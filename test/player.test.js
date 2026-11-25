import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setImmediate as turn } from 'node:timers/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createPlayback } from '../src/playback.js';

const playerSource = readFileSync(new URL('../public/player.js', import.meta.url), 'utf8')
  .replaceAll('export function ', 'function ')
  .replace('    authorizeApproval() {', '    measure() { return { offset, target: positionAt(performance.now() + offset) }; },\n    authorizeApproval() {');

function roomFixture({ automatic = false, blocked = [], duration = 120,
  audioStage = () => {}, suspendHostAudio = false, resumeHostAudio, cancelHostStart = false } = {}) {
  const room = createPlayback(duration);
  const timers = new Set();
  const saved = { host: new Map(), visitor: new Map() };
  let now = 1000;
  let dropSeekReply = false;
  let seekReply;
  let readyReply;
  let committedReady;
  let hostOffline = false;
  let committedSeek;
  let recoveryLoss;
  let delayedRecovery;
  let pausedReplyLoss = false;
  let visitorObserveTimeout = false;
  let delay = { request: 0, reply: 0 };
  const recovery = [];
  const pauses = [];
  const visitorWire = [];
  const visitorRequests = [];
  const grants = new Set();
  const missingPositions = new Set();

  const wait = ms => ms ? new Promise(resolve => schedule(resolve, ms)) : undefined;

  function waitForReply(promise, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      promise.then(value => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      });
    });
  }

  function schedule(callback, delay, repeat = false) {
    const timer = { callback, due: now + (delay > 0 ? Math.max(1, delay) : delay), delay, repeat };
    timers.add(timer);
    return timer;
  }

  async function advance(ms) {
    const end = now + ms;
    while (true) {
      const timer = [...timers].sort((a, b) => a.due - b.due)[0];
      if (!timer || timer.due > end) break;
      now = timer.due;
      if (timer.repeat) timer.due += timer.delay;
      else timers.delete(timer);
      timer.callback();
      await turn();
    }
    now = end;
  }

  function open(role) {
    const video = new EventTarget();
    const elements = new Map([['video', video]]);
    let position = 0;
    let updatedAt = now;
    let rate = 1;
    let mediaAssociated = false;
    let audioContext;
    Object.assign(video, {
      duration, HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2, HAVE_FUTURE_DATA: 3,
      readyState: 4, seeking: false, paused: true, src: '',
      hasAttribute() { return Boolean(this.src); },
      getAttribute() { return this.src; },
      removeAttribute() { this.src = ''; },
      load() {},
      play() {
        if (blocked.includes(role) && !grants.has(role)) {
          return Promise.reject(new DOMException('Policy blocked playback', 'NotAllowedError'));
        }
        this.paused = false;
        updatedAt = now;
        return Promise.resolve();
      },
      pause() { position = this.currentTime; this.paused = true; }
    });
    Object.defineProperties(video, {
      currentTime: {
        get: () => Math.min(duration, position + (video.paused || video.stuck ? 0 : (now - updatedAt) * rate / 1000)),
        set: seconds => { if (!video.stuck) { position = seconds; updatedAt = now; } },
      },
      ended: { get: () => video.currentTime >= duration },
      playbackRate: {
        get: () => rate,
        set: next => { video.currentTime = video.currentTime; rate = next; },
      },
    });
    const element = id => {
      if (!elements.has(id)) {
        elements.set(id, Object.assign(new EventTarget(), { setAttribute() {} }));
      }
      return elements.get(id);
    };
    const gainWrites = [];
    const audibleStarts = [];
    let reloads = 0;
    const gain = {
      get value() { return gainWrites.at(-1) ?? 0; },
      set value(value) {
        if (value > 0 && !this.value && !video.paused && !video.ended && !video.stuck) {
          audibleStarts.push({ at: now, position: video.currentTime });
        }
        gainWrites.push(value);
      },
    };
    const context = {
      document: Object.assign(new EventTarget(), { getElementById: element, hidden: false }),
      window: Object.assign(new EventTarget(), { location: { reload() { reloads++; } } }),
      crypto: { randomUUID },
      sessionStorage: { getItem: key => saved[role].get(key) ?? null,
        setItem: (key, value) => saved[role].set(key, value),
        removeItem: key => saved[role].delete(key) },
      performance: { now: () => now },
      AbortController, AbortSignal, DOMException,
      AudioContext: class extends EventTarget {
        state = role === 'host' && suspendHostAudio ? 'suspended' : 'running';
        constructor() { super(); audioStage(role, 'context'); audioContext = this; }
        createGain() {
          audioStage(role, 'gain');
          return { gain, connect() { audioStage(role, 'gain connection'); } };
        }
        createMediaElementSource() {
          if (mediaAssociated) throw new DOMException('Media already associated', 'InvalidStateError');
          audioStage(role, 'media source');
          mediaAssociated = true;
          return { connect: node => { audioStage(role, 'media connection'); return node; } };
        }
        resume() {
          audioStage(role, 'resume');
          if (role === 'host' && resumeHostAudio) {
            return resumeHostAudio().then(() => {
              this.state = 'running';
              this.dispatchEvent(new Event('statechange'));
            });
          }
          this.state = 'running';
          return Promise.resolve();
        }
        close() { audioStage(role, 'close'); return Promise.resolve(); }
      },
      setTimeout: schedule,
      setInterval: (fn, delay) => schedule(fn, delay, true),
      clearTimeout: timer => timers.delete(timer),
      clearInterval: timer => timers.delete(timer),
      async fetch(_url, options) {
        const command = JSON.parse(options.body);
        if (command.action === 'observe' && missingPositions.has(role)) delete command.position;
        if (role === 'host' && hostOffline) throw new TypeError('offline');
        const sent = now;
        const wire = delay;
        if (role === 'visitor') {
          visitorRequests.push(command.action);
          if (visitorObserveTimeout && command.action === 'observe') {
            visitorObserveTimeout = false;
            await wait(2000);
            throw new DOMException('The first observation timed out', 'TimeoutError');
          }
        }
        if (role === 'visitor' && wire.request) await wait(wire.request);
        if (role === 'host' && command.action === 'recover' && ['request', 'late'].includes(recoveryLoss)) {
          if (recoveryLoss === 'late') delayedRecovery = command;
          recovery.push({ command, result: recoveryLoss === 'late' ? 'delayed' : 'request lost' });
          recoveryLoss = undefined;
          hostOffline = true;
          throw new TypeError('recovery request lost before application');
        }
        const result = room.update(command, now);
        if (role === 'visitor') {
          if (wire.reply) await wait(wire.reply);
          visitorWire.push({ sent, received: now, serverTime: result.state.serverTime,
            action: command.action, status: result.conflict ? 409 : 200, version: result.state.version,
            startsAt: result.state.startsAt });
        }
        if (role === 'host' && command.action === 'recover') {
          recovery.push({ command, result: result.conflict ? 'conflict' : 'applied' });
          if (delayedRecovery) {
            const late = room.update(delayedRecovery, now);
            recovery.push({ command: delayedRecovery, result: late.conflict ? 'late conflict' : 'late applied' });
            delayedRecovery = undefined;
          }
          if (recoveryLoss === 'reply' && !result.conflict) {
            recoveryLoss = undefined;
            hostOffline = true;
            throw new TypeError('recovery committed but reply was lost');
          }
        }
        if (role === 'host' && command.action === 'pause') {
          pauses.push({ command, result: result.conflict ? 'conflict' : 'applied', state: result.state });
          if (pausedReplyLoss && !result.conflict) {
            pausedReplyLoss = false;
            hostOffline = true;
            throw new TypeError('pause committed but reply was lost');
          }
        }
        if (role === 'host' && command.action === 'seek' && seekReply && !result.conflict) {
          committedSeek = result.state;
          const { promise } = seekReply;
          seekReply = undefined;
          const deliver = await waitForReply(promise, options.signal);
          if (!deliver) {
            hostOffline = true;
            throw new TypeError('seek reply lost after it was held');
          }
        }
        if (role === 'host' && command.action === 'seek' && dropSeekReply && !result.conflict) {
          dropSeekReply = false;
          committedSeek = result.state;
          hostOffline = true;
          throw new TypeError('seek committed but reply was lost');
        }
        if (role === 'host' && command.action === 'ready' && readyReply && !result.conflict) {
          committedReady = result.state;
          const { promise } = readyReply;
          readyReply = undefined;
          await waitForReply(promise, options.signal);
        }
        return { ok: !result.conflict, status: result.conflict ? 409 : 200, json: async () => result.state };
      },
    };
    const player = runInNewContext(playerSource + '\ncreatePlayer', context)({
      apiOrigin: '', roomPath: '/rooms/synthetic', role,
      cancelFirstStart: role === 'host' && cancelHostStart
        ? playerId => Promise.resolve(room.cancelFirstStart(playerId, now)) : undefined,
    });
    player.load('/media/synthetic.mp4');
    if (automatic) player.admit();
    return { player, video, element, gain, gainWrites, audibleStarts, get reloads() { return reloads; },
      leavePage() {
        context.document.hidden = true;
        context.document.dispatchEvent(new Event('visibilitychange'));
        context.window.dispatchEvent(new Event('pagehide'));
      },
      get audioContext() { return audioContext; }, allowPlayback() {
      grants.add(role);
      element('prepare').dispatchEvent(new Event('click'));
    } };
  }

  let host = open('host');
  let visitor = open('visitor');
  async function start() {
    await advance(250);
    host.element('prepare').dispatchEvent(new Event('click'));
    visitor.element('prepare').dispatchEvent(new Event('click'));
    await advance(500);
    assert.equal(host.element('play').disabled, false);
    host.element('play').dispatchEvent(new Event('click'));
    await advance(1800);
    assert.ok(!host.video.paused && !visitor.video.paused);
  }
  return {
    advance, start, recovery, pauses, visitorWire, visitorRequests, now: () => now,
    approve() { room.startOnApproval(); },
    setDelay(request, reply) { delay = { request, reply }; },
    loseNextRecovery(kind) { recoveryLoss = kind; },
    loseNextPauseReply() { pausedReplyLoss = true; },
    timeOutNextVisitorObserve() { visitorObserveTimeout = true; },
    savedHost() { return JSON.parse(saved.host.values().next().value ?? 'null'); },
    saveHost(value) { saved.host.set([...saved.host.keys()][0], JSON.stringify(value)); },
    send(command) { return room.update({ role: 'host', ...command }, now); },
    get host() { return host; },
    get visitor() { return visitor; },
    omitPosition(role) { missingPositions.add(role); },
    restorePosition(role) { missingPositions.delete(role); },
    savedVisitor() { return JSON.parse(saved.visitor.values().next().value ?? 'null'); },
    get committedSeek() { return committedSeek; },
    get committedReady() { return committedReady; },
    holdNextReadyReply() {
      readyReply = Promise.withResolvers();
      return readyReply.resolve;
    },
    loseNextSeekReply() { dropSeekReply = true; },
    holdNextSeekReply() {
      seekReply = Promise.withResolvers();
      return seekReply.resolve;
    },
    reloadHost() { host.player.stop(); host = open('host'); },
    reloadVisitor() { visitor.leavePage(); visitor.player.stop(); visitor = open('visitor'); },
    restoreHost() { hostOffline = false; },
    disconnectHost() { hostOffline = true; },
    snapshot() { return room.update({ role: 'host', action: 'observe', playerId: randomUUID() }, now).state; },
  };
}

test('approval reuses the native click even when audio setup consumes 5095 ms', async t => {
  for (const slow of ['context', 'gain', 'media source', 'media connection', 'gain connection', 'resume']) {
    await t.test(slow, () => {
      let clock = 0;
      let activationExpires = 0;
      const events = [];
      const app = roomFixture({
        suspendHostAudio: true,
        audioStage(role, stage) {
          if (role !== 'host') return;
          events.push({ stage, at: clock });
          if (stage === slow) clock += 5095;
        },
      });
      const { player, video, gain, gainWrites } = app.host;
      const nativePlay = video.play;
      video.play = function () {
        events.push({ stage: 'play', at: clock, active: clock < activationExpires,
          originalElement: this === video, muted: Boolean(video.muted), gain: gain.value });
        return nativePlay.call(this);
      };

      // The room has displayed the ready media snapshot before delivering the click.
      player.load('/media/synthetic.mp4', { prepareApproval: true });
      player.load('/media/synthetic.mp4', { prepareApproval: true });
      assert.equal(video.paused, true);
      assert.ok(events.every(({ stage }) => stage !== 'play' && stage !== 'resume'));
      const started = clock;
      activationExpires = started + 5000;
      player.authorizeApproval();
      events.push({ stage: 'approval request', at: clock });
      app.approve();

      const play = events.find(({ stage }) => stage === 'play');
      assert.deepEqual(play, { stage: 'play', at: started, active: true,
        originalElement: true, muted: false, gain: 0 }, JSON.stringify(events));
      assert.deepEqual(events.filter(({ at, stage }) => at >= started && ['play', 'resume', 'approval request'].includes(stage))
        .map(({ stage }) => stage), ['play', 'resume', 'approval request']);
      assert.equal(events.find(({ stage }) => stage === 'resume').at, started);
      assert.equal(events.filter(({ stage }) => stage === 'context').length, 1);
      assert.ok(gainWrites.length > 0 && gainWrites.every(value => value === 0));
    });
  }
});

test('a transient audio graph failure has a safe ready-approval fallback', async t => {
  await t.test('one failed constructor can recover before the approval click', async () => {
    let contexts = 0;
    const app = roomFixture({ audioStage(role, stage) {
      if (role === 'host' && stage === 'context' && ++contexts === 1) throw new Error('Transient constructor failure');
    } });
    const { player, video, gain } = app.host;
    const nativePlay = video.play;
    const plays = [];
    let active = false;
    video.play = function () {
      plays.push({ active, sameElement: this === video, gain: gain.value });
      return nativePlay.call(this);
    };
    player.load('/media/synthetic.mp4', { prepareApproval: true });
    await app.advance(1);
    assert.equal(video.paused, true);
    assert.deepEqual(plays, []);
    active = true;
    player.authorizeApproval();
    active = false;
    app.approve();
    assert.deepEqual(plays, [{ active: true, sameElement: true, gain: 0 }]);
    assert.equal(contexts, 2);
  });

  for (const failingStage of ['context', 'gain connection', 'media connection']) {
    await t.test(failingStage, async () => {
      const stages = [];
      let available = false;
      const app = roomFixture({ audioStage(role, stage) {
        if (role !== 'host') return;
        stages.push(stage);
        if (!available && stage === failingStage) throw new Error('Audio output temporarily unavailable');
      } });
      const { player, video, element, gainWrites } = app.host;
      let plays = 0;
      const nativePlay = video.play;
      video.play = function () { plays++; return nativePlay.call(this); };
      player.load('/media/synthetic.mp4', { prepareApproval: true });
      player.authorizeApproval();
      app.approve();
      player.admit();
      app.visitor.player.admit();
      await app.advance(300);
      assert.equal(plays, 0, 'No native play without a safely connected graph');
      assert.equal(video.paused, true);
      assert.equal(app.snapshot().startsAt, null);
      assert.deepEqual(app.snapshot().blocked, []);
      if (failingStage === 'gain connection') {
        assert.equal(stages.includes('media source'), false, 'A failed destination must leave the video unassociated');
        assert.ok(stages.includes('close'), 'Discard the unassociated context on setup failure');
      }
      assert.equal(element('prepare').hidden, false);
      assert.equal(element('prepare').textContent, '重试音频');
      assert.equal(app.visitor.element('prepare').hidden, true);
      available = true;
      app.host.allowPlayback();
      assert.equal(plays, 1);
      assert.equal(stages.filter(stage => stage === 'media source').length, 1);
      assert.ok(gainWrites.every(value => value === 0));
      await app.advance(11500);
      assert.equal(app.snapshot().synchronized, true);
    });
  }
});

test('pending audio resumption is distinct from denial and belongs to the current attempt', async t => {
  for (const delay of [600, 1200]) {
    await t.test(delay + ' ms', async () => {
      const resume = Promise.withResolvers();
      const app = roomFixture({ automatic: true, suspendHostAudio: true, resumeHostAudio: () => resume.promise });
      app.approve();
      await app.advance(delay - 1);
      assert.deepEqual(app.snapshot().blocked, []);
      assert.notEqual(app.host.element('prepare').textContent, '允许播放');
      assert.equal(app.host.video.paused, true, 'Pause the silent probe while waiting for audio');
      assert.ok(app.host.gainWrites.every(value => value === 0));
      resume.resolve();
      await app.advance(11600);
      assert.equal(app.snapshot().synchronized, true);
      assert.equal(app.host.element('prepare').hidden, true);
    });
  }

  await t.test('explicit denial prompts only the affected seat', async () => {
    const resume = Promise.withResolvers();
    const app = roomFixture({ automatic: true, suspendHostAudio: true, resumeHostAudio: () => resume.promise });
    app.approve();
    await app.advance(300);
    assert.deepEqual(app.snapshot().blocked, []);
    resume.reject(new DOMException('Audio denied', 'NotAllowedError'));
    await app.advance(300);
    assert.deepEqual(app.snapshot().blocked, ['host']);
    assert.equal(app.host.element('prepare').textContent, '允许播放');
    assert.equal(app.host.element('prepare').hidden, false);
    assert.equal(app.visitor.element('prepare').hidden, true);
    assert.ok(app.host.gainWrites.every(value => value === 0));
  });

  await t.test('local retry is available while native play and resume are pending', async () => {
    const previousPlay = Promise.withResolvers();
    const previousResume = Promise.withResolvers();
    const requestedResume = Promise.withResolvers();
    let resumes = 0;
    let plays = 0;
    const app = roomFixture({ automatic: true, suspendHostAudio: true,
      resumeHostAudio: () => (++resumes === 1 ? previousResume.promise : requestedResume.promise) });
    const { video, element, gainWrites } = app.host;
    const nativePlay = video.play;
    video.play = function () {
      return ++plays === 1 ? previousPlay.promise : nativePlay.call(this);
    };
    app.approve();
    await app.advance(300);
    assert.equal(element('prepare').hidden, false);
    assert.equal(element('prepare').disabled, false);
    assert.equal(element('prepare').textContent, '重试音频');
    app.host.allowPlayback();
    assert.equal(plays, 2);
    assert.equal(resumes, 2);
    previousPlay.reject(new DOMException('Obsolete video attempt', 'NotAllowedError'));
    previousResume.resolve();
    await app.advance(300);
    assert.deepEqual(app.snapshot().blocked, []);
    assert.equal(app.snapshot().ready.host, false);
    assert.ok(gainWrites.every(value => value === 0));
    requestedResume.resolve();
    await app.advance(11600);
    assert.equal(app.snapshot().synchronized, true);
  });

  for (const reject of [false, true]) {
    await t.test('obsolete ' + (reject ? 'rejection' : 'fulfillment') + ' after cancellation', async () => {
      const first = Promise.withResolvers();
      const second = Promise.withResolvers();
      let resumes = 0;
      const app = roomFixture({ automatic: true, suspendHostAudio: true, cancelHostStart: true,
        resumeHostAudio: () => (++resumes === 1 ? first.promise : second.promise) });
      app.approve();
      await app.advance(300);
      app.host.element('play').dispatchEvent(new Event('click'));
      await app.advance(300);
      assert.equal(app.snapshot().wantsPlay, false);
      assert.equal(app.host.video.paused, true);
      app.host.element('play').dispatchEvent(new Event('click'));
      await app.advance(300);
      assert.equal(resumes, 2);
      if (reject) first.reject(new DOMException('Old denial', 'NotAllowedError'));
      else first.resolve();
      await app.advance(400);
      assert.equal(app.snapshot().ready.host, false);
      assert.deepEqual(app.snapshot().blocked, []);
      assert.ok(app.host.gainWrites.every(value => value === 0));
      second.resolve();
      await app.advance(11600);
      assert.equal(app.snapshot().synchronized, true);
    });
  }
});

test('audio loss on an active timeline pauses the room and leaves a local retry', async t => {
  for (const seek of [false, true]) await t.test(seek ? 'seek restart with pending resume' : 'audio drops during playback', async () => {
    const resume = Promise.withResolvers();
    let resumes = 0;
    const app = roomFixture({ automatic: true, resumeHostAudio: () => { resumes++; return resume.promise; } });
    app.approve();
    await app.advance(11500);
    assert.equal(app.snapshot().synchronized, true);
    const { video, element, gain, audioContext } = app.host;
    const setAudioState = state => {
      audioContext.state = state;
      audioContext.dispatchEvent(new Event('statechange'));
    };
    if (seek) {
      const version = app.snapshot().version;
      element('seek').value = 25;
      element('seek').dispatchEvent(new Event('change'));
      for (let i = 0; i < 10; i++) {
        await app.advance(100);
        const plan = app.snapshot();
        if (plan.version > version && plan.startsAt > app.now()) break;
      }
      const plan = app.snapshot();
      assert.equal(plan.position, 25);
      assert.ok(plan.version > version && plan.startsAt > app.now());
    } else {
      assert.equal(video.paused, false);
      setAudioState('suspended');
      await app.advance(100);
      setAudioState('running');
      await app.advance(400);
      assert.equal(app.snapshot().synchronized, true, 'A transient state change does not interrupt the room');
    }
    setAudioState('suspended');
    await app.advance(1500);
    const held = app.snapshot();
    assert.equal(held.startsAt, null);
    assert.equal(held.wantsPlay, true);
    assert.equal(held.waiting.host, 'audio');
    assert.deepEqual(held.blocked, []);
    assert.equal(app.visitor.video.paused, true);
    assert.equal(video.paused, true);
    assert.equal(gain.value, 0);
    assert.equal(app.visitor.gain.value, 0);
    assert.equal(resumes, 1);
    assert.equal(element('prepare').textContent, '重试音频');
    assert.equal(element('prepare').hidden, false);
    assert.equal(app.visitor.element('prepare').hidden, true);
    if (seek) app.host.allowPlayback();
    resume.resolve();
    await app.advance(2300);
    assert.equal(app.snapshot().synchronized, true);
    assert.equal(element('prepare').hidden, true);
    element('play').dispatchEvent(new Event('click'));
    await app.advance(300);
    setAudioState('suspended');
    await app.advance(600);
    assert.equal(app.snapshot().wantsPlay, false);
    assert.notEqual(app.snapshot().waiting.host, 'audio');
    assert.equal(element('prepare').hidden, true);
  });
});

test('late shared audio recovery cannot outlive a source change or lost seat', async t => {
  for (const replaceSource of [false, true]) await t.test(replaceSource ? 'source' : 'seat', async () => {
    const previous = Promise.withResolvers();
    const replacement = Promise.withResolvers();
    let resumes = 0;
    const app = roomFixture({ automatic: true,
      resumeHostAudio: () => (++resumes === 1 ? previous.promise : replacement.promise) });
    app.approve();
    await app.advance(11500);
    const { audioContext, element, gain, player } = app.host;
    audioContext.state = 'suspended';
    audioContext.dispatchEvent(new Event('statechange'));
    await app.advance(800);
    assert.equal(resumes, 1);
    assert.equal(app.snapshot().waiting.host, 'audio');
    if (replaceSource) {
      player.load('/media/replacement.mp4');
      await app.advance(400);
      assert.equal(resumes, 2);
      assert.equal(app.host.audioContext, audioContext);
    } else {
      const seat = app.savedHost();
      const recovered = app.send({ action: 'recover', playerId: randomUUID(),
        recoveryId: seat.recoveryId, recoveryGeneration: seat.recoveryGeneration + 1 });
      assert.equal(recovered.state.ownsSeat, true);
      await app.advance(400);
      assert.equal(element('prepare').hidden, true);
    }
    previous.resolve();
    await app.advance(500);
    assert.equal(app.snapshot().ready.host, false);
    assert.equal(app.snapshot().startsAt, null);
    assert.equal(gain.value, 0);
    assert.equal(app.visitor.gain.value, 0);
    assert.deepEqual(app.snapshot().blocked, []);
  });
});

test('a suspended context cannot confirm a future first start', async () => {
  const app = roomFixture({ automatic: true, resumeHostAudio: () => new Promise(() => {}) });
  app.approve();
  let plan;
  for (let i = 0; i < 80; i++) {
    await app.advance(25);
    plan = app.snapshot();
    if (plan.awaitingStart && plan.startsAt > app.now() && !plan.startConfirmed) break;
  }
  assert.ok(plan.awaitingStart && plan.startsAt > app.now() && !plan.startConfirmed);
  app.host.audioContext.state = 'suspended';
  app.host.audioContext.dispatchEvent(new Event('statechange'));
  await app.advance(400);
  const held = app.snapshot();
  assert.equal(held.startsAt === plan.startsAt && held.startConfirmed, false);
  assert.equal(held.waiting.host, 'audio');
  assert.deepEqual(held.blocked, []);
  assert.equal(app.host.gain.value, 0);
  assert.equal(app.visitor.gain.value, 0);
});

test('pending scheduled play holds the room for a bounded local retry', async t => {
  for (const reject of [false, true]) await t.test(reject ? 'late rejection' : 'late success', async () => {
    const previous = Promise.withResolvers();
    const app = roomFixture({ automatic: true });
    app.approve();
    await app.advance(11500);
    assert.equal(app.snapshot().synchronized, true);
    const { video, element, gain } = app.host;
    const nativePlay = video.play;
    let attempts = 0;
    video.play = function () { return ++attempts === 1 ? previous.promise : nativePlay.call(this); };
    element('seek').value = 25;
    element('seek').dispatchEvent(new Event('change'));
    await app.advance(3400);
    const held = app.snapshot();
    assert.equal(held.startsAt, null);
    assert.equal(held.waiting.host, 'audio');
    assert.equal(held.wantsPlay, true);
    assert.deepEqual(held.blocked, []);
    assert.equal(app.host.audioContext.state, 'running');
    assert.equal(video.readyState, video.HAVE_FUTURE_DATA + 1);
    assert.ok(video.paused && app.visitor.video.paused);
    assert.equal(gain.value, 0);
    assert.equal(app.visitor.gain.value, 0);
    assert.equal(attempts, 1);
    assert.equal(element('prepare').textContent, '重试音频');
    assert.equal(element('prepare').hidden, false);
    assert.equal(app.visitor.element('prepare').hidden, true);
    app.host.allowPlayback();
    if (reject) previous.reject(new DOMException('Obsolete scheduled start', 'NotAllowedError'));
    else previous.resolve();
    await app.advance(2400);
    assert.equal(app.snapshot().synchronized, true);
    assert.deepEqual(app.snapshot().blocked, []);
    assert.equal(element('prepare').hidden, true);
  });
});

test('a settled scheduled play without media movement holds the room', async () => {
  const app = roomFixture({ automatic: true });
  app.approve();
  await app.advance(11500);
  assert.equal(app.snapshot().synchronized, true);
  const { video, element, gain } = app.host;
  const play = video.play;
  let attempts = 0;
  video.play = function () {
    if (++attempts === 1) video.stuck = true;
    return play.call(this);
  };
  element('seek').value = 25;
  element('seek').dispatchEvent(new Event('change'));
  await app.advance(3400);
  const held = app.snapshot();
  assert.equal(held.startsAt, null);
  assert.equal(held.position, 25);
  assert.equal(held.waiting.host, 'audio');
  assert.deepEqual(held.blocked, []);
  assert.equal(attempts, 1);
  assert.ok(video.paused && app.visitor.video.paused);
  assert.equal(gain.value, 0);
  assert.equal(app.visitor.gain.value, 0);
  assert.equal(element('prepare').textContent, '重试音频');
  assert.equal(app.visitor.element('prepare').hidden, true);
  video.stuck = false;
  app.host.allowPlayback();
  await app.advance(2400);
  assert.equal(app.snapshot().synchronized, true);
});

test('a scheduled seek through the final frame can end without an audio hold', async () => {
  const app = roomFixture({ automatic: true });
  app.approve();
  await app.advance(11500);
  assert.equal(app.snapshot().synchronized, true);
  const played = [];
  for (const role of ['host', 'visitor']) {
    const { video } = app[role];
    const play = video.play;
    video.play = function () {
      played.push([role, video.currentTime]);
      return play.call(this);
    };
  }
  const seek = app.host.element('seek');
  seek.value = 119.98;
  seek.dispatchEvent(new Event('change'));
  await app.advance(2900);
  const ended = app.snapshot();
  assert.deepEqual(played.sort(), [['host', 119.98], ['visitor', 119.98]]);
  assert.ok(app.host.video.ended && app.visitor.video.ended);
  assert.equal(ended.ended, true);
  assert.equal(ended.position, 120);
  assert.deepEqual(ended.waiting, { host: null, visitor: null });
  assert.equal(app.host.element('prepare').hidden, true);
  assert.equal(app.visitor.element('prepare').hidden, true);
});

test('normal playback ends after both media elements finish naturally', async () => {
  const app = roomFixture({ duration: 3 });
  await app.start();
  const plan = app.snapshot();
  assert.equal(plan.synchronized, true);
  await app.advance(plan.startsAt + 2850 - app.now());
  const { video: visitorVideo } = app.visitor;
  const visitorPosition = visitorVideo.currentTime;
  visitorVideo.currentTime = visitorPosition;
  visitorVideo.stuck = true;
  await app.advance(plan.startsAt + 3000 - app.now());
  const { video: hostVideo } = app.host;
  assert.equal(hostVideo.ended, true);
  hostVideo.readyState = hostVideo.HAVE_CURRENT_DATA;
  hostVideo.dispatchEvent(new Event('ended'));
  hostVideo.dispatchEvent(new Event('waiting'));
  assert.equal(visitorVideo.ended, false);
  await app.advance(250);
  const waitingForVisitor = app.snapshot();
  assert.equal(waitingForVisitor.waiting.host, null);
  assert.equal(waitingForVisitor.startsAt, plan.startsAt);
  assert.equal(waitingForVisitor.ended, false);
  visitorVideo.stuck = false;
  visitorVideo.currentTime = visitorPosition;
  await app.advance(800);
  assert.equal(visitorVideo.ended, true);
  assert.equal(app.snapshot().ended, true);
  assert.equal(app.host.element('play').textContent, '重播');
});

test('a pending tail seek reaches the native start watchdog before it can end the room', async () => {
  const app = roomFixture({ automatic: true });
  app.approve();
  await app.advance(11500);
  assert.equal(app.snapshot().synchronized, true);
  const { video, element, gain } = app.host;
  const previous = Promise.withResolvers();
  const play = video.play;
  let attemptedAt;
  video.play = function () {
    if (attemptedAt !== undefined) return play.call(this);
    attemptedAt = app.now();
    return previous.promise;
  };
  element('seek').value = 119.98;
  element('seek').dispatchEvent(new Event('change'));
  for (let i = 0; i < 20 && attemptedAt === undefined; i++) await app.advance(100);
  assert.ok(attemptedAt !== undefined);
  const scheduled = app.snapshot();
  await app.advance(attemptedAt + 600 - app.now());
  assert.ok(app.now() > scheduled.startsAt + 20);
  assert.equal(video.currentTime, 119.98);
  assert.equal(video.ended, false);
  assert.equal(app.snapshot().ended, false);
  assert.equal(app.snapshot().startsAt, scheduled.startsAt);
  assert.equal(app.visitor.video.ended, true);
  await app.advance(attemptedAt + 1300 - app.now());
  const held = app.snapshot();
  assert.equal(held.ended, false);
  assert.equal(held.position, 119.98);
  assert.equal(held.startsAt, null);
  assert.equal(held.wantsPlay, true);
  assert.equal(held.waiting.host, 'audio');
  assert.deepEqual(held.blocked, []);
  assert.ok(video.paused && app.visitor.video.paused);
  assert.equal(gain.value, 0);
  assert.equal(app.visitor.gain.value, 0);
  assert.equal(element('prepare').textContent, '重试音频');
  assert.equal(element('prepare').hidden, false);
  assert.equal(app.visitor.element('prepare').hidden, true);
  app.host.allowPlayback();
  previous.reject(new DOMException('Obsolete scheduled start', 'NotAllowedError'));
  await app.advance(2400);
  assert.ok(video.ended && app.visitor.video.ended);
  assert.equal(app.snapshot().ended, true);
  assert.deepEqual(app.snapshot().blocked, []);
});

test('losing the completed seat preserves the unfinished frame and play intent', async t => {
  for (const loss of ['connection', 'connection before terminal report', 'lease', 'recover', 'pause']) await t.test(loss, () => {
    const room = createPlayback(3);
    const ids = { host: randomUUID(), visitor: randomUUID() };
    const send = (role, action, now, fields = {}) =>
      room.update({ role, action, playerId: ids[role], ...fields }, now);
    const { epoch, version } = send('host', 'observe', 0).state;
    const ready = { epoch, version, position: 0, claim: true, nativeEnd: true };
    const recoveryId = randomUUID();
    send('host', 'ready', 0, { ...ready, recoveryId });
    send('visitor', 'ready', 0, ready);
    const plan = send('host', 'play', 0, ready).state;
    const target = { epoch, version: plan.version };
    const at = elapsed => plan.startsAt + elapsed;
    const finished = { ...target, position: 3, ended: true, playing: false };
    const unfinished = { ...target, position: 2.8, ended: false, playing: true };
    send('host', 'observe', at(2000), target);
    send('visitor', 'observe', at(2000), target);
    send('visitor', 'observe', at(3000), unfinished);
    if (loss !== 'connection before terminal report') {
      assert.equal(send('host', 'observe', at(3100), finished).state.ended, false);
    }
    const replacement = randomUUID();
    const recovery = { playerId: replacement, recoveryId, recoveryGeneration: 1 };
    let paused;
    if (loss === 'lease') {
      send('visitor', 'observe', at(6100), unfinished);
      paused = send('visitor', 'observe', at(7101), unfinished).state;
    } else if (loss === 'recover') {
      assert.equal(send('host', 'recover', at(3150), { ...recovery, recoveryId: randomUUID() }).conflict, true);
      paused = send('host', 'recover', at(3200), recovery).state;
    } else if (loss === 'pause') {
      send('visitor', 'observe', at(3150), { ...unfinished, playing: false, position: 3 });
      paused = send('host', 'pause', at(3200), target).state;
    } else {
      paused = send('host', 'unavailable', at(3200), { ...target, reason: 'connection', position: 3 }).state;
    }
    // Without either a terminal report or an in-range host sample, the host still caps recovery at the plan start.
    const resumePosition = loss === 'connection before terminal report' ? plan.position : 2.8;
    assert.equal(paused.position, resumePosition);
    assert.equal(paused.startsAt, null);
    assert.equal(paused.ended, false);
    assert.equal(paused.wantsPlay, loss !== 'pause');
    if (loss === 'pause') {
      assert.equal(send('host', 'unavailable', at(3300), { ...target, reason: 'connection' }).conflict, true);
      return;
    }
    assert.equal(paused.waiting.host, 'connection');
    const restoredAt = at(loss === 'lease' ? 7200 : 3300);
    if (loss !== 'recover') {
      assert.equal(send('host', 'recover', restoredAt, recovery).state.ownsSeat, true);
    }
    const aligned = { epoch, version: paused.version + Number(loss !== 'recover'), position: resumePosition, nativeEnd: true };
    send('host', 'ready', restoredAt, { ...aligned, playerId: replacement });
    const retry = send('visitor', 'ready', restoredAt, aligned).state;
    assert.ok(retry.startsAt > restoredAt);
    const replayed = { ...finished, version: retry.version };
    assert.equal(send('host', 'observe', retry.startsAt + 300, replayed).state.ownsSeat, false);
    assert.equal(send('host', 'observe', retry.startsAt + 300, { ...finished, playerId: replacement }).state.ended, false);
    assert.equal(send('visitor', 'observe', retry.startsAt + 310, replayed).state.ended, false);
    const cancel = send('host', 'pause', retry.startsAt + 320, { epoch, version: retry.version, playerId: replacement });
    assert.equal(cancel.conflict, false);
    assert.equal(cancel.state.wantsPlay, false);
    assert.equal(send('host', 'observe', retry.startsAt + 330, { ...replayed, playerId: replacement }).state.ended, false);
  });
});

test('a player that advanced after a seek and then froze gets a local tail retry', async () => {
  const app = roomFixture({ automatic: true });
  app.approve();
  await app.advance(11500);
  assert.equal(app.snapshot().synchronized, true);
  const seek = app.host.element('seek');
  seek.value = 119.4;
  seek.dispatchEvent(new Event('change'));
  const { video, element } = app.visitor;
  for (let i = 0; i < 35 && video.currentTime < 119.7; i++) await app.advance(50);
  const pausedAt = video.currentTime;
  assert.ok(pausedAt >= 119.7 && pausedAt < 120);
  video.currentTime = pausedAt;
  video.stuck = true;
  await app.advance(1500);
  const held = app.snapshot();
  assert.equal(held.ended, false);
  assert.equal(held.startsAt, null);
  assert.equal(held.wantsPlay, true);
  assert.equal(held.position, pausedAt);
  assert.equal(held.waiting.visitor, 'stalled');
  assert.ok(app.host.video.paused && video.paused);
  assert.equal(app.host.gain.value, 0);
  assert.equal(app.visitor.gain.value, 0);
  assert.equal(element('prepare').textContent, '重试播放');
  assert.equal(element('prepare').hidden, false);
  assert.equal(app.host.element('prepare').hidden, true);
  video.stuck = false;
  app.visitor.allowPlayback();
  await app.advance(2400);
  assert.equal(app.snapshot().ended, true);
});

test('tail stall uses consecutive in-order capture times, not a delayed reply', () => {
  const room = createPlayback(3);
  const ids = { host: randomUUID(), visitor: randomUUID() };
  const send = (role, action, now, fields = {}) =>
    room.update({ role, action, playerId: ids[role], ...fields }, now).state;
  const { epoch, version } = send('host', 'observe', 0);
  const ready = { epoch, version, position: 0, claim: true, nativeEnd: true };
  for (const role of ['host', 'visitor']) send(role, 'ready', 0, ready);
  const plan = send('host', 'play', 0, ready);
  const report = (role, received, captured, position, ended = false) =>
    send(role, 'observe', plan.startsAt + received, { epoch, version: plan.version,
      position, ended, playing: !ended, observedAt: plan.startsAt + captured, sampledAt: captured });
  report('visitor', 2500, 2500, 2.5);
  report('host', 2500, 2500, 2.5);
  report('visitor', 2550, 2550, 2.55);
  report('host', 3100, 3100, 3, true);
  report('visitor', 3120, 2600, 2.55);
  const delayed = report('visitor', 3730, 2800, 2.55);
  assert.equal(delayed.startsAt, plan.startsAt);
  assert.equal(delayed.waiting.visitor, null);
  const stale = report('visitor', 3740, 2750, 2.6);
  assert.equal(stale.startsAt, plan.startsAt);
  const stopped = report('visitor', 3880, 3300, 2.55);
  assert.equal(stopped.startsAt, null);
  assert.equal(stopped.position, 2.55);
  assert.equal(stopped.waiting.visitor, 'stalled');
});

function observedPlayback({ duration = 10, legacy, position = 0 } = {}) {
  const room = createPlayback(duration);
  const players = { host: randomUUID(), visitor: randomUUID() };
  const update = (role, action, at, fields = {}) =>
    room.update({ role, action, playerId: players[role], ...fields }, at).state;
  let { epoch, version } = update('host', 'observe', 0);
  if (position) {
    update('host', 'ready', 0, { epoch, version, position: 0, claim: true });
    ({ version } = update('host', 'seek', 0, { epoch, version, position }));
  }
  for (const role of ['host', 'visitor']) {
    update(role, 'ready', 0, { epoch, version, position, claim: true,
      ...(role !== legacy ? { nativeEnd: true } : {}) });
  }
  const plan = update('host', 'play', 0, { epoch, version });
  const target = { epoch, version: plan.version };
  const send = (role, action, elapsed, fields) => update(role, action, plan.startsAt + elapsed, { ...target, ...fields });
  const observe = (role, elapsed, position, fields) => send(role, 'observe', elapsed, {
    position, ...(role !== legacy ? { ended: false, playing: true, sampledAt: elapsed, observedAt: plan.startsAt + elapsed } : {}),
    ...fields,
  });
  return { plan, players, send, observe };
}

test('tail stall keeps the seek target when the other player’s position is missing', async t => {
  for (const missing of ['visitor', 'host']) await t.test(missing, async () => {
    const app = roomFixture({ automatic: true });
    app.approve();
    await app.advance(11500);
    assert.equal(app.snapshot().synchronized, true);
    app.omitPosition(missing);
    const seek = app.host.element('seek');
    seek.value = 118.1;
    seek.dispatchEvent(new Event('change'));
    const stalled = missing === 'visitor' ? 'host' : 'visitor';
    for (const [role, position] of [[missing, 118.425], [stalled, 119.8]]) {
      const { video } = app[role];
      for (let i = 0; i < 120 && video.currentTime < position; i++) await app.advance(25);
      assert.ok(video.currentTime >= position);
      const active = app.snapshot();
      assert.equal(active.position, 118.1);
      assert.notEqual(active.startsAt, null);
      assert.deepEqual(active.ready, { host: true, visitor: true });
      assert.equal(video.paused, false);
      video.currentTime = position;
      video.stuck = true;
    }
    await app.advance(1150);
    const held = app.snapshot();
    assert.equal(app[missing].video.currentTime, 118.425);
    assert.equal(app[stalled].video.currentTime, 119.8);
    assert.equal(held.startsAt, null);
    assert.equal(held.waiting[stalled], 'stalled');
    assert.equal(held.waiting[missing], null);
    assert.equal(held.wantsPlay, true);
    assert.equal(held.position, 118.1);
    await app.advance(200);
    const retry = app[stalled].element('prepare');
    assert.equal(retry.hidden, false);
    assert.equal(retry.disabled, false);
    assert.equal(retry.textContent, '重试播放');
    assert.equal(app[missing].element('prepare').hidden, true);
    assert.equal(app.host.gain.value, 0);
    assert.equal(app.visitor.gain.value, 0);
    app.restorePosition(missing);
    for (const role of ['host', 'visitor']) {
      app[role].video.stuck = false;
      app[role].video.dispatchEvent(new Event('canplay'));
    }
    await app.advance(350);
    assert.equal(app.visitor.video.currentTime, 118.1);
    assert.equal(app.host.video.currentTime, 118.1);
    app[stalled].allowPlayback();
    await app.advance(4200);
    assert.equal(app.snapshot().ended, true);
  });
});

test('the shared tail checkpoint holds for connection loss and explicit pause', async t => {
  for (const [name, reports, target, action, role] of [
    ['missing visitor', { host: 119.8 }, 118.1, 'unavailable', 'host'],
    ['missing host', { visitor: 118.425 }, 118.1, 'unavailable', 'visitor'],
    ['both missing', {}, 118.1, 'unavailable', 'host'],
    ['stale visitor plan', { host: 119.8 }, 118.1, 'unavailable', 'host'],
    ['two usable positions', { host: 119.8, visitor: 118.425 }, 118.425, 'unavailable', 'host'],
    ['completed host', { host: 120, visitor: 118.425 }, 118.425, 'unavailable', 'host'],
    ['completed visitor', { host: 118.425, visitor: 120 }, 118.425, 'unavailable', 'visitor'],
    ['pause before late interruption', { host: 119.8 }, 118.1, 'pause', 'host'],
  ]) await t.test(name, () => {
    const { plan, observe, send } = observedPlayback({ duration: 120, position: 118.1 });
    for (const [seat, value] of Object.entries(reports)) {
      observe(seat, 1950, value, { ended: value === 120, playing: value !== 120 });
    }
    if (name === 'stale visitor plan') observe('visitor', 1980, 119.5, { version: plan.version - 1 });
    if (reports.visitor === 118.425) observe('visitor', 1990, 119.9, { sampledAt: 1900 });
    const result = send(role, action, 2100, { reason: 'connection', position: reports[role] });
    assert.equal(result.startsAt, null);
    assert.equal(result.position, target);
    assert.equal(result.ended, false);
    assert.equal(result.wantsPlay, action !== 'pause');
    if (action === 'pause') {
      const late = send('host', 'unavailable', 2200, { reason: 'connection', position: 119.8 });
      assert.equal(late.position, 118.1);
      assert.equal(late.wantsPlay, false);
    } else {
      assert.equal(result.waiting[role], 'connection');
    }
  });
});

test('an explicitly paused room with an observed automatic start stays paused across visitor refresh', async t => {
  for (const scenario of ['same host', 'pause reply not yet observed', 'unknown replacement host']) await t.test(scenario, async () => {
    const replaced = scenario === 'unknown replacement host';
    const awaitingPause = scenario === 'pause reply not yet observed';
    const app = roomFixture({ automatic: true });
    app.approve();
    await app.advance(11500);
    assert.equal(app.snapshot().synchronized, true);
    const play = app.host.element('play');
    assert.equal(play.textContent, '暂停');
    assert.equal(play.hidden, false);
    assert.equal(play.disabled, false);
    if (awaitingPause) app.setDelay(0, 900);
    play.dispatchEvent(new Event('click'));
    await app.advance(450);
    assert.equal(app.snapshot().wantsPlay, false);
    if (awaitingPause) {
      assert.notEqual(app.visitor.element('playback-status').textContent, '已暂停，等待房主播放。');
      app.setDelay(0, 0);
    } else {
      assert.equal(app.visitor.element('playback-status').textContent, '已暂停，等待房主播放。');
    }
    if (replaced) {
      const seat = app.savedHost();
      const recovered = app.send({ action: 'recover', playerId: randomUUID(),
        recoveryId: seat.recoveryId, recoveryGeneration: seat.recoveryGeneration + 1 }).state;
      assert.equal(recovered.ownsSeat, true);
      assert.equal(recovered.wantsPlay, false);
    }
    app.reloadVisitor();
    await app.advance(600);
    assert.equal(app.visitor.element('playback-status').textContent, '已暂停，等待房主播放。');
    assert.equal(app.visitor.video.paused, true);
    const prepare = app.visitor.element('prepare');
    assert.equal(prepare.hidden, !replaced);
    if (replaced) {
      assert.equal(prepare.disabled, false);
      assert.equal(prepare.textContent, '准备好了');
    } else {
      assert.equal(play.textContent, '播放');
      assert.equal(play.disabled, false);
      play.dispatchEvent(new Event('click'));
      await app.advance(2900);
      assert.equal(app.snapshot().synchronized, true);
      assert.equal(prepare.hidden, true);
    }
  });
});

test('an optional visitor Observe timeout cannot delay seat recovery on refresh', async () => {
  const app = roomFixture({ automatic: true });
  app.approve();
  await app.advance(11500);
  assert.equal(app.snapshot().synchronized, true);
  const play = app.host.element('play');
  assert.equal(play.textContent, '暂停');
  assert.equal(play.disabled, false);
  play.dispatchEvent(new Event('click'));
  await app.advance(450);
  const previous = app.savedVisitor();
  app.timeOutNextVisitorObserve();
  app.reloadVisitor();
  const requestIndex = app.visitorRequests.length;
  const replyIndex = app.visitorWire.length;
  await app.advance(50);
  assert.equal(app.visitorRequests[requestIndex], 'recover');
  assert.ok(app.visitorWire.slice(replyIndex).some(reply => reply.action === 'recover' && reply.status === 200));
  const restored = app.savedVisitor();
  assert.equal(restored.recoveryId, previous.recoveryId);
  assert.equal(restored.recoveryGeneration, previous.recoveryGeneration + 1);
  await app.advance(2700);
  assert.equal(app.visitorRequests[requestIndex + 1], 'observe');
  assert.ok(app.visitorWire.slice(replyIndex).some(reply => reply.action === 'unavailable'));
  assert.equal(app.visitor.element('playback-status').textContent, '已暂停，等待房主播放。');
  assert.equal(app.visitor.element('prepare').hidden, true);
  assert.equal(app.visitor.video.paused, true);
  assert.equal(play.textContent, '播放');
  play.dispatchEvent(new Event('click'));
  await app.advance(2900);
  assert.equal(app.snapshot().synchronized, true);
});

test('an admitted visitor can prepare from a visible control before a manual host play', async () => {
  const app = roomFixture({ automatic: true });
  await app.advance(250);
  const prepare = app.visitor.element('prepare');
  assert.equal(prepare.hidden, false);
  assert.equal(prepare.disabled, false);
  assert.equal(prepare.textContent, '准备好了');
  assert.equal(app.snapshot().wantsPlay, false);
  prepare.dispatchEvent(new Event('click'));
  await app.advance(450);
  assert.equal(app.snapshot().ready.visitor, true);
  assert.equal(app.snapshot().wantsPlay, false);
  assert.equal(app.visitor.video.paused, true);
  assert.equal(app.visitor.gain.value, 0);
  assert.equal(prepare.hidden, true);
});

test('mixed pages show advancement only after consecutive current-plan legacy samples', async t => {
  for (const legacy of ['host', 'visitor']) await t.test(legacy, () => {
    const { plan, players, send, observe } = observedPlayback({ legacy });
    const newer = legacy === 'host' ? 'visitor' : 'host';
    observe(newer, 100, 0.1);
    observe(legacy, 100, 0.1);
    observe(newer, 300, 0.3);
    assert.equal(observe(legacy, 300, 0.3).advancing[legacy], false);
    observe(newer, 500, 0.5);
    const progressing = observe(legacy, 500, 0.5);
    assert.deepEqual(progressing.advancing, { host: true, visitor: true });
    assert.equal(progressing.synchronized, false);
    assert.equal(progressing.playbackGap, null);
    assert.equal(observe(legacy, 700, 0.5).advancing[legacy], false);
    assert.equal(observe(legacy, 900, 2.5).advancing[legacy], false);
    assert.equal(observe(legacy, 1100, 2.7).advancing[legacy], false);
    assert.equal(observe(legacy, 1200, 2.8, { version: plan.version - 1 }).advancing[legacy], false);
    assert.equal(observe(legacy, 1250, 2.85, { playerId: randomUUID() }).advancing[legacy], false);
    assert.equal(observe(legacy, 1300, 2.9).advancing[legacy], true);
    const taken = send(legacy, 'recover', 1350, { playerId: randomUUID(), previousPlayerId: players[legacy] });
    assert.equal(taken.startsAt, null);
    assert.equal(observe(legacy, 1400, 3).advancing[legacy], false);
  });
});

test('tail stall resumes at both unfinished seats’ safe point without blocking the advancing seat', () => {
  const { observe, send } = observedPlayback({ duration: 3 });
  observe('host', 2600, 2.6);
  observe('visitor', 2600, 0.9);
  observe('host', 2800, 2.8);
  observe('visitor', 3050, 1.35);
  observe('host', 3050, 2.8);
  observe('visitor', 3750, 2.05);
  const held = observe('host', 3750, 2.8);
  assert.equal(held.position, 2.05);
  assert.equal(held.startsAt, null);
  assert.equal(held.wantsPlay, true);
  assert.deepEqual(held.blocked, []);
  assert.deepEqual(held.waiting, { host: 'stalled', visitor: null });
  const paused = send('host', 'pause', 3800);
  assert.equal(paused.wantsPlay, false);
  assert.equal(paused.position, 2.05);
});

test('a clockless observation cannot replace a current timed checkpoint', () => {
  const { observe, send } = observedPlayback({ duration: 3 });
  observe('host', 2450, 2.45);
  observe('visitor', 2600, 2.55);
  observe('visitor', 2620, 2.6, { sampledAt: undefined });
  observe('visitor', 2650, 2.3, { sampledAt: 2400 });
  observe('host', 3100, 3, { ended: true, playing: false });
  const held = send('host', 'unavailable', 3200, { reason: 'connection', position: 3 });
  assert.equal(held.position, 2.55);
  assert.equal(held.wantsPlay, true);
});

test('replacing the source retires an unsent audio report and an old Observe reply', async () => {
  const app = roomFixture({ automatic: true });
  app.approve();
  await app.advance(11500);
  const current = app.snapshot();
  assert.equal(current.synchronized, true);
  app.setDelay(0, 900);
  await app.advance(200);
  app.setDelay(0, 0);
  const { audioContext, player, video } = app.visitor;
  audioContext.state = 'suspended';
  audioContext.dispatchEvent(new Event('statechange'));
  await app.advance(410);
  assert.equal(video.paused, true);
  const replacedAt = app.now();
  player.load('/media/replacement.mp4');
  audioContext.state = 'running';
  audioContext.dispatchEvent(new Event('statechange'));
  await app.advance(1600);
  assert.equal(app.snapshot().version, current.version);
  assert.equal(app.snapshot().synchronized, true);
  assert.ok(!app.visitorWire.some(row => row.action === 'unavailable' && row.sent >= replacedAt));
  const older = app.visitorWire.find(row => row.action === 'observe' && row.received - row.sent === 900 &&
    row.sent < replacedAt && row.received > replacedAt);
  assert.ok(older);
  assert.ok(app.visitorWire.some(row => row.action === 'observe' && row.sent >= replacedAt && row.received < older.received));
});

test('changing the source retires an unsent buffering report without retracting a sent report', async t => {
  for (const timing of ['unsent', 'same source', 'already sent']) await t.test(timing, async () => {
    const app = roomFixture({ automatic: true });
    app.approve();
    await app.advance(11500);
    const current = app.snapshot();
    assert.equal(current.synchronized, true);
    if (timing !== 'already sent') {
      app.setDelay(0, 900);
      await app.advance(200);
      app.setDelay(0, 0);
    } else app.setDelay(0, 100);
    const { player, video } = app.visitor;
    video.readyState = video.HAVE_CURRENT_DATA;
    video.dispatchEvent(new Event('waiting'));
    const sent = timing === 'already sent';
    if (sent) {
      for (let elapsed = 0; elapsed < 410 && !app.snapshot().waiting.visitor; elapsed += 10) await app.advance(10);
      await app.advance(1);
    } else await app.advance(410);
    assert.equal(video.paused, true);
    const changedAt = app.now();
    assert.equal(app.snapshot().waiting.visitor, sent ? 'buffering' : null);
    player.load(timing === 'same source' ? '/media/synthetic.mp4' : '/media/replacement.mp4');
    video.readyState = video.HAVE_FUTURE_DATA + 1;
    await app.advance(1600);
    const reports = app.visitorWire.filter(row => row.action === 'unavailable' && row.status === 200);
    if (timing === 'unsent') {
      assert.deepEqual(reports, []);
      assert.equal(app.snapshot().version, current.version);
      assert.equal(app.snapshot().synchronized, true);
    } else {
      assert.equal(reports.length, 1);
      assert.equal(reports[0].sent < changedAt, sent);
      if (sent) assert.ok(reports[0].received > changedAt);
      assert.equal(app.snapshot().version, current.version + 1);
    }
  });
});

test('cancel, source and seat changes retire a pending scheduled play', async t => {
  for (const changed of ['cancel', 'source', 'seat']) await t.test(changed, async () => {
    const previous = Promise.withResolvers();
    const app = roomFixture({ automatic: true });
    app.approve();
    await app.advance(11500);
    const { video, element, player } = app.host;
    const play = video.play;
    let attempts = 0;
    video.play = function () { return ++attempts === 1 ? previous.promise : play.call(this); };
    const seek = position => {
      element('seek').value = position;
      element('seek').dispatchEvent(new Event('change'));
    };
    seek(119.98);
    for (let i = 0; i < 20 && !attempts; i++) await app.advance(100);
    assert.equal(attempts, 1);
    assert.equal(app.snapshot().ended, false);
    if (changed === 'cancel') element('play').dispatchEvent(new Event('click'));
    else if (changed === 'source') {
      player.load('/media/replacement.mp4');
      seek(35);
    } else {
      const seat = app.savedHost();
      const recovered = app.send({ action: 'recover', playerId: randomUUID(),
        recoveryId: seat.recoveryId, recoveryGeneration: seat.recoveryGeneration + 1 });
      assert.equal(recovered.state.ownsSeat, true);
    }
    await app.advance(500);
    previous.reject(new DOMException('Obsolete scheduled start', 'NotAllowedError'));
    await app.advance(1800);
    const result = app.snapshot();
    assert.equal(result.ended, false);
    assert.deepEqual(result.blocked, []);
    assert.notEqual(result.waiting.host, 'audio');
    assert.equal(element('prepare').hidden, true);
    if (changed === 'source') {
      assert.equal(result.position, 35);
      assert.equal(result.synchronized, true);
    } else {
      assert.equal(result.startsAt, null);
      assert.ok(video.paused && app.visitor.video.paused);
      assert.equal(app.host.gain.value, 0);
      assert.equal(app.visitor.gain.value, 0);
    }
  });
});

test('audio state changes are observed inside a 900 ms reply gap', async t => {
  for (const duration of [100, 410]) await t.test(duration + ' ms', async () => {
    const app = roomFixture({ automatic: true });
    app.approve();
    await app.advance(11500);
    const current = app.snapshot();
    assert.equal(current.synchronized, true);
    app.setDelay(0, 900);
    await app.advance(200);
    app.setDelay(0, 0);
    const suspendedAt = app.now();
    const { audioContext, gain } = app.visitor;
    audioContext.state = 'suspended';
    audioContext.dispatchEvent(new Event('statechange'));
    const gainOnEvent = gain.value;
    await app.advance(duration);
    const pausedBeforeResponse = app.visitor.video.paused;
    const peerPausedBeforeResponse = app.host.video.paused;
    audioContext.state = 'running';
    audioContext.dispatchEvent(new Event('statechange'));
    const gainOnRecovery = gain.value;
    await app.advance(650);
    const observed = app.snapshot();
    assert.equal(pausedBeforeResponse, duration > 200);
    assert.equal(peerPausedBeforeResponse, false, 'The peer still awaits propagation of the local report');
    assert.equal(gainOnEvent, 0);
    assert.equal(observed.version > current.version, duration > 200);
    assert.deepEqual(observed.blocked, []);
    if (duration < 200) {
      assert.equal(gainOnRecovery, 1);
      await app.advance(500);
      assert.equal(app.snapshot().version, current.version);
      assert.equal(app.snapshot().synchronized, true);
    } else {
      assert.equal(gainOnRecovery, 0);
      assert.notEqual(observed.startsAt, current.startsAt);
    }
    assert.ok(app.visitorWire.some(reply => reply.action === 'observe' && reply.received - reply.sent === 900 &&
      reply.sent <= suspendedAt && reply.received > suspendedAt + duration));
  });
});

test('initial play alone can stay pending and non-permission rejection allows a retry', async t => {
  await t.test('play alone stays pending', async () => {
    const previous = Promise.withResolvers();
    const app = roomFixture({ automatic: true, suspendHostAudio: true });
    const { video, element, gainWrites } = app.host;
    const nativePlay = video.play;
    let attempts = 0;
    video.play = function () { return ++attempts === 1 ? previous.promise : nativePlay.call(this); };
    app.approve();
    await app.advance(1500);
    assert.equal(element('prepare').hidden, false);
    assert.equal(element('prepare').textContent, '重试音频');
    assert.equal(app.visitor.element('prepare').hidden, true);
    assert.deepEqual(app.snapshot().blocked, []);
    app.host.allowPlayback();
    previous.reject(new DOMException('Obsolete request', 'NotAllowedError'));
    await app.advance(300);
    assert.deepEqual(app.snapshot().blocked, []);
    assert.ok(gainWrites.every(value => value === 0));
    await app.advance(11500);
    assert.equal(app.snapshot().synchronized, true);
  });

  await t.test('non-permission resume error', async () => {
    let available = false;
    const app = roomFixture({ automatic: true, suspendHostAudio: true,
      resumeHostAudio: () => available ? Promise.resolve() : Promise.reject(new DOMException('Output interrupted', 'InvalidStateError')) });
    app.approve();
    await app.advance(400);
    assert.equal(app.host.element('prepare').textContent, '重试音频');
    assert.equal(app.host.element('prepare').hidden, false);
    assert.equal(app.visitor.element('prepare').hidden, true);
    assert.deepEqual(app.snapshot().blocked, []);
    assert.equal(app.host.video.paused, true);
    available = true;
    app.host.allowPlayback();
    await app.advance(11500);
    assert.equal(app.snapshot().synchronized, true);
  });

  await t.test('closed output requires a fresh page', async () => {
    let associations = 0;
    let resumes = 0;
    const app = roomFixture({ automatic: true, suspendHostAudio: true,
      audioStage(role, stage) {
        if (role === 'host' && stage === 'media source') associations++;
        if (role === 'host' && stage === 'resume') resumes++;
      },
      resumeHostAudio: () => Promise.reject(new DOMException('Output closed', 'InvalidStateError')) });
    app.approve();
    await app.advance(400);
    app.host.audioContext.state = 'closed';
    app.host.audioContext.dispatchEvent(new Event('statechange'));
    await app.advance(2300);
    assert.equal(app.host.element('prepare').textContent, '刷新页面');
    assert.equal(app.visitor.element('prepare').hidden, true);
    app.host.allowPlayback();
    assert.equal(app.host.reloads, 1);
    assert.equal(associations, 1);
    assert.equal(resumes, 1, 'A known closed context is not probed again');
    assert.ok(app.host.gainWrites.every(value => value === 0));
  });
});

for (const blocked of [[], ['host'], ['visitor'], ['host', 'visitor']]) {
  test('first start keeps probes silent and prompts only blocked seats (' + (blocked.join(', ') || 'none') + ')', async () => {
    const app = roomFixture({ automatic: true, blocked });
    app.approve();
    await app.advance(600);
    for (const role of ['host', 'visitor']) {
      assert.equal(app[role].element('prepare').hidden, !blocked.includes(role));
      assert.equal(app[role].gain.value, 0);
    }
    if (blocked.length) {
      assert.equal(app.snapshot().startsAt, null);
      assert.deepEqual(app.snapshot().blocked, blocked);
      for (const role of blocked) app[role].allowPlayback();
    }
    await app.advance(11500);
    assert.equal(app.snapshot().synchronized, true);
    for (const role of ['host', 'visitor']) {
      assert.equal(app[role].element('prepare').hidden, true);
      assert.equal(app[role].video.paused, false);
      assert.equal(app[role].gain.value, 1);
    }
  });
}

test('a visitor stuck at the opening keeps both outputs silent and exposes the waiting reason', async () => {
  const app = roomFixture({ automatic: true });
  app.approve();
  await app.advance(600);
  app.visitor.video.stuck = true;
  await app.advance(1050);
  assert.equal(app.snapshot().advancing.host, true);
  assert.equal(app.snapshot().advancing.visitor, false);
  assert.equal(app.snapshot().firstStartPending, true);
  assert.equal(app.host.element('playback-status').textContent, '等待访客的播放进度推进。');
  assert.equal(app.host.gain.value, 0);
  assert.equal(app.visitor.gain.value, 0);
  app.visitor.video.stuck = false;
  app.visitor.video.currentTime = app.host.video.currentTime;
  await app.advance(9500);
  assert.equal(app.snapshot().firstStartPending, false);
  assert.equal(app.host.gain.value, 1);
  assert.equal(app.visitor.gain.value, 1);
});

test('both outputs remain silent when the visitor stalls only after each rewind', async () => {
  const app = roomFixture({ automatic: true });
  app.approve();
  const deadlines = [];
  for (let step = 0; step < 450 && deadlines.length < 3; step++) {
    await app.advance(100);
    const state = app.snapshot();
    if (state.preview) app.visitor.video.stuck = false;
    if (state.awaitingStart && state.startConfirmed && state.startsAt !== deadlines.at(-1)) {
      deadlines.push(state.startsAt);
      app.visitor.video.stuck = true;
    }
  }
  assert.equal(deadlines.length, 3, 'Both previews must succeed before each stalled audible attempt');
  await app.advance(deadlines.at(-1) - app.now() + 900);
  const observation = JSON.stringify({
    deadlines, checkedAt: app.now(), host: app.host.audibleStarts, visitor: app.visitor.audibleStarts,
  });
  assert.equal(app.host.gainWrites.includes(1), false, observation);
  assert.equal(app.visitor.gainWrites.includes(1), false, observation);
});

const openingAudioPending = { todo: process.env.BWP_REQUIRE_OPENING_AUDIO !== '1'
  && 'The live gain gate cannot replay samples consumed before paired movement proof' };

test('both peers hear the opening from the shared start position', openingAudioPending, async () => {
  const app = roomFixture({ automatic: true });
  app.approve();
  await app.advance(11500);
  const openings = [app.host.audibleStarts[0], app.visitor.audibleStarts[0]];
  assert.ok(openings.every(opening => opening && opening.position <= 0.01), JSON.stringify(openings));
});

test('a healthy 150 ms clip produces audio before both peers finish', openingAudioPending, async () => {
  const app = roomFixture({ automatic: true, duration: 0.15 });
  app.approve();
  await app.advance(11500);
  assert.equal(app.snapshot().ended, true);
  const openings = [app.host.audibleStarts[0], app.visitor.audibleStarts[0]];
  assert.ok(openings.every(Boolean), JSON.stringify(openings));
});

test('a healthy silent preview survives staggered progress responses 800 ms apart', () => {
  const room = createPlayback(120);
  const ids = { host: randomUUID(), visitor: randomUUID() };
  const update = (role, action, now, fields) =>
    room.update({ role, playerId: ids[role], action, ...fields }, now).state;
  room.startOnApproval();
  const { epoch, version } = update('host', 'observe', 0);
  const target = { epoch, version, claim: true, position: 0, nativeEnd: true };
  update('host', 'ready', 0, target);
  const { startsAt } = update('visitor', 'ready', 0, target);
  const observe = (role, now) => update(role, 'observe', now, {
    ...target, observedAt: now, sampledAt: now, position: (now - startsAt) / 1000, playing: true,
  });
  observe('host', startsAt + 200);
  observe('host', startsAt + 1100);
  observe('visitor', startsAt + 1900);
  observe('host', startsAt + 2700);
  const state = observe('host', startsAt + 3100);
  assert.equal(state.version, version, 'An observation gap alone does not establish video stalled');
  const visitor = observe('visitor', startsAt + 3500);
  assert.equal(visitor.preview, false);
  assert.equal(visitor.position, 0);
  assert.equal(visitor.awaitingStart, true);
});

test('an offline pause stays visible after the host refreshes without probing playback', async () => {
  const app = roomFixture({ automatic: true });
  app.approve();
  await app.advance(11500);
  assert.equal(app.snapshot().synchronized, true);
  app.disconnectHost();
  await app.advance(450);
  app.host.element('play').dispatchEvent(new Event('click'));
  app.reloadHost();
  app.restoreHost();
  await app.advance(1200);
  assert.equal(app.snapshot().wantsPlay, false);
  assert.equal(app.host.video.paused, true);
  assert.equal(app.host.gain.value, 0);
  assert.equal(app.host.element('playback-status').textContent, '已暂停，等待房主播放。');
});

function firstStartAfterPreview() {
  const room = createPlayback(120);
  const ids = { host: randomUUID(), visitor: randomUUID() };
  const update = (role, action, now, fields) =>
    room.update({ role, playerId: ids[role], action, ...fields }, now).state;
  room.startOnApproval();
  const { epoch, version } = update('host', 'observe', 0);
  const target = { epoch, version, claim: true, position: 0, nativeEnd: true };
  update('host', 'ready', 0, target);
  const { startsAt } = update('visitor', 'ready', 0, target);
  function progress(role, now) {
    return update(role, 'observe', now, { epoch, version, position: (now - startsAt) / 1000, playing: true });
  }
  progress('host', 1100);
  progress('visitor', 1100);
  progress('host', 1300);
  const aligned = progress('visitor', 1300);
  assert.equal(aligned.position, 0);
  assert.equal(aligned.startsAt, null);
  const realTarget = { ...target, version: aligned.version };
  update('host', 'ready', 1400, realTarget);
  const first = update('visitor', 'ready', 1400, realTarget);
  const agree = (role, now, deadline, confirms) => update(role, 'observe', now, {
    ...realTarget, ended: false, playing: false,
    startAcknowledgment: deadline, startConfirmation: confirms ? deadline : undefined,
  });
  return { update, realTarget, first, agree, ids };
}

test('an armed first start chooses the current Ready seat capabilities after recovery', async t => {
  for (const modern of [false, true]) await t.test(modern ? 'new host' : 'legacy host', () => {
    const { update, realTarget, first, agree, ids } = firstStartAfterPreview();
    agree('host', 1450, first.startsAt);
    const playerId = randomUUID();
    const recovered = update('host', 'recover', 1500, { playerId, previousPlayerId: ids.host });
    assert.equal(recovered.ownsSeat, true);
    assert.equal(recovered.startsAt, null);
    assert.equal(recovered.hostSupportsAutomaticStart, undefined);
    const target = { epoch: realTarget.epoch, version: recovered.version, position: 0 };
    const unknown = update('host', 'observe', 1550, { ...target, playerId });
    assert.equal(unknown.hostSupportsAutomaticStart, undefined);
    const visitorReady = update('visitor', 'ready', 1600, target);
    assert.equal(visitorReady.firstStartPending, true);
    assert.equal(visitorReady.startsAt, null);
    const newPlan = update('host', 'ready', 1650, { ...target, playerId, ...(modern && { nativeEnd: true }) });
    assert.equal(newPlan.hostSupportsAutomaticStart, modern);
    const missing = update('host', 'observe', 1700, { ...target, playerId });
    assert.equal(missing.hostSupportsAutomaticStart, modern);
    assert.equal(missing.awaitingStart, modern);
    assert.equal(missing.startConfirmed, !modern);
    assert.equal(missing.startAcknowledged, false);
    assert.ok(missing.startsAt > 1700);
    const obsolete = update('host', 'observe', 1750, { ...realTarget, ended: false,
      startAcknowledgment: first.startsAt, startConfirmation: first.startsAt });
    assert.equal(obsolete.ownsSeat, false);
    assert.equal(obsolete.hostSupportsAutomaticStart, modern);
    assert.equal(obsolete.startAcknowledged, false);
  });
});

test('replacing a new host also retires a released first start before both players advance', () => {
  const { update, realTarget, first, agree, ids } = firstStartAfterPreview();
  const deadline = first.startsAt;
  agree('host', 1500, deadline);
  agree('visitor', 1700, deadline, true);
  assert.equal(agree('host', 1900, deadline, true).startConfirmed, true);
  for (let now = 2500; now < deadline; now += 1000) {
    for (const role of ['host', 'visitor']) agree(role, now, deadline, true);
  }
  const released = agree('host', deadline, deadline);
  assert.equal(released.awaitingStart, false);
  assert.equal(released.firstStartPending, true);
  const playerId = randomUUID();
  const recovered = update('host', 'recover', deadline + 100, { playerId, previousPlayerId: ids.host });
  assert.equal(recovered.startsAt, null);
  const target = { ...realTarget, version: recovered.version };
  update('host', 'ready', deadline + 150, { ...target, playerId });
  const scheduled = update('visitor', 'ready', deadline + 200, target);
  assert.ok(scheduled.startsAt > deadline);
  assert.equal(scheduled.awaitingStart, true);
  assert.equal(scheduled.startConfirmed, false);
});

test('first start waits for both acknowledgments before releasing audio', () => {
  const { update, realTarget, first, agree } = firstStartAfterPreview();
  agree('host', 1500, first.startsAt);
  agree('visitor', 1700, first.startsAt);
  agree('visitor', 1900, first.startsAt, true);
  const revised = agree('host', first.startsAt - 2200, first.startsAt, true);
  assert.ok(revised.startsAt > first.startsAt);
  assert.equal(revised.startConfirmed, false);
  const deadline = revised.startsAt;
  const retryAt = revised.serverTime;
  agree('host', retryAt + 200, deadline);
  agree('visitor', retryAt + 400, deadline);
  agree('host', retryAt + 500, deadline, true);
  const agreed = agree('visitor', retryAt + 600, deadline, true);
  assert.equal(agreed.startConfirmed, true);
  assert.equal(agreed.synchronized, false);
  for (let now = retryAt + 1000; now < deadline; now += 1000) {
    for (const role of ['host', 'visitor']) agree(role, now, deadline, true);
  }
  const started = agree('host', deadline, deadline);
  assert.equal(started.firstStartPending, true);
  assert.equal(started.position, 0);
  const progressAt = (role, elapsed) => update(role, 'observe', deadline + elapsed,
    { ...realTarget, position: elapsed / 1000, playing: true });
  const host = progressAt('host', 100);
  assert.equal(host.firstStartPending, true);
  const visitor = progressAt('visitor', 900);
  assert.equal(visitor.startsAt, deadline, 'A late report does not prove that the host stalled');
  assert.equal(visitor.firstStartPending, false, 'Healthy peers with reports 800 ms apart can release audio');
  assert.equal(visitor.synchronized, true);
});

test('a proven stall takes priority when stale movement projects both playheads to the same position', () => {
  const { update, realTarget, first, agree } = firstStartAfterPreview();
  const deadline = first.startsAt;
  agree('host', 1500, deadline);
  agree('visitor', 1700, deadline, true);
  assert.equal(agree('host', 1900, deadline, true).startConfirmed, true);
  for (let now = 2500; now < deadline; now += 1000) {
    for (const role of ['host', 'visitor']) agree(role, now, deadline, true);
  }
  const report = (role, elapsed, position) => update(role, 'observe', deadline + elapsed,
    { ...realTarget, position, playing: true });
  report('host', 100, 0.1);
  report('host', 300, 0.3);
  report('host', 400, 0.3);
  assert.equal(report('visitor', 900, 0.1).firstStartPending, true);
  const stalled = report('host', 1100, 0.3);
  assert.equal(stalled.firstStartPending, true, 'The player must keep gain closed');
  assert.equal(stalled.synchronized, false);
  assert.equal(stalled.startsAt, null);
  assert.equal(stalled.waiting.host, 'buffering');
});

function shortFirstStartFixture() {
  const room = createPlayback(1);
  const ids = { host: randomUUID(), visitor: randomUUID() };
  const update = (role, action, now, fields) =>
    room.update({ role, playerId: ids[role], action, ...fields }, now).state;
  room.startOnApproval();
  const { epoch, version } = update('host', 'observe', 0);
  const target = { epoch, version, claim: true, position: 0, nativeEnd: true };
  update('host', 'ready', 0, target);
  const { startsAt } = update('visitor', 'ready', 0, target);
  const plan = { ...target, startAcknowledgment: startsAt, startConfirmation: startsAt };
  update('host', 'observe', 200, plan);
  update('visitor', 'observe', 400, plan);
  assert.equal(update('host', 'observe', 600, plan).startConfirmed, true);
  for (let now = 1500; now < startsAt; now += 1000) {
    for (const role of ['host', 'visitor']) update(role, 'observe', now, plan);
  }
  return { update, target, startsAt };
}

test('a short clip cannot end while one player still shows its first frame', () => {
  const { update, target, startsAt } = shortFirstStartFixture();
  update('host', 'observe', startsAt + 100, { ...target, position: 0.1, playing: true });
  update('visitor', 'observe', startsAt + 100, { ...target, playing: true });
  update('host', 'observe', startsAt + 1000, { ...target, position: 1, ended: true });
  const stalled = update('visitor', 'observe', startsAt + 1000, { ...target, playing: true });
  assert.equal(stalled.ended, false);
  assert.equal(stalled.startsAt, null);
  assert.equal(stalled.position, 0);
  assert.equal(stalled.waiting.visitor, 'buffering');
});

test('a delayed stationary sample uses its capture time when checking for a stall', () => {
  const { update, target, startsAt } = shortFirstStartFixture();
  update('visitor', 'observe', startsAt + 10, {
    ...target, sampledAt: 10, observedAt: startsAt + 10, playing: true,
  });
  update('host', 'observe', startsAt + 1000, { ...target, position: 1, ended: true });
  const delayed = update('visitor', 'observe', startsAt + 1410, {
    ...target, sampledAt: 210, observedAt: startsAt + 210, playing: true,
  });
  assert.equal(delayed.startsAt, startsAt);
  assert.equal(delayed.ended, false);
  assert.equal(delayed.waiting.visitor, null);
});

test('a short clip plays through both terminal frames when the visitor starts 300 ms late', () => {
  const { update, target, startsAt } = shortFirstStartFixture();
  const report = (role, ms, position, ended = false) => update(role, 'observe', startsAt + ms,
    { ...target, position, playing: !ended, ended });
  report('host', 100, 0.1);
  report('host', 300, 0.3);
  report('visitor', 400, 0.1);
  const playing = report('visitor', 500, 0.2);
  assert.equal(playing.synchronized, true);
  assert.equal(report('host', 1000, 1, true).ended, false);
  assert.equal(report('visitor', 1300, 1, true).ended, true);
});

test('projected duration cannot end a first start with a media clock stuck at zero', () => {
  const room = createPlayback(2);
  const ids = { host: randomUUID(), visitor: randomUUID() };
  room.startOnApproval();
  const update = (role, action, now, fields) =>
    room.update({ role, playerId: ids[role], action, ...fields }, now).state;
  const { epoch, version } = update('host', 'observe', 0);
  const target = { epoch, version, claim: true, position: 0, nativeEnd: true };
  update('host', 'ready', 0, target);
  const { startsAt } = update('visitor', 'ready', 0, target);
  const waiting = update('visitor', 'observe', startsAt + 2000, { ...target, playing: true });
  assert.equal(waiting.ended, false);
  assert.equal(waiting.firstStartPending, true);
  assert.equal(waiting.position, 0);
  assert.equal(waiting.startsAt, null);
  assert.equal(waiting.waiting.visitor, 'buffering');
});

for (const direction of [-1, 1]) {
  test('opposing 0.31 second errors converge when the host is ' + (direction > 0 ? 'ahead' : 'behind'), async t => {
    const app = roomFixture();
    await app.start();
    app.host.video.currentTime += direction * 0.31;
    app.visitor.video.currentTime -= direction * 0.31;
    const gap = () => Math.abs(app.host.video.currentTime - app.visitor.video.currentTime);
    assert.ok(Math.abs(gap() - 0.62) < 0.001);
    await app.advance(1500);
    const samples = [];
    for (let i = 0; i < 100; i++) {
      samples.push(gap());
      assert.ok(!app.host.video.paused && !app.visitor.video.paused);
      await app.advance(100);
    }
    const clear = samples.filter(value => value < 0.5).length;
    const result = clear + '/100 below 0.5 s, max ' + Math.max(...samples).toFixed(3) + ' s';
    t.diagnostic(result);
    assert.ok(clear >= 95, result);
  });
}

for (const refresh of [false, true]) {
  test('a newer host pause survives a committed seek with a lost reply' + (refresh ? ' and refresh' : ''), async () => {
    const app = roomFixture();
    await app.start();
    app.loseNextSeekReply();
    const seek = app.host.element('seek');
    seek.value = 45;
    seek.dispatchEvent(new Event('change'));
    await app.advance(100);
    assert.equal(app.committedSeek.position, 45);
    assert.equal(app.committedSeek.wantsPlay, true);
    assert.equal(app.host.element('play').disabled, false);
    app.host.element('play').dispatchEvent(new Event('click'));
    await app.advance(200);
    if (refresh) {
      app.reloadHost();
      await app.advance(300);
    }
    app.restoreHost();
    await app.advance(4000);
    const final = app.snapshot();
    assert.equal(final.wantsPlay, false);
    assert.equal(final.startsAt, null);
    assert.ok(app.host.video.paused && app.visitor.video.paused);
  });
}

for (const direction of [-1, 1]) {
  test('opposing steady-state errors under ' + (direction > 0 ? 'request' : 'reply') + ' asymmetry', async t => {
    const app = roomFixture();
    app.setDelay(direction > 0 ? 80 : 0, direction < 0 ? 80 : 0);
    await app.start();
    const host = app.host.player.measure();
    const visitor = app.visitor.player.measure();
    const wire = app.visitorWire.at(-1);
    assert.equal(visitor.offset - host.offset, direction * 40);
    assert.equal(wire.serverTime - (wire.sent + wire.received) / 2, direction * 40);
    app.host.video.currentTime = host.target - direction * 0.074;
    app.visitor.video.currentTime = visitor.target + direction * 0.419;
    await app.advance(1500);
    const gaps = [];
    for (let i = 0; i < 100; i++) {
      assert.ok(!app.host.video.paused && !app.visitor.video.paused);
      gaps.push(Math.abs(app.host.video.currentTime - app.visitor.video.currentTime));
      await app.advance(100);
    }
    const clear = gaps.filter(gap => gap < 0.5).length;
    const metric = clear + '/100 below 0.5 s, max ' + Math.max(...gaps).toFixed(3) + ' s';
    t.diagnostic('target gap ' + (visitor.target - host.target).toFixed(3) + ' s, midpoint bias ' + visitor.offset + ' ms, ' + metric);
    assert.ok(clear >= 95, metric);
  });
}

for (const direction of [-1, 1]) {
  test('clock retains a fast sample then re-estimates after expiry under ' + (direction > 0 ? 'request' : 'reply') + ' delay', async t => {
    const app = roomFixture();
    app.setDelay(40, 40);
    await app.start();
    assert.equal(app.visitor.player.measure().offset, 0);
    app.setDelay(direction > 0 ? 700 : 0, direction < 0 ? 700 : 0);
    await app.advance(28_000);
    assert.equal(app.visitor.player.measure().offset, 0);
    await app.advance(3500);
    const expiredOffset = app.visitor.player.measure().offset;
    app.setDelay(40, 40);
    await app.advance(1100);
    const restoredOffset = app.visitor.player.measure().offset;
    t.diagnostic('retained 0 ms, expired ' + expiredOffset + ' ms, restored ' + restoredOffset + ' ms');
    assert.equal(expiredOffset, direction * 350);
    assert.equal(restoredOffset, 0);
  });
}

for (const loss of ['request', 'reply', 'late']) {
  test('second refresh preserves a pending pause across lost recovery ' + loss, async t => {
    const app = roomFixture();
    await app.start();
    app.loseNextSeekReply();
    const seek = app.host.element('seek');
    seek.value = 45;
    seek.dispatchEvent(new Event('change'));
    await app.advance(100);
    assert.equal(app.committedSeek.position, 45);
    app.host.element('play').dispatchEvent(new Event('click'));
    const { playerId: firstSeat, recoveryId: root, pause: originalPause } = app.savedHost();
    assert.equal(originalPause.action, 'pause');
    app.loseNextRecovery(loss);
    app.reloadHost();
    app.restoreHost();
    await app.advance(120);
    const first = app.recovery[0];
    assert.equal(first.command.recoveryId, root);
    assert.equal(first.result, { request: 'request lost', reply: 'applied', late: 'delayed' }[loss]);
    assert.deepEqual(app.savedHost().pause, originalPause);
    assert.equal(app.snapshot().wantsPlay, true);

    app.reloadHost();
    app.restoreHost();
    app.loseNextPauseReply();
    await app.advance(120);
    // The pause is retained even when the server has applied it, until a definitive reply.
    assert.deepEqual(app.savedHost().pause, originalPause);
    t.diagnostic('recovery: ' + app.recovery.map(entry => entry.result).join(', ') + '; pause: ' + app.pauses.map(entry => entry.result).join(', '));
    assert.equal(app.snapshot().wantsPlay, false);
    assert.equal(app.snapshot().startsAt, null);
    if (loss === 'late') assert.equal(app.recovery.at(-1).result, 'late conflict');
    app.restoreHost();
    await app.advance(1600);
    assert.equal(app.savedHost().pause, undefined);
    assert.deepEqual(app.pauses.map(entry => entry.result), ['applied', 'conflict']);
    assert.ok(app.host.video.paused && app.visitor.video.paused);
    const currentSeat = app.savedHost().playerId;
    assert.notEqual(currentSeat, firstSeat);
    assert.notEqual(currentSeat, first.command.playerId);

    const paused = app.snapshot();
    assert.equal(app.send({ action: 'play', playerId: currentSeat, epoch: paused.epoch, version: paused.version }).conflict, false);
    assert.equal(app.send({ ...originalPause, playerId: currentSeat }).conflict, true);
    const playing = app.snapshot();
    assert.equal(app.send({ action: 'ready', playerId: currentSeat, epoch: paused.epoch, version: paused.version, position: 45 }).conflict, true);
    assert.equal(app.send({ action: 'pause', playerId: first.command.playerId, epoch: playing.epoch, version: playing.version }).conflict, true);
    assert.equal(app.send({ action: 'recover', playerId: first.command.playerId, previousPlayerId: firstSeat }).conflict, true);
    assert.equal(app.snapshot().wantsPlay, true);
  });
}


for (const deliver of [true, false]) {
  test('host can pause during a pending seek even when its reply is ' + (deliver ? 'delayed' : 'lost'), async () => {
    const app = roomFixture();
    await app.start();
    function seekTo(position) {
      const seek = app.host.element('seek');
      seek.value = position;
      seek.dispatchEvent(new Event('change'));
    }
    seekTo(30);
    await app.advance(10);
    const earlier = app.snapshot();
    assert.equal(earlier.position, 30);
    const reply = app.holdNextSeekReply();
    seekTo(45);
    await app.advance(20);
    const newest = app.committedSeek;
    assert.equal(newest.position, 45);

    const pauseButton = app.host.element('play');
    assert.equal(pauseButton.disabled, false);
    pauseButton.dispatchEvent(new Event('click'));
    if (!deliver) app.disconnectHost();
    const pending = app.savedHost().pause;
    const owner = app.savedHost().playerId;
    assert.equal(pending.action, 'pause');
    assert.ok(pending.afterSeekId);
    assert.equal(app.host.video.paused, true);

    app.visitor.video.readyState = 2;
    app.visitor.video.dispatchEvent(new Event('waiting'));
    app.host.video.dispatchEvent(new Event('canplay'));
    assert.equal(app.send({ action: 'ready', playerId: owner, epoch: earlier.epoch,
      version: earlier.version, position: earlier.position }).conflict, true);
    await app.advance(300);
    assert.equal(app.host.video.paused, true);

    reply(deliver);
    await app.advance(200);
    if (!deliver) {
      assert.deepEqual(app.savedHost().pause, pending);
      app.reloadHost();
      await app.advance(200);
      app.restoreHost();
    }
    app.visitor.video.readyState = 4;
    app.visitor.video.dispatchEvent(new Event('canplay'));
    await app.advance(2300);
    const paused = app.snapshot();
    assert.equal(paused.wantsPlay, false);
    assert.equal(paused.startsAt, null);
    assert.equal(paused.position, 45);
    assert.ok(app.host.video.paused && app.visitor.video.paused);
    assert.equal(app.savedHost().pause, undefined);

    const active = app.savedHost().playerId;
    assert.equal(app.send({ action: 'play', playerId: active, epoch: paused.epoch, version: paused.version }).conflict, false);
    assert.equal(app.send({ ...pending, playerId: active }).conflict, true);
    assert.equal(app.snapshot().wantsPlay, true);
  });
}


test('an oversized older saved recovery history migrates in bounded batches', async () => {
  const app = roomFixture();
  await app.start();
  app.loseNextSeekReply();
  const seek = app.host.element('seek');
  seek.value = 45;
  seek.dispatchEvent(new Event('change'));
  await app.advance(100);
  app.host.element('play').dispatchEvent(new Event('click'));
  const { playerId, pause } = app.savedHost();
  app.saveHost({
    playerId: randomUUID(), pause,
    recoveryCandidates: [...Array.from({ length: 106 }, () => randomUUID()), playerId],
  });
  app.reloadHost();
  app.restoreHost();
  await app.advance(1400);

  assert.deepEqual(app.recovery.map(({ result }) => result), ['conflict', 'conflict', 'conflict', 'applied']);
  assert.ok(app.recovery.every(({ command }) => Buffer.byteLength(JSON.stringify(command)) < 4096));
  assert.equal(app.savedHost().legacySeats, undefined);
  assert.equal(app.savedHost().pause, undefined);
  assert.equal(app.snapshot().wantsPlay, false);
});

test('long host disconnection keeps a fixed-size recovery lineage and retains pause', async () => {
  const app = roomFixture();
  await app.start();
  app.loseNextSeekReply();
  const seek = app.host.element('seek');
  seek.value = 45;
  seek.dispatchEvent(new Event('change'));
  await app.advance(100);
  app.host.element('play').dispatchEvent(new Event('click'));
  const { recoveryId, pause } = app.savedHost();
  for (let i = 1; i <= 110; i++) {
    app.loseNextRecovery(i % 2 ? 'request' : 'reply');
    app.reloadHost();
    app.restoreHost();
    await app.advance(80);
    const saved = app.savedHost();
    assert.equal(saved.recoveryId, recoveryId);
    assert.equal(saved.recoveryGeneration, i);
    assert.deepEqual(saved.pause, pause);
    assert.equal(saved.legacySeats, undefined);
  }
  await app.advance(4500);
  assert.equal(app.snapshot().waiting.host, 'connection');
  const inDoubt = app.recovery[77].command;
  app.reloadHost();
  app.restoreHost();
  await app.advance(1600);
  const recovered = app.recovery.at(-1);
  assert.equal(recovered.command.recoveryGeneration, 111);
  assert.equal(recovered.result, 'applied');
  assert.ok(app.recovery.every(({ command }) => Buffer.byteLength(JSON.stringify(command)) < 200));
  assert.equal(app.send(inDoubt).conflict, true);
  assert.equal(app.send(recovered.command).conflict, false);
  assert.equal(app.savedHost().pause, undefined);
  assert.equal(app.snapshot().wantsPlay, false);
});


for (const holdClaimReply of [false, true]) {
  test('a tab that reclaims an expired seat can refresh again ' + (holdClaimReply ? 'before' : 'after') + ' its reply', async () => {
    const app = roomFixture();
    await app.start();
    app.reloadHost();
    await app.advance(1700);
    const remembered = app.savedHost();
    assert.equal(remembered.recoveryGeneration, 1);
    const former = randomUUID();
    assert.equal(app.send({ action: 'recover', playerId: former,
      recoveryId: remembered.recoveryId, recoveryGeneration: 2 }).conflict, false);
    await app.advance(4500);
    assert.equal(app.snapshot().waiting.host, 'connection');
    const release = holdClaimReply ? app.holdNextReadyReply() : undefined;
    app.host.element('prepare').dispatchEvent(new Event('click'));
    await app.advance(250);
    if (holdClaimReply) assert.equal(app.committedReady?.ownsSeat, true);
    const beforeRefresh = app.savedHost();
    assert.equal(beforeRefresh.playerId, remembered.playerId);
    app.reloadHost();
    release?.();
    await app.advance(1400);
    assert.equal(app.recovery.at(-1).result, 'applied');
    assert.notEqual(app.savedHost().playerId, remembered.playerId);
  });
}

test('host pause reaches the room before playback starts despite a held readiness reply', async () => {
  const app = roomFixture();
  await app.start();
  const playerId = app.savedHost().playerId;
  const { epoch, version } = app.snapshot();
  app.host.video.readyState = 2;
  assert.equal(app.send({ action: 'unavailable', reason: 'buffering', playerId, epoch, version }).conflict, false);
  await app.advance(600);
  assert.equal(app.snapshot().ready.visitor, true);
  assert.equal(app.snapshot().ready.host, false);

  const release = app.holdNextReadyReply();
  app.host.video.readyState = 4;
  app.host.video.dispatchEvent(new Event('canplay'));
  await app.advance(80);
  assert.ok(app.committedReady.startsAt !== null);
  assert.equal(app.host.element('play').disabled, false);
  app.host.element('play').dispatchEvent(new Event('click'));
  assert.equal(app.savedHost().pause.action, 'pause');

  try {
    await app.advance(1000);
    assert.ok(app.visitor.video.paused);
    assert.equal(app.snapshot().wantsPlay, false);
  } finally {
    release();
  }
  await app.advance(1000);
  assert.equal(app.snapshot().startsAt, null);
  assert.ok(app.host.video.paused && app.visitor.video.paused);
});

test('a delayed recovery from a retired lineage cannot retake a freshly claimed seat', async () => {
  const app = roomFixture();
  await app.start();
  const first = app.savedHost();
  const former = randomUUID();
  assert.equal(app.send({ action: 'recover', playerId: former,
    recoveryId: first.recoveryId, recoveryGeneration: 1 }).conflict, false);
  await app.advance(4500);
  assert.equal(app.snapshot().waiting.host, 'connection');
  app.host.element('prepare').dispatchEvent(new Event('click'));
  await app.advance(400);
  const claimed = app.savedHost();
  assert.equal(claimed.playerId, first.playerId);
  assert.equal(app.send({ action: 'recover', playerId: former,
    recoveryId: first.recoveryId, recoveryGeneration: 2 }).conflict, true);
  assert.notEqual(claimed.recoveryId, first.recoveryId);
});


for (const heldReady of [false, true]) {
  test('visitor stays paused after server Pause with ' + (heldReady ? 'an obsolete ready reply' : 'no fresh scheduled start'), async t => {
    const app = roomFixture();
    await app.start();
    const playerId = app.savedHost().playerId;
    const interrupted = heldReady ? app.visitor : app.host;
    interrupted.video.readyState = 2;
    const { epoch, version } = app.snapshot();
    const interruption = app.send({ action: 'unavailable', reason: 'buffering', playerId, epoch, version });
    assert.equal(interruption.conflict, false);
    await app.advance(600);
    if (heldReady) app.setDelay(0, 1100);
    interrupted.video.readyState = 4;
    interrupted.video.dispatchEvent(new Event('canplay'));
    await app.advance(300);
    const scheduled = app.snapshot();
    assert.notEqual(scheduled.startsAt, null);
    if (!heldReady) {
      assert.ok(app.visitorWire.some(sample => sample.startsAt === scheduled.startsAt));
      app.setDelay(0, 1100);
    }
    assert.ok(app.now() < scheduled.startsAt);
    app.host.element('play').dispatchEvent(new Event('click'));
    await app.advance(100);
    const paused = app.snapshot();
    assert.equal(paused.wantsPlay, false);
    assert.equal(paused.startsAt, null);
    assert.ok(paused.version > scheduled.version);
    await app.advance(850);
    const stale = app.visitorWire.findLast(reply => reply.startsAt === scheduled.startsAt);
    assert.ok(stale);
    t.diagnostic('scheduled v' + scheduled.version + ' at ' + scheduled.startsAt +
      ' ms, visitor ' + stale.action + ' HTTP ' + stale.status + ' v' + stale.version +
      ' sent ' + stale.sent + ' and received ' + stale.received + ' ms, host pause HTTP 200 v' +
      paused.version + ', visitor paused at ' + app.now() + ' ms = ' + app.visitor.video.paused);
    assert.equal(app.visitor.video.paused, true);
    await app.advance(1150);
    assert.equal(app.snapshot().wantsPlay, false);
    assert.ok(app.host.video.paused && app.visitor.video.paused);
  });
}

test('a definitive stale pause conflict clears the old document without interrupting the replacement host', async t => {
  const app = roomFixture();
  await app.start();
  app.loseNextSeekReply();
  const slider = app.host.element('seek');
  slider.value = 45;
  slider.dispatchEvent(new Event('change'));
  await app.advance(100);
  app.host.element('play').dispatchEvent(new Event('click'));
  const original = app.savedHost();
  assert.equal(original.pause.action, 'pause');
  await app.advance(4500);
  const old = app.snapshot();
  assert.equal(old.waiting.host, 'connection');
  const playerId = randomUUID();
  const replacement = app.send({ action: 'ready', claim: true, playerId,
    recoveryId: randomUUID(), epoch: old.epoch, version: old.version, position: old.position });
  assert.equal(replacement.conflict, false);
  // The replacement can deliberately pause and then play at its own current version.
  assert.equal(app.send({ action: 'pause', playerId, epoch: old.epoch, version: old.version }).conflict, false);
  const paused = app.snapshot();
  assert.equal(app.send({ action: 'ready', playerId, epoch: paused.epoch,
    version: paused.version, position: paused.position }).conflict, false);
  await app.advance(500);
  assert.equal(app.send({ action: 'play', playerId, epoch: paused.epoch, version: paused.version }).conflict, false);
  const played = app.snapshot();
  assert.equal(played.wantsPlay, true);
  app.restoreHost();
  await app.advance(1200);
  const rejected = app.pauses.at(-1);
  assert.equal(rejected.result, 'conflict');
  assert.equal(rejected.state.ownsSeat, false);
  assert.equal(rejected.state.version, played.version);
  t.diagnostic('old host pause v' + original.pause.version + ' returned HTTP 409 at current v' +
    played.version + ' with ownsSeat false, saved pause still present = ' + Boolean(app.savedHost()?.pause));
  assert.equal(app.snapshot().wantsPlay, true);
  assert.equal(app.savedHost()?.pause, undefined);
  assert.equal(app.send({ action: 'ready', role: 'visitor', playerId: app.savedVisitor().playerId,
    epoch: old.epoch, version: old.version, position: old.position }).conflict, true);
});

test('a same-seat recovered pause clears on acknowledgment and a later Play stays authoritative', async t => {
  const app = roomFixture();
  await app.start();
  app.loseNextSeekReply();
  const seek = app.host.element('seek');
  seek.value = 45;
  seek.dispatchEvent(new Event('change'));
  await app.advance(100);
  app.host.element('play').dispatchEvent(new Event('click'));
  const { pause, recoveryId } = app.savedHost();
  app.reloadHost();
  app.loseNextPauseReply();
  app.restoreHost();
  await app.advance(300);
  const committed = app.pauses.at(-1);
  assert.equal(committed.result, 'applied');
  assert.deepEqual(app.savedHost().pause, pause);
  assert.equal(app.snapshot().wantsPlay, false);
  app.reloadHost();
  app.restoreHost();
  await app.advance(1700);
  const acknowledged = app.pauses.at(-1);
  const active = app.savedHost();
  assert.equal(acknowledged.result, 'conflict');
  assert.equal(acknowledged.state.ownsSeat, true);
  assert.equal(active.recoveryId, recoveryId);
  assert.equal(active.pause, undefined);

  assert.equal(app.host.element('play').disabled, false);
  app.host.element('play').dispatchEvent(new Event('click'));
  await app.advance(1800);
  const playing = app.snapshot();
  assert.equal(playing.wantsPlay, true);
  assert.ok(!app.host.video.paused && !app.visitor.video.paused);
  const stale = app.send({ ...pause, playerId: active.playerId });
  assert.equal(stale.conflict, true);
  assert.equal(stale.state.wantsPlay, true);
  assert.equal(stale.state.version, playing.version);
  t.diagnostic('pause v' + pause.version + ' committed as v' + committed.state.version +
    ', duplicate HTTP 409 with ownership at v' + acknowledged.state.version +
    ', deliberate Play v' + playing.version + ' survived later HTTP 409 for stale pause');
});

test('visitor still prepares after transient future data on initial seeked', async t => {
  async function prepareWithSeekedState(seekedState) {
    const app = roomFixture();
    const { video, element } = app.visitor;
    let reloads = 0;
    video.load = () => {
      reloads++;
      video.readyState = video.HAVE_FUTURE_DATA;
      video.dispatchEvent(new Event('canplay'));
    };

    await app.advance(250);
    app.host.element('prepare').dispatchEvent(new Event('click'));
    video.readyState = video.HAVE_CURRENT_DATA;
    element('prepare').dispatchEvent(new Event('click'));
    await app.advance(180);
    const beforeSeeked = app.snapshot();
    assert.equal(beforeSeeked.version, 0);
    assert.equal(beforeSeeked.wantsPlay, false);
    assert.equal(beforeSeeked.startsAt, null);
    assert.equal(beforeSeeked.ready.visitor, false);
    assert.equal(video.currentTime, 0);
    assert.equal(video.paused, true);
    assert.equal(element('prepare').hidden, true, 'The guest has already primed the media element');

    // The media event exposes a frame as ready, then loses future data before the next sync.
    video.readyState = seekedState;
    video.dispatchEvent(new Event('seeked'));
    video.readyState = video.HAVE_CURRENT_DATA;
    await app.advance(3500);
    assert.ok(!app.visitorWire.some(reply => reply.action === 'ready'));
    assert.equal(app.snapshot().ready.visitor, false);

    video.dispatchEvent(new Event('stalled'));
    await app.advance(400);
    const room = app.snapshot();
    return { reloads, ready: room.ready.visitor, version: room.version, paused: video.paused };
  }

  const steady = await prepareWithSeekedState(2);
  assert.deepEqual(steady, { reloads: 1, ready: true, version: 0, paused: true });
  const transient = await prepareWithSeekedState(4);
  t.diagnostic('seeked=2 ' + JSON.stringify(steady) + '; seeked=4 then 2 ' + JSON.stringify(transient));
  assert.deepEqual(transient, steady, 'Transient HAVE_ENOUGH_DATA must preserve retry before the first Ready');
});


test('initial visitor rewind waits for a pending Ready result', async () => {
  const app = roomFixture();
  const { video, element } = app.visitor;
  let reloads = 0;
  video.load = () => { reloads++; };

  await app.advance(250);
  video.readyState = video.HAVE_CURRENT_DATA;
  element('prepare').dispatchEvent(new Event('click'));
  await app.advance(180);
  assert.equal(video.currentTime, 0);
  assert.equal(video.paused, true);

  app.setDelay(0, 1000);
  video.readyState = 4;
  video.dispatchEvent(new Event('seeked'));
  await app.advance(250);
  assert.equal(app.snapshot().ready.visitor, true, 'Ready applied before its delayed reply');
  assert.ok(!app.visitorWire.some(reply => reply.action === 'ready'));

  video.readyState = video.HAVE_CURRENT_DATA;
  video.dispatchEvent(new Event('stalled'));
  await app.advance(1400);
  assert.ok(app.visitorWire.some(reply => reply.action === 'ready' && reply.status === 200));
  video.dispatchEvent(new Event('stalled'));
  await app.advance(400);
  assert.equal(reloads, 0);
  assert.equal(app.snapshot().ready.visitor, true);
});

test('seat-owning host reloads once for a visitor interruption', async () => {
  const app = roomFixture();
  await app.start();
  const before = app.snapshot();
  let reloads = 0;
  const host = app.host.video;
  host.load = () => {
    reloads++;
    host.readyState = host.HAVE_FUTURE_DATA;
    host.dispatchEvent(new Event('canplay'));
  };
  host.readyState = host.HAVE_CURRENT_DATA;
  app.visitor.video.readyState = app.visitor.video.HAVE_CURRENT_DATA;
  const update = app.send({ role: 'visitor', action: 'unavailable', reason: 'connection',
    playerId: app.savedVisitor().playerId, epoch: before.epoch, version: before.version });
  assert.equal(update.conflict, false);
  await app.advance(450);
  assert.equal(host.paused, true);
  assert.equal(host.currentTime, update.state.position);

  host.dispatchEvent(new Event('stalled'));
  await app.advance(450);
  assert.equal(reloads, 1);
  assert.equal(app.snapshot().ready.host, true);
  host.readyState = host.HAVE_CURRENT_DATA;
  host.dispatchEvent(new Event('stalled'));
  await app.advance(450);
  assert.equal(reloads, 1);
});


async function bufferDuringRescheduledPlayback({ beforeFirstStart = false } = {}) {
  const app = roomFixture();
  if (beforeFirstStart) {
    await app.advance(250);
    app.host.element('prepare').dispatchEvent(new Event('click'));
    app.visitor.element('prepare').dispatchEvent(new Event('click'));
    await app.advance(500);
    app.host.element('play').dispatchEvent(new Event('click'));
    await app.advance(250);
    assert.ok(app.snapshot().startsAt > app.now());
    assert.equal(app.host.video.paused && app.visitor.video.paused, true);
  } else {
    await app.start();
  }
  assert.equal(app.snapshot().version, 1);
  const { video: host } = app.host;
  const { video: visitor } = app.visitor;

  visitor.readyState = visitor.HAVE_CURRENT_DATA;
  visitor.dispatchEvent(new Event('waiting'));
  await app.advance(800);
  const held = app.snapshot();
  assert.equal(held.version, 2);
  assert.equal(held.waiting.visitor, 'buffering');
  assert.equal(held.ready.host, true);
  assert.equal(held.startsAt, null);

  visitor.readyState = 4;
  visitor.dispatchEvent(new Event('canplay'));
  await app.advance(250);
  const scheduled = app.snapshot();
  assert.equal(scheduled.version, 2);
  assert.equal(scheduled.wantsPlay, true);
  assert.deepEqual(scheduled.ready, { host: true, visitor: true });
  assert.ok(scheduled.startsAt > app.now() + 200);

  host.readyState = host.HAVE_CURRENT_DATA;
  host.dispatchEvent(new Event('waiting'));
  await app.advance(190);
  visitor.readyState = visitor.HAVE_CURRENT_DATA;
  await app.advance(350);
  const recovery = app.snapshot();
  assert.equal(recovery.version, 3);
  assert.equal(recovery.waiting.host, 'buffering');
  assert.equal(recovery.wantsPlay, true);
  assert.equal(recovery.startsAt, null);
  assert.deepEqual(recovery.ready, { host: false, visitor: false });
  for (const video of [host, visitor]) {
    assert.equal(video.paused, true);
    assert.equal(video.currentTime, recovery.position);
    assert.equal(video.readyState, video.HAVE_CURRENT_DATA);
    video.dispatchEvent(new Event('seeked'));
  }
  return { app, host, visitor, recovery };
}

test('host buffering during a visitor recovery can re-prime both stalled seats', async () => {
  const { app, host, visitor, recovery } = await bufferDuringRescheduledPlayback();
  const reloads = [0, 0];
  const media = [host, visitor];
  for (const [index, video] of media.entries()) {
    video.load = () => {
      reloads[index]++;
      video.readyState = video.HAVE_METADATA;
      video.currentTime = 0;
    };
    video.dispatchEvent(new Event('stalled'));
  }
  await app.advance(150);
  assert.deepEqual(reloads, [0, 0]);
  await app.advance(150);
  assert.deepEqual(reloads, [1, 1], 'Both aligned stalled seats must re-prime in v3');
  assert.deepEqual(app.snapshot().ready, { host: false, visitor: false });
  for (const video of media) {
    video.readyState = 4;
    video.dispatchEvent(new Event('canplay'));
  }
  await app.advance(350);
  const restarted = app.snapshot();
  assert.equal(restarted.version, recovery.version);
  assert.deepEqual(restarted.ready, { host: true, visitor: true });
  assert.ok(restarted.startsAt > app.now());
  await app.advance(1300);
  assert.ok(media.every(video => !video.paused && video.currentTime > recovery.position));
});


test('v3 buffering recovery reloads each stalled seat at most once', async () => {
  const { app, host, visitor, recovery } = await bufferDuringRescheduledPlayback();
  const reloads = [0, 0];
  for (const [index, video] of [host, visitor].entries()) {
    video.load = () => { reloads[index]++; };
  }
  for (let i = 0; i < 3; i++) {
    host.dispatchEvent(new Event('stalled'));
    visitor.dispatchEvent(new Event('stalled'));
    await app.advance(300);
  }
  assert.deepEqual(reloads, [1, 1]);
  assert.equal(app.snapshot().version, recovery.version);
  assert.deepEqual(app.snapshot().ready, { host: false, visitor: false });
  assert.equal(app.snapshot().startsAt, null);
});

test('explicit Pause invalidates pending v3 buffering recovery on both seats', async () => {
  const { app, host, visitor, recovery } = await bufferDuringRescheduledPlayback();
  let reloads = 0;
  for (const video of [host, visitor]) {
    video.load = () => { reloads++; };
    video.dispatchEvent(new Event('stalled'));
  }
  app.host.element('play').dispatchEvent(new Event('click'));
  await app.advance(5);
  visitor.dispatchEvent(new Event('seeked'));
  await app.advance(1200);
  const paused = app.snapshot();
  assert.equal(paused.version, recovery.version + 1);
  assert.equal(paused.wantsPlay, false);
  assert.equal(paused.startsAt, null);
  assert.equal(reloads, 0);
  assert.equal(host.paused && visitor.paused, true);
});

test('a different media source invalidates an armed v3 buffering recovery', async () => {
  const { app, visitor } = await bufferDuringRescheduledPlayback();
  let reloads = 0;
  visitor.load = () => { reloads++; };
  visitor.dispatchEvent(new Event('stalled'));
  app.visitor.player.load('/media/replacement.mp4');
  await app.advance(300);
  visitor.dispatchEvent(new Event('stalled'));
  await app.advance(300);
  assert.equal(reloads, 0);
});

test('an interrupted first scheduled play does not arm v3 buffering recovery', async () => {
  const { app, host, visitor } = await bufferDuringRescheduledPlayback({ beforeFirstStart: true });
  let reloads = 0;
  for (const video of [host, visitor]) {
    video.load = () => { reloads++; };
    video.dispatchEvent(new Event('stalled'));
  }
  await app.advance(450);
  assert.equal(reloads, 0);
  assert.equal(app.snapshot().startsAt, null);
});


test('a replacement visitor seat cannot use the stale v3 buffering recovery', async () => {
  const { app, visitor, recovery } = await bufferDuringRescheduledPlayback();
  let reloads = 0;
  visitor.load = () => { reloads++; };
  visitor.dispatchEvent(new Event('stalled'));
  const { recoveryId, recoveryGeneration } = app.savedVisitor();
  const replacement = app.send({ role: 'visitor', action: 'recover', playerId: randomUUID(),
    recoveryId, recoveryGeneration: recoveryGeneration + 1 });
  assert.equal(replacement.conflict, false);
  assert.equal(replacement.state.version, recovery.version + 1);
  visitor.dispatchEvent(new Event('seeked'));
  await app.advance(550);
  visitor.dispatchEvent(new Event('stalled'));
  await app.advance(350);
  assert.equal(reloads, 0);
  assert.equal(app.snapshot().ready.visitor, false);
});

test('a newer seek cannot reuse the pending v3 buffering recovery', async () => {
  const { app, host, visitor, recovery } = await bufferDuringRescheduledPlayback();
  let reloads = 0;
  for (const video of [host, visitor]) {
    video.load = () => { reloads++; };
    video.dispatchEvent(new Event('stalled'));
  }
  const seek = app.send({ action: 'seek', playerId: app.savedHost().playerId,
    epoch: recovery.epoch, version: recovery.version, position: 7 });
  assert.equal(seek.conflict, false);
  assert.equal(seek.state.version, recovery.version + 1);
  for (const video of [host, visitor]) video.dispatchEvent(new Event('seeked'));
  await app.advance(550);
  for (const video of [host, visitor]) video.dispatchEvent(new Event('stalled'));
  await app.advance(350);
  assert.equal(reloads, 0);
  assert.equal(app.snapshot().position, 7);
});


test('v3 buffering recovery waits for an in-flight Ready acknowledgment', async () => {
  const { app, host, visitor, recovery } = await bufferDuringRescheduledPlayback();
  let reloads = 0;
  host.load = () => { reloads++; };
  const release = app.holdNextReadyReply();
  try {
    for (const video of [host, visitor]) {
      video.readyState = 4;
      video.dispatchEvent(new Event('canplay'));
    }
    await app.advance(100);
    assert.equal(app.committedReady.version, recovery.version);
    assert.deepEqual(app.snapshot().ready, { host: true, visitor: true });
    assert.ok(app.snapshot().startsAt > app.now());
    host.readyState = host.HAVE_CURRENT_DATA;
    host.dispatchEvent(new Event('stalled'));
    await app.advance(300);
    assert.equal(reloads, 0, 'Do not reload a seat whose Ready is already applied');
  } finally {
    release();
  }
  await app.advance(150);
  assert.equal(reloads, 0);
  assert.equal(app.snapshot().ready.host, true);
});

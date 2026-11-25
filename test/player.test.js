import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setImmediate as turn } from 'node:timers/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createPlayback } from '../src/playback.js';

const playerSource = readFileSync(new URL('../public/player.js', import.meta.url), 'utf8')
  .replaceAll('export function ', 'function ')
  .replace('  return {\n    load(', '  return {\n    measure() { return { offset, target: positionAt(performance.now() + offset) }; },\n    load(');

function roomFixture({ publicMedia = false } = {}) {
  const room = createPlayback(120);
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
  let delay = { request: 0, reply: 0 };
  const recovery = [];
  const pauses = [];
  const visitorWire = [];

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
    const timer = { callback, due: now + delay, delay, repeat };
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
    const seeks = [];
    Object.assign(video, {
      duration: 120, HAVE_METADATA: 1, HAVE_CURRENT_DATA: 2, HAVE_FUTURE_DATA: 3,
      readyState: 4, seeking: false, paused: true, src: '',
      hasAttribute() { return Boolean(this.src); },
      getAttribute() { return this.src; },
      removeAttribute() { this.src = ''; },
      load() {},
      play() { this.paused = false; updatedAt = now; return Promise.resolve(); },
      pause() { position = this.currentTime; this.paused = true; }
    });
    Object.defineProperties(video, {
      currentTime: {
        get: () => position + (video.paused ? 0 : (now - updatedAt) * rate / 1000),
        set: seconds => { seeks.push(seconds); position = seconds; updatedAt = now; },
      },
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
    const context = {
      document: Object.assign(new EventTarget(), { getElementById: element, hidden: false }),
      window: new EventTarget(),
      crypto: { randomUUID },
      sessionStorage: { getItem: key => saved[role].get(key) ?? null,
        setItem: (key, value) => saved[role].set(key, value),
        removeItem: key => saved[role].delete(key) },
      performance: { now: () => now },
      AbortController, AbortSignal,
      setTimeout: schedule,
      setInterval: (fn, delay) => schedule(fn, delay, true),
      clearTimeout: timer => timers.delete(timer),
      clearInterval: timer => timers.delete(timer),
      async fetch(_url, options) {
        const command = JSON.parse(options.body);
        if (role === 'host' && hostOffline) throw new TypeError('offline');
        const sent = now;
        const wire = delay;
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
    });
    player.load(publicMedia ? 'https://media.fixture.test/synthetic.mp4' : '/media/synthetic.mp4', publicMedia);
    return { player, video, element, seeks };
  }

  let host = open('host');
  const visitor = open('visitor');
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
    advance, start, visitor, recovery, pauses, visitorWire, now: () => now,
    setDelay(request, reply) { delay = { request, reply }; },
    loseNextRecovery(kind) { recoveryLoss = kind; },
    loseNextPauseReply() { pausedReplyLoss = true; },
    savedHost() { return JSON.parse(saved.host.values().next().value ?? 'null'); },
    saveHost(value) { saved.host.set([...saved.host.keys()][0], JSON.stringify(value)); },
    send(command) { return room.update({ role: 'host', ...command }, now); },
    get host() { return host; },
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
    restoreHost() { hostOffline = false; },
    disconnectHost() { hostOffline = true; },
    snapshot() { return room.update({ role: 'host', action: 'observe', playerId: randomUUID() }, now).state; },
  };
}

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

for (const direction of [-1, 1]) {
  test('public media corrects opposing 0.31 second errors at 1x with the host ' +
      (direction > 0 ? 'ahead' : 'behind'), async t => {
    const app = roomFixture({ publicMedia: true });
    await app.start();
    const { host, visitor } = app;
    const gap = () => Math.abs(host.video.currentTime - visitor.video.currentTime);
    host.video.currentTime += direction * 0.31;
    visitor.video.currentTime -= direction * 0.31;
    assert.ok(Math.abs(gap() - 0.62) < 0.001);
    const initialSeeks = [host.seeks.length, visitor.seeks.length];

    await app.advance(1500);
    const samples = [];
    for (let i = 0; i < 100; i++) {
      samples.push(gap());
      for (const player of [host, visitor]) {
        assert.equal(player.video.playbackRate, 1);
        assert.equal(player.video.paused, false);
      }
      await app.advance(100);
    }
    const clear = samples.filter(value => value < 0.5).length;
    const result = clear + '/100 below 0.5 s, max ' + Math.max(...samples).toFixed(3) + ' s';
    t.diagnostic(result);
    assert.ok(clear >= 95, result);
    assert.deepEqual([host.seeks.length, visitor.seeks.length],
      initialSeeks.map(seeks => seeks + 1), 'Neither player repeats a settled correction');
  });
}

test('public media corrects sustained moderate drift in either direction at 1x', async () => {
  const app = roomFixture({ publicMedia: true });
  await app.start();
  const { video, seeks } = app.visitor;
  for (const offset of [0.70, -0.70]) {
    video.currentTime = app.host.video.currentTime + offset;
    const initialSeeks = seeks.length;
    await app.advance(1000);
    const difference = Math.abs(app.host.video.currentTime - video.currentTime);
    assert.ok(difference < 0.5, 'Sustained public drift must converge below 0.5 s, observed ' + difference);
    assert.equal(video.playbackRate, 1);
    assert.equal(seeks.length, initialSeeks + 1, 'Each sustained displacement needs one corrective seek');

    await app.advance(2300);
    assert.equal(seeks.length, initialSeeks + 1, 'A settled displacement must not cause repeat seeks');
    assert.equal(video.playbackRate, 1);
  }
});

test('public media leaves brief or reversing moderate drift at 1x without seeking', async () => {
  const app = roomFixture({ publicMedia: true });
  await app.start();
  const { video, seeks } = app.visitor;
  for (const offset of [0.70, -0.70, 0.70, -0.70]) {
    video.currentTime = app.host.video.currentTime + offset;
    const initialSeeks = seeks.length;
    await app.advance(200);
    assert.equal(seeks.length, initialSeeks, 'A short deviation should not trigger a correction');
    assert.equal(video.playbackRate, 1);
  }
  video.currentTime = app.host.video.currentTime;
  const finalSeeks = seeks.length;
  await app.advance(2000);
  assert.equal(seeks.length, finalSeeks);
});

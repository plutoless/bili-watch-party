import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const playbackRoute = '**/api/rooms/*/playback';
const stabilityMs = 10_000;
const sampleMs = 100;

async function pageClock(page) {
  let best = { rtt: Infinity };
  for (let i = 0; i < 8; i++) {
    const sent = performance.now();
    const pageTime = await page.evaluate(() => performance.now());
    const received = performance.now();
    if (received - sent < best.rtt) {
      best = { rtt: received - sent, offset: (sent + received) / 2 - pageTime };
    }
  }
  return best;
}

function sample(page, localStart) {
  return page.locator('video').evaluate((video, { localStart, sampleMs, stabilityMs }) =>
    new Promise(resolve => {
      const samples = [];
      const record = () => {
        const before = performance.now();
        const position = video.currentTime;
        const after = performance.now();
        const time = (before + after) / 2;
        samples.push({ time, position, paused: video.paused, seeking: video.seeking });
        if (time >= localStart + stabilityMs + sampleMs) resolve(samples);
        else setTimeout(record, Math.max(0, localStart - sampleMs + samples.length * sampleMs - performance.now()));
      };
      setTimeout(record, Math.max(0, localStart - sampleMs - performance.now()));
    }), { localStart, sampleMs, stabilityMs });
}

function positionAt(samples, time) {
  const index = samples.findIndex(sample => sample.time >= time);
  assert.ok(index > 0, 'Both engines must have samples bracketing each observation');
  const first = samples[index - 1];
  const second = samples[index];
  assert.ok(second.time - first.time <= 300, 'A large sampling gap would conceal playback drift');
  const ratio = (time - first.time) / (second.time - first.time);
  return first.position + ratio * (second.position - first.position);
}

async function checkStability(hostPage, visitorPage) {
  const clocks = await Promise.all([pageClock(hostPage), pageClock(visitorPage)]);
  const start = performance.now() + 1500;
  const samples = await Promise.all([hostPage, visitorPage].map(async (page, index) => {
    const { offset } = clocks[index];
    const samples = await sample(page, start - offset);
    if (samples.some(sample => sample.paused)) {
      assert.fail('Unexpected pause in the stable window: ' + JSON.stringify(await playbackDetails(page)));
    }
    assert.ok(samples.at(-1).position - samples[0].position >= 9, 'Both playheads must advance');
    return samples.map(sample => ({ ...sample, time: sample.time + offset }));
  }));
  const differences = Array.from({ length: stabilityMs / sampleMs }, (_, index) => {
    const time = start + index * sampleMs;
    return Math.abs(positionAt(samples[0], time) - positionAt(samples[1], time));
  });
  const below = differences.filter(delta => delta < 0.5).length;
  const seekingSamples = samples.map(side => side.filter(sample => sample.seeking).length);
  console.log('Stable playback: ' + below + '/' + differences.length + ' below 0.5 s; maximum ' +
    Math.max(...differences).toFixed(3) + ' s; calibration RTTs ' +
    clocks.map(({ rtt }) => rtt.toFixed(2) + ' ms').join(', ') +
    '; observed seeking samples ' + seekingSamples.join(', ') + '.');
  assert.ok(below / differences.length >= 0.95);
}

async function playhead(page) {
  return page.locator('video').evaluate(video => ({
    position: video.currentTime, paused: video.paused, seeking: video.seeking,
  }));
}

function playbackDetails(page) {
  return page.locator('video').evaluate(video => ({
    paused: video.paused, position: video.currentTime, seeking: video.seeking, readyState: video.readyState,
    mediaError: video.error?.code, online: navigator.onLine, status: document.querySelector('#playback-status').textContent,
    ready: [document.querySelector('#host-ready').textContent, document.querySelector('#visitor-ready').textContent],
  }));
}

async function waitForPlaying(page, after) {
  await page.waitForFunction(after => {
    const video = document.querySelector('video');
    return !video.paused && !video.seeking && video.currentTime > after &&
      video.videoWidth > 0 && !video.muted;
  }, after, { timeout: 10_000 }).catch(async () => {
    assert.fail('Expected playback past ' + after.toFixed(2) + ' s, observed ' + JSON.stringify(await playbackDetails(page)));
  });
}

async function checkFullscreen(page, visitorPage) {
  const host = Boolean(visitorPage);
  const portrait = page.viewportSize();
  const video = page.locator('video');
  const enter = page.getByRole('button', { name: '网页全屏', exact: true });
  const exit = page.getByRole('button', { name: '退出全屏', exact: true });
  const actions = page.locator('#playback-actions');
  const tapVideo = () => video.tap({ position: { x: 50, y: 30 } });
  await enter.tap({ timeout: 5000 });
  for (const viewport of [portrait, { width: portrait.height, height: portrait.width }]) {
    await page.setViewportSize(viewport);
    await tapVideo();
    await exit.waitFor();
    const frame = await page.locator('#player').boundingBox();
    assert.ok(Math.abs(frame.width - viewport.width) < 2 && Math.abs(frame.height - viewport.height) < 2);
    const play = page.locator('#play');
    const seek = page.locator('#seek');
    assert.equal(await play.isVisible(), host);
    assert.equal(await seek.isVisible(), host);
    assert.equal(await page.getByRole('progressbar', { name: '播放进度' }).isVisible(), !host);
    assert.match(await page.locator('#playback-time').textContent(), /\d+:\d\d\s*\/\s*\d+:\d\d/);
    assert.ok(Number(await page.locator('#buffered').getAttribute('value')) > 0);
    await page.locator('#playback-status').waitFor();
    await exit.tap({ trial: true });
  }
  await actions.waitFor({ state: 'hidden', timeout: 8000 }).catch(async () => {
    const focus = await page.evaluate(() => document.activeElement?.id);
    assert.fail('Fullscreen controls did not hide during playback: ' +
      JSON.stringify({ host, focus, player: await playbackDetails(page) }));
  });
  await tapVideo();
  await actions.waitFor({ timeout: 2500 });
  if (host) {
    await page.getByRole('button', { name: '暂停', exact: true }).tap();
    await Promise.all([page, visitorPage].map(side => side.getByText('已暂停，等待房主播放。').waitFor()));
    const pausedAt = (await playhead(page)).position;
    await page.getByRole('button', { name: '播放', exact: true }).tap();
    await Promise.all([waitForPlaying(page, pausedAt + 0.25), waitForPlaying(visitorPage, pausedAt + 0.25)]);
  } else await tryVisitorControls(page);
  await exit.tap();
  await enter.waitFor();
  await page.setViewportSize(portrait);
}

async function tryVisitorControls(page) {
  const video = page.locator('video');
  await video.scrollIntoViewIfNeeded();
  const started = performance.now();
  const before = (await playhead(page)).position;
  await video.tap({ position: { x: 60, y: 45 } });
  await video.dblclick({ position: { x: 60, y: 45 } });
  const box = await video.boundingBox();
  await page.mouse.move(box.x + 30, box.y + 55);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 30, box.y + 55, { steps: 5 });
  await page.mouse.up();
  await page.evaluate(() => document.activeElement.blur());
  for (const key of ['Space', 'ArrowRight', 'k']) await page.keyboard.press(key);
  const after = await playhead(page);
  const elapsed = (performance.now() - started) / 1000;
  assert.ok(!after.paused && after.position >= before - 0.5 && after.position <= before + elapsed + 0.75,
    'Visitor gestures and shortcuts must leave the media following the room: ' +
    JSON.stringify({ before, after, elapsed }));
  for (const selector of ['#play', '#seek', '#end-after-playback']) {
    assert.equal(await page.locator(selector).isVisible(), false);
  }
}

function hostCommands(page, callback) {
  function record(request) {
    if (!request.url().endsWith('/playback') || request.method() !== 'POST') return;
    const { action } = request.postDataJSON();
    if (['play', 'pause', 'seek'].includes(action)) callback(action);
  }
  page.on('request', record);
  return () => page.off('request', record);
}

async function checkPlaybackEnd(hostPage, visitorPage, getTimeline) {
  const play = hostPage.locator('#play');
  const replay = hostPage.getByRole('button', { name: '重播', exact: true });
  const duration = await hostPage.locator('video').evaluate(video => video.duration);
  const nearEnd = 1 - Math.max(2.4, duration * 0.006) / duration;
  const end = () => Promise.all([
    replay.waitFor({ timeout: 12_000 }),
    visitorPage.getByText('播放结束，等待房主决定。').waitFor({ timeout: 12_000 }),
  ]);
  await Promise.all([hostPage, visitorPage].map(page => page.getByRole('button', { name: '网页全屏' }).tap()));
  await dragSeek(hostPage, nearEnd);
  await play.tap();
  await end();
  for (const page of [hostPage, visitorPage]) {
    assert.equal(await page.locator('video').getAttribute('loop'), null);
  }
  const ended = await getTimeline();
  assert.equal(ended.ended, true);
  assert.equal(ended.wantsPlay, false);
  assert.equal(ended.startsAt, null);
  await delay(1100);
  assert.equal((await getTimeline()).version, ended.version);
  assert.ok((await playhead(hostPage)).paused && (await playhead(visitorPage)).paused);
  assert.equal(await visitorPage.getByRole('button', { name: '重播', exact: true }).count(), 0);
  assert.equal(await visitorPage.locator('#end-after-playback').isVisible(), false);
  await replay.tap();
  await Promise.all([waitForPlaying(hostPage, 0.25), waitForPlaying(visitorPage, 0.25)]);
  assert.equal((await getTimeline()).position, 0);
  await dragSeek(hostPage, nearEnd);
  await end();
  console.log('Playback ended without looping; the host replayed both from zero and can end the room in fullscreen.');
}

async function checkDriftCorrection(visitorPage, getTimeline) {
  const video = visitorPage.locator('video');
  async function waitFor(predicate, expected) {
    await visitorPage.waitForFunction(predicate, undefined, { timeout: 10_000 }).catch(async () => {
      const observed = await video.evaluate(video => ({
        rate: video.playbackRate, seeks: Number(video.dataset.seeks), paused: video.paused,
        seeking: video.seeking, readyState: video.readyState,
      }));
      assert.fail(expected + ', observed ' + JSON.stringify(observed));
    });
  }
  const clock = await pageClock(visitorPage);
  const sent = performance.now();
  const { startsAt, position, serverTime } = await getTimeline();
  const received = performance.now();
  assert.ok(startsAt !== null, 'An active timeline is required for the drift probe');
  const projected = position + (serverTime - startsAt) / 1000;
  const snapshotAt = (sent + received) / 2 - clock.offset;
  await video.evaluate((video, { projected, snapshotAt }) => {
    video.dataset.seeks = '0';
    video.addEventListener('seeking', () => { video.dataset.seeks = Number(video.dataset.seeks) + 1; });
    video.currentTime = projected + (performance.now() - snapshotAt) / 1000 + 0.70;
  }, { projected, snapshotAt });
  await waitFor(() => document.querySelector('video').playbackRate !== 1, 'Expected rate correction for moderate drift');
  await waitFor(() => document.querySelector('video').playbackRate === 1, 'Expected rate to return to normal');
  assert.equal(await video.getAttribute('data-seeks'), '1', 'Moderate drift must recover through rate changes');
  await video.evaluate(video => { video.currentTime += 2; });
  await waitFor(() => Number(document.querySelector('video').dataset.seeks) === 3, 'Expected one additional corrective seek');
  await visitorPage.waitForFunction(() => !document.querySelector('video').seeking);
  console.log('Drift: a 0.70 s offset recovered by playback rate; a 2.0 s offset triggered one corrective seek.');
}

async function dragSeek(page, fraction) {
  const seek = page.locator('#seek');
  await seek.scrollIntoViewIfNeeded();
  const box = await seek.boundingBox();
  assert.ok(box);
  const current = await seek.evaluate(input => Number(input.value) / Number(input.max));
  const x = progress => box.x + 9 + (box.width - 18) * progress;
  const y = box.y + box.height / 2;
  await page.mouse.move(x(current), y);
  await page.mouse.down();
  await page.mouse.move(x(fraction), y, { steps: 8 });
  await page.mouse.up();
}

function denyNextPlay(page) {
  return page.locator('video').evaluate(video => {
    const play = video.play;
    video.play = function () {
      video.play = play;
      return Promise.reject(new DOMException('Injected play rejection', 'NotAllowedError'));
    };
  });
}

function delayNextPlayFailure(page) {
  return page.locator('video').evaluate(video => {
    const play = video.play;
    video.play = function () {
      video.play = play;
      return new Promise((resolve, reject) => {
        video.addEventListener('test-reject-play', () => {
          reject(new DOMException('Injected obsolete play rejection', 'NotAllowedError'));
        }, { once: true });
        video.dataset.delayedPlay = 'true';
      });
    };
  });
}

async function simulateLateStart(page) {
  await page.locator('video').evaluate(video => {
    const originalFetch = window.fetch;
    const currentTime = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    const seeking = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'seeking');
    let startsLate = false;
    let seekEndsAt = 0;
    // A seek may take longer than the 250 ms it takes the timeline to move away again.
    Object.defineProperties(video, {
      currentTime: {
        configurable: true,
        get() { return currentTime.get.call(this); },
        set(value) {
          if (startsLate && this.paused) seekEndsAt = performance.now() + 475;
          currentTime.set.call(this, value);
        },
      },
      seeking: {
        configurable: true,
        get() { return seeking.get.call(this) || performance.now() < seekEndsAt; },
      },
    });
    window.fetch = async function(url, options) {
      const response = await originalFetch(url, options);
      if (String(url).endsWith('/playback')) {
        const read = response.json.bind(response);
        response.json = async () => {
          const state = await read();
          if (!startsLate && state.startsAt !== null) {
            startsLate = true;
            window.fetch = originalFetch;
            await new Promise(resolve => setTimeout(resolve, 1450));
          }
          return state;
        };
      }
      return response;
    };
  });
}

async function waitForSignal(promise, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(message)), 8000); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkSharedPlayback({ hostPage, visitorPage, host, visitor, stranger, origin, apiOrigin, hostPath }) {
  const endpoint = apiOrigin + '/api' + hostPath + '/playback';
  const post = (context, data) => context.request.post(endpoint, { data, headers: { Origin: origin } });
  const playerId = randomUUID();
  const play = hostPage.locator('#play');
  const hasFullscreen = await hostPage.locator('#fullscreen').count() > 0;
  const prepareHost = hostPage.getByRole('button', { name: '准备好了', exact: true });
  const prepareVisitor = visitorPage.getByRole('button', { name: '准备好了', exact: true });
  assert.equal(await visitorPage.locator('#play').isVisible(), false);
  assert.equal(await visitorPage.locator('#seek').isVisible(), false);
  assert.equal(await visitorPage.locator('video').getAttribute('controls'), null);

  await denyNextPlay(visitorPage);
  const seekAcknowledgment = Promise.withResolvers();
  const releaseAcknowledgment = Promise.withResolvers();
  let holdSeek = false;
  await visitorPage.route(playbackRoute, async route => {
    const body = route.request().postDataJSON();
    if (holdSeek && body.action === 'ready' && body.position > 35) {
      seekAcknowledgment.resolve(body.position);
      await releaseAcknowledgment.promise;
    }
    await delay(80);
    await route.continue();
  });

  await prepareHost.tap();
  await hostPage.getByText('房主 · 已就绪').waitFor();
  await prepareVisitor.tap();
  await visitorPage.getByText(/浏览器阻止了起播/).waitFor();
  await visitorPage.getByText('访客 · 未就绪').waitFor();
  assert.ok(await play.isDisabled());
  assert.ok((await playhead(hostPage)).paused && (await playhead(visitorPage)).paused);
  await visitorPage.getByRole('button', { name: '再次点按以准备' }).tap();
  await hostPage.getByText('访客 · 已就绪').waitFor();
  await visitorPage.getByText('房主 · 已就绪').waitFor();

  const getTimeline = async () => {
    const response = await post(host, { role: 'host', action: 'observe', playerId });
    assert.ok(response.ok());
    return response.json();
  };
  const { epoch, version } = await getTimeline();
  const command = { playerId, epoch, version, action: 'seek', position: 9 };
  assert.equal((await post(stranger, { ...command, role: 'visitor' })).status(), 401);
  assert.equal((await post(visitor, { ...command, role: 'host' })).status(), 401);
  assert.equal((await post(visitor, { ...command, role: 'visitor' })).status(), 403);

  const commands = [];
  const stopRecording = [hostPage, visitorPage].map(page => hostCommands(page, action => commands.push(action)));
  let started = performance.now();
  await play.tap();
  await Promise.all([waitForPlaying(hostPage, 0.25), waitForPlaying(visitorPage, 0.25)]);
  console.log('Initial start: both past 0.25 s after ' + Math.round(performance.now() - started) + ' ms.');
  await checkStability(hostPage, visitorPage);
  await checkDriftCorrection(visitorPage, getTimeline);
  if (hasFullscreen) {
    await Promise.all([waitForPlaying(hostPage, 0.25), waitForPlaying(visitorPage, 0.25)]);
    await checkFullscreen(hostPage, visitorPage);
    const before = await getTimeline();
    await tryVisitorControls(visitorPage);
    await checkFullscreen(visitorPage);
    assert.equal((await getTimeline()).version, before.version);
    console.log('Both roles entered and exited page fullscreen in portrait and landscape. One tap restored controls.');
  }
  const expected = hasFullscreen ? ['play', 'pause', 'play'] : ['play'];
  assert.deepEqual(commands, expected, 'Gestures and drift corrections must not generate host commands');

  holdSeek = true;
  started = performance.now();
  const hostPortrait = hostPage.viewportSize();
  try {
    if (hasFullscreen) {
      await Promise.all([hostPage, visitorPage].map(page => page.getByRole('button', { name: '网页全屏' }).tap()));
      await hostPage.setViewportSize({ width: hostPortrait.height, height: hostPortrait.width });
    }
    await dragSeek(hostPage, 0.72);
    const target = await waitForSignal(seekAcknowledgment.promise, 'Visitor seek was not acknowledged');
    assert.ok(target > 35);
    await Promise.all([hostPage, visitorPage].map(page =>
      page.getByText('正在对齐进度，等待双方就绪。').waitFor()));
    await hostPage.getByText('访客 · 未就绪').waitFor();
    await hostPage.waitForFunction(target => {
      const video = document.querySelector('video');
      return video.paused && !video.seeking && Math.abs(video.currentTime - target) < 0.12;
    }, target);
    await delay(1100);
    for (const page of [hostPage, visitorPage]) {
      const player = await playhead(page);
      assert.ok(player.paused && !player.seeking && Math.abs(player.position - target) < 0.12);
    }
    holdSeek = false;
    releaseAcknowledgment.resolve();
    await Promise.all([waitForPlaying(hostPage, target + 0.25), waitForPlaying(visitorPage, target + 0.25)]);
    console.log('Seek: both aligned and held for 1100 ms with visitor acknowledgment withheld; ' +
      'both passed seek target + 0.25 s after ' + Math.round(performance.now() - started) + ' ms.');
  } finally {
    releaseAcknowledgment.resolve();
  }

  await play.tap();
  await Promise.all([hostPage, visitorPage].map(page => page.getByText('已暂停，等待房主播放。').waitFor()));
  if (hasFullscreen) {
    await Promise.all([hostPage, visitorPage].map(page => page.getByRole('button', { name: '退出全屏' }).tap()));
    await hostPage.setViewportSize(hostPortrait);
  }
  const positions = await Promise.all([playhead(hostPage), playhead(visitorPage)]);
  assert.ok(positions.every(player => player.paused && !player.seeking));
  assert.ok(Math.abs(positions[0].position - positions[1].position) < 0.12);
  stopRecording.forEach(stop => stop());
  assert.deepEqual(commands, [...expected, 'seek', 'pause'], 'Only the intentional host controls may send timeline commands');
  console.log('Pause: both players paused and aligned within 0.12 s.');

  await dragSeek(hostPage, 0.32);
  await Promise.all([hostPage, visitorPage].map(page => page.waitForFunction(() => {
    const video = document.querySelector('video');
    const ratio = video.currentTime / video.duration;
    return video.paused && !video.seeking && ratio > 0.25 && ratio < 0.4;
  })));
  await hostPage.getByText('已暂停，等待房主播放。').waitFor();
  await delay(1100);
  assert.ok((await playhead(hostPage)).paused && (await playhead(visitorPage)).paused);

  const restartPosition = (await playhead(hostPage)).position;
  await denyNextPlay(visitorPage);
  await play.tap();
  await visitorPage.getByText(/浏览器阻止了起播/).waitFor();
  await hostPage.getByText('等待点按以允许播放。').waitFor();
  assert.ok((await playhead(hostPage)).paused && (await playhead(visitorPage)).paused);
  await visitorPage.getByRole('button', { name: '再次点按以准备' }).tap();
  await Promise.all([waitForPlaying(hostPage, restartPosition + 0.25), waitForPlaying(visitorPage, restartPosition + 0.25)]);
  console.log('Paused seek stayed paused; scheduled gesture rejection held the room until the next tap.');

  const waitForPause = () => Promise.all([hostPage, visitorPage].map(page =>
    page.getByText('已暂停，等待房主播放。').waitFor()));
  await play.tap();
  await waitForPause();
  await delayNextPlayFailure(visitorPage);
  await play.tap();
  await visitorPage.locator('video[data-delayed-play]').waitFor();
  await play.tap();
  await waitForPause();
  await visitorPage.locator('video').dispatchEvent('test-reject-play');
  await delay(600);
  assert.equal(await visitorPage.getByRole('button', { name: '再次点按以准备' }).isVisible(), false);
  await waitForPause();

  await denyNextPlay(hostPage);
  await play.tap();
  await hostPage.getByText(/浏览器阻止了起播/).waitFor();
  assert.ok(await play.isEnabled(), 'Host must be able to cancel a blocked start');
  await play.tap();
  await hostPage.getByRole('button', { name: '再次点按以准备' }).tap();
  await waitForPause();
  await delay(1100);
  assert.ok((await playhead(hostPage)).paused && (await playhead(visitorPage)).paused);
  console.log('Obsolete rejection was ignored; host could cancel a blocked start and re-prepare without resuming.');

  if (process.env.SYNTHETIC_VIDEO === '1') {
    const position = (await playhead(hostPage)).position;
    await simulateLateStart(visitorPage);
    await play.tap();
    try {
      await Promise.all([waitForPlaying(hostPage, position + 0.25), waitForPlaying(visitorPage, position + 0.25)]);
    } finally {
      await visitorPage.locator('video').evaluate(video => {
        delete video.currentTime;
        delete video.seeking;
      });
    }
    await play.tap();
    await waitForPause();
    console.log('Delayed start notification and slow seeks did not prevent either player from starting.');
  }

  await checkRecovery({ hostPage, visitorPage, host, visitor, endpoint, getTimeline, waitForPause });
  if (hasFullscreen) await checkPlaybackEnd(hostPage, visitorPage, getTimeline);
}

async function checkRecovery({ hostPage, visitorPage, host, visitor, endpoint, getTimeline, waitForPause }) {
  const play = hostPage.locator('#play');
  let started;

  async function assertAligned() {
    const [host, visitor] = await Promise.all([playhead(hostPage), playhead(visitorPage)]);
    const difference = Math.abs(host.position - visitor.position);
    assert.ok(difference < 0.5, 'Recovery must leave the two players within 0.5 s');
    return difference.toFixed(3);
  }

  async function waitForRecovery(label, started, position, { acceptGesture = false } = {}) {
    const playing = Promise.all([waitForPlaying(hostPage, position + 0.25), waitForPlaying(visitorPage, position + 0.25)]);
    let usedGesture = false;
    if (acceptGesture) {
      const retry = visitorPage.getByRole('button', { name: '再次点按以准备' });
      usedGesture = await Promise.race([playing.then(() => false), retry.waitFor().then(() => true)]);
      if (usedGesture) await retry.tap();
    }
    await playing.catch(async error => {
      const players = await Promise.all([playbackDetails(hostPage), playbackDetails(visitorPage)]);
      assert.fail(label + ' failed for host/visitor ' + JSON.stringify(players) + '. ' + error.message);
    });
    console.log(label + ': ' + Math.round(performance.now() - started) + ' ms to both advancing 0.25 s; ' +
      'paired position difference ' + await assertAligned() + ' s' + (usedGesture ? '; browser required a new tap.' : '.'));
  }

  async function stallVisitor(whileStalled) {
    const mediaRoute = '**/media/*.mp4';
    const requested = Promise.withResolvers();
    const release = Promise.withResolvers();
    const gate = async route => {
      requested.resolve();
      await release.promise;
      await route.continue();
    };
    await visitorPage.route(mediaRoute, gate);
    try {
      // Discard cached ranges and withhold actual MP4 responses from this player.
      const interrupted = performance.now();
      await visitorPage.locator('video').evaluate(video => video.load());
      await Promise.all([
        waitForSignal(requested.promise, 'Visitor did not request media after its buffer was cleared'),
        hostPage.getByText('缓冲中，等待双方在同一位置就绪。').waitFor(),
      ]);
      assert.ok((await playhead(hostPage)).paused);
      assert.ok((await playhead(visitorPage)).paused);
      assert.ok(await visitorPage.locator('video').evaluate(video => video.readyState < video.HAVE_FUTURE_DATA));
      const frozen = await getTimeline();
      assert.equal(frozen.startsAt, null);
      assert.equal(frozen.ready.visitor, false);
      console.log('Actual media response withheld: both waiting after ' + Math.round(performance.now() - interrupted) + ' ms.');
      await whileStalled(frozen);
    } finally {
      release.resolve();
      await visitorPage.unroute(mediaRoute, gate);
    }
  }

  await play.tap();
  const beforeBuffer = (await playhead(hostPage)).position;
  await Promise.all([waitForPlaying(hostPage, beforeBuffer + 0.25), waitForPlaying(visitorPage, beforeBuffer + 0.25)]);
  let frozen;
  await stallVisitor(async state => {
    frozen = state;
    await delay(1100);
    assert.equal((await getTimeline()).startsAt, null);
  });
  await waitForRecovery('Buffer release', performance.now(), frozen.position);

  await stallVisitor(async state => {
    frozen = state;
    await play.tap();
    await hostPage.locator('#play').filter({ hasText: '播放' }).waitFor();
    assert.equal((await getTimeline()).wantsPlay, false);
  });
  started = performance.now();
  await waitForPause();
  assert.ok((await playhead(hostPage)).paused && (await playhead(visitorPage)).paused);
  assert.ok(Math.abs((await playhead(visitorPage)).position - frozen.position) < 0.12);
  console.log('Buffer release after host pause: ' + Math.round(performance.now() - started) + ' ms to aligned pause.');

  const firstReady = Promise.withResolvers();
  const releaseFirst = Promise.withResolvers();
  let held = false;
  const holdFirstReady = async route => {
    const operation = route.request().postDataJSON();
    if (operation.action !== 'ready' || held) return route.fallback();
    held = true;
    firstReady.resolve(operation.position);
    await releaseFirst.promise;
    await route.fallback();
  };
  const inRange = (page, low, high) => page.waitForFunction(({ low, high }) => {
    const video = document.querySelector('video');
    const fraction = video.currentTime / video.duration;
    return video.paused && !video.seeking && fraction > low && fraction < high;
  }, { low, high });
  await visitorPage.route(playbackRoute, holdFirstReady);
  try {
    await dragSeek(hostPage, 0.25);
    const firstPosition = await waitForSignal(firstReady.promise, 'Visitor did not acknowledge the first seek');
    await dragSeek(hostPage, 0.55);
    started = performance.now();
    await inRange(hostPage, 0.48, 0.62);
    const staleReply = visitorPage.waitForResponse(response =>
      response.url() === endpoint && response.request().postDataJSON().action === 'ready' &&
      response.request().postDataJSON().position === firstPosition);
    releaseFirst.resolve();
    assert.equal((await staleReply).status(), 409);
    await inRange(visitorPage, 0.48, 0.62);
    await waitForPause();
    console.log('Repeated seeks with late readiness: newest target settled paused after ' +
      Math.round(performance.now() - started) + ' ms; difference ' + await assertAligned() + ' s.');
  } finally {
    releaseFirst.resolve();
    await visitorPage.unroute(playbackRoute, holdFirstReady);
  }

  const beforeOffline = (await playhead(hostPage)).position;
  await play.tap();
  await Promise.all([waitForPlaying(hostPage, beforeOffline + 0.25), waitForPlaying(visitorPage, beforeOffline + 0.25)]);
  const offline = route => route.abort('internetdisconnected');
  await visitorPage.route(playbackRoute, offline);
  started = performance.now();
  await visitor.setOffline(true);
  try {
    await visitorPage.getByText('连接中断，等待播放状态。').waitFor();
    const disconnectedPosition = (await playhead(visitorPage)).position;
    await hostPage.getByText('等待重新连接并对齐进度。').waitFor();
    frozen = await getTimeline();
    assert.equal(frozen.startsAt, null);
    assert.equal(frozen.wantsPlay, true);
    assert.ok(frozen.position <= disconnectedPosition + 0.12, 'The frozen room must not skip unplayed media');
    assert.ok((await playhead(hostPage)).paused && (await playhead(visitorPage)).paused);
    console.log('Visitor offline: both waiting after ' + Math.round(performance.now() - started) + ' ms.');
  } finally {
    await visitorPage.unroute(playbackRoute, offline);
    started = performance.now();
    await visitor.setOffline(false);
  }
  await waitForRecovery('Network restored', started, frozen.position);

  const alternate = await visitor.newPage();
  await alternate.bringToFront();
  const nativeVisibility = await visitorPage.evaluate(() => document.hidden);
  const setHidden = (hidden) => visitorPage.evaluate(hidden => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  if (!nativeVisibility) await setHidden(true);
  try {
    await hostPage.getByText('等待双方回到观影页面。').waitFor();
    frozen = await getTimeline();
    assert.equal(frozen.startsAt, null);
    assert.ok((await playhead(hostPage)).paused && (await playhead(visitorPage)).paused);
  } finally {
    started = performance.now();
    await visitorPage.bringToFront();
    if (!nativeVisibility) await setHidden(false);
    await alternate.close();
  }
  await waitForRecovery('Foreground return (' + (nativeVisibility ? 'native tab visibility' : 'injected visibility event') + ')',
    started, frozen.position);

  const refreshPosition = (await playhead(hostPage)).position;
  started = performance.now();
  await visitorPage.reload({ waitUntil: 'domcontentloaded' });
  await visitorPage.getByText('视频已就绪').waitFor();
  assert.equal(await visitorPage.getByText('等待房主批准').isVisible(), false);
  await waitForRecovery('Approved visitor refresh', started, refreshPosition, { acceptGesture: true });
  await checkStability(hostPage, visitorPage);

  await hostPage.route(playbackRoute, offline);
  await host.setOffline(true);
  try {
    await hostPage.getByText('连接中断，等待播放状态。').waitFor();
    await play.tap();
    await hostPage.getByText('已请求暂停，重新连接后将同步。').waitFor();
    await visitorPage.getByText('等待重新连接并对齐进度。').waitFor();
    assert.ok((await playhead(hostPage)).paused && (await playhead(visitorPage)).paused);
    // Restore page navigation first while the playback endpoint remains unreachable.
    await host.setOffline(false);
    await hostPage.reload({ waitUntil: 'domcontentloaded' });
    await hostPage.getByText('连接中断，等待播放状态。').waitFor();
  } finally {
    await hostPage.unroute(playbackRoute, offline);
    started = performance.now();
    await host.setOffline(false);
  }
  await hostPage.locator('#play').filter({ hasText: '播放' }).waitFor();
  await hostPage.waitForFunction(() => document.querySelector('#playback-status').textContent === '已暂停，等待房主播放。');
  await waitForPause();
  assert.equal((await getTimeline()).wantsPlay, false);
  const pausePosition = (await playhead(hostPage)).position;
  const alignedAfter = Math.round(performance.now() - started);
  await delay(1100);
  assert.ok((await playhead(hostPage)).paused && (await playhead(visitorPage)).paused);
  assert.ok(Math.abs((await playhead(hostPage)).position - pausePosition) < 0.12);
  console.log('Host pause requested offline and preserved after refresh: ' + alignedAfter +
    ' ms to aligned pause after reconnect; difference ' + await assertAligned() + ' s.');
}

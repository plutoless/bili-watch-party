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
    assert.ok(samples.every(sample => !sample.paused), 'Both players must stay unpaused in the stable window');
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

async function waitForPlaying(page, after) {
  await page.waitForFunction(after => {
    const video = document.querySelector('video');
    return !video.paused && !video.seeking && video.currentTime > after &&
      video.videoWidth > 0 && !video.muted;
  }, after);
}

async function checkDriftCorrection(visitorPage) {
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
  await video.evaluate(video => {
    video.dataset.seeks = '0';
    video.addEventListener('seeking', () => { video.dataset.seeks = Number(video.dataset.seeks) + 1; });
    video.currentTime += 0.30;
  });
  await waitFor(() => document.querySelector('video').playbackRate < 1, 'Expected a reduced rate for small drift');
  await waitFor(() => document.querySelector('video').playbackRate === 1, 'Expected rate to return to normal');
  assert.equal(await video.getAttribute('data-seeks'), '1', 'Small drift must recover through rate changes');
  await video.evaluate(video => { video.currentTime += 1.4; });
  await waitFor(() => Number(document.querySelector('video').dataset.seeks) === 3, 'Expected one additional corrective seek');
  await visitorPage.waitForFunction(() => !document.querySelector('video').seeking);
  console.log('Drift: a 0.30 s offset recovered by playback rate; a 1.4 s offset triggered one corrective seek.');
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

export async function checkSharedPlayback({ hostPage, visitorPage, host, visitor, stranger, origin, hostPath }) {
  const endpoint = origin + '/api' + hostPath + '/playback';
  const post = (context, data) => context.request.post(endpoint, { data, headers: { Origin: origin } });
  const playerId = randomUUID();
  const play = hostPage.locator('#play');
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
    if (holdSeek && body.action === 'ready') {
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

  const beforePlay = await post(host, { role: 'host', action: 'observe', playerId });
  const { epoch, version } = await beforePlay.json();
  const command = { playerId, epoch, version, action: 'seek', position: 9 };
  assert.equal((await post(stranger, { ...command, role: 'visitor' })).status(), 401);
  assert.equal((await post(visitor, { ...command, role: 'host' })).status(), 401);
  assert.equal((await post(visitor, { ...command, role: 'visitor' })).status(), 403);

  let started = performance.now();
  await play.tap();
  await Promise.all([waitForPlaying(hostPage, 0.25), waitForPlaying(visitorPage, 0.25)]);
  console.log('Initial start: both past 0.25 s after ' + Math.round(performance.now() - started) + ' ms.');
  await checkStability(hostPage, visitorPage);
  await checkDriftCorrection(visitorPage);

  holdSeek = true;
  started = performance.now();
  let timeout;
  try {
    await dragSeek(hostPage, 0.72);
    const target = await Promise.race([
      seekAcknowledgment.promise,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Visitor seek was not acknowledged')), 8000); }),
    ]);
    assert.ok(target > 30);
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
    clearTimeout(timeout);
    releaseAcknowledgment.resolve();
  }

  await play.tap();
  await Promise.all([hostPage, visitorPage].map(page => page.getByText('已暂停，等待房主播放。').waitFor()));
  const positions = await Promise.all([playhead(hostPage), playhead(visitorPage)]);
  assert.ok(positions.every(player => player.paused && !player.seeking));
  assert.ok(Math.abs(positions[0].position - positions[1].position) < 0.12);
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
}

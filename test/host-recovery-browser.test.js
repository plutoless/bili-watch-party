import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { appendFileSync, copyFileSync, readFileSync } from 'node:fs';
import { createServer as httpServer, request } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { connect } from 'node:net';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import test from 'node:test';
import { devices, webkit } from 'playwright';
import { startServer } from '../src/server.js';

const fixture = process.env.ITEM5_FIXTURE;
const evidence = process.env.ITEM5_EVIDENCE;
const cert = process.env.ITEM5_LEAF_CERT;
const key = process.env.ITEM5_LEAF_KEY;
const selected = process.env.ITEM5_CASES?.split(',') ?? ['reconnect'];
const browserOptions = { ...devices['iPhone 13'], serviceWorkers: 'block' };
const next = (probe, ms, message) => {
  const deadline = performance.now() + ms;
  return (async () => {
    do {
      const result = await probe();
      if (result) return result;
      await wait(40);
    } while (performance.now() < deadline);
    throw new Error(message);
  })();
};

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

function closeServer(server) {
  server.closeAllConnections();
  return new Promise(resolve => server.close(resolve));
}

async function service(dataDir, trace, retain) {
  const tls = { cert: readFileSync(cert), key: readFileSync(key) };
  const password = randomBytes(24).toString('hex');
  let upstream, authority, held, offline = false;
  const pend = new Set();
  const guestSockets = new Set();

  let mediaRequestNo = 0;
  function forward(req, res, mediaRequest) {
    const proxy = request(upstream + req.url, { method: req.method, headers: req.headers }, reply => {
      if (mediaRequest) trace('media-response', { ...mediaRequest, status: reply.statusCode,
        contentRange: reply.headers['content-range'] ?? null, contentLength: reply.headers['content-length'] ?? null });
      res.writeHead(reply.statusCode, reply.headers);
      reply.pipe(res);
    });
    proxy.on('error', () => { if (res.headersSent) res.destroy(); else res.writeHead(502).end(); });
    res.once('close', () => proxy.destroy());
    req.pipe(proxy);
  }

  function serve(role, req, res) {
    if (req.method !== 'GET' || !/^\/media\/[a-f0-9-]+\.mp4$/.test(new URL(req.url, origin).pathname)) return forward(req, res);
    const mediaRequest = { role, requestNo: ++mediaRequestNo, range: req.headers.range ?? null,
      held: role === 'guest' && Boolean(held) };
    trace('media-get', mediaRequest);
    res.once('finish', () => trace('media-finish', { ...mediaRequest, status: res.statusCode }));
    res.once('close', () => trace('media-close', { ...mediaRequest, completed: res.writableFinished }));
    const send = () => { if (!res.destroyed) forward(req, res, mediaRequest); };
    if (mediaRequest.held) pend.add(send);
    else send();
  }

  const hostServer = httpsServer(tls, (req, res) => serve('host', req, res));
  retain(() => closeServer(hostServer));
  const origin = 'https://127.0.0.1:' + await listen(hostServer);
  authority = new URL(origin).host;
  const guestServer = httpsServer(tls, (req, res) => serve('guest', req, res));
  retain(() => closeServer(guestServer));
  const guestPort = await listen(guestServer);
  const tunnel = httpServer((_, response) => response.writeHead(403).end());
  tunnel.on('connect', (req, socket, head) => {
    if (offline || req.url !== authority) return socket.destroy();
    const other = connect(guestPort, '127.0.0.1');
    guestSockets.add(socket);
    socket.on('close', () => { guestSockets.delete(socket); other.destroy(); });
    socket.on('error', () => other.destroy());
    other.on('close', () => socket.destroy());
    other.on('error', () => socket.destroy());
    other.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) other.write(head);
      socket.pipe(other).pipe(socket);
    });
  });
  retain(() => {
    for (const socket of guestSockets) socket.destroy();
    return closeServer(tunnel);
  });
  const proxy = { server: 'http://127.0.0.1:' + await listen(tunnel) };
  const app = await startServer({
    password, port: 0, publicOrigin: origin, dataDir,
    async importVideo({ output, update }) {
      update({ title: 'Synthetic host recovery regression' });
      copyFileSync(fixture, output);
      return 60;
    },
  });
  retain(() => app.close());
  upstream = app.localOrigin;
  return {
    origin, password, proxy,
    hold() { held = true; },
    pending() { return pend.size; },
    release() {
      held = false;
      const released = performance.now();
      for (const send of pend) send();
      pend.clear();
      return released;
    },
    network(value) {
      offline = value;
      if (!value) return performance.now();
      for (const socket of guestSockets) socket.destroy();
    },
  };
}

function track(page, role, trace, observe) {
  const actions = [];
  const byRequest = new WeakMap();
  page.on('request', request => {
    if (request.method() !== 'POST' || !new URL(request.url()).pathname.endsWith('/playback')) return;
    const { action, epoch, version, reason, position } = request.postDataJSON();
    const item = { role, action, epoch, version, reason, position, sentAt: performance.now() };
    actions.push(item);
    byRequest.set(request, item);
    if (action !== 'observe') trace('control-send', item);
  });
  page.on('response', async response => {
    const sent = byRequest.get(response.request());
    if (!sent) return;
    try {
      const { epoch, version, ready, waiting, wantsPlay, startsAt, position, serverTime, ownsSeat } = await response.json();
      if (!Number.isInteger(version)) return;
      const state = { epoch, version, ready, waiting, wantsPlay, startsAt, position, serverTime, ownsSeat };
      observe?.(state);
      if (sent.action !== 'observe') trace('control-reply', { ...sent, status: response.status(), state });
    } catch {}
  });
  return actions;
}

async function installMediaProbe(page) {
  await page.evaluate(() => {
    const video = document.querySelector('video');
    window.item5Events = [];
    for (const type of ['pause', 'playing', 'stalled', 'waiting', 'emptied', 'loadstart', 'canplay', 'seeking', 'seeked', 'error']) {
      video.addEventListener(type, () => window.item5Events.push({ type, clock: performance.now(), position: video.currentTime,
        state: video.readyState, paused: video.paused, seeking: video.seeking }));
    }
  });
  let best = { latency: Infinity };
  for (let i = 0; i < 9; i++) {
    const before = performance.now();
    const clock = await page.evaluate(() => performance.now());
    const after = performance.now();
    if (after - before < best.latency) best = { latency: after - before, offset: (before + after) / 2 - clock };
  }
  return best;
}

function media(page) {
  return page.evaluate(() => {
    const video = document.querySelector('video');
    return { clock: performance.now(), position: video.currentTime, paused: video.paused, seeking: video.seeking,
      ready: video.readyState, online: navigator.onLine,
      buffered: Array.from({ length: video.buffered.length }, (_, i) => [video.buffered.start(i), video.buffered.end(i)]),
      events: window.item5Events.splice(0) };
  });
}

function stableWindow(sides, events, start) {
  const samples = Array.from({ length: 100 }, (_, i) => {
    const t = start + i * 100;
    const positions = sides.map(side => {
      const j = side.findIndex(sample => sample.at >= t);
      assert.ok(j > 0 && side[j].at - side[j - 1].at <= 300, 'Unpaired stable sample');
      const [a, b] = [side[j - 1], side[j]];
      return { position: a.position + (b.position - a.position) * ((t - a.at) / (b.at - a.at)), paused: a.paused || b.paused };
    });
    return { t, drift: Math.abs(positions[0].position - positions[1].position), paused: positions.some(side => side.paused) };
  });
  const pauseEvents = events.flat().filter(event => event.type === 'pause' && event.at >= start && event.at <= start + 9900).length;
  return { samples, below: samples.filter(sample => sample.drift < 0.5).length,
    maximum: Math.max(...samples.map(sample => sample.drift)), paused: samples.filter(sample => sample.paused).length, pauseEvents };
}

async function scenario(kind, root, t) {
  const resources = [];
  const failures = [];
  const retain = close => resources.push(close);
  let stop, monitor, state;
  t.after(async () => {
    stop = true;
    await monitor;
    for (const close of resources.reverse()) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Recovery fixture failed during sampling or teardown');
  });
  const trace = (event, payload) => appendFileSync(join(evidence, kind + '.jsonl'),
    JSON.stringify({ event, at: performance.now(), utc: new Date().toISOString(), ...payload }) + '\n', { mode: 0o600 });
  const endpoint = await service(root, trace, retain);
  const hostBrowser = await webkit.launch();
  retain(() => hostBrowser.close());
  const guestBrowser = await webkit.launch({ proxy: endpoint.proxy });
  retain(() => guestBrowser.close());
  const host = await hostBrowser.newContext(browserOptions);
  const guest = await guestBrowser.newContext(browserOptions);
  const hp = await host.newPage();
  const gp = await guest.newPage();
  const pages = [hp, gp];
  const samples = [[], []];
  const events = [[], []];
  const paired = [];
  assert.equal(hostBrowser.version(), '27.2');
  assert.equal(guestBrowser.version(), hostBrowser.version());
  for (const context of [host, guest]) assert.deepEqual(await context.storageState(), { cookies: [], origins: [] });
  const api = endpoint.origin + '/api';
  const headers = { Origin: endpoint.origin };
  const post = (path, data) => host.request.post(api + path, { data, headers });
  assert.equal((await post('/session', { password: endpoint.password })).status(), 204);
  const created = await post('/rooms', { url: 'https://www.bilibili.com/video/BV1aa1111111' });
  assert.equal(created.status(), 201);
  const { id } = await created.json();
  const room = '/rooms/' + id;
  const result = await post(room + '/invitation', { action: 'generate' });
  assert.equal(result.status(), 200);
  const { invitation } = await result.json();
  const options = { waitUntil: 'domcontentloaded', timeout: 15000 };
  await hp.goto(endpoint.origin + room, options);
  const pending = gp.waitForResponse(response => new URL(response.url()).pathname.endsWith('/join') && response.request().method() === 'POST', options);
  await gp.goto(endpoint.origin + '/invite/' + id + '#' + invitation.token, options);
  assert.ok((await Promise.all(pages.map(page => page.evaluate(() => isSecureContext)))).every(Boolean));
  const request = await (await pending).json();
  assert.equal(request.state, 'pending');
  assert.equal((await post(room + '/approve', { requestId: request.requestId })).status(), 200);
  const hostActions = track(hp, 'host', trace, nextState => {
    if (state && (nextState.serverTime < state.serverTime || nextState.version < state.version)) return;
    if (!state || nextState.version !== state.version || nextState.startsAt !== state.startsAt ||
        nextState.ready.host !== state.ready.host || nextState.ready.visitor !== state.ready.visitor) trace('host-observed', nextState);
    state = nextState;
  });
  let guestState;
  track(gp, 'guest', trace, nextState => {
    if (!guestState || nextState.epoch !== guestState.epoch || nextState.version !== guestState.version ||
        nextState.startsAt !== guestState.startsAt || nextState.ready.host !== guestState.ready.host ||
        nextState.ready.visitor !== guestState.ready.visitor) trace('guest-observed', nextState);
    guestState = nextState;
  });
  await Promise.all(pages.map(page => page.locator('#status[data-status="ready"]').waitFor({ timeout: 15000 })));
  const calibration = await Promise.all(pages.map(installMediaProbe));
  monitor = (async () => {
    while (!stop) {
      const pair = (await Promise.all(pages.map(media))).map(({ events: batch, ...snapshot }, i) => {
        const offset = calibration[i].offset;
        for (const event of batch) {
          const row = { ...event, at: event.clock + offset };
          events[i].push(row);
          trace('media-event', { role: i === 0 ? 'host' : 'guest', sample: row });
        }
        const row = { ...snapshot, at: snapshot.clock + offset };
        samples[i].push(row);
        return row;
      });
      const observation = { pair, sampledAt: Math.max(...pair.map(row => row.at)) };
      paired.push({ pair, at: observation.sampledAt });
      if (kind === 'buffer' || kind === 'reconnect') trace('media-pair', observation);
      await wait(45);
    }
  })().catch(error => { failures.push(error); });

  for (const page of pages) await page.locator('#prepare').tap({ timeout: 12000 });
  await next(() => state?.ready.visitor, 10_000, 'Guest did not prepare');
  if (!state.ready.host) {
    // Only preflight can nudge a freshly primed WebKit host whose initial rewind stalls.
    trace('preflight-host-load');
    await hp.locator('video').evaluate(video => video.load());
  }
  await next(() => state?.ready.host && state?.ready.visitor, 10_000, 'Both seats did not prepare');
  await hp.getByRole('button', { name: '播放', exact: true }).tap({ timeout: 10000 });
  await next(() => paired.at(-1)?.pair.every(row => !row.paused && row.position > 3), 12_000, 'Both players did not advance beyond three seconds');

  const previous = state.version;
  const expected = kind === 'buffer' ? 'buffering' : 'connection';
  if (kind === 'buffer') {
    endpoint.hold();
    await gp.locator('video').evaluate(video => video.load());
  } else {
    endpoint.network(true);
    await guest.setOffline(true);
    assert.equal(await gp.evaluate(() => navigator.onLine), false);
  }
  const frozen = await next(() => state?.version > previous && state.startsAt === null && state.wantsPlay &&
    state.waiting.visitor === expected && paired.at(-1)?.pair.every(row => row.paused) &&
    (kind !== 'buffer' || endpoint.pending() > 0) && state, 10_000, 'Interruption did not freeze both players');
  trace('frozen', frozen);
  if (kind === 'pause') await hp.getByRole('button', { name: '暂停', exact: true }).tap({ timeout: 5000 });
  await wait(1100);
  let release;
  if (kind === 'buffer') release = endpoint.release();
  else { await guest.setOffline(false); release = endpoint.network(false); }
  trace('release', { release });

  if (kind === 'pause') {
    await next(() => state?.wantsPlay === false && state.version > frozen.version, 4000, 'Requested Pause did not become authoritative');
    await wait(4000);
    assert.equal(state.startsAt, null);
    assert.equal(state.wantsPlay, false);
    assert.ok(paired.filter(row => row.at >= release + 1000).every(row => row.pair.every(side => side.paused)));
    trace('result', { case: kind, paused: true, version: state.version });
    return;
  }

  const limit = release + 10_000;
  const advanced = () => paired.find(row => row.at <= limit && row.pair.every(side =>
    side.at >= release && !side.paused && !side.seeking && side.position > frozen.position + 0.25));
  await next(() => advanced() || performance.now() >= limit, 10_400, 'Missing recovery deadline');
  await wait(60);
  const first = advanced();
  const metrics = {
    case: kind, oldVersion: previous, frozenVersion: frozen.version, version: state.version, guestReady: state.ready.visitor,
    hostReady: state.ready.host, hostReadyAttempts: hostActions.filter(op => op.sentAt >= release && op.version === state.version && op.action === 'ready').length,
    releaseToPlayMs: first ? first.at - release : null, lastMedia: paired.filter(row => row.at <= limit).at(-1)?.pair, room: state,
  };
  if (first) {
    const start = first.at + 1500;
    await wait(Math.max(0, start + 10100 - performance.now()));
    metrics.stable = stableWindow(samples, events, start);
  }
  trace('result', metrics);
  if (kind === 'reconnect') assert.ok(metrics.version > metrics.frozenVersion && metrics.guestReady, 'The host never observed the post-reconnect room version and guest Ready');
  assert.ok(first, 'Both players must automatically advance within 10 seconds: ' + JSON.stringify(metrics));
  assert.ok(metrics.hostReady, 'Host must be Ready on the current recovery version');
  if (kind === 'reconnect') assert.ok(metrics.hostReadyAttempts, 'Host must send Ready on the post-reconnect version');
  assert.ok(metrics.stable.below >= 95 && metrics.stable.paused === 0 && metrics.stable.pauseEvents === 0,
    'Stable playback must meet the fixed drift and pause gate');
}

for (const kind of selected) test('host recovery after guest ' + kind, { timeout: 90000 }, async t => {
  assert.ok(fixture && evidence && cert && key, 'The local synthetic fixture, evidence directory and guest-trusted leaf are required');
  await scenario(kind, join(evidence, kind + '-room'), t);
});

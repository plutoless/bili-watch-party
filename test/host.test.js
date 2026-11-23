import assert from 'node:assert/strict';
import { access, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { createImporter } from '../src/importer.js';
import { startServer } from '../src/server.js';

const source = 'https://www.bilibili.com/video/BV1TDyazeEuY';
const fixturePassword = 'synthetic-test-password';

async function setup(t, importVideo, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'watch-party-test-'));
  let app;
  t.after(async () => {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  async function start() {
    app = await startServer({ dataDir, password: fixturePassword, port: 0, importVideo, ...options });
  }
  await start();
  function request(path, { cookie, method = 'GET', body, headers } = {}) {
    return fetch(app.origin + path, {
      method,
      headers: {
        ...(cookie && { Cookie: cookie }),
        ...(method === 'POST' && { Origin: app.origin, 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }
  async function login() {
    const response = await request('/api/session', {
      method: 'POST', body: { password: fixturePassword },
    });
    assert.equal(response.status, 204);
    return response.headers.get('set-cookie').split(';')[0];
  }
  async function submit(cookie, url = source) {
    const response = await request('/api/rooms', { cookie, method: 'POST', body: { url } });
    return [response.status, await response.json()];
  }
  async function status(cookie, id, expected) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await request('/api/rooms/' + id, { cookie });
      assert.equal(response.status, 200);
      const room = await response.json();
      if (room.status === expected) return room;
      await setTimeout(20);
    }
    assert.fail('Room did not reach ' + expected);
  }
  return {
    request, login, submit, status,
    dataDir,
    async restart() {
      await app.close();
      app = null;
      await start();
    },
  };
}

test('anonymous requests cannot create, inspect, retry, or read media from a room', async t => {
  const app = await setup(t, async () => assert.fail('Anonymous submission started an import'));
  assert.equal((await app.submit())[0], 401);
  const cookie = await app.login();
  const id = '00000000-0000-4000-8000-000000000000';
  const url = '/api/rooms/' + id;
  assert.equal((await app.request(url)).status, 401);
  assert.equal((await app.request(url + '/retry', { method: 'POST' })).status, 401);
  assert.equal((await app.request('/media/' + id + '.mp4', {
    method: 'HEAD', headers: { Range: 'bytes=0-0' },
  })).status, 401);
  assert.equal((await app.request('/api/rooms', {
    cookie, method: 'POST', body: { url: source }, headers: { Origin: 'https://example.org' },
  })).status, 403);
});

test('supported links normalize to one room per part; unsupported links fail before import', async t => {
  const jobs = [];
  const app = await setup(t, async ({ source, output }) => {
    jobs.push(source);
    await writeFile(output, 'synthetic bytes for the HTTP range protocol test');
    return 5;
  });
  const cookie = await app.login();
  for (const invalid of [
    'https://www.bilibili.com.example.org/video/BV1TDyazeEuY',
    'https://user@www.bilibili.com/video/BV1TDyazeEuY',
    'https://www.bilibili.com/video/BV1TDyazeEuY?p=0',
    'https://www.bilibili.com/video/BV1TDyazeEuY?p=1&p=2',
    'https://www.bilibili.com/bangumi/play/ep1',
  ]) {
    const [status, body] = await app.submit(cookie, invalid);
    assert.equal(status, 400);
    assert.equal(body.error.code, 'invalid');
  }
  const submissions = await Promise.all([
    app.submit(cookie),
    app.submit(cookie, 'http://m.bilibili.com/video/BV1TDyazeEuY/?p=01&share_source=copy_web'),
    app.submit(cookie, source + '?p=1#t=12'),
  ]);
  assert.deepEqual(submissions.map(([status]) => status).sort(), [200, 200, 201]);
  const id = submissions[0][1].id;
  for (const [, room] of submissions) assert.equal(room.id, id);
  assert.equal((await app.status(cookie, id, 'ready')).part, 1);
  assert.deepEqual(jobs, [{ bvid: 'BV1TDyazeEuY', part: 1 }]);

  const [status, otherPart] = await app.submit(cookie, source + '?p=2');
  assert.equal(status, 201);
  assert.notEqual(otherPart.id, id);
  assert.equal((await app.status(cookie, otherPart.id, 'ready')).part, 2);
});

test('a transient first failure can be retried once in the same room and publishes media only when ready', async t => {
  let attempts = 0;
  const downloading = Promise.withResolvers();
  const preparing = Promise.withResolvers();
  const offline = createImporter({ fetch: async () => { throw new TypeError('Synthetic connection reset'); } });
  const fixture = 'ABCDEF0123456789';
  const app = await setup(t, async job => {
    if (++attempts === 1) return offline(job);
    job.update({ title: '验收影片', partTitle: '第一部分' });
    await Promise.race([downloading.promise, setTimeout(2000, undefined, { signal: job.signal })]);
    job.update({ status: 'preparing' });
    await Promise.race([preparing.promise, setTimeout(2000, undefined, { signal: job.signal })]);
    await writeFile(job.output, fixture);
    return 10;
  });
  const cookie = await app.login();
  const [, submitted] = await app.submit(cookie);
  assert.equal(submitted.status, 'queued');
  const failed = await app.status(cookie, submitted.id, 'failed');
  assert.equal(failed.error.code, 'network');
  assert.equal(failed.error.retryable, true);
  assert.match(failed.error.message, /重试/);
  assert.equal(failed.mediaUrl, null);
  const [, duplicate] = await app.submit(cookie);
  assert.equal(duplicate.id, submitted.id);
  assert.equal(duplicate.status, 'failed');
  const roomUrl = '/api/rooms/' + submitted.id;
  const mediaUrl = '/media/' + submitted.id + '.mp4';
  const retries = await Promise.all(Array.from({ length: 3 }, () =>
    app.request(roomUrl + '/retry', { cookie, method: 'POST', body: { attempt: failed.attempt } })));
  for (const response of retries) assert.equal((await response.json()).id, submitted.id);
  const pending = await app.status(cookie, submitted.id, 'downloading');
  assert.equal(pending.title, '验收影片');
  assert.equal(pending.partTitle, '第一部分');
  assert.equal((await app.request(mediaUrl, { cookie })).status, 404);
  downloading.resolve();
  await app.status(cookie, submitted.id, 'preparing');
  preparing.resolve();
  const ready = await app.status(cookie, submitted.id, 'ready');
  assert.equal(ready.mediaUrl, mediaUrl);
  assert.equal(ready.error, null);
  assert.equal(attempts, 2);

  for (const [range, start, end] of [
    ['bytes=0-1', 0, 1], ['bytes=13-', 13, 15], ['bytes=-4', 12, 15], ['bytes=15-50', 15, 15],
  ]) {
    const response = await app.request(mediaUrl, { cookie, headers: { Range: range } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes ' + start + '-' + end + '/16');
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(await response.text(), fixture.slice(start, end + 1));
  }
  const head = await app.request(mediaUrl, { cookie, method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '16');
  const unsatisfiable = await app.request(mediaUrl, { cookie, headers: { Range: 'bytes=16-' } });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers.get('content-range'), 'bytes */16');
  assert.equal((await app.request(mediaUrl)).status, 401);
  const forgedCookie = cookie.slice(0, -1) + (cookie.endsWith('a') ? 'b' : 'a');
  assert.equal((await app.request(mediaUrl, { cookie: forgedCookie })).status, 401);
});

test('replaying an old retry after a fast failure does not start another attempt', async t => {
  let attempts = 0;
  const importer = createImporter({ fetch: async () => {
    attempts++;
    return new Response(null, { status: 503 });
  } });
  const app = await setup(t, importer);
  const cookie = await app.login();
  const [, room] = await app.submit(cookie);
  const failed = await app.status(cookie, room.id, 'failed');
  const path = '/api/rooms/' + room.id + '/retry';
  const repeat = { cookie, method: 'POST', body: { attempt: failed.attempt } };
  assert.equal((await app.request(path, repeat)).status, 200);
  const nextFailure = await app.status(cookie, room.id, 'failed');
  assert.equal(nextFailure.attempt, failed.attempt + 1);
  const replay = await app.request(path, repeat);
  assert.equal((await replay.json()).status, 'failed');
  assert.equal(attempts, 2);
});

test('public access, missing part, and unsupported format have distinct actionable statuses', async t => {
  const options = [
    ['access', 1, () => ({ code: -403 })],
    ['part', 2, () => ({ code: 0, data: { title: '验收影片', pages: [{ page: 1, cid: 123 }] } })],
    ['format', 1, url => ({ code: 0, data: url.pathname.endsWith('/view')
      ? { title: '验收影片', pages: [{ page: 1, cid: 123, duration: 818 }] }
      : { dash: { video: [{ id: 32, codecs: 'hvc1.1.6.L120.90' }] } },
    })],
    ['access', 1, url => ({ code: 0, data: url.pathname.endsWith('/view')
      ? { title: '验收影片', pages: [{ page: 1, cid: 123, duration: 818 }] }
      : { is_preview: 1, timelength: 60_000 },
    })],
  ];
  for (const [index, [code, part, respond]] of options.entries()) {
    await t.test(code + ' ' + (index + 1), async t => {
      const app = await setup(t, createImporter({ fetch: async url => Response.json(respond(url)) }));
      const cookie = await app.login();
      const [, room] = await app.submit(cookie, source + '?p=' + part);
      const failed = await app.status(cookie, room.id, 'failed');
      assert.equal(failed.error.code, code);
      assert.ok(failed.error.message);
      assert.equal(failed.mediaUrl, null);
    });
  }
});

test('media download tries backup URLs and distinguishes a refusal from a transient error', async t => {
  for (const [backupStatus, expected] of [[404, 'access'], [503, 'network']]) {
    await t.test(expected, async t => {
      const attempted = [];
      const importer = createImporter({ fetch: async url => {
        if (url.pathname.endsWith('/view')) {
          return Response.json({ code: 0, data: {
            title: '验收影片', pages: [{ page: 1, cid: 123, duration: 818 }],
          } });
        }
        if (url.pathname.endsWith('/playurl')) {
          return Response.json({ code: 0, data: { dash: {
            video: [{
              id: 32, codecs: 'avc1.64001f',
              baseUrl: 'https://cdn.bilivideo.com/primary',
              backupUrl: ['https://cdn.bilivideo.com/backup'],
            }],
            audio: [{ codecs: 'mp4a.40.2' }],
          } } });
        }
        attempted.push(url.pathname);
        return new Response(null, { status: url.pathname === '/primary' ? 403 : backupStatus });
      } });
      const app = await setup(t, importer);
      const cookie = await app.login();
      const [, room] = await app.submit(cookie);
      const failed = await app.status(cookie, room.id, 'failed');
      assert.deepEqual(attempted, ['/primary', '/backup']);
      assert.equal(failed.error.code, expected);
      assert.equal(failed.mediaUrl, null);
    });
  }
});

test('only the explicitly approved visitor can watch, including during competing approvals', async t => {
  const download = Promise.withResolvers();
  const app = await setup(t, async ({ output, signal }) => {
    await Promise.race([download.promise, setTimeout(2000, undefined, { signal })]);
    await writeFile(output, 'abcd');
    return 5;
  });
  const host = await app.login();
  const [, room] = await app.submit(host);
  const path = '/api/rooms/' + room.id;
  const media = '/media/' + room.id + '.mp4';
  const post = (action, body = {}, cookie = host) =>
    app.request(path + '/' + action, { method: 'POST', body, cookie });
  const invitation = await post('invitation', { action: 'generate' });
  assert.equal(invitation.status, 200);
  const { token } = (await invitation.json()).invitation;
  const visitors = await Promise.all([1, 2].map(async () => {
    const response = await post('join', { token }, '');
    assert.equal(response.status, 200);
    const { state, requestId } = await response.json();
    assert.equal(state, 'pending');
    return { requestId, cookie: response.headers.get('set-cookie').split(';')[0] };
  }));
  assert.notEqual(visitors[0].requestId, visitors[1].requestId);
  for (const visitor of visitors) {
    assert.equal((await post('approve', { requestId: visitor.requestId }, visitor.cookie)).status, 401);
    assert.equal((await app.request(path, { cookie: visitor.cookie })).status, 401);
  }
  const approvals = await Promise.all(visitors.map(({ requestId }) => post('approve', { requestId })));
  assert.deepEqual(approvals.map(response => response.status).sort(), [200, 409]);
  const approved = approvals.findIndex(response => response.status === 200);
  const winner = visitors[approved].cookie;
  const other = visitors[1 - approved].cookie;
  const status = cookie => app.request(path + '/join', { cookie }).then(response => response.json());
  assert.equal((await status(winner)).room.mediaUrl, null);
  assert.equal((await status(other)).state, 'full');
  const lateArrival = await post('join', { token }, '');
  assert.deepEqual(await lateArrival.json(), { state: 'full' });
  assert.equal(lateArrival.headers.get('set-cookie'), null);
  download.resolve();
  await app.status(host, room.id, 'ready');
  for (const cookie of [undefined, other]) {
    for (const method of ['GET', 'HEAD']) {
      assert.equal((await app.request(media, { cookie, method })).status, 401);
      assert.equal((await app.request(media, { cookie, method, headers: { Range: 'bytes=1-2' } })).status, 401);
    }
  }
  const response = await app.request(media, { cookie: winner, headers: { Range: 'bytes=1-2' } });
  assert.equal(response.status, 206);
  assert.equal(await response.text(), 'bc');
  const [, otherRoom] = await app.submit(host, source + '?p=2');
  assert.equal((await app.request('/media/' + otherRoom.id + '.mp4', { cookie: winner })).status, 401);
});

test('invitation rotation, revocation and expiry invalidate pending requests', async t => {
  let now = 1_000_000;
  const app = await setup(t, async ({ output }) => {
    await writeFile(output, 'synthetic data');
    return 5;
  }, { now: () => now });
  const host = await app.login();
  const [, room] = await app.submit(host);
  const path = '/api/rooms/' + room.id;
  const post = (action, body, cookie) =>
    app.request(path + '/' + action, { method: 'POST', body, cookie });
  const generate = async () => (await (await post('invitation', { action: 'generate' }, host)).json()).invitation;
  const join = async token => {
    const response = await post('join', { token });
    return { ...(await response.json()), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const verifyRevoked = async (token, { requestId, cookie }) => {
    assert.equal((await join(token)).state, 'expired');
    const status = await app.request(path + '/join', { cookie });
    assert.deepEqual(await status.json(), { state: 'expired' });
    assert.match(status.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await post('approve', { requestId }, host)).status, 409);
  };

  const first = await generate();
  const firstRequest = await join(first.token);
  assert.equal(firstRequest.state, 'pending');
  const replacement = await generate();
  assert.ok(replacement.token !== first.token);
  await verifyRevoked(first.token, firstRequest);
  const replacementRequest = await join(replacement.token);
  assert.equal(replacementRequest.state, 'pending');
  assert.equal((await post('invitation', { action: 'revoke' }, host)).status, 200);
  await verifyRevoked(replacement.token, replacementRequest);

  const expiring = await generate();
  const expiringRequest = await join(expiring.token);
  assert.equal(expiringRequest.state, 'pending');
  now = expiring.expiresAt;
  await verifyRevoked(expiring.token, expiringRequest);
});

test('approved session persists across restart, then room end revokes access and cleanup removes media', async t => {
  let now = 1_000_000;
  const retentionMs = 1000;
  const app = await setup(t, async ({ output }) => {
    await writeFile(output, 'synthetic data');
    return 5;
  }, { now: () => now, retentionMs });
  let host = await app.login();
  const [, room] = await app.submit(host);
  const path = '/api/rooms/' + room.id;
  const { mediaUrl } = await app.status(host, room.id, 'ready');
  const post = (action, body, cookie = host) =>
    app.request(path + '/' + action, { method: 'POST', body, cookie });
  const invitationResponse = await post('invitation', { action: 'generate' });
  const { invitation } = await invitationResponse.json();
  const apply = await post('join', { token: invitation.token }, '');
  const visitor = apply.headers.get('set-cookie').split(';')[0];
  const { requestId } = await apply.json();
  assert.equal((await post('approve', { requestId })).status, 200);

  now = invitation.expiresAt;
  await app.restart();
  host = await app.login();
  const range = { Range: 'bytes=0-1' };
  assert.equal((await app.request(mediaUrl, { cookie: visitor, headers: range })).status, 206);
  assert.equal((await post('end', {})).status, 200);
  assert.deepEqual(await (await post('join', { token: invitation.token }, '')).json(), { state: 'ended' });
  assert.deepEqual(await (await app.request(path + '/join', { cookie: visitor })).json(), { state: 'ended' });
  assert.equal((await app.request(mediaUrl, { cookie: host, headers: range })).status, 410);
  assert.equal((await app.request(mediaUrl, { cookie: visitor, headers: range })).status, 401);
  const mediaFile = join(app.dataDir, mediaUrl);
  await access(mediaFile);
  const [created, replacement] = await app.submit(host);
  assert.equal(created, 201);
  assert.notEqual(replacement.id, room.id);

  now += retentionMs;
  await app.restart();
  host = await app.login();
  assert.equal((await app.request(path, { cookie: host })).status, 404);
  await assert.rejects(access(mediaFile), { code: 'ENOENT' });
});

test('ending a room during download cancels the import and frees the queue', async t => {
  const cancelled = Promise.withResolvers();
  let attempts = 0;
  const app = await setup(t, async ({ output, signal }) => {
    if (++attempts === 1) {
      try {
        await setTimeout(2000, undefined, { signal });
      } catch (error) {
        cancelled.resolve();
        throw error;
      }
    }
    await writeFile(output, 'synthetic data');
    return 5;
  });
  const host = await app.login();
  const [, room] = await app.submit(host);
  await app.status(host, room.id, 'downloading');
  const path = '/api/rooms/' + room.id;
  assert.equal((await app.request(path + '/end', { method: 'POST', body: {}, cookie: host })).status, 200);
  const [created, replacement] = await app.submit(host);
  assert.equal(created, 201);
  await app.status(host, replacement.id, 'ready');
  await cancelled.promise;
  await assert.rejects(access(join(app.dataDir, 'media', room.id + '.mp4')), { code: 'ENOENT' });
});

test('ending a room interrupts a media transfer already in progress', { timeout: 5000 }, async t => {
  const app = await setup(t, async ({ output }) => {
    await writeFile(output, 'synthetic data');
    await truncate(output, 32 * 1024 * 1024);
    return 5;
  });
  const host = await app.login();
  const [, room] = await app.submit(host);
  const ready = await app.status(host, room.id, 'ready');
  const response = await app.request(ready.mediaUrl, { cookie: host, headers: { Range: 'bytes=0-' } });
  assert.equal(response.status, 206);
  const media = response.body.getReader();
  assert.ok((await media.read()).value.length > 0);

  const end = await app.request('/api/rooms/' + room.id + '/end', { method: 'POST', body: {}, cookie: host });
  assert.equal(end.status, 200);
  await assert.rejects(async () => {
    while (!(await media.read()).done) {
      // Drain only after end, so the server cannot finish streaming before revocation.
    }
  }, TypeError);
});


test('only the host directs playback and both players must acknowledge the current target', async t => {
  let now = 1_000_000;
  const app = await setup(t, async ({ output }) => {
    await writeFile(output, 'synthetic media');
    return 120;
  }, { now: () => now });
  const host = await app.login();
  const [, room] = await app.submit(host);
  await app.status(host, room.id, 'ready');
  const path = '/api/rooms/' + room.id + '/';
  const post = (route, body, cookie = host) =>
    app.request(path + route, { method: 'POST', body, cookie });
  const { invitation } = await post('invitation', { action: 'generate' }).then(r => r.json());
  const joined = await post('join', { token: invitation.token }, '');
  const { requestId } = await joined.json();
  const visitor = joined.headers.get('set-cookie').split(';')[0];

  const playerIds = {
    host: '00000000-0000-4000-8000-000000000001',
    visitor: '00000000-0000-4000-8000-000000000002',
  };
  const send = (role, action, fields, cookie = role === 'host' ? host : visitor) =>
    post('playback', { role, playerId: playerIds[role], action, ...fields }, cookie);

  assert.equal((await send('visitor', 'observe')).status, 401);
  assert.equal((await post('approve', { requestId })).status, 200);
  const initial = await send('host', 'observe').then(r => r.json());
  const version = { epoch: initial.epoch, version: initial.version };
  assert.deepEqual(initial.ready, { host: false, visitor: false });
  assert.equal((await send('host', 'play', version)).status, 409);
  assert.equal((await send('host', 'seek', { ...version, position: 12 }, visitor)).status, 401);
  assert.equal((await send('visitor', 'seek', { ...version, position: 12 })).status, 403);

  assert.equal((await send('host', 'ready', { ...version, position: 0, claim: true })).status, 200);
  assert.equal((await send('visitor', 'ready', { ...version, position: 0, claim: true })).status, 200);
  const start = await send('host', 'play', version).then(r => r.json());
  assert.ok(start.startsAt > now);
  const following = await send('visitor', 'observe').then(r => r.json());
  assert.equal(following.startsAt, start.startsAt);
  assert.equal(following.version, start.version);

  now = start.startsAt + 500;
  const seeking = await send('host', 'seek', { ...version, version: start.version, position: 25 }).then(r => r.json());
  assert.equal(seeking.position, 25);
  assert.equal(seeking.startsAt, null);
  assert.deepEqual(seeking.ready, { host: false, visitor: false });
  const seekVersion = { ...version, version: seeking.version };
  assert.equal((await send('visitor', 'ready', { ...version, position: 0 })).status, 409);
  assert.equal((await send('visitor', 'ready', { ...seekVersion, position: 24 })).status, 409);
  const waiting = await send('host', 'ready', { ...seekVersion, position: 25 }).then(r => r.json());
  assert.equal(waiting.startsAt, null);
  const resumed = await send('visitor', 'ready', { ...seekVersion, position: 25 }).then(r => r.json());
  assert.ok(resumed.startsAt > now);

  now = resumed.startsAt + 750;
  const paused = await send('host', 'pause', { ...seekVersion, version: resumed.version }).then(r => r.json());
  assert.equal(paused.position, 25.75);
  assert.equal(paused.startsAt, null);
  assert.equal((await send('host', 'seek', { ...seekVersion, position: 95 })).status, 409);
  const stillPaused = await send('visitor', 'observe').then(r => r.json());
  assert.equal(stillPaused.position, 25.75);
  assert.equal(stillPaused.version, paused.version);

  const pausedVersion = { ...version, version: paused.version };
  await send('host', 'ready', { ...pausedVersion, position: 25.75 });
  await send('visitor', 'ready', { ...pausedVersion, position: 25.75 });
  const retryStart = await send('host', 'play', pausedVersion).then(r => r.json());
  const blocked = await send('visitor', 'blocked', { ...version, version: retryStart.version }).then(r => r.json());
  assert.equal(blocked.startsAt, null);
  assert.deepEqual(blocked.blocked, ['visitor']);
  assert.deepEqual(blocked.ready, { host: false, visitor: false });
  assert.equal((await send('visitor', 'ready', { ...version, version: retryStart.version, position: 25.75 })).status, 409);
  const blockedVersion = { ...version, version: blocked.version };
  await send('host', 'ready', { ...blockedVersion, position: 25.75 });
  const rearmed = await send('visitor', 'ready', { ...blockedVersion, position: 25.75 }).then(r => r.json());
  assert.ok(rearmed.startsAt > now);
  assert.deepEqual(rearmed.blocked, []);

  now += 4_000;
  const expired = await send('host', 'observe').then(r => r.json());
  assert.equal(expired.startsAt, null);
  assert.equal(expired.wantsPlay, false);
  assert.equal(expired.ownsSeat, false);
  assert.deepEqual(expired.ready, { host: false, visitor: false });
});

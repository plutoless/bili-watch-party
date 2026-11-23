import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import { createImporter } from '../src/importer.js';
import { startServer } from '../src/server.js';

const source = 'https://www.bilibili.com/video/BV1TDyazeEuY';
const fixturePassword = 'synthetic-test-password';

async function setup(t, importVideo) {
  const dataDir = await mkdtemp(join(tmpdir(), 'watch-party-test-'));
  let app;
  t.after(async () => {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  app = await startServer({ dataDir, password: fixturePassword, port: 0, importVideo });
  const { origin } = app;
  function request(path, { cookie, method = 'GET', body, headers } = {}) {
    return fetch(origin + path, {
      method,
      headers: {
        ...(cookie && { Cookie: cookie }),
        ...(method === 'POST' && { Origin: origin, 'Content-Type': 'application/json' }),
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
  return { request, login, submit, status };
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

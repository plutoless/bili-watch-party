import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chromium, devices, webkit } from 'playwright';
import { createImporter } from '../src/importer.js';
import { startServer } from '../src/server.js';
import { checkSharedPlayback } from './playback-browser.js';
import { startSplitFixture } from './split-browser-fixture.js';

const run = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH ?? 'ffprobe';
const source = 'https://www.bilibili.com/video/BV1TDyazeEuY';
const deployedOrigin = process.env.BROWSER_ORIGIN;
const deployedApiOrigin = process.env.BROWSER_API_ORIGIN;
const password = deployedOrigin ? process.env.HOST_PASSWORD : 'synthetic-browser-test-password';
const dataDir = deployedOrigin ? null : await mkdtemp(join(tmpdir(), 'watch-party-live-'));
const mediaDir = dataDir ?? process.env.BROWSER_DATA_DIR;
const simulateFirstFailure = process.env.SIMULATE_FIRST_FAILURE === '1';
const synthetic = process.env.SYNTHETIC_VIDEO === '1';
const splitFixture = process.env.BROWSER_SYNTHETIC_SPLIT === '1';
const ignoreHTTPSErrors = splitFixture || process.env.BROWSER_LOCAL_TLS === '1';
let app;
let fixture;
let failNextRequest = simulateFirstFailure;

async function checkMediaFile(media) {
  const output = join(mediaDir, 'media', media.split('/').at(-1));
  const { stdout } = await run(ffprobe, [
    '-v', 'error', '-show_entries', 'stream=codec_name,codec_type,height:format=duration',
    '-of', 'json', output,
  ]);
  const file = JSON.parse(stdout);
  const video = file.streams.find(stream => stream.codec_type === 'video');
  assert.equal(video?.codec_name, 'h264');
  assert.equal(file.streams.find(stream => stream.codec_type === 'audio')?.codec_name, 'aac');
  assert.ok(Number(file.format.duration) > (synthetic ? 59 : 810));
  await run(ffmpeg, ['-v', 'error', '-xerror', '-i', output, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'],
    { timeout: 180_000 });
  console.log((synthetic ? 'Synthetic' : 'Public') + ' sample: H.264 ' + video.height + 'p + AAC, ' + Number(file.format.duration).toFixed(2) +
    ' s, complete audio/video decode passed.');
}

async function checkSessions(browser, profile, origin, apiOrigin, checkFile) {
  const options = { ...devices[profile], ignoreHTTPSErrors };
  const host = await browser.newContext(options);
  const visitor = await browser.newContext(options);
  const stranger = await browser.newContext(options);
  const hostPage = await host.newPage();
  const visitorPage = await visitor.newPage();
  const strangerPage = await stranger.newPage();
  const inviteLink = hostPage.getByLabel('邀请链接');
  const generate = hostPage.locator('#generate-invite');
  const watchStatus = (page, state) => page.locator('#status[data-status="' + state + '"]');
  const range = { Range: 'bytes=0-1023' };

  const home = await hostPage.goto(origin);
  assert.equal((await home.allHeaders())['permissions-policy'], 'microphone=()');
  assert.equal((await stranger.request.get(apiOrigin + '/api/rooms')).status(), 401);
  await hostPage.getByLabel('房主密码').fill(password);
  await hostPage.getByRole('button', { name: '登录', exact: true }).tap();
  await hostPage.getByLabel('B 站视频链接').fill(source);
  await hostPage.getByRole('button', { name: '创建房间并导入' }).tap();

  if (simulateFirstFailure && checkFile) {
    await watchStatus(hostPage, 'failed').waitFor();
    assert.match(await hostPage.locator('#room-error').textContent(), /暂时无法.*重试/);
    const failedPath = new URL(hostPage.url()).pathname;
    await hostPage.getByRole('button', { name: '重试导入' }).tap();
    await hostPage.locator('#status:not([data-status="failed"])').waitFor();
    assert.ok(new URL(hostPage.url()).pathname === failedPath, 'Retry must stay in the original room');
    console.log('Synthetic connection reset: actionable error and same-room retry passed.');
  }

  await generate.tap();
  await inviteLink.waitFor();
  const hostPath = new URL(hostPage.url()).pathname;
  assert.equal(new URL(hostPage.url()).origin, origin);
  const revokedLink = await inviteLink.inputValue();
  await hostPage.getByRole('button', { name: '撤销邀请' }).tap();
  await inviteLink.waitFor({ state: 'hidden' });
  await strangerPage.goto(revokedLink, { waitUntil: 'domcontentloaded' });
  await watchStatus(strangerPage, 'expired').waitFor();
  await generate.tap();
  await inviteLink.waitFor();
  const replacedLink = await inviteLink.inputValue();
  await generate.tap();
  await hostPage.waitForFunction(old => document.querySelector('#invite-url').value !== old, replacedLink);
  const invitation = await inviteLink.inputValue();
  assert.ok(invitation.startsWith(origin + '/invite/') && invitation !== revokedLink);
  await hostPage.getByRole('button', { name: '复制邀请' }).tap();
  await hostPage.locator('#action-message').filter({ hasText: /已复制邀请|请复制已选中/ }).waitFor();

  await strangerPage.goto(replacedLink, { waitUntil: 'domcontentloaded' });
  await strangerPage.waitForFunction(() => !location.hash);
  await watchStatus(strangerPage, 'expired').waitFor();
  await visitorPage.goto(invitation, { waitUntil: 'domcontentloaded' });
  await watchStatus(visitorPage, 'pending').waitFor();
  const requestCode = (await visitorPage.locator('#request-code').textContent()).match(/[a-f0-9]{8}/)[0];
  await strangerPage.goto(invitation, { waitUntil: 'domcontentloaded' });
  await watchStatus(strangerPage, 'pending').waitFor();

  const media = '/media/' + hostPath.split('/').at(-1) + '.mp4';
  assert.equal((await visitor.request.get(apiOrigin + media, { headers: range })).status(), 401);
  await hostPage.getByRole('button', { name: '批准访客 ' + requestCode, exact: true }).tap();
  await watchStatus(strangerPage, 'full').waitFor();
  const visitorStatus = visitorPage.locator('#status[data-status="waiting"], #status[data-status="ready"], #status[data-status="failed"]');
  await visitorStatus.waitFor();
  const waitedForVideo = await visitorStatus.getAttribute('data-status') === 'waiting';
  await visitorPage.reload({ waitUntil: 'domcontentloaded' });
  await hostPage.reload({ waitUntil: 'domcontentloaded' });
  for (const page of [hostPage, visitorPage]) {
    await page.locator('#status[data-status="ready"], #status[data-status="failed"]').waitFor({ timeout: 360_000 });
    assert.equal(await page.locator('#status').textContent(), '视频已就绪',
      await page.locator('#room-error').textContent());
    assert.match(await page.locator('#source-detail').textContent(), /BV1TDyazeEuY/);
    assert.notEqual(await page.locator('#title').textContent(), '观影房间');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'Mobile page must fit the viewport');
  }

  if (deployedOrigin || splitFixture) {
    for (const [context, cookiePrefix] of [[host, 'watch_party_host'], [visitor, 'watch_party_visitor_']]) {
      const cookie = (await context.cookies(apiOrigin)).find(cookie => cookie.name.startsWith(cookiePrefix));
      assert.ok(cookie?.secure && cookie.httpOnly && cookie.sameSite === 'Strict');
      assert.equal(cookie.domain, new URL(apiOrigin).hostname);
    }
  }
  if (apiOrigin !== origin) {
    const denied = await host.request.get(apiOrigin + '/api/session', {
      headers: { Origin: 'https://other.example.org' },
    });
    assert.equal(denied.status(), 403);
    assert.equal(denied.headers()['access-control-allow-origin'], undefined);
    for (const page of [hostPage, visitorPage]) {
      const { status, contentRange, cacheControl, size } = await page.evaluate(async url => {
        const response = await fetch(url, { credentials: 'include', headers: { Range: 'bytes=0-1023' } });
        return {
          status: response.status,
          contentRange: response.headers.get('content-range'),
          cacheControl: response.headers.get('cache-control'),
          size: (await response.arrayBuffer()).byteLength,
        };
      }, apiOrigin + media);
      assert.equal(status, 206);
      assert.match(contentRange, /^bytes 0-1023\/\d+$/);
      assert.equal(cacheControl, 'private, no-store');
      assert.equal(size, 1024);
    }
    console.log('Split HTTPS: allowlisted browser sessions received private 206 media; foreign Origin denied.');
  }
  for (const context of [host, visitor]) {
    const head = await context.request.head(apiOrigin + media);
    assert.equal(head.status(), 200);
    assert.equal(head.headers()['accept-ranges'], 'bytes');
    const first = await context.request.get(apiOrigin + media, { headers: range });
    assert.equal(first.status(), 206);
    assert.equal(first.headers()['content-type'], 'video/mp4');
    assert.equal(first.headers()['accept-ranges'], 'bytes');
    assert.match(first.headers()['content-range'], /^bytes 0-1023\/\d+$/);
    assert.equal((await first.body()).length, 1024);
    const last = await context.request.get(apiOrigin + media, { headers: { Range: 'bytes=-128' } });
    assert.equal(last.status(), 206);
    assert.equal((await last.body()).length, 128);
  }
  for (const headers of [undefined, range]) {
    assert.equal((await stranger.request.get(apiOrigin + media, { headers })).status(), 401);
    assert.equal((await stranger.request.head(apiOrigin + media, { headers })).status(), 401);
  }
  await strangerPage.goto(origin + hostPath);
  await strangerPage.getByRole('heading', { name: '房主登录' }).waitFor();
  assert.equal(await strangerPage.locator('video').getAttribute('src'), null);

  const duplicateTab = await host.newPage();
  await duplicateTab.goto(origin);
  await duplicateTab.getByLabel('B 站视频链接').fill(source);
  await duplicateTab.getByRole('button', { name: '创建房间并导入' }).tap();
  await watchStatus(duplicateTab, 'ready').waitFor();
  assert.ok(new URL(duplicateTab.url()).pathname === hostPath, 'Duplicate submission must reuse the active room');
  await duplicateTab.close();

  await checkSharedPlayback({ hostPage, visitorPage, host, visitor, stranger, origin, apiOrigin, hostPath });
  if (checkFile && mediaDir) await checkMediaFile(media);

  hostPage.once('dialog', dialog => dialog.accept());
  await hostPage.getByRole('button', { name: '结束房间' }).tap();
  await watchStatus(hostPage, 'ended').waitFor();
  await watchStatus(visitorPage, 'ended').waitFor();
  assert.equal(await visitorPage.locator('video').getAttribute('src'), null);
  assert.equal((await host.request.get(apiOrigin + media, { headers: range })).status(), 410);
  assert.equal((await visitor.request.get(apiOrigin + media, { headers: range })).status(), 401);
  await strangerPage.goto(invitation);
  await watchStatus(strangerPage, 'ended').waitFor();
  console.log(profile + ': independent approval, shared mobile playback and seek, denied third session, and room end passed. ' +
    'Observed approved visitor waiting for import: ' + waitedForVideo + '.');
}

try {
  assert.ok(!synthetic || (!deployedOrigin && !simulateFirstFailure), 'Synthetic video requires the standalone test server');
  assert.ok(!splitFixture || synthetic, 'The isolated split fixture requires SYNTHETIC_VIDEO=1');
  assert.ok(!deployedApiOrigin || deployedOrigin, 'BROWSER_API_ORIGIN requires BROWSER_ORIGIN');
  if (deployedOrigin) {
    for (const origin of [deployedOrigin, deployedApiOrigin ?? deployedOrigin]) {
      assert.equal(new URL(origin).protocol, 'https:', 'Deployed browser run requires HTTPS');
      assert.equal(new URL(origin).origin, origin, 'Use an origin without a trailing slash');
      if (ignoreHTTPSErrors) {
        assert.ok(['localhost', '127.0.0.1'].includes(new URL(origin).hostname),
          'Test trust bypass is for isolated loopback HTTPS only');
      }
    }
    assert.ok(password, 'Set HOST_PASSWORD for the deployed browser run');
    assert.ok(!simulateFirstFailure, 'Failure injection requires the test-managed app server');
  } else {
    if (splitFixture) fixture = await startSplitFixture(dataDir);
    const importVideo = synthetic
      ? async ({ output, update, signal }) => {
          update({ title: '合成验收视频' });
          update({ status: 'preparing' });
          await run(ffmpeg, [
            '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
            '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '60',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', output,
          ], { signal });
          return 60;
        }
      : createImporter({
        ffmpeg, ffprobe,
        async fetch(...args) {
          if (failNextRequest) {
            failNextRequest = false;
            throw new TypeError('Synthetic connection reset during first import');
          }
          return fetch(...args);
        },
      });
    app = await startServer({
      dataDir, password, port: 0, importVideo, webOrigin: fixture?.webOrigin, publicOrigin: fixture?.apiOrigin,
    });
    fixture?.bind(app);
  }
  const origin = deployedOrigin ?? fixture?.webOrigin ?? app.origin;
  const apiOrigin = deployedApiOrigin ?? fixture?.apiOrigin ?? origin;
  for (const [engine, profile] of [[chromium, 'Pixel 7'], [webkit, 'iPhone 13']]) {
    const browser = await engine.launch();
    try {
      console.log(engine.name() + ' ' + browser.version() + ' (' + profile + '), ' + new URL(origin).protocol);
      await checkSessions(browser, profile, origin, apiOrigin, engine === chromium);
    } finally {
      await browser.close();
    }
  }
} catch (error) {
  console.error('Live check failed:', error.message
    .replace(/\/(rooms|media|invite)\/[a-f0-9-]+(?:\.mp4|#[a-f0-9]+)?/g, '/$1/[redacted]')
    .replaceAll(mediaDir ?? '\0', '[temporary data]'));
  process.exitCode = 1;
} finally {
  await fixture?.close();
  await app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}

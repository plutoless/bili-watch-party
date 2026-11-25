import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, devices, webkit } from 'playwright';
import { createImporter, ImportError } from '../src/importer.js';
import { createR2Media } from '../src/r2-media.js';
import { startServer } from '../src/server.js';
import { formatBrowserFailure } from './browser-failure.js';
import { checkPlaybackReconnect, checkSharedPlayback } from './playback-browser.js';
import { startR2Fixture } from './r2-fixture.js';
import { createLoopbackTls, readLoopbackTls, startSplitFixture } from './split-browser-fixture.js';

const run = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH ?? 'ffprobe';
const source = 'https://www.bilibili.com/video/BV1TDyazeEuY';
const deployedOrigin = process.env.BROWSER_ORIGIN;
const deployedApiOrigin = process.env.BROWSER_API_ORIGIN;
const deployedMediaOrigin = process.env.BROWSER_MEDIA_ORIGIN;
const r2Fixture = process.env.BROWSER_R2_FIXTURE === '1';
const fixtureTlsDir = process.env.BROWSER_R2_TLS_DIR;

// Node reads extra roots at startup. Trust only the generated loopback fixture in this run.
if (r2Fixture && !deployedOrigin && !fixtureTlsDir) {
  const directory = await mkdtemp(join(tmpdir(), 'watch-party-r2-tls-'));
  let exitCode;
  try {
    const { cert } = await createLoopbackTls(directory);
    const extra = process.env.NODE_EXTRA_CA_CERTS;
    const trust = join(directory, 'ca.pem');
    await writeFile(trust, extra ? Buffer.concat([await readFile(extra), Buffer.from('\n'), cert]) : cert);
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: trust, BROWSER_R2_TLS_DIR: directory },
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    exitCode = result.status ?? 1;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  process.exit(exitCode);
}
const password = deployedOrigin ? process.env.HOST_PASSWORD : 'synthetic-browser-test-password';
const dataDir = deployedOrigin ? null : await mkdtemp(join(tmpdir(), 'watch-party-live-'));
const mediaDir = dataDir ?? process.env.BROWSER_DATA_DIR;
const simulateFirstFailure = process.env.SIMULATE_FIRST_FAILURE === '1';
const synthetic = process.env.SYNTHETIC_VIDEO === '1';
const splitFixture = r2Fixture || process.env.BROWSER_SYNTHETIC_SPLIT === '1';
const ignoreHTTPSErrors = splitFixture || process.env.BROWSER_LOCAL_TLS === '1';
let app;
let fixture;
let storage;
const browsers = [];
let failNextRequest = simulateFirstFailure;
let importGate;
let clockOffset = 0;
let failurePhase = 'configuration';

function reportFailure(error, phase = failurePhase) {
  console.error('Live check failed:', formatBrowserFailure(error, phase));
  process.exitCode = 1;
}

async function checkMediaFile(output) {
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

async function syntheticTracks(directory) {
  const video = join(directory, 'source-video.mp4');
  const audio = join(directory, 'source-audio.mp4');
  await run(ffmpeg, [
    '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-map', '0:v:0', '-t', '60', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video,
    '-map', '1:a:0', '-t', '60', '-c:a', 'aac', audio,
  ]);
  const cdn = 'https://synthetic.bilivideo.com/';
  return async input => {
    const url = new URL(input);
    switch (url.pathname) {
      case '/x/web-interface/view':
        return Response.json({ code: 0, data: {
          title: '合成验收视频', pages: [{ page: 1, cid: 42, duration: 60 }],
        } });
      case '/x/player/playurl':
        return Response.json({ code: 0, data: { dash: { duration: 60,
          video: [{ codecs: 'avc1.64001E', id: 32, baseUrl: cdn + 'video' }],
          audio: [{ codecs: 'mp4a.40.2', bandwidth: 32000, baseUrl: cdn + 'audio' }],
        } } });
      case '/video':
        return new Response(await readFile(video));
      case '/audio':
        return new Response(await readFile(audio));
      default:
        return new Response(null, { status: 404 });
    }
  };
}

async function checkSessions(hostBrowser, hostProfile, visitorBrowser, visitorProfile, origin, apiOrigin, checkFile) {
  failurePhase = 'room admission';
  const hostOptions = { ...devices[hostProfile], ignoreHTTPSErrors };
  const visitorOptions = { ...devices[visitorProfile], ignoreHTTPSErrors };
  const host = await hostBrowser.newContext(hostOptions);
  const visitor = await visitorBrowser.newContext(visitorOptions);
  const stranger = await visitorBrowser.newContext(visitorOptions);
  if (synthetic) {
    await host.addInitScript(() => {
      const matchesInvitation = url => url === document.querySelector('#invite-url').value;
      Object.defineProperty(navigator, 'share', {
        value: async ({ url }) => { window.sharedExpectedInvitation = matchesInvitation(url); },
      });
      Object.defineProperty(navigator, 'clipboard', {
        get: () => window.allowInvitationCopy ? {
          async writeText(url) { window.copiedExpectedInvitation = matchesInvitation(url); },
        } : undefined,
      });
    });
  }
  const hostPage = await host.newPage();
  const visitorPage = await visitor.newPage();
  const strangerPage = await stranger.newPage();
  const inviteLink = hostPage.getByLabel('邀请链接');
  const generate = hostPage.getByRole('button', { name: '生成邀请', exact: true });
  const manage = hostPage.getByText('管理房间', { exact: true });
  const create = hostPage.getByRole('button', { name: '创建房间并导入' });
  const sourceInput = hostPage.getByLabel('B 站视频链接');
  const back = hostPage.getByRole('link', { name: '返回首页' });
  const resume = hostPage.getByRole('link', { name: '继续观影' });
  const copy = hostPage.getByRole('button', { name: '复制邀请' });
  const watchStatus = (page, state) => page.locator('#status[data-status="' + state + '"]');
  const range = { Range: 'bytes=0-1023' };
  const writesBefore = storage?.writes;
  if (storage) storage.nextUpload = 'dropResponse';

  const home = await hostPage.goto(origin);
  const legacyWeb = await hostPage.locator('#recent-room').count() === 0;
  assert.ok(!legacyWeb || (splitFixture && process.env.BROWSER_WEB_SOURCE),
    'The current webpage must provide a recent-room entry');
  const singleApproval = hostPage.getByRole('button', {
    name: legacyWeb ? /^批准访客 [a-f0-9]{8}$/ : '批准访客', exact: true,
  });
  async function openManagement() {
    if (!legacyWeb) await manage.tap();
  }
  assert.equal((await home.allHeaders())['permissions-policy'], 'microphone=()');
  assert.equal((await stranger.request.get(apiOrigin + '/api/rooms')).status(), 401);
  await hostPage.getByLabel('房主密码').fill(password);
  await hostPage.getByRole('button', { name: '登录', exact: true }).tap();
  await sourceInput.fill(source);
  await create.tap();
  await copy.waitFor();
  const hostPath = new URL(hostPage.url()).pathname;
  assert.equal(new URL(hostPage.url()).origin, origin);
  const originalLink = await inviteLink.inputValue();
  assert.ok(originalLink.startsWith(origin + '/invite/'));
  if (synthetic && !legacyWeb) {
    await hostPage.locator('#status:is([data-status="preparing"], [data-status="failed"])').waitFor();
    await hostPage.getByRole('button', { name: '分享邀请' }).tap();
    assert.ok(await hostPage.evaluate(() => window.sharedExpectedInvitation));
    await hostPage.evaluate(() => { window.allowInvitationCopy = true; });
    await copy.tap();
    await hostPage.getByText('已复制邀请。', { exact: true }).waitFor();
    assert.ok(await hostPage.evaluate(() => window.copiedExpectedInvitation));
    await hostPage.evaluate(() => { window.allowInvitationCopy = false; });
    await copy.tap();
    await inviteLink.waitFor();
    assert.ok(await inviteLink.evaluate(input =>
      document.activeElement === input && input.selectionStart === 0 && input.selectionEnd === input.value.length));
  }

  await visitorPage.goto(originalLink, { waitUntil: 'domcontentloaded' });
  await watchStatus(visitorPage, 'pending').waitFor();
  await singleApproval.waitFor();
  const initialCode = await visitorPage.locator('#request-code').textContent();
  if (simulateFirstFailure && checkFile) {
    await watchStatus(hostPage, 'failed').waitFor();
    assert.match(await hostPage.locator('#room-error').textContent(), /暂时无法.*重试/);
    await hostPage.getByRole('button', { name: '重试导入' }).tap();
    await hostPage.locator('#status:not([data-status="failed"])').waitFor();
    assert.ok(new URL(hostPage.url()).pathname === hostPath, 'Retry must stay in the original room');
    assert.ok(await inviteLink.inputValue() === originalLink, 'Retry must keep the original invitation');
    await singleApproval.waitFor();
    console.log('Injected connection reset: actionable error and same-room retry with pending application passed.');
  }
  if (!legacyWeb) {
    await back.tap();
    await resume.tap();
    await singleApproval.waitFor();
    assert.ok(new URL(hostPage.url()).pathname === hostPath, 'Home must resume the last room');
  }
  await hostPage.getByRole('link', { name: 'B 站一起看' }).tap();
  await sourceInput.fill(source + '?p=01');
  await create.tap();
  await singleApproval.waitFor();
  assert.ok(new URL(hostPage.url()).pathname === hostPath, 'Duplicate submission must reuse the active room');
  await hostPage.reload({ waitUntil: 'domcontentloaded' });
  await singleApproval.waitFor();
  await visitorPage.reload({ waitUntil: 'domcontentloaded' });
  await watchStatus(visitorPage, 'pending').waitFor();
  assert.ok(await visitorPage.locator('#request-code').textContent() === initialCode,
    'Refresh and duplicate submission must retain the pending request');
  assert.ok(await inviteLink.inputValue() === originalLink, 'Refresh and duplicate submission must retain the invitation');

  await openManagement();
  await hostPage.getByRole('button', { name: '撤销邀请' }).tap();
  await copy.waitFor({ state: 'hidden' });
  await watchStatus(visitorPage, 'expired').waitFor();
  await strangerPage.goto(originalLink, { waitUntil: 'domcontentloaded' });
  await watchStatus(strangerPage, 'expired').waitFor();
  await hostPage.getByRole('link', { name: 'B 站一起看' }).tap();
  await sourceInput.fill(source);
  await create.tap();
  await generate.waitFor();
  assert.equal(await copy.isVisible(), false);
  await generate.tap();
  await copy.waitFor();
  if (synthetic) {
    const expiring = await inviteLink.inputValue();
    clockOffset += 30 * 60_000;
    await strangerPage.goto(expiring, { waitUntil: 'domcontentloaded' });
    await watchStatus(strangerPage, 'expired').waitFor();
    await hostPage.reload({ waitUntil: 'domcontentloaded' });
    await generate.tap();
    await copy.waitFor();
  }
  await openManagement();
  await inviteLink.waitFor();
  const replacedLink = await inviteLink.inputValue();
  await hostPage.getByRole('button', { name: '更换邀请' }).tap();
  await hostPage.waitForFunction(old => document.querySelector('#invite-url').value !== old, replacedLink);
  const invitation = await inviteLink.inputValue();
  assert.ok(invitation.startsWith(origin + '/invite/') && invitation !== originalLink);
  await copy.tap();
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
  assert.equal((await stranger.request.get(apiOrigin + media, { headers: range })).status(), 401);
  await hostPage.getByRole('button', { name: '批准访客 ' + requestCode, exact: true }).tap();
  await watchStatus(strangerPage, 'full').waitFor();
  const visitorStatus = visitorPage.locator('#status[data-status="waiting"], #status[data-status="ready"], #status[data-status="failed"]');
  await visitorStatus.waitFor();
  const waitedForVideo = await visitorStatus.getAttribute('data-status') === 'waiting';
  if (synthetic) {
    assert.ok(waitedForVideo, 'Approval during import must show waiting for import');
    importGate.resolve();
  }
  if (storage) {
    await watchStatus(hostPage, 'failed').waitFor({ timeout: 360_000 });
    assert.match(await hostPage.locator('#room-error').textContent(), /无法发布视频/);
    assert.equal(await hostPage.locator('video').getAttribute('src'), null);
    assert.equal(storage.writes, writesBefore + 1);
    await hostPage.getByRole('button', { name: '重试导入' }).tap();
  }
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
  failurePhase = 'media access';
  const roomResponse = await host.request.get(apiOrigin + '/api' + hostPath);
  assert.equal(roomResponse.status(), 200);
  const room = await roomResponse.json();
  const publicMedia = room.mediaPublic === true;
  const expectedMediaOrigin = storage?.options.publicOrigin ?? deployedMediaOrigin;
  assert.ok(!expectedMediaOrigin || publicMedia, 'The room must publish to the expected media origin');
  const mediaUrl = new URL(room.mediaUrl, apiOrigin).href;
  if (publicMedia) {
    const address = new URL(mediaUrl);
    assert.equal(address.protocol, 'https:');
    assert.ok(address.origin !== origin && address.origin !== apiOrigin, 'Public media must use a separate HTTPS origin');
    if (expectedMediaOrigin) assert.equal(address.origin, expectedMediaOrigin);
    if (ignoreHTTPSErrors) assert.ok(['localhost', '127.0.0.1'].includes(address.hostname),
      'Test trust bypass is for isolated loopback HTTPS only');
    assert.equal((await host.request.get(apiOrigin + media, { headers: range })).status(), 404);
  } else {
    assert.equal(mediaUrl, apiOrigin + media, 'Protected media must be served by the room API origin');
  }
  for (const page of [hostPage, visitorPage]) {
    assert.ok(await page.locator('video').evaluate((video, url) => video.src === url, mediaUrl));
    if (publicMedia) assert.equal(await page.locator('video').getAttribute('crossorigin'), 'anonymous');
  }
  const publicContext = publicMedia && await hostBrowser.newContext(hostOptions);
  const publicReader = publicContext?.request;
  if (apiOrigin !== origin) {
    const denied = await host.request.get(apiOrigin + '/api/session', {
      headers: { Origin: 'https://other.example.org' },
    });
    assert.equal(denied.status(), 403);
    assert.equal(denied.headers()['access-control-allow-origin'], undefined);
  }
  if (apiOrigin !== origin && !publicMedia) {
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
  const mediaHeaders = publicMedia ? { Origin: origin } : {};
  for (const reader of publicMedia ? [publicReader] : [host.request, visitor.request]) {
    const head = await reader.head(mediaUrl, { headers: mediaHeaders, maxRedirects: 0 });
    assert.equal(head.status(), 200);
    assert.equal(head.headers()['accept-ranges'], 'bytes');
    const first = await reader.get(mediaUrl, { headers: { ...mediaHeaders, ...range }, maxRedirects: 0 });
    assert.equal(first.status(), 206);
    if (publicMedia) assert.ok([origin, '*'].includes(first.headers()['access-control-allow-origin']),
      'Anonymous Range must allow the web origin');
    assert.equal(first.headers()['content-type'], 'video/mp4');
    assert.equal(first.headers()['accept-ranges'], 'bytes');
    assert.match(first.headers()['content-range'], /^bytes 0-1023\/\d+$/);
    assert.equal((await first.body()).length, 1024);
    const last = await reader.get(mediaUrl, { headers: { ...mediaHeaders, Range: 'bytes=-128' }, maxRedirects: 0 });
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

  failurePhase = 'shared playback';
  await checkSharedPlayback({
    hostPage, visitorPage, host, visitor, stranger, origin, apiOrigin, hostPath, publicMedia,
  });
  if (checkFile && mediaDir && (!publicMedia || storage)) {
    const path = storage ? join(mediaDir, 'public-object.mp4') : join(mediaDir, 'media', media.split('/').at(-1));
    if (storage) await writeFile(path, storage.objects.get(new URL(mediaUrl).pathname).body);
    await checkMediaFile(path);
  }

  failurePhase = 'public lifecycle';
  let finalMedia = mediaUrl;
  if (publicMedia) {
    for (const page of [hostPage, visitorPage]) {
      assert.ok(await page.locator('video').evaluate((video, url) => video.currentSrc === url, mediaUrl));
    }
    await checkPlaybackReconnect(hostPage, visitorPage);
    console.log('Direct public media: both players loaded the media origin, anonymous Range returned 206, and room controls remained protected.');
  }
  if (storage) {
    assert.ok(storage.ranges.some(read => read.path === new URL(mediaUrl).pathname &&
      read.origin === origin && /Mozilla/.test(read.userAgent) && read.end > read.start),
    'The mobile video element must receive a 206 from the public media origin');
    assert.equal(storage.writes, writesBefore + 1);
    storage.remove(mediaUrl);
    assert.equal((await publicReader.get(mediaUrl, { headers: range })).status(), 404);
    for (const page of [hostPage, visitorPage]) {
      await watchStatus(page, 'media-expired').waitFor();
      assert.equal(await page.locator('video').getAttribute('src'), null);
    }
    if (!legacyWeb) {
      await back.tap();
      await resume.tap();
      await watchStatus(hostPage, 'media-expired').waitFor();
      assert.ok(new URL(hostPage.url()).pathname === hostPath, 'Home must resume the room after media expiry');
    }
    await hostPage.getByRole('button', { name: '重新导入' }).tap();
    for (const page of [hostPage, visitorPage]) {
      await page.locator('#status[data-status="ready"], #status[data-status="failed"]').waitFor({ timeout: 360_000 });
      assert.equal(await page.locator('#status').getAttribute('data-status'), 'ready',
        await page.locator('#room-error').textContent());
    }
    finalMedia = await hostPage.locator('video').evaluate(video => video.src);
    assert.notEqual(finalMedia, mediaUrl);
    assert.equal((await publicReader.get(mediaUrl, { headers: range })).status(), 404);
    assert.equal(storage.writes, writesBefore + 2);
    for (const page of [hostPage, visitorPage]) await page.getByRole('button', { name: '准备好了', exact: true }).tap();
    await hostPage.getByText('访客 · 已就绪').waitFor();
    await hostPage.locator('#play').tap();
    await Promise.all([hostPage, visitorPage].map(page => page.waitForFunction(() => {
      const video = document.querySelector('video');
      return !video.paused && video.videoWidth > 0 && video.currentTime > 0.25 && video.currentTime < 5;
    })));
    console.log('Direct public 206, ambiguous-upload retry, expired-link rejection and reimport passed.');
  }

  await openManagement();
  failurePhase = 'room revocation';
  hostPage.once('dialog', dialog => dialog.accept());
  await hostPage.getByRole('button', { name: '结束房间' }).tap();
  await watchStatus(hostPage, 'ended').waitFor();
  await watchStatus(visitorPage, 'ended').waitFor();
  assert.equal(await visitorPage.locator('video').getAttribute('src'), null);
  assert.equal((await host.request.get(apiOrigin + media, { headers: range })).status(), 410);
  assert.equal((await visitor.request.get(apiOrigin + media, { headers: range })).status(), 401);
  if (publicMedia) {
    assert.equal((await publicReader.get(finalMedia, { headers: range })).status(), 206);
    storage?.remove(finalMedia);
  }
  await strangerPage.goto(invitation);
  await watchStatus(strangerPage, 'ended').waitFor();
  if (!legacyWeb) {
    for (const unavailable of [hostPath, '/rooms/00000000-0000-4000-8000-000000000000']) {
      await hostPage.evaluate(path => localStorage.setItem('watch-party-recent-room', path), unavailable);
      await Promise.all([
        hostPage.waitForResponse(response => new URL(response.url()).pathname === '/api' + unavailable),
        hostPage.goto(origin),
      ]);
      await create.waitFor();
      await hostPage.waitForFunction(() => !localStorage.getItem('watch-party-recent-room'));
      assert.equal(await resume.isVisible(), false);
    }
  }
  const resumeSummary = legacyWeb ? '' : 'home resume, ';
  console.log(hostProfile + ' / ' + visitorProfile + ': initial invitation, ' + resumeSummary +
    'deduplication, approval, shared playback and seek, denied third session, and invalidation passed. ' +
    'Observed approved visitor waiting for import: ' + waitedForVideo + '.');
  await Promise.all([host, visitor, stranger, ...(publicContext ? [publicContext] : [])]
    .map(context => context.close()));
}

try {
  assert.ok(!synthetic || !deployedOrigin, 'Synthetic video requires the standalone test server');
  assert.ok(!splitFixture || (!deployedOrigin && (synthetic || r2Fixture)),
    'The isolated split fixture requires a local app and SYNTHETIC_VIDEO=1 or BROWSER_R2_FIXTURE=1');
  assert.ok(!(deployedApiOrigin || deployedMediaOrigin) || deployedOrigin,
    'BROWSER_API_ORIGIN and BROWSER_MEDIA_ORIGIN require BROWSER_ORIGIN');
  if (deployedOrigin) {
    const origins = [deployedOrigin, deployedApiOrigin ?? deployedOrigin];
    if (deployedMediaOrigin) origins.push(deployedMediaOrigin);
    for (const origin of origins) {
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
    failurePhase = 'fixture setup';
    if (r2Fixture) {
      const tls = await readLoopbackTls(fixtureTlsDir);
      storage = await startR2Fixture({ tls });
      fixture = await startSplitFixture(dataDir, { tls, mediaOrigin: storage.options.publicOrigin });
    } else if (splitFixture) fixture = await startSplitFixture(dataDir);
    const prepareVideo = synthetic && !storage
      ? async ({ output, signal }) => {
          await run(ffmpeg, [
            '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
            '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '60',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', output,
          ], { signal });
          return 60;
        }
      : createImporter({
        ffmpeg, ffprobe,
        fetch: synthetic ? await syntheticTracks(dataDir) : async (...args) => {
          if (failNextRequest) {
            failNextRequest = false;
            throw new TypeError('Synthetic connection reset during first import');
          }
          return fetch(...args);
        },
      });
    const importVideo = synthetic ? async job => {
      if (failNextRequest) {
        failNextRequest = false;
        throw new ImportError('network');
      }
      job.update({ title: '合成验收视频' });
      job.update({ status: 'preparing' });
      await importGate.promise;
      job.signal.throwIfAborted();
      return prepareVideo(job);
    } : prepareVideo;
    app = await startServer({
      dataDir, password, port: 0, importVideo, now: () => Date.now() + clockOffset,
      webOrigin: fixture?.webOrigin, publicOrigin: fixture?.apiOrigin,
      r2Media: storage && createR2Media({ ...storage.options, webOrigin: fixture.webOrigin }),
    });
    fixture?.bind(app);
  }
  const origin = deployedOrigin ?? fixture?.webOrigin ?? app.origin;
  const apiOrigin = deployedApiOrigin ?? fixture?.apiOrigin ?? origin;
  failurePhase = 'browser launch';
  browsers.push(await chromium.launch());
  browsers.push(await webkit.launch());
  const [android, iphone] = browsers;
  console.log('Chromium ' + android.version() + ' (Pixel 7), WebKit ' + iphone.version() +
    ' (iPhone 13), ' + new URL(origin).protocol);
  for (const [host, hostProfile, visitor, visitorProfile, checkFile] of [
    [android, 'Pixel 7', android, 'Pixel 7', true],
    [iphone, 'iPhone 13', iphone, 'iPhone 13', false],
    [android, 'Pixel 7', iphone, 'iPhone 13', false],
  ]) {
    importGate = Promise.withResolvers();
    await checkSessions(host, hostProfile, visitor, visitorProfile, origin, apiOrigin, checkFile);
  }
} catch (error) {
  reportFailure(error);
} finally {
  async function attemptCleanup(action) {
    try {
      await action();
    } catch (error) {
      reportFailure(error, 'cleanup');
    }
  }

  importGate?.resolve();
  await Promise.all(browsers.map(browser => attemptCleanup(() => browser.close())));
  await attemptCleanup(() => fixture?.close());
  await attemptCleanup(() => app?.close());
  await attemptCleanup(() => storage?.close());
  if (dataDir) await attemptCleanup(() => rm(dataDir, { recursive: true, force: true }));
}

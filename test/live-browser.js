import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chromium, devices, webkit } from 'playwright';
import { createImporter } from '../src/importer.js';
import { startServer } from '../src/server.js';

const run = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH ?? 'ffprobe';
const source = 'https://www.bilibili.com/video/BV1TDyazeEuY';
const password = 'synthetic-browser-test-password';
const dataDir = await mkdtemp(join(tmpdir(), 'watch-party-live-'));
const simulateFirstFailure = process.env.SIMULATE_FIRST_FAILURE === '1';
let failNextRequest = simulateFirstFailure;
let app;
try {
  app = await startServer({
    dataDir, password, port: 0,
    importVideo: createImporter({
      ffmpeg, ffprobe,
      async fetch(...args) {
        if (failNextRequest) {
          failNextRequest = false;
          throw new TypeError('Synthetic connection reset during first import');
        }
        return fetch(...args);
      },
    }),
  });
  let roomPath;
  for (const [engine, profile] of [[chromium, 'Pixel 7'], [webkit, 'iPhone 13']]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext(devices[profile]);
      const page = await context.newPage();
      await page.goto(app.origin);
      await page.getByLabel('房主密码').fill(password);
      await page.getByRole('button', { name: '登录' }).tap();
      await page.getByLabel('B 站视频链接').fill(source);
      await page.getByRole('button', { name: '创建房间并导入' }).tap();
      if (!roomPath && simulateFirstFailure) {
        await page.locator('#status[data-status="failed"]').waitFor();
        assert.match(await page.locator('#room-error').textContent(), /暂时无法.*重试/);
        const failedPath = new URL(page.url()).pathname;
        await page.getByRole('button', { name: '重试导入' }).tap();
        await page.locator('#status:not([data-status="failed"])').waitFor();
        assert.ok(new URL(page.url()).pathname === failedPath, 'Retry must stay in the original room');
        console.log('Synthetic connection reset: actionable error and same-room retry passed.');
      }
      await page.locator('#status[data-status="ready"], #status[data-status="failed"]')
        .waitFor({ timeout: 360_000 });
      assert.equal(await page.locator('#status').textContent(), '视频已就绪',
        await page.locator('#room-error').textContent());
      assert.match(await page.locator('#source-detail').textContent(), /BV1TDyazeEuY/);
      assert.notEqual(await page.locator('#title').textContent(), '观影房间');
      const path = new URL(page.url()).pathname;
      if (roomPath) assert.ok(path === roomPath, 'Duplicate browser submission must reuse the room');
      roomPath = path;
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        'Mobile page must fit the viewport');

      const media = await page.locator('video').getAttribute('src');
      const first = await context.request.get(app.origin + media, { headers: { Range: 'bytes=0-1023' } });
      assert.equal(first.status(), 206);
      assert.equal(first.headers()['content-type'], 'video/mp4');
      assert.equal(first.headers()['accept-ranges'], 'bytes');
      assert.match(first.headers()['content-range'], /^bytes 0-1023\/\d+$/);
      assert.equal((await first.body()).length, 1024);
      const last = await context.request.get(app.origin + media, { headers: { Range: 'bytes=-128' } });
      assert.equal(last.status(), 206);
      assert.equal((await last.body()).length, 128);
      const stranger = await browser.newContext(devices[profile]);
      const strangerPage = await stranger.newPage();
      await strangerPage.goto(app.origin + path);
      await strangerPage.getByRole('heading', { name: '房主登录' }).waitFor();
      assert.equal(await strangerPage.locator('video').getAttribute('src'), null);
      assert.equal((await stranger.request.get(app.origin + media, {
        headers: { Range: 'bytes=0-1' },
      })).status(), 401);
      await stranger.close();

      await page.getByRole('button', { name: '播放', exact: true }).tap();
      await page.waitForFunction(() => {
        const video = document.querySelector('video');
        return !video.paused && video.currentTime > 0.25 && video.videoWidth > 0 && !video.muted;
      });
      // Both engines exercise real HTMLMediaElement seeking. Native controls differ between engines.
      await page.locator('video').evaluate(video => { video.currentTime = 600; });
      await page.waitForFunction(() => {
        const video = document.querySelector('video');
        return !video.paused && !video.seeking && video.readyState >= 2 &&
          video.currentTime > 600.2 && video.currentTime < 610;
      });
      console.log(engine.name() + ' (' + profile + '): authenticated playback, 600 s seek, ranges and anonymous denial passed');
    } finally {
      await browser.close();
    }
  }
  const output = join(dataDir, 'media', roomPath.split('/').at(-1) + '.mp4');
  const { stdout } = await run(ffprobe, [
    '-v', 'error', '-show_entries', 'stream=codec_name,codec_type,height:format=duration',
    '-of', 'json', output,
  ]);
  const media = JSON.parse(stdout);
  const video = media.streams.find(stream => stream.codec_type === 'video');
  assert.equal(video?.codec_name, 'h264');
  assert.equal(media.streams.find(stream => stream.codec_type === 'audio')?.codec_name, 'aac');
  assert.ok(Number(media.format.duration) > 810);
  await run(ffmpeg, ['-v', 'error', '-xerror', '-i', output, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'],
    { timeout: 180_000 });
  console.log('Public sample: H.264 ' + video.height + 'p + AAC, ' + Number(media.format.duration).toFixed(2) +
    ' s, complete audio/video decode passed.');
} catch (error) {
  // Avoid publishing paths and room IDs from Playwright or process diagnostics.
  console.error('Live check failed:', error.message.replace(/\/(rooms|media)\/[\w-]+(?:\.mp4)?/g, '/$1/[redacted]')
    .replaceAll(dataDir, '[temporary data]'));
  process.exitCode = 1;
} finally {
  await app?.close();
  await rm(dataDir, { recursive: true, force: true });
}

import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const origin = URL.parse(process.env.API_ORIGIN ?? '');
if (origin?.protocol !== 'https:' || origin.origin !== process.env.API_ORIGIN ||
    !/^[a-z0-9.-]+$/.test(origin.hostname)) {
  throw new Error('API_ORIGIN 必须是 HTTPS 源地址，且无结尾斜杠。');
}
const releaseSha = process.env.RELEASE_SHA;
if (releaseSha && !/^[0-9a-f]{40}$/.test(releaseSha)) throw new Error('RELEASE_SHA 无效。');
const mediaOrigin = process.env.MEDIA_ORIGIN;
if (mediaOrigin) {
  const media = URL.parse(mediaOrigin);
  if (media?.protocol !== 'https:' || media.origin !== mediaOrigin ||
      !/^[a-z0-9.-]+$/.test(media.hostname) || mediaOrigin === origin.origin) {
    throw new Error('MEDIA_ORIGIN 必须是独立的 HTTPS 源地址，且无结尾斜杠。');
  }
}

const output = new URL('../dist/', import.meta.url);
const source = new URL('../public/', import.meta.url);
const html = await readFile(new URL('index.html', source), 'utf8');
const policy = "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; " +
  'connect-src ' + origin.origin + '; media-src ' + origin.origin + (mediaOrigin ? ' ' + mediaOrigin : '');
const page = html.replace('<meta charset="utf-8">', `<meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${policy}">
  <meta name="watch-api-origin" content="${origin.origin}">` +
  (releaseSha ? `\n  <meta name="watch-release" content="${releaseSha}">` : ''));

await rm(output, { recursive: true, force: true });
await mkdir(output);
await writeFile(new URL('index.html', output), page);
for (const file of ['app.js', 'player.js', 'style.css']) {
  await copyFile(new URL(file, source), new URL(file, output));
}
await copyFile(new URL(import.meta.resolve('xgplayer')), new URL('xgplayer.js', output));

import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function createLoopbackTls(directory) {
  const key = join(directory, 'key.pem');
  const cert = join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-nodes', '-days', '1', '-newkey', 'rsa:2048',
    '-subj', '/CN=localhost', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  return { key: await readFile(key), cert: await readFile(cert) };
}

export async function startSplitFixture(directory, { mediaOrigin = '', tls } = {}) {
  const webOutput = join(directory, 'web');
  await mkdir(webOutput);
  const webSource = process.env.BROWSER_WEB_SOURCE ?? fileURLToPath(new URL('../', import.meta.url));
  await cp(join(webSource, 'public'), join(webOutput, 'public'), { recursive: true });
  await cp(join(webSource, 'scripts/build-web.js'), join(webOutput, 'scripts/build-web.js'), { recursive: true });
  tls ??= await createLoopbackTls(directory);
  const assets = {
    '/index.html': 'text/html; charset=utf-8',
    '/app.js': 'text/javascript',
    '/player.js': 'text/javascript',
    '/style.css': 'text/css',
  };
  const web = createServer(tls, async (req, res) => {
    const path = new URL(req.url, 'https://localhost').pathname;
    const asset = path === '/' || /^\/(rooms|invite)\/[a-f0-9-]+$/.test(path) ? '/index.html' : path;
    if (!Object.hasOwn(assets, asset)) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': assets[asset], 'Permissions-Policy': 'microphone=()' });
    res.end(await readFile(join(webOutput, 'dist', asset)));
  });
  let backend;
  const api = createServer(tls, (req, res) => {
    const upstream = request(backend + req.url, { method: req.method, headers: req.headers }, received => {
      res.writeHead(received.statusCode, received.headers);
      received.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  async function listen(server) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    return 'https://127.0.0.1:' + server.address().port;
  }
  const close = async () => {
    await Promise.all([web, api].map(server => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    })));
  };
  try {
    const [webOrigin, apiOrigin] = await Promise.all([listen(web), listen(api)]);
    execFileSync(process.execPath, ['scripts/build-web.js'], {
      cwd: webOutput, env: { ...process.env, API_ORIGIN: apiOrigin, MEDIA_ORIGIN: mediaOrigin }, stdio: 'ignore',
    });
    return { webOrigin, apiOrigin, bind(app) { backend = app.localOrigin; }, close };
  } catch (error) {
    await close();
    throw error;
  }
}

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createImporter, ImportError, parseSource } from './importer.js';
import { openRooms } from './rooms.js';

const lifetime = 12 * 60 * 60;
const cookieName = 'watch_party_host';
const roomId = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const roomRoute = new RegExp('^/api/rooms/(' + roomId + ')(/retry)?$');
const pageRoute = new RegExp('^/rooms/' + roomId + '$');
const mediaRoute = new RegExp('^/media/(' + roomId + ')\\.mp4$');
const assets = {
  '/index.html': 'text/html; charset=utf-8',
  '/app.js': 'text/javascript; charset=utf-8',
  '/style.css': 'text/css; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, payload) {
  if (payload === undefined) {
    res.writeHead(status).end();
    return;
  }
  const json = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': json.length }).end(json);
}

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new HttpError(415, '请求需要 JSON 格式。');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 4096) {
      req.resume();
      throw new HttpError(413, '请求太长。');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '无法读取请求。');
  }
}

function hostSession(password) {
  const secret = randomBytes(32);
  const digest = value => createHash('sha256').update(value).digest();
  const passwordHash = digest(password);
  const sign = payload => createHmac('sha256', secret).update(payload).digest('base64url');
  let failed = 0;
  let resetAt = 0;
  return {
    login(input, secure) {
      if (Date.now() >= resetAt) {
        failed = 0;
        resetAt = Date.now() + 60_000;
      }
      if (failed >= 10) throw new HttpError(429, '尝试次数过多，请等一分钟。');
      if (typeof input !== 'string' || !timingSafeEqual(passwordHash, digest(input))) {
        failed++;
        throw new HttpError(401, '房主密码不正确。');
      }
      const payload = Math.floor(Date.now() / 1000 + lifetime) + '.' + randomBytes(16).toString('hex');
      return cookieName + '=' + payload + '.' + sign(payload) +
        '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + lifetime + (secure ? '; Secure' : '');
    },
    verify(req) {
      const cookie = req.headers.cookie?.split(';').map(value => value.trim())
        .find(value => value.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
      const token = /^(\d{10}\.[a-f0-9]{32})\.([\w-]{43})$/.exec(cookie ?? '');
      return token && Number(token[1].split('.')[0]) > Date.now() / 1000 &&
        timingSafeEqual(Buffer.from(token[2]), Buffer.from(sign(token[1])));
    },
  };
}

async function serveMedia(req, res, path) {
  let file;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') throw new HttpError(404, '视频文件不可用。');
    throw error;
  }
  try {
    const { size } = await file.stat();
    const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' };
    let start = 0;
    let end = size - 1;
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
      if (match && (match[1] || match[2])) {
        if (match[1]) {
          start = Number(match[1]);
          if (match[2]) end = Math.min(end, Number(match[2]));
        } else {
          start = Math.max(0, size - Number(match[2]));
        }
      }
      if (!match || (!match[1] && !match[2]) || start > end) {
        res.writeHead(416, { ...headers, 'Content-Range': 'bytes */' + size }).end();
        return;
      }
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD' || size === 0) res.end();
    else await pipeline(file.createReadStream({ start, end, autoClose: false }), res);
  } finally {
    await file.close();
  }
}

export async function startServer({
  dataDir = join(homedir(), '.bili-watch-party'),
  password,
  port = 3000,
  publicOrigin,
  importVideo = createImporter(),
} = {}) {
  if (typeof password !== 'string' || password.length < 16) {
    throw new Error('设置至少 16 字符的 HOST_PASSWORD。');
  }
  if (publicOrigin && (new URL(publicOrigin).protocol !== 'https:' ||
      new URL(publicOrigin).origin !== publicOrigin)) {
    throw new Error('PUBLIC_ORIGIN 必须是 HTTPS 源地址，且无结尾斜杠。');
  }
  const sessions = hostSession(password);
  const rooms = openRooms(dataDir, importVideo);
  let origin = publicOrigin;

  async function route(req, res) {
    const path = new URL(req.url, 'http://localhost').pathname;
    const method = req.method;
    if (method === 'POST' && req.headers.origin !== origin) {
      throw new HttpError(403, '请从本应用网页提交。');
    }
    if (path === '/api/session' && method === 'POST') {
      const body = await readJson(req);
      res.setHeader('Set-Cookie', sessions.login(body?.password, Boolean(publicOrigin)));
      return send(res, 204);
    }

    if (path.startsWith('/api/') || path.startsWith('/media/')) {
      if (!sessions.verify(req)) throw new HttpError(401, '请先以房主身份登录。');
      if (path === '/api/session' && method === 'GET') return send(res, 204);
      if (path === '/api/rooms' && method === 'POST') {
        const body = await readJson(req);
        const { created, room } = rooms.submit(parseSource(body?.url));
        return send(res, created ? 201 : 200, room);
      }
      const match = roomRoute.exec(path);
      if (match && ((method === 'GET' && !match[2]) || (method === 'POST' && match[2]))) {
        const body = match[2] ? await readJson(req) : null;
        if (match[2] && (!Number.isSafeInteger(body?.attempt) || body.attempt < 1)) {
          throw new HttpError(400, '缺少导入次数。请刷新房间后重试。');
        }
        const room = match[2] ? rooms.retry(match[1], body.attempt) : rooms.get(match[1]);
        if (!room) throw new HttpError(404, '找不到房间。');
        return send(res, 200, room);
      }
      const media = mediaRoute.exec(path);
      if (media && ['GET', 'HEAD'].includes(method)) {
        const room = rooms.get(media[1]);
        if (room?.status !== 'ready') throw new HttpError(404, '视频还不可用。');
        return serveMedia(req, res, rooms.mediaPath(room.id));
      }
    }

    const asset = path === '/' || pageRoute.test(path) ? '/index.html' : path;
    if (method === 'GET' && Object.hasOwn(assets, asset)) {
      const file = await readFile(new URL('../public' + asset, import.meta.url));
      res.writeHead(200, { 'Content-Type': assets[asset] }).end(file);
      return;
    }
    throw new HttpError(404, '找不到这个页面。');
  }

  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    route(req, res).catch(error => {
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      if (error instanceof ImportError) return send(res, 400, { error: error.toJSON() });
      if (error instanceof HttpError) return send(res, error.status, { error: { message: error.message } });
      console.error('请求处理失败。');
      send(res, 500, { error: { message: '服务暂时不可用，请稍后再试。' } });
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) {
    await rooms.close();
    throw error;
  }
  origin ??= 'http://127.0.0.1:' + server.address().port;
  return {
    origin,
    async close() {
      await new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
      });
      await rooms.close();
    },
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const app = await startServer({
    dataDir: process.env.DATA_DIR,
    password: process.env.HOST_PASSWORD,
    port: Number(process.env.PORT ?? 3000),
    publicOrigin: process.env.PUBLIC_ORIGIN,
    importVideo: createImporter({ ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH }),
  });
  console.log('房主入口已启动。');
  function shutdown() {
    app.close().catch(() => { process.exitCode = 1; });
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

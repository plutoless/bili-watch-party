import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createImporter, ImportError, parseSource } from './importer.js';
import { createPlayback } from './playback.js';
import { openRooms } from './rooms.js';

const lifetime = 12 * 60 * 60;
const cookieName = 'watch_party_host';
const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const uuidPattern = new RegExp('^' + uuid + '$');
const isUuid = value => typeof value === 'string' && uuidPattern.test(value);
const roomRoute = new RegExp('^/api/rooms/(' + uuid + ')(?:/(retry|invitation|approve|cancel-start|join|end|playback))?$');
const pageRoute = new RegExp('^/(?:rooms|invite)/' + uuid + '$');
const mediaRoute = new RegExp('^/media/(' + uuid + ')\\.mp4$');
const assets = {
  '/index.html': 'text/html; charset=utf-8',
  '/app.js': 'text/javascript; charset=utf-8',
  '/player.js': 'text/javascript; charset=utf-8',
  '/style.css': 'text/css; charset=utf-8',
  '/xgplayer.js': 'text/javascript; charset=utf-8',
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

function getCookie(req, name) {
  return req.headers.cookie?.split(';').map(value => value.trim())
    .find(value => value.startsWith(name + '='))?.slice(name.length + 1);
}

function sessionCookie(name, token, secure) {
  return name + '=' + token + '; Path=/; HttpOnly; SameSite=Strict' + (secure ? '; Secure' : '');
}

function validateHttpsOrigin(value, name) {
  const origin = URL.parse(value);
  if (origin?.protocol !== 'https:' || origin.origin !== value) {
    throw new Error(name + ' 必须是 HTTPS 源地址，且无结尾斜杠。');
  }
}

function hostSession(password) {
  const secret = randomBytes(32);
  const digest = value => createHash('sha256').update(value).digest();
  const passwordHash = digest(password);
  const sign = payload => createHmac('sha256', secret).update(payload).digest('base64url');
  const failures = new Map();
  let resetAt = 0;
  return {
    login(input, secure, client) {
      if (Date.now() >= resetAt) {
        failures.clear();
        resetAt = Date.now() + 60_000;
      }
      const count = failures.get(client) ?? 0;
      if (count >= 10) throw new HttpError(429, '尝试次数过多，请等一分钟。');
      if (typeof input !== 'string' || !timingSafeEqual(passwordHash, digest(input))) {
        if (failures.size >= 10_000 && !failures.has(client)) {
          failures.delete(failures.keys().next().value);
        }
        failures.set(client, count + 1);
        throw new HttpError(401, '房主密码不正确。');
      }
      failures.delete(client);
      const payload = Math.floor(Date.now() / 1000 + lifetime) + '.' + randomBytes(16).toString('hex');
      return sessionCookie(cookieName, payload + '.' + sign(payload), secure) + '; Max-Age=' + lifetime;
    },
    verify(req) {
      const cookie = getCookie(req, cookieName);
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
    if (res.destroyed) return;
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
  now = Date.now,
  retentionMs = 24 * 60 * 60_000,
  publicOrigin,
  webOrigin,
  releaseSha,
  importVideo = createImporter(),
} = {}) {
  if (typeof password !== 'string' || password.length < 16) {
    throw new Error('设置至少 16 字符的 HOST_PASSWORD。');
  }
  if (publicOrigin) validateHttpsOrigin(publicOrigin, 'PUBLIC_ORIGIN');
  if (webOrigin) {
    validateHttpsOrigin(webOrigin, 'WEB_ORIGIN');
    if (!publicOrigin || webOrigin === publicOrigin) {
      throw new Error('拆分部署需要不同的 WEB_ORIGIN 和 PUBLIC_ORIGIN。');
    }
  }
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 1) {
    throw new Error('房间保留期限必须是正数。');
  }
  const secure = Boolean(publicOrigin);
  const sessions = hostSession(password);
  const rooms = openRooms(dataDir, importVideo, { now, retentionMs });
  const { admission } = rooms;
  const mediaResponses = new Map();
  const playback = new Map();
  const playbackNow = now === Date.now ? () => performance.now() : now;
  let origin = publicOrigin;

  function requireHost(req) {
    if (!sessions.verify(req)) throw new HttpError(401, '请先以房主身份登录。');
  }

  const visitorCookieName = id => 'watch_party_visitor_' + id;
  const visitorToken = (req, id) => getCookie(req, visitorCookieName(id));
  const roomView = room => ({ ...room, firstStartPending: playback.get(room.id)?.firstStartPending ?? false });

  function roomTimeline(id) {
    if (!playback.has(id)) playback.set(id, createPlayback());
    return playback.get(id);
  }

  async function roomPlayback(req, res, id) {
    const body = await readJson(req);
    const { role, action, playerId, previousPlayerId, fallbackPlayerIds = [], recoveryId, recoveryGeneration,
      position, reason, seekId, afterSeekId, waitForReadiness } = body ?? {};
    if (role === 'host') requireHost(req);
    else if (role !== 'visitor' || !admission.isApproved(id, visitorToken(req, id))) {
      throw new HttpError(401, '仅房主和已批准的访客可读取播放状态。');
    }
    const hostCommand = ['play', 'pause', 'seek'].includes(action);
    const hasRecoveryGeneration = recoveryId !== undefined || recoveryGeneration !== undefined;
    const invalidRecovery = (hasRecoveryGeneration && (!isUuid(recoveryId) ||
      !Number.isSafeInteger(recoveryGeneration) || recoveryGeneration < 1)) ||
      ((!hasRecoveryGeneration || previousPlayerId !== undefined) && !isUuid(previousPlayerId)) ||
      !Array.isArray(fallbackPlayerIds) || !fallbackPlayerIds.every(isUuid);
    if ((!hostCommand && !['observe', 'ready', 'blocked', 'unavailable', 'recover'].includes(action)) ||
        !isUuid(playerId) ||
        (action === 'recover' && invalidRecovery) ||
        (['ready', 'blocked', 'play'].includes(action) && recoveryId !== undefined &&
          (body.claim !== true || !isUuid(recoveryId))) ||
        [seekId, afterSeekId].some(value => value !== undefined && !isUuid(value)) ||
        (action === 'unavailable' && !['buffering', 'connection', 'background'].includes(reason)) ||
        (['ready', 'seek'].includes(action) && !Number.isFinite(position))) {
      throw new HttpError(400, '播放操作无效。');
    }
    if (role !== 'host' && hostCommand) {
      throw new HttpError(403, '只有房主可以控制共享播放。');
    }
    if (rooms.isEnded(id)) throw new HttpError(410, '房间已结束。');
    const room = rooms.get(id);
    if (room?.status !== 'ready') throw new HttpError(404, '视频还不可用。');
    if (action === 'play' && waitForReadiness === true && !admission.hasApprovedVisitor(id)) {
      throw new HttpError(409, '请先批准访客。');
    }
    const timeline = roomTimeline(id);
    timeline.setDuration(room.duration);
    const { conflict, state } = timeline.update(body, playbackNow());
    return send(res, conflict ? 409 : 200, state);
  }

  async function joinRoom(req, res, id) {
    const body = req.method === 'POST' ? await readJson(req) : null;
    const name = visitorCookieName(id);
    const token = visitorToken(req, id);
    let result;
    const room = rooms.get(id);
    if (!room) result = { state: rooms.isEnded(id) ? 'ended' : 'expired' };
    else if (req.method === 'POST') result = admission.request(id, body?.token, token);
    else result = admission.state(id, token);

    const { visitorToken: newToken, ...status } = result;
    if (newToken) res.setHeader('Set-Cookie', sessionCookie(name, newToken, secure));
    else if (token && ['expired', 'ended'].includes(status.state)) {
      res.setHeader('Set-Cookie', sessionCookie(name, '', secure) + '; Max-Age=0');
    }
    if (status.state === 'approved') status.room = roomView(room);
    return send(res, 200, status);
  }

  async function hostRoom(req, res, id, action) {
    requireHost(req);
    const body = action ? await readJson(req) : null;
    if (rooms.isEnded(id)) return send(res, 200, { status: 'ended' });
    let room = rooms.get(id);
    if (!room) throw new HttpError(404, '找不到房间。');

    switch (action) {
      case 'retry':
        if (!Number.isSafeInteger(body?.attempt) || body.attempt < 1) {
          throw new HttpError(400, '缺少导入次数。请刷新房间后重试。');
        }
        room = rooms.retry(id, body.attempt);
        break;
      case 'invitation':
        if (!['generate', 'revoke'].includes(body?.action)) throw new HttpError(400, '请选择邀请操作。');
        admission.changeInvitation(id, body.action);
        break;
      case 'approve': {
        const approval = isUuid(body?.requestId) && admission.approve(id, body.requestId);
        if (!approval) {
          throw new HttpError(409, '申请已失效，或唯一访客席位已被占用。');
        }
        if (approval === 'approved' && body.startPlayback === true) roomTimeline(id).startOnApproval();
        break;
      }
      case 'cancel-start':
        if (!isUuid(body?.playerId)) throw new HttpError(400, '播放操作无效。');
        if (playback.get(id)?.cancelFirstStart(body.playerId, playbackNow()) === false) {
          throw new HttpError(409, '这个席位已由另一个页面使用。');
        }
        break;
      case 'end':
        rooms.end(id);
        playback.delete(id);
        for (const response of mediaResponses.get(id) ?? []) response.destroy();
        return send(res, 200, { status: 'ended' });
    }
    return send(res, 200, { ...roomView(room), ...admission.hostView(id) });
  }

  async function roomMedia(req, res, id) {
    if (!sessions.verify(req) && !admission.isApproved(id, visitorToken(req, id))) {
      throw new HttpError(401, '仅房主和已批准的访客可读取视频。');
    }
    if (rooms.isEnded(id)) throw new HttpError(410, '房间已结束。');
    if (rooms.get(id)?.status !== 'ready') throw new HttpError(404, '视频还不可用。');
    let responses = mediaResponses.get(id);
    if (!responses) mediaResponses.set(id, responses = new Set());
    responses.add(res);
    try {
      await serveMedia(req, res, rooms.mediaPath(id));
    } finally {
      responses.delete(res);
      if (!responses.size) mediaResponses.delete(id);
    }
  }

  async function route(req, res) {
    const path = new URL(req.url, 'http://localhost').pathname;
    const method = req.method;
    const requestOrigin = req.headers.origin;
    if (webOrigin && (path.startsWith('/api/') || path.startsWith('/media/'))) {
      res.setHeader('Vary', 'Origin');
      if (requestOrigin !== undefined && requestOrigin !== webOrigin) {
        throw new HttpError(403, '请从本应用网页访问。');
      }
      if (requestOrigin === webOrigin) {
        res.setHeader('Access-Control-Allow-Origin', webOrigin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Range');
        if (method === 'OPTIONS') {
          res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
          return send(res, 204);
        }
      }
    }
    if (method === 'POST' && requestOrigin !== (webOrigin || origin)) {
      throw new HttpError(403, '请从本应用网页提交。');
    }
    if (path === '/api/release' && method === 'GET' && releaseSha) {
      return send(res, 200, { sha: releaseSha });
    }
    if (path === '/api/session' && method === 'POST') {
      const body = await readJson(req);
      // The application binds exclusively to loopback. Its HTTPS proxy must overwrite this header.
      const forwarded = req.headers['x-forwarded-for'];
      const client = secure && typeof forwarded === 'string' && isIP(forwarded)
        ? forwarded : req.socket.remoteAddress;
      res.setHeader('Set-Cookie', sessions.login(body?.password, secure, client));
      return send(res, 204);
    }

    const match = roomRoute.exec(path);
    if (match) {
      const [, id, action] = match;
      if (action === 'join' && ['GET', 'POST'].includes(method)) return joinRoom(req, res, id);
      if (action === 'playback' && method === 'POST') return roomPlayback(req, res, id);
      if (method === (action ? 'POST' : 'GET')) return hostRoom(req, res, id, action);
    }
    const media = mediaRoute.exec(path);
    if (media && ['GET', 'HEAD'].includes(method)) return roomMedia(req, res, media[1]);
    if (path.startsWith('/api/') || path.startsWith('/media/')) {
      requireHost(req);
      if (path === '/api/session' && method === 'GET') return send(res, 204);
      if (path === '/api/rooms' && method === 'POST') {
        const body = await readJson(req);
        const { created, room } = rooms.submit(parseSource(body?.url));
        return send(res, created ? 201 : 200, { ...roomView(room), ...admission.hostView(room.id) });
      }
    }

    const asset = path === '/' || pageRoute.test(path) ? '/index.html' : path;
    if (method === 'GET' && Object.hasOwn(assets, asset)) {
      const source = asset === '/xgplayer.js' ? import.meta.resolve('xgplayer') : '../public' + asset;
      const file = await readFile(new URL(source, import.meta.url));
      res.writeHead(200, { 'Content-Type': assets[asset] }).end(file);
      return;
    }
    throw new HttpError(404, '找不到这个页面。');
  }

  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Permissions-Policy', 'microphone=()');
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
  const localOrigin = 'http://127.0.0.1:' + server.address().port;
  origin ??= localOrigin;
  return {
    origin,
    localOrigin,
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
    retentionMs: Number(process.env.ENDED_ROOM_RETENTION_HOURS ?? 24) * 60 * 60_000,
    port: Number(process.env.PORT ?? 3000),
    publicOrigin: process.env.PUBLIC_ORIGIN,
    webOrigin: process.env.WEB_ORIGIN,
    releaseSha: process.env.RELEASE_SHA,
    importVideo: createImporter({ ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH }),
  });
  console.log('房主入口已启动。');
  function shutdown() {
    app.close().catch(() => { process.exitCode = 1; });
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

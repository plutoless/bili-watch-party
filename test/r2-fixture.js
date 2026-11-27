import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';

const bucket = 'synthetic-media';
const credentials = {
  accessKeyId: 'synthetic-access-key',
  secretAccessKey: 'synthetic-secret-access-key',
};

export async function startR2Fixture({ tls } = {}) {
  const objects = new Map();
  const uploadHeld = Promise.withResolvers();
  const release = Promise.withResolvers();
  const fixture = {
    objects, ranges: [], writes: 0, conflicts: 0, nextUpload: null,
    publicReadable: true, headUnavailable: false, nextHeadMissing: false,
    uploadHeld: uploadHeld.promise, releaseUpload: release.resolve,
    remove(url) { objects.delete(new URL(url).pathname); },
  };
  const privateServer = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const match = new RegExp('^/' + bucket + '(/[a-f0-9-]{36}\\.mp4)$').exec(path);
    // Check the SDK's request shape. Cloudflare verifies the actual signature in production.
    if (!match || !req.headers.authorization?.startsWith('AWS4-HMAC-SHA256 Credential=' + credentials.accessKeyId + '/') ||
        !req.headers.authorization.includes('/auto/s3/aws4_request,')) {
      return res.writeHead(403).end();
    }
    const key = match[1];
    if (req.method === 'HEAD') {
      if (fixture.headUnavailable) return res.writeHead(503).end();
      if (fixture.nextHeadMissing) {
        fixture.nextHeadMissing = false;
        return res.writeHead(404).end();
      }
      const object = objects.get(key);
      return object ? res.writeHead(200, object.headers).end() : res.writeHead(404).end();
    }
    if (req.method !== 'PUT' || req.headers['if-none-match'] !== '*' ||
        req.headers['content-type'] !== 'video/mp4' || req.headers['cache-control'] !== 'public, no-store') {
      return res.writeHead(400).end();
    }
    const mode = fixture.nextUpload;
    fixture.nextUpload = null;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (mode === 'hold') {
      uploadHeld.resolve();
      await release.promise;
      return res.destroy();
    }
    if (objects.has(key)) {
      fixture.conflicts++;
      return res.writeHead(412).end();
    }
    const body = Buffer.concat(chunks);
    if (!body.length || body.length !== Number(req.headers['content-length'])) return res.writeHead(400).end();
    objects.set(key, {
      body,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': body.length,
        'Cache-Control': req.headers['cache-control'],
        'Accept-Ranges': 'bytes',
      },
    });
    fixture.writes++;
    if (mode === 'dropResponse') return res.destroy();
    return res.writeHead(200).end();
  });
  const servePublic = (req, res) => {
    if (req.headers.cookie || req.headers.authorization) return res.writeHead(403).end();
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.headers.origin) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Range');
    if (!fixture.publicReadable) return res.writeHead(503).end();
    const object = objects.get(path);
    if (!object) return res.writeHead(404, { 'Cache-Control': 'no-store' }).end();
    const { body, headers } = object;
    if (req.method === 'HEAD') return res.writeHead(200, headers).end();
    if (req.method !== 'GET') return res.writeHead(405).end();
    if (!req.headers.range) return res.writeHead(200, headers).end(body);
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!range || (!range[1] && !range[2])) return res.writeHead(416).end();
    const start = range[1] ? Number(range[1]) : Math.max(0, body.length - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    if (start > end) return res.writeHead(416).end();
    fixture.ranges.push({ path, origin: req.headers.origin, userAgent: req.headers['user-agent'], start, end });
    return res.writeHead(206, {
      ...headers, 'Content-Length': end - start + 1, 'Content-Range': 'bytes ' + start + '-' + end + '/' + body.length,
    }).end(body.subarray(start, end + 1));
  };
  const publicServer = tls ? createHttpsServer(tls, servePublic) : createServer(servePublic);
  const servers = [privateServer, publicServer];
  const close = async () => {
    release.resolve();
    await Promise.all(servers.map(server => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    })));
  };
  try {
    await Promise.all(servers.map(server => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    })));
    const endpoint = 'http://127.0.0.1:' + privateServer.address().port;
    const publicOrigin = (tls ? 'https://localhost:' : 'http://127.0.0.1:') + publicServer.address().port;
    return Object.assign(fixture, { options: { endpoint, bucket, credentials, publicOrigin }, close });
  } catch (error) {
    await close();
    throw error;
  }
}

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const cacheControl = 'public, no-store';

export function configuredR2Media(env, webOrigin) {
  const {
    R2_ACCOUNT_ID: account, R2_BUCKET: bucket, R2_ACCESS_KEY_ID: accessKeyId,
    R2_SECRET_ACCESS_KEY: secretAccessKey, MEDIA_ORIGIN: publicOrigin,
  } = env;
  if (![account, bucket, accessKeyId, secretAccessKey, publicOrigin].some(Boolean)) return;
  const origin = URL.parse(publicOrigin ?? '');
  if (!/^[0-9a-f]{32}$/.test(account ?? '') ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket ?? '') ||
      !accessKeyId || !secretAccessKey || !webOrigin || origin?.protocol !== 'https:' ||
      origin.origin !== publicOrigin || !/^[a-z0-9.-]+$/.test(origin.hostname) ||
      [env.PUBLIC_ORIGIN, webOrigin].includes(publicOrigin)) {
    throw new Error('R2 配置无效。请配置专用桶、写入凭据及独立的 HTTPS MEDIA_ORIGIN。');
  }
  return createR2Media({
    endpoint: 'https://' + account + '.r2.cloudflarestorage.com', bucket,
    credentials: { accessKeyId, secretAccessKey }, publicOrigin, webOrigin,
  });
}

export function createR2Media({ endpoint, bucket, credentials, publicOrigin, webOrigin }) {
  const client = new S3Client({
    endpoint, credentials, region: 'auto', forcePathStyle: true, maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED',
  });
  const url = key => publicOrigin + '/' + key + '.mp4';
  const object = key => ({ Bucket: bucket, Key: key + '.mp4' });

  async function head(key, signal) {
    const timeout = AbortSignal.timeout(5000);
    try {
      return await client.send(new HeadObjectCommand(object(key)), {
        abortSignal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (error.$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  }

  return {
    origin: publicOrigin,
    url,
    async exists(key) {
      return (await head(key)) !== null;
    },
    async publish(key, path, signal) {
      const { size } = await stat(path);
      let existing = await head(key, signal);
      if (!existing) {
        const body = createReadStream(path);
        try {
          await client.send(new PutObjectCommand({
            ...object(key), Body: body, ContentLength: size, ContentType: 'video/mp4',
            CacheControl: cacheControl, IfNoneMatch: '*',
          }), { abortSignal: AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]) });
        } catch (error) {
          if (error.$metadata?.httpStatusCode !== 412) throw error;
          // A previous upload can commit after this attempt's HEAD.
          existing = await head(key, signal);
          if (!existing) throw error;
        } finally {
          body.destroy();
        }
      }
      if (existing && (existing.ContentLength !== size || existing.ContentType !== 'video/mp4')) {
        throw new Error('成品对象与待上传文件不匹配。');
      }

      const response = await fetch(url(key), {
        headers: { Range: 'bytes=0-0', ...(webOrigin ? { Origin: webOrigin } : {}) },
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      });
      try {
        const cors = response.headers.get('access-control-allow-origin');
        if (response.status !== 206 || response.headers.get('content-range') !== 'bytes 0-0/' + size ||
            response.headers.get('content-length') !== '1' ||
            response.headers.get('content-type') !== 'video/mp4' ||
            (webOrigin && cors !== webOrigin && cors !== '*')) {
          throw new Error('成品无法从公开媒体域读取。');
        }
        if ((await response.arrayBuffer()).byteLength !== 1) throw new Error('成品读取不完整。');
      } finally {
        if (!response.bodyUsed) await response.body?.cancel();
      }
    },
  };
}

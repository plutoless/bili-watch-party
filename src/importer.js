import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const bilibiliApi = 'https://api.bilibili.com';
const sourceHosts = new Set(['www.bilibili.com', 'm.bilibili.com', 'bilibili.com']);
const cdnDomain = /(?:^|\.)(?:bilivideo\.com|bilivideo\.cn)$/;
const akamaiCdnHost = 'upos-hz-mirrorakam.akamaized.net';
const trackLimit = 512 * 1024 * 1024;
const accessStatuses = new Set([401, 403, 404, 410, 451]);

const failures = {
  invalid: ['请输入 B 站投稿视频链接，例如 https://www.bilibili.com/video/BV1TDyazeEuY。', false],
  part: ['该视频没有这个分 P，请在 B 站确认分 P 后重新提交。', false],
  access: ['B 站未开放此视频的公开访问。请在未登录的浏览器中确认可看正片，或换一条公开链接。', true],
  format: ['该视频未提供完整、兼容的音画。请选择能公开播放的普通投稿。', false],
  limit: ['视频超出导入大小上限。请换一个较短的视频。', false],
  network: ['暂时无法从 B 站获取视频。请稍后在此房间重试。', true],
  processing: ['视频准备失败。请检查服务端 FFmpeg、FFprobe 和磁盘空间，然后重试。', true],
  interrupted: ['导入因服务重启而中断。请在此房间重试。', true],
};

export class ImportError extends Error {
  constructor(code) {
    const [message, retryable] = failures[code];
    super(message);
    this.code = code;
    this.retryable = retryable;
  }

  toJSON() {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

export function parseSource(input) {
  if (typeof input !== 'string' || input.length > 2048) throw new ImportError('invalid');
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ImportError('invalid');
  }
  const video = /^\/video\/(BV[0-9A-Za-z]{10})\/?$/.exec(url.pathname);
  const parts = url.searchParams.getAll('p');
  const part = Number(parts[0] ?? 1);
  if (!['https:', 'http:'].includes(url.protocol) || !sourceHosts.has(url.hostname) ||
      url.port || url.username || url.password || !video || parts.length > 1 ||
      (parts.length === 1 && !/^[0-9]+$/.test(parts[0])) ||
      !Number.isSafeInteger(part) || part < 1) {
    throw new ImportError('invalid');
  }
  return { bvid: video[1], part };
}

function videoUrl({ bvid, part }) {
  return 'https://www.bilibili.com/video/' + bvid + '?p=' + part;
}

function cdnUrl(input) {
  if (typeof input !== 'string' || !URL.canParse(input)) return null;
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      !(cdnDomain.test(url.hostname) || url.hostname === akamaiCdnHost)) return null;
  return url;
}

function completeRangeSize(range) {
  const fields = /^bytes 0-(\d+)\/([1-9]\d*)$/.exec(range ?? '');
  if (!fields) return null;
  const size = Number(fields[2]);
  return Number.isSafeInteger(size) && Number(fields[1]) === size - 1 ? size : null;
}

export function createImporter({ fetch: request = fetch, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe' } = {}) {
  async function upstream(url, options, signal, timeout) {
    try {
      return await request(url, {
        ...options,
        redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
      });
    } catch {
      throw new ImportError('network');
    }
  }

  async function api(path, params, referer, signal) {
    const url = new URL(path, bilibiliApi);
    url.search = new URLSearchParams(params).toString();
    const response = await upstream(url, { headers: { Referer: referer } }, signal, 20_000);
    if (!response.ok) {
      await response.body?.cancel();
      if (accessStatuses.has(response.status)) throw new ImportError('access');
      throw new ImportError('network');
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new ImportError('network');
    }
    if (result?.code === 0 && result.data) return result.data;
    if ([-101, -403, -404, 62002, 62004, 10015002].includes(result?.code)) {
      throw new ImportError('access');
    }
    throw new ImportError('network');
  }

  async function download(track, destination, referer, signal) {
    const urls = new Set([track.baseUrl ?? track.base_url, ...(track.backupUrl ?? track.backup_url ?? [])]);
    const failedCandidates = new Set();
    for (const candidate of urls) {
      let url = cdnUrl(candidate);
      if (!url) continue;
      let failure = 'network';
      for (let redirects = 0; url && redirects <= 2; redirects++) {
        if (signal.aborted) throw new ImportError('network');
        let response;
        try {
          response = await upstream(url, { headers: { Referer: referer, Range: 'bytes=0-' } }, signal, 180_000);
        } catch {
          break;
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          url = location && URL.canParse(location, url) ? cdnUrl(new URL(location, url).href) : null;
          continue;
        }
        const rangeSize = response.status === 206
          ? completeRangeSize(response.headers.get('content-range')) : null;
        if ((response.status !== 200 && rangeSize === null) || !response.body) {
          await response.body?.cancel();
          if (accessStatuses.has(response.status)) failure = 'access';
          break;
        }
        if (Number(response.headers.get('content-length')) > trackLimit || rangeSize > trackLimit) {
          await response.body.cancel();
          throw new ImportError('limit');
        }
        let size = 0;
        const limit = new Transform({
          transform(chunk, encoding, callback) {
            size += chunk.length;
            if (size > trackLimit) callback(new ImportError('limit'));
            else callback(null, chunk);
          },
        });
        try {
          await pipeline(response.body, limit, createWriteStream(destination, { mode: 0o600 }), { signal });
          if (size > 0 && (rangeSize === null || size === rangeSize)) return;
        } catch (error) {
          if (error instanceof ImportError) throw error;
          if (['ENOSPC', 'EACCES', 'EROFS'].includes(error.code)) throw new ImportError('processing');
        }
        await rm(destination, { force: true });
        break;
      }
      failedCandidates.add(failure);
    }
    const allDenied = failedCandidates.size === 1 && failedCandidates.has('access');
    throw new ImportError(allDenied ? 'access' : 'network');
  }

  return async function importVideo({ source, workDir, output, update, signal }) {
    const referer = videoUrl(source);
    const info = await api('/x/web-interface/view', { bvid: source.bvid }, referer, signal);
    const page = info.pages?.find(item => item.page === source.part);
    if (!page?.cid) throw new ImportError('part');
    const duration = Number(page.duration);
    update({ title: info.title, partTitle: info.pages.length > 1 ? page.part : null });
    if (info.rights?.pay || info.rights?.arc_pay || info.rights?.is_stein_gate) {
      throw new ImportError(info.rights.is_stein_gate ? 'format' : 'access');
    }
    const playback = await api('/x/player/playurl', {
      bvid: source.bvid, cid: page.cid, qn: 32, fnver: 0, fnval: 16, fourk: 0,
    }, referer, signal);
    if (playback.is_preview || playback.dash?.duration < duration - 2 ||
        playback.timelength / 1000 < duration - 2) throw new ImportError('access');
    const video = playback.dash?.video
      ?.filter(track => track.codecs?.startsWith('avc1.') && track.id <= 32)
      .sort((a, b) => b.id - a.id)[0];
    const audio = playback.dash?.audio
      ?.filter(track => track.codecs === 'mp4a.40.2')
      .sort((a, b) => b.bandwidth - a.bandwidth)[0];
    if (!video || !audio || !(duration > 0)) throw new ImportError('format');

    const videoFile = join(workDir, 'video.m4s');
    const audioFile = join(workDir, 'audio.m4s');
    await download(video, videoFile, referer, signal);
    await download(audio, audioFile, referer, signal);
    update({ status: 'preparing' });
    try {
      await run(ffmpeg, [
        '-nostdin', '-v', 'error', '-protocol_whitelist', 'file', '-f', 'mov', '-i', videoFile,
        '-protocol_whitelist', 'file', '-f', 'mov', '-i', audioFile,
        '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart', output,
      ], { signal, timeout: 120_000 });
      const { stdout } = await run(ffprobe, [
        '-v', 'error', '-protocol_whitelist', 'file',
        '-show_entries', 'stream=codec_name,codec_type,duration:format=duration', '-of', 'json', output,
      ], { signal, timeout: 30_000 });
      const media = JSON.parse(stdout);
      const types = [['video', 'h264'], ['audio', 'aac']];
      for (const [type, codec] of types) {
        const stream = media.streams?.find(item => item.codec_type === type && item.codec_name === codec);
        const seconds = Number(stream?.duration);
        if (!(seconds > 0) || seconds < duration - 2) throw new ImportError('format');
      }
      return Number(media.format.duration);
    } catch (error) {
      if (error instanceof ImportError) throw error;
      throw new ImportError('processing');
    }
  };
}

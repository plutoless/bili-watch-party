import { setTimeout as delay } from 'node:timers/promises';
import { playbackFailure } from './browser-failure.js';

const pausedText = '已暂停，等待房主播放。';
const statusLabels = [
  [pausedText, 'paused'],
  ['等待双方就绪。', 'waiting-ready'],
  ['等待点按以允许播放。', 'waiting-gesture'],
  ['正在连接播放状态…', 'connecting'],
  ['连接中断，等待播放状态。', 'disconnected'],
  ['缓冲中，等待双方在同一位置就绪。', 'buffering'],
  ['等待双方回到观影页面。', 'background'],
  ['等待重新连接并对齐进度。', 'recovering'],
  ['即将同时播放…', 'starting'],
  ['正在同步播放', 'playing'],
  ['正在对齐进度，等待双方就绪。', 'aligning'],
  ['播放结束。请选择重播或结束房间。', 'ended'],
  ['播放结束，等待房主决定。', 'ended'],
];

function observeTimeline(page, endpoint) {
  const observed = {};
  const listener = response => {
    if (response.url() !== endpoint || response.request().method() !== 'POST'
        || ![200, 409].includes(response.status())) return;
    observed.first ??= response;
    observed.latest = response;
  };
  page.on('response', listener);
  return { observed, stop: () => page.off('response', listener) };
}

async function recordFailure(error, stage, role, page, { first, latest }) {
  const flags = { timelineReceived: Boolean(latest) };
  const pause = { displayedStatus: 'unavailable' };
  // Diagnostics run only after the original assertion fails. Keep partial
  // observations if a page has closed or a playback response body is late.
  const collect = (read, save) => Promise.resolve().then(read).then(save, () => {});
  const pending = [
    collect(() => page.evaluate(labels => {
      const status = document.querySelector('#playback-status');
      const video = document.querySelector('#video');
      const displayedStatus = status
        ? labels.find(([text]) => text === status.textContent?.trim())?.[1] ?? 'other'
        : 'missing';
      return { displayedStatus, paused: video?.paused, seeking: video?.seeking };
    }, statusLabels), state => {
      pause.displayedStatus = state.displayedStatus;
      flags.paused = state.paused;
      flags.seeking = state.seeking;
    }),
    collect(() => page.locator('#playback-status').isVisible(), visible => { flags.statusVisible = visible; }),
  ];
  if (latest) {
    const latestState = Promise.resolve().then(() => latest.json());
    pending.push(collect(() => latestState, state => {
      pause.timelineVersion = state?.version;
      flags.wantsPlay = state?.wantsPlay;
      if (state?.startsAt === null || Number.isFinite(state?.startsAt)) {
        flags.startScheduled = state.startsAt !== null;
      }
      flags.hostReady = state?.ready?.host;
      flags.guestReady = state?.ready?.visitor;
    }));
    pending.push(collect(() => first === latest ? latestState : first.json(), state => {
      pause.firstVersion = state?.version;
    }));
  }

  const deadline = new AbortController();
  try {
    await Promise.race([
      Promise.allSettled(pending),
      delay(750, undefined, { signal: deadline.signal }),
    ]);
    playbackFailure(error, stage, role, flags, pause);
  } finally {
    deadline.abort();
  }
}

export async function waitForPausedStatus(hostPage, visitorPage, endpoint, stage) {
  const sides = [['host', hostPage], ['guest', visitorPage]].map(([role, page]) =>
    ({ role, page, ...observeTimeline(page, endpoint) }));
  let failure;
  try {
    return await Promise.all(sides.map(({ role, page, observed }) =>
      page.getByText(pausedText).waitFor().catch(error => {
        failure ??= { role, page, observed: { ...observed } };
        throw error;
      })));
  } catch (error) {
    if (failure) await recordFailure(error, stage, failure.role, failure.page, failure.observed);
    throw error;
  } finally {
    for (const side of sides) side.stop();
  }
}

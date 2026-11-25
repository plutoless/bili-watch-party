import { AssertionError } from 'node:assert';

const phases = new Set([
  'configuration', 'fixture setup', 'browser launch', 'room admission',
  'media access', 'shared playback', 'public lifecycle', 'room revocation', 'cleanup',
]);
const transportCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE']);
const wrappedTransport = /\b(?:read|connect|write|getaddrinfo) (ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE)\b/;

const playbackFailures = new WeakMap();
const pauseStages = new Set([
  'pause-after-gesture-retry', 'pause-after-cancel-delayed-guest-play',
  'pause-after-obsolete-guest-rejection', 'pause-after-cancel-blocked-host-reprepare',
  'pause-after-delayed-start', 'pause-after-buffer-release', 'pause-after-repeated-seeks',
  'pause-after-offline-refresh',
]);
const pauseStatuses = new Set([
  'paused', 'waiting-ready', 'waiting-gesture', 'connecting', 'disconnected', 'buffering',
  'background', 'recovering', 'starting', 'playing', 'aligning', 'ended', 'other', 'missing', 'unavailable',
]);
const playbackStages = new Set([
  ...pauseStages,
  'initial-start', 'initial-stability', 'public-drift', 'protected-drift', 'fullscreen', 'fullscreen-resume',
  'shared-seek', 'shared-pause', 'paused-seek', 'gesture-hold', 'gesture-retry', 'blocked-start', 'delayed-start',
  'protected-recovery', 'buffer-recovery', 'network-recovery', 'foreground-recovery', 'refresh-recovery',
  'recovery-stability', 'playback-end', 'playback-replay',
  'r2-pre-disconnect', 'r2-disconnected', 'r2-post-reconnect', 'r2-pause',
]);
const playbackRoles = new Set(['host', 'guest', 'both']);
const playbackFlags = ['paused', 'seeking', 'advanced', 'decoded', 'muted', 'bracketed', 'withinGap',
  'withinBudget', 'aligned', 'controlEnabled', 'retryVisible', 'neutralRate', 'ready',
  'statusVisible', 'timelineReceived', 'wantsPlay', 'startScheduled', 'hostReady', 'guestReady'];

export function playbackFailure(error, stage, role, flags = {}, pause = {}) {
  if (error instanceof Error && !playbackFailures.has(error) && playbackStages.has(stage) && playbackRoles.has(role)) {
    const details = playbackFlags.filter(flag => typeof flags[flag] === 'boolean')
      .map(flag => flag + '=' + flags[flag]);
    if (pauseStages.has(stage)) {
      details.push('expectedStatus=paused');
      if (pauseStatuses.has(pause.displayedStatus)) details.push('displayedStatus=' + pause.displayedStatus);
      for (const field of ['firstVersion', 'timelineVersion']) {
        if (Number.isSafeInteger(pause[field]) && pause[field] >= 0) details.push(field + '=' + pause[field]);
      }
    }
    playbackFailures.set(error, ['stage=' + stage, 'role=' + role, ...details].join(' '));
  }
  return error;
}

export function formatBrowserFailure(error, phase) {
  const stage = phases.has(phase) ? phase : 'unknown';
  let kind = 'unexpected error';
  if (error instanceof AssertionError) {
    kind = 'assertion failed';
  } else if (error?.name === 'TimeoutError') {
    kind = 'timeout';
  } else {
    const message = typeof error?.message === 'string' ? error.message : '';
    const code = [error?.code, error?.cause?.code, wrappedTransport.exec(message)?.[1]]
      .find(value => transportCodes.has(value));
    if (code) kind = 'transport error (' + code + ')';
  }
  const playback = playbackFailures.get(error);
  return stage + ' | ' + kind + (playback ? ' | ' + playback : '');
}

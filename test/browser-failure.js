import { AssertionError } from 'node:assert';

const phases = new Set([
  'configuration', 'fixture setup', 'browser launch', 'room admission',
  'media access', 'shared playback', 'public lifecycle', 'room revocation', 'cleanup',
]);
const transportCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE']);
const wrappedTransport = /\b(?:read|connect|write|getaddrinfo) (ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE)\b/;

const playbackFailures = new WeakMap();
const playbackStages = new Set([
  'initial-start', 'initial-stability', 'public-drift', 'protected-drift', 'fullscreen', 'fullscreen-resume',
  'shared-seek', 'shared-pause', 'paused-seek', 'gesture-hold', 'gesture-retry', 'blocked-start', 'delayed-start',
  'protected-recovery', 'buffer-recovery', 'network-recovery', 'foreground-recovery', 'refresh-recovery',
  'recovery-stability', 'playback-end', 'playback-replay',
  'r2-pre-disconnect', 'r2-disconnected', 'r2-post-reconnect', 'r2-pause',
]);
const playbackRoles = new Set(['host', 'guest', 'both']);
const playbackFlags = ['paused', 'seeking', 'advanced', 'decoded', 'muted', 'bracketed', 'withinGap',
  'withinBudget', 'aligned', 'controlEnabled', 'retryVisible', 'neutralRate', 'ready'];

export function playbackFailure(error, stage, role, flags = {}) {
  if (error instanceof Error && !playbackFailures.has(error) && playbackStages.has(stage) && playbackRoles.has(role)) {
    const details = playbackFlags.filter(flag => typeof flags[flag] === 'boolean')
      .map(flag => flag + '=' + flags[flag]);
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

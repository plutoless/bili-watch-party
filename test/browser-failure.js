import { AssertionError } from 'node:assert';

const phases = new Set([
  'configuration', 'fixture setup', 'browser launch', 'room admission',
  'media access', 'shared playback', 'public lifecycle', 'room revocation', 'cleanup',
]);
const transportCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE']);
const wrappedTransport = /\b(?:read|connect|write|getaddrinfo) (ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE)\b/;

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
  return stage + ' | ' + kind;
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { formatBrowserFailure } from './browser-failure.js';

const privateDetails = [
  'https://media.fixture.test/private-object.mp4?invite=synthetic-invite&session=synthetic-session',
  'Cookie: watch_party_host=synthetic-cookie',
  'Authorization: Bearer synthetic-bearer',
].join('\n');

test('browser failures retain only allowlisted diagnostic text', () => {
  const error = new Error('apiRequestContext.get: read ECONNRESET\n' + privateDetails);
  assert.equal(formatBrowserFailure(error, 'media access'), 'media access | transport error (ECONNRESET)');
  const mismatch = new assert.AssertionError({ actual: privateDetails, expected: false });
  assert.equal(formatBrowserFailure(mismatch, 'room revocation'), 'room revocation | assertion failed');
  const timeout = Object.assign(new Error(privateDetails), { name: 'TimeoutError' });
  assert.equal(formatBrowserFailure(timeout, 'shared playback'), 'shared playback | timeout');
  const unknown = Object.assign(new Error(privateDetails), { code: privateDetails, name: privateDetails });
  assert.equal(formatBrowserFailure(unknown, privateDetails), 'unknown | unexpected error');
});

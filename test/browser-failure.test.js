import assert from 'node:assert/strict';
import test from 'node:test';
import { formatBrowserFailure, playbackFailure } from './browser-failure.js';
import { checkPlaybackReconnect } from './playback-browser.js';

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

test('shared playback failures retain fixed stage and role with booleans only', () => {
  const error = new assert.AssertionError({ actual: privateDetails, expected: false });
  playbackFailure(error, 'r2-post-reconnect', 'guest', { paused: true, decoded: false,
    muted: privateDetails, detail: privateDetails });
  playbackFailure(error, 'protected-recovery', 'both');
  assert.equal(formatBrowserFailure(error, 'public lifecycle'),
    'public lifecycle | assertion failed | stage=r2-post-reconnect role=guest paused=true decoded=false');

  const unknown = new Error(privateDetails);
  playbackFailure(unknown, privateDetails, 'guest', { paused: true });
  playbackFailure(unknown, 'r2-post-reconnect', privateDetails, { paused: true });
  assert.equal(formatBrowserFailure(unknown, 'shared playback'), 'shared playback | unexpected error');
});

for (const [target, stage, failedRole] of [
  [10.25, 'r2-pre-disconnect', 'host'], [10.75, 'r2-post-reconnect', 'guest'],
]) {
  test('reconnect reports the failed advancement stage and ' + failedRole + ' predicates', async () => {
    function page(role) {
      const video = { currentTime: 10, paused: true, seeking: false, videoWidth: 640, muted: false };
      return {
        locator: () => ({ tap: async () => {}, evaluate: async (read, bound) => read(video, bound) }),
        getByText: () => ({ waitFor: async () => {} }),
        route: async () => {},
        unroute: async () => {},
        async waitForFunction(_predicate, bound) {
          if (role === failedRole && bound === target) throw new Error(privateDetails);
        },
      };
    }
    await assert.rejects(checkPlaybackReconnect(page('host'), page('guest')), error => {
      assert.equal(formatBrowserFailure(error, 'public lifecycle'),
        'public lifecycle | assertion failed | stage=' + stage + ' role=' + failedRole +
        ' paused=true seeking=false advanced=false decoded=true muted=false');
      return true;
    });
  });
}

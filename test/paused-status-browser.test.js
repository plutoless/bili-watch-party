import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { formatBrowserFailure } from './browser-failure.js';
import { waitForPausedStatus } from './paused-status-browser.js';

const playback = 'https://api.fixture.test/api/rooms/synthetic/playback';
const pausedText = '已暂停，等待房主播放。';
const secret = 'https://media.fixture.test/?session=synthetic-secret';

function fixturePage(wait, { displayed = pausedText, paused = true, seeking = false, visible = true } = {}) {
  const page = new EventEmitter();
  return Object.assign(page, {
    getByText(text) {
      assert.equal(text, pausedText);
      return { waitFor(...args) { assert.deepEqual(args, []); return wait(); } };
    },
    evaluate(read, settings) {
      const document = {
        querySelector: selector => selector === '#playback-status' ? { textContent: displayed } : { paused, seeking },
      };
      return Promise.resolve(runInNewContext('(' + read + ')(settings)', { document, settings }));
    },
    locator(selector) {
      assert.equal(selector, '#playback-status');
      return { isVisible: async () => visible };
    },
  });
}

function emitTimeline(page, version, fields = {}, { url = playback, status = 200 } = {}) {
  page.emit('response', {
    url: () => url, status: () => status, request: () => ({ method: () => 'POST' }),
    json: async () => ({ version, startsAt: null, wantsPlay: false, ready: { host: true, visitor: false }, ...fields }),
  });
}

test('a guest pause timeout reports its exact call, displayed status, media and observed timeline', async () => {
  const timeout = Object.assign(new Error(secret), { name: 'TimeoutError' });
  const host = fixturePage(async () => {});
  const guest = fixturePage(async () => {
    emitTimeline(guest, 10);
    emitTimeline(guest, 11, { roomId: secret }, { status: 409 });
    emitTimeline(guest, 20, {}, { url: 'https://foreign.fixture.test/playback' });
    throw timeout;
  }, { displayed: '等待双方就绪。', paused: true });

  await assert.rejects(waitForPausedStatus(host, guest, playback, 'pause-after-obsolete-guest-rejection'), error => {
    assert.equal(error, timeout);
    assert.equal(formatBrowserFailure(error, 'shared playback'),
      'shared playback | timeout | stage=pause-after-obsolete-guest-rejection role=guest paused=true seeking=false statusVisible=true timelineReceived=true wantsPlay=false startScheduled=false hostReady=true guestReady=false expectedStatus=paused displayedStatus=waiting-ready firstVersion=10 timelineVersion=11');
    return true;
  });
  assert.equal(host.listenerCount('response'), 0);
  assert.equal(guest.listenerCount('response'), 0);
});

test('a hidden paused status is distinct from paused media and from timeline delivery', async () => {
  const hostTimeout = Object.assign(new Error(secret), { name: 'TimeoutError' });
  const guestTimeout = Object.assign(new Error(secret), { name: 'TimeoutError' });
  const host = fixturePage(async () => { throw hostTimeout; }, { paused: false, seeking: true, visible: false });
  const guest = fixturePage(async () => { throw guestTimeout; });

  await assert.rejects(waitForPausedStatus(host, guest, playback, 'pause-after-cancel-blocked-host-reprepare'), error => {
    assert.equal(error, hostTimeout);
    assert.equal(formatBrowserFailure(error, 'shared playback'),
      'shared playback | timeout | stage=pause-after-cancel-blocked-host-reprepare role=host paused=false seeking=true statusVisible=false timelineReceived=false expectedStatus=paused displayedStatus=paused');
    return true;
  });
  assert.equal(host.listenerCount('response'), 0);
  assert.equal(guest.listenerCount('response'), 0);
});

test('successful status waits leave no listener and do not read timeline bodies or the DOM', async () => {
  const host = fixturePage(async () => {
    host.emit('response', {
      url: () => playback, status: () => 200, request: () => ({ method: () => 'POST' }), json,
    });
  });
  const guest = fixturePage(async () => {});
  const json = test.mock.fn();
  host.evaluate = test.mock.fn();
  guest.evaluate = test.mock.fn();

  await waitForPausedStatus(host, guest, playback, 'pause-after-gesture-retry');
  assert.equal(json.mock.callCount(), 0);
  assert.equal(host.evaluate.mock.callCount(), 0);
  assert.equal(guest.evaluate.mock.callCount(), 0);
  assert.equal(host.listenerCount('response'), 0);
  assert.equal(guest.listenerCount('response'), 0);
});

test('failed diagnostic reads preserve the original wait failure and omit unknown fields', async () => {
  const timeout = Object.assign(new Error(secret), { name: 'TimeoutError' });
  const host = fixturePage(async () => { throw timeout; });
  const guest = fixturePage(async () => {});
  host.evaluate = async () => { throw new Error(secret); };
  host.locator = () => { throw new Error(secret); };

  await assert.rejects(waitForPausedStatus(host, guest, playback, 'pause-after-offline-refresh'), error => {
    assert.equal(error, timeout);
    assert.equal(formatBrowserFailure(error, 'shared playback'),
      'shared playback | timeout | stage=pause-after-offline-refresh role=host timelineReceived=false expectedStatus=paused displayedStatus=unavailable');
    return true;
  });
});

test('unknown DOM text and nonnumeric response versions are excluded from diagnostics', async () => {
  const timeout = Object.assign(new Error(secret), { name: 'TimeoutError' });
  const host = fixturePage(async () => {});
  const guest = fixturePage(async () => {
    emitTimeline(guest, secret, { wantsPlay: secret, startsAt: 12_000, ready: { host: true, visitor: secret } });
    throw timeout;
  }, { displayed: secret });

  await assert.rejects(waitForPausedStatus(host, guest, playback, 'pause-after-delayed-start'), error => {
    assert.equal(formatBrowserFailure(error, 'shared playback'),
      'shared playback | timeout | stage=pause-after-delayed-start role=guest paused=true seeking=false statusVisible=true timelineReceived=true startScheduled=true hostReady=true expectedStatus=paused displayedStatus=other');
    return true;
  });
});

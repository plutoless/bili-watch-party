import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { observeNativeRanges } from './native-range-observer.js';

const apiOrigin = 'https://api.fixture.test';
const mediaUrl = apiOrigin + '/media/00000000-0000-4000-8000-000000000000.mp4';

function fixtureResponse({ url = mediaUrl, status = 206, type = 'other', method = 'GET',
  destination = 'video', range = 'bytes=0-1', contentRange = 'bytes 0-1/1200' } = {}) {
  const headers = { 'sec-fetch-dest': destination, range };
  const request = {
    method: () => method, resourceType: () => type,
    headerValue: async name => headers[name] ?? null,
  };
  return {
    url: () => url, status: () => status, request: () => request,
    headerValue: async () => contentRange,
  };
}

test('native WebKit video 206 counts even when Playwright classifies it as other', async () => {
  const page = new EventEmitter();
  const hasNativeRange = observeNativeRanges(page, apiOrigin);
  page.emit('response', fixtureResponse());
  assert.equal(await hasNativeRange(mediaUrl), true);
});

test('a classified native media response still counts when destination is unavailable', async () => {
  const page = new EventEmitter();
  const hasNativeRange = observeNativeRanges(page, apiOrigin);
  page.emit('response', fixtureResponse({ type: 'media', destination: null }));
  assert.equal(await hasNativeRange(mediaUrl), true);
});

test('scripted and ambiguous Range responses do not count as native media', async () => {
  for (const [type, destination] of [['fetch', 'empty'], ['xhr', 'video'], ['media', 'empty'],
    ['other', 'empty'], ['other', null]]) {
    const page = new EventEmitter();
    const hasNativeRange = observeNativeRanges(page, apiOrigin);
    page.emit('response', fixtureResponse({ type, destination }));
    assert.equal(await hasNativeRange(mediaUrl), false);
  }
});

test('only valid native GET 206 evidence for the authorized room media counts', async () => {
  const page = new EventEmitter();
  const hasNativeRange = observeNativeRanges(page, apiOrigin);
  const foreignMedia = mediaUrl.replace(apiOrigin, 'https://other.fixture.test');
  page.emit('response', fixtureResponse({ url: foreignMedia }));
  assert.equal(await hasNativeRange(foreignMedia), false);

  page.emit('response', fixtureResponse({ url: mediaUrl.replace('000000000000', '000000000001') }));
  page.emit('response', fixtureResponse({ method: 'HEAD' }));
  page.emit('response', fixtureResponse({ status: 200 }));
  page.emit('response', fixtureResponse({ range: null }));
  page.emit('response', fixtureResponse({ contentRange: 'bytes 0-2/1200' }));
  assert.equal(await hasNativeRange(mediaUrl), false);
});

test('the native check waits for headers of an already observed response', async () => {
  const page = new EventEmitter();
  const hasNativeRange = observeNativeRanges(page, apiOrigin);
  const header = Promise.withResolvers();
  const response = fixtureResponse();
  response.headerValue = () => header.promise;
  page.emit('response', response);
  const observed = hasNativeRange(mediaUrl);
  header.resolve('bytes 0-1/1200');
  assert.equal(await observed, true);
});

function matchesRange(range, contentRange) {
  const requested = /^bytes=(\d*)-(\d*)$/i.exec(range?.trim() ?? '');
  const returned = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? '');
  if (!requested || (!requested[1] && !requested[2]) || !returned) return false;
  const [start, end, size] = returned.slice(1).map(Number);
  if (![start, end, size].every(Number.isSafeInteger) || start > end || end >= size) return false;
  const expectedStart = requested[1] ? Number(requested[1]) : Math.max(0, size - Number(requested[2]));
  const expectedEnd = requested[1] && requested[2] ? Math.min(size - 1, Number(requested[2])) : size - 1;
  return start === expectedStart && end === expectedEnd;
}

async function isNativeRange(response, request) {
  const type = request.resourceType();
  if (request.method() !== 'GET' || type === 'fetch' || type === 'xhr') return false;
  const destination = await request.headerValue('sec-fetch-dest');
  // WebKit may report video requests as 'other'. Require browser video evidence in that case.
  if (destination === null ? type !== 'media' : destination !== 'video') return false;
  const [range, contentRange] = await Promise.all([
    request.headerValue('range'), response.headerValue('content-range'),
  ]);
  return matchesRange(range, contentRange);
}

export function observeNativeRanges(page, apiOrigin) {
  const responses = new Map();
  page.on('response', response => {
    const url = new URL(response.url());
    if (response.status() !== 206 || url.origin !== apiOrigin || !url.pathname.startsWith('/media/')) return;
    const pending = responses.get(url.href) ?? [];
    pending.push(isNativeRange(response, response.request()).catch(() => false));
    responses.set(url.href, pending);
  });
  return async mediaUrl => (await Promise.all(responses.get(mediaUrl) ?? [])).some(Boolean);
}

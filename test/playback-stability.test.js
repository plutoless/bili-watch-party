import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { formatBrowserFailure } from './browser-failure.js';
import { checkStability } from './playback-browser.js';

const nodeNow = 1000;
const scoringStart = 2500;

function fixturePage(clockShift, { firstDelay = 0, delayTimer = () => 0,
  pausedAt = () => false, positionAt = time => time / 1000 } = {}) {
  const run = { samples: [] };
  return {
    run,
    async evaluate(read) {
      return runInNewContext('(' + read + ')()', { performance: { now: () => nodeNow + clockShift } });
    },
    locator() {
      return { evaluate: async (collect, settings) => {
        run.localStart = settings.localStart;
        let now = nodeNow + clockShift;
        let started = false;
        const queue = [];
        const video = {
          get currentTime() { return positionAt(now - clockShift); },
          get paused() { return pausedAt(now - clockShift); },
          seeking: false,
        };
        const setTimeout = (callback, wait) => {
          const due = now + wait;
          const timer = { callback, at: due + (started ? delayTimer(due - clockShift) : firstDelay) };
          queue.push(timer);
          return timer;
        };
        const clearTimeout = timer => { timer.cancelled = true; };
        const result = runInNewContext('(' + collect + ')(video, settings)', {
          video, settings, setTimeout, clearTimeout, performance: { now: () => now },
        });
        while (queue.length) {
          queue.sort((a, b) => a.at - b.at);
          const { callback, at, cancelled } = queue.shift();
          if (cancelled) continue;
          now = at;
          started = true;
          callback();
        }
        const collected = await result;
        const { samples, preRoll } = Array.isArray(collected) ? { samples: collected } : collected;
        run.samples = samples.map(({ time }) => time - clockShift);
        if (preRoll) run.preRoll = preRoll.time - clockShift;
        return result;
      } };
    },
  };
}

test('a delayed first guest timer still brackets the original 100 stability observations', async t => {
  t.mock.method(performance, 'now', () => nodeNow);
  const output = t.mock.method(console, 'log', () => {});
  const host = fixturePage(2000);
  const guest = fixturePage(4000, { firstDelay: 169.552 });
  try {
    await checkStability(host, guest, 'initial-stability');
  } catch (error) {
    t.diagnostic(formatBrowserFailure(error, 'shared playback'));
    throw error;
  } finally {
    const relative = guest.run.samples[0] - scoringStart;
    t.diagnostic('guest first primary sample relative to scoring start: ' + relative.toFixed(3) + ' ms');
    if (guest.run.preRoll !== undefined) {
      t.diagnostic('guest pre-roll relative to scoring start: ' + (guest.run.preRoll - scoringStart).toFixed(3) + ' ms');
    }
  }
  assert.equal(host.run.localStart, scoringStart + 2000);
  assert.equal(guest.run.localStart, scoringStart + 4000);
  assert.equal(Number((guest.run.samples[0] - scoringStart).toFixed(3)), 69.552);
  assert.equal(Number((guest.run.preRoll - scoringStart).toFixed(3)), -30.448);
  assert.match(output.mock.calls[0].arguments[0], /^Stable playback: 100\/100 below 0\.5 s; maximum 0\.000 s;/);
});

for (const [name, guestOptions, predicate] of [
  ['both startup callbacks arrive after scoring starts', { firstDelay: 270 }, 'bracketed=false'],
  ['the backup sample was paused', { firstDelay: 169.552, pausedAt: time => time < scoringStart }, 'bracketed=false'],
  ['a regular sample was paused', { pausedAt: time => time === scoringStart }, 'paused=true'],
  ['primary advancement is insufficient', { firstDelay: 169.552, positionAt: time => time * 0.89 / 1000 }, 'advanced=false'],
  ['a regular sampling gap exceeds 300 ms', { delayTimer: time => time === scoringStart + 1000 ? 301 : 0 }, 'withinGap=false'],
]) {
  test('stability still fails when ' + name, async t => {
    t.mock.method(performance, 'now', () => nodeNow);
    const host = fixturePage(2000);
    const guest = fixturePage(4000, guestOptions);
    await assert.rejects(checkStability(host, guest, 'initial-stability'), error => {
      assert.equal(formatBrowserFailure(error, 'shared playback'),
        'shared playback | assertion failed | stage=initial-stability role=guest ' + predicate);
      return true;
    });
  });
}

for (const below of [95, 94]) {
  test('the unchanged 100-pair gate ' + (below === 95 ? 'passes' : 'fails') + ' with ' + below + ' below budget', async t => {
    t.mock.method(performance, 'now', () => nodeNow);
    const output = t.mock.method(console, 'log', () => {});
    const positionAt = time => time / 1024;
    const host = fixturePage(2000, { positionAt });
    const guest = fixturePage(4000, {
      positionAt: time => positionAt(time) + (time >= scoringStart && time < scoringStart + (100 - below) * 100 ? 0.5 : 0),
    });
    const check = checkStability(host, guest, 'recovery-stability');
    if (below === 95) await check;
    else await assert.rejects(check, error => {
      assert.equal(formatBrowserFailure(error, 'shared playback'),
        'shared playback | assertion failed | stage=recovery-stability role=both withinBudget=false');
      return true;
    });
    assert.ok(output.mock.calls[0].arguments[0].startsWith('Stable playback: ' + below + '/100 below 0.5 s; maximum 0.500 s;'));
  });
}

'use strict';
// SHARPENING THE DIAGNOSTIC — "18/18 answered" is not the same as "we got signals".
//
// Probed op=challenger (read-only, same internal-header path the cron uses) at 15:40 UTC
// on 2026-08-20: 18/18 sources present, 243 ranked signals, sourceDiag.empty = []. So the
// gather is HEALTHY outside the cron window, and the 22:0x failure is specific to that
// window — which the shipped diagnostic could not have told us apart, because it only
// asked whether each source was NULL.
//
// A source can answer 200 and still carry zero signals — most plausibly at 22:0x, when
// the warm scans are rebuilding the candle cache those endpoints read. In that case the
// current diagnostic would report a healthy-looking "18/18 answered" next to a 503, which
// is precisely the dead end it was meant to remove.
//
// So: count each source's CONTRIBUTION, and name the ones that answered but were barren.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sourceDiagnostics } = require('../lib/challenger-routes');
const { SIGNAL_SOURCE_KEYS } = require('../lib/decision-sources');

test('an unreachable source is EMPTY; one that answers with nothing is BARREN', () => {
  // Arrange — screener answers with a real candidate, gapgo answers with nothing,
  // daytrade is unreachable.
  const sources = {
    screener: screenerPayload(['AAPL']),
    gapgo: { strong: [], watch: [] },
    daytrade: null,
  };

  // Act
  const diag = sourceDiagnostics(sources);

  // Assert
  assert.deepStrictEqual(diag.empty, ['daytrade'], 'null source = unreachable');
  assert.ok(diag.barren.includes('gapgo'), 'answered but contributed no signals');
  assert.ok(!diag.barren.includes('daytrade'), 'an unreachable source is not "barren"');
  assert.equal(diag.present, 2);
  assert.equal(diag.total, 3);
});

test('THE 22:0x CASE: every source answers, none carries a signal', () => {
  // This is the shape the shipped diagnostic reported as a clean "18/18 answered"
  // alongside a 503 — the exact ambiguity being removed here.
  const sources = Object.fromEntries(SIGNAL_SOURCE_KEYS.map(k => [k, {}]));

  const diag = sourceDiagnostics(sources);

  assert.deepStrictEqual(diag.empty, [], 'nothing was unreachable...');
  assert.equal(diag.barren.length, SIGNAL_SOURCE_KEYS.length, '...but everything was barren');
  assert.equal(diag.present, SIGNAL_SOURCE_KEYS.length);
});

test('context-only sources are never counted as barren', () => {
  // sectors / today / scoreboard supply regime, density and ranking context — they are
  // not signal sources, so a zero contribution from them is normal, not a fault.
  const sources = { sectors: { sectors: [] }, today: { regime: {} }, scoreboard: { rows: [] } };
  const diag = sourceDiagnostics(sources);
  assert.deepStrictEqual(diag.barren, []);
  assert.equal(diag.present, 3);
});

test('perSource carries the actual contribution counts for the log line', () => {
  const sources = { screener: screenerPayload(['AAPL', 'MSFT']) };
  const diag = sourceDiagnostics(sources);
  assert.ok(diag.perSource.screener >= 1, 'a real source reports how much it contributed');
});

test('a source whose payload is malformed is reported, not thrown on', () => {
  // Runs on an already-failing path: it must never turn a 503 into a 500.
  const diag = sourceDiagnostics({ screener: { results: 'not-an-array' }, coil: 42 });
  assert.equal(typeof diag.present, 'number');
  assert.ok(Array.isArray(diag.barren));
});

test('still total on junk input', () => {
  for (const bad of [null, undefined, {}]) {
    const diag = sourceDiagnostics(bad);
    assert.equal(diag.present, 0);
    assert.deepStrictEqual(diag.empty, []);
    assert.deepStrictEqual(diag.barren, []);
    assert.equal(diag.total, 0);
  }
});

test('SIGNAL_SOURCE_KEYS matches the sources normalizeAll actually reads', () => {
  const { SOURCE_URLS } = require('../lib/decision-sources');
  for (const k of SIGNAL_SOURCE_KEYS) {
    assert.ok(k in SOURCE_URLS, `${k} must be a real gathered source`);
  }
  for (const ctxOnly of ['sectors', 'today', 'scoreboard']) {
    assert.ok(!SIGNAL_SOURCE_KEYS.includes(ctxOnly), `${ctxOnly} is context, not a signal source`);
  }
});

// The shape fromScreener actually reads: results[] with a status and positive entry level.
function screenerPayload(tickers) {
  return {
    scope: 'large',
    results: tickers.map(ticker => ({
      ticker, status: 'Breakout', price: 100,
      levels: { entry: 100, stop: 95, target: 115 },
    })),
  };
}

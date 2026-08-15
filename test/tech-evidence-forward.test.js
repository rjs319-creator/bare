'use strict';
// Prevents: same-close entry (lookahead fills), weekend/holiday session-count drift,
// benchmark residuals on mismatched geometry, cost-unit mistakes (lib/costs is PERCENT),
// premature resolution of immature events, and overlapping duplicate events.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../lib/tech-evidence/forward');
const { addDays } = require('../lib/tech-evidence/signals');
const { roundTripCostPct } = require('../lib/costs');

// Trading-day candle builder that skips weekends AND July 3 2026 (observed holiday)
// plus Sept 7 2026 (Labor Day) so session arithmetic is tested against real gaps.
const SKIP = new Set(['2026-07-03', '2026-09-07']);
function candlesFrom(startDate, n, { start = 100, drift = 0.01, vol = 3e6 } = {}) {
  const out = [];
  let p = start;
  let d = startDate;
  while (out.length < n) {
    const dow = new Date(d + 'T00:00:00Z').getUTCDay();
    if (dow !== 0 && dow !== 6 && !SKIP.has(d)) {
      out.push({ date: d, open: p, close: p * (1 + drift), volume: vol });
      p *= 1 + drift;
    }
    d = addDays(d, 1);
  }
  return out;
}

test('entry is the NEXT session open after the cutoff — never the cutoff close, across a weekend+holiday', () => {
  const candles = candlesFrom('2026-06-01', 60);
  // Cutoff Thursday 2026-07-02; Friday July 3 is a holiday; entry must be Monday July 6.
  const r = F.horizonReturns(candles, '2026-07-02');
  assert.equal(r.status, 'ok');
  assert.equal(r.entryDate, '2026-07-06');
  const decIdx = candles.findIndex(c => c.date === '2026-07-02');
  assert.equal(r.exitDates[1], candles[decIdx + 1].date, '1-session exit = entry bar close');
  assert.equal(r.exitDates[5], candles[decIdx + 5].date);
  assert.equal(r.exitDates[10], candles[decIdx + 10].date);
});

test('a cutoff on a Saturday resolves to the prior Friday decision bar', () => {
  const candles = candlesFrom('2026-06-01', 60);
  const sat = F.horizonReturns(candles, '2026-06-13'); // Saturday
  const fri = F.horizonReturns(candles, '2026-06-12');
  assert.equal(sat.status, 'ok');
  assert.equal(sat.entryDate, fri.entryDate);
});

test('immature events return not-mature; bad prices are rejected', () => {
  const candles = candlesFrom('2026-06-01', 12);
  assert.equal(F.horizonReturns(candles, candles[5].date).status, 'not-mature');
  // corrupt the 5-session exit bar (decIdx 10 → exit idx 15) so the guard must fire
  const bad = candlesFrom('2026-06-01', 30).map((c, i) => (i === 15 ? { ...c, close: 0 } : c));
  assert.equal(F.horizonReturns(bad, bad[10].date).status, 'bad-prices');
});

test('resolveEvent: net residual = gross − benchmark − round-trip cost (fractions), tier by ADV', () => {
  const stock = candlesFrom('2026-06-01', 60, { drift: 0.01, vol: 5e5 });   // ADV ≈ 5e7·? small*: close*vol grows
  const bench = candlesFrom('2026-06-01', 60, { drift: 0.005 });
  const event = { id: 'e1', cutoffDate: '2026-07-02', benchmark: 'IGV', direction: 'positive', z: 2, arm: 'npm', ticker: 'MDB', basis: 'live' };
  const r = F.resolveEvent(event, stock, bench);
  assert.equal(r.status, 'resolved');
  const expectedCost = roundTripCostPct(r.tier) / 100;
  assert.equal(r.costFraction, expectedCost, 'lib/costs speaks PERCENT — the ledger must divide by 100 exactly once');
  for (const H of [1, 5, 10]) {
    const residual = r.gross[H] - r.benchmark[H];
    assert.ok(Math.abs(r.netResidual[H] - (residual - expectedCost)) < 1e-12);
    assert.ok(Math.abs(r.gross[H] - (Math.pow(1.01, H) - 1)) < 1e-9, `gross ${H}-session return must be exit close / entry open − 1`);
  }
});

test('resolveEvent: not-mature benchmark postpones; missing benchmark is its own status', () => {
  const stock = candlesFrom('2026-06-01', 60);
  const shortBench = candlesFrom('2026-06-01', 12);
  const event = { id: 'e1', cutoffDate: '2026-07-02', benchmark: 'IGV' };
  assert.equal(F.resolveEvent(event, stock, shortBench).status, 'not-mature');
  assert.equal(F.resolveEvent(event, stock, []).status, 'no-benchmark-data');
});

test('eventsFromSignals: ineligible skipped, overlapping open events deduped, no benchmark → excluded with reason', () => {
  const sig = (over = {}) => ({
    eligible: true, ticker: 'MDB', arm: 'npm', id: 'sig-x', mappingId: 'm', direction: 'positive',
    z: 2, surprise: 0.2, adjustedSurprise: 0.2, basis: 'live', ...over,
  });
  const { events, skipped } = F.eventsFromSignals(
    [sig(), sig({ ticker: 'ZZZ' }), sig({ ticker: 'DDOG', eligible: false })],
    {
      cutoffDate: '2026-08-07',
      priorEvents: [{ d: '2026-08-03', t: 'MDB', arm: 'npm' }],  // 4 days earlier — overlaps
      benchmarkFor: (t) => (t === 'ZZZ' ? null : 'IGV'),
      createdAt: '2026-08-07T22:00:00Z',
    },
  );
  assert.equal(events.length, 0);
  assert.deepEqual(skipped.map(s => s.reason).sort(), ['no-benchmark', 'overlapping-open-event']);
  // Same signal far enough from the prior event DOES create an event
  const ok = F.eventsFromSignals([sig()], {
    cutoffDate: '2026-08-20', priorEvents: [{ d: '2026-08-03', t: 'MDB', arm: 'npm' }],
    benchmarkFor: () => 'IGV', createdAt: '2026-08-20T22:00:00Z',
  });
  assert.equal(ok.events.length, 1);
  assert.equal(ok.events[0].entryPolicy, 'next-regular-session-open-after-cutoff');
});

test('historyRangeFor refuses events too old to resolve honestly', () => {
  const now = new Date('2026-08-11T00:00:00Z');
  assert.equal(F.historyRangeFor('2026-06-01', now), '1y');
  assert.equal(F.historyRangeFor('2025-06-01', now), '2y');
  assert.equal(F.historyRangeFor('2024-01-01', now), null);
});

'use strict';
// GRIDLOCK Read-Through extension: deterministic tape read (no lookahead) and
// the notYetRepriced honesty rule (a weak-link non-mover is NOT an opportunity).
const test = require('node:test');
const assert = require('node:assert');
const RT = require('../lib/gridlock-readthrough');

// Synthetic candles: 30 flat days then a +10% pop on day 31, then future noise.
function candlesFrom(dates, closes, vol = 1e6) {
  return dates.map((date, i) => ({ date, open: closes[i], high: closes[i] * 1.01, low: closes[i] * 0.99, close: closes[i], volume: vol }));
}
const dates = Array.from({ length: 40 }, (_, i) => `2026-06-${String(i + 1).padStart(2, '0')}`.replace(/-3([2-9])$/, (m, d) => `-3${d}`))
  .map((d, i) => new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10));
const flat = dates.map(() => 100);

test('tapeRead measures event→asOf excess move vs bench and never uses bars after asOf', () => {
  const closes = dates.map((d, i) => (i >= 25 ? 110 : 100));                 // pops after index 25
  const tick = candlesFrom(dates, closes);
  const bench = candlesFrom(dates, flat);
  const before = RT.tapeRead({ candles: tick, benchCandles: bench, eventDate: dates[20], asOf: dates[24] });
  assert.strictEqual(before.excessMovePct, 0);                              // future pop invisible before asOf
  const after = RT.tapeRead({ candles: tick, benchCandles: bench, eventDate: dates[20], asOf: dates[30] });
  assert.strictEqual(after.excessMovePct, 10);
});

test('tapeRead reports missing coverage as nulls, not zeros', () => {
  const r = RT.tapeRead({ candles: null, benchCandles: null, eventDate: '2026-06-10', asOf: '2026-06-20' });
  assert.strictEqual(r.excessMovePct, null);
  assert.strictEqual(r.coverage, false);
});

const rel = { estimatedMateriality: 'high', verifiedOrInferred: 'verified' };
const cls = (over = {}) => ({ classification: 'DIRECT_BENEFICIARY', direction: 1, verifiedOrInferred: 'verified', ...over });
const ev = { announcedAt: '2026-07-25', independentSourceCount: 2, lifecycle: 'EMERGING' };

test('weak or inferred links are NOT scored as hidden opportunities', () => {
  const weak = RT.notYetRepricedScore({ classification: cls({ classification: 'TOO_INDIRECT' }), relationship: rel, event: ev, tape: { excessMovePct: 0, relVol: 1, dollarVol: 5e7 }, asOf: '2026-07-30' });
  assert.strictEqual(weak.score, null);
  assert.match(weak.note, /NOT a hidden opportunity/);
  const inferred = RT.notYetRepricedScore({ classification: cls({ verifiedOrInferred: 'inferred' }), relationship: rel, event: ev, tape: { excessMovePct: 0, relVol: 1, dollarVol: 5e7 }, asOf: '2026-07-30' });
  assert.strictEqual(inferred.score, null);
});

test('unreacted gap: un-moved verified direct link scores high; fully repriced scores low', () => {
  const unmoved = RT.notYetRepricedScore({ classification: cls(), relationship: rel, event: ev, tape: { excessMovePct: 0.2, relVol: 1.6, dollarVol: 5e7 }, asOf: '2026-07-30' });
  const repriced = RT.notYetRepricedScore({ classification: cls(), relationship: rel, event: ev, tape: { excessMovePct: 9, relVol: 1.6, dollarVol: 5e7 }, asOf: '2026-07-30' });
  assert.ok(unmoved.score > repriced.score);
  assert.strictEqual(repriced.reads.unreactedGap, 0);
  // Moving AGAINST the thesis is suspicious, not "unpriced upside".
  const against = RT.notYetRepricedScore({ classification: cls(), relationship: rel, event: ev, tape: { excessMovePct: -8, relVol: 1, dollarVol: 5e7 }, asOf: '2026-07-30' });
  assert.strictEqual(against.reads.unreactedGap, 20);
});

test('attention saturation and crowding cap the score; decomposed reads are returned', () => {
  const crowded = RT.notYetRepricedScore({ classification: cls(), relationship: rel, event: { ...ev, lifecycle: 'CROWDED', independentSourceCount: 12 }, tape: { excessMovePct: 0.5, relVol: 1.2, dollarVol: 5e7 }, asOf: '2026-07-30' });
  assert.strictEqual(crowded.reads.attentionRoom, 10);
  assert.ok(Array.isArray(crowded.available) && Array.isArray(crowded.missing));
});

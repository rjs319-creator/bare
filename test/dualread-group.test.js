// Tests for the behavior grouping (lib/dualread-group.js).
const test = require('node:test');
const assert = require('node:assert');
const { groupOf, annualizedVol, GROUPS } = require('../lib/dualread-group');

// Build a daily close series with a given per-step multiplicative noise amplitude.
// amp≈0.005 → calm; amp≈0.05 → wild. Deterministic via a small LCG.
function seriesVol(amp, n = 160, seed = 3) {
  let s = seed >>> 0; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const candles = []; let px = 100;
  for (let i = 0; i < n; i++) { px *= 1 + amp * (rnd() * 2 - 1); candles.push({ close: px }); }
  return candles;
}

test('annualizedVol: calm series is low, wild series is high', () => {
  const lo = annualizedVol(seriesVol(0.004));
  const hi = annualizedVol(seriesVol(0.06));
  assert.ok(lo < hi, `calm ${lo} should be < wild ${hi}`);
  assert.ok(lo > 0 && hi > 0);
});

test('groupOf: calm → lowvol, wild → highvol', () => {
  assert.equal(groupOf(seriesVol(0.003)), 'lowvol');
  assert.equal(groupOf(seriesVol(0.08)), 'highvol');
});

test('groupOf: thin history → other (rides global weights)', () => {
  assert.equal(groupOf([{ close: 1 }, { close: 2 }]), 'other');
  assert.equal(groupOf(null), 'other');
});

test('every non-other group is a known bucket', () => {
  const g = groupOf(seriesVol(0.02));
  assert.ok(GROUPS.includes(g), `${g} should be one of ${GROUPS}`);
});

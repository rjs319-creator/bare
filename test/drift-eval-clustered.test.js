'use strict';
// REGRESSION (audit 2026-08-14): drift-eval clusteredStats computed tStat = s.avg / s.se
// from the 2dp-ROUNDED display fields of evidence-stats summarizeDateSeries. Drift series
// are in FRACTIONAL units (a real edge is ~0.004/date), so the rounded avg is 0.00 and the
// t-statistic — the one the CONFIRMED / NOT-CONFIRMED verdict gates on at t ≥ 2 — was
// garbage computed from zero. clusteredStats must use avgExact/seExact.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clusteredStats } = require('../lib/drift-eval');

// A fractional-units date series with true mean 0.004 and a tiny sd: 40 dates,
// v alternating 0.0036 / 0.0044 (deterministic — mean exactly 0.004, sd 4e-4).
function fractionalRows(n = 40) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const day = String((i % 28) + 1).padStart(2, '0');
    const month = String(Math.floor(i / 28) + 1).padStart(2, '0');
    rows.push({ date: `2026-${month}-${day}`, v: 0.004 + (i % 2 === 0 ? -0.0004 : 0.0004) });
  }
  return rows;
}

test('clusteredStats: a fractional-units series with true mean 0.004 and tiny sd yields a LARGE t, not 0', () => {
  // Arrange
  const rows = fractionalRows(40);
  // Act
  const s = clusteredStats(rows, 5);
  // Assert — the ROUNDED avg of this series is 0.00; a t computed from display fields is 0.
  assert.equal(s.basis, 'date-clustered (HAC/Newey-West, horizon-lagged)');
  assert.ok(Number.isFinite(s.tStat), 'tStat must be finite');
  assert.ok(s.tStat > 10, `true t is ~0.004 / (4e-4/√40) ≈ 63 — got ${s.tStat} (0 means the display-rounded fields were used)`);
});

test('clusteredStats: meanPct comes from the full-precision mean (0.004 → 0.40%, not 0.00%)', () => {
  const s = clusteredStats(fractionalRows(40), 5);
  assert.ok(Math.abs(s.meanPct - 0.4) < 0.02, `expected ~0.40%, got ${s.meanPct}`);
});

test('clusteredStats: ci95Pct is derived from exact fields and brackets the true mean', () => {
  const s = clusteredStats(fractionalRows(40), 5);
  assert.ok(s.ci95Pct && Number.isFinite(s.ci95Pct.lo) && Number.isFinite(s.ci95Pct.hi));
  // Exact t-interval: 0.4% ± tCrit×(se×100) ≈ 0.4% ± ~0.015% — a rounded-field interval
  // would be quantized to whole-percent steps ({0, 1}) and could not sit strictly inside (0.3, 0.5).
  assert.ok(s.ci95Pct.lo > 0.3 && s.ci95Pct.hi < 0.5, `expected a tight interval around 0.40%, got [${s.ci95Pct.lo}, ${s.ci95Pct.hi}]`);
  assert.ok(s.ci95Pct.lo <= s.meanPct && s.meanPct <= s.ci95Pct.hi);
});

test('clusteredStats: still fails closed on an unusable series', () => {
  assert.deepEqual(clusteredStats([], 5), { n: 0 });
  const one = clusteredStats([{ date: '2026-01-01', v: 0.004 }], 5);
  assert.equal(one.n, 1);
  assert.match(one.note || '', /insufficient/);
});

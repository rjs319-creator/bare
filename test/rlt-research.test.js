'use strict';
// RLT research harness — deterministic fixture validation with NO credentials.
// Three properties matter more than any IC number:
//   1. the null control stays insignificant (leakage detector);
//   2. a PLANTED leadership-transition effect is detected by the simple
//      rank baselines (the machinery can see what it claims to measure);
//   3. every verdict is stamped productionEligible:false (survivorship-unsafe
//      data can never promote anything, regardless of IC).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildRltEvents, runRltComparison } = require('../lib/rlt-research');

function lcg(seed) { let s = seed >>> 0; return () => (s = (1103515245 * s + 12345) >>> 0) / 4294967296; }
function mkSeries(n, retFn) {
  let p = 50;
  const out = [];
  const d0 = new Date('2025-04-01');
  let day = 0;
  while (out.length < n) {
    const dt = new Date(d0.getTime() + day * 86400000); day++;
    const wd = dt.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const r = retFn(out.length);
    p = Math.max(2, p * (1 + r));
    out.push([dt.toISOString().slice(0, 10), p * 0.997, p * 1.008, p * 0.992, p, 2e6 + 5e4 * (out.length % 40), p]);
  }
  return out;
}

function buildFixture() {
  const N = 260;
  const rnd = lcg(42);
  const spyRets = Array.from({ length: N }, () => 0.0003 + (rnd() - 0.5) * 0.014);
  const spy = mkSeries(N, i => spyRets[i]);
  const sectors = ['Technology', 'Health Care', 'Energy', 'Financials'];
  const secRets = {}, secBars = {};
  for (const s of sectors) {
    const r2 = lcg(s.length * 7 + 3);
    secRets[s] = Array.from({ length: N }, (_, i) => spyRets[i] * 0.9 + (r2() - 0.5) * 0.006);
    secBars[s] = mkSeries(N, i => secRets[s][i]);
  }
  const rows = [];
  for (let si = 0; si < sectors.length; si++) {
    const s = sectors[si];
    for (let k = 0; k < 12; k++) {
      const r3 = lcg(si * 100 + k * 13 + 7);
      // Planted effect: an episodic residual-drift burst that RAMPS UP then
      // persists — a leadership transition that precedes continuation.
      const burstStart = 80 + ((si * 37 + k * 53) % 120);
      const drift = i => (i >= burstStart && i < burstStart + 30
        ? Math.min(1, (i - burstStart) / 10) * 0.004 : 0);
      rows.push({
        ticker: s.slice(0, 3).toUpperCase() + k, sector: s, price: 50, dollarVol: 6e6,
        capGroup: 'large', scope: 'large',
        bars: mkSeries(N, i => secRets[s][i] + drift(i) + (r3() - 0.5) * 0.02),
      });
    }
  }
  const spyDates = spy.map(b => b[0]);
  const decisionDates = [];
  for (let i = 100; i < N - 30; i += 9) decisionDates.push(spyDates[i]);
  return { rows, spy, secBars, decisionDates };
}

test('the fixture comparison is deterministic, leakage-clean, and fail-closed', { timeout: 120000 }, () => {
  const { rows, spy, secBars, decisionDates } = buildFixture();
  const events = buildRltEvents({
    rowsFor: () => rows, spyCandles: spy, sectorBarsFor: s => secBars[s] || [], decisionDates,
  });
  assert.ok(events.length > 300, `expected a real event set, got ${events.length}`);

  const cmp = runRltComparison(events, { experimentId: 'rlt-test-fixture' });

  // 1. Null control: random ranking must not look significant.
  const rand = cmp.perRankerIC['control-random'];
  assert.equal(rand.significant, false, 'random control came out significant — leakage or broken folds');

  // 2. The planted transition effect is visible to the simple rank baselines.
  const level = cmp.perRankerIC['rank-level'];
  assert.ok(level.meanIC > 0.03, `rank-level should detect the planted effect, meanIC=${level.meanIC}`);
  const fixed = cmp.perRankerIC['fixed-transition'];
  assert.ok(fixed.meanIC > 0.03, `fixed-transition should detect the planted effect, meanIC=${fixed.meanIC}`);

  // 3. Fail closed regardless of IC.
  assert.equal(cmp.verdict.productionEligible, false);
  assert.equal(cmp.manifest.researchValidity.survivorshipSafe, false);

  // 4. Deterministic: identical inputs → identical result (no RNG anywhere).
  const cmp2 = runRltComparison(events, { experimentId: 'rlt-test-fixture' });
  assert.equal(JSON.stringify(cmp.perRankerIC), JSON.stringify(cmp2.perRankerIC));

  // 5. Outcome basis is sector-relative when the sector leg exists.
  assert.equal(events[0].outcomeBasis, 'sector-relative');
});

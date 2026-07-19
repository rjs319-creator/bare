'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const Mon = require('../lib/orbit-monitor');

function lcg(seed) { let s = seed >>> 0; return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; }; }

// Resolved ledger: `nDates` dates × `nNames` names. `sign`=+1 predictive, −1 inverted.
function ledger(nDates, nNames, seed, sign = 1) {
  const rnd = lcg(seed);
  const rows = [];
  for (let di = 0; di < nDates; di++) {
    const date = new Date(new Date('2025-01-06T00:00:00Z').getTime() + di * 7 * 86400000).toISOString().slice(0, 10);
    for (let ni = 0; ni < nNames; ni++) {
      const score = rnd();
      // sign>0: predictive with a positive edge; sign<0: inverted with a negative edge.
      const net = sign * (score - 0.5) * 0.2 + sign * 0.012 + (rnd() - 0.5) * 0.02;
      rows.push({ date, ticker: `T${ni}`, horizon: 'days21', score, calUp: score, label: net > 0 ? 1 : 0, net: +net.toFixed(4), severe: net <= -0.08 ? 1 : 0 });
    }
  }
  return rows;
}

test('INSUFFICIENT_DATA when too few independent dates (no overreaction to a streak)', () => {
  const out = Mon.monitorHorizon(ledger(4, 6, 1), 'days21');
  assert.strictEqual(out.status, 'INSUFFICIENT_DATA');
});

test('HEALTHY on a genuinely predictive resolved set', () => {
  const out = Mon.monitorHorizon(ledger(30, 12, 2, +1), 'days21');
  assert.strictEqual(out.status, 'HEALTHY');
  assert.ok(out.expanding.ic > 0.02);
  assert.ok(out.expanding.brier != null, 'Brier computed from calibrated preds');
});

test('BROKEN on an inverted (negative-edge) resolved set', () => {
  const out = Mon.monitorHorizon(ledger(30, 12, 3, -1), 'days21');
  assert.strictEqual(out.status, 'BROKEN');
});

test('multi-window metrics + drift are reported', () => {
  const out = Mon.monitorHorizon(ledger(40, 10, 4), 'days21');
  assert.ok(out.windows.d20 && out.windows.d60 && out.windows.d126);
  assert.ok('predictionDrift' in out.drift);
});

test('grade B: promising purged OOS but no prospective evidence', () => {
  const wf = { ok: true, purged: { overall: { ic: 0.05, icir: 0.4, brier: 0.23, topDecileNet: 0.03, nDates: 12 } } };
  const g = Mon.gradeHorizon(wf, null, { survivorshipSafe: false });
  assert.strictEqual(g.grade, 'B');
  assert.strictEqual(g.productionGrade, false);
  assert.ok(g.limitations.some(l => /survivorship/i.test(l)));
});

test('grade F: negative nested outer-OOS', () => {
  const wf = { ok: true, purged: { overall: { ic: -0.05, nDates: 10 } } };
  assert.strictEqual(Mon.gradeHorizon(wf, null, {}).grade, 'F');
});

test('grade A is NOT awarded from backfill alone (needs prospective + survivorship-safe)', () => {
  const wf = { ok: true, purged: { overall: { ic: 0.06, nDates: 12, brier: 0.2 } } };
  // Even with a HEALTHY prospective, survivorshipSafe=false blocks A → falls to B.
  const healthy = Mon.monitorHorizon(ledger(30, 12, 7, +1), 'days21');
  const g = Mon.gradeHorizon(wf, healthy, { survivorshipSafe: false });
  assert.notStrictEqual(g.grade, 'A');
});

test('grade A reachable only with survivorship-safe + prospective HEALTHY', () => {
  const wf = { ok: true, purged: { overall: { ic: 0.06, nDates: 12, brier: 0.2 } } };
  const healthy = Mon.monitorHorizon(ledger(30, 12, 8, +1), 'days21');
  const g = Mon.gradeHorizon(wf, healthy, { survivorshipSafe: true });
  assert.strictEqual(g.grade, 'A');
});

test('classify never returns BROKEN below the minimum date count', () => {
  const m = { effN: 5, ic: -0.2, positiveIcFrac: 0.1, netExpectancy: -0.1 };
  assert.strictEqual(Mon.classify(m), 'INSUFFICIENT_DATA');
});

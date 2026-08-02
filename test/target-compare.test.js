'use strict';
// TARGET COMPARISON tests. The invariants that matter:
//   1. ONE evaluation metric: every variant trains on its OWN label but is scored
//      against the SAME pre-declared economic outcome (cost-adjusted-residual) —
//      "easier to predict" can never masquerade as "better target".
//   2. The shuffled-label control is built in, deterministic, and if it wins the
//      verdict says NOISE — the comparison can falsify itself.
//   3. Purge/embargo: overlapping-label rows are excluded from training
//      (trainN < pastN when labels span into the test block).
//   4. Fail closed: below minimum dates/rows → INSUFFICIENT_DATA, no winner.
//   5. A variant whose label is informative about the economic outcome beats one
//      trained on pure noise labels, on the SAME evaluation.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const TC = require('../lib/research/target-compare');

function tradingDates(n) {
  const out = [];
  const d = new Date('2026-01-05T00:00:00Z');
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd >= 1 && wd <= 5) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
function lcg(seed) { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

// A world where features genuinely predict the economic outcome: econ = 2*f1 - f2 + noise.
// 'noise-label' carries NO information about econ. Labels end 21 sessions after decision.
function buildRows({ nDates = 16, perDate = 15, seed = 5 } = {}) {
  const dts = tradingDates(nDates * 5 + 30);
  const rnd = lcg(seed);
  const rows = [];
  for (let d = 0; d < nDates; d++) {
    const decisionTs = dts[d * 5];
    const labelEndDate = dts[d * 5 + 21];
    for (let i = 0; i < perDate; i++) {
      const f1 = rnd() - 0.5, f2 = rnd() - 0.5;
      const econ = 2 * f1 - f2 + (rnd() - 0.5) * 0.3;
      rows.push({
        securityId: `T${i}`, ticker: `T${i}`,
        decisionTs, labelEndDate, horizon: 21,
        features: { f1, f2, residMom21: f1 },     // residMom21 doubles as the baseline's feature
        score: f1 * 0.5 + (rnd() - 0.5) * 0.8,    // a mediocre "champion" score
        outcomes: {
          'cost-adjusted-residual': econ,
          'rank-cost-residual': null,             // filled below, per date
          'noise-label': rnd() - 0.5,             // information-free training target
        },
      });
    }
  }
  // Within-date percentile rank of the economic outcome (the factory's preferred shape).
  const byDate = new Map();
  for (const r of rows) { if (!byDate.has(r.decisionTs)) byDate.set(r.decisionTs, []); byDate.get(r.decisionTs).push(r); }
  for (const group of byDate.values()) {
    const vals = group.map(r => r.outcomes['cost-adjusted-residual']);
    for (const r of group) {
      const below = vals.filter(v => v < r.outcomes['cost-adjusted-residual']).length;
      r.outcomes['rank-cost-residual'] = below / (vals.length - 1);
    }
  }
  return rows;
}

// ridge fit needs FEATURE_KEYS from research/features — our synthetic features use
// custom keys, so ridge trains on standardized zeros for unknown keys… verify the
// comparison still behaves: baselines and controls work on any keys; ridge variants
// need real feature keys. Map synthetic features onto two REAL keys instead.
function remapToRealKeys(rows) {
  return rows.map(r => ({ ...r, features: { ret21: r.features.f1, volSurprise: r.features.f2, residMom21: r.features.residMom21 } }));
}

test('informative labels beat noise labels on the SAME economic evaluation', () => {
  const rows = remapToRealKeys(buildRows());
  const out = TC.compareTargets(rows, { folds: 4, embargo: 3 });
  assert.notEqual(out.verdict, 'INSUFFICIENT_DATA');
  assert.equal(out.evaluationVariant, 'cost-adjusted-residual');
  const econ = out.perVariant['cost-adjusted-residual'].meanIC;
  const noise = out.perVariant['noise-label'].meanIC;
  assert.ok(econ > 0.3, `training on the economic label should rank well OOS, got ${econ}`);
  assert.ok(econ > noise + 0.15, `noise-trained model must be clearly worse (econ ${econ} vs noise ${noise})`);
  assert.ok(out.perVariant['rank-cost-residual'].meanIC > noise, 'rank target carries the same information');
});

test('the shuffled control exists, is deterministic, and does not win in an informative world', () => {
  const rows = remapToRealKeys(buildRows());
  const a = TC.compareTargets(rows, { folds: 4, embargo: 3 });
  const b = TC.compareTargets(remapToRealKeys(buildRows()), { folds: 4, embargo: 3 });
  assert.ok('control-shuffled' in a.perVariant, 'shuffled control must always run');
  assert.equal(a.shuffledIC, b.shuffledIC, 'shuffle is seeded — byte-identical reruns');
  assert.ok(a.winner !== 'control-shuffled');
  assert.ok(!/NOISE/.test(a.verdict), `informative world must not be called noise: ${a.verdict}`);
});

test('purge: overlapping labels are excluded from training', () => {
  const rows = remapToRealKeys(buildRows());
  const out = TC.compareTargets(rows, { folds: 4, embargo: 3 });
  for (const f of out.foldReport) {
    assert.ok(f.trainN < f.pastN, `fold ${f.fold}: 21-session labels near the boundary must be purged (train ${f.trainN} vs past ${f.pastN})`);
  }
});

test('fail closed below minimums — no winner from a tiny sample', () => {
  const rows = remapToRealKeys(buildRows({ nDates: 4, perDate: 5 }));
  const out = TC.compareTargets(rows, { folds: 4, embargo: 3 });
  assert.equal(out.verdict, 'INSUFFICIENT_DATA');
  assert.equal(Object.keys(out.perVariant).length, 0);
});

test('rows without the evaluation label are dropped, not zero-filled', () => {
  const rows = remapToRealKeys(buildRows());
  const broken = rows.map((r, i) => (i % 2 ? { ...r, outcomes: { ...r.outcomes, 'cost-adjusted-residual': null } } : r));
  const out = TC.compareTargets(broken, { folds: 4, embargo: 3 });
  assert.equal(out.rows, rows.length / 2);
});

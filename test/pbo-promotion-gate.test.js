'use strict';
// pbo-promotion-gate — the CSCV Probability of Backtest Overfitting (lib/research/pbo,
// previously an orphan consumed by nothing) wired into the challenger promotion gate as
// a DEMOTE-ONLY input:
//   • computable PBO ≥ threshold  → an extra criterion FAILS (blocks promotable)
//   • computable PBO < threshold  → an extra criterion passes — which can never flip
//     promotable to true (promotable = every criterion passes), so low PBO never boosts
//   • not computable              → the gate is BYTE-IDENTICAL to pre-wiring (same 10
//     criteria, same passed/of/promotable) plus an honest 'not-computable' stamp; the
//     check is never claimed as passed
const test = require('node:test');
const assert = require('node:assert');
const evalLib = require('../lib/challenger-eval');

// ---- fixtures -----------------------------------------------------------------------------
// Sequential distinct ISO prediction dates (avoids month/day overflow).
function isoDate(i) {
  const d = new Date(Date.UTC(2025, 0, 2));
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
}

// Resolved-prediction fixture: `dates` prediction dates × `picksPerDate` picks. Two
// variant columns survive coverage (residualScore + baselineProd; momentum/omega are
// null → dropped by the coverage floor). Per date, outcomes order picks 0..k-1;
// `residualPhase(dateIdx)` decides whether residualScore ranks WITH the outcome (+1
// per-date IC) or against it (−1); baselineProd always does the opposite.
function variantFixture(dates, picksPerDate, residualPhase) {
  const rows = [];
  for (let d = 0; d < dates; d++) {
    const aligned = residualPhase(d);
    for (let j = 0; j < picksPerDate; j++) {
      rows.push({
        predDate: isoDate(d), ticker: `T${d}_${j}`, horizon: 'swing', decision: 'TRADE',
        outcome: +(j - (picksPerDate - 1) / 2 + 0.001 * d).toFixed(4),
        won: j > (picksPerDate - 1) / 2,
        residualScore: aligned ? j : picksPerDate - 1 - j,
        baselineProd: aligned ? picksPerDate - 1 - j : j,
        baselineMomentum: null, baselineOmega: null,
        regimeLabel: 'neutral', capTier: 'large', eventType: 'none',
      });
    }
  }
  return rows;
}

// ---- (d) threshold pinned -----------------------------------------------------------------
test('PBO block threshold is pinned at the literature-standard 0.5 (Bailey et al. 2014)', () => {
  assert.strictEqual(evalLib.PBO_OVERFIT_THRESHOLD, 0.5);
});

test('pboVerdictInput: boundary semantics — ≥ threshold blocks, below passes, null is not-computable', () => {
  assert.strictEqual(evalLib.pboVerdictInput({ pbo: 0.5, dates: 12 }).verdictInput, 'blocked');
  assert.strictEqual(evalLib.pboVerdictInput({ pbo: 0.4999, dates: 12 }).verdictInput, 'pass');
  const nc = evalLib.pboVerdictInput({ pbo: null, reason: 'too few dates (3) for 2/block × 2 blocks' });
  assert.strictEqual(nc.verdictInput, 'not-computable');
  assert.strictEqual(nc.pbo, null);
  assert.match(nc.note, /not computable/);
  assert.match(nc.note, /too few dates/); // the honest reason rides through
  // Missing entirely (e.g. a pre-wiring cached evaluation) is also not-computable.
  const missing = evalLib.pboVerdictInput(undefined);
  assert.strictEqual(missing.verdictInput, 'not-computable');
  assert.match(missing.note, /not computable \(insufficient data\)/);
});

// ---- (a) high PBO blocks ------------------------------------------------------------------
test('anti-persistent variant selection (high PBO) fails the CSCV criterion and blocks promotable', () => {
  // Arrange — 96 dates in 12-date phase blocks: whichever variant wins any in-sample
  // block mix loses the complementary mix (the pbo.test.js anti-persistent shape,
  // reached through the real resolved-prediction pipeline).
  const preds = variantFixture(96, 4, (d) => Math.floor(d / 12) % 2 === 0);

  // Act
  const ev = evalLib.evaluate(preds, { now: '2026-08-14' });
  const promo = evalLib.promotionCheck(ev, { liveIC: 0.1, liveAvgOutcome: 0.5 });

  // Assert — computable, high, and it BLOCKS.
  assert.ok(ev.pbo && typeof ev.pbo.pbo === 'number', 'evaluate() must surface a computable PBO');
  assert.ok(ev.pbo.pbo >= evalLib.PBO_OVERFIT_THRESHOLD, `anti-persistent PBO should be high, got ${ev.pbo.pbo}`);
  const crit = promo.criteria.find((c) => /CSCV|PBO/i.test(c.name));
  assert.ok(crit, 'a PBO criterion must appear when PBO is computable');
  assert.strictEqual(crit.pass, false);
  assert.strictEqual(promo.promotable, false);
  // Self-describing stamp on the promotion doc.
  assert.strictEqual(promo.pbo.verdictInput, 'blocked');
  assert.strictEqual(promo.pbo.pbo, ev.pbo.pbo);
  assert.ok(Number.isFinite(promo.pbo.n) && promo.pbo.n > 0, 'stamp carries the date-row count n');
  assert.strictEqual(promo.pbo.threshold, evalLib.PBO_OVERFIT_THRESHOLD);
});

// ---- (b) low PBO never boosts -------------------------------------------------------------
test('a persistently dominant variant (low PBO) changes NOTHING — the criterion can only demote', () => {
  // Arrange — residualScore ranks with the outcome on EVERY date → the IS winner keeps
  // winning OOS → PBO ~0.
  const preds = variantFixture(96, 4, () => true);

  // Act
  const ev = evalLib.evaluate(preds, { now: '2026-08-14' });
  const withPbo = evalLib.promotionCheck(ev, {});
  const withoutPbo = evalLib.promotionCheck({ ...ev, pbo: undefined }, {}); // pre-wiring view of the same record

  // Assert — computable and low.
  assert.ok(ev.pbo && typeof ev.pbo.pbo === 'number');
  assert.ok(ev.pbo.pbo < evalLib.PBO_OVERFIT_THRESHOLD, `dominant-variant PBO should be low, got ${ev.pbo.pbo}`);
  assert.strictEqual(withPbo.pbo.verdictInput, 'pass');
  // The first 10 criteria are unchanged, and the verdict is NOT improved by low PBO.
  assert.deepStrictEqual(withPbo.criteria.slice(0, 10), withoutPbo.criteria);
  assert.strictEqual(withPbo.criteria.length, 11);
  assert.strictEqual(withPbo.promotable, withoutPbo.promotable);
  assert.strictEqual(withPbo.recommendedStatus, withoutPbo.recommendedStatus);
});

// ---- (c) missing data → byte-identical gate + honest stamp --------------------------------
test('PBO not computable → gate byte-identical to pre-wiring, stamped not-computable, never claimed passed', () => {
  // Arrange — no baseline column reaches the coverage floor → <2 variants → PBO null.
  const preds = variantFixture(96, 4, () => true).map((p) => ({ ...p, baselineProd: null }));

  // Act
  const ev = evalLib.evaluate(preds, { now: '2026-08-14' });
  const promo = evalLib.promotionCheck(ev, {});
  const preWiring = evalLib.promotionCheck({ ...ev, pbo: undefined }, {});

  // Assert — evaluate is honest about WHY.
  assert.strictEqual(ev.pbo.pbo, null);
  assert.ok(ev.pbo.reason, 'a null PBO always carries its reason');
  // The gate itself is byte-identical to pre-wiring: same 10 criteria, same counts.
  assert.strictEqual(promo.criteria.length, 10);
  assert.deepStrictEqual(
    { criteria: promo.criteria, passed: promo.passed, of: promo.of, promotable: promo.promotable, recommendedStatus: promo.recommendedStatus },
    { criteria: preWiring.criteria, passed: preWiring.passed, of: preWiring.of, promotable: preWiring.promotable, recommendedStatus: preWiring.recommendedStatus }
  );
  assert.ok(!promo.criteria.some((c) => /CSCV|PBO/i.test(c.name)), 'no PBO criterion may appear — a missing diagnostic is not a passed one');
  // …but the stamp says so, loudly.
  assert.strictEqual(promo.pbo.verdictInput, 'not-computable');
  assert.match(promo.pbo.note, /not computable/);
});

test('empty input: PBO stamp is not-computable and the gate still degrades gracefully', () => {
  const ev = evalLib.evaluate([], {});
  const promo = evalLib.promotionCheck(ev, {});
  assert.strictEqual(promo.promotable, false);
  assert.strictEqual(promo.criteria.length, 10);
  assert.strictEqual(promo.pbo.verdictInput, 'not-computable');
});

// ---- matrix construction honesty ----------------------------------------------------------
test('pboOverVariants drops uncovered variant columns (null-logged baselines) instead of nulling every date', () => {
  const preds = variantFixture(96, 4, (d) => Math.floor(d / 12) % 2 === 0);
  const out = evalLib.pboOverVariants(preds);
  // baselineOmega/baselineMomentum are logged null on the live path — they must be
  // dropped by coverage, not allowed to blank the whole matrix.
  assert.deepStrictEqual(out.variantKeys, ['residualScore', 'baselineProd']);
  assert.ok(typeof out.pbo === 'number');
});

test('pboOverVariants: dates with too few picks for a rank-IC fall out; too few surviving dates → null verdict', () => {
  // 1 pick per date → no per-date cross-section → every cell non-finite → pbo null.
  const preds = variantFixture(40, 1, () => true);
  const out = evalLib.pboOverVariants(preds);
  assert.strictEqual(out.pbo, null);
  assert.ok(out.reason, 'null verdict must carry its reason');
});

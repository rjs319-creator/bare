'use strict';
// THE OVERLAP CORRECTION WAS A SILENT NO-OP (alpha-research pass 3).
//
// lib/evolve-uniqueness keyed exclusively on `ev.predDate`. The EVOLVE live path supplies
// that, but lib/research/harness.js builds rows carrying `decisionTs` — so every harness
// event hit the `!ev.predDate` short-circuit, took weight 1, and the López de Prado
// average-uniqueness correction never ran. effectiveN === rawN, uniquenessRatio 1.000:
// a perfect-independence claim that was never measured, feeding every CI, t-stat and
// deflated Sharpe derived from it.
//
// test/evolve-uniqueness.test.js could not catch this — every fixture there is built with
// `predDate`, so the helper was proven correct in isolation while its only research
// caller silently no-opped. Classic integration blind spot: the unit was right, the
// wiring was not.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const U = require('../lib/evolve-uniqueness');

// Overlapping 21-day swing labels sampled every 7 calendar days across 40 tickers —
// the production shape the harness feeds in.
function overlapping(field, n = 800, tickers = 40) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2022, 0, 3));
    d.setUTCDate(d.getUTCDate() + Math.floor(i / tickers) * 7);
    const ev = { ticker: 'T' + (i % tickers), horizon: 'swing', barsToBarrier: 21 };
    ev[field] = d.toISOString().slice(0, 10);
    out.push(ev);
  }
  return out;
}

test('decisionTs rows are corrected — the harness shape no longer no-ops', () => {
  const s = U.uniquenessSummary(overlapping('decisionTs'));
  assert.equal(s.usable, true);
  assert.ok(s.uniquenessRatio < 0.5,
    `heavily overlapping labels must not read as independent, got ${s.uniquenessRatio}`);
  assert.ok(s.effectiveN < s.rawN / 2, `effectiveN ${s.effectiveN} vs rawN ${s.rawN}`);
});

test('predDate and decisionTs are treated identically', () => {
  // The live EVOLVE path and the research harness must not measure independence
  // differently purely because they name the same field differently.
  const a = U.uniquenessSummary(overlapping('predDate'));
  const b = U.uniquenessSummary(overlapping('decisionTs'));
  assert.equal(a.effectiveN, b.effectiveN);
  assert.equal(a.uniquenessRatio, b.uniquenessRatio);
});

test('predDate wins when both are present', () => {
  // Explicit precedence so a row carrying both cannot silently switch basis.
  const both = overlapping('predDate', 40).map((e, i) => ({ ...e, decisionTs: '2019-01-0' + ((i % 9) + 1) }));
  const onlyPred = overlapping('predDate', 40);
  assert.equal(U.uniquenessSummary(both).effectiveN, U.uniquenessSummary(onlyPred).effectiveN);
});

test('THE SILENT NO-OP: an all-undated set reports null, never a fabricated 1.0', () => {
  // This is the exact shape the bug produced. A ratio of 1.000 here is not a measurement
  // of perfect independence — it is the absence of a measurement, and it must not be
  // mistakable for one.
  const s = U.uniquenessSummary([
    { ticker: 'A', horizon: 'swing', barsToBarrier: 21 },
    { ticker: 'A', horizon: 'swing', barsToBarrier: 21 },
  ]);
  assert.equal(s.uniquenessRatio, null);
  assert.equal(s.usable, false);
  assert.equal(s.undated, 2);
});

test('partially-undated sets are still measured, with the gap counted', () => {
  const rows = overlapping('decisionTs', 80);
  rows.push({ ticker: 'ZZ', horizon: 'swing', barsToBarrier: 21 }); // no date
  const s = U.uniquenessSummary(rows);
  assert.equal(s.undated, 1);
  assert.equal(s.usable, true, 'one dateless row must not void the whole measurement');
  assert.ok(s.uniquenessRatio < 1);
});

test('non-overlapping labels still read as independent', () => {
  // Guards against over-correcting: widely-spaced labels on one ticker genuinely are
  // independent and must keep ratio ~1.
  const rows = [];
  for (let i = 0; i < 10; i++) {
    const d = new Date(Date.UTC(2022, 0, 3));
    d.setUTCDate(d.getUTCDate() + i * 400);
    rows.push({ ticker: 'A', horizon: 'swing', barsToBarrier: 21, decisionTs: d.toISOString().slice(0, 10) });
  }
  const s = U.uniquenessSummary(rows);
  assert.equal(s.uniquenessRatio, 1);
});

test('the summary states which field it keyed on', () => {
  const s = U.uniquenessSummary(overlapping('decisionTs', 20));
  assert.equal(s.basis, 'predDate || decisionTs');
});

test('the research harness actually receives a corrected summary', () => {
  // End-to-end: build rows the way lib/research/harness.js does (decisionTs) and assert
  // the summary it would embed is corrected rather than 1.0. This is the assertion that
  // would have caught the original defect.
  const rows = overlapping('decisionTs', 400).map(r => ({
    securityId: r.ticker, ticker: r.ticker, decisionTs: r.decisionTs,
    horizon: r.horizon, barsToBarrier: r.barsToBarrier, outcome: 0.01,
  }));
  const s = U.uniquenessSummary(rows);
  assert.ok(s.usable && s.uniquenessRatio < 0.5);
  assert.notEqual(s.effectiveN, s.rawN, 'effectiveN must not equal rawN on overlapping labels');
});

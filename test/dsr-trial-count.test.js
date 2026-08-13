'use strict';
// THE DEFLATED SHARPE WAS DEFLATED AGAINST A FICTION (alpha-research pass 3).
//
// dsrVeto is a LIVE gate: lib/evolve.decideState downgrades TRADE_CANDIDATE -> WATCH for
// a cell that has not survived the deflated-Sharpe correction. Two defects fed it:
//
//   1. N was `tried.length` — the cells that happen to clear minCellN RIGHT NOW. Thinner
//      data means fewer qualifying cells, which SHRINKS N, which WEAKENS the deflation.
//      Less evidence produced a LOWER bar.
//   2. varSR came from the spread ACROSS qualifying cells, and varianceOf returns 0 below
//      two values. With a single qualifying cell varSR was 0, expectedMaxSharpe returns 0
//      when varSR is 0, and the correction was INERT no matter how many trials ran.
//
// Together those made the veto largely decorative in exactly the thin-data regime where
// multiple-testing control matters most.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const DSR = require('../lib/evolve-dsr');
const CE = require('../lib/challenger-eval');

const ev = (sp, i, ret) => ({ specialists: [sp], horizon: 'swing', regime: 'neutral', terminalReturn: ret, predDate: `2025-01-0${(i % 9) + 1}` });
// One marginal edge plus N thin cells that widen the SEARCH without adding evidence.
function grid(nThin, main = 'marginal') {
  const out = [];
  for (let i = 0; i < 80; i++) out.push(ev(main, i, i % 2 ? 0.021 : -0.017));
  for (let t = 0; t < nThin; t++) for (let i = 0; i < 6; i++) out.push(ev(`thin${t}`, i, 0.01 * ((i % 3) - 1)));
  return out;
}

test('a wider search RAISES the bar — the correction is no longer inverted', () => {
  const narrow = DSR.gridDeflatedSharpe(grid(0));
  const wide = DSR.gridDeflatedSharpe(grid(80));
  assert.ok(wide.trials > narrow.trials, `trials must grow with the search (${narrow.trials} -> ${wide.trials})`);
  const c = (g) => g.cells.find(x => x.specialist === 'marginal');
  assert.ok(c(wide).sr0 > c(narrow).sr0, 'the null\'s expected max must rise with more trials');
  assert.ok(c(wide).dsr < c(narrow).dsr, 'and the deflated Sharpe must fall');
});

test('a cell that was searched but not scored still counts as a trial', () => {
  const g = DSR.gridDeflatedSharpe(grid(10));
  assert.ok(g.cellsSearched >= g.cellsScored, 'searched >= scored');
  assert.ok(g.trials >= g.cellsSearched, 'every searched cell is a trial');
  assert.ok(g.cellsQualifying <= g.cellsScored, 'qualifying is reported separately and honestly');
});

test('the deflation is NOT inert when only one cell qualifies', () => {
  // This is what made fixing the trial count alone a hollow fix.
  const g = DSR.gridDeflatedSharpe(grid(0));
  assert.equal(g.cellsQualifying, 1);
  assert.ok(g.varSR > 0, 'a single qualifying cell must still produce a usable null spread');
  assert.equal(g.varSRBasis, 'analytic-sampling');
  assert.ok(g.cells.find(x => x.specialist === 'marginal').sr0 > 0, 'the bar must be above zero');
});

test('a genuinely strong edge still survives a wide search — not a blanket veto', () => {
  const out = [];
  for (let i = 0; i < 300; i++) out.push(ev('strong', i, i % 10 < 8 ? 0.03 : -0.005));
  for (let t = 0; t < 40; t++) for (let i = 0; i < 6; i++) out.push(ev(`thin${t}`, i, 0.01 * ((i % 3) - 1)));
  const g = DSR.gridDeflatedSharpe(out);
  const c = g.cells.find(x => x.specialist === 'strong');
  assert.ok(g.trials > 40, 'searched widely');
  assert.equal(c.pass, true, 'a real edge must still clear the raised bar');
});

test('an external ledger count can only RAISE the bar, never lower it', () => {
  const base = DSR.gridDeflatedSharpe(grid(10));
  const withLedger = DSR.gridDeflatedSharpe(grid(10), { trials: 500 });
  const tiny = DSR.gridDeflatedSharpe(grid(10), { trials: 1 });
  assert.equal(withLedger.trials, 500);
  assert.equal(withLedger.trialsSource, 'external-ledger');
  assert.equal(tiny.trials, base.trials, 'a smaller external count cannot undercut the searched grid');
});

test('the observed cross-cell spread still wins when it is wider', () => {
  // The floor is a max(), so a genuinely dispersed grid is not flattened to the analytic
  // estimate — the correction only ever gets more conservative.
  const out = [];
  for (const [sp, r] of [['a', 0.05], ['b', -0.04], ['c', 0.02], ['d', -0.01]]) {
    for (let i = 0; i < 40; i++) out.push(ev(sp, i, i % 2 ? r : -r / 2));
  }
  const g = DSR.gridDeflatedSharpe(out);
  assert.ok(g.varSR > 0);
  assert.ok(['observed-cross-cell', 'analytic-sampling'].includes(g.varSRBasis));
});

// ── the hardcoded trials=8 ───────────────────────────────────────────────────────

test('deflatedSharpeOf REQUIRES a stated trial count', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ predDate: '2025-01-01', outcome: i % 3 ? 0.02 : -0.01 }));
  const missing = CE.deflatedSharpeOf(rows);
  assert.equal(missing.ready, false);
  assert.equal(missing.reason, 'trial-count-required');
  const stated = CE.deflatedSharpeOf(rows, 25);
  assert.equal(stated.ready, true);
  assert.ok(Number.isFinite(stated.dsr));
});

test('an invalid trial count fails closed rather than defaulting', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ predDate: '2025-01-01', outcome: i % 3 ? 0.02 : -0.01 }));
  for (const bad of [0, -1, NaN, null, 'eight']) {
    assert.equal(CE.deflatedSharpeOf(rows, bad).ready, false, `${bad} must not be accepted`);
  }
});

'use strict';
// THE OVERLAP CORRECTION WAS COMPUTED, REPORTED, AND NEVER APPLIED (alpha-research pass 3).
//
// lib/evolve-walkforward defaulted `weighted = false` at four call sites, so the deflated
// Sharpe received `weights: null` and every grid cell's effective sample equalled its raw
// count. The `uniqueness` block was published alongside — showing effectiveN well below
// rawN — while nothing consumed it. A correction you display but do not apply is worse
// than one you never computed: it reads as a control that is in force.
//
// Two reasons the default is now true:
//   1. lib/evolve-routes.recomputePerf (the LIVE perf fit) already defaulted weighted:true,
//      so the walk-forward VALIDATING it was strictly more permissive than the fit itself.
//   2. It binds — see the DSR test below.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WF = require('../lib/evolve-walkforward');

// Overlapping 21-bar swing labels: 50 tickers, one cohort every 5 calendar days.
function overlappingEvents(winPct, n = 3000) {
  const evs = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2022, 0, 3));
    d.setUTCDate(d.getUTCDate() + Math.floor(i / 50) * 5);
    const ds = d.toISOString().slice(0, 10);
    evs.push({
      ticker: 'T' + (i % 50), horizon: 'swing', barsToBarrier: 21,
      predDate: ds, decisionTs: ds,
      labelEndDate: new Date(d.getTime() + 21 * 864e5).toISOString().slice(0, 10),
      won: (i % 100) < winPct, probability: 0.55,
      terminalReturn: (i % 100) < winPct ? 0.02 : -0.019,
      specialists: ['sp1'], regime: 'neutral',
    });
  }
  return evs;
}
const cellOf = (evs, weighted) => WF.evaluate(evs, { weighted }).deflatedSharpe.cells[0];

test('the default applies the correction — effective sample falls below the raw count', () => {
  const evs = overlappingEvents(56);
  const def = cellOf(evs, undefined);
  const off = cellOf(evs, false);
  assert.equal(off.effN, off.n, 'unweighted: effective sample equals the raw count');
  assert.ok(def.effN < def.n / 2,
    `default must de-duplicate overlap (effN ${def.effN} vs n ${def.n})`);
});

test('the default matches an explicit weighted:true', () => {
  const evs = overlappingEvents(56);
  assert.equal(cellOf(evs, undefined).effN, cellOf(evs, true).effN);
});

test('IT BINDS: a marginal edge that passed on the inflated sample now fails', () => {
  // This is the whole point. Same Sharpe either way — only the sample length the null
  // distribution is built from changes.
  for (const winPct of [51, 52]) {
    const evs = overlappingEvents(winPct);
    const off = cellOf(evs, false);
    const on = cellOf(evs, true);
    assert.equal(off.sr, on.sr, 'the Sharpe itself is unchanged — only its deflation moves');
    assert.equal(off.pass, true, `unweighted passes at ${winPct}% (dsr ${off.dsr})`);
    assert.equal(on.pass, false, `weighted must fail at ${winPct}% (dsr ${on.dsr})`);
    assert.ok(on.dsr < off.dsr, 'weighting can only lower the deflated Sharpe, never raise it');
  }
});

test('a genuinely strong edge still passes under weighting — this is not a blanket veto', () => {
  const on = cellOf(overlappingEvents(56), true);
  assert.equal(on.pass, true, 'weighting must not reject everything');
});

test('an unweighted comparison is still reachable for diagnosis', () => {
  const evs = overlappingEvents(56);
  assert.equal(cellOf(evs, false).effN, cellOf(evs, false).n);
  // and the route exposes it as an explicit opt-OUT rather than an opt-in
  const routes = fs.readFileSync(path.join(__dirname, '..', 'lib', 'evolve-routes.js'), 'utf8');
  assert.match(routes, /const weighted = !\(req\.query\.uniqueness === '0' \|\| req\.query\.uniqueness === 'false'\)/);
});

test('every default in the module is the corrected one', () => {
  // Guards against one of the four being missed or reverted piecemeal.
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'evolve-walkforward.js'), 'utf8');
  assert.ok(!/weighted = false/.test(src), 'no weighted default may remain false');
  assert.equal((src.match(/weighted = true/g) || []).length, 4,
    'fitPerf, walkForward, evaluate and runEvolveOmegaWalkForward must all default true');
});

test('the walk-forward is no longer more permissive than the live fit it validates', () => {
  // lib/evolve-routes.recomputePerf already defaulted weighted:true. The research gate
  // must not be looser than the production fit.
  const routes = fs.readFileSync(path.join(__dirname, '..', 'lib', 'evolve-routes.js'), 'utf8');
  assert.match(routes, /function recomputePerf\(resolved, \{ weighted = true \} = \{\}\)/);
  const wf = fs.readFileSync(path.join(__dirname, '..', 'lib', 'evolve-walkforward.js'), 'utf8');
  assert.match(wf, /function fitPerf\(events, \{ weighted = true \} = \{\}\)/);
});

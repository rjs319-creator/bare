'use strict';
// WHAT `selected` MEANS IN THE RESEARCH CAPTURE (alpha-research pass 3).
//
// lib/atlasx-capture's `selected` cohort is what forward outcomes are compared against
// matched controls to produce SELECTION LIFT — so its definition is load-bearing for
// every number derived from the capture.
//
// It was `candidates.filter(c => c.actionable)`: the UTILITY gate alone (expected value,
// net-utility floor, prosecutor, R:R, staleness, applicability, liquidity, regime). That
// admitted names with NO valid entry (`entry.action: 'NO_TRADE'`) — names the board
// displayed under Avoid and the system could not have traded. Selection lift over that
// cohort answers "did utility-gate passers outperform?", not "did what we would have
// acted on outperform?".
//
// This is the same conflation #331 fixed for the shadow portfolio. Here it changes
// research-evidence lineage, so the cohort is SPLIT three ways rather than reclassified,
// and the basis is stamped on every capture.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../lib/atlasx-capture');
const P = require('../lib/atlasx-portfolio');

const item = (t, extra = {}) => ({ ticker: t, sector: 'Tech', beta: 1, vol: 0.02, liqTier: 'deep', momentum: 0.05, price: 10, ...extra });

const capture = () => C.buildCapture({
  date: '2026-08-12',
  selected: [item('ENTERABLE')],
  qualifiedNoEntry: [item('NOENTRY')],
  rejected: [item('FAILEDGATE', { reasonCode: 'stale-data' })],
  nearMiss: [item('NEAR')],
  controls: [item('CTRL')],
  todayCandidates: [item('ENTERABLE'), item('NOENTRY'), item('OTHER')],
  ctx: {},
});

test('the capture stamps the basis its `selected` cohort was built under', () => {
  // A stored capture must be self-describing: this definition CHANGED, and comparing
  // cohorts across that boundary without knowing would be silently wrong.
  const cap = capture();
  assert.match(cap.selectionBasis, /actionable AND enterable/);
});

test('a utility-passing name with no entry is neither selected nor rejected', () => {
  const cap = capture();
  const sel = cap.selected.map(x => x.ticker);
  const rej = cap.rejected.map(x => x.ticker);
  const qne = cap.qualifiedNoEntry.map(x => x.ticker);

  assert.deepEqual(sel, ['ENTERABLE'], 'selected = would have been acted on');
  assert.deepEqual(qne, ['NOENTRY'], 'cleared the gate, no valid entry');
  assert.deepEqual(rej, ['FAILEDGATE'], 'rejected = failed the utility gate');
  assert.ok(!sel.includes('NOENTRY'), 'must not inflate the selection-lift cohort');
  assert.ok(!rej.includes('NOENTRY'), 'must not be miscounted as a gate failure');
});

test('the three cohorts are disjoint — no name is double-counted', () => {
  const cap = capture();
  const all = [...cap.selected, ...cap.qualifiedNoEntry, ...cap.rejected].map(x => x.ticker);
  assert.equal(new Set(all).size, all.length);
});

test('matched controls are matched for the SELECTED cohort only', () => {
  // Controls exist to measure the selected cohort's lift; matching them against names
  // the system could not enter would dilute the very metric they support.
  const cap = capture();
  assert.equal(cap.matchedControls.length, cap.selected.length);
});

test('a name with no entry counts as NOT selected for the algo-comparison lane', () => {
  // Consequence worth pinning: currentAlgoNotSelected keys off `selected`, so a
  // utility-passing name without an entry now correctly appears there.
  const cap = capture();
  assert.deepEqual(cap.currentAlgoNotSelected.map(x => x.ticker).sort(), ['NOENTRY', 'OTHER']);
});

test('an omitted qualifiedNoEntry argument degrades to empty, never to undefined', () => {
  const cap = C.buildCapture({ date: 'd', selected: [item('A')], rejected: [], nearMiss: [], controls: [], todayCandidates: [], ctx: {} });
  assert.deepEqual(cap.qualifiedNoEntry, []);
});

// ── the route must use the SHARED rule, not a second definition ──────────────────

test('the route splits the cohort using the portfolio module\'s enterable rule', () => {
  const routes = fs.readFileSync(path.join(__dirname, '..', 'lib', 'atlasx-routes.js'), 'utf8');
  assert.match(routes, /const \{ isEnterable \} = require\('\.\/atlasx-portfolio'\)/,
    'one definition of "enterable", shared with the portfolio gate');
  assert.match(routes, /const utilityPassed = candidates\.filter\(c => c\.actionable\)/);
  assert.match(routes, /const actionable = utilityPassed\.filter\(c => isEnterable/);
  assert.match(routes, /const qualifiedNoEntry = utilityPassed\.filter\(c => !isEnterable/);
  assert.match(routes, /selected: actionable\.map\(controlKey\)/);
  assert.match(routes, /qualifiedNoEntry: qualifiedNoEntry\.map\(controlKey\)/);
});

test('the portfolio still receives the FULL utility-passing set so omissions stay explained', () => {
  // #331's contract: every omission carries a reason. Pre-filtering to the enterable set
  // here would make unenterable names vanish from the excluded panel instead of showing
  // up as `no-entry-trigger`.
  const routes = fs.readFileSync(path.join(__dirname, '..', 'lib', 'atlasx-routes.js'), 'utf8');
  assert.match(routes, /buildAtlasPortfolio\(utilityPassed\.map\(rankRow\)/);

  const p = P.buildAtlasPortfolio([
    { ticker: 'IN', expert: 'e1', sector: 'Tech', rank: 1, score: 90, liquidity: { dollarVol: 1e7 }, entryAction: 'ENTER_NEXT_OPEN' },
    { ticker: 'OUT', expert: 'e2', sector: 'Energy', rank: 2, score: 89, liquidity: { dollarVol: 1e7 }, entryAction: 'NO_TRADE' },
  ], {});
  assert.deepEqual(p.positions.map(x => x.ticker), ['IN']);
  assert.equal((p.excluded.find(e => e.ticker === 'OUT') || {}).reason, 'no-entry-trigger');
});

test('the enterable rule has ONE definition, shared by portfolio and capture paths', () => {
  assert.ok(Array.isArray(P.ENTERABLE_ENTRY_ACTIONS));
  assert.equal(P.isEnterable({ entryAction: 'ENTER_NEXT_OPEN' }), true);
  assert.equal(P.isEnterable({ entryAction: 'WAIT_BREAKOUT' }), false);
  assert.equal(P.isEnterable({ entryAction: 'NO_TRADE' }), false);
  assert.equal(P.isEnterable({}), false, 'missing action fails closed');
});

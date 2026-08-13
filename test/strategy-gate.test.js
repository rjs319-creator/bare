'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../lib/strategy-gate');

// ── the gate: production may trade, everything else may not ──────────────────
test('isTradeEligible: only production strategies are trade-eligible', () => {
  const registry = [
    { id: 'prod', maturity: 'production' },
    { id: 'shadow', maturity: 'shadow' },
    { id: 'exp', maturity: 'experimental' },
    { id: 'rej', maturity: 'rejected' },
  ];
  assert.equal(gate.isTradeEligible('prod', registry), true);
  assert.equal(gate.isTradeEligible('shadow', registry), false);
  assert.equal(gate.isTradeEligible('exp', registry), false);
  assert.equal(gate.isTradeEligible('rej', registry), false);
});

// quant-redesign-3: the historic fail-OPEN default ('omitted maturity ⇒ production')
// was the audit's headline defect (H1) — an author could grant live-trade eligibility
// by doing nothing. Omission now fails CLOSED like every other unknown state; the
// backbone screeners carry EXPLICIT maturity: 'production' in the registry instead.
test('statusOf: omitted maturity fails CLOSED to shadow (never silently production)', () => {
  const registry = [{ id: 'core' }];   // no maturity field
  assert.equal(gate.statusOf('core', registry), 'shadow');
  assert.equal(gate.isTradeEligible('core', registry), false);
});

test('every registry entry carries an EXPLICIT, valid maturity (no defaults in play)', () => {
  const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');
  for (const e of STRATEGY_REGISTRY) {
    assert.ok(gate.STATUSES.includes(e.maturity), `${e.id} must declare explicit maturity, got ${e.maturity}`);
  }
});

test('every SIGNAL registry entry carries a scoringVersion (governance version guard input)', () => {
  const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');
  for (const e of STRATEGY_REGISTRY.filter(x => x.kind === 'signal')) {
    assert.ok(typeof e.scoringVersion === 'string' && e.scoringVersion.length > 0,
      `${e.id} must declare scoringVersion`);
  }
});

test('statusOf: unregistered id fails CLOSED (shadow), never trade-eligible', () => {
  assert.equal(gate.statusOf('does-not-exist', []), 'shadow');
  assert.equal(gate.isTradeEligible('does-not-exist', []), false);
});

test('normalizeStatus: an unknown/typo maturity fails CLOSED to shadow', () => {
  // A copy-edit typo must NEVER accidentally grant live-trade eligibility.
  const registry = [{ id: 'oops', maturity: 'promoted-yesterday!!' }];
  assert.equal(gate.statusOf('oops', registry), 'shadow');
  assert.equal(gate.isTradeEligible('oops', registry), false);
});

// ── the actual registered state of the options overlays ─────────────────────
test('SAFETY: optionsflow + putsell are registered SHADOW (not trade-eligible)', () => {
  assert.equal(gate.statusOf('optionsflow'), 'shadow');
  assert.equal(gate.statusOf('putsell'), 'shadow');
  assert.equal(gate.isTradeEligible('optionsflow'), false);
  assert.equal(gate.isTradeEligible('putsell'), false);
});

test('the production backbone screeners remain trade-eligible', () => {
  // ghost and downday were demoted 2026-08-11, and `custom` (the learned Apex ranking)
  // on 2026-08-12 — see the next test. `screener` is now the ONLY non-Day-Trade
  // strategy this app will put weight behind.
  for (const id of ['screener', 'daytrade']) {
    assert.equal(gate.isTradeEligible(id), true, `${id} must stay trade-eligible`);
  }
  // ignition was demoted to shadow (graduation-league RT-09/F3/F-13): it held
  // production maturity with future-tense criteria and no promotion artifact —
  // the exact state this test's own comment said should not exist.
  assert.equal(gate.isTradeEligible('ignition'), false, 'ignition is shadow until its criteria are actually met');
});

test('exactly one non-Day-Trade strategy carries live weight, and it is named', () => {
  // Stated rather than left implicit: after three demotions the live non-Day-Trade
  // surface is a single strategy. If a fourth is promoted or `screener` is demoted,
  // this fails and forces the change to be acknowledged.
  const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');
  const DT = /^(daytrade|gapgo|gapdown|ignition|lowfloat|intraday)/;
  const live = STRATEGY_REGISTRY
    .filter(e => e.kind === 'signal' && !DT.test(e.id) && gate.isTradeEligible(e.id))
    .map(e => e.id);
  assert.deepEqual(live, ['screener']);
});

test('2026-08-12 demotion: the learned Apex ranking (custom) is SHADOW', () => {
  // Brief §2 named it for zeroing, and the repo record agrees on its own terms: no
  // registered hypothesis, no cost-net Scoreboard record (section:null — its drift
  // panel measures rank stability, not edge), and a 625-candidate weight search
  // (lib/recalibrate.js: 5 offsets x 4 pillars) whose trials are never ledgered or
  // deflated the way lib/promotion-gate deflates Day-Trade model trials.
  assert.equal(gate.statusOf('custom'), 'shadow');
  assert.equal(gate.isTradeEligible('custom'), false);
  const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');
  const e = STRATEGY_REGISTRY.find(x => x.id === 'custom');
  assert.match(e.note, /DEMOTED from production 2026-08-12/);
  assert.match(e.criteria, /hypothesis-registry/, 'the way back must start with a written claim');
});

test('2026-08-11 demotion: ghost and downday are SHADOW — the ledger contradicted the status', () => {
  // downday: A-downday-exact-contract-2026-08 ran at the FROZEN PRODUCTION contract
  //   (lib/downday.classify, next-open, matched same-date/liquidity controls) and
  //   returned lift -0.04%, CI95 [-0.16, +0.08], 254 dates, 0/4 positive blocks,
  //   BH q 0.52 -> NOT PROMOTED. Identical at base/doubled/stressed costs: no signal,
  //   not a cost-eaten one.
  // ghost: hypothesis `quiet-accumulation-standalone` is no-edge against a 12-1
  //   momentum baseline, and ghost x screener return correlation ~0.96 means it was
  //   duplicating the Breakout sleeve rather than diversifying it.
  assert.equal(gate.statusOf('downday'), 'shadow', 'downday must be shadow');
  // ghost was subsequently RETIRED (2026-08-13, owner decision, weekly disposition
  // cycle 1): duplicate of the screener — measured independence credit 0.248,
  // corr ~0.96, and its historical insider evidence carries a filing-date look-ahead.
  assert.equal(gate.statusOf('ghost'), 'rejected', 'ghost must be retired (rejected)');
  for (const id of ['ghost', 'downday']) {
    assert.equal(gate.isTradeEligible(id), false, `${id} must not originate or boost a live trade`);
  }
});

test('a demoted strategy keeps a note and a written way back', () => {
  // The registry's own convention: a governed entry states what it is and what would
  // change its status. A demotion without criteria is a dead end, not a decision.
  const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');
  const dd = STRATEGY_REGISTRY.find(x => x.id === 'downday');
  assert.match(dd.note, /DEMOTED from production 2026-08-11/, 'downday must record the demotion');
  assert.ok(dd.criteria && dd.criteria.length > 80, 'downday must state what would earn promotion back');
  assert.match(dd.criteria, /NEW prospective/, 'downday must require fresh evidence');
  // ghost's status moved on (RETIRED 2026-08-13) but the same convention holds:
  // the entry records the decision, its date, and the written way back.
  const gh = STRATEGY_REGISTRY.find(x => x.id === 'ghost');
  assert.match(gh.note, /RETIRED .*2026-08-13/, 'ghost must record the retirement decision and date');
  assert.ok(gh.criteria && gh.criteria.length > 80, 'ghost must keep a written way back');
  assert.match(gh.criteria, /NEW prospective/, 'un-retiring requires fresh evidence, not a re-read');
});

test('2026-08 reconciliation: gapgo/coil/biotech are SHADOW — evidence and registration now agree', () => {
  // Gap & Go: unproven prospective challenger on a daily-close proxy ledger.
  // Coil: abnormal-expansion watchlist detector; trade utility (Stage B) unproven.
  // Biotech: lead-only research system; only its episode lane grades executable fills.
  for (const id of ['gapgo', 'coil', 'biotech']) {
    assert.equal(gate.statusOf(id), 'shadow', `${id} must be shadow`);
    assert.equal(gate.isTradeEligible(id), false, `${id} must not be trade-eligible`);
  }
});

test('previously-unregistered screeners are now registered shadow with contracts', () => {
  const SC = require('../lib/strategy-contracts');
  for (const id of ['trendrider', 'aligned', 'confluence']) {
    assert.equal(gate.statusOf(id), 'shadow', `${id} must be registered shadow`);
    const c = SC.contractFor(id);
    assert.ok(c, `${id} must have an outcome contract`);
    assert.equal(c.fillVerified, false, `${id} grading is a proxy — fillVerified must be false`);
  }
});

test('momentum-v2 reset to SHADOW: the rebuilt contract (intraday, price/volume universe) does not inherit v1 evidence', () => {
  // Predictive-redesign defects #14/#15: the scanner was rebuilt (universe + horizon), so
  // its production maturity — earned under the mismatched momentum-v1 1m contract — resets.
  assert.equal(gate.statusOf('momentum'), 'shadow');
  assert.equal(gate.isTradeEligible('momentum'), false);
});

test('PROMOTION_GATE documents the bar and is frozen (not editable at runtime)', () => {
  assert.equal(gate.PROMOTION_GATE.minResolvedEpisodes, 50);
  assert.ok(Object.isFrozen(gate.PROMOTION_GATE));
});

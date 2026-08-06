'use strict';
// Three INDEPENDENT horizons: the frozen Day Trade engine is projected read-only, the
// swing board cannot promote a research signal, the long-term model is its own thing,
// and no horizon silently reuses another's conclusion.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const DT = require('../lib/tech-command-daytrade');
const SW = require('../lib/tech-command-swing');
const LT = require('../lib/tech-command-longterm');
const DOS = require('../lib/tech-command-dossier');
const TAX = require('../lib/tech-command-taxonomy');

function universeOf(specs) {
  const recs = specs.map(s => TAX.classifySecurity({
    symbol: s.ticker, company: s.company || `${s.ticker} Inc`, sector: 'Technology',
    industry: s.industry || 'Software - Application', marketCap: s.marketCap || 1e10, isActivelyTrading: true,
  }, { asOf: '2026-08-05T00:00:00Z', applyOverlay: false }));
  const byTicker = Object.fromEntries(recs.map(r => [r.ticker, r]));
  const bySubsector = TAX.groupBySubsector(recs);
  return { byTicker, bySubsector, securities: recs };
}

const universe = universeOf([
  { ticker: 'AAAA', industry: 'Semiconductors' },
  { ticker: 'BBBB', industry: 'Software - Application' },
  { ticker: 'CCCC', industry: 'Semiconductors' },
]);

// ── Day trade ───────────────────────────────────────────────────────────────
const dtPayload = {
  ok: true, readOnly: true, strategyVersion: 'daytrade-early-runner-v2', generatedAt: '2026-08-05T14:30:00Z',
  session: 'regular',
  lanes: {
    actionableNow: [{ ticker: 'AAAA', lifecycleState: 'ACTIONABLE_NOW', actionable: true, currentPrice: 100, dayChangePct: 4.2, relVol: 3.1, aboveVwap: true, livePlan: { entry: 100, stop: 97, target: 106, trigger: 99.5, expiresAt: '2026-08-05T18:00:00Z' }, currentSessionFresh: true, explanation: 'trigger confirmed', setupId: 's1', execution: { gate: { blocked: false, reasons: [] }, spreadStatus: 'unknown', cost: { roundTripBps: 18 } } }],
    armed: [{ ticker: 'BBBB', lifecycleState: 'ARMED', actionable: false, currentPrice: 50, relVol: 1.8, aboveVwap: true, originalPlan: { entry: 51, stop: 49, target: 55 } }],
    retiredToday: [{ ticker: 'CCCC', lifecycleState: 'FAILED', actionable: false, currentPrice: 20, explanation: 'stop breached' }],
  },
  bestOpportunities: [{ ticker: 'ZZZZ', lifecycleState: 'ACTIONABLE_NOW', actionable: true }],   // non-technology
};

test('the day-trade projection is read-only and preserves the engine lifecycle verbatim', () => {
  const b = DT.projectDaytradeBoard({ payload: dtPayload, universe, now: new Date('2026-08-05T15:00:00Z') });
  assert.equal(b.readOnly, true);
  assert.equal(b.authority, 'read-only-projection');
  const a = b.rows.find(r => r.ticker === 'AAAA');
  assert.equal(a.lifecycleState, 'ACTIONABLE_NOW', 'the engine state must survive unchanged');
  assert.equal(a.action, 'TRIGGERED');
  assert.equal(b.rows.find(r => r.ticker === 'BBBB').action, 'READY');
  assert.equal(b.rows.find(r => r.ticker === 'CCCC').action, 'INVALIDATED');
});

test('non-technology names are filtered out and counted', () => {
  const b = DT.projectDaytradeBoard({ payload: dtPayload, universe });
  assert.ok(!b.rows.some(r => r.ticker === 'ZZZZ'));
  assert.equal(b.droppedNonTech, 1);
});

test('technology-relative numbers are ANNOTATIONS and never change the decision', () => {
  const withAnn = DT.projectDaytradeBoard({
    payload: dtPayload, universe,
    annotations: { AAAA: { rsVsQqqPct: -9, rsVsSubsectorPct: -12, asOf: '2026-08-05' } },
  });
  const without = DT.projectDaytradeBoard({ payload: dtPayload, universe });
  const a1 = withAnn.rows.find(r => r.ticker === 'AAAA');
  const a2 = without.rows.find(r => r.ticker === 'AAAA');
  assert.equal(a1.action, a2.action, 'a badly-negative annotation changed the frozen decision');
  assert.equal(a1.lifecycleState, a2.lifecycleState);
  assert.match(a1.techAnnotations.note, /do not modify it/i);
});

test('an unavailable Day Trade source produces an explicit data-gap reason, not a silent all-clear', () => {
  const b = DT.projectDaytradeBoard({ payload: null, universe });
  assert.equal(b.empty, true);
  assert.match(b.emptyReason, /data gap, not an all-clear/i);
});

test('alerts fire only on meaningful transitions, never on unchanged states', () => {
  const prior = DT.projectDaytradeBoard({ payload: dtPayload, universe });
  const same = DT.projectDaytradeBoard({ payload: dtPayload, universe, priorProjection: prior });
  assert.equal(same.transitions.length, 0, 'an unchanged board must not emit transitions');

  const advanced = JSON.parse(JSON.stringify(dtPayload));
  advanced.lanes.armed[0].lifecycleState = 'ACTIONABLE_NOW';
  const next = DT.projectDaytradeBoard({ payload: advanced, universe, priorProjection: prior });
  const t = next.transitions.find(x => x.ticker === 'BBBB');
  assert.equal(t.to, 'TRIGGERED');
  assert.equal(t.kind, 'trigger-confirmed');
  assert.equal(t.alertable, true);
});

// ── Swing ───────────────────────────────────────────────────────────────────
const swingBase = {
  ticker: 'AAAA', company: 'AAAA Inc', side: 'long', entry: 100, stop: 95, target: 115, price: 100.5,
  rr: 3, score: 71, percentile: 88, signalClass: 'ACTIONABLE', sizingEligible: true,
  state: 'triggered', stateHint: 'triggered', sources: ['screener'], catalyst: 'product launch',
};
const ctx = { AAAA: { rsVsQqq21: 6, rsVsSubsector21: 3, dollarVolume: 5e7, atrPct: 3, earningsInDays: 40, asOf: '2026-08-05' } };

test('ENTER requires cleared evidence, sizing eligibility, freshness, liquidity, a trigger and a complete plan', () => {
  const ok = SW.buildSwingBoard({ signals: [swingBase], universe, context: ctx });
  assert.equal(ok.rows[0].action, 'ENTER');
  assert.deepEqual(ok.rows[0].gatesFailed, []);

  const cases = [
    [{ sizingEligible: false }, 'not sizing-eligible'],
    [{ stateHint: null, state: 'watching', price: 90 }, 'trigger has not occurred'],
    [{ target: null }, 'trade plan is incomplete'],
    [{ retainedLabel: 'DATA_STALE' }, null],
  ];
  for (const [patch] of cases) {
    const r = SW.buildSwingBoard({ signals: [{ ...swingBase, ...patch }], universe, context: ctx });
    assert.notEqual(r.rows[0].action, 'ENTER', `ENTER survived ${JSON.stringify(patch)}`);
  }
});

test('a RESEARCH signal can never become an actionable recommendation', () => {
  const b = SW.buildSwingBoard({ signals: [{ ...swingBase, signalClass: 'RESEARCH' }], universe, context: ctx });
  const r = b.rows[0];
  assert.equal(r.action, 'WATCH');
  assert.equal(r.demotedFrom !== null, true, 'the demotion must be recorded, not hidden');
  assert.equal(r.signalClass, 'RESEARCH');
});

test('a QUALIFIED_LEAD is capped at READY', () => {
  const b = SW.buildSwingBoard({ signals: [{ ...swingBase, signalClass: 'QUALIFIED_LEAD' }], universe, context: ctx });
  assert.equal(b.rows[0].action, 'READY');
});

test('stale inputs demote the row and say so', () => {
  const b = SW.buildSwingBoard({ signals: [{ ...swingBase, retainedLabel: 'DATA_STALE' }], universe, context: ctx });
  assert.equal(b.rows[0].action, 'WATCH');
  assert.match(b.rows[0].removalReason, /stale/i);
});

test('a price already far beyond the entry becomes DO_NOT_CHASE', () => {
  const b = SW.buildSwingBoard({ signals: [{ ...swingBase, price: 112 }], universe, context: ctx });
  assert.equal(b.rows[0].action, 'DO_NOT_CHASE');
});

test('an earnings print inside the blackout blocks a fresh entry', () => {
  const b = SW.buildSwingBoard({
    signals: [swingBase], universe,
    context: { AAAA: { ...ctx.AAAA, earningsInDays: 1 } },
  });
  assert.notEqual(b.rows[0].action, 'ENTER');
  assert.ok(b.rows[0].gatesFailed.some(g => /blackout/.test(g)));
});

test('no picks are forced — an honest empty state is produced instead', () => {
  const b = SW.buildSwingBoard({ signals: [], universe, context: {} });
  assert.equal(b.empty, true);
  assert.match(b.emptyReason, /never forced/i);
  assert.equal(b.featured.length, 0);
});

test('the swing board is ranked by the upstream governed score, not by tech-relative evidence', () => {
  assert.match(SW.SWING_VIEW_VERSION, /swing/);
  const b = SW.buildSwingBoard({
    signals: [
      { ...swingBase, ticker: 'AAAA', score: 40 },
      { ...swingBase, ticker: 'BBBB', score: 90 },
    ],
    universe,
    context: { AAAA: { ...ctx.AAAA, rsVsQqq21: 50 }, BBBB: { ...ctx.AAAA, rsVsQqq21: -50 } },
  });
  assert.equal(b.rows[0].ticker, 'BBBB', 'tech-relative strength must not re-rank the board');
  assert.equal(b.rows[0].evidence.usedForRanking, false);
  assert.match(b.rankBasis, /negative ranking IC/);
});

test('a published name that drops out of the scan is retained with a reason, never deleted', () => {
  const first = SW.buildSwingBoard({ signals: [swingBase], universe, context: ctx });
  const second = SW.buildSwingBoard({ signals: [], universe, context: {}, priorBoard: first });
  const carried = second.rows.find(r => r.ticker === 'AAAA');
  assert.ok(carried, 'the name silently disappeared');
  assert.equal(carried.persisted, true);
  assert.ok(carried.removalReason);
});

test('no swing row ever carries a probability', () => {
  const b = SW.buildSwingBoard({ signals: [swingBase], universe, context: ctx });
  assert.equal(b.rows[0].probability, null);
  assert.match(b.rows[0].probabilityNote, /No out-of-sample calibration/);
});

// ── Long term ───────────────────────────────────────────────────────────────
const ltStrong = {
  ticker: 'AAAA',
  fundamentals: { revGrowth: 40, epsGrowth: 55, revAccel: 6, epsAccel: 4, marginExpanding: true, opMarginTTM: 34, opMarginBase: 28, pe: 40, earningsDate: '2026-08-25', earningsInDays: 20 },
  trend: { trend: 'bullish', score: 8, composite: 0.8, reasons: ['Above the 200-day'], factors: { sma200: 80 }, insufficient: false },
  context: { rsVsQqq126: 20, rsVsSubsector126: 8, asOf: '2026-08-05' },
  revisions: { period: '2026-08-01', strongBuy: 20, buy: 10, hold: 3, sell: 0, strongSell: 0, prev: { strongBuy: 15, buy: 10, hold: 5, sell: 1, strongSell: 0 } },
};

test('the long-term model is distinct from the swing model and has its own actions', () => {
  const b = LT.buildLongTermBoard({ candidates: [ltStrong], universe });
  assert.notEqual(LT.LONGTERM_VIEW_VERSION, SW.SWING_VIEW_VERSION);
  assert.ok(LT.ACTIONS.includes(b.rows[0].action));
  assert.ok(!SW.ACTIONS.includes(b.rows[0].action), 'the two vocabularies must not overlap');
});

test('sparse fundamentals produce INSUFFICIENT_DATA rather than a confident verdict', () => {
  const b = LT.buildLongTermBoard({ candidates: [{ ticker: 'BBBB', fundamentals: null, trend: null, context: null }], universe });
  assert.equal(b.rows[0].action, 'INSUFFICIENT_DATA');
  assert.ok(b.rows[0].dataCompletenessPct < 100);
});

test('a rich multiple downgrades ACCUMULATE to WATCH_VALUATION', () => {
  const rich = { ...ltStrong, fundamentals: { ...ltStrong.fundamentals, pe: 300, epsGrowth: 20 } };
  const b = LT.buildLongTermBoard({ candidates: [rich], universe });
  assert.ok(['WATCH_VALUATION', 'HOLD', 'THESIS_WEAKENING'].includes(b.rows[0].action));
});

test('analyst revisions are PIT_UNPROVEN, weight zero, and cannot lift the action', () => {
  const withRev = LT.buildLongTermBoard({ candidates: [ltStrong], universe });
  const withoutRev = LT.buildLongTermBoard({ candidates: [{ ...ltStrong, revisions: null }], universe });
  assert.equal(withRev.revisionsStatus, 'PIT_UNPROVEN');
  assert.equal(withRev.rows[0].revisions.affectsRanking, false);
  assert.equal(withRev.rows[0].score, withoutRev.rows[0].score, 'revisions moved the score');
  assert.equal(withRev.rows[0].action, withoutRev.rows[0].action);
});

test('unavailable long-term factors are named, not estimated', () => {
  const b = LT.buildLongTermBoard({ candidates: [ltStrong], universe });
  const names = b.unavailableFactors.map(f => f.factor);
  for (const f of ['free-cash-flow quality', 'return on invested capital', 'net cash / debt', 'stock-based compensation']) {
    assert.ok(names.includes(f), `${f} must be declared unavailable`);
  }
  assert.ok(b.unavailableFactors.every(f => f.reason));
});

test('the long-term score is never labeled a return probability', () => {
  const b = LT.buildLongTermBoard({ candidates: [ltStrong], universe });
  assert.equal(b.probability, null);
  assert.match(b.probabilityNote, /NOT a return probability/i);
  assert.match(b.scoreLabel, /uncalibrated/);
  assert.equal(b.rows[0].probability, null);
});

test('the long-term board does not force picks', () => {
  const b = LT.buildLongTermBoard({ candidates: [], universe });
  assert.equal(b.empty, true);
  assert.match(b.emptyReason, /never forced/i);
});

// ── Horizon separation ──────────────────────────────────────────────────────
test('one stock can hold three DIFFERENT conclusions at once, and the dossier shows all three', () => {
  const daytrade = DT.projectDaytradeBoard({
    payload: { ok: true, readOnly: true, lanes: { tooExtended: [{ ticker: 'AAAA', lifecycleState: 'TOO_EXTENDED', currentPrice: 130 }] } },
    universe,
  });
  const swing = SW.buildSwingBoard({ signals: [swingBase], universe, context: ctx });
  const longterm = LT.buildLongTermBoard({ candidates: [ltStrong], universe });

  assert.equal(daytrade.rows[0].action, 'AVOID');
  assert.equal(swing.rows[0].action, 'ENTER');
  assert.equal(longterm.rows[0].action, 'ACCUMULATE');

  const dossier = DOS.buildDossier({
    ticker: 'AAAA',
    snapshot: { universe, daytrade, swing, longterm, events: null, scenarios: {}, options: null, sentiment: null, readthrough: null, lifecycle: {} },
  });
  assert.equal(dossier.intraday.action, 'AVOID');
  assert.equal(dossier.swing.action, 'ENTER');
  assert.equal(dossier.longterm.action, 'ACCUMULATE');
  assert.ok(dossier.contradictions.length > 0, 'a three-way disagreement must surface as a contradiction');
});

test('alignment is information only and cannot raise conviction', () => {
  const daytrade = DT.projectDaytradeBoard({ payload: dtPayload, universe });
  const swing = SW.buildSwingBoard({ signals: [swingBase], universe, context: ctx });
  const longterm = LT.buildLongTermBoard({ candidates: [ltStrong], universe });
  const a = DOS.buildAlignment({ daytrade, swing, longterm });
  assert.equal(a.affectsConviction, false);
  assert.match(a.policy, /INFORMATION ONLY/);
  const row = a.rows.find(r => r.ticker === 'AAAA');
  assert.equal(row.horizonsPresent, 3);
});

test('the dossier refuses a ticker outside the technology universe', () => {
  const d = DOS.buildDossier({ ticker: 'XOM', snapshot: { universe, daytrade: { rows: [] }, swing: { rows: [] }, longterm: { rows: [] } } });
  assert.equal(d.found, false);
  assert.match(d.reason, /not in the technology universe/i);
});

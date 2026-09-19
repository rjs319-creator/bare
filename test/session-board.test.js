'use strict';
// lib/session-board — pure session-aware opportunity board: phase, time frame, grade rubric,
// checklist honesty (never fabricate), assembly ordering and held-out handling.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const SB = require('../lib/session-board');

// ── sessionPhase ────────────────────────────────────────────────────────────
test('sessionPhase: premarket / regular / afterhours / closed transitions on a trading day', () => {
  const pre = SB.sessionPhase(new Date('2026-09-18T12:30:00Z'));   // 08:30 ET Fri
  assert.equal(pre.phase, 'premarket');
  assert.equal(pre.minutesToOpen, 60);
  assert.deepEqual(pre.nextTransition, { phase: 'regular', at: '2026-09-18T13:30:00.000Z' });
  const reg = SB.sessionPhase(new Date('2026-09-18T15:00:00Z'));   // 11:00 ET
  assert.equal(reg.phase, 'regular');
  assert.equal(reg.minutesToClose, 300);
  assert.equal(reg.nextTransition.phase, 'afterhours');
  const post = SB.sessionPhase(new Date('2026-09-18T21:00:00Z'));  // 17:00 ET
  assert.equal(post.phase, 'afterhours');
  assert.equal(post.nextTransition.at, '2026-09-19T00:00:00.000Z');
  const late = SB.sessionPhase(new Date('2026-09-19T01:00:00Z'));  // 21:00 ET Fri
  assert.equal(late.phase, 'closed');
  assert.equal(late.isTradingDay, true);
  assert.equal(late.nextTransition.phase, 'premarket');
  assert.equal(late.nextTransition.at, '2026-09-21T08:00:00.000Z'); // Monday 04:00 ET
});

test('sessionPhase: weekend, holiday and early close', () => {
  const sat = SB.sessionPhase(new Date('2026-09-19T14:00:00Z'));
  assert.equal(sat.phase, 'closed');
  assert.match(sat.label, /weekend/i);
  assert.equal(sat.isTradingDay, false);
  assert.equal(sat.minutesToOpen, 2850);   // Sat 10:00 ET → Mon 09:30 ET
  const hol = SB.sessionPhase(new Date('2026-11-26T15:00:00Z'));   // Thanksgiving
  assert.equal(hol.phase, 'closed');
  assert.match(hol.label, /holiday/i);
  const early = SB.sessionPhase(new Date('2026-11-27T18:30:00Z')); // 13:30 ET day after
  assert.equal(early.phase, 'afterhours');
  assert.equal(early.isEarlyClose, true);
  assert.equal(early.nextTransition.at, '2026-11-27T22:00:00.000Z'); // 17:00 ET
  const preDawn = SB.sessionPhase(new Date('2026-09-18T07:00:00Z')); // 03:00 ET
  assert.equal(preDawn.phase, 'closed');
  assert.equal(preDawn.nextTransition.phase, 'premarket');
  assert.equal(preDawn.minutesToOpen, 390);
});

test('sessionPhase: DST — the ET→UTC conversion follows the offset in force', () => {
  assert.equal(SB.etWallToUtc('2026-01-15', 9 * 60 + 30).toISOString(), '2026-01-15T14:30:00.000Z');
  assert.equal(SB.etWallToUtc('2026-07-15', 9 * 60 + 30).toISOString(), '2026-07-15T13:30:00.000Z');
});

// ── timeframeFor ────────────────────────────────────────────────────────────
test('timeframeFor: plain-English labels + hold window per horizon, swing fallback', () => {
  assert.deepEqual(SB.timeframeFor({ horizon: 'intraday' }), { key: 'intraday', label: 'Intraday (today)', holdWindow: 'Same session — exit by close' });
  assert.equal(SB.timeframeFor({ horizon: 'swing' }).label, 'Days to weeks');
  assert.equal(SB.timeframeFor({ horizon: 'position' }).label, 'Weeks to months');
  assert.equal(SB.timeframeFor({ horizon: 'portfolio' }).label, 'Long term');
  assert.equal(SB.timeframeFor({ horizon: 'weird', holdWindow: 'x' }).holdWindow, 'x');
  assert.equal(SB.timeframeFor({}).key, 'swing');
});

// ── gradeItem ───────────────────────────────────────────────────────────────
const ROW = { id: 'screener:swing:ABC', ticker: 'ABC', section: 'screener', tier: 'Setup', scope: 'large', horizon: 'swing', side: 'long',
  price: 100, entry: 101, stop: 95, target: 115, rr: 2.3, confidence: 70, remainingEdge: { fraction: 0.9 },
  breadth: { litCount: 6, of: 8 }, catalyst: 'earnings beat', liquidity: { dollarVol: 50e6 }, sectorStrength: 0.8 };
const GOV_WEIGHTED = { strategies: [{ id: 'screener', section: 'screener', grade: 'validated', weight: 0.5 }] };
const GOV_PAPER = { strategies: [{ id: 'screener', section: 'screener', grade: 'promising', weight: 0 }] };

test('gradeItem: rubric weights, A when everything lines up and governance carries weight', () => {
  const g = SB.gradeItem({ row: ROW, live: { status: 'in-zone' }, premarket: { gapPct: 2, preRelVol: 0.5 }, regime: { riskOn: true }, maturityGrade: 'validated', governance: GOV_WEIGHTED });
  assert.equal(g.letter, 'A');
  assert.ok(g.score >= 80, `score ${g.score}`);
  const expected = Math.round(0.35 * g.components.evidence + 0.35 * g.components.setup + 0.20 * g.components.live + 0.10 * g.components.regime);
  assert.equal(g.rawScore, expected);
  assert.deepEqual(g.caps, []);
  assert.ok(g.why.some((w) => /validated/.test(w)));
});

test('gradeItem: no governance weight caps at B and says so', () => {
  const g = SB.gradeItem({ row: ROW, live: { status: 'in-zone' }, premarket: { gapPct: 2, preRelVol: 0.5 }, regime: { riskOn: true }, maturityGrade: 'validated', governance: GOV_PAPER });
  assert.equal(g.letter, 'B');
  assert.ok(g.score <= 79);
  assert.ok(g.caps.some((c) => c.rule === 'no-validated-edge' && c.appliedMax === 'B'));
  assert.ok(g.why.includes(SB.NO_EDGE_WHY));
});

test('gradeItem: negative lane → held out, max D', () => {
  const lanes = [{ key: 'screener:Setup:large', section: 'screener', tier: 'Setup', scope: 'large', reason: 'screener:Setup:large: CI-negative' }];
  const g = SB.gradeItem({ row: ROW, live: { status: 'in-zone' }, regime: { riskOn: true }, maturityGrade: 'validated', governance: GOV_WEIGHTED, negativeLanes: lanes });
  assert.equal(g.heldOut, true);
  assert.equal(g.letter, 'D');
  assert.ok(g.why.some((w) => /Held out/.test(w)));
});

test('gradeItem: stop hit → F; extended → max C; long in risk-off drops one letter', () => {
  const stopped = SB.gradeItem({ row: ROW, live: { status: 'stopped' }, regime: { riskOn: true }, maturityGrade: 'validated', governance: GOV_WEIGHTED });
  assert.equal(stopped.letter, 'F');
  const ext = SB.gradeItem({ row: ROW, live: { status: 'extended' }, regime: { riskOn: true }, maturityGrade: 'validated', governance: GOV_WEIGHTED });
  assert.equal(ext.letter, 'C');
  const off = SB.gradeItem({ row: ROW, live: { status: 'in-zone' }, premarket: { gapPct: 2, preRelVol: 0.5 }, regime: { riskOff: true, label: 'Risk-off' }, maturityGrade: 'validated', governance: GOV_WEIGHTED });
  assert.ok(off.components.regime <= 20);
  assert.ok(off.caps.some((c) => c.rule === 'long-in-risk-off'));
  const shortOff = SB.gradeItem({ row: { ...ROW, side: 'short', sectorStrength: -0.8 }, live: { status: 'in-zone' }, regime: { riskOff: true }, maturityGrade: 'validated', governance: GOV_WEIGHTED });
  assert.equal(shortOff.components.regime, 100);
  assert.ok(!shortOff.caps.some((c) => c.rule === 'long-in-risk-off'));
});

test('gradeItem: unmeasured evidence scores 50, disabled 0; no-trade density halves regime', () => {
  const un = SB.gradeItem({ row: { ...ROW, confidence: null }, governance: GOV_PAPER });
  assert.equal(un.components.evidence, 50);
  assert.ok(un.why.some((w) => /unmeasured/.test(w)));
  const dis = SB.gradeItem({ row: { ...ROW, confidence: null }, maturityGrade: 'disabled', governance: GOV_PAPER });
  assert.equal(dis.components.evidence, 0);
  const nt = SB.gradeItem({ row: ROW, regime: { riskOn: true }, governance: GOV_PAPER, density: { decision: 'no-trade' } });
  assert.equal(nt.components.regime, 50);
  assert.ok(nt.why.some((w) => /no-trade/.test(w)));
});

test('gradeItem: premarket gap in the trade direction — modest is good, >15% is extended', () => {
  const { gapScore } = SB._components;
  assert.equal(gapScore(3, 0.5, false), 90);
  assert.equal(gapScore(12, null, false), 50);
  assert.equal(gapScore(20, null, false), 25);
  assert.equal(gapScore(-4, null, false), 40);
  assert.equal(gapScore(-4, null, true), 80);   // a gap DOWN is in a short's direction
  assert.equal(gapScore(null, 1, false), null);
});

// ── checks: never fabricate ─────────────────────────────────────────────────
test('buildChecks: absent inputs → value null, ok null, label present', () => {
  const checks = SB.buildChecks({ row: { ticker: 'X', section: 's', tier: 't', horizon: 'swing' }, live: null, premarket: null, regime: null });
  const keys = checks.map((c) => c.key);
  for (const k of ['gapPct', 'preRelVol', 'relVol', 'catalyst', 'toEntry', 'toStop', 'toTarget', 'vwap', 'orb', 'atrPct', 'sectorStrength', 'shortInterest', 'float', 'dilution', 'earningsSoon', 'regime']) assert.ok(keys.includes(k), k);
  for (const c of checks) {
    assert.ok(typeof c.label === 'string' && c.label.length);
    if (c.key !== 'regime') { assert.equal(c.value, null, c.key); assert.equal(c.ok, null, c.key); }
  }
});

test('buildChecks: levels are read from the live/premarket price, direction-aware', () => {
  const checks = SB.buildChecks({ row: ROW, live: { status: 'in-zone', vwap: { value: 99, above: true }, orb: { high: 102, low: 98, state: 'breakout-up' }, relVol: 2.1 }, premarket: { gapPct: 2, preRelVol: 0.3, preMarketPrice: 100 }, regime: { riskOn: true } });
  const by = Object.fromEntries(checks.map((c) => [c.key, c]));
  assert.equal(by.toEntry.value, 1); assert.equal(by.toEntry.ok, true);
  assert.equal(by.toStop.value, -5); assert.equal(by.toStop.ok, true);
  assert.equal(by.toTarget.value, 15); assert.equal(by.toTarget.ok, true);
  assert.equal(by.vwap.value, 'above'); assert.equal(by.vwap.ok, true);
  assert.equal(by.orb.ok, true);
  assert.equal(by.relVol.ok, true);
  assert.equal(by.gapPct.ok, true);
  assert.equal(by.regime.value, 'risk-on');
  const short = SB.buildChecks({ row: { ...ROW, side: 'short', entry: 99, stop: 105, target: 85 }, live: { vwap: { value: 101, above: true } }, premarket: { gapPct: -3, preMarketPrice: 100 }, regime: { riskOff: true } });
  const sb = Object.fromEntries(short.map((c) => [c.key, c]));
  assert.equal(sb.vwap.ok, false);
  assert.equal(sb.gapPct.ok, true);
  assert.equal(sb.toStop.ok, true);
  assert.equal(sb.regime.ok, true);
});

// ── assembleSessionBoard ────────────────────────────────────────────────────
const TODAY = {
  horizons: { intraday: [], swing: [ROW], position: [], portfolio: [] },
  researchByHorizon: { intraday: [{ ...ROW, id: 'gapdown:intraday:PMI', ticker: 'PMI', section: 'GapDown', tier: 'MODERATE', horizon: 'intraday', side: 'short', confidence: 51 }], swing: [ROW], position: [], portfolio: [] },
};
const DAYTRADE = [
  { ticker: 'SDGR', sector: 'Health Care', scan: 'momentum_run', tier: 'A', lifecycleState: 'STALLING', entry: 29.5, stop: 25.2, target: 38, rr: 2, relVol: 1.05, gapPct: -3, avgDollarVol: 47e6, last: 29.49 },
  { ticker: 'IOVA', sector: 'Health Care', scan: 'momentum_run', tier: 'B', lifecycleState: 'BUILDING', entry: 10, stop: 9, target: 13, rr: 3, relVol: 2.4, gapPct: 1, avgDollarVol: 30e6, last: 10.1, actionable: false },
];
const PREMARKET = {
  asOf: '2026-09-18T12:30:00Z', session: 'premarket',
  rows: [{ ticker: 'ABC', prevClose: 100, preMarketPrice: 102, preMarketChangePct: 2, preRelVol: 0.4 }, { ticker: 'GAPR', prevClose: 10, preMarketPrice: 11.2, preMarketChangePct: 12, preRelVol: 0.9 }],
  gapLane: [{ ticker: 'GAPR', gapPct: 12, preRelVol: 0.9, direction: 'up', prevClose: 10, preMarketPrice: 11.2 }, { ticker: 'ABC', gapPct: 2, preRelVol: 0.4, direction: 'up', prevClose: 100, preMarketPrice: 102 }],
};

test('assembleSessionBoard: merges today + active daytrade + gap lane, dedups, orders by grade then phase time frame', () => {
  const b = SB.assembleSessionBoard({ now: new Date('2026-09-18T12:30:00Z'), todayRows: TODAY, daytradeRows: DAYTRADE, premarket: PREMARKET,
    liveByTicker: { ABC: { status: 'in-zone' } }, regime: { riskOn: true }, governance: GOV_PAPER, maturityBySection: { screener: 'promising' } });
  assert.equal(b.ok, true);
  assert.equal(b.version, 'session-board-v1');
  assert.equal(b.session.phase, 'premarket');
  const tickers = b.items.map((i) => i.ticker);
  assert.ok(tickers.includes('ABC') && tickers.includes('PMI') && tickers.includes('IOVA') && tickers.includes('GAPR'));
  assert.ok(!tickers.includes('SDGR'), 'retired lifecycle state is not on the board');
  assert.equal(tickers.filter((t) => t === 'ABC').length, 1, 'ABC appears once even though the gap lane has it too');
  for (let i = 1; i < b.items.length; i++) assert.ok(b.items[i - 1].grade.score >= b.items[i].grade.score);
  assert.deepEqual(b.timeframeOrder, ['intraday', 'swing', 'position', 'portfolio']);
  const abc = b.items.find((i) => i.ticker === 'ABC');
  assert.equal(abc.timeframe.label, 'Days to weeks');
  assert.equal(abc.premarket.gapPct, 2);
  assert.equal(abc.levels.prevClose, 100);
  assert.equal(abc.live.status, 'in-zone');
  assert.ok(abc.grade.letter === 'B' || abc.grade.letter === 'C');
  const gapr = b.items.find((i) => i.ticker === 'GAPR');
  assert.equal(gapr.source, 'premarket-gap');
  assert.equal(gapr.horizon, 'intraday');
  assert.equal(gapr.levels.entry, null, 'no plan is invented for a gap-lane name');
  const iova = b.items.find((i) => i.ticker === 'IOVA');
  assert.equal(iova.source, 'daytrade');
  assert.equal(iova.lifecycleState, 'BUILDING');
  assert.equal(iova.live.status, 'unknown');
  assert.equal(b.counts.items, b.items.length);
  assert.equal(b.empty, false);
  assert.deepEqual(Object.keys(b.byTimeframe), ['intraday', 'swing', 'position', 'portfolio']);
  assert.ok(b.disclosure.length > 40);
});

test('assembleSessionBoard: held-out lanes leave items and land in heldOut; closed phase leads with swing', () => {
  const lanes = [{ key: 'screener:Setup:large', section: 'screener', tier: 'Setup', scope: 'large', reason: 'proven negative' }];
  const b = SB.assembleSessionBoard({ now: new Date('2026-09-19T14:00:00Z'), todayRows: TODAY, negativeLanes: lanes, governance: GOV_PAPER, regime: { riskOn: true } });
  assert.ok(!b.items.some((i) => i.ticker === 'ABC'));
  assert.equal(b.heldOut.length, 1);
  assert.equal(b.heldOut[0].flags.heldOut, true);
  assert.equal(b.heldOut[0].grade.letter, 'D');
  assert.deepEqual(b.timeframeOrder, ['swing', 'position', 'portfolio', 'intraday']);
  assert.equal(b.session.phase, 'closed');
  assert.match(b.items[0].live.note, /market closed/);
});

test('assembleSessionBoard: empty inputs → empty:true, no items, market/density carried when present', () => {
  const b = SB.assembleSessionBoard({ now: new Date('2026-09-18T15:00:00Z'), todayRows: null, density: { decision: 'no-trade', decisionLabel: 'No trade', maxExposurePct: 0, score: 3 }, market: { mode: { mode: 'TWO_WAY_CHOP' }, indexes: { SPY: { dayReturnPct: -0.12 } }, marketDataAsOf: '2026-09-18T14:55:00Z' } });
  assert.equal(b.empty, true);
  assert.deepEqual(b.items, []);
  assert.equal(b.market.mode, 'TWO_WAY_CHOP');
  assert.equal(b.market.spyChangePct, -0.12);
  assert.equal(b.market.density.decision, 'no-trade');
  assert.equal(b.counts.byGrade.A, 0);
});

test('assembleSessionBoard: does not mutate its inputs', () => {
  const rows = JSON.parse(JSON.stringify(TODAY));
  const dt = JSON.parse(JSON.stringify(DAYTRADE));
  SB.assembleSessionBoard({ now: new Date('2026-09-18T12:30:00Z'), todayRows: rows, daytradeRows: dt, premarket: PREMARKET, governance: GOV_PAPER });
  assert.deepEqual(rows, TODAY);
  assert.deepEqual(dt, DAYTRADE);
});

'use strict';
// PSRL engine scenario tests — the eight required leadership scenarios plus
// determinism, point-in-time invariance and the episode ledger. All fixtures
// are deterministic synthetic paths; no network, no credentials.

const test = require('node:test');
const assert = require('node:assert');

const { runPsrl, buildCard } = require('../lib/psrl/engine');
const EP = require('../lib/psrl/episodes');

// ── fixtures ────────────────────────────────────────────────────────────────

const N = 280;
function mk(rets, { start = 100, gapAt = -1, gap = 0 } = {}) {
  const out = []; let c = start;
  const d0 = Date.parse('2025-01-01T00:00:00Z');
  for (let i = 0; i < rets.length; i++) {
    const date = new Date(d0 + i * 86400000).toISOString().slice(0, 10);
    let o = c; if (i === gapAt) o = c * (1 + gap);
    const nc = c * (1 + rets[i]);
    out.push({ date, open: o, high: Math.max(o, nc) * 1.002, low: Math.min(o, nc) * 0.998, close: nc, volume: nc > o ? 1.5e6 : 1e6 });
    c = nc;
  }
  return out;
}

// Rising market with variance (so betas are estimable): mean +7.5bp/session.
const spyR = Array.from({ length: N }, (_, i) => (i % 2 ? -0.0035 : 0.005));
const SPY = mk(spyR);
// Sector ETF: market + 100bp/63d sector tailwind + tiny idio wiggle.
const secR = spyR.map((r, i) => r + 0.001 + (i % 2 ? -0.0005 : 0.0005));
const SEC = mk(secR);

const R = {
  steady: spyR.map((r) => r + 0.0025),                                   // gradual true leader
  plateau: spyR.map((r, i) => (i === N - 40 ? 0.18 : i > N - 40 ? r - 0.0008 : r)),
  holding: spyR.map((r, i) => (i === N - 40 ? 0.18 : i > N - 40 ? 0.0003 : r)),
  passenger: spyR.map((r) => 1.5 * r - 0.0002),                          // high-beta market passenger
  lowBetaLeader: spyR.map((r) => 0.5 * r + 0.0012),                      // low-beta true leader
  sectorPassenger: secR.slice(),                                          // rides the sector exactly
  sectorLeader: secR.map((r) => r + 0.001),                               // beats sector and market
  losing: spyR.map((r, i) => (i >= N - 21 ? 0 : r + 0.002)),             // price stalls while SPY runs
};

function rowsOf(names) {
  return names.map((k) => ({
    ticker: k.toUpperCase(),
    sector: (k === 'sectorPassenger' || k === 'sectorLeader') ? 'Technology' : null,
    candles: mk(R[k], k === 'plateau' || k === 'holding' ? { gapAt: N - 40, gap: 0.17 } : {}),
    sectorCandles: (k === 'sectorPassenger' || k === 'sectorLeader') ? SEC : null,
  }));
}

const ASOF = SPY[SPY.length - 1].date;
const SNAP = runPsrl({
  rows: rowsOf(['steady', 'plateau', 'holding', 'passenger', 'lowBetaLeader', 'sectorPassenger', 'sectorLeader', 'losing']),
  spyCandles: SPY, asOf: ASOF,
});
const card = (t) => SNAP.cards.find((c) => c.ticker === t.toUpperCase());

// ── 1. steady advance vs jump plateau ───────────────────────────────────────

test('scenario 1: equal-gain steady advance ranks materially above the jump-plateau', () => {
  const a = card('steady'), b = card('plateau');
  assert.strictEqual(a.absPath.state, 'STEADY_ADVANCE');
  assert.strictEqual(b.absPath.state, 'JUMP_PLATEAU');
  assert.ok(b.continuity.w63.concentration.top1Share > 0.45, 'jump concentration detected');
  assert.ok(a.continuity.w63.concentration.top1Share < 0.1, 'steady path is unconcentrated');
  assert.ok(a.scores.combinedAfterPenalties >= b.scores.combinedAfterPenalties + 15,
    `steady must rank materially higher (${a.scores.combinedAfterPenalties} vs ${b.scores.combinedAfterPenalties})`);
  assert.ok(b.penalties.some((p) => p.code === 'JUMP_PLATEAU'));
  assert.ok(a.rank < b.rank);
});

// ── 2. jump-holding vs dead plateau ─────────────────────────────────────────

test('scenario 2: constructive consolidation retaining higher lows is not classified dead', () => {
  const h = card('holding');
  assert.notStrictEqual(h.absPath.state, 'JUMP_PLATEAU');
  assert.ok(['JUMP_HOLDING', 'JUMP_CONTINUING'].includes(h.absPath.state), h.absPath.state);
  assert.ok(!h.penalties.some((p) => p.code === 'JUMP_PLATEAU'));
});

// ── 3 + 4. high-beta passenger vs low-beta true leader ──────────────────────

test('scenario 3: a beta-1.5 stock rising as expected gets no strong residual leadership', () => {
  const d = card('passenger');
  assert.ok(Math.abs(d.residual.beta - 1.5) < 0.15, `beta estimated ≈1.5, got ${d.residual.beta}`);
  assert.ok(d.residual.byHorizon[63].marketRel > 0, 'raw excess return IS positive (the trap)');
  assert.ok(d.residual.byHorizon[63].residual <= 0.005, 'residual strips the beta carry');
  assert.strictEqual(d.quadrant, 'MARKET_CARRIED_LAGGARD');
});

test('scenario 4: low-beta stock exceeding its beta-adjusted expectation ranks above the passenger', () => {
  const e = card('lowBetaLeader'), d = card('passenger');
  assert.ok(Math.abs(e.residual.beta - 0.5) < 0.15, `beta ≈0.5, got ${e.residual.beta}`);
  assert.ok(e.residual.byHorizon[63].residual > d.residual.byHorizon[63].residual + 0.02,
    'residual leadership favors the low-beta true leader');
  assert.ok(e.rank < d.rank, 'and it ranks above the market passenger');
  assert.ok(e.scores.relativeLeadership > d.scores.relativeLeadership);
});

// ── 5 + 6. sector tailwind vs sector leader ─────────────────────────────────

test('scenario 5: rising exactly with its sector earns no company-specific sector leadership', () => {
  const f = card('sectorPassenger');
  assert.ok(Math.abs(f.residual.byHorizon[63].sectorRel) < 0.02, 'sector-relative return ≈ 0');
  assert.ok(Math.abs(f.residual.byHorizon[63].residual) < 0.02, 'two-factor residual ≈ 0');
});

test('scenario 6: persistent outperformance of both SPY and sector qualifies as true leader', () => {
  const g = card('sectorLeader');
  assert.ok(g.residual.byHorizon[63].sectorRel > 0.03);
  assert.ok(g.residual.byHorizon[63].residual > 0.02);
  assert.strictEqual(g.quadrant, 'TRUE_LEADER');
  assert.ok(g.sectorDataAvailable);
});

// ── 7. defensive leader (separate declining-market universe) ────────────────

test('scenario 7: falling less than a falling market is DEFENSIVE watch, never a buy', () => {
  const spy2R = Array.from({ length: N }, (_, i) => (i % 2 ? -0.005 : 0.0026));
  const SPY2 = mk(spy2R);
  const h = mk(spy2R.map((r) => r + 0.0008));
  const snap = runPsrl({ rows: [{ ticker: 'DEF', candles: h, sector: null, sectorCandles: null }], spyCandles: SPY2, asOf: SPY2[SPY2.length - 1].date });
  const c = snap.cards[0];
  assert.ok(c.trend.byHorizon[63].totalReturn < 0, 'absolute trend is down');
  assert.ok(c.residual.byHorizon[63].marketRel > 0, 'but it held up better than SPY');
  assert.strictEqual(c.quadrant, 'DEFENSIVE_LEADER');
  assert.strictEqual(c.entry.state, 'DEFENSIVE_WATCH');
  assert.ok(!String(c.entry.state).startsWith('BUY'));
});

// ── 8. losing leadership ────────────────────────────────────────────────────

test('scenario 8: relative arrows downgrade before the absolute trend breaks', () => {
  const i = card('losing');
  assert.ok(['DOWN', 'DOWN2'].includes(i.arrows.vsMarket), `vs-market arrow weak, got ${i.arrows.vsMarket}`);
  assert.ok(i.arrows.price !== 'DOWN2', 'absolute trend has not hard-broken yet');
  assert.ok(i.residual.byHorizon[21].marketRel < 0, '21-session market-relative already negative');
});

// ── determinism + PIT invariants ────────────────────────────────────────────

test('ranking is deterministic: identical inputs produce identical snapshots', () => {
  const again = runPsrl({
    rows: rowsOf(['steady', 'plateau', 'holding', 'passenger', 'lowBetaLeader', 'sectorPassenger', 'sectorLeader', 'losing']),
    spyCandles: SPY, asOf: ASOF,
  });
  assert.strictEqual(JSON.stringify(again), JSON.stringify(SNAP));
});

test('no future data: asOf slicing equals physically truncated history', () => {
  const cut = SPY[220].date;
  const full = buildCard({ ticker: 'AAA', candles: mk(R.steady), sector: null, sectorCandles: null, spyCandles: SPY, asOf: cut, prevCard: null });
  const trunc = buildCard({
    ticker: 'AAA', candles: mk(R.steady).filter((b) => b.date <= cut), sector: null, sectorCandles: null,
    spyCandles: SPY.filter((b) => b.date <= cut), asOf: cut, prevCard: null,
  });
  assert.strictEqual(full.scores.combinedAfterPenalties, trunc.scores.combinedAfterPenalties);
  assert.strictEqual(full.quadrant, trunc.quadrant);
  assert.strictEqual(full.absPath.state, trunc.absPath.state);
});

test('insufficient history abstains instead of guessing', () => {
  const short = mk(R.steady.slice(0, 60));
  const c = buildCard({ ticker: 'SHRT', candles: short, sector: null, sectorCandles: null, spyCandles: SPY.slice(0, 60), asOf: SPY[59].date, prevCard: null });
  assert.strictEqual(c.available, false);
  assert.strictEqual(c.entry.state, 'INSUFFICIENT_EVIDENCE');
  assert.ok(c.eligibility.reasons.includes('INSUFFICIENT_HISTORY'));
});

test('missing sector data is a support downgrade, never neutral-zero', () => {
  const a = card('steady');
  assert.strictEqual(a.sectorDataAvailable, false);
  assert.strictEqual(a.residual.byHorizon[63].sectorRel, null, 'unknown, not 0');
  assert.strictEqual(a.arrows.vsSector, null, 'sector arrow renders as missing');
  assert.strictEqual(a.support.grade, 'REDUCED');
  assert.ok(a.support.reasons.includes('SECTOR_DATA_MISSING'));
});

test('no probabilities anywhere: utilities are BASELINE_UNCALIBRATED', () => {
  const a = card('steady');
  for (const h of ['h5', 'h21', 'h63']) {
    assert.strictEqual(a.utility[h].basis, 'BASELINE_UNCALIBRATED');
    assert.strictEqual(a.utility[h].calibrationStatus, 'uncalibrated');
  }
  assert.strictEqual(SNAP.governanceStatus, 'shadow');
  assert.strictEqual(SNAP.weight, 0);
});

// ── episode ledger ──────────────────────────────────────────────────────────

test('ledger: admission, idempotency, hard invalidation and right-censoring', () => {
  const { ledger: led1, transitions: t1 } = EP.applyDay(EP.emptyLedger(), SNAP);
  assert.ok(t1.some((t) => t.to === 'NEW'), 'qualifying leaders admitted');
  const steadyEp = led1.episodes.STEADY;
  assert.ok(steadyEp, 'steady leader has an episode');
  assert.strictEqual(steadyEp.rightCensored, true, 'active episode is censored, not graded');
  assert.strictEqual(steadyEp.startDate, ASOF);

  // Re-applying the same day is a no-op (idempotent by construction).
  const again = EP.applyDay(led1, SNAP);
  assert.strictEqual(again.idempotent, true);
  assert.strictEqual(again.ledger, led1);

  // Next day: the steady name hard-breaks → immediate INVALIDATED + terminal.
  const nextDate = '2025-12-31';
  const brokenCards = SNAP.cards.map((c) => (c.ticker === 'STEADY'
    ? { ...c, absPath: { ...c.absPath, state: 'TREND_BROKEN' }, disqualified: true }
    : c));
  const { ledger: led2, transitions: t2 } = EP.applyDay(led1, { ...SNAP, asOf: nextDate, cards: brokenCards });
  assert.ok(!led2.episodes.STEADY, 'closed episodes leave the active set');
  const closed = led2.closed.find((e) => e.symbol === 'STEADY');
  assert.strictEqual(closed.status, 'INVALIDATED');
  assert.strictEqual(closed.terminalEvent, 'ABSOLUTE_TREND_BREAK');
  assert.strictEqual(closed.rightCensored, false);
  assert.ok(t2.some((t) => t.ticker === 'STEADY' && t.to === 'INVALIDATED' && t.reason === 'HARD_INVALIDATION'));

  // Original ledger untouched (immutability).
  assert.ok(led1.episodes.STEADY, 'input ledger was not mutated');
});

test('ledger: research surface reports accrual only, never interim metrics', () => {
  const { experimentStatus } = require('../lib/psrl/research');
  const { ledger } = EP.applyDay(EP.emptyLedger(), SNAP);
  const s = experimentStatus({ ledger });
  assert.ok(s.registry.every((e) => e.familyId === 'swing-ranking'));
  assert.ok(s.accrual.activeEpisodes >= 1);
  const flat = JSON.stringify(s);
  assert.ok(!/"ic"|"rankIC"|"tStat"/i.test(flat), 'no interim ICs are ever revealed');
});

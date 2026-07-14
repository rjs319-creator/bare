'use strict';
// EVOLVE — HISTORICAL BACKFILL (seed-from-history, leakage-safe)
//
// EVOLVE's forward ledger accrues one day at a time, so it would sit dormant (abstaining)
// for weeks before any triple-barrier outcome resolves. This replays the app's PROVEN
// point-in-time machinery — `screenTicker` on historical candle slices (the exact pattern
// lib/backfill.js / lib/research.js / lib/ghost-backtest.js use) — to reconstruct which
// specialists fired at each historical cohort date, then labels each with a REAL
// triple-barrier outcome computed only from subsequent bars. That populates specialist
// performance across regimes immediately, so the live ensemble's probabilities are
// grounded in history from day one.
//
// Leakage safety: every reconstruction uses `candles.slice(0, idx+1)` (only bars up to the
// cohort date) and every label uses only bars AFTER it. Cohort dates leave ≥ the longest
// hold of forward data so nothing is scored on an unfinished window.
//
// Honest coverage: only the two specialists that are (a) faithfully reconstructable from
// screenTicker and (b) backed by the app's own factor research get backfilled —
// momentumIgnition (breakout / emerging-leader; momentum IC ~0.10) and quietAccumulation
// (accumRatio + up/down-volume footprint; IC ~0.07–0.10). Compression/VCP is deliberately
// NOT backfilled (the app's research found base/VCP/dry-up dead for raw-% prediction);
// catalyst / read-through / rotation specialists have no clean point-in-time reconstruction
// here and accrue forward-only. This is documented in the returned stats.

const { fetchDailyHistory, screenTicker } = require('./screener');
const { LARGE, SMALL_CAPS, MICRO_CAPS } = require('./universe');
const { buildMacroLookup } = require('./macro');
const L = require('./evolve-labels');
const E = require('./evolve');

const BACKFILL_VERSION = 'evolve-backfill-v1';
const MAX_HOLD = 63;                 // longest barrier window → forward bars every cohort must have
const BARRIERS = { fast: L.barriersFor('fast'), swing: L.barriersFor('swing'), position: L.barriersFor('position') };

// GICS sector name (from screenTicker's SECTOR_OF) → sector SPDR ETF, for sector-relative labels.
const SECTOR_ETF = {
  'Technology': 'XLK', 'Information Technology': 'XLK', 'Financials': 'XLF', 'Financial Services': 'XLF',
  'Health Care': 'XLV', 'Healthcare': 'XLV', 'Energy': 'XLE', 'Industrials': 'XLI',
  'Consumer Discretionary': 'XLY', 'Consumer Cyclical': 'XLY', 'Consumer Staples': 'XLP', 'Consumer Defensive': 'XLP',
  'Materials': 'XLB', 'Basic Materials': 'XLB', 'Real Estate': 'XLRE', 'Utilities': 'XLU',
  'Communication Services': 'XLC',
};
const SECTOR_ETFS = [...new Set(Object.values(SECTOR_ETF))];

// Which specialists fired at this point-in-time screenTicker result. Both conditions use
// only fields screenTicker computes from the sliced (past-only) candles.
function specialistsFiring(r) {
  const fired = [];
  // momentumIgnition — a confirmed breakout or an early momentum-emergence leg.
  if (r.emergingLeader || r.qualifies) fired.push('momentumIgnition');
  // quietAccumulation — accumulation footprint BEFORE the breakout (not already qualified):
  // strong accumRatio + up-vol dominance while holding the 200-DMA.
  const m = r.metrics || {};
  if (!r.qualifies && m.accumRatio >= 1.3 && m.udVol >= 1.0 && r.aboveSma200) fired.push('quietAccumulation');
  return fired;
}

// Bounded-concurrency map (mirrors lib/backfill.js's worker pool).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch { out[k] = null; } } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Replay history and produce resolved triple-barrier labels. Pure of storage — returns the
// additions ({id: label}) + stats; the route merges them into the resolved ledger and
// recomputes specialist performance. `now` is injected (ISO date) to avoid a clock dep.
async function runEvolveBackfill({ scope = 'large', limit = 80, step = 21, months = 18, deadlineMs = 50000, now = null, volAdjust = false, range = '2y' } = {}) {
  const t0 = Date.now();
  const list = scope === 'micro' ? MICRO_CAPS : scope === 'small' ? SMALL_CAPS : LARGE;
  const tickers = (limit > 0 ? list.slice(0, limit) : list).slice();

  // Benchmarks: SPY (for spyByDate + SPY-relative) and the sector ETFs (sector-relative).
  const spy = await fetchDailyHistory('SPY', range).catch(() => null);
  if (!spy) return { additions: {}, stats: { error: 'no SPY history', version: BACKFILL_VERSION } };
  const spyCandles = spy.candles;
  const spyByDate = {}; spyCandles.forEach(x => { spyByDate[x.date] = x.close; });
  const sectorCandles = {};
  await mapLimit(SECTOR_ETFS, 6, async (sym) => { const d = await fetchDailyHistory(sym, range).catch(() => null); if (d) sectorCandles[sym] = d.candles; });

  const macro = await buildMacroLookup(range).catch(() => null);
  const regimeAt = (date) => { const s = macro && macro.at(date); return (s && s.regime) || 'neutral'; };

  // Ticker candle histories (bounded concurrency).
  const hist = new Map();
  await mapLimit(tickers, 6, async (t) => { const d = await fetchDailyHistory(t, range).catch(() => null); if (d) hist.set(t, { candles: d.candles, meta: { ...d.meta, symbol: t } }); });

  // Cohort date axis from SPY: every `step` trading days over the trailing `months`,
  // leaving MAX_HOLD bars of forward data so even POSITION resolves.
  const span = Math.min(spyCandles.length - 1, Math.round((months / 12) * 252));
  const dates = [];
  for (let k = span; k >= MAX_HOLD; k -= step) dates.push(spyCandles[spyCandles.length - 1 - k].date);

  const additions = {};
  const stat = { rows: 0, byHorizon: { fast: 0, swing: 0, position: 0 }, bySpecialist: {}, byRegime: {}, wins: 0, deadlineHit: false };
  const bump = (obj, k) => { obj[k] = (obj[k] || 0) + 1; };

  outer:
  for (const date of dates) {
    const regimeLabel = regimeAt(date);
    for (const [t, { candles, meta }] of hist) {
      if (Date.now() - t0 > deadlineMs) { stat.deadlineHit = true; break outer; }
      // Point-in-time index (last bar on/before the cohort date).
      let idx = -1;
      for (let k = candles.length - 1; k >= 0; k--) { if (candles[k].date <= date) { idx = k; break; } }
      if (idx < 200 || candles.length - 1 - idx < MAX_HOLD) continue;   // need history + forward bars
      const r = screenTicker(candles.slice(0, idx + 1), meta, { spyByDate });
      if (!r) continue;
      const fired = specialistsFiring(r);
      if (!fired.length) continue;

      const entry = candles[idx].close;
      const cap = E.capBucket(r.factors && r.factors.dollarVol);
      const etf = SECTOR_ETF[r.sector];
      const secC = etf ? sectorCandles[etf] : null;
      const contribs = fired.map(s => ({ specialist: s, p: 0.4 }));   // placeholder P (perf uses win/n)
      // Point-in-time ATR% (from past-only candles via screenTicker) → optional vol-adjusted
      // barriers so a quiet name and a jumpy name are judged on comparable, tradeable moves.
      const atrPct = (volAdjust && r.factors && Number.isFinite(r.factors.atr) && entry > 0) ? r.factors.atr / entry : null;

      for (const h of L.EVOLVE_HORIZONS) {
        const b = volAdjust ? L.barriersFor(h, { atrPct, volAdjust: true }) : BARRIERS[h];
        const fwd = L.sliceForward(candles, date, b.window + 5);
        const core = L.tripleBarrier(fwd, entry, b);
        if (!core.resolved) continue;
        const spyRet = L.benchmarkReturn(L.sliceForward(spyCandles, date, b.window + 5), b.window);
        const secRet = secC ? L.benchmarkReturn(L.sliceForward(secC, date, b.window + 5), b.window) : null;
        additions[`bf|${date}|${t}|${h}`] = {
          ticker: t, predDate: date, horizon: h, contextKey: E.contextKey({ regimeLabel, cap, horizon: h }),
          specialists: fired, contribs, probability: 0.4, decision: 'BACKFILL',
          won: core.won, barrier: core.barrier, label: core.label, terminalReturn: core.terminalReturn,
          mfe: core.mfe, mae: core.mae, barsToBarrier: core.barsToBarrier,
          spyRelReturn: spyRet == null ? null : +(core.terminalReturn - spyRet).toFixed(4),
          sectorRelReturn: secRet == null ? null : +(core.terminalReturn - secRet).toFixed(4),
          barriers: { up: b.up, down: b.down, volAdjusted: !!b.volAdjusted },
          regimeLabel, resolvedAt: now || 'backfill', backfill: true,
        };
        stat.rows++; bump(stat.byHorizon, h); bump(stat.byRegime, regimeLabel);
        if (core.won) stat.wins++;
        for (const s of fired) { stat.bySpecialist[s] = stat.bySpecialist[s] || { n: 0, wins: 0 }; stat.bySpecialist[s].n++; if (core.won) stat.bySpecialist[s].wins++; }
      }
    }
  }
  stat.version = BACKFILL_VERSION;
  stat.tickers = hist.size; stat.cohortDates = dates.length; stat.scope = scope;
  stat.volAdjust = !!volAdjust;
  stat.coverage = 'momentumIgnition + quietAccumulation (screenTicker-reconstructable); others accrue forward-only';
  stat.hitRate = stat.rows ? +(stat.wins / stat.rows).toFixed(3) : null;
  stat.ms = Date.now() - t0;
  return { additions, stats: stat };
}

module.exports = { runEvolveBackfill, specialistsFiring, BACKFILL_VERSION, SECTOR_ETF };

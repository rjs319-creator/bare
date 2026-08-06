'use strict';
// EPHEMERAL EDGE FACTORY (ephemeral-edge-factory) — pure engine.
//
// Hunts TEMPORARY dislocations with the only honest architecture for mass
// scenario search:
//   1. GENERATOR   — a mechanical grammar enumerates every scenario (nothing
//                    hand-picked): cross-sectional feature extremes, alone and
//                    in pairs, long and short, at fast horizons.
//   2. SCREEN      — every cell is scored on the trailing window with the FULL
//                    grammar size as the trial count (Bailey-López de Prado
//                    Deflated Sharpe via lib/evolve-dsr.js), so surviving means
//                    beating what pure luck produces across the whole search —
//                    not one lucky backtest.
//   3. LIVE QUEUE  — survivors' CURRENT firings are logged as paper picks and
//                    resolved at their fast horizons; only the pooled LIVE
//                    record can ever confirm anything (registry hypothesis).
//                    Survivor sets are recomputed every tick, so a decayed cell
//                    silently stops firing — temporary edges are RENTED.
//
// Everything here is pure (no network, no store, no clock): bars are injected.
// Costs are charged per event at the exec-engine small-tier round trip — a
// "dislocation" that cannot pay 62bps is noise, not edge.

const { deflatedSharpe, moments } = require('./evolve-dsr');

const EPHEMERAL_VERSION = 'ephemeral-factory-v1';
const HORIZONS = [2, 5];                        // sessions — fast feedback is the point
const Z_THRESHOLD = 1;                          // |cross-sectional z| defining an extreme
const ROUND_TRIP_COST_PCT = 0.62;               // exec-engine small tier 2×(12+18+1)bps
const MIN_CELL_EVENTS = 30;
const PASS_DSR = 0.95;
const MAX_PICKS_PER_TICK = 15;                  // no silent flood; cap RECORDED in output

// Per-name-day raw features (from a bar window ending at index i; needs ≥ 21 bars).
// gap1: overnight gap; ret5: 5-session return; relVol: volume vs 20d mean;
// dist20: stretch from 20d SMA; rangePos: close position in the day's range.
function rawFeatures(bars, i) {
  if (i < 21) return null;
  const b = bars[i], p = bars[i - 1];
  if (!(b && p && b.open > 0 && b.close > 0 && p.close > 0)) return null;
  let volSum = 0, smaSum = 0;
  for (let k = i - 20; k < i; k++) { volSum += bars[k].volume || 0; smaSum += bars[k].close; }
  const avgVol = volSum / 20, sma20 = smaSum / 20;
  const range = b.high - b.low;
  return {
    gap1: (b.open / p.close - 1) * 100,
    ret5: bars[i - 5] && bars[i - 5].close > 0 ? (b.close / bars[i - 5].close - 1) * 100 : null,
    relVol: avgVol > 0 ? (b.volume || 0) / avgVol : null,
    dist20: sma20 > 0 ? (b.close / sma20 - 1) * 100 : null,
    rangePos: range > 0 ? (b.close - b.low) / range : null,
  };
}
const FEATURE_KEYS = ['gap1', 'ret5', 'relVol', 'dist20', 'rangePos'];

// Cross-sectional z-scores per date (the DISLOCATION frame: extreme vs the
// market that day, not vs a name's own history).
function zScoreByDate(rows) {
  const byDate = new Map();
  for (const r of rows) { if (!byDate.has(r.date)) byDate.set(r.date, []); byDate.get(r.date).push(r); }
  for (const [, day] of byDate) {
    for (const k of FEATURE_KEYS) {
      const vals = day.map((r) => r.f[k]).filter(Number.isFinite);
      if (vals.length < 20) { day.forEach((r) => { r.z[k] = null; }); continue; }
      const m = vals.reduce((s, x) => s + x, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((s, x) => s + (x - m) ** 2, 0) / vals.length) || 1;
      day.forEach((r) => { r.z[k] = Number.isFinite(r.f[k]) ? (r.f[k] - m) / sd : null; });
    }
  }
  return rows;
}

// ── grammar: singles + unordered pairs of (feature, side), × direction × horizon ──
function grammar() {
  const singles = [];
  for (const k of FEATURE_KEYS) for (const side of ['hi', 'lo']) singles.push({ k, side });
  const conds = singles.map((s) => [s]);
  for (let a = 0; a < singles.length; a++) {
    for (let b = a + 1; b < singles.length; b++) {
      if (singles[a].k === singles[b].k) continue;        // same feature both sides — impossible
      conds.push([singles[a], singles[b]]);
    }
  }
  const cells = [];
  for (const c of conds) for (const dir of [1, -1]) for (const h of HORIZONS) {
    cells.push({
      id: `${c.map((x) => `${x.k}:${x.side}`).join('+')}|${dir === 1 ? 'L' : 'S'}|${h}`,
      conds: c, dir, horizon: h,
    });
  }
  return cells;
}

const matches = (row, cell) => cell.conds.every(({ k, side }) => {
  const z = row.z[k];
  return z != null && (side === 'hi' ? z > Z_THRESHOLD : z < -Z_THRESHOLD);
});

// Evaluate every cell over labeled rows (row.fwd[h] = next-open→+h-close SPY-excess %).
// Returns { cells: all with stats, survivors, trials }.
function evaluateGrammar(rows) {
  const cells = grammar();
  const trials = cells.length;
  const out = [];
  for (const cell of cells) {
    const rets = [];
    for (const r of rows) {
      const fwd = r.fwd && r.fwd[cell.horizon];
      if (fwd == null || !matches(r, cell)) continue;
      rets.push(cell.dir * fwd - ROUND_TRIP_COST_PCT);
    }
    if (rets.length < MIN_CELL_EVENTS) { out.push({ ...cell, n: rets.length, dsr: null }); continue; }
    const m = moments(rets);
    const sr = m.sd > 0 ? m.mean / m.sd : 0;
    const d = deflatedSharpe(sr, rets.length, m.skew, m.kurt, trials, 0.02);
    out.push({
      ...cell, n: rets.length,
      meanNetPct: +m.mean.toFixed(4), perEventSharpe: +sr.toFixed(4),
      dsr: +d.dsr.toFixed(4), sr0: d.sr0,
      hitRate: +(rets.filter((x) => x > 0).length / rets.length).toFixed(3),
    });
  }
  const survivors = out.filter((c) => c.dsr != null && c.dsr >= PASS_DSR);
  return { version: EPHEMERAL_VERSION, trials, cells: out, survivors };
}

// Today's paper picks: latest-date rows matching any surviving cell. One pick
// per symbol (highest-DSR cell wins); capped with the overflow RECORDED.
function currentFirings(rows, survivors, latestDate) {
  const today = rows.filter((r) => r.date === latestDate);
  const bySym = new Map();
  for (const cell of [...survivors].sort((a, b) => b.dsr - a.dsr)) {
    for (const r of today) {
      if (bySym.has(r.sym) || !matches(r, cell)) continue;
      bySym.set(r.sym, { sym: r.sym, date: latestDate, cellId: cell.id, dir: cell.dir, horizon: cell.horizon, dsr: cell.dsr });
    }
  }
  const all = [...bySym.values()];
  return { picks: all.slice(0, MAX_PICKS_PER_TICK), overflow: Math.max(0, all.length - MAX_PICKS_PER_TICK) };
}

// Resolve a paper pick against its symbol's bars: entry next-open after the
// pick date, exit at +horizon close, SPY-excess, signed by direction, net of
// the frozen round trip. Null while unresolved.
function resolvePick(pick, bars, spyBars) {
  let i = -1;
  for (let k = 0; k < bars.length; k++) { if (bars[k].date <= pick.date) i = k; else break; }
  const e0 = i + 1, e1 = i + 1 + pick.horizon;
  if (i < 0 || e1 >= bars.length || !(bars[e0].open > 0)) return null;
  let s = -1;
  for (let k = 0; k < spyBars.length; k++) { if (spyBars[k].date <= bars[e0].date) s = k; else break; }
  const s1 = s + pick.horizon;
  if (s < 0 || s1 >= spyBars.length || !(spyBars[s].open > 0)) return null;
  const ret = (bars[e1].close / bars[e0].open - 1) * 100;
  const spy = (spyBars[s1].close / spyBars[s].open - 1) * 100;
  const netExcess = pick.dir * (ret - spy) - ROUND_TRIP_COST_PCT;
  return { entryDate: bars[e0].date, exitDate: bars[e1].date, netExcessPct: +netExcess.toFixed(4), win: netExcess > 0 };
}

module.exports = {
  EPHEMERAL_VERSION, HORIZONS, Z_THRESHOLD, ROUND_TRIP_COST_PCT, MIN_CELL_EVENTS, PASS_DSR, MAX_PICKS_PER_TICK,
  rawFeatures, zScoreByDate, grammar, matches, evaluateGrammar, currentFirings, resolvePick, FEATURE_KEYS,
};

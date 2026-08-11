'use strict';
// CFL — DUD / FALSE-POSITIVE GRADING of the historical picks ledger. Pure core.
//
// Grades each logged pick at its OWN stop/target via the canonical resolver
// (lib/outcome.resolveTrade — the same contract the Scoreboard uses, never a
// parallel one), reconstructs the fill-basis path (MFE/MAE, closing return),
// and attributes the failures deterministically (lib/cfl/taxonomy.classifyDud).
//
// Input is injected (picks + candle map + benchmark) so tests run offline.

const { resolveTrade } = require('../outcome');
const { planFill, POLICIES } = require('../execution-policy');
const { resolveBarrierPath, classifyGap, benchmarkForward } = require('./labels');
const { classifyDud } = require('./taxonomy');
const CFG = require('./config');

// 21-session pre-entry run-up (%) — the EXHAUSTED_MOVE evidence.
function preRunPct(candles, decisionIdx, lookback = 21) {
  const from = decisionIdx - lookback;
  if (from < 0 || !candles[from] || !(candles[from].close > 0)) return null;
  return +((candles[decisionIdx].close / candles[from].close - 1) * 100).toFixed(1);
}

// Grade one pick. pick: {ticker, date, entry, stop, target, section, tier, scope}.
function gradePick({ pick, candles, spyCandles = null, sectorCandles = null } = {}) {
  if (!Array.isArray(candles) || !candles.length) {
    return {
      ticker: pick.ticker, date: pick.date, section: pick.section || null, tier: pick.tier || null,
      status: 'ungradable',
      attribution: classifyDud({ resolved: {}, path: {}, pick, context: { dataMissing: true } }),
    };
  }
  const resolved = resolveTrade(candles, pick.date, pick.entry, pick.stop, pick.target);
  if (resolved.outcome === 'OPEN') {
    return { ticker: pick.ticker, date: pick.date, section: pick.section || null, tier: pick.tier || null, status: 'unresolved', resolved };
  }
  const decisionIdx = candles.findIndex(b => b.date >= pick.date);
  const fill = planFill(candles, pick.date, { policy: POLICIES.NEXT_OPEN_PLUS_SLIPPAGE, side: 'long', tier: pick.tier === 'micro' ? 'micro' : 'liquid' });
  const horizonSessions = Math.min(63, Math.max(resolved.hold || 0, 5));
  const path = (fill.filled && fill.fillIdx != null)
    ? {
        ...resolveBarrierPath({
          candles, fillIdx: fill.fillIdx, fillPrice: fill.fillPrice,
          upPct: pick.target > 0 && pick.entry > 0 ? (pick.target / pick.entry - 1) * 100 : 20,
          downPct: pick.stop > 0 && pick.entry > 0 ? (1 - pick.stop / pick.entry) * 100 : 8,
          horizonSessions,
        }),
        entryPrice: fill.fillPrice,
      }
    : {};
  const gap = decisionIdx >= 0 ? classifyGap({ candles, decisionIdx, horizonSessions }) : { gapPct: null };
  const context = {
    spyReturn: benchmarkForward(spyCandles, pick.date, horizonSessions),
    sectorReturn: benchmarkForward(sectorCandles, pick.date, horizonSessions),
    entryGapPct: gap.gapPct,
    dataMissing: false,
  };
  const enrichedPick = { ...pick, preRunPct: decisionIdx >= 0 ? preRunPct(candles, decisionIdx) : null };
  const attribution = classifyDud({ resolved, path, pick: enrichedPick, context });
  const status = resolved.outcome === 'WIN' ? 'success'
    : (resolved.outcome === 'LOSS' || (resolved.outcome === 'EXPIRED' && Number.isFinite(resolved.r) && resolved.r <= 0)) ? 'dud'
    : 'resolved-flat';
  return {
    ticker: pick.ticker, date: pick.date, section: pick.section || null, tier: pick.tier || null,
    status, resolved,
    path: path.mfe != null ? { mfe: path.mfe, mae: path.mae, closingReturn: path.closingReturn } : null,
    context: { spyReturn: context.spyReturn, sectorReturn: context.sectorReturn, entryGapPct: context.entryGapPct },
    attribution,
  };
}

// Grade a batch of picks with first-appearance dedup (same convention as the
// Scoreboard: the first time a (section,ticker) appears is the evidence row).
function gradeDuds({ picks = [], histOf, spyCandles = null, sectorCandlesOf = null, deadline = null, now = Date.now } = {}) {
  const seen = new Set();
  const out = [];
  let truncated = false;
  for (const p of picks) {
    if (deadline != null && now() > deadline) { truncated = true; break; }
    const key = `${p.section || ''}|${p.ticker}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const candles = histOf ? histOf(p.ticker) : null;
    out.push(gradePick({
      pick: p, candles, spyCandles,
      sectorCandles: sectorCandlesOf ? sectorCandlesOf(p.ticker) : null,
    }));
  }
  const counts = out.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
  const byCategory = out.reduce((m, r) => {
    const c = r.attribution && r.attribution.primaryFailure;
    if (c) m[c] = (m[c] || 0) + 1;
    return m;
  }, {});
  return { version: CFG.CFL_VERSION, graded: out.length, counts, byCategory, rows: out, truncated };
}

module.exports = { gradePick, gradeDuds, preRunPct };

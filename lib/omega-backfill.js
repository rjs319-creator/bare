'use strict';
// OMEGA-SWING — POINT-IN-TIME REPLAY (walk-forward validation + Scoreboard ledger seed)
//
// The honest evidence layer (§15). Replays the OMEGA-SWING engine on historical candle
// slices — the app's proven leakage-safe pattern (lib/backfill.js / ghost-backtest.js /
// evolve-backfill.js): every evaluation uses ONLY bars up to the cohort date, and every
// residual label uses ONLY bars strictly after it. Cohort dates leave ≥ the longest horizon
// (10 trading days + buffer) of forward data so nothing is scored on an unfinished window.
//
// Two consumers share one replay:
//   runOmegaWalkforward   → OOS residual expectancy, rank-IC (score & predicted-residual vs
//                           realized 5d/10d residual), calibration, tier-conditional payoff,
//                           purged sequential walk-forward blocks, and baseline comparisons
//                           (simple 10d momentum, 52wk-high proximity, relative volume).
//   runOmegaLedgerBackfill→ point-in-time Prime/Qualified/Watch picks per historical day so
//                           the generic Scoreboard resolves their forward returns.
//
// Nothing here declares an edge: it produces the numbers and a strict all-blocks-positive
// verdict; if the score doesn't separate winners from losers OOS, the verdict says so.

const { fetchDailyHistory, screenTicker } = require('./screener');
const { LARGE, SMALL_CAPS, MICRO_CAPS, SECTOR_OF } = require('./universe');
const { buildMacroLookup } = require('./macro');
const RQ = require('./rankquality');
const O = require('./omega-swing');
const OX = require('./omega-execution');            // executable next-open/conditional fills
const { roundTripCostPct } = require('./costs');    // cost-net residuals
const { PROVENANCE } = require('./omega-contract');
const OF = require('./omega-funnel');               // live-funnel parity assessment (Phase 4)

const OMEGA_BACKFILL_VERSION = 'omega-backfill-v1';
const MAX_HOLD = 15;                 // 10d horizon + holiday buffer of forward bars per cohort
const MIN_HISTORY = 60;              // computeFeatures needs ~55 bars

const SECTOR_ETF = {
  'Technology': 'XLK', 'Information Technology': 'XLK', 'Financials': 'XLF', 'Financial Services': 'XLF',
  'Health Care': 'XLV', 'Healthcare': 'XLV', 'Energy': 'XLE', 'Industrials': 'XLI',
  'Consumer Discretionary': 'XLY', 'Consumer Cyclical': 'XLY', 'Consumer Staples': 'XLP', 'Consumer Defensive': 'XLP',
  'Materials': 'XLB', 'Basic Materials': 'XLB', 'Real Estate': 'XLRE', 'Utilities': 'XLU',
  'Communication Services': 'XLC',
};
const SECTOR_ETFS = [...new Set(Object.values(SECTOR_ETF))];

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch { out[k] = null; } } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Last-bar-on-or-before-date index in an ascending candle series.
function idxAsOf(candles, date) {
  for (let k = candles.length - 1; k >= 0; k--) if (candles[k].date <= date) return k;
  return -1;
}

// ── Shared replay — produces one row per (cohort date, ticker) that OMEGA-SWING evaluated,
//    carrying the score/tier/predicted-quantities AND the realized 5d/10d residual labels. ──
async function replayOmega({ scope = 'large', limit = 60, step = 10, months = 24, range = '2y', deadlineMs = 50000 } = {}) {
  const t0 = Date.now();
  const list = scope === 'micro' ? MICRO_CAPS : scope === 'small' ? SMALL_CAPS : LARGE;
  const tickers = (limit > 0 ? list.slice(0, limit) : list).slice();

  const spy = await fetchDailyHistory('SPY', range).catch(() => null);
  if (!spy) return { rows: [], stats: { error: 'no SPY history', version: OMEGA_BACKFILL_VERSION } };
  const spyCandles = spy.candles;
  const spyByDate = {}; spyCandles.forEach(x => { spyByDate[x.date] = x.close; });
  const sectorCandles = {};
  await mapLimit(SECTOR_ETFS, 6, async (sym) => { const d = await fetchDailyHistory(sym, range).catch(() => null); if (d) sectorCandles[sym] = d.candles; });
  const macro = await buildMacroLookup(range).catch(() => null);
  const regimeAt = (date) => { const s = macro && macro.at(date); return (s && s.regime) || 'neutral'; };

  const hist = new Map();
  await mapLimit(tickers, 6, async (t) => { const d = await fetchDailyHistory(t, range).catch(() => null); if (d) hist.set(t, d.candles); });

  const span = Math.min(spyCandles.length - 1, Math.round((months / 12) * 252));
  const dates = [];
  for (let k = span; k >= MAX_HOLD; k -= step) dates.push(spyCandles[spyCandles.length - 1 - k].date);

  const rows = [];
  const stat = { evaluated: 0, unfilled: 0, byTier: {}, byRegime: {}, byNoFill: {}, deadlineHit: false };
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };

  outer:
  for (const date of dates) {
    const regimeLabel = regimeAt(date);
    const regime = { riskOn: regimeLabel === 'risk-on', bearish: regimeLabel === 'risk-off' };
    const spyIdx = idxAsOf(spyCandles, date);
    const spySlice = spyCandles.slice(0, spyIdx + 1);
    for (const [t, candles] of hist) {
      if (Date.now() - t0 > deadlineMs) { stat.deadlineHit = true; break outer; }
      const idx = idxAsOf(candles, date);
      if (idx < MIN_HISTORY || candles.length - 1 - idx < MAX_HOLD) continue;   // history + forward bars
      const etf = SECTOR_ETF[SECTOR_OF[t]];
      const secFull = etf ? sectorCandles[etf] : null;
      const secSlice = secFull ? secFull.slice(0, idxAsOf(secFull, date) + 1) : null;
      const card = O.evaluateCandidate({
        ticker: t, candles: candles.slice(0, idx + 1), bench: { spy: spySlice, sector: secSlice },
        ctx: { regime },
      });
      if (!card) continue;
      // EXECUTABLE ENTRY (§3): resolve the real T+1 fill against the FULL series — no more
      // crediting the un-tradeable signal-day close. A conditional trigger that never fires,
      // or an opening gap past the point of positive utility, is an honest NO-TRADE.
      const tierName = OX.tierForDollarVol(card.features.dollarVol);
      const exec = OX.planOmegaEntry({
        candles, signalDate: date, entryClass: card.entry.classification, f: card.features,
        levels: card.risk ? card.risk.levels : null,
        stop: card.risk ? card.risk.invalidation : null, target1: card.risk ? card.risk.target1 : null,
        tier: tierName,
      });
      if (exec.fillStatus !== 'filled') { bump(stat.byNoFill, exec.noFillReason || 'unfilled'); stat.unfilled = (stat.unfilled || 0) + 1; continue; }
      const entry = exec.assumedFillPrice;
      // Forward window measured from the SIGNAL date (bars strictly after T); entry is the T+1
      // fill, so the label is "buy the next open, hold `window` sessions" — realistic.
      const lab5 = O.residualForward({ candles, predDate: date, entry, window: 5, spyCandles, sectorCandles: secFull });
      const lab10 = O.residualForward({ candles, predDate: date, entry, window: 10, spyCandles, sectorCandles: secFull });
      if (!lab10.resolved) continue;
      const rtCost = roundTripCostPct(tierName) / 100;                 // fraction
      const netOf = (x) => (x == null ? null : +(x - rtCost).toFixed(4));
      rows.push({
        date, ticker: t, regime: regimeLabel, tier: card.tier, stage: card.stage,
        signalRef: card.price, entry, fillDate: exec.assumedFillDate, openingGapPct: exec.openingGapPct,
        executableState: exec.executableState,
        setup: card.setup || null, score: card.score, utility: card.utility, pPositive: card.pred.pPositive,
        p3pct: card.pred.p3pct, p5pct: card.pred.p5pct, expResid10: card.pred.expResidual10,
        r10: card.features.r10, distFrom52High: card.features.distFrom52High, relVol5: card.features.relVol5,
        residual5: lab5.resolved ? lab5.residualReturn : null, residual10: lab10.residualReturn,
        residual5Net: lab5.resolved ? netOf(lab5.residualReturn) : null, residual10Net: netOf(lab10.residualReturn),
        raw10: lab10.rawReturn, mae: lab10.mae, mfe: lab10.mfe, hit3: lab10.hit3pct, hit5: lab10.hit5pct,
      });
      stat.evaluated++; bump(stat.byTier, card.tier); bump(stat.byRegime, regimeLabel);
    }
  }
  stat.version = OMEGA_BACKFILL_VERSION; stat.scope = scope; stat.tickers = hist.size;
  stat.cohortDates = dates.length; stat.ms = Date.now() - t0;
  // HONESTY STAMPS (§Phase 4). This replay scans a STATIC present-day universe list (LARGE/
  // SMALL/MICRO), NOT the point-in-time op=today candidate funnel and NOT a survivorship-
  // complete universe. So: it cannot claim live-funnel parity, and delisted names are absent.
  // These flags BLOCK any "validated"/"production" promotion downstream — fail closed.
  stat.provenance = PROVENANCE.HISTORICAL_RECONSTRUCTION;
  stat.historicalLiveParity = false;   // static universe ≠ the live op=today funnel
  stat.survivorshipSafe = false;       // present-day list omits delisted names
  stat.executionPolicy = OX.OMEGA_EXECUTION_VERSION;
  return { rows, stats: stat, dates };
}

// ── Walk-forward validation (§15) ────────────────────────────────────────────────────────
const meanOf = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const icOf = (rows, scoreKey, outKey) => {
  const items = rows.filter(r => r[scoreKey] != null && r[outKey] != null).map(r => ({ score: r[scoreKey], outcome: r[outKey] }));
  return items.length >= 8 ? RQ.informationCoefficient(items) : { ic: null, n: items.length, significant: false };
};

// ── PURE, PREDECLARED FAIL-CLOSED GATES (§15) — a mean-IC threshold is NOT sufficient. ──
// Extracted so the promotion logic is unit-testable without a network replay. A challenger
// may be promoted ONLY if EVERY gate passes; a static-universe harness can never satisfy
// live-funnel parity + survivorship, so `promotable` is structurally false here (fail closed).
function evaluateGates({ blockICs = [], margin = 0.02, deadlineTruncated = false, tierNet = {}, scoreIC = null, baseICs = [], historicalLiveParity = false, survivorshipSafe = false } = {}) {
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const allPositive = blockICs.length >= 3 && blockICs.every(x => x > 0);
  const meanOOS = blockICs.length ? +mean(blockICs).toFixed(3) : null;
  const { prime: np, qualified: nq, watch: nw } = tierNet;
  const tierMonotone = np != null && nq != null && nw != null && np >= nq && nq >= nw;
  const beatsBaselines = scoreIC != null && baseICs.length > 0 && baseICs.every(b => scoreIC > b);
  const gates = {
    minBlocksPositive: allPositive,
    meanOOSaboveMargin: meanOOS != null && meanOOS > margin,
    notDeadlineTruncated: !deadlineTruncated,
    tierMonotone, beatsBaselines,
    liveFunnelParity: historicalLiveParity === true,
    survivorshipSafe: survivorshipSafe === true,
  };
  // `passed` is the STATISTICAL edge test; `promotable` additionally requires parity +
  // survivorship — so a challenger can never be promoted off a static-universe harness alone.
  const passed = allPositive && meanOOS != null && meanOOS > margin && !deadlineTruncated && tierMonotone && beatsBaselines;
  const promotable = passed && gates.liveFunnelParity && gates.survivorshipSafe;
  const verdict = deadlineTruncated ? 'inconclusive-truncated'
    : passed ? 'edge-holds-oos'
    : (meanOOS != null && meanOOS > 0) ? 'inconclusive' : 'no-edge';
  return { gates, allPositive, meanOOS, tierMonotone, beatsBaselines, passed, promotable, verdict };
}

async function runOmegaWalkforward(opts = {}) {
  const { rows, stats, dates } = await replayOmega(opts);
  if (!rows.length) return { version: OMEGA_BACKFILL_VERSION, stats, verdict: 'insufficient', note: 'no resolved rows' };

  // PHASE 4 — live-funnel parity. If the caller supplies the captured funnel dates (op=omegafunnel
  // snapshots), reassess parity against THIS replay's cohort dates. Parity flips to true only when
  // EVERY cohort date has a captured funnel — so a historical replay stays false until enough
  // prospective funnel has accrued. survivorshipSafe still requires a PIT security master.
  const funnelParity = OF.assessFunnelParity(dates || [], opts.funnelDates || []);
  if (funnelParity.historicalLiveParity) stats.historicalLiveParity = true;
  stats.funnelParity = funnelParity;

  const withResid = rows.filter(r => r.residual10 != null);
  // Rank-IC: does the OMEGA score / predicted residual separate 5d/10d residual winners?
  const ic = {
    score_vs_resid10: icOf(withResid, 'score', 'residual10'),
    score_vs_resid5: icOf(rows.filter(r => r.residual5 != null), 'score', 'residual5'),
    predResid_vs_resid10: icOf(withResid, 'expResid10', 'residual10'),
    utility_vs_resid10: icOf(withResid, 'utility', 'residual10'),
  };
  // Baselines to beat (§15).
  const baselines = {
    momentum10d: icOf(withResid, 'r10', 'residual10'),
    high52prox: icOf(withResid.filter(r => r.distFrom52High != null), 'distFrom52High', 'residual10'),
    relVol5: icOf(withResid, 'relVol5', 'residual10'),
  };
  // Tier-conditional payoff — the product test: does PRIME > QUALIFIED > WATCH > AVOID?
  const byTier = {};
  for (const tier of O.TIERS) {
    const g = withResid.filter(r => r.tier === tier);
    byTier[tier] = {
      n: g.length,
      meanResidual10: g.length ? +meanOf(g.map(r => r.residual10)).toFixed(4) : null,
      meanResidual5: g.filter(r => r.residual5 != null).length ? +meanOf(g.filter(r => r.residual5 != null).map(r => r.residual5)).toFixed(4) : null,
      hit3Rate: g.length ? +meanOf(g.map(r => (r.hit3 ? 1 : 0))).toFixed(3) : null,
      hit5Rate: g.length ? +meanOf(g.map(r => (r.hit5 ? 1 : 0))).toFixed(3) : null,
      meanMAE: g.length ? +meanOf(g.map(r => r.mae)).toFixed(4) : null,
    };
  }
  // Calibration of pPositive vs realized P(residual10>0).
  const calItems = withResid.map(r => ({ pred: r.pPositive, won: r.residual10 > 0 ? 1 : 0 }))
    .map(x => ({ score: x.pred, outcome: x.won, won: x.won, pred: x.pred }));
  const cal = RQ.calibration(calItems, 5);

  // Purged sequential walk-forward blocks: the score is a FIXED formula (no fitting), so this
  // measures OOS STABILITY of the score→residual IC across time (ghost-backtest discipline).
  // Cohorts are spaced by `step` ≥ the 10d window, so blocks are naturally purged.
  const blockCount = Math.min(4, Math.max(2, Math.floor(dates.length / 6)));
  const blocks = [];
  const dateList = [...new Set(withResid.map(r => r.date))].sort();
  const per = Math.ceil(dateList.length / blockCount);
  for (let b = 0; b < blockCount; b++) {
    const bd = new Set(dateList.slice(b * per, (b + 1) * per));
    const br = withResid.filter(r => bd.has(r.date));
    if (br.length < 8) continue;
    blocks.push({ block: b + 1, n: br.length, ic: icOf(br, 'score', 'residual10').ic, meanResidual10: +meanOf(br.map(r => r.residual10)).toFixed(4) });
  }
  const blockICs = blocks.map(b => b.ic).filter(x => x != null);
  const MARGIN = 0.02;

  // Tier payoff on cost-net residual: PRIME ≥ QUALIFIED ≥ WATCH.
  const tierNet = (t) => {
    const g = withResid.filter(r => r.tier === t && r.residual10Net != null);
    return g.length >= 5 ? meanOf(g.map(r => r.residual10Net)) : null;
  };
  const [np, nq, nw] = [tierNet('OMEGA_PRIME'), tierNet('OMEGA_QUALIFIED'), tierNet('OMEGA_WATCH')];
  const scoreIC = ic.score_vs_resid10 && ic.score_vs_resid10.ic;
  const baseICs = Object.values(baselines).map(b => b && b.ic).filter(x => x != null);

  const g = evaluateGates({
    blockICs, margin: MARGIN, deadlineTruncated: !!(stats && stats.deadlineHit),
    tierNet: { prime: np, qualified: nq, watch: nw }, scoreIC, baseICs,
    historicalLiveParity: !!(stats && stats.historicalLiveParity === true),
    survivorshipSafe: !!(stats && stats.survivorshipSafe === true),
  });
  const { gates, allPositive, meanOOS, passed, verdict, promotable } = g;

  // By-regime IC — the app's one validated lever (does the edge invert in risk-off?).
  const byRegime = {};
  for (const rg of ['risk-on', 'neutral', 'risk-off']) {
    const g = withResid.filter(r => r.regime === rg);
    if (g.length >= 8) byRegime[rg] = { n: g.length, ic: icOf(g, 'score', 'residual10').ic, meanResidual10: +meanOf(g.map(r => r.residual10)).toFixed(4) };
  }

  return {
    version: OMEGA_BACKFILL_VERSION, stats,
    ic, baselines, byTier, byRegime,
    calibration: { brier: cal.brier, table: cal.table },
    walkforward: { blocks, blockICs, meanOOS, allPositive, margin: MARGIN, passed, verdict, gates },
    gates, tierNetResidual: { prime: np, qualified: nq, watch: nw }, funnelParity,
    promotable, promotionBlockedReason: promotable ? null
      : 'Static present-day universe ⇒ historicalLiveParity=false and survivorshipSafe=false. A trained challenger cannot be promoted off this harness — it needs point-in-time candidate-funnel reconstruction and a survivorship-complete universe plus prospective-live evidence.',
    verdict,
    shipCriteria: 'A challenger may override the baseline ONLY when ALL gates pass (≥3 purged blocks all positive, meanOOS>0.02, NOT deadline-truncated, tier payoff monotone on cost-net residual, beats every simple baseline) AND it is promotable (live-funnel parity + survivorship-safe) AND prospective-live evidence is consistent. This harness alone can never promote (promotable=false).',
    honesty: 'Fixed interpretable formula (no fitting) — this is an OOS STABILITY test of the ranking, not a claim of edge. The app\'s prior research found no durable regime-robust selection edge on this data; risk-off avoidance is the one validated lever. A non-positive verdict is a valid, expected outcome.',
  };
}

// ── Scoreboard ledger seed — point-in-time Prime/Qualified/Watch picks per historical day ──
async function runOmegaLedgerBackfill({ scope = 'large', limit = 80, months = 12, step = 10, range = '2y', deadlineMs = 50000 } = {}) {
  const { rows, stats } = await replayOmega({ scope, limit, months, step, range, deadlineMs });
  const byDate = {};
  const KEEP = new Set(['OMEGA_PRIME', 'OMEGA_QUALIFIED', 'OMEGA_WATCH']);
  for (const r of rows) {
    if (!KEEP.has(r.tier)) continue;
    (byDate[r.date] = byDate[r.date] || []).push({
      ticker: r.ticker, section: 'OMEGA', tier: r.tier, date: r.date,
      // `entry` is the executable T+1 fill (NOT the signal-day close); signalRef is the close.
      entry: r.entry != null ? +r.entry.toFixed(2) : null, signalRef: r.signalRef, fillDate: r.fillDate,
      score: r.score, stage: r.stage, setup: r.setup || null,
      provenance: PROVENANCE.HISTORICAL_RECONSTRUCTION,   // reconstructed — NEVER the live track
    });
  }
  stats.pickDays = Object.keys(byDate).length;
  stats.picks = Object.values(byDate).reduce((s, a) => s + a.length, 0);
  return { byDate, stats };
}

module.exports = { OMEGA_BACKFILL_VERSION, replayOmega, runOmegaWalkforward, runOmegaLedgerBackfill, evaluateGates, SECTOR_ETF };

'use strict';
// ATLAS-X — engine. Orchestrates the full shadow pipeline per candidate and folds
// the results into episodes, a shadow portfolio, capture, and the 10-section board.
//
//   PIT universe → residualization → state-transition → expert routing →
//   distributional ranking → survival → prosecutor → enter-now-vs-wait →
//   cost/opportunity/portfolio → conformal abstention → episodes → board
//
// Every layer's output is attached to the candidate (inspectable), and every card
// carries a provenance stamp. PURE over its price inputs: the routes layer supplies
// candles (priceLookup) + benchmarks and persists; nothing here fetches or writes.

const { residualize } = require('./atlasx-residual');
const { detectTransition } = require('./atlasx-transition');
const { pathFeatures } = require('./atlasx-path');
const { assessExperts } = require('./atlasx-experts');
const { routeExperts } = require('./atlasx-router');
const { predictDistribution } = require('./atlasx-ranking');
const { assessAtlasSurvival } = require('./atlasx-survival');
const { prosecute } = require('./atlasx-prosecutor');
const { decideEntry } = require('./atlasx-entry');
const { computeUtility } = require('./atlasx-utility');
const { buildAtlasPortfolio } = require('./atlasx-portfolio');
const { buildCapture } = require('./atlasx-capture');
const { buildAtlasEpisodes } = require('./atlasx-episodes');
const { toBars } = require('./atlasx-residual');
const { makeProvenance } = require('./atlasx-contracts');
const { VERSIONS, HURDLES, HOLDING_WINDOW, PERMITTED } = require('./atlasx-config');
const { tierForPick, costBreakdown } = require('./costs');

const num = v => (v == null || v === '' || typeof v === 'boolean' || !isFinite(+v) ? null : +v);

// ── per-candidate pipeline (no cross-sectional terms yet) ────────────────────
function buildCandidate({ ticker, candles, spy, sector, meta = {}, ctx = {} }) {
  const asOf = ctx.date || null;
  const bars = toBars(candles);
  const lastBar = bars.length ? bars[bars.length - 1] : null;
  const price = lastBar ? lastBar.c : num(meta.price);
  const dataCutoff = lastBar ? lastBar.date : asOf;

  const residual = residualize({ stock: candles, spy, sector, asOf });
  const transition = detectTransition({ candles, residual, asOf });
  const path = pathFeatures({ candles, asOf });

  const side = 'long'; // ATLAS-X v1 ranks long continuation; red-tape reversal handled as an expert flag
  const eCtx = { ...ctx, sector: meta.sector, sectorEtf: meta.sectorEtf, liqTier: meta.liqTier };
  const experts = assessExperts({ candles, spy, sector, residual, transition, path, ctx: eCtx });
  const router = routeExperts({ expertAssessments: experts.assessments, ctx: eCtx, performance: ctx.performance });
  const selectedExpert = router.selectedExpert || null;
  const expertAssessment = selectedExpert ? experts.assessments[selectedExpert] : null;
  const applicability = expertAssessment ? num(expertAssessment.applicability) : 0;

  const distribution = predictDistribution({ residual, transition, path, expert: expertAssessment || {}, ctx });

  // liquidity ($ vol) + freshness for hurdles
  const dollarVol = medianDollarVol(bars);
  const staleSessions = sessionsStale(dataCutoff, ctx.date, ctx.isHoliday);

  // sig consumed by the reused challenger-survival + failure-model wrappers.
  const sig = {
    ticker, side, expert: selectedExpert, price,
    entry: price, stop: num(expertAssessment && expertAssessment.invalidation),
    target: num(expertAssessment && expertAssessment.target && expertAssessment.target.price),
    score: distribution.score, rank: null,
    strategyFamily: selectedExpert || 'priceTrend', family: selectedExpert || 'priceTrend',
    horizon: 'swing', setup: transition.dominantTransition, stage: expertAssessment && expertAssessment.stage,
    sector: meta.sector, sectorEtf: meta.sectorEtf, dollarVol,
    candles, features: { residual, transition: transition.features, path: path.features },
    event: meta.catalyst || null, rr: num(distribution.remainingMFE) && num(distribution.remainingMAE)
      ? distribution.remainingMFE / Math.max(1e-6, distribution.remainingMAE) : null,
  };

  const survival = assessAtlasSurvival(sig, { ...ctx, expert: selectedExpert, regime: ctx.regime }, 'pre-entry');
  const prosecutor = prosecute(sig, { ...ctx, expert: selectedExpert });

  return Object.freeze({
    ticker, company: meta.company || null, side, price, sector: meta.sector || null, sectorEtf: meta.sectorEtf || null,
    dataCutoff, dollarVol, staleSessions,
    residual, transition, path,
    experts: experts.assessments, applicableExperts: experts.applicable,
    router, expert: selectedExpert, expertAssessment, expertApplicability: applicability,
    contributingExperts: experts.applicable.filter(e => e !== selectedExpert),
    distribution, survival, prosecutor,
    sourceMeta: meta, sig,
  });
}

// ── cross-sectional finalize: rank, opportunity, entry, utility, actionability ─
function finalizeCandidate(c, rank, nextBestMedian, ctx) {
  const dist = c.distribution;
  const costTier = tierForPick({ scope: capToScope(c.sourceMeta.liqTier || capFromDollarVol(c.dollarVol)) });
  const cb = costBreakdown(costTier, { side: c.side, holdSessions: HOLDING_WINDOW });
  // costBreakdown.totalPct is in PERCENT (0.16 = 0.16%); percent → bps is ×100.
  const roundTripBps = Math.abs(num(cb && cb.totalPct) || 0) * 100;

  const opportunity = { cash: 0, spy: 0, sector: 0, nextBest: nextBestMedian,
    cashBps: 0, spyBps: 0, sectorBps: 0, nextBestBps: (num(nextBestMedian) || 0) * 10000 };

  const entry = decideEntry({
    candidate: { ticker: c.ticker, side: c.side, price: c.price, stop: num(c.expertAssessment && c.expertAssessment.invalidation),
      invalidation: num(c.expertAssessment && c.expertAssessment.invalidation), maxGap: null,
      state: c.transition.features && c.transition.features.ret20 > 0.18 ? 'extended' : null, costBps: roundTripBps },
    distribution: dist, survival: c.survival, prosecutor: c.prosecutor, ctx,
  });

  const uCtx = {
    ...ctx,
    concentrationPenaltyBps: 0,
    remainingRR: num(entry.remainingRR),
    dataStaleSessions: c.staleSessions,
    expertApplicability: c.expertApplicability,
    liquidityDollarVol: c.dollarVol,
    regimePermitted: regimePermittedFor(c, ctx),
    residualsOOF: ctx.residualsOOF || null,
  };
  const utility = computeUtility({ distribution: dist, survival: c.survival, prosecutor: c.prosecutor, costs: { roundTripBps }, opportunity, ctx: uCtx });

  const eligibleEntryTs = nextBusinessDay(c.dataCutoff);
  const provenance = makeProvenance({
    decisionTs: ctx.date, eligibleEntryTs, dataCutoff: c.dataCutoff,
    featureVersion: VERSIONS.residual, strategyVersion: VERSIONS.strategy, modelVersion: VERSIONS.ranking,
    executionVersion: VERSIONS.execution, universeSnapshotId: ctx.universeSnapshotId || null,
    provenance: c.sourceMeta.provenance || 'op=today/near-miss/episode',
    calibrationStatus: 'uncalibrated', governanceStatus: 'shadow',
  });

  const champion = buildChampion(c);
  return Object.freeze({
    ...c, rank, entry, utility,
    actionable: utility.actionable === true,
    abstentionReason: utility.abstentionReason || null,
    remainingRR: num(entry.remainingRR),
    targets: c.expertAssessment && c.expertAssessment.target && c.expertAssessment.target.price != null ? [c.expertAssessment.target.price] : [],
    invalidation: num(c.expertAssessment && c.expertAssessment.invalidation),
    thesis: champion.summary, champion,
    holdingWindow: HOLDING_WINDOW,
    provenance,
    costs: { tier: costTier, roundTripBps },
  });
}

function runEngine({ universe, priceLookup, benchLookup, ctx = {} }) {
  const spy = benchLookup ? benchLookup('SPY') : [];
  const built = [];
  const skipped = [];
  for (const ticker of universe.evalTickers) {
    const candles = priceLookup(ticker);
    if (!candles || toBars(candles).length < 30) { skipped.push({ ticker, reason: 'insufficient-history' }); continue; }
    const cur = (universe.current || []).find(x => x.ticker === ticker) || {};
    const sectorEtf = cur.sectorEtf || null;
    const sector = sectorEtf && benchLookup ? benchLookup(sectorEtf) : [];
    const meta = { company: cur.company, sector: cur.sector, sectorEtf, price: cur.price,
      provenance: universe.sources.current.includes(ticker) ? 'op=today' : (universe.sources.episodes.includes(ticker) ? 'episode' : 'near-miss') };
    try {
      built.push(buildCandidate({ ticker, candles, spy, sector, meta, ctx }));
    } catch (e) { skipped.push({ ticker, reason: 'engine-error', error: String(e && e.message || e) }); }
  }

  // rank by central residual estimate (cost-agnostic ranking score)
  const ranked = built.slice().sort((a, b) => (num(b.distribution.score) || -9) - (num(a.distribution.score) || -9));
  const medians = ranked.map(c => num(c.distribution.median) || 0);
  const finalized = ranked.map((c, i) => {
    const nextBest = medians[i + 1] != null ? medians[i + 1] : 0;
    return finalizeCandidate(c, i + 1, nextBest, ctx);
  });

  return { candidates: finalized, skipped };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function buildChampion(c) {
  const reasons = [];
  const r10 = c.residual.byHorizon && c.residual.byHorizon[10] ? c.residual.byHorizon[10].residual : null;
  if (r10 != null && r10 > 0) reasons.push(`positive 10d residual (${(r10 * 100).toFixed(1)}%)`);
  if (c.residual.residualAccel != null && c.residual.residualAccel > 0) reasons.push('residual strength accelerating');
  if (c.transition.dominantTransition) reasons.push(`transition: ${c.transition.dominantTransition}`);
  if (c.expert) reasons.push(`specialist: ${c.expert}`);
  if (c.path && c.path.archetype) reasons.push(`path: ${c.path.archetype}`);
  return Object.freeze({ reasons, summary: reasons.slice(0, 3).join('; ') || 'no dominant upside driver' });
}

function regimePermittedFor(c, ctx) {
  // Red-tape reversal is only permitted in a risk-off regime; every other expert is
  // permitted in a normal regime. In risk-off, only redTapeReversal is permitted.
  if (ctx.regimeRiskOff) return c.expert === 'redTapeReversal';
  if (c.expert === 'redTapeReversal') return !PERMITTED.redTapeRequiresRiskOff ? true : false;
  return true;
}

// Map a cap/liquidity group to the cost model's scope buckets (unknown → liquid).
function capToScope(cap) {
  if (cap === 'micro') return 'micro';
  if (cap === 'small') return 'small';
  return 'large';
}
function capFromDollarVol(dv) {
  if (dv == null) return 'unknown';
  if (dv >= 100e6) return 'large';
  if (dv >= 20e6) return 'mid';
  if (dv >= 2e6) return 'small';
  return 'micro';
}

function medianDollarVol(bars) {
  if (bars.length < 5) return null;
  const dv = bars.slice(-20).map(b => b.c * b.v).sort((a, b) => a - b);
  return dv.length ? dv[Math.floor(dv.length / 2)] : null;
}

function sessionsStale(barDate, asOf, isHoliday) {
  if (!barDate || !asOf) return 0;
  // crude calendar-session gap (holiday-aware if predicate supplied)
  let d = new Date(barDate + 'T00:00:00Z');
  const end = new Date(asOf + 'T00:00:00Z');
  let n = 0;
  while (d < end && n < 30) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if (isHoliday && isHoliday(d.toISOString().slice(0, 10))) continue;
    n++;
  }
  return n;
}

function nextBusinessDay(dateStr) {
  if (!dateStr) return null;
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
  do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

module.exports = { runEngine, buildCandidate, finalizeCandidate, buildChampion, nextBusinessDay };

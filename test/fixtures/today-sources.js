'use strict';
// PHASE-1 BASELINE FIXTURE (quant-redesign-3) — a deterministic, all-source snapshot of
// realistic payload shapes for buildToday(). This is the frozen control: the golden test
// (test/today-golden.test.js) asserts the live ranking of these inputs stays byte-stable
// unless a change is deliberate, evidence-backed, and the golden is regenerated with
// `node scripts/capture-today-golden.js` (the regeneration itself is the audit trail).
//
// Every live source adapter is exercised, including the ones the audit flagged as
// reaching the board ungated (gapdown shorts, the 5 AI lead screeners, coremo) and the
// Day Trade rows whose behavior is contractually frozen (see DAYTRADE-EARLY-RUNNER.md).

const SOURCES = {
  screener: {
    regime: { indexAbove200: true, breadthPct: 69, bearish: false, riskOn: true, condition: 'mixed' },
    results: [
      { ticker: 'AAA', company: 'Alpha', sector: 'Technology', status: 'Setup', price: 100,
        levels: { entry: 102, stop: 96, target: 120, rr: 3 }, factors: { dollarVol: 5e8, mom63: 40 },
        ghost: { tier: 'GHOST', score: 90 }, quant: { score: 82 } },
      { ticker: 'BBB', company: 'Beta', sector: 'Energy', status: 'Early', price: 20,
        levels: { entry: 21, stop: 19, target: 27, rr: 3 }, factors: { dollarVol: 1e6, mom63: 10 },
        ghost: { tier: 'WATCH', score: 55 }, quant: { score: 60 } },
    ],
  },
  screenerSmall: {
    results: [
      { ticker: 'SML', company: 'Smallco', sector: 'Industrials', status: 'Setup', price: 12,
        levels: { entry: 12.4, stop: 11.2, target: 15.5, rr: 2.6 }, factors: { dollarVol: 3e6, mom63: 22 },
        quant: { score: 66 } },
    ],
  },
  gapgo: { strong: [{ ticker: 'AAA', sector: 'Technology', last: 101, tier: 'STRONG', continuationScore: 75,
    avgDollarVol: 4e7, plan: { trigger: 103, stop: 98, target: 112, rr: 2 }, nextEarnings: null, cause: 'NEWS' }] },
  daytrade: { bestOpportunities: [
    { ticker: 'CCC', sector: 'Health Care', last: 30, tier: 'B', relScore: 67,
      entry: 30.2, stop: 28.5, target: 34, rr: 2, source: 'Momentum & Liquid', catalyst: 'GUIDE',
      lifecycleState: 'ACTIONABLE_NOW', actionable: true, currentSessionFresh: true, thesisValid: true, planValid: true, barIsToday: true },
    { ticker: 'DTX', sector: 'Technology', last: 8.2, tier: 'A', relScore: 91,
      entry: 8.35, stop: 7.8, target: 9.6, rr: 2.3, source: 'Gap & Go', catalyst: 'FDA',
      lifecycleState: 'ACTIONABLE_NOW', actionable: true, currentSessionFresh: true, thesisValid: true, planValid: true, barIsToday: true },
  ] },
  coil: { picks: [{ ticker: 'DDD', company: 'Delta', sector: 'Utilities', price: 70, decile: 10, band: 'high',
    entry: 70.6, stop: 69, target: 76, rr: 3.2 }] },
  gapdown: { strong: [{ ticker: 'ZZZ', sector: 'Technology', last: 13, tier: 'STRONG', side: 'short', continuationScore: 60,
    avgDollarVol: 4e7, plan: { trigger: 11.5, stop: 14.2, target: 6.2, rr: 2, side: 'short' }, nextEarnings: null }] },
  biotech: { items: [
    { ticker: 'AGIO', tier: 'Hot', score: 85, last: 44, relVol: 2.3, classification: 'FDA', catalyst_timing: 'Ahead' },
    { ticker: 'WCH', tier: 'Watch', score: 40, last: 5 },
  ] },
  coremo: { book: [
    { ticker: 'MMM', sector: 'Industrials', price: 100, rank: 1, marketCap: 5e9 },
    { ticker: 'NNN', sector: 'Energy', price: 40, rank: 2, marketCap: 2e9 },
  ] },
  downday: { bounces: [
    { ticker: 'RVL', sector: 'Consumer Discretionary', price: 55, tier: 'EMERGING', bucket: 'v-reversal', score: 62,
      dollarVol: 9e6, signals: { entry: 56.1, stop: 52.9, target: 61.5, rr: 1.7, side: 'long' }, label: 'oversold bounce' },
  ], fades: [
    { ticker: 'HOT', sector: 'Technology', price: 210, tier: 'WATCH', bucket: 'overheated', score: 58,
      dollarVol: 6e7, signals: { entry: 205, stop: 216, target: 188, rr: 1.5, side: 'short' }, label: 'overheated fade' },
  ] },
  optionsflow: { byTicker: [
    { ticker: 'AAA', isIndex: false, score: 42, net: 'bullish', grade: 'strong', underlying: 100 },
  ] },
  scoreboard: { groups: [
    { section: 'screener', tier: 'Setup', horizons: { '5d': { avgExcess: 3, winRate: 58, n: 30 } } },
    { section: 'GapGo', tier: 'STRONG', horizons: { '1d': { avgExcess: 1.2, winRate: 56, n: 24 } } },
    { section: 'DownDay', tier: 'EMERGING', horizons: { '5d': { avgExcess: 2.1, winRate: 55, n: 12 } } },
  ] },
  sectors: { sectors: [
    { name: 'Technology', changePct: 1.5 }, { name: 'Energy', changePct: 0.2 },
    { name: 'Utilities', changePct: -0.9 }, { name: 'Industrials', changePct: 0.6 },
    { name: 'Health Care', changePct: 0.1 }, { name: 'Consumer Discretionary', changePct: -0.3 },
  ] },
  tape: { spyChangePct: 0.4, condition: 'trending', efficiency: 0.5 },
  ai: {
    rt: { items: [{ beneficiary_ticker: 'EEE', mechanism: 'reads through from AAA', directness: 70, moved: { alreadyMoved: false } }] },
    an: { items: [{ ticker: 'FFF', classification: 'ACCUMULATION', thesis: 'quiet vol', confidence: 60 }] },
    sw: { items: [{ ticker: 'GGG', classification: 'PRIMED', catalyst: 'second leg', virality: 55 }] },
    ca: { items: [{ ticker: 'HHH', classification: 'LEAD', lead_asset: 'copper', confidence: 58 }] },
    ts: { items: [{ ticker: 'III', shift: 'BRIGHTENING', change: 'tone up', confidence: 52 }] },
  },
};

// Canonical projection of a buildToday() payload for golden comparison — only the
// deterministic decision-relevant fields (no timestamps).
function project(payload) {
  const row = (s) => ({
    id: s.id, ticker: s.ticker, source: s.source, sources: s.sources, section: s.section,
    horizon: s.horizon, side: s.side, tier: s.tier, state: s.state,
    rank: s.rank, score: s.score, rawConfidence: s.rawConfidence,
    expectancyTilt: s.expectancyTilt, evidenceMult: s.evidenceMult,
    regimeFit: s.regimeFit, executionQuality: s.execution && s.execution.quality,
    costTier: s.cost && s.cost.tier, costPenalty: s.cost && s.cost.penalty,
    scoringVersion: s.scoringVersion ?? null,
  });
  const horizons = {};
  for (const h of Object.keys(payload.horizons || {})) horizons[h] = (payload.horizons[h] || []).map(row);
  const topByHorizon = {};
  for (const h of Object.keys(payload.topByHorizon || {})) topByHorizon[h] = (payload.topByHorizon[h] || []).map(row);
  return {
    counts: payload.counts,
    topByHorizon,
    horizons,
    portfolio: payload.portfolio ? {
      picks: (payload.portfolio.picks || payload.portfolio.selected || []).map(p => p.id || p.ticker),
      } : null,
    opportunity: payload.opportunity ? {
      decision: payload.opportunity.decision, score: payload.opportunity.score,
      qualifyingCount: payload.opportunity.qualifyingCount,
      maxExposurePct: payload.opportunity.maxExposurePct,
    } : null,
  };
}

module.exports = { SOURCES, project };

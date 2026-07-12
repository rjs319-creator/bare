// Baseline-validation harness — the honest "does this strategy beat a DUMB baseline?"
// scorecard. The spec's promotion rule: don't promote a strategy unless it adds
// out-of-sample value over SPY, the sector ETF, an equal-weight/random pick, and the
// simple factor screens (momentum, 52-week-high proximity, relative volume, earnings
// revision). This assembles that scorecard from data the app already computes:
//   • factor baselines  ← lib/research.js cross-section (rank-IC + top-quintile excess)
//   • SPY & sector bars  ← the maturity grade already controls for both
//   • equal-weight/random ← the cohort average = 0% excess by construction
// Pure + tested. The route (baselines-routes) reads the cached research + maturity and
// calls this.

// Each spec baseline → where its edge comes from and how to read it.
const BASELINE_DEFS = [
  { key: 'spy',         name: 'SPY (the market)',        kind: 'benchmark',   note: 'Every strategy grade already controls for this — "excess vs SPY".' },
  { key: 'sector',      name: 'Sector ETF',              kind: 'benchmark',   note: 'Validated now also requires beating this — controls for sector beta.' },
  { key: 'equalweight', name: 'Equal-weight universe',   kind: 'null',        note: 'Buy-anything baseline: the cohort average is 0% excess by construction. A strategy must clear 0.' },
  { key: 'random',      name: 'Matched random pick',     kind: 'null',        note: 'Random selection ≈ the universe average — the same ~0% excess bar.' },
  { key: 'momentum',    name: 'Simple 6-month momentum', kind: 'factor', factor: 'mom126' },
  { key: 'proximity',   name: '52-week-high proximity',  kind: 'factor', factor: 'proximity' },
  { key: 'relvol',      name: 'Relative-volume rank',    kind: 'factor', factor: 'volSurge' },
  { key: 'revision',    name: 'Earnings-revision rank',  kind: 'unavailable', note: 'Not computed — FMP estimate-revision history is plan-gated (same data wall as PEAD).' },
];

// A factor "beats the market" as a baseline if its top quintile earns positive excess
// AND ranking by it correlates with forward return (rank-IC materially > 0).
const IC_MEANINGFUL = 0.03;

function readFactor(research, factorKey) {
  const f = ((research && research.factors) || []).find(x => x.key === factorKey);
  if (!f || !Number.isFinite(f.rankIC)) return { available: false };
  const top = (f.quintiles && f.quintiles[f.quintiles.length - 1]) || null;
  const topExcess = top && Number.isFinite(top.avgR) ? top.avgR : null;
  return {
    available: true, rankIC: f.rankIC, topQuintileExcess: topExcess,
    winRateSpread: f.winRateSpread ?? null, n: f.n || 0,
    predictive: f.rankIC >= IC_MEANINGFUL && (topExcess == null || topExcess > 0),
  };
}

// Assemble the scorecard. `research` = cached runResearch output (or null); `maturity`
// = classifyStrategies output (or null). asOf lets the caller stamp freshness.
function assembleBaselines({ research, maturity } = {}) {
  const baselines = BASELINE_DEFS.map(def => {
    if (def.kind === 'factor') {
      const r = readFactor(research, def.factor);
      return { key: def.key, name: def.name, kind: def.kind, ...r };
    }
    if (def.kind === 'null') return { key: def.key, name: def.name, kind: def.kind, note: def.note, topQuintileExcess: 0, predictive: false, available: true };
    return { key: def.key, name: def.name, kind: def.kind, note: def.note, available: def.kind !== 'unavailable' };
  });

  // The bar every strategy must clear = the strongest predictive factor baseline.
  const factorBars = baselines.filter(b => b.kind === 'factor' && b.available && b.predictive);
  const bestBar = factorBars.sort((a, b) => (b.rankIC || 0) - (a.rankIC || 0))[0] || null;

  // Each app strategy vs the two benchmark baselines it's graded on.
  const strategies = ((maturity && maturity.strategies) || [])
    .filter(s => s.kind === 'signal' && s.stats && s.stats.baselines)
    .map(s => {
      const m = s.stats.baselines.market || {};
      const sec = s.stats.baselines.sector || {};
      return {
        id: s.id, label: s.label, grade: s.grade,
        vsSpy: Number.isFinite(m.avgExcess) ? m.avgExcess : null,
        vsSector: Number.isFinite(sec.avgExcess) ? sec.avgExcess : null,
        n: m.n || 0,
        beatsSpy: Number.isFinite(m.avgExcess) ? m.avgExcess > 0 : null,
        beatsSector: Number.isFinite(sec.avgExcess) ? sec.avgExcess > 0 : null,
      };
    })
    .sort((a, b) => (b.vsSpy ?? -99) - (a.vsSpy ?? -99));

  const validated = strategies.filter(s => s.grade === 'validated').length;
  const beatBoth = strategies.filter(s => s.beatsSpy && s.beatsSector).length;

  return {
    baselines, bestBar, strategies,
    summary: { total: strategies.length, validated, beatSpyAndSector: beatBoth, researchAvailable: !!(research && research.factors) },
    verdict: !research || !research.factors
      ? 'Factor baselines not computed yet — run the research scan to populate the momentum/relvol/52-week bars.'
      : validated > 0
        ? `${validated} strateg${validated === 1 ? 'y' : 'ies'} clear the promotion bar (beat SPY + sector at significance).`
        : `No strategy yet beats SPY + sector at significance${bestBar ? ` — the bar to beat is a ${bestBar.name.toLowerCase()} rank (IC ${bestBar.rankIC}).` : '.'} Consistent with the app's honest finding: only momentum carries weak edge, and regime avoidance is the one durable lever.`,
  };
}

module.exports = { BASELINE_DEFS, IC_MEANINGFUL, readFactor, assembleBaselines };

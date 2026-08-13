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
//
// ── WHAT THIS SCORECARD MAY AND MAY NOT CLAIM (alpha-research pass 3) ────────────
// Three things were wrong here, all of them about what the numbers MEAN rather than
// how they were computed:
//
// (1) TWO METRIC SPACES, ONE TABLE. The factor arms come from lib/research.js, whose
//     outcome is `r = cohortRet[i] - mean(cohortRets)` over MAX_HOLD=63 sessions,
//     GROSS of costs — cross-sectional excess vs THE COHORT. The strategy rows come
//     from lib/maturity.js `stats.baselines.market.avgExcess` — excess vs SPY, at
//     each strategy's own horizon, NET of costs wherever a cost channel exists.
//     Those are different units. The old verdict said "the bar to beat is a momentum
//     rank (IC 0.10)" and the UI headed the block "the bar to beat", inviting exactly
//     the comparison the data cannot support. Both spaces are now stamped as `basis`
//     and their non-comparability is stated rather than implied away.
//
// (2) THE NULL ARMS WERE AN IDENTITY DRESSED AS A MEASUREMENT. `topQuintileExcess: 0`
//     for equal-weight/random is true BY CONSTRUCTION in cross-sectional space (the
//     cohort mean minus itself is zero) — it was never measured. Worse, a random-pick
//     baseline exists precisely for its SAMPLING DISTRIBUTION: an N-name random draw
//     has real spread, and beating a zero MEAN by a hair is not evidence when the
//     spread is wide. Reporting a bare 0 with no error band makes any positive number
//     look like it clears. The dispersion is not derivable from the cached artifact
//     (research.js persists quintile aggregates, not per-record returns), so it is
//     reported as UNMEASURED rather than invented.
//
// (3) THE STATED RULE HAS FOUR ARMS; THE CODE APPLIES TWO. `strategies[]` carries only
//     vsSpy/vsSector and `beatSpyAndSector` is the only gate — the null and factor
//     arms are displayed under a "bar to beat" heading and never applied to any
//     strategy. A reader could only conclude they had been cleared. Each arm now
//     declares `applied`, and the unapplied ones are named on the summary.

// The two metric spaces this scorecard draws from. Kept as constants because the whole
// point is that they are DIFFERENT and every consumer must be able to tell which is which.
const FACTOR_BASIS = 'cross-sectional excess vs the cohort average · 63 sessions · gross of costs';
const STRATEGY_BASIS = "excess vs SPY · each strategy's own horizon · net of costs where a cost channel exists";
const COMPARABILITY_NOTE = 'Factor/null bars and strategy rows are measured in DIFFERENT units (benchmark, horizon and cost treatment all differ). A factor top-quintile number is not a threshold a strategy\'s vs-SPY number can be read against.';

// Which baselines are actually enforced against a strategy in this scorecard. Only the
// two the maturity grade computes per-strategy figures for; the rest are context.
const APPLIED_KEYS = Object.freeze(['spy', 'sector']);

// Each spec baseline → where its edge comes from and how to read it.
const BASELINE_DEFS = [
  { key: 'spy',         name: 'SPY (the market)',        kind: 'benchmark',   note: 'Every strategy grade already controls for this — "excess vs SPY".' },
  { key: 'sector',      name: 'Sector ETF',              kind: 'benchmark',   note: 'Validated now also requires beating this — controls for sector beta.' },
  { key: 'equalweight', name: 'Equal-weight universe',   kind: 'null',        note: 'Buy-anything reference. Zero is an IDENTITY in cross-sectional space (the cohort mean less itself), not a measured return — and its dispersion is not computed, so clearing zero by a hair is not evidence.' },
  { key: 'random',      name: 'Matched random pick',     kind: 'null',        note: 'A random draw of N names has real sampling spread; that spread — not the zero mean — is the bar. It is NOT measured here, so this arm cannot reject anything.' },
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
    const applied = APPLIED_KEYS.includes(def.key);
    if (def.kind === 'factor') {
      const r = readFactor(research, def.factor);
      return { key: def.key, name: def.name, kind: def.kind, applied, basis: FACTOR_BASIS, ...r };
    }
    if (def.kind === 'null') {
      return {
        key: def.key, name: def.name, kind: def.kind, note: def.note, available: true, applied,
        basis: FACTOR_BASIS,
        // Zero is where the cohort mean sits by definition — kept for orientation, but
        // flagged so no reader mistakes it for something that was measured.
        topQuintileExcess: 0,
        byConstruction: true,
        // A null arm only discriminates through its sampling spread, and that spread is
        // not recoverable from the persisted quintile aggregates. Say so; do not invent it.
        dispersion: null,
        dispersionMeasured: false,
        discriminates: false,
        predictive: false,
      };
    }
    return { key: def.key, name: def.name, kind: def.kind, note: def.note, applied, available: def.kind !== 'unavailable' };
  });

  // The strongest predictive FACTOR arm. This is a reference point in the factor metric
  // space — deliberately NOT described as the bar the strategy rows must clear, because
  // those rows are measured against a different benchmark, horizon and cost basis.
  const factorBars = baselines.filter(b => b.kind === 'factor' && b.available && b.predictive);
  const strongest = factorBars.sort((a, b) => (b.rankIC || 0) - (a.rankIC || 0))[0] || null;
  const bestBar = strongest
    ? { ...strongest, comparableToStrategies: false, comparabilityNote: COMPARABILITY_NOTE }
    : null;

  // Each app strategy vs the two benchmark baselines it's graded on. The other arms in
  // `baselines` are context, not gates — see APPLIED_KEYS.
  const strategies = ((maturity && maturity.strategies) || [])
    .filter(s => s.kind === 'signal' && s.stats && s.stats.baselines)
    .map(s => {
      const m = s.stats.baselines.market || {};
      const sec = s.stats.baselines.sector || {};
      return {
        id: s.id, label: s.label, grade: s.grade,
        basis: STRATEGY_BASIS,
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
  const unapplied = baselines.filter(b => !b.applied).map(b => b.key);

  return {
    baselines, bestBar, strategies,
    // The gap between the promotion rule as WRITTEN and as ENFORCED, made explicit so it
    // reads as an open item rather than a satisfied one.
    coverage: {
      appliedBaselines: [...APPLIED_KEYS],
      unappliedBaselines: unapplied,
      note: 'Only SPY and the sector ETF are enforced per strategy. The null and factor arms are shown for context and are NOT applied as gates — listing them is not evidence any strategy cleared them.',
    },
    comparability: {
      comparable: false,
      factorBasis: FACTOR_BASIS,
      strategyBasis: STRATEGY_BASIS,
      note: COMPARABILITY_NOTE,
    },
    summary: { total: strategies.length, validated, beatSpyAndSector: beatBoth, researchAvailable: !!(research && research.factors), unappliedBaselines: unapplied.length },
    verdict: !research || !research.factors
      ? 'Factor baselines not computed yet — run the research scan to populate the momentum/relvol/52-week bars.'
      : validated > 0
        ? `${validated} strateg${validated === 1 ? 'y' : 'ies'} clear the two ENFORCED baselines (SPY + sector, at significance). The null and factor arms are context, not gates.`
        : `No strategy yet beats SPY + sector at significance${strongest ? ` — separately, in the factor cross-section, the strongest naive screen is a ${strongest.name.toLowerCase()} rank (IC ${strongest.rankIC}); that is a different benchmark/horizon/cost basis and is NOT a threshold these strategy numbers can be read against.` : '.'} Consistent with the app's honest finding: only momentum carries weak edge, and regime avoidance is the one durable lever.`,
  };
}

module.exports = { BASELINE_DEFS, IC_MEANINGFUL, APPLIED_KEYS, FACTOR_BASIS, STRATEGY_BASIS, readFactor, assembleBaselines };

'use strict';
// OMEGA ENSEMBLE — VIEW-MODEL (spec §9).
//
// WHAT THIS IS: a pure COMPOSITION over engines that already exist. It scores NOTHING.
//
// WHY IT SCORES NOTHING: the spec asks for an ensemble page over all the app's algorithms.
// That ensemble is already built and running — `op=today` (lib/decision.js) merges every
// adapter into one canonical, redundancy-discounted, cost-charged, regime-gated ranking,
// and `op=evolve` (lib/evolve.js) carries the calibrated-probability / abstention layer.
// Re-deriving any of that here would create a SECOND scorer to keep in sync with the
// first — the exact hazard `lib/ghost.js` was deliberately designed around (it renders
// server-computed scores rather than duplicating the scorer, because `lib/apex.js` and its
// index.html twin had to be hand-synced and drifted). It would also burn the last of the
// 12 Vercel Hobby function slots (api/ is at 11).
//
// So every number this module emits is PASSED THROUGH from the engine that computed it,
// with a `source` naming that engine. If a field is absent upstream, it is reported absent
// — never defaulted into a plausible-looking number. That is the spec's own rule: every
// displayed metric must trace to a real calculation.
//
// Pure: payloads in → a render-ready view model out. No network, no state.

const VIEW_VERSION = 'omega-ensemble-view-v1';

// A metric the page wants that no engine actually produces is reported as absent rather
// than synthesized. `label` is what the UI shows in place of a number.
const ABSENT = (why) => ({ known: false, value: null, why });

const num = (v) => (Number.isFinite(v) ? v : null);

// ── Summary panel ───────────────────────────────────────────────────────────
// Regime, model version, freshness, validation status, production/fallback mode.
function buildSummary(today, health) {
  const t = today || {};
  const h = health || null;
  const regime = t.regime || {};

  // The regime engine returns a HARD label (lib/macro.js) plus a soft 13-axis vector
  // (lib/evolve-regime.js). It does NOT return a probability distribution over regime
  // types — so we surface the label and say so, rather than inventing percentages.
  const regimeBlock = {
    label: regime.label || null,
    riskOn: regime.riskOn === true,
    bearish: regime.bearish === true,
    breadthPct: num(regime.breadthPct),
    condition: regime.condition || null,
    probabilities: ABSENT('the regime engine emits a hard label plus a 13-axis soft vector, not a probability distribution over regime types'),
    source: 'lib/macro.js + lib/evolve-regime.js (via op=today)',
  };

  const redundancy = t.redundancy || null;

  // op=evolvehealth reports the multiple-testing gate under `deflatedSharpe` and carries
  // its OWN verdict string. We pass that through rather than re-writing the prose here:
  // the engine that ran the test owns what the test concluded, and a second wording is a
  // second thing to drift.
  //
  // NB the first prod run said "op=evolvehealth did not answer" while sources.evolvehealth
  // was ok:true — this block had been coded against a guessed `h.dsr` shape. An absent
  // FIELD and an absent ANSWER are different failures and must not share a message.
  const ds = h && h.deflatedSharpe ? h.deflatedSharpe : null;
  const validation = !h
    ? { known: false, verdict: 'validation status unavailable — op=evolvehealth did not answer', source: null }
    : !ds
      ? { known: false, verdict: 'op=evolvehealth answered but reported no deflated-Sharpe block', source: 'op=evolvehealth' }
      : {
        known: true,
        trials: num(ds.trials),
        passing: num(ds.passing),
        // 0 survivors is a RESULT, not a missing value — the gate doing its job. The page
        // must say so plainly rather than look broken.
        verdict: ds.verdict || (ds.passing === 0
          ? 'no cell survives multiple-testing'
          : `${ds.passing} of ${ds.trials} cells survive multiple testing`),
        threshold: num(ds.passDSR),
        source: 'lib/evolve-dsr.js (via op=evolvehealth)',
      };

  // The §9 summary asks for model version, training evidence and calibration quality.
  // All of it already exists on op=evolvehealth — surfaced rather than re-derived.
  const model = h ? {
    known: true,
    version: h.version || null,
    resolvedSamples: num(h.resolved),
    calibrated: h.calibrated === true,
    calibrationError: num(h.calibrationError),
    brier: num(h.calibration && h.calibration.brier),
    source: 'lib/evolve.js + lib/rankquality.js (via op=evolvehealth)',
  } : { known: false, source: null };

  return {
    generatedAt: t.generatedAt || null,
    regime: regimeBlock,
    redundancy: redundancy ? {
      method: redundancy.method || null,
      version: redundancy.version || null,
      verdict: redundancy.verdict || null,
      measurablePairs: num(redundancy.measurablePairs),
      totalPairs: num(redundancy.totalPairs),
      avgMeasuredCredit: num(redundancy.avgMeasuredCredit),
      avgConfirmationLift: num(redundancy.avgConfirmationLift),
      source: 'lib/redundancy.js (via op=today)',
    } : null,
    validation,
    model,
    // Production vs fallback is a real, observable distinction here: the ranking runs on
    // MEASURED redundancy or on the asserted family prior.
    mode: redundancy && redundancy.method === 'measured' ? 'production (measured redundancy)' : 'fallback (asserted family prior)',
    freshness: Array.isArray(t.freshness) ? t.freshness : null,
    warnings: Array.isArray(t.warnings) ? t.warnings : [],
    schema: { view: VIEW_VERSION, decision: t.schemaVersion || null },
  };
}

// ── Ranking rows ────────────────────────────────────────────────────────────
// One row per held name. Everything is passed through from op=today; the only thing this
// adds is the shape.
function rowOf(s) {
  const cost = s.cost || null;
  const ev = s.evidence || null;
  const exp = s.expectancy || null;
  return {
    rank: s.portfolioRank ?? s.rank ?? null,
    ticker: s.ticker,
    company: s.company || null,
    horizon: s.horizon,
    side: s.side || 'long',
    sector: s.sector || null,
    strategyFamily: s.strategyFamily || null,
    score: num(s.score),
    confidence: num(s.confidence),

    // §9 asks for 2/5/10-day probabilities. The decision engine emits a composite and a
    // realized track record — NOT a calibrated per-horizon probability ladder. EVOLVE has
    // calibrated probabilities but only for names it surfaces, and it currently abstains
    // on everything (its own backfill showed these specialists below barrier breakeven).
    // Rather than dress the composite up as a probability, we say what is missing.
    probabilities: ABSENT('no calibrated per-horizon probability exists for this name — the composite is a rank, not a probability, and EVOLVE abstains on this population'),

    // What IS real: the realized, sector-benchmarked track record of this name's
    // section:tier, straight from the Scoreboard.
    trackRecord: exp && exp.known ? {
      known: true,
      avgExcess: num(exp.avgExcess), median: num(exp.median), ci: exp.ci || null,
      winRate: num(exp.winRate), n: num(exp.n) || 0, horizon: exp.horizonKey || null,
      source: 'Scoreboard realized excess vs benchmark (via lib/decision.js expectancyFor)',
    } : { known: false, source: null },

    // The cost waterfall — gross target move → round trip → net (§7).
    cost: cost ? {
      known: cost.known === true,
      grossMovePct: num(cost.grossMovePct),
      roundTripPct: num(cost.roundTripPct),
      netMovePct: num(cost.netMovePct),
      costShare: num(cost.costShare),
      penalty: num(cost.penalty),
      tier: cost.tier, tierLabel: cost.tierLabel, tierAssumed: cost.tierAssumed === true,
      modelVersion: cost.modelVersion || null,
      source: 'lib/decision-costs.js + lib/costs.js',
    } : null,

    // Independent-evidence accounting (§2) — raw count vs measured units.
    evidence: ev ? {
      rawSourceCount: Array.isArray(s.sources) ? s.sources.length : 1,
      declaredFamilyCount: num(ev.familyCount),
      effectiveUnits: num(ev.effectiveCount),
      measured: ev.measured === true,
      families: s.evidenceFamilies || [],
      discounted: ev.measured === true && Number.isFinite(ev.effectiveCount) && Number.isFinite(ev.familyCount)
        ? +(ev.familyCount - ev.effectiveCount).toFixed(2) : null,
      source: ev.measured ? 'lib/redundancy.js (measured from the ledgers)' : 'asserted family map (no measurement yet)',
    } : null,

    execution: s.execution ? { quality: num(s.execution.quality), penalties: s.execution.penalties || [] } : null,
    regimeFit: num(s.regimeFit),
    state: s.state || null,
    entry: num(s.entry), stop: num(s.stop), target: num(s.target), rr: num(s.rr),
    event: s.event || null,
    liquidity: s.liquidity || null,
  };
}

// ── The view ────────────────────────────────────────────────────────────────
function buildEnsembleView({ today, health } = {}) {
  const t = today || null;
  if (!t || t.ok === false) {
    return {
      version: VIEW_VERSION, ok: false,
      degraded: true,
      note: 'the decision engine (op=today) did not answer — nothing is rendered rather than a stale or invented board',
      summary: null, ranking: [], excluded: [], portfolio: null,
    };
  }
  const pf = t.portfolio || null;
  const selected = (pf && Array.isArray(pf.selected)) ? pf.selected : (Array.isArray(t.top) ? t.top : []);

  // Excluded candidates (§9) — only the STRONG ones removed for a real reason. A name
  // that simply ranked 40th is not an interesting exclusion; one that scored 99 and was
  // dropped for concentration is the whole point of the panel.
  const excluded = (pf && Array.isArray(pf.excluded) ? pf.excluded : [])
    .filter(e => e.reason !== 'size' && e.reason !== 'quality-floor')
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 20);

  return {
    version: VIEW_VERSION,
    ok: true,
    degraded: false,
    summary: buildSummary(t, health),
    ranking: selected.map(rowOf),
    excluded,
    portfolio: pf ? {
      method: pf.method, caps: pf.caps, exposure: pf.exposure,
      familyExposure: pf.familyExposure, unfilled: num(pf.unfilled),
      note: pf.note || null,
    } : null,
    counts: t.counts || null,
    // Everything the page deliberately does NOT show, and why. Rendered verbatim so the
    // page cannot quietly imply a capability the backend does not have.
    disclosures: [
      'This page composes existing engines (op=today, op=evolvehealth). It computes no score of its own — every number traces to the engine named in its source field.',
      'No calibrated 2/5/10-day probability ladder is shown: the composite is a RANK, not a probability. EVOLVE holds the calibrated layer and currently abstains on this population (its triple-barrier backfill put these specialists below breakeven).',
      'Concentration is proxied by sector and strategy archetype. The app has no pairwise ticker-correlation matrix, so no exclusion here claims a measured correlation.',
      'The app has no durable, regime-robust selection edge (long-short t≈0.53; 5y purged walk-forward negative; 0 of 18 cells survive the deflated-Sharpe gate). The one validated lever is regime avoidance. This page ranks and explains — it does not claim alpha.',
    ],
  };
}

module.exports = { VIEW_VERSION, buildEnsembleView, buildSummary, rowOf };

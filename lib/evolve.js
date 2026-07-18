// EVOLVE — CALIBRATED CONTEXTUAL ENSEMBLE (the decision core)
//
// EVOLVE does NOT train a new opaque alpha model on the app's ~0.08-IC raw features —
// the app's own multi-regime research proved those die out-of-sample (documented five
// times). Instead it treats the app's already-built, already-tracked engines as
// SPECIALISTS and puts the science where it's actually missing:
//
//   1. calibration      — turn each specialist's firing into a real, empirically-
//                         calibrated P(upper barrier first), not a 0-100 vanity score.
//   2. contextual gating— learn WHICH specialist works in WHICH context (regime × cap ×
//                         horizon) from resolved triple-barrier outcomes, with partial
//                         pooling so a tiny sample can't create an extreme weight.
//   3. honest abstention— return TRADE_CANDIDATE only when a calibrated edge clears an
//                         adaptive guardrail; otherwise WATCH / PROBE (paper) / ABSTAIN.
//                         EVOLVE is allowed — and expected — to return zero candidates.
//
// Everything here is PURE (no network, no clock, no RNG): the ledgers + regime + live
// signals are injected, so it is fully unit-testable and its exploration is DETERMINISTIC
// and auditable (a reproducibility gate the app requires before promotion).
//
// The "EVOLVE score" is a MONOTONE PRESENTATION layer over the honest components
// (calibrated P, expected net payoff, agreement, regime support) purely for ordering —
// it is never surfaced as a probability.

'use strict';

const { wilson } = require('./stats');
const R = require('./redundancy');

const EVOLVE_VERSION = 'evolve-core-v1';

// ── Specialists: the app's engines, grouped into the 7 archetypes from the brief ──────
// Each live source (a decision-engine `source`) maps to one specialist. Grouping is what
// prevents ten correlated momentum screeners from voting as ten independent specialists.
const SPECIALISTS = [
  'quietAccumulation', 'momentumIgnition', 'compressionExpansion',
  'catalystFundamental', 'relativeStrengthRotation', 'postShockContinuation',
  'existingSignalEnsemble',
];
const SPECIALIST_META = {
  quietAccumulation:        { icon: '👻', label: 'Quiet accumulation',      blurb: 'Pre-breakout volume/insider footprint.' },
  momentumIgnition:         { icon: '🚀', label: 'Momentum ignition',        blurb: 'Confirmed trend / breakout continuation.' },
  compressionExpansion:     { icon: '🌀', label: 'Compression → expansion',  blurb: 'Volatility coil resolving into a move.' },
  catalystFundamental:      { icon: '⚡', label: 'Catalyst / fundamentals',  blurb: 'Events, revisions, forced flow.' },
  relativeStrengthRotation: { icon: '🔄', label: 'Relative-strength rotation', blurb: 'Sector/peer leadership rotation.' },
  postShockContinuation:    { icon: '🔗', label: 'Post-shock continuation',   blurb: 'Read-through / second-wave off a mover.' },
  existingSignalEnsemble:   { icon: '🧭', label: 'Ensemble consensus',        blurb: 'The unified decision-engine composite.' },
};
// decision-engine source → specialist.
const SOURCE_SPECIALIST = {
  ghost: 'quietAccumulation', anomaly: 'quietAccumulation', stealth: 'quietAccumulation', opportunities: 'quietAccumulation',
  screener: 'momentumIgnition', momentum: 'momentumIgnition', coremo: 'momentumIgnition',
  daytrade: 'momentumIgnition', gapgo: 'momentumIgnition',
  coil: 'compressionExpansion',
  biotech: 'catalystFundamental', cern: 'catalystFundamental', gapdown: 'catalystFundamental',
  toneshift: 'catalystFundamental', tone: 'catalystFundamental', putsell: 'catalystFundamental', fade: 'catalystFundamental',
  confluence: 'relativeStrengthRotation', trendrider: 'relativeStrengthRotation', rotation: 'relativeStrengthRotation',
  readthrough: 'postShockContinuation', secondwave: 'postShockContinuation', crossasset: 'postShockContinuation',
};
function sourceToSpecialists(sources) {
  const set = new Set();
  for (const s of sources || []) { const sp = SOURCE_SPECIALIST[s]; if (sp) set.add(sp); }
  return [...set];
}

// ── Decision states + guardrails ─────────────────────────────────────────────────────
const DECISION_STATES = ['TRADE_CANDIDATE', 'WATCH', 'PROBE', 'ABSTAIN'];
const DECISION_META = {
  TRADE_CANDIDATE: { icon: '✅', label: 'Trade candidate', blurb: 'Calibrated edge clears the guardrail with adequate support.' },
  WATCH:           { icon: '👀', label: 'Watch',           blurb: 'Promising but below the promotion threshold.' },
  PROBE:           { icon: '🧪', label: 'Probe (paper)',    blurb: 'Exploration pick — paper-only, never counted as validated alpha.' },
  ABSTAIN:         { icon: '🚫', label: 'Abstain',          blurb: 'Inadequate edge, sample, data, or a regime veto.' },
};

const GUARDRAILS = {
  minEffSample: 12,        // effective resolved samples in context before a TRADE is allowed
  watchMinEffN: 5,         // minimum sample before a name is even WATCH-worthy (below → abstain,
                           // honestly "no track record yet" — a bare prior is not evidence)
  minEdgeP: 0.01,          // calibrated P must beat the barrier-implied breakeven by ≥ this
  minPayoff: 0.005,        // expected net payoff floor (after est. costs), as a fraction
  maxProbeShare: 0.20,     // cap PROBE selections to ≤20% of evaluated candidates …
  maxProbeCount: 9,        // … AND an absolute ceiling (exploration is a FEW paper picks, not dozens)
  minLiquidity: 0.4,       // execution-quality floor for TRADE (below → WATCH at best)
  wilsonZ: 1.645,          // 90% one-sided interval for uncertainty + exploration optimism
};

// Barrier-implied breakeven probability: to break even a win pays +up, a loss costs
// −down (before costs), so p_be = down / (up + down). A calibrated P must clear this
// PLUS the payoff floor to be a real edge — a +8/−4 barrier needs P > 1/3 just to break
// even, which is why raw "hit rate" is meaningless without the geometry.
function breakevenProb({ up, down }) {
  const u = up || 0.08, d = down || 0.04;
  return d / (u + d);
}

// ── Partial-pooling (empirical-Bayes shrinkage) ──────────────────────────────────────
// A specialist's win rate in a specific context (regime × cap × horizon) is shrunk toward
// its own global rate, which is itself shrunk toward a conservative prior. Tiny samples
// stay near the prior; large samples earn their empirical rate. This is what stops a
// 3-for-3 fluke in one context from producing an extreme weight.
function pooledRate({ ctxWins = 0, ctxN = 0, globalWins = 0, globalN = 0, priorP = 0.4, priorStrength = 20, ctxStrength = 15 }) {
  const globalRate = (globalWins + priorP * priorStrength) / (globalN + priorStrength);
  const rate = (ctxWins + globalRate * ctxStrength) / (ctxN + ctxStrength);
  const effN = ctxN + globalN * 0.25;   // context counts full; global lends partial support
  return { rate: +rate.toFixed(4), globalRate: +globalRate.toFixed(4), effN: +effN.toFixed(1) };
}

// A specialist's calibrated P(win) for a candidate in the current context, from the
// resolved-outcome ledger. `perf` is the specialist_performance summary for this
// specialist: { global:{wins,n}, byContext:{ '<ctxKey>':{wins,n} } }. Cold-start (no
// ledger) → returns the conservative prior with effN 0 (→ never enough for TRADE alone).
function specialistProb(perf, ctxKey, { priorP = 0.4 } = {}) {
  const g = (perf && perf.global) || { wins: 0, n: 0 };
  const c = (perf && perf.byContext && perf.byContext[ctxKey]) || { wins: 0, n: 0 };
  const pooled = pooledRate({ ctxWins: c.wins, ctxN: c.n, globalWins: g.wins, globalN: g.n, priorP });
  return { p: pooled.rate, effN: pooled.effN, ctxN: c.n, globalN: g.n, cold: g.n === 0 && c.n === 0 };
}

// ── Meta-weights: which specialist to trust in this context ───────────────────────────
// Each firing specialist's weight = its effective-sample trust × recent-OOS-performance
// factor × drift penalty. Partial-pooled (sample-based trust) so low-sample specialists
// get little say. Weights are normalized across the firing specialists for this candidate.
function metaWeights(firing, { driftById = {}, perfById = {} } = {}) {
  const raw = firing.map(sp => {
    const perf = perfById[sp] || {};
    const recent = perf.recent || {};                 // { ic, hit, n } recent OOS window
    const globalN = (perf.global && perf.global.n) || 0;
    const trust = globalN / (globalN + 20);           // 0→1 as samples accumulate
    // Recent OOS performance factor: reward positive recent IC/hit, penalize negative.
    const icFactor = Number.isFinite(recent.ic) ? Math.max(0.4, Math.min(1.6, 1 + recent.ic * 4)) : 1;
    const drift = driftById[sp];
    const driftPenalty = drift === 'BROKEN' ? 0.3 : drift === 'DEGRADING' ? 0.7 : 1;
    // A cold specialist still gets a small floor weight (prior), never zero, so it can
    // start earning a track record.
    const w = Math.max(0.05, trust * icFactor * driftPenalty);
    return { specialist: sp, weight: w, trust: +trust.toFixed(3), icFactor: +icFactor.toFixed(2), drift: drift || 'HEALTHY' };
  });
  const total = raw.reduce((s, x) => s + x.weight, 0) || 1;
  return raw.map(x => ({ ...x, weight: +(x.weight / total).toFixed(4) }));
}

// ── Ensemble probability + agreement ─────────────────────────────────────────────────
// Weighted average of the firing specialists' calibrated P's. Agreement = 1 − normalized
// dispersion across specialists (low spread ⇒ specialists concur ⇒ higher confidence).
// `opts.redundancyModel` (measured pairwise credits from lib/redundancy.js) discounts the summed
// effN by the specialists' EFFECTIVE INDEPENDENCE: two ~0.96-correlated specialists must not count
// as two independent samples toward the TRADE gate. independenceRatio = effectiveSources / firing,
// so a redundant pair collapses toward one specialist's worth of effN. With no model the ratio is 1
// and effN is byte-identical to before (safe default).
function ensembleProbability(contribs, weights, { redundancyModel = null, familyOf = null, priorCredit = 0.3 } = {}) {
  if (!contribs.length) return { p: null, agreement: null, effN: 0, effNRaw: 0, independenceRatio: 1 };
  const wById = Object.fromEntries(weights.map(w => [w.specialist, w.weight]));
  let p = 0, wsum = 0, rawEffN = 0;
  for (const c of contribs) { const w = wById[c.specialist] || 0; p += w * c.p; wsum += w; rawEffN += c.effN; }
  p = wsum ? p / wsum : null;
  const ps = contribs.map(c => c.p);
  const m = ps.reduce((s, x) => s + x, 0) / ps.length;
  const disp = Math.sqrt(ps.reduce((s, x) => s + (x - m) ** 2, 0) / ps.length);
  const agreement = +Math.max(0, 1 - disp * 3).toFixed(3);   // ~0.33 spread ⇒ 0 agreement

  const specialists = contribs.map(c => c.specialist);
  let independenceRatio = 1, redundantAgreement = false;
  if (redundancyModel && specialists.length >= 2) {
    const ev = R.effectiveEvidence(specialists, { model: redundancyModel, familyOf: familyOf || (() => null), priorCredit });
    independenceRatio = Math.max(0, Math.min(1, ev.score / specialists.length));
    redundantAgreement = ev.redundantAgreement;
  }
  const effN = rawEffN * independenceRatio;
  return {
    p: p == null ? null : +p.toFixed(4), agreement,
    effN: +effN.toFixed(1), effNRaw: +rawEffN.toFixed(1),
    independenceRatio: +independenceRatio.toFixed(3), redundantAgreement,
  };
}

// Build a measured specialist-redundancy model from resolved EVOLVE events (reuses
// lib/redundancy.js). Each event contributes one row per FIRING specialist keyed on (date,ticker)
// with the SPY-relative outcome, so overlap + realized-return correlation are measured between
// specialists exactly as lib/redundancy does for algorithms. Returns null when there are too few
// rows to measure anything (→ ensembleProbability then leaves effN undiscounted).
function buildSpecialistRedundancy(rows, { priorCredit = 0.3 } = {}) {
  const specRows = [];
  for (const r of rows || []) {
    if (!r || !r.predDate || !r.ticker) continue;
    const excess = Number.isFinite(r.spyRelReturn) ? r.spyRelReturn
      : Number.isFinite(r.sectorRelReturn) ? r.sectorRelReturn
      : Number.isFinite(r.terminalReturn) ? r.terminalReturn : null;
    const specs = (r.specialists && r.specialists.length) ? r.specialists : (r.contribs || []).map(c => c.specialist);
    for (const sp of specs) if (sp) specRows.push({ date: r.predDate, ticker: r.ticker, algorithm: sp, excess });
  }
  if (specRows.length < 20) return null;
  return R.buildRedundancyModel(specRows, { priorCredit });
}

// Expected NET payoff (fraction) after estimated slippage/cost, using barrier geometry
// for win/loss magnitudes unless the ledger provides realized averages.
function expectedPayoff(p, { up, down, slippagePct = 0, avgWin = null, avgLoss = null }) {
  if (p == null) return null;
  const win = Number.isFinite(avgWin) ? avgWin : up;
  const loss = Number.isFinite(avgLoss) ? Math.abs(avgLoss) : down;
  const cost = (slippagePct || 0) / 100 * 2;          // entry + exit
  return +(p * win - (1 - p) * loss - cost).toFixed(4);
}

// Uncertainty interval on the ensemble P given its effective sample (Wilson).
function uncertaintyInterval(p, effN, z = GUARDRAILS.wilsonZ) {
  if (p == null || !effN) return { lo: null, hi: null, width: null };
  const wins = Math.round(p * effN);
  const { lo, hi } = wilson(wins, Math.round(effN), z);
  return { lo: +lo.toFixed(3), hi: +hi.toFixed(3), width: +(hi - lo).toFixed(3) };
}

// Exploration optimism (auditable, deterministic — an "optimism-under-uncertainty" stand-in
// for discounted Thompson sampling): how much the upper confidence bound exceeds the point
// estimate. High for promising-but-thinly-sampled names — exactly what PROBE should chase.
function explorationBonus(p, effN, z = GUARDRAILS.wilsonZ) {
  if (p == null || !effN) return p == null ? 0 : 0.5;   // no data ⇒ maximally uncertain
  const { hi } = uncertaintyInterval(p, effN, z);
  return +Math.max(0, (hi ?? p) - p).toFixed(3);
}

// Adaptive TRADE threshold: the breakeven prob + a margin that TIGHTENS in risk-off and
// when the model is poorly calibrated, and eases in a supportive regime with good
// calibration — but never below a hard floor (guardrail).
function adaptiveThreshold({ regime = {}, calibrationError = null } = {}, barriers) {
  const be = breakevenProb(barriers);
  let margin = GUARDRAILS.minEdgeP;
  const riskOff = regime.bearish === true || regime.riskOn === false;
  if (riskOff) margin += 0.06;                         // demand a bigger edge in risk-off
  else if (regime.riskOn === true) margin += 0.0;
  else margin += 0.02;                                // neutral
  if (Number.isFinite(calibrationError)) margin += Math.min(0.06, calibrationError * 0.3);
  return +(be + Math.max(GUARDRAILS.minEdgeP, margin)).toFixed(4);
}

// ── Decision state machine ────────────────────────────────────────────────────────────
// Deterministic + auditable. Order of vetoes matters: data/regime vetoes → ABSTAIN before
// anything else, so a risk-off long or a data-quality failure can never surface as a trade.
function decideState({ p, payoff, effN, threshold, regimeVeto, dataOk, liquidityOk, exploreSelected, dsrVeto = false }) {
  if (!dataOk) return { state: 'ABSTAIN', reason: 'data quality insufficient' };
  if (regimeVeto) return { state: 'ABSTAIN', reason: 'regime veto (stand down)' };
  if (p == null) return { state: 'ABSTAIN', reason: 'no probability estimate' };
  const clearsEdge = p >= threshold && (payoff == null || payoff >= GUARDRAILS.minPayoff);
  const enoughSample = effN >= GUARDRAILS.minEffSample;
  const watchSample = effN >= GUARDRAILS.watchMinEffN;
  // dsrVeto = this specialist×regime×horizon cell has NOT survived the deflated-Sharpe /
  // multiple-testing gate → not TRADE-eligible (its apparent edge may be selection bias).
  // It does NOT force ABSTAIN — a name that otherwise clears becomes WATCH (promising, watched).
  if (clearsEdge && enoughSample && liquidityOk && !dsrVeto) return { state: 'TRADE_CANDIDATE', reason: 'calibrated edge + support' };
  // Exploration (paper) can pick a promising name up REGARDLESS of sample — that is how a
  // cold context earns a track record. Capped + never counted as validated alpha.
  if (clearsEdge && exploreSelected) return { state: 'PROBE', reason: enoughSample ? 'illiquid — paper only' : 'thin sample — paper probe' };
  // WATCH requires SOME real track record — a bare prior with no resolved samples is not
  // evidence, so a cold name abstains (honestly) rather than masquerading as "promising".
  if (clearsEdge && watchSample) return { state: 'WATCH', reason: dsrVeto ? 'edge not yet significant after multiple-testing (watched)' : liquidityOk ? 'promising but below promotion threshold' : 'promising but illiquid' };
  if (p >= threshold - 0.03 && watchSample) return { state: 'WATCH', reason: 'near threshold, insufficient conviction' };
  return { state: 'ABSTAIN', reason: watchSample ? 'edge below guardrail' : 'no resolved track record yet' };
}

// Monotone EVOLVE score for ORDERING only (not a probability). Rewards expected payoff
// first, then calibrated edge over breakeven, agreement, and regime support; penalizes a
// wide uncertainty band and an extended/chased entry.
function evolveScore({ payoff, p, breakeven, agreement, regimeSupport, uncertaintyWidth, extensionPenalty = 0 }) {
  if (p == null) return 0;
  const edge = Math.max(0, p - (breakeven ?? 0.4));
  const s = 100 * (
    0.45 * Math.max(0, Math.min(1, (payoff ?? 0) * 8 + 0.5) - 0.5) * 2   // payoff, centered
    + 0.30 * Math.min(1, edge * 6)
    + 0.12 * (agreement ?? 0)
    + 0.13 * (regimeSupport ?? 0)
  ) * (1 - 0.3 * (uncertaintyWidth ?? 0)) * (1 - extensionPenalty);
  return +Math.max(0, Math.min(100, s)).toFixed(1);
}

// The context key a candidate's outcomes are bucketed under, for gating + resolution.
function contextKey({ regimeLabel = 'neutral', cap = 'unknown', horizon = 'swing' }) {
  return `${regimeLabel}|${cap}|${horizon}`;
}
const capBucket = (dollarVol) => {
  if (!Number.isFinite(dollarVol)) return 'unknown';
  if (dollarVol >= 5e8) return 'mega';
  if (dollarVol >= 5e7) return 'large';
  if (dollarVol >= 5e6) return 'mid';
  return 'small';
};

// ── Score ONE candidate ───────────────────────────────────────────────────────────────
// `sig` is an enriched decision-engine signal (from op=today): ticker, horizon, sources,
// side, liquidity, execution, regimeFit, percentile, state, evidence, price/entry/stop.
// `ctx` injects the ledgers + regime + calibrator + exploration budget.
function scoreCandidate(sig, ctx = {}) {
  const { regime = {}, regimeVector = null, perfBySpecialist = {}, driftBySpecialist = {},
    calibrator = null, priorP = 0.4, barriersByHorizon = {}, regimeSupport = 0.5,
    exploreAllow = false, redundancyModel = null } = ctx;

  const evHorizon = ctx.horizonOf ? ctx.horizonOf(sig.horizon) : (sig.evolveHorizon || 'swing');
  const barriers = barriersByHorizon[evHorizon] || { up: 0.15, down: 0.07, window: 21 };
  const cap = capBucket(sig.liquidity && sig.liquidity.dollarVol);
  const ctxKey = contextKey({ regimeLabel: regime.label || (regime.bearish ? 'risk-off' : regime.riskOn ? 'risk-on' : 'neutral'), cap, horizon: evHorizon });

  const firing = sourceToSpecialists(sig.sources && sig.sources.length ? sig.sources : [sig.source]);
  const contribs = firing.map(sp => {
    const { p, effN, ctxN, globalN, cold } = specialistProb(perfBySpecialist[sp], ctxKey, { priorP });
    return { specialist: sp, p, effN, ctxN, globalN, cold };
  });
  const weights = metaWeights(firing, { driftById: driftBySpecialist, perfById: perfBySpecialist });
  let { p, agreement, effN, effNRaw, independenceRatio } = ensembleProbability(contribs, weights, { redundancyModel });
  // Apply the global calibration map (identity when the ledger is cold).
  const rawP = p;
  if (p != null && calibrator) p = applyCalibrator(calibrator, p);

  const be = breakevenProb(barriers);
  const slippagePct = (sig.liquidity && sig.liquidity.slippageEst) || null;
  const payoff = expectedPayoff(p, { up: barriers.up, down: barriers.down, slippagePct });
  const uncertainty = uncertaintyInterval(p, effN);
  const explore = explorationBonus(p, effN);
  const threshold = adaptiveThreshold({ regime, calibrationError: calibrator && calibrator.error }, barriers);

  // Regime veto = the one validated lever: a long stands down in risk-off.
  const regimeVeto = (sig.side !== 'short') && (regime.bearish === true || regime.riskOn === false);
  // Data quality: we must at least know the price and have a firing specialist.
  const dataOk = Number.isFinite(sig.price) && firing.length > 0 && (sig.dataQuality !== 'bad');
  const liquidityOk = (sig.execution && sig.execution.quality != null ? sig.execution.quality : 1) >= GUARDRAILS.minLiquidity;
  // Extension/novelty penalty: a chased ('extended') or very-extended name has less room.
  const extensionPenalty = sig.state === 'extended' ? 0.3 : (sig.percentile != null && sig.percentile > 97 ? 0.15 : 0);

  const exploreSelected = exploreAllow && explore >= 0.15;   // caller gates the budget/cap
  // Deflated-Sharpe gate: when the resolved ledger has produced a survivors list, a candidate
  // is only TRADE-eligible if one of its firing specialists' cell (specialist×regime×horizon)
  // survived the multiple-testing gate. `null`/absent survivors ⇒ gate inactive (no veto).
  const regimeCellLabel = regime.label || (regime.bearish ? 'risk-off' : regime.riskOn ? 'risk-on' : 'neutral');
  const dsrVeto = Array.isArray(ctx.dsrSurvivors)
    ? !firing.some(sp => ctx.dsrSurvivors.includes(`${sp}|${regimeCellLabel}|${evHorizon}`))
    : false;
  const decision = decideState({ p, payoff, effN, threshold, regimeVeto, dataOk, liquidityOk, exploreSelected, dsrVeto });

  const score = evolveScore({ payoff, p, breakeven: be, agreement, regimeSupport, uncertaintyWidth: uncertainty.width, extensionPenalty });

  return {
    ticker: sig.ticker, company: sig.company || null, horizon: evHorizon,
    side: sig.side || 'long', sources: sig.sources || [sig.source],
    specialists: firing, specialistMeta: firing.map(sp => SPECIALIST_META[sp]),
    contribs, weights,
    probability: p, rawProbability: rawP, breakeven: +be.toFixed(3),
    edge: p == null ? null : +(p - be).toFixed(4),
    expectedPayoff: payoff, uncertainty, explorationBonus: explore,
    agreement, effSample: effN, effSampleRaw: effNRaw, independenceRatio, regimeSupport, threshold,
    calibrated: !!calibrator,
    decision: decision.state, decisionReason: decision.reason, decisionMeta: DECISION_META[decision.state],
    regimeVeto, dsrVeto, extensionPenalty, contextKey: ctxKey, cap,
    barriers, price: sig.price ?? null, entry: sig.entry ?? null, stop: sig.stop ?? null, target: sig.target ?? null,
    liquidityWarn: !liquidityOk ? (sig.execution && sig.execution.penalties) || ['thin'] : null,
    score,
  };
}

// ── Simple binned calibrator (Platt-lite) ─────────────────────────────────────────────
// Fit an isotonic-ish monotone map from raw ensemble P → empirical hit rate using resolved
// records [{ p, won }]. Cold/thin → identity (returns null so callers skip calibration).
// The binned monotone map (edges = bin midpoints, table = empirical hit rate), pooled non-decreasing.
// Extracted so the k-fold OOF Brier below fits the SAME calibrator shape on each training fold.
function binnedMap(rows, bins) {
  const edges = [], table = [];
  for (let b = 0; b < bins; b++) {
    const lo = b / bins, hi = (b + 1) / bins;
    const seg = rows.filter(r => r.p >= lo && (b === bins - 1 ? r.p <= hi : r.p < hi));
    const mid = (lo + hi) / 2;
    const actual = seg.length ? seg.filter(r => r.won).length / seg.length : mid;
    edges.push(mid); table.push(+actual.toFixed(4));
  }
  for (let i = 1; i < table.length; i++) if (table[i] < table[i - 1]) table[i] = table[i - 1];  // PAV, light touch
  return { edges, table };
}

// OUT-OF-FOLD calibrator Brier (audit #18). The in-sample Brier flatters calibration because it is
// scored on the SAME rows the map was fit on. This does k-fold CV: fit the map on k-1 folds, score
// the CALIBRATED probability on the held-out fold, and report the mean Brier — plus the raw-P OOF
// Brier so you can see whether calibration actually HELPS out of sample. Deterministic (round-robin
// folds by index — no RNG). Returns null when too thin to split.
function oofCalibratorBrier(rows, { bins = 5, folds = 5 } = {}) {
  if (rows.length < folds * 8) return null;
  let sqCal = 0, sqRaw = 0, n = 0;
  for (let f = 0; f < folds; f++) {
    const train = rows.filter((_, i) => i % folds !== f);
    const test = rows.filter((_, i) => i % folds === f);
    if (!test.length || !train.length) continue;
    const cal = binnedMap(train, bins);
    for (const r of test) {
      const y = r.won ? 1 : 0;
      const pc = applyCalibrator({ edges: cal.edges, table: cal.table }, r.p);
      sqCal += (pc - y) ** 2; sqRaw += (r.p - y) ** 2; n++;
    }
  }
  if (!n) return null;
  return { oofBrier: +(sqCal / n).toFixed(4), oofBrierRaw: +(sqRaw / n).toFixed(4), folds, n };
}

function fitCalibrator(resolved, { bins = 5, minN = 40 } = {}) {
  const rows = (resolved || []).filter(r => r && Number.isFinite(r.p) && (r.won === true || r.won === false));
  if (rows.length < minN) return null;
  const { edges, table } = binnedMap(rows, bins);
  // `error` kept for continuity: the in-sample RAW-P Brier (optimistic — see oofBrier for the honest read).
  const brier = +(rows.reduce((s, r) => s + (r.p - (r.won ? 1 : 0)) ** 2, 0) / rows.length).toFixed(4);
  const oof = oofCalibratorBrier(rows, { bins });
  return {
    version: EVOLVE_VERSION, edges, table, n: rows.length, error: brier, inSampleBrierRaw: brier,
    oofBrier: oof ? oof.oofBrier : null,           // calibrated, out-of-fold — the honest metric
    oofBrierRaw: oof ? oof.oofBrierRaw : null,      // raw P, out-of-fold — the baseline it must beat
    calibrationHelpsOOS: oof ? oof.oofBrier < oof.oofBrierRaw : null,
  };
}
function applyCalibrator(cal, p) {
  if (!cal || !cal.edges || !cal.edges.length) return p;
  const { edges, table } = cal;
  if (p <= edges[0]) return table[0];
  if (p >= edges[edges.length - 1]) return table[table.length - 1];
  for (let i = 1; i < edges.length; i++) {
    if (p <= edges[i]) {
      const t = (p - edges[i - 1]) / (edges[i] - edges[i - 1] || 1);
      return +(table[i - 1] + t * (table[i] - table[i - 1])).toFixed(4);
    }
  }
  return p;
}

// ── Build the full EVOLVE surface from a batch of enriched signals ────────────────────
// Enforces the PROBE cap (≤ maxProbeShare of surfaced candidates), buckets by horizon,
// and returns the abstained set for transparency (why names were NOT surfaced).
function buildEvolve(signals, ctx = {}) {
  const horizonOf = ctx.horizonOf || ((h) => ({ intraday: 'fast', swing: 'swing', position: 'position', portfolio: 'position' }[h] || 'swing'));
  const scored = (signals || []).map(sig => scoreCandidate(sig, { ...ctx, horizonOf, exploreAllow: false }));

  // Exploration: among names that clear the edge on the point estimate but were held back
  // for thin sample/illiquidity, promote the highest-optimism few to PROBE, up to the cap.
  const surfaced = scored.filter(s => s.decision === 'TRADE_CANDIDATE' || s.decision === 'WATCH');
  const probeCandidates = scored
    .filter(s => s.decision !== 'TRADE_CANDIDATE' && s.probability != null && s.probability >= s.threshold && !s.regimeVeto);
  // Cap PROBE to a small share of ALL candidates EVOLVE evaluated AND an absolute ceiling —
  // exploration is a FEW paper picks, and it still runs on a cold ledger (which is exactly
  // when exploration matters). Spread the budget ACROSS horizons via round-robin so a
  // ledger with no differentiating signal (all optimism tied) doesn't dump every probe
  // into one horizon by source order.
  const probeCap = Math.min(GUARDRAILS.maxProbeCount, Math.max(1, Math.floor(scored.length * GUARDRAILS.maxProbeShare)));
  const byH = { fast: [], swing: [], position: [] };
  for (const s of probeCandidates.slice().sort((a, b) => b.explorationBonus - a.explorationBonus || b.score - a.score)) {
    (byH[s.horizon] || (byH[s.horizon] = [])).push(s);
  }
  const probeSet = new Set();
  for (let i = 0; probeSet.size < probeCap && i < 999; i++) {
    let added = false;
    for (const h of ['fast', 'swing', 'position']) {
      if (probeSet.size >= probeCap) break;
      const pick = (byH[h] || [])[i];
      if (pick) { probeSet.add(pick.ticker + '|' + pick.horizon); added = true; }
    }
    if (!added) break;
  }
  const finalScored = scored.map(s => probeSet.has(s.ticker + '|' + s.horizon) && s.decision !== 'TRADE_CANDIDATE'
    ? { ...s, decision: 'PROBE', decisionReason: 'exploration probe (paper only)', decisionMeta: DECISION_META.PROBE }
    : s);

  const active = finalScored.filter(s => s.decision === 'TRADE_CANDIDATE' || s.decision === 'PROBE' || s.decision === 'WATCH');
  const byHorizon = {};
  for (const h of ['fast', 'swing', 'position']) {
    byHorizon[h] = active.filter(s => s.horizon === h)
      .sort((a, b) => (rankDecision(b.decision) - rankDecision(a.decision)) || (b.score - a.score));
  }
  const abstained = finalScored.filter(s => s.decision === 'ABSTAIN');
  return {
    version: EVOLVE_VERSION,
    byHorizon,
    counts: {
      surfaced: active.length, abstained: abstained.length,
      trade: active.filter(s => s.decision === 'TRADE_CANDIDATE').length,
      probe: active.filter(s => s.decision === 'PROBE').length,
      watch: active.filter(s => s.decision === 'WATCH').length,
    },
    abstainedSample: abstained.slice(0, 8).map(s => ({ ticker: s.ticker, reason: s.decisionReason })),
    specialistLegend: SPECIALIST_META, decisionLegend: DECISION_META,
  };
}
const DECISION_RANK = { TRADE_CANDIDATE: 3, PROBE: 2, WATCH: 1, ABSTAIN: 0 };
const rankDecision = (d) => DECISION_RANK[d] ?? 0;

module.exports = {
  EVOLVE_VERSION, SPECIALISTS, SPECIALIST_META, SOURCE_SPECIALIST, sourceToSpecialists,
  DECISION_STATES, DECISION_META, GUARDRAILS,
  breakevenProb, pooledRate, specialistProb, metaWeights, ensembleProbability, buildSpecialistRedundancy,
  expectedPayoff, uncertaintyInterval, explorationBonus, adaptiveThreshold, decideState,
  evolveScore, contextKey, capBucket, scoreCandidate, fitCalibrator, applyCalibrator, binnedMap, oofCalibratorBrier, buildEvolve,
};

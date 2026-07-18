'use strict';

// op=router — the Algorithm Effectiveness Monitor + conservative Market-Regime Router,
// surfaced as ONE shadow payload. It reads only cached artifacts and the live forward
// ledger; it does NOT touch the live rank (lib/decision.js). Its output is diagnostic:
// "which algorithms are working now, which are degrading, how much focus each deserves".
//
// Reuses, never reimplements:
//   • long-term skill  ← lib/maturity.classifyStrategies over scoreboard/summary.json
//     (the same Wilson-CI track record the Evidence board already trusts)
//   • independence     ← the cached measured redundancy model (apex/redundancy.json)
//   • current regime   ← lib/macro.fetchMacro (VIX + credit), + buildMacroLookup for the
//                        per-date regime buckets used to score regime compatibility
//   • recent series    ← lib/redundancy-routes.buildRows (force/cron only — it refetches
//                        candles, so it is trusted-only, exactly like op=redundancy)
//   • the reasoning    ← lib/algo-health (Monitor) + lib/algo-router (Router), both pure
//
// Persistence: the Router advances a small state doc (router/latest.json: current weights +
// cooldowns) ONLY on a trusted/force run, so hysteresis progresses once per cron tick and
// anonymous reads simply display the last persisted state recomputed against fresh health.

const { hasStore, readJSON, writeJSON } = require('./store');
const { classifyStrategies, MATURITY_VERSION } = require('./maturity');
const { STRATEGY_REGISTRY } = require('./strategy-registry');
const { loadRedundancyModel, buildRows } = require('./redundancy-routes');
const { creditFor } = require('./redundancy');
const { fetchMacro, buildMacroLookup } = require('./macro');
const { classifyAlgo, HEALTH_STATES, HEALTH_VERSION } = require('./algo-health');
const { routeWeights, ROUTER_VERSION } = require('./algo-router');
const { isTrusted } = require('./auth');

const STATE_DOC = 'router/latest.json';

// Coarse correlated-cluster map keyed by registry id. Kept LOCAL and explicit rather than
// bridging the three overlapping id spaces (registry id / scoreboard section / decision
// source) — a documented family table is less fragile than a chain of lookups. Anything
// unlisted is its own family (no shared cap). Clusters reflect the measured redundancy work
// (e.g. ghost×screener ≈ 0.96 correlated → same price-momentum family).
const FAMILY = {
  screener: 'price-momentum', momentum: 'price-momentum', ghost: 'price-momentum',
  coil: 'price-momentum', custom: 'price-momentum', biotech: 'price-momentum',
  gapgo: 'intraday-event', daytrade: 'intraday-event', gapdown: 'intraday-event',
  events: 'catalyst', readthrough: 'catalyst', secondwave: 'catalyst',
  downday: 'mean-reversion', fade: 'mean-reversion',
  crossasset: 'sentiment-context', toneshift: 'sentiment-context', tone: 'sentiment-context',
  anomaly: 'sentiment-context', attention: 'sentiment-context',
};
const familyOf = (id) => FAMILY[id] || id;

// Map a maturity `stats` block (percent scale, 0–100 beat-rate) onto the long-term skill
// shape lib/algo-health expects (0–1 beat-rate + CI). avgExcess sign is what matters for
// classification; its magnitude is reported verbatim.
function longTermFromStats(stats) {
  if (!stats || typeof stats.excessN !== 'number') return null;
  const pct = (x) => (typeof x === 'number' ? x / 100 : null);
  return {
    effN: stats.excessN,
    avgExcess: typeof stats.avgExcess === 'number' ? stats.avgExcess : null,
    beatRate: pct(stats.beatMktRate),
    ci: { lo: pct(stats.beatLo) ?? 0, hi: pct(stats.beatHi) ?? 1 },
    ready: stats.excessN >= 8,
  };
}

// Independence in [0,1] for one algorithm: the MINIMUM measured credit against any sibling
// it actually co-fires with (most conservative). null when no pair is measurable → the
// Monitor treats it as unknown. `creditFor` returns a family prior for unmeasured pairs, so
// we only count pairs present in the model's measured `credits` map.
function independenceFor(model, id, allIds) {
  if (!model || !model.credits) return null;
  let min = null;
  for (const other of allIds) {
    if (other === id) continue;
    const key = [id, other].sort().join('|');
    if (!(key in model.credits)) continue;
    const c = creditFor(model, id, other);
    if (typeof c === 'number') min = min == null ? c : Math.min(min, c);
  }
  return min;
}

// Regime compatibility in [0,1]: bucket an algorithm's resolved excess by the macro regime
// in force AT each pick date, then score how the CURRENT regime bucket ranks among the
// three. An algo that only paid in risk-on tape scores low when today is risk-off. null when
// the current bucket has too little history to judge.
function regimeCompatFor(series, macroLU, currentRegime) {
  if (!series || !series.length || !macroLU || !currentRegime) return null;
  const buckets = { 'risk-on': [], neutral: [], 'risk-off': [] };
  for (const r of series) {
    if (typeof r.excess !== 'number') continue;
    const st = macroLU.at(r.date);
    if (st && buckets[st.regime]) buckets[st.regime].push(r.excess);
  }
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const cur = buckets[currentRegime];
  if (!cur || cur.length < 3) return null; // not enough same-regime history
  const means = Object.values(buckets).map(avg).filter((x) => x != null);
  if (means.length < 2) return null;
  const lo = Math.min(...means), hi = Math.max(...means), curM = avg(cur);
  if (hi === lo) return 0.5;
  return Math.max(0, Math.min(1, (curM - lo) / (hi - lo)));
}

// Coarse market-state probability vector from the macro read. Not the full 13-dim regime
// vector (that needs index+sector fetches) — a documented proxy, flagged as such.
function marketBlock(macroNow, prevRegime) {
  if (!macroNow) {
    return { states: [], confidence: 0, changedRecently: false, evidence: [], note: 'macro feed unavailable' };
  }
  const off = Math.max(0, Math.min(1, macroNow.macroRisk / 100));
  const on = Math.max(0, 1 - off - 0.15);
  const neutral = Math.max(0, 1 - off - on);
  const norm = off + on + neutral || 1;
  const states = [
    { name: 'risk-off', probability: +(off / norm).toFixed(2) },
    { name: 'neutral', probability: +(neutral / norm).toFixed(2) },
    { name: 'risk-on', probability: +(on / norm).toFixed(2) },
  ].sort((a, b) => b.probability - a.probability);
  return {
    states,
    dominant: macroNow.regime,
    confidence: +Math.max(...states.map((s) => s.probability)).toFixed(2),
    changedRecently: prevRegime != null && prevRegime !== macroNow.regime,
    evidence: [
      `VIX ${macroNow.vix.level} (${macroNow.vix.pctile}th pctile${macroNow.vix.rising ? ', rising' : ''})`,
      `credit trend ${macroNow.credit.trend20}%${macroNow.credit.belowSma ? ' (below 50d)' : ''}`,
      `macro-risk ${macroNow.macroRisk}/100`,
    ],
    note: 'coarse VIX+credit proxy, not the full 13-axis regime vector',
  };
}

async function runRouter(req, res) {
  const configured = hasStore();
  const trusted = isTrusted(req);
  const force = trusted && (req.query.force === '1' || req.query.force === 'true');

  if (!configured) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, configured: false, note: 'no store configured — router is inert', version: ROUTER_VERSION });
  }

  // ── inputs (all cached / cheap, except buildRows behind `force`) ──
  const [summary, redModel, prior, macroNow] = await Promise.all([
    readJSON('scoreboard/summary.json', null).catch(() => null),
    loadRedundancyModel().catch(() => null),
    readJSON(STATE_DOC, null).catch(() => null),
    fetchMacro().catch(() => null),
  ]);

  const classified = classifyStrategies(summary || { groups: [] }, STRATEGY_REGISTRY);
  const signals = classified.strategies.filter((s) => s.kind === 'signal');
  const allIds = signals.map((s) => s.id);

  // Recent per-date series + regime buckets — trusted/force only (refetches candles).
  let seriesByAlgo = {};
  let macroLU = null;
  let seriesBuilt = false;
  if (force) {
    try {
      const { rows } = await buildRows({ limitTickers: 400 });
      for (const r of rows) (seriesByAlgo[r.algorithm] = seriesByAlgo[r.algorithm] || []).push({ date: r.date, excess: r.excess });
      macroLU = await buildMacroLookup('3y').catch(() => null);
      seriesBuilt = true;
    } catch { /* fall back to long-term-only health */ }
  }

  const priorState = { weights: (prior && prior.weights) || {}, cooldowns: (prior && prior.cooldowns) || {} };
  const emergency = new Set(
    (trusted && typeof req.query.emergency === 'string' ? req.query.emergency.split(',') : [])
      .map((s) => s.trim()).filter(Boolean),
  );

  // ── Monitor: classify each signal algorithm's health ──
  const healths = signals.map((s) => {
    const series = seriesByAlgo[s.id] || [];
    return classifyAlgo({
      id: s.id,
      series,
      longTerm: longTermFromStats(s.stats),
      regimeCompatibility: regimeCompatFor(series, macroLU, macroNow && macroNow.regime),
      independence: independenceFor(redModel, s.id, allIds),
      calibration: null, // live-ledger track record carries no per-pick probability yet
    });
  });

  // ── Router: conservative weights ──
  const routed = routeWeights(healths, { familyOf, prior: priorState, emergency });

  // ── unified payload ──
  const byId = new Map(healths.map((h) => [h.id, h]));
  const metaById = new Map(signals.map((s) => [s.id, s]));
  const algorithms = routed.weights.map((w) => {
    const h = byId.get(w.id) || {};
    const meta = metaById.get(w.id) || {};
    return {
      id: w.id,
      label: meta.label || w.id,
      horizon: meta.horizon || null,
      health: h.health,
      currentWeight: w.currentWeight,
      targetWeight: w.targetWeight,
      effectiveSampleSize: h.effectiveSampleSize || 0,
      recentRankIC: null, // rank-IC needs per-pick scores; not yet in the forward ledger
      longTermRankIC: null,
      expectedNetEdge: h.expectedNetEdge ?? null,
      calibrationQuality: h.calibrationQuality ?? null,
      regimeCompatibility: h.regimeCompatibility ?? null,
      independentContribution: h.independentContribution ?? null,
      reason: h.reason || '',
      weightNote: w.note,
      limitations: h.limitations || [],
    };
  });

  const favored = algorithms.filter((a) => a.currentWeight > 0.05).map((a) => a.id);
  const reduced = routed.weights.filter((w) => w.currentWeight < w.priorWeight - 1e-6).map((w) => w.id);
  const disabled = algorithms.filter((a) => a.currentWeight === 0 && (a.health === 'BROKEN' || a.health === 'UNKNOWN')).map((a) => a.id);

  const explanation = routed.abstain
    ? 'No algorithm has a positive conservative edge in current conditions — the system abstains and trades less.'
    : `${favored.length} algorithm(s) favored; focus shifts gradually (≤${(routed.caps.maxStepUp * 100).toFixed(0)}%/run up, ≤${(routed.caps.maxStepDown * 100).toFixed(0)}%/run down).`;

  const payload = {
    ok: true,
    configured: true,
    version: { router: ROUTER_VERSION, health: HEALTH_VERSION, maturity: MATURITY_VERSION },
    generatedAt: new Date().toISOString(),
    shadow: true,
    currentMarket: marketBlock(macroNow, prior && prior.marketRegime),
    algorithms,
    focus: {
      favoredAlgorithms: favored,
      reducedAlgorithms: reduced,
      disabledAlgorithms: disabled,
      abstain: routed.abstain,
      totalWeight: routed.totalWeight,
      unallocated: routed.unallocated,
      explanation,
    },
    router: { caps: routed.caps, cappedFamilies: routed.cappedFamilies },
    // The raw persisted hysteresis state doc (router/latest.json) exactly as last written by
    // a trusted force run: { version, savedAt, marketRegime, weights, cooldowns }. null until
    // the first cron populate. Pure diagnostic — no secrets — so it is safe to echo publicly.
    persistedState: prior,
    healthStates: HEALTH_STATES,
    validity: {
      survivorshipSafe: false,
      pointInTimeSafe: true, // picks are logged live at decision time
      prospective: true,     // this is live-forward tracking, not a historical replay
      seriesBuilt,
      limitations: [
        'Long-term skill is measured on the live forward ledger over a present-day universe (survivorship-unsafe).',
        'Regime state is a coarse VIX+credit proxy, not the full 13-axis regime vector.',
        seriesBuilt ? null : 'Recent-window drift not computed this run (per-date series is trusted/force-only).',
        'No per-pick probabilities yet → calibration and rank-IC are unmeasured.',
      ].filter(Boolean),
    },
  };

  // Advance persisted router state ONLY on a trusted/force run (hysteresis progresses once
  // per cron tick). Best-effort — never blocks the response.
  if (force) {
    const weights = {};
    for (const w of routed.weights) weights[w.id] = w.currentWeight;
    writeJSON(STATE_DOC, {
      version: ROUTER_VERSION,
      savedAt: payload.generatedAt,
      marketRegime: macroNow && macroNow.regime,
      weights,
      cooldowns: routed.cooldowns,
    }).catch(() => {});
  }

  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  return res.json(payload);
}

module.exports = {
  runRouter, longTermFromStats, independenceFor, regimeCompatFor, marketBlock, familyOf, FAMILY, STATE_DOC,
};

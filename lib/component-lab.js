// COUNTERFACTUAL COMPONENT LABORATORY (spec §2)
//
// Does a given algorithm COMPONENT add value BEYOND the rest of the setup — or does it just
// ride a confounder? "Breakouts with abnormal volume did +6%" is not evidence the volume adds
// anything if those names were also in stronger sectors and higher-momentum to begin with. This
// measures each component with a matched treated-vs-control design: for every pick WITH the
// component (treated), find the most similar pick WITHOUT it (control) — same regime, similar
// sector / prior return / liquidity — and compare their forward outcomes. The matched paired
// difference is the incremental effect the component contributed on top of comparable names.
//
// Method: nearest-neighbour matching, stratified by regime, on standardised confounders
// (prior return, log dollar-volume) with a same-sector preference and a caliper. Defensible at
// the few-hundred-pick sample sizes this app has (propensity-score logistic modelling would be
// fragile here). Reports treated/control n, matched pairs, matched & naive means, hit / MFE /
// MAE, incremental return with a 95% CI + t-stat, per-regime stability, an interpretable verdict
// (additive / redundant / harmful / inconclusive / insufficient) and an evidence-backed
// recommendation (retain / reduce / disable / observe) — it never auto-removes anything. Pure.

'use strict';

const COMPONENT_LAB_VERSION = 'complab-v1';

const CONFIG = {
  MIN_GROUP: 15,     // min treated AND control before a component is evaluable
  MIN_PAIRS: 20,     // min matched pairs before a verdict (else insufficient)
  CALIPER: 1.5,      // max standardised confounder distance for a valid match
  SECTOR_PENALTY: 0.75, // distance added when the control is in a different sector
  ECON_MIN: 0.5,     // |incremental return| (pp) below which the effect is economically negligible
  T_SIG: 2.0,        // |t| for statistical significance (~95%)
  EXAMPLES: 3,       // matched-pair examples surfaced per component (provenance → source records)
};

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const median = (a) => {
  const x = a.filter(Number.isFinite).sort((p, q) => p - q);
  if (!x.length) return null;
  const m = Math.floor(x.length / 2);
  return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2;
};
const sd = (a, mu) => {
  if (a.length < 2) return 0;
  const m = mu == null ? mean(a) : mu;
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1));
};

// Standardise a confounder across the pool once, so distances are scale-free.
function standardizer(records, key) {
  const vals = records.map(r => r.features[key]).filter(Number.isFinite);
  const mu = mean(vals) || 0;
  const s = sd(vals, mu) || 1;
  return (v) => (Number.isFinite(v) ? (v - mu) / s : 0);
}

function pairedStats(diffs) {
  const n = diffs.length;
  if (!n) return { n: 0 };
  const m = mean(diffs);
  const s = sd(diffs, m);
  const se = n > 1 ? s / Math.sqrt(n) : 0;
  const t = se > 0 ? m / se : 0;
  return {
    n, mean: +m.toFixed(2), se: +se.toFixed(3), t: +t.toFixed(2),
    ci: [+(m - 1.96 * se).toFixed(2), +(m + 1.96 * se).toFixed(2)],
  };
}

// k-nearest-neighbour match (with replacement) within regime strata. Each treated pick's
// counterfactual is the MEAN outcome of its k closest controls — averaging cancels the
// idiosyncratic noise of any single control, which a 1:1 match would import as bias. Returns
// pairs carrying the counterfactual return + the single nearest control (for provenance).
function matchPairs(treated, control, zPrior, zDV, cfg) {
  const K = cfg.K || 5;
  const byRegime = (rows) => {
    const m = new Map();
    for (const r of rows) { const k = r.features.regime || 'unknown'; (m.get(k) || m.set(k, []).get(k)).push(r); }
    return m;
  };
  const ctrlByReg = byRegime(control);
  const pairs = [];
  for (const t of treated) {
    const pool = ctrlByReg.get(t.features.regime || 'unknown') || [];
    const scored = pool.map(c => ({
      c,
      d: Math.abs(zPrior(t.features.priorReturn) - zPrior(c.features.priorReturn))
        + Math.abs(zDV(t.features.logDollarVol) - zDV(c.features.logDollarVol))
        + (t.features.sector && c.features.sector && t.features.sector !== c.features.sector ? cfg.SECTOR_PENALTY : 0),
    })).filter(x => x.d <= cfg.CALIPER).sort((a, b) => a.d - b.d);
    if (!scored.length) continue;
    const knn = scored.slice(0, K);
    const controlRet = mean(knn.map(x => x.c.ret));
    pairs.push({ treated: t, control: knn[0].c, controlRet, distance: +knn[0].d.toFixed(3), matchedControls: knn.length });
  }
  return pairs;
}

function groupSummary(rows) {
  const rets = rows.map(r => r.ret).filter(Number.isFinite);
  return {
    n: rows.length,
    meanReturn: rets.length ? +mean(rets).toFixed(2) : null,
    medianReturn: rets.length ? +median(rets).toFixed(2) : null,
    winRate: rets.length ? +(rets.filter(r => r > 0).length / rets.length * 100).toFixed(1) : null,
    targetBeforeStopRate: (() => { const tb = rows.map(r => r.targetBeforeStop).filter(v => v === true || v === false); return tb.length ? +(tb.filter(Boolean).length / tb.length * 100).toFixed(1) : null; })(),
    avgMfe: (() => { const v = rows.map(r => r.mfe).filter(Number.isFinite); return v.length ? +mean(v).toFixed(2) : null; })(),
    avgMae: (() => { const v = rows.map(r => r.mae).filter(Number.isFinite); return v.length ? +mean(v).toFixed(2) : null; })(),
  };
}

function verdictFor(matched, cfg) {
  if (matched.n < cfg.MIN_PAIRS) return { verdict: 'insufficient', recommendation: 'observe' };
  const sig = Math.abs(matched.t) >= cfg.T_SIG;
  const econ = Math.abs(matched.mean) >= cfg.ECON_MIN;
  if (!econ) return { verdict: 'redundant', recommendation: 'reduce' };      // real-but-negligible or ~0
  if (matched.mean > 0 && sig) return { verdict: 'additive', recommendation: 'retain' };
  if (matched.mean < 0 && sig) return { verdict: 'harmful', recommendation: 'disable' };
  return { verdict: 'inconclusive', recommendation: 'observe' };             // economically meaningful but not significant
}

// Per-regime stability of the matched incremental effect.
function byRegimeStability(pairs) {
  const m = new Map();
  for (const p of pairs) { const k = p.treated.features.regime || 'unknown'; (m.get(k) || m.set(k, []).get(k)).push(p.treated.ret - p.controlRet); }
  const out = {};
  for (const [k, diffs] of m) out[k] = { n: diffs.length, incremental: diffs.length ? +mean(diffs).toFixed(2) : null };
  return out;
}

// records: [{ ticker, date, section, tier, ret, targetBeforeStop, mfe, mae, features:{...} }].
// components: [{ key, label, blurb, detect(features)->bool }].
function runComponentLab(records, { components, config = {} } = {}) {
  const cfg = { ...CONFIG, ...config };
  const pool = (records || []).filter(r => r && r.features && Number.isFinite(r.ret));
  const zPrior = standardizer(pool, 'priorReturn');
  const zDV = standardizer(pool, 'logDollarVol');

  const results = (components || []).map((comp) => {
    const treated = [], control = [];
    for (const r of pool) { (comp.detect(r.features) ? treated : control).push(r); }
    const base = { key: comp.key, label: comp.label, blurb: comp.blurb, treatedN: treated.length, controlN: control.length };
    if (treated.length < cfg.MIN_GROUP || control.length < cfg.MIN_GROUP) {
      return { ...base, verdict: 'insufficient', recommendation: 'observe',
        note: `Blocked — need ≥${cfg.MIN_GROUP} in both groups (have ${treated.length} with, ${control.length} without).` };
    }
    const pairs = matchPairs(treated, control, zPrior, zDV, cfg);
    const diffs = pairs.map(p => p.treated.ret - p.controlRet);
    const matched = pairedStats(diffs);
    const naive = (mean(treated.map(r => r.ret)) ?? 0) - (mean(control.map(r => r.ret)) ?? 0);
    const { verdict, recommendation } = verdictFor(matched, cfg);
    const examples = pairs.slice(0, cfg.EXAMPLES).map(p => ({
      treated: { ticker: p.treated.ticker, date: p.treated.date, section: p.treated.section, ret: p.treated.ret },
      control: { ticker: p.control.ticker, date: p.control.date, section: p.control.section, ret: p.control.ret },
    }));
    return {
      ...base,
      matchedPairs: matched.n,
      treatedGroup: groupSummary(treated), controlGroup: groupSummary(control),
      incrementalReturn: matched.mean ?? null, ci: matched.ci || null, t: matched.t ?? null,
      significant: Math.abs(matched.t || 0) >= cfg.T_SIG,
      naiveDifference: +naive.toFixed(2),
      confoundingCorrection: matched.n ? +((matched.mean ?? 0) - naive).toFixed(2) : null, // matched − naive
      byRegime: byRegimeStability(pairs),
      verdict, recommendation, examples,
    };
  });
  return {
    version: COMPONENT_LAB_VERSION, config: cfg,
    coverage: { records: pool.length, components: results.length },
    components: results,
  };
}

module.exports = { COMPONENT_LAB_VERSION, CONFIG, runComponentLab, matchPairs, pairedStats, standardizer };

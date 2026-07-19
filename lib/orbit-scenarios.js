// ORBIT market-scenario robustness (orbit-scenario-v1).
//
// A stock is only credibly attractive if its idiosyncratic edge survives the
// market states that could plausibly occur next — not just the one we're in. We
// build a SOFT probability vector over five interpretable scenarios (reusing the
// macro read from lib/macro), estimate P(up) under each, and take the WORST
// (minimum) across the currently-PLAUSIBLE scenarios as `robustUp`. This is what
// stops ORBIT from crowning a name "market-independent" just because today's tape
// is bullish: if risk-off is plausible and the name is weak there, robustUp is low.

const M = require('./orbit-math');

const SCENARIO_VERSION = 'orbit-scenario-v1';
const SCENARIOS = Object.freeze(['riskOn', 'neutral', 'riskOff', 'highVol', 'sectorWeak']);
const DEFAULT_PLAUSIBILITY = 0.15;   // a scenario counts if its soft prob ≥ this (fold-tunable)

// Soft scenario probabilities from a macro state (lib/macro `stateAt`/`at(date)`)
// plus optional context (sectorTrend from the feature snapshot). Never a hard 1.0
// — the vector stays diffuse so several scenarios can remain plausible.
function scenarioVector(macroState, ctx = {}) {
  const macroRisk = macroState && Number.isFinite(macroState.macroRisk) ? macroState.macroRisk : 50;
  const vixPctile = macroState && macroState.vix ? (macroState.vix.pctile ?? 50) : 50;
  const vixRising = !!(macroState && macroState.vix && macroState.vix.rising);
  const sectorTrend = Number.isFinite(ctx.sectorTrend) ? ctx.sectorTrend : 0;   // −1..+1

  // Unnormalised scores → softmax. Scaled so no single state dominates absolutely.
  const scores = {
    riskOn: (50 - macroRisk) / 25 + (vixPctile < 40 ? 0.5 : 0),
    neutral: 0.6 - Math.abs(macroRisk - 45) / 40,
    riskOff: (macroRisk - 50) / 25,
    highVol: (vixPctile - 70) / 20 + (vixRising ? 0.4 : 0),
    sectorWeak: -sectorTrend * 1.2,   // negative sector trend lifts this state
  };
  const keys = SCENARIOS;
  const exps = keys.map(k => Math.exp(M.clamp(scores[k], -6, 6)));
  const sum = exps.reduce((a, b) => a + b, 0);
  const probs = {};
  keys.forEach((k, i) => { probs[k] = +(exps[i] / sum).toFixed(4); });
  // Uncertainty = normalised entropy of the vector (0 = certain, 1 = uniform).
  let ent = 0; for (const k of keys) { const p = probs[k]; if (p > 0) ent -= p * Math.log(p); }
  const uncertainty = +(ent / Math.log(keys.length)).toFixed(4);
  const dominant = keys.reduce((a, b) => probs[b] > probs[a] ? b : a, keys[0]);
  return { version: SCENARIO_VERSION, probs, uncertainty, dominant };
}

// Shift a name's overall P(up) toward each scenario's historical base rate, so a
// name inherits the scenario's tailwind/headwind. baseRates/overall come from the
// training fold (P(up | scenario) and the pooled base rate). Pure.
function perScenarioProb(nameProb, baseRates = {}, overall = null) {
  if (nameProb == null) return null;
  const out = {};
  for (const k of SCENARIOS) {
    const br = Number.isFinite(baseRates[k]) ? baseRates[k] : null;
    const shift = (br != null && overall != null) ? (br - overall) : 0;
    out[k] = +M.clamp(nameProb + shift, 0.01, 0.99).toFixed(4);
  }
  return out;
}

// robustUp = min P(up) across scenarios that are currently plausible. Also returns
// a conservative lower bound (worst minus the dispersion of plausible scenarios).
function robustUp(perScenario, vec, opts = {}) {
  const plaus = opts.plausibility != null ? opts.plausibility : DEFAULT_PLAUSIBILITY;
  if (!perScenario || !vec) return { robustUp: null, lowerBound: null, scenariosUsed: [], worstScenario: null };
  const used = SCENARIOS.filter(k => (vec.probs[k] || 0) >= plaus);
  // Always include the dominant scenario so `used` is never empty.
  if (!used.includes(vec.dominant)) used.push(vec.dominant);
  const vals = used.map(k => perScenario[k]).filter(v => v != null);
  if (!vals.length) return { robustUp: null, lowerBound: null, scenariosUsed: used, worstScenario: null };
  const worst = Math.min(...vals);
  const worstScenario = used.find(k => perScenario[k] === worst) || null;
  const disp = M.std(vals) || 0;
  const lowerBound = +M.clamp(worst - disp, 0, 1).toFixed(4);
  return { robustUp: +worst.toFixed(4), lowerBound, scenariosUsed: used, worstScenario };
}

module.exports = { SCENARIO_VERSION, SCENARIOS, DEFAULT_PLAUSIBILITY, scenarioVector, perScenarioProb, robustUp };

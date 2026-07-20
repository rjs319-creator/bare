'use strict';
// EXPERIMENT #5 — does counterfactual historical-twin estimation (NSL E8) add value ORTHOGONAL
// to price momentum? This is the panel-assembly + labeling harness behind that question. The twin
// engine itself (findTwins) lives in twin.js; the decisive test lives in incremental.js. This
// module turns raw candles into the [{date, baseline, signal, outcome}] samples the test eats —
// point-in-time correctly, so the verdict is honest.
//
// The signal is a k-NN analog predictor: for a name at a decision date, describe its PRE-decision
// state with 4 technical features, find its nearest historical "twins" in a resolved pool, and use
// their MEDIAN forward outcome as the signal. Because `mom` is BOTH a feature and the baseline, the
// baseline-orthogonal IC measures whether the twins' NONLINEAR analog structure (interactions of
// momentum × reversal × vol × trend) beats a LINEAR momentum baseline.
//
// FOUR PIT GUARANTEES, all tested:
//   1. BASELINE + FEATURES use only bars on/before the decision date.
//   2. POOL RESOLUTION: an analog state may enter the pool for date D only if its forward label
//      ENDED on/before D (labelEndDate ≤ D). A state whose outcome resolves after D is invisible —
//      this is the guarantee a naive `date < asOf` twin pool would violate (it would peek at
//      outcomes not yet knowable).
//   3. SELF-EXCLUSION: a name never twins with its OWN history. The pool is purely cross-sectional
//      analogs, so a name cannot predict itself through autocorrelation. Conservative by design.
//   4. OUTCOME is a real forward fill (next open, held `horizon`), dropped when unelapsed.
//
// The momentum baseline and forward-label primitives are reused from the insider harness so all
// experiments stay comparable. Pure & deterministic: candles in, samples out. No network, no clock.

const { findTwins } = require('./twin');
const { evaluateIncremental } = require('./incremental');
const { DEFAULTS: BASE_DEFAULTS, momentumScore, forwardReturn } = require('./insider-incremental');
const { sd } = require('./stats');

const DEFAULTS = Object.freeze({ ...BASE_DEFAULTS, stride: 5, minHistory: 200 });
const FEATURE_KEYS = Object.freeze(['mom', 'rev1m', 'vol', 'dist200']);

const idxOnOrBefore = (candles, date) => {
  let idx = -1;
  for (let k = 0; k < candles.length; k++) { if (candles[k].date <= date) idx = k; else break; }
  return idx;
};

// PIT pre-decision feature vector from bars ≤ asOf. Returns null unless every feature (which needs
// up to 200 trailing sessions for the SMA) is finite — never a partial/looking-ahead vector.
function featuresAt(candles, asOf, cfg = DEFAULTS) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const i = idxOnOrBefore(candles, asOf);
  if (i < 0 || i - (cfg.minHistory || 200) < 0) return null;
  const mom = momentumScore(candles, asOf, cfg);            // 6–1 total return (baseline)
  if (mom == null) return null;
  const c0 = candles[i - 21] && candles[i - 21].close;
  const rev1m = c0 > 0 ? candles[i].close / c0 - 1 : null;  // last ~1-month return (reversal axis)
  const rets = [];
  for (let k = i - 62; k <= i; k++) { const p0 = candles[k - 1] && candles[k - 1].close, p1 = candles[k].close; if (p0 > 0) rets.push(p1 / p0 - 1); }
  const vol = rets.length > 1 ? sd(rets) : null;            // 63d realized vol
  let sum = 0; for (let k = i - 199; k <= i; k++) sum += candles[k].close;
  const sma200 = sum / 200;
  const dist200 = sma200 > 0 ? candles[i].close / sma200 - 1 : null;  // trend: % above/below 200d SMA
  const f = { mom, rev1m, vol, dist200 };
  return FEATURE_KEYS.every(k => Number.isFinite(f[k])) ? f : null;
}

// Build the analog state library: for each name, sample states on a stride grid where a full PIT
// feature vector AND a resolved forward outcome both exist. Each state carries its labelEndDate so
// the pool can be filtered to outcomes known as-of any later decision date.
function buildStateLibrary(tickerData, cfg = DEFAULTS) {
  const c = { ...DEFAULTS, ...cfg };
  const lib = [];
  for (const td of tickerData || []) {
    if (!td || !td.ticker || !Array.isArray(td.candles)) continue;
    for (let i = c.minHistory; i < td.candles.length; i += c.stride) {
      const date = td.candles[i].date;
      const features = featuresAt(td.candles, date, c);
      if (!features) continue;
      const fwd = forwardReturn(td.candles, date, c);
      if (!fwd) continue;
      lib.push({ ticker: td.ticker, date, features, outcome: fwd.outcome, labelEndDate: fwd.labelEndDate });
    }
  }
  return lib;
}

// Twin signal: median forward outcome of the candidate's nearest historical twins. `pool` must
// already be filtered to resolved, non-self analogs. Returns null when support is insufficient.
function twinSignal(candidateFeatures, pool, asOf, cfg = DEFAULTS) {
  if (!candidateFeatures) return null;
  const t = findTwins({ features: candidateFeatures }, pool, FEATURE_KEYS, asOf, cfg.twinConfig);
  if (!t || t.insufficient || !Number.isFinite(t.median)) return null;
  return t.median;
}

// Assemble the cross-sectional panel. `tickerData` = [{ ticker, candles }]; `library` from
// buildStateLibrary. For each date the pool is the resolved (labelEndDate ≤ date) library minus the
// candidate's own ticker.
function assembleSamples(tickerData, library, decisionDates, cfg = DEFAULTS) {
  const c = { ...DEFAULTS, ...cfg };
  const samples = [];
  const diagnostics = { dates: decisionDates.length, tickers: tickerData.length, dropped: { noMomentum: 0, noSignal: 0, noOutcome: 0 }, nonzeroSignal: 0, poolSizes: [] };

  for (const date of decisionDates) {
    const resolvedPool = (library || []).filter(s => s.labelEndDate && s.labelEndDate <= date);
    diagnostics.poolSizes.push(resolvedPool.length);
    for (const td of tickerData) {
      if (!td || !td.ticker) continue;
      const feats = featuresAt(td.candles, date, c);
      const baseline = feats ? feats.mom : null;
      if (baseline == null) { diagnostics.dropped.noMomentum++; continue; }
      const pool = resolvedPool.filter(s => s.ticker !== td.ticker);  // self-exclusion
      const signal = twinSignal(feats, pool, date, c);
      if (signal == null) { diagnostics.dropped.noSignal++; continue; }
      const fwd = forwardReturn(td.candles, date, c);
      if (fwd == null) { diagnostics.dropped.noOutcome++; continue; }
      if (signal !== 0) diagnostics.nonzeroSignal++;
      samples.push({ date, ticker: td.ticker, baseline, signal, outcome: fwd.outcome });
    }
  }
  return { samples, diagnostics };
}

// End-to-end convenience: build library + assemble + evaluate.
function runTwinIncremental(tickerData, decisionDates, cfg = DEFAULTS, evalOpts = {}) {
  const library = buildStateLibrary(tickerData, cfg);
  const { samples, diagnostics } = assembleSamples(tickerData, library, decisionDates, cfg);
  const evaluation = evaluateIncremental(samples, evalOpts);
  return { nSamples: samples.length, librarySize: library.length, diagnostics, evaluation };
}

module.exports = { DEFAULTS, FEATURE_KEYS, featuresAt, buildStateLibrary, twinSignal, assembleSamples, runTwinIncremental };

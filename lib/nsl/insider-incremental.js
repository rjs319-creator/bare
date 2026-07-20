'use strict';
// EXPERIMENT #3 — does opportunistic-insider conviction (NSL E2) add value ORTHOGONAL to
// price momentum? This is the panel-assembly + labeling harness behind that question. The
// decisive test itself lives in incremental.js (evaluateIncremental); this module's only job
// is to turn raw per-ticker inputs into the [{date, baseline, signal, outcome}] samples it
// eats — point-in-time correctly, so the verdict is honest.
//
// THREE PIT GUARANTEES, all tested:
//   1. BASELINE uses only bars on/before the decision date (trailing 12–1 momentum).
//   2. SIGNAL uses only Form 4s FILED on/before the decision date — delegated to
//      classifyInsider, whose filingDate mask is the whole reason this signal is PIT-safe.
//   3. OUTCOME is a real forward fill: enter at the NEXT session's open, exit `horizon`
//      sessions later. A decision date whose label has not fully elapsed in the data is
//      DROPPED, never truncated — the same rule the grader enforces.
//
// Decision dates are spaced so their forward labels do not overlap, keeping each date an
// independent cross-sectional observation (what evaluateIncremental's date-clustered t-stat
// assumes). Pure & deterministic: candles + txs in, samples out. No network, no clock.

const { classifyInsider } = require('./insider-conviction');
const { evaluateIncremental } = require('./incremental');

const DEFAULTS = Object.freeze({
  lookbackBars: 126,   // ~6 months trailing for the momentum baseline
  skipBars: 5,         // skip the last week (12–1 style — avoid short-term reversal)
  horizonBars: 21,     // ~1 month forward label
});

const idxOnOrBefore = (candles, date) => {
  let idx = -1;
  for (let k = 0; k < candles.length; k++) { if (candles[k].date <= date) idx = k; else break; }
  return idx;
};
const num = x => (Number.isFinite(x) ? x : null);

// Trailing total return from (asOf − lookback) to (asOf − skip), using only bars ≤ asOf.
// Returns null when there is not enough history — never a partial/looking-ahead value.
function momentumScore(candles, asOf, cfg = DEFAULTS) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const i = idxOnOrBefore(candles, asOf);
  const endIdx = i - (cfg.skipBars || 0);
  const startIdx = i - (cfg.lookbackBars || 0);
  if (startIdx < 0 || endIdx <= startIdx) return null;
  const from = num(candles[startIdx].close), to = num(candles[endIdx].close);
  if (!(from > 0) || to == null) return null;
  return (to - from) / from;
}

// Forward return of a real next-open fill held `horizon` sessions. Returns { outcome, labelEndDate }
// or null when the full horizon has not elapsed in the available data (purge, not truncation).
function forwardReturn(candles, asOf, cfg = DEFAULTS) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const i = idxOnOrBefore(candles, asOf);
  const entryIdx = i + 1;                       // next session — never the decision close
  const exitIdx = entryIdx + (cfg.horizonBars || DEFAULTS.horizonBars);
  if (i < 0 || exitIdx >= candles.length) return null;   // label not fully elapsed → drop
  const entry = num(candles[entryIdx].open) ?? num(candles[entryIdx].close);
  const exit = num(candles[exitIdx].close);
  if (!(entry > 0) || exit == null) return null;
  return { outcome: (exit - entry) / entry, labelEndDate: candles[exitIdx].date };
}

// Insider conviction as-of, from a ticker's FULL transaction list. Delegates the filingDate
// masking to classifyInsider. Returns 0 for a filer with no window activity (a real reading:
// "no conviction"), and null when the name is not an SEC filer at all (excluded from the panel).
function insiderSignal(txs, asOf) {
  if (!Array.isArray(txs)) return null;
  const c = classifyInsider(txs, asOf);
  if (!c || !c.hasData) return null;
  return c.empty ? 0 : num(c.conviction);
}

// Assemble the cross-sectional panel. `tickerData` = [{ ticker, candles, txs }].
// Each (date, ticker) contributes a sample only when baseline, signal AND outcome all exist
// point-in-time. Returns { samples, diagnostics }.
function assembleSamples(tickerData, decisionDates, cfg = DEFAULTS) {
  const c = { ...DEFAULTS, ...cfg };
  const samples = [];
  const diagnostics = { dates: decisionDates.length, tickers: tickerData.length, dropped: { noMomentum: 0, noSignal: 0, noOutcome: 0 }, nonzeroSignal: 0 };

  for (const date of decisionDates) {
    for (const td of tickerData) {
      if (!td || !td.ticker) continue;
      const baseline = momentumScore(td.candles, date, c);
      if (baseline == null) { diagnostics.dropped.noMomentum++; continue; }
      const signal = insiderSignal(td.txs, date);
      if (signal == null) { diagnostics.dropped.noSignal++; continue; }
      const fwd = forwardReturn(td.candles, date, c);
      if (fwd == null) { diagnostics.dropped.noOutcome++; continue; }
      if (signal !== 0) diagnostics.nonzeroSignal++;
      samples.push({ date, ticker: td.ticker, baseline, signal, outcome: fwd.outcome });
    }
  }
  return { samples, diagnostics };
}

// End-to-end convenience: assemble + evaluate. `evalOpts` flows to evaluateIncremental
// (minPerDate/minDates/variantsTested).
function runInsiderIncremental(tickerData, decisionDates, cfg = DEFAULTS, evalOpts = {}) {
  const { samples, diagnostics } = assembleSamples(tickerData, decisionDates, cfg);
  const evaluation = evaluateIncremental(samples, evalOpts);
  return { nSamples: samples.length, diagnostics, evaluation };
}

module.exports = {
  DEFAULTS, momentumScore, forwardReturn, insiderSignal, assembleSamples, runInsiderIncremental,
};

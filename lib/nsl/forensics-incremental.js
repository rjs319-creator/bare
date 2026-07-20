'use strict';
// EXPERIMENT #4 — does structured accounting-transition forensics (NSL E6) add value ORTHOGONAL
// to price momentum? This is the panel-assembly + labeling harness behind that question. The
// decisive test itself lives in incremental.js (evaluateIncremental); this module's only job is
// to turn raw per-ticker inputs into the [{date, baseline, signal, outcome}] samples it eats —
// point-in-time correctly, so the verdict is honest.
//
// THREE PIT GUARANTEES, all tested (same shape as experiment #3):
//   1. BASELINE uses only bars on/before the decision date (trailing 6–1 momentum).
//   2. SIGNAL uses only XBRL facts FILED on/before the decision date — delegated to
//      extractSeries, whose `filed`-date mask is the whole reason this signal is PIT-safe.
//      Restatements arrive as NEW facts with LATER `filed` dates, so the as-of view is always
//      the ORIGINAL reported vintage the market saw; a restatement can never overwrite history.
//   3. OUTCOME is a real forward fill: enter at the NEXT session's open, exit `horizon` sessions
//      later. A decision date whose label has not fully elapsed is DROPPED, never truncated.
//
// The momentum baseline and forward-label primitives are IDENTICAL to the insider experiment, so
// they are reused from there rather than re-implemented — keeping the two harnesses comparable and
// avoiding drift. Pure & deterministic: candles + a raw companyfacts payload in, samples out.
// No network, no clock.

const { assessAccountingFacts, extractSeries } = require('./accounting-forensics');
const { evaluateIncremental } = require('./incremental');
const { DEFAULTS, momentumScore, forwardReturn } = require('./insider-incremental');

// Accounting-forensics composite as-of, from a ticker's FULL companyfacts payload. Delegates the
// filed-date PIT masking to extractSeries. Returns the composite (positive = healthier / improving
// accounting relationships, negative = deteriorating — receivables outrunning revenue, accruals
// rising, cash conversion decaying, dilution) or null when the name has too few structured facts
// to form a transition as-of that date (excluded from the panel — never a fabricated 0).
function forensicsSignal(facts, asOf) {
  if (!facts) return null;
  const series = extractSeries(facts, asOf);
  const a = assessAccountingFacts(series, asOf);
  if (!a || a.insufficient || !Number.isFinite(a.composite)) return null;
  return a.composite;
}

// Assemble the cross-sectional panel. `tickerData` = [{ ticker, candles, facts }].
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
      const signal = forensicsSignal(td.facts, date);
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
function runForensicsIncremental(tickerData, decisionDates, cfg = DEFAULTS, evalOpts = {}) {
  const { samples, diagnostics } = assembleSamples(tickerData, decisionDates, cfg);
  const evaluation = evaluateIncremental(samples, evalOpts);
  return { nSamples: samples.length, diagnostics, evaluation };
}

module.exports = { DEFAULTS, forensicsSignal, assembleSamples, runForensicsIncremental };

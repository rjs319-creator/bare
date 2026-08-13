'use strict';
// CFL — ALPHA PROSECUTOR: adversarial validation of any claimed improvement.
//
// A thin COMPOSITION over the repo's existing controls — never a parallel stats
// toolkit: lib/orbit-controls (label shuffle, future-feature leak, random ranker,
// doubled costs, drop-best-year) + deterministic best-trade excision + a
// concentration read. A claim that fails any applicable challenge stays
// RESEARCH/REJECTED; this module can only downgrade, never promote.
//
// samples: [{date, features:{...}, label, cost?}] — the orbit-controls shape.
// trades:  [{net}] — per-trade nets for excision/concentration checks.

const CONTROLS = require('../orbit-controls');
const NCAL = require('./null-calibration');
const CFG = require('./config');

const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

// Remove the best N trades — an edge that dies without its top handful is
// concentration, not alpha.
//
// MAXIMUM SLICE. removeCounts are ABSOLUTE and were written for trade counts in
// the hundreds, where removing 5 is ~2% of the sample. Applied to a date-level
// series of 18 they strip 28% and 56% and then require the remaining bottom 44%
// to average positive — which almost nothing passes. Simulated against a real
// production series' own mean and dispersion, a GENUINELY POSITIVE strategy
// survived 0.51% of the time at n=18 and 0.01% at n=30 (where k=20 removes 67%,
// so the absolute thresholds are not even monotonic in sample size). The check
// was measuring sample size and reporting it as concentration.
//
// A removal larger than this fraction cannot separate concentration from
// ordinary dispersion, so it declines to run rather than convict — the same
// stance MIN_CONCENTRATION_N takes, expressed as a share instead of a count.
// k=5 needs n>=25, k=10 needs n>=50, k=20 needs n>=100: the scale intended.
const MAX_EXCISION_FRACTION = 0.20;

function excisionCheck(trades = [], removeCounts = [5, 10, 20]) {
  const nets = trades.map(t => t && Number.isFinite(t.net) ? t.net : null).filter(x => x != null);
  if (nets.length < 10) return { ok: false, reason: 'insufficient-trades', n: nets.length };
  const applicable = removeCounts.filter(k => k < nets.length && (k / nets.length) <= MAX_EXCISION_FRACTION);
  if (!applicable.length) {
    return { ok: false, reason: 'sample-too-small-for-excision', n: nets.length,
      minN: Math.ceil(Math.min(...removeCounts) / MAX_EXCISION_FRACTION),
      note: `every removal would take more than ${Math.round(MAX_EXCISION_FRACTION * 100)}% of the sample — dispersion, not concentration, would decide the result` };
  }
  const sorted = [...nets].sort((a, b) => b - a);
  const base = mean(sorted);
  const rows = applicable.map(k => {
    const rest = sorted.slice(k);
    const m = mean(rest);
    return { removed: k, meanNet: +m.toFixed(5), stillPositive: m > 0 };
  });
  return { ok: true, n: nets.length, baseMeanNet: +base.toFixed(5), rows, survives: rows.every(r => r.stillPositive) };
}

// Share of total positive P&L carried by the single best trade / best 5.
//
// MINIMUM SAMPLE, same floor excisionCheck already applies. On a handful of
// observations "one carries >=50% of positive P&L" is true by ARITHMETIC rather
// than by concentration — with two positive trades it is unavoidable. Firing
// here on n=2 produced a `blocked` verdict that read as an adversarial rejection
// when it only meant "too few observations to say". Below the floor the check
// declines to run (ok:false ⇒ prosecuteClaim records it as UNRUN, never a fail).
const MIN_CONCENTRATION_N = 10;

function concentrationCheck(trades = []) {
  const nets = trades.map(t => t && Number.isFinite(t.net) ? t.net : null).filter(x => x != null);
  if (nets.length < MIN_CONCENTRATION_N) return { ok: false, reason: 'insufficient-trades', n: nets.length };
  const pos = nets.filter(x => x > 0);
  if (!pos.length) return { ok: false, reason: 'no-positive-trades' };
  const total = pos.reduce((a, b) => a + b, 0);
  const sorted = [...pos].sort((a, b) => b - a);
  return {
    ok: true,
    top1Share: +(sorted[0] / total).toFixed(3),
    top5Share: +(sorted.slice(0, 5).reduce((a, b) => a + b, 0) / total).toFixed(3),
  };
}

// Run every applicable challenge. Verdict semantics:
//   REJECTED  — a leak/placebo test failed (the claim is invalid, not just weak)
//   RESEARCH  — insufficient data or a robustness check failed (stay shadow)
//   SURVIVES  — no applicable challenge invalidated the claim (NOT a promotion —
//               promotion still requires the full governance gate ladder)
function prosecuteClaim({ samples = [], trades = [], opts = {} } = {}) {
  const checks = [];
  let controls = null;
  if (samples.length >= 30) {
    controls = CONTROLS.runControls(samples, opts);
    checks.push({ check: 'orbit-controls-battery', ok: !controls.leakSuspected, detail: controls });
  } else {
    checks.push({ check: 'orbit-controls-battery', ok: null, detail: { reason: 'insufficient-samples', n: samples.length } });
  }
  const excision = excisionCheck(trades);
  checks.push({ check: 'best-trade-excision', ok: excision.ok ? excision.survives : null, detail: excision });
  const conc = concentrationCheck(trades);
  checks.push({ check: 'concentration', ok: conc.ok ? conc.top1Share < 0.5 : null, detail: conc });
  // The DECIDING concentration statistic. The two above use absolute thresholds
  // and were shown twice to convict on dispersion rather than concentration
  // (see lib/cfl/null-calibration.js); they remain as descriptives. This one
  // compares the series against a matched symmetric null, so it answers the
  // question without also answering "how many observations are there?".
  const nets = trades.map(t => (t && Number.isFinite(t.net)) ? t.net : null).filter(x => x != null);
  const cal = NCAL.calibrateConcentration(nets);
  checks.push({ check: 'null-calibrated-concentration', ok: cal.ran ? !cal.concentrated : null, detail: cal });

  const leak = controls && controls.leakSuspected;
  const anyFail = checks.some(c => c.ok === false);
  const anyUnrun = checks.some(c => c.ok == null);
  const verdict = leak ? 'REJECTED' : (anyFail || anyUnrun) ? 'RESEARCH' : 'SURVIVES';
  return {
    version: CFG.CFL_VERSION, prosecutorOf: 'cfl-claims',
    verdict, canPromote: false,   // structurally: the prosecutor never promotes
    checks,
    note: 'SURVIVES means no applicable challenge invalidated the claim; promotion still requires the full governance ladder (lib/maturity, lib/governance) on prospective data.',
  };
}

module.exports = { prosecuteClaim, excisionCheck, concentrationCheck, MIN_CONCENTRATION_N, MAX_EXCISION_FRACTION };

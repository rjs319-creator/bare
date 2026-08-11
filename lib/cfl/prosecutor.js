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
const CFG = require('./config');

const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

// Remove the best N trades — an edge that dies without its top handful is
// concentration, not alpha.
function excisionCheck(trades = [], removeCounts = [5, 10, 20]) {
  const nets = trades.map(t => t && Number.isFinite(t.net) ? t.net : null).filter(x => x != null);
  if (nets.length < 10) return { ok: false, reason: 'insufficient-trades', n: nets.length };
  const sorted = [...nets].sort((a, b) => b - a);
  const base = mean(sorted);
  const rows = removeCounts.filter(k => k < nets.length).map(k => {
    const rest = sorted.slice(k);
    const m = mean(rest);
    return { removed: k, meanNet: +m.toFixed(5), stillPositive: m > 0 };
  });
  return { ok: true, n: nets.length, baseMeanNet: +base.toFixed(5), rows, survives: rows.every(r => r.stillPositive) };
}

// Share of total positive P&L carried by the single best trade / best 5.
function concentrationCheck(trades = []) {
  const nets = trades.map(t => t && Number.isFinite(t.net) ? t.net : null).filter(x => x != null);
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

module.exports = { prosecuteClaim, excisionCheck, concentrationCheck };

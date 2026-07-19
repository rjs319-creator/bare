// ORBIT-ML monitor (orbit-ml-monitor-v1) — thin composition over the proven
// lib/orbit-monitor (multi-window OOS health + A–F grade) PLUS the ORBIT-ML-specific
// pieces: correlation with the existing algorithms (via the ensemble module) and the
// EVOLVE-specialist shadow status. Nothing here is new health math — it reuses the
// same conservative rules (never react to a small streak, never grade A from backfill).

const OrbitMon = require('./orbit-monitor');
const Ensemble = require('./orbit-ml-ensemble');
const Adapter = require('./orbit-ml-evolve');

const ML_MONITOR_VERSION = 'orbit-ml-monitor-v1';
const HORIZONS = ['days5', 'days21', 'days63'];

// resolved: map keyed `ticker:decisionTs` → { ticker, decisionTs, horizons } (from op=orbitmlresolve)
// peerRows: [{date, ticker, algorithm, excess}] for existing algorithms (optional)
// jointPredictions: [{date, ticker, outcome, scores}] for leave-one-out (optional)
// evalDoc: cached walk-forward result (optional)
function monitorOrbitMl(resolved, opts = {}) {
  const rows = flattenResolved(resolved);
  const health = OrbitMon.monitorAll(rows, { now: opts.now || null });

  const grades = {};
  for (const h of HORIZONS) {
    const wf = opts.evalDoc && opts.evalDoc.walkforward && opts.evalDoc.walkforward[h] ? normalizeWF(opts.evalDoc.walkforward[h]) : null;
    grades[h] = OrbitMon.gradeHorizon(wf, health.byHorizon[h], { survivorshipSafe: false });
  }

  // Incremental value vs the existing algorithms.
  let redundancy = null, leaveOneOut = null;
  if (opts.peerRows && opts.peerRows.length) {
    const ownRows = Adapter.specialistRows(resolved, { horizon: opts.horizon || 'days21' });
    if (ownRows.length) redundancy = Ensemble.redundancyContribution([...ownRows, ...opts.peerRows]);
  }
  if (opts.jointPredictions && opts.jointPredictions.length) leaveOneOut = Ensemble.leaveOneOutIC(opts.jointPredictions);

  return {
    version: ML_MONITOR_VERSION,
    shadow: Adapter.shadowStatus(),
    health, grades,
    incremental: { redundancy, leaveOneOut },
    generatedAt: opts.now || null,
  };
}

// The rank walk-forward stores IC under purged.overall.ic; map to the grade schema.
function normalizeWF(wf) {
  if (!wf || !wf.ok || !wf.purged || !wf.purged.overall) return null;
  const o = wf.purged.overall;
  return { ok: true, horizon: wf.horizon, purged: { overall: { ic: o.ic, icir: o.icir, brier: null, topDecileNet: null, nDates: o.nDates } } };
}

function flattenResolved(map) {
  const rows = [];
  for (const key in (map || {})) {
    const r = map[key]; if (!r || !r.horizons) continue;
    for (const h of HORIZONS) {
      const hz = r.horizons[h]; if (!hz || !hz.resolved) continue;
      rows.push({ date: r.decisionTs, ticker: r.ticker, horizon: h, score: r.rankScore != null ? r.rankScore : null, calUp: hz.calUp != null ? hz.calUp : null, label: hz.positiveResidual != null ? hz.positiveResidual : (hz.netReturn > 0 ? 1 : 0), net: hz.netReturn, severe: hz.severeLoss });
    }
  }
  return rows;
}

module.exports = { ML_MONITOR_VERSION, monitorOrbitMl, flattenResolved };

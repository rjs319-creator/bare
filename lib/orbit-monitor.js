// ORBIT self-improving monitor + grade (orbit-monitor-v1).
//
// Consumes the RESOLVED prediction ledger (eligible candidates AND rejected
// candidates AND matched controls are all persisted upstream) and computes
// out-of-sample health across several look-back windows, then a conservative
// A–F grade. Two hard rules baked in:
//   1. Never react to a small losing streak — every status needs a minimum number
//      of INDEPENDENT decision dates (effective sample size = distinct dates).
//   2. Grade A is never awarded from historical backfill alone — it requires
//      prospective (live-forward) shadow validation too.
//
// Health states per horizon: HEALTHY / WATCH / DEGRADING / BROKEN / INSUFFICIENT_DATA.

const { groupedIC } = require('./orbit-walkforward');
const { wilson } = require('./stats');
const M = require('./orbit-math');

const MONITOR_VERSION = 'orbit-monitor-v1';
const WINDOWS = Object.freeze([20, 60, 126]);     // distinct-date look-backs
const MIN_DATES = 10;                              // below this → INSUFFICIENT_DATA

// resolved: [{ date, ticker, horizon, score, calUp|null, label, net, severe, cost?, featureMean? }]
// Filter to one horizon, sorted by date.
function forHorizon(resolved, horizon) {
  return (resolved || []).filter(r => r.horizon === horizon && r.date && r.label != null)
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
}

// Restrict rows to the most recent `k` distinct decision dates.
function lastKDates(rows, k) {
  const dates = [...new Set(rows.map(r => r.date))].sort();
  const keep = new Set(dates.slice(Math.max(0, dates.length - k)));
  return rows.filter(r => keep.has(r.date));
}

function windowMetrics(rows) {
  const effN = new Set(rows.map(r => r.date)).size;
  const g = groupedIC(rows.map(r => ({ date: r.date, score: r.score, net: r.net })));
  const nets = rows.map(r => r.net).filter(v => v != null && Number.isFinite(v));
  const netExpectancy = nets.length ? +M.mean(nets).toFixed(4) : null;
  const wins = rows.filter(r => r.label === 1).length;
  const winRate = rows.length ? +(wins / rows.length).toFixed(3) : null;
  const wl = wilson(wins, rows.length);
  const withCal = rows.filter(r => r.calUp != null);
  const brier = withCal.length >= 20 ? +M.brier(withCal.map(r => r.calUp), withCal.map(r => r.label)).toFixed(4) : null;
  const logLoss = withCal.length >= 20 ? +M.logLoss(withCal.map(r => r.calUp), withCal.map(r => r.label)).toFixed(4) : null;
  const severe = rows.map(r => r.severe).filter(v => v === 0 || v === 1);
  const severeRate = severe.length ? +M.mean(severe).toFixed(3) : null;
  return { n: rows.length, effN, ic: g.ic, icir: g.icir, positiveIcFrac: g.posFrac, netExpectancy, winRate, winRateLB: wl.lo, brier, logLoss, severeRate };
}

// Conservative status from a window's metrics.
function classify(m) {
  if (m == null || m.effN < MIN_DATES || m.ic == null) return 'INSUFFICIENT_DATA';
  const ic = m.ic, exp = m.netExpectancy;
  // BROKEN: clearly negative edge with a real sample.
  if (m.effN >= MIN_DATES && ((ic <= -0.03 && m.positiveIcFrac != null && m.positiveIcFrac < 0.4) || (exp != null && exp < -0.02))) return 'BROKEN';
  // HEALTHY: positive IC, positive expectancy, majority of dates positive.
  if (ic > 0.02 && (exp == null || exp > 0) && (m.positiveIcFrac == null || m.positiveIcFrac >= 0.5)) return 'HEALTHY';
  // DEGRADING: mildly negative edge, not yet broken.
  if (ic < 0 || (exp != null && exp < 0)) return 'DEGRADING';
  return 'WATCH';
}

// Feature / prediction / cost drift: compare the recent half to the older half.
function driftMetrics(rows) {
  if (rows.length < 20) return { predictionDrift: null, costDrift: null, featureDrift: null };
  const mid = Math.floor(rows.length / 2);
  const older = rows.slice(0, mid), recent = rows.slice(mid);
  const meanOf = (arr, key) => M.mean(arr.map(r => r[key]).filter(v => v != null && Number.isFinite(v)));
  const drift = (key) => { const a = meanOf(older, key), b = meanOf(recent, key); return (a == null || b == null) ? null : +(b - a).toFixed(4); };
  return { predictionDrift: drift('score'), costDrift: drift('cost'), featureDrift: drift('featureMean') };
}

// Monitor one horizon across all windows.
function monitorHorizon(resolved, horizon) {
  const rows = forHorizon(resolved, horizon);
  const windows = {};
  for (const k of WINDOWS) { const w = lastKDates(rows, k); windows[`d${k}`] = { ...windowMetrics(w), status: classify(windowMetrics(w)) }; }
  const expanding = windowMetrics(rows);
  const status = classify(expanding);
  return { horizon, status, expanding, windows, drift: driftMetrics(rows), nResolved: rows.length };
}

function monitorAll(resolved, opts = {}) {
  const horizons = opts.horizons || ['days5', 'days21', 'days63'];
  const byHorizon = {};
  for (const h of horizons) byHorizon[h] = monitorHorizon(resolved, h);
  return { version: MONITOR_VERSION, byHorizon, generatedAt: opts.now || null };
}

// ── Grade (A–F) ──────────────────────────────────────────────────────────────
// walkforward: an orbit-walkforward result (purged.overall). prospective: an
// orbit-monitor horizon result from the LIVE ledger. survivorshipSafe gates A.
const GRADE_REASONS = Object.freeze({
  A: 'Nested outer-OOS + prospective shadow validation, calibrated, positive incremental value.',
  B: 'Promising nested outer-OOS, but prospective/regime coverage incomplete.',
  C: 'Inconclusive or insufficient support.',
  D: 'Statistically meaningful degradation.',
  F: 'Persistent negative value, calibration failure, leakage, or broken data.',
});

function gradeHorizon(walkforward, prospective, opts = {}) {
  const survivorshipSafe = !!opts.survivorshipSafe;
  const wf = walkforward && walkforward.ok ? walkforward.purged && walkforward.purged.overall : null;
  const prosp = prospective || null;
  const effDates = prosp ? prosp.expanding.effN : 0;
  const limitations = [];
  if (!survivorshipSafe) limitations.push('Universe survivorship-biased → production-grade blocked.');
  if (!prosp || effDates < MIN_DATES) limitations.push('No/low prospective live-forward evidence yet.');

  let grade = 'C', reason = GRADE_REASONS.C;
  // F — broken data or clearly negative OOS.
  if (prosp && prosp.status === 'BROKEN') { grade = 'F'; reason = GRADE_REASONS.F; }
  else if (wf && wf.ic != null && wf.ic <= -0.03) { grade = 'F'; reason = 'Nested outer-OOS IC is negative — no evidence of edge.'; }
  // D — meaningful degradation live.
  else if (prosp && prosp.status === 'DEGRADING' && effDates >= MIN_DATES) { grade = 'D'; reason = GRADE_REASONS.D; }
  // A — requires BOTH purged OOS and prospective validation and survivorship safety.
  else if (wf && wf.ic > 0.02 && prosp && prosp.status === 'HEALTHY' && effDates >= 20 && survivorshipSafe) { grade = 'A'; reason = GRADE_REASONS.A; }
  // B — promising purged OOS, prospective incomplete.
  else if (wf && wf.ic > 0.02 && (wf.nDates || 0) >= 8) { grade = 'B'; reason = GRADE_REASONS.B; }
  // C — everything else (insufficient).
  else { grade = 'C'; reason = GRADE_REASONS.C; }

  return {
    grade, reason,
    effectiveSampleSize: effDates,
    independentDecisionDates: effDates,
    oos: wf ? { ic: wf.ic, icir: wf.icir, brier: wf.brier, topDecileNet: wf.topDecileNet, nDates: wf.nDates } : null,
    prospective: prosp ? { status: prosp.status, ic: prosp.expanding.ic, netExpectancy: prosp.expanding.netExpectancy, winRateLB: prosp.expanding.winRateLB } : null,
    calibrated: !!(wf && wf.brier != null),
    survivorshipSafe, productionGrade: false,
    limitations,
  };
}

// Map ORBIT's native A–F to the app's maturity vocabulary for the registry panel.
const MATURITY_MAP = Object.freeze({ A: 'validated', B: 'promising', C: 'experimental', D: 'experimental', F: 'disabled' });

module.exports = {
  MONITOR_VERSION, WINDOWS, MIN_DATES, GRADE_REASONS, MATURITY_MAP,
  forHorizon, lastKDates, windowMetrics, classify, driftMetrics,
  monitorHorizon, monitorAll, gradeHorizon,
};

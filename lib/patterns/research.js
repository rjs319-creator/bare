'use strict';
// PATTERN RESEARCH — the offline, point-in-time path to honest probabilities.
//
// This is the ONLY module allowed to mark a family "proven", and it fails closed at every
// step. The pipeline:
//   1. buildResearchRecords  — replay family detectors over historical bars, one anchored
//      as-of at a time. A record freezes only information available at detection time and
//      resolves its outcome with the fill-aware grader on STRICTLY-forward bars.
//   2. matched controls     — non-pattern windows given the same mechanical plan
//      construction, so the pattern's rate is compared against "the same trade without
//      the pattern", not against zero.
//   3. splitChronology      — purged, embargoed, anchored splits: train (reserved for any
//      learned challenger), calibration (probability estimates), final untouched eval.
//   4. evaluateCells        — per family × direction × timeframe metrics on the FINAL
//      period only, with Benjamini–Hochberg false-discovery control across cells.
//   5. provenGate           — every promotion condition; `analog.sufficient` has no vote.
//   6. buildEvidenceTable   — the versioned artifact confirm.recommendationEligibility
//      reads. No artifact → nothing is ever eligible.

const { detectWindow } = require('./detectors');
const { resolveOutcome } = require('./grade');
const G = require('./geometry');
const { wilson } = require('./predict');

const isNum = v => typeof v === 'number' && isFinite(v);
const round = (v, p = 4) => (isNum(v) ? Math.round(v * 10 ** p) / 10 ** p : null);

const EVIDENCE_VERSION = 'pattern-evidence-v2';

// ---- 1. point-in-time record builder -------------------------------------------

// Replay detection at every anchored as-of. Window = bars[t-windowBars .. t]; the
// detector itself splits formation (≤ t-1) from the confirmation bar (t), so nothing at
// any as-of sees the future. Outcomes resolve on bars strictly after t.
function buildResearchRecords({ ticker, candles, timeframe = '20d', windowBars = 22, stepBars = 5, horizonBars = 21, marketRegimeAt = null }) {
  const cs = G.toDaily(candles);
  const records = [];
  if (cs.length < windowBars + horizonBars + 2) return records;
  for (let t = windowBars; t < cs.length - 1; t += stepBars) {
    const window = cs.slice(t - windowBars, t + 1);
    const asOf = cs[t].date;
    const regime = marketRegimeAt ? marketRegimeAt(asOf) : 'UNKNOWN';
    let dets = [];
    try { dets = detectWindow(window, { timeframe, context: { marketRegime: regime } }); } catch { dets = []; }
    const top = dets.find(d => d.plan && !d.structurallyInvalid);
    if (!top) continue;
    const forward = cs.slice(t + 1);
    const outcome = resolveOutcome(top.plan, top.direction, forward, { horizonBars });
    records.push({
      ticker, asOfDate: asOf, asOfIdx: t, timeframe,
      family: top.family, direction: top.direction,
      // Frozen at-detection features only:
      structuralValidity: top.structuralValidity,
      featureCoverage: top.featureCoverage,
      similarity: top.similarity ? top.similarity.combined : null,
      plan: { trigger: top.plan.trigger, stop: top.plan.stop, target: top.plan.target, rr: top.plan.rr },
      regime,
      outcome,
    });
  }
  return purgeOverlaps(records, horizonBars);
}

// Matched non-pattern controls: as-ofs where NO family fired get the same mechanical
// breakout plan (prior high entry, ATR stop, measured target) resolved identically.
function buildControlRecords({ ticker, candles, windowBars = 22, stepBars = 5, horizonBars = 21, timeframe = '20d', marketRegimeAt = null }) {
  const cs = G.toDaily(candles);
  const out = [];
  if (cs.length < windowBars + horizonBars + 2) return out;
  for (let t = windowBars; t < cs.length - 1; t += stepBars) {
    const window = cs.slice(t - windowBars, t + 1);
    let dets = [];
    try { dets = detectWindow(window, { timeframe }); } catch { dets = []; }
    if (dets.some(d => d.plan && !d.structurallyInvalid)) continue; // pattern day → not a control
    const formation = window.slice(0, -1);
    const atr = G.atrOf(formation);
    if (!isNum(atr) || atr <= 0) continue;
    const hi = Math.max(...formation.map(c => c.high));
    const lo = Math.min(...formation.map(c => c.low));
    const plan = { trigger: hi, stop: hi - Math.max(1.5 * atr, (hi - lo) * 0.4), target: hi + (hi - lo) };
    const asOf = cs[t].date;
    out.push({
      ticker, asOfDate: asOf, timeframe, family: 'CONTROL', direction: 'LONG',
      regime: marketRegimeAt ? marketRegimeAt(asOf) : 'UNKNOWN',
      plan, outcome: resolveOutcome(plan, 'LONG', cs.slice(t + 1), { horizonBars }),
    });
  }
  return purgeOverlaps(out, horizonBars);
}

// Same-ticker temporal purge: records whose windows would overlap are near-duplicates,
// not independent evidence. Keep the first of each overlapping cluster per ticker.
function purgeOverlaps(records, embargoBars) {
  const byTicker = new Map();
  const out = [];
  const sorted = records.slice().sort((a, b) => String(a.asOfDate).localeCompare(String(b.asOfDate)));
  for (const r of sorted) {
    const k = `${r.ticker}|${r.family}|${r.direction}|${r.timeframe}`;
    const lastIdx = byTicker.get(k);
    if (lastIdx != null && isNum(r.asOfIdx) && r.asOfIdx - lastIdx < embargoBars) continue;
    byTicker.set(k, isNum(r.asOfIdx) ? r.asOfIdx : (lastIdx ?? 0) + embargoBars);
    out.push(r);
  }
  return out;
}

// ---- 3. purged chronological splits --------------------------------------------

// Anchored, embargoed split by DATE: train 60% / calibration 20% / final eval 20%,
// with an embargo gap (in records' date order) between segments so outcomes maturing
// across a boundary cannot leak.
function splitChronology(records, { embargoDays = 30 } = {}) {
  const sorted = records.slice().sort((a, b) => String(a.asOfDate).localeCompare(String(b.asOfDate)));
  const n = sorted.length;
  if (n < 10) return { train: [], calibration: [], evaluation: sorted.slice(), tooSmall: true };
  const d1 = sorted[Math.floor(n * 0.6)].asOfDate;
  const d2 = sorted[Math.floor(n * 0.8)].asOfDate;
  const gap = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);
  return {
    train: sorted.filter(r => String(r.asOfDate) < String(d1) && gap(r.asOfDate, d1) > embargoDays),
    calibration: sorted.filter(r => String(r.asOfDate) >= String(d1) && String(r.asOfDate) < String(d2) && gap(r.asOfDate, d2) > embargoDays),
    evaluation: sorted.filter(r => String(r.asOfDate) >= String(d2)),
    boundaries: { trainEnd: d1, calibrationEnd: d2 },
    tooSmall: false,
  };
}

// ---- 4. per-cell evaluation with FDR -------------------------------------------

function cellKey(r) { return `${r.family}|${r.direction}|${r.timeframe}`; }

function rateOf(rs) {
  const filled = rs.filter(r => r.outcome && r.outcome.filled);
  if (!filled.length) return { n: 0, filled: 0, targetRate: null, netMean: null };
  const wins = filled.filter(r => r.outcome.targetFirst).length;
  const netMean = filled.reduce((a, r) => a + (r.outcome.netReturnPct || 0), 0) / filled.length;
  return { n: rs.length, filled: filled.length, targetRate: round(wins / filled.length), netMean: round(netMean, 3) };
}

// Two-proportion z-test p-value (one-sided: pattern > control).
function twoPropP(p1, n1, p2, n2) {
  if (![p1, p2].every(isNum) || n1 < 2 || n2 < 2) return null;
  const p = (p1 * n1 + p2 * n2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return null;
  const z = (p1 - p2) / se;
  return round(1 - phi(z), 6);
}
function phi(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
function erf(x) {
  const s = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}

// Benjamini–Hochberg: which cells survive at FDR q. Returns the p-value threshold.
function bhThreshold(pvals, q = 0.1) {
  const ps = pvals.filter(isNum).sort((a, b) => a - b);
  let thresh = 0;
  for (let i = 0; i < ps.length; i++) {
    if (ps[i] <= ((i + 1) / ps.length) * q) thresh = ps[i];
  }
  return thresh;
}

// Evaluate every family×direction×timeframe cell. Calibration-period rates provide the
// probability estimate; ALL pass/fail metrics come from the untouched final period.
function evaluateCells({ records, controls, embargoDays = 30, fdrQ = 0.1 }) {
  const split = splitChronology(records, { embargoDays });
  const ctlSplit = splitChronology(controls || [], { embargoDays });
  const byCell = new Map();
  for (const r of split.evaluation) {
    const k = cellKey(r);
    if (!byCell.has(k)) byCell.set(k, []);
    byCell.get(k).push(r);
  }
  const calByCell = new Map();
  for (const r of split.calibration) {
    const k = cellKey(r);
    if (!calByCell.has(k)) calByCell.set(k, []);
    calByCell.get(k).push(r);
  }
  const ctlEval = rateOf(ctlSplit.evaluation);

  const cells = {};
  const pvals = [];
  for (const [k, rs] of byCell.entries()) {
    const evalStats = rateOf(rs);
    const calStats = rateOf(calByCell.get(k) || []);
    // Calibration quality: Brier of the calibration-period rate against final outcomes.
    let brier = null;
    let brierBaseline = null;
    if (isNum(calStats.targetRate) && evalStats.filled > 0) {
      const filled = rs.filter(r => r.outcome && r.outcome.filled);
      brier = round(filled.reduce((a, r) => a + (calStats.targetRate - (r.outcome.targetFirst ? 1 : 0)) ** 2, 0) / filled.length);
      const base = isNum(ctlEval.targetRate) ? ctlEval.targetRate : 0.5;
      brierBaseline = round(filled.reduce((a, r) => a + (base - (r.outcome.targetFirst ? 1 : 0)) ** 2, 0) / filled.length);
    }
    // Stability: net mean by chronological half of the final period + by year.
    const halves = [rs.slice(0, Math.floor(rs.length / 2)), rs.slice(Math.floor(rs.length / 2))].map(rateOf);
    const byYear = {};
    for (const r of rs.filter(x => x.outcome && x.outcome.filled)) {
      const y = String(r.asOfDate).slice(0, 4);
      byYear[y] = byYear[y] || { n: 0, net: 0 };
      byYear[y].n++;
      byYear[y].net += r.outcome.netReturnPct || 0;
    }
    const yearStats = Object.fromEntries(Object.entries(byYear).map(([y, v]) => [y, { n: v.n, netMean: round(v.net / v.n, 3) }]));
    const p = twoPropP(evalStats.targetRate, evalStats.filled, ctlEval.targetRate, ctlEval.filled);
    pvals.push(p);
    const ci = isNum(evalStats.targetRate) && evalStats.filled > 0 ? wilson(evalStats.targetRate, evalStats.filled) : null;
    cells[k] = {
      key: k,
      effectiveN: evalStats.filled,
      totalN: evalStats.n,
      targetRate: evalStats.targetRate,
      netMean: evalStats.netMean,
      controlTargetRate: ctlEval.targetRate,
      controlNetMean: ctlEval.netMean,
      controlN: ctlEval.filled,
      incrementalLift: isNum(evalStats.targetRate) && isNum(ctlEval.targetRate) ? round(evalStats.targetRate - ctlEval.targetRate) : null,
      netLift: isNum(evalStats.netMean) && isNum(ctlEval.netMean) ? round(evalStats.netMean - ctlEval.netMean, 3) : null,
      calibrationRate: calStats.targetRate,
      calibrationN: calStats.filled,
      brier, brierBaseline,
      wilsonCI: ci,
      pValue: p,
      stability: { halves: halves.map(h => h.netMean), byYear: yearStats },
    };
  }
  const fdrCut = bhThreshold(pvals, fdrQ);
  for (const c of Object.values(cells)) c.fdrPass = isNum(c.pValue) && c.pValue <= fdrCut && fdrCut > 0;
  return { cells, split: { train: split.train.length, calibration: split.calibration.length, evaluation: split.evaluation.length, boundaries: split.boundaries }, control: ctlEval, fdrCut };
}

// ---- 5. the proven gate ----------------------------------------------------------

const DEFAULT_GATE = Object.freeze({
  minEffectiveN: 40,        // resolved, de-overlapped, final-period fills
  minCalibrationN: 20,      // calibration-period fills backing the probability
  maxBrierVsBaseline: 0,    // brier must beat the control baseline (≤)
  minNetLift: 0.05,         // cost-net % lift vs matched controls, strictly > 0
  minYears: 2,              // may not depend on a single year
});

// Every condition, every reason. `analog.sufficient` is not an input — sample size alone
// can NEVER mark a family proven.
function provenGate(cell, gate = DEFAULT_GATE) {
  const reasons = [];
  if (!cell) return { proven: false, reasons: ['no evaluated cell'] };
  if (!isNum(cell.effectiveN) || cell.effectiveN < gate.minEffectiveN) reasons.push(`out-of-sample n ${cell.effectiveN || 0} < ${gate.minEffectiveN}`);
  if (!isNum(cell.calibrationN) || cell.calibrationN < gate.minCalibrationN) reasons.push(`calibration n ${cell.calibrationN || 0} < ${gate.minCalibrationN}`);
  if (!isNum(cell.netLift) || cell.netLift <= gate.minNetLift) reasons.push(`cost-net lift vs matched controls ${cell.netLift ?? 'n/a'} ≤ ${gate.minNetLift}`);
  if (!isNum(cell.incrementalLift) || cell.incrementalLift <= 0) reasons.push('no positive target-rate lift vs matched controls');
  if (!(cell.wilsonCI && isNum(cell.controlTargetRate) && cell.wilsonCI[0] > cell.controlTargetRate)) reasons.push('confidence interval does not clear the control rate');
  if (!(isNum(cell.brier) && isNum(cell.brierBaseline) && cell.brier - cell.brierBaseline <= gate.maxBrierVsBaseline)) reasons.push('calibration quality does not beat the baseline');
  if (cell.fdrPass !== true) reasons.push('does not survive false-discovery control across families');
  const years = cell.stability ? Object.keys(cell.stability.byYear) : [];
  if (years.length < gate.minYears) reasons.push(`resolved history spans ${years.length} year(s) < ${gate.minYears}`);
  else {
    const positives = years.filter(y => (cell.stability.byYear[y].netMean || 0) > 0).length;
    if (positives < Math.ceil(years.length / 2)) reasons.push('net edge not stable across years');
  }
  if (cell.stability && cell.stability.halves.every(isNum) && cell.stability.halves.some(h => h <= 0) && cell.stability.halves.filter(h => h > 0).length === 0) {
    reasons.push('no positive chronological block');
  }
  return { proven: reasons.length === 0, reasons };
}

// ---- 6. the versioned evidence artifact ------------------------------------------

function buildEvidenceTable(evaluated, { gate = DEFAULT_GATE, builtAt = null } = {}) {
  const cells = {};
  for (const [k, cell] of Object.entries(evaluated.cells || {})) {
    const verdict = provenGate(cell, gate);
    cells[k] = { ...cell, proven: verdict.proven, reasons: verdict.reasons };
  }
  return {
    version: EVIDENCE_VERSION,
    builtAt,
    gate,
    split: evaluated.split,
    control: evaluated.control,
    fdrCut: evaluated.fdrCut,
    cells,
  };
}

module.exports = {
  buildResearchRecords, buildControlRecords, purgeOverlaps,
  splitChronology, evaluateCells, provenGate, buildEvidenceTable,
  DEFAULT_GATE, EVIDENCE_VERSION,
};

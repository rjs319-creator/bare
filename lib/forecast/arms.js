'use strict';
// COMPARISON ARMS & NEGATIVE CONTROLS (forecast-arms-v1)
//
// Turns one fold's frames into the prediction series each scoreboard arm is measured on. Every
// arm is scored on the SAME rows so the comparison is like-for-like — a candidate that is only
// better because it quietly dropped hard names is not better.
//
// Arms:
//   control-random     a deterministic, information-free pseudo-order. Must score ~0.
//   ridge              the permanent baseline.
//   chronos2/moirai2   the foundation models, when available.
//   static-ensemble    equal-weighted usable base points.
//   dynamic-ensemble   weighted by matured OOS performance (lib/forecast/ensemble.js).
//   lightgbm-no-foundation  the meta-ranker trained WITHOUT foundation-model features — the
//                      control that answers "did the foundation models add anything?".
//   meta-ranker        the final ranker.
//   shuffled-label     the meta-ranker trained on labels shuffled WITHIN each decision date.
//                      A persistent edge here means leakage, not skill.
//   delayed-signal     the final ranker's score carried forward from an earlier decision date.
//                      A signal that survives an execution delay it should not survive is a
//                      backtest error.

const ARMS_VERSION = 'forecast-arms-v1';

const isFin = Number.isFinite;

/** Deterministic, information-free order — the zero-signal control. */
function hashOrder(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000000) / 1000000;
}

const usable = (b) => b && (b.availability === 'ok' || b.availability === 'degraded') && isFin(b.point);

/** Equal-weighted mean of usable base points; null when nothing is usable. */
function staticEnsemblePoint(frame) {
  const pts = Object.values(frame.base || {}).filter(usable).map((b) => b.point);
  return pts.length ? pts.reduce((a, b) => a + b, 0) / pts.length : null;
}

/**
 * Prediction rows for one arm.
 *   scoreOf(frame) -> number|null
 *   detailOf(frame) -> { quantiles, probabilities, availability, latencyMs } (optional)
 */
function armPredictions(frames, scoreOf, detailOf = null) {
  const out = [];
  for (const f of frames) {
    const score = scoreOf(f);
    const d = detailOf ? detailOf(f) || {} : {};
    out.push({
      rowKey: f.rowKey, ticker: f.ticker, sector: f.sector,
      decisionDate: f.decisionDate, labelEnd: f.label && f.label.labelEnd,
      score: isFin(score) ? score : null,
      actual: f.label && isFin(f.label.residualReturn) ? f.label.residualReturn : null,
      classes: f.label ? f.label.classes : null,
      label: f.label, adv: f.adv, price: f.price,
      quantiles: d.quantiles || null,
      probabilities: d.probabilities || null,
      availability: d.availability || 'ok',
      latencyMs: isFin(d.latencyMs) ? d.latencyMs : null,
    });
  }
  return out;
}

/** Base-model arm: point estimate as the score, with its own quantiles/probabilities. */
function baseArm(frames, model) {
  return armPredictions(
    frames,
    (f) => (usable(f.base[model]) ? f.base[model].point : null),
    (f) => {
      const b = f.base[model];
      return b ? { quantiles: b.quantiles, probabilities: b.probabilities, availability: b.availability, latencyMs: b.latencyMs } : { availability: 'inference-failed' };
    },
  );
}

/** Carry a score forward by `lagDates` decision dates — the delayed-signal negative control. */
function delayedSignal(frames, scoreByKey, lagDates = 1) {
  const dates = [...new Set(frames.map((f) => f.decisionDate))].sort();
  const dateIndex = new Map(dates.map((d, i) => [d, i]));
  const byKey = new Map();
  for (const f of frames) byKey.set(`${f.ticker}|${f.decisionDate}`, f);
  return armPredictions(frames, (f) => {
    const i = dateIndex.get(f.decisionDate);
    if (i == null || i - lagDates < 0) return null;
    const prior = byKey.get(`${f.ticker}|${dates[i - lagDates]}`);
    if (!prior) return null;
    const s = scoreByKey.get(prior.rowKey);
    return isFin(s) ? s : null;
  });
}

/** Shuffle labels WITHIN each decision date, deterministically — the shuffled-label control. */
function shuffleLabelsWithinDate(frames, seed) {
  let s = (seed >>> 0) || 1;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const out = frames.map((f) => ({ ...f }));
  let i = 0;
  while (i < out.length) {
    let j = i;
    while (j + 1 < out.length && out[j + 1].decisionDate === out[i].decisionDate) j++;
    const labels = out.slice(i, j + 1).map((f) => f.label);
    for (let k = labels.length - 1; k > 0; k--) {
      const r = Math.floor(rnd() * (k + 1));
      const t = labels[k]; labels[k] = labels[r]; labels[r] = t;
    }
    for (let k = i; k <= j; k++) out[k].label = labels[k - i];
    i = j + 1;
  }
  return out;
}

module.exports = { ARMS_VERSION, hashOrder, usable, staticEnsemblePoint, armPredictions, baseArm, delayedSignal, shuffleLabelsWithinDate };

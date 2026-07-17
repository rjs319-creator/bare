// FAILURE-MODEL VALIDATION (spec §5 acceptance test)
//
// The failure model only earns the right to bind if the names it REJECTS actually do worse
// out-of-sample. This replays the candle-reconstructable failure features POINT-IN-TIME over
// the resolved ledger, scores each historical pick, splits into rejected / near-threshold /
// approved, and compares their forward returns. Verdict:
//   • predictive  → rejected underperformed approved beyond the gate ⇒ the model has real
//                    failure signal (a future session could promote it out of shadow);
//   • inverted    → rejected did BETTER (a red flag — the "failure" features mark winners here);
//   • no-signal   → the split doesn't separate outcomes ⇒ stays shadow;
//   • insufficient→ not enough resolved picks in both buckets yet.
// Only the technical (candle-derivable) subset is testable historically — earnings/single-factor/
// track features aren't in the ledger — so the report labels itself a subset test. Pure.

'use strict';

const FM = require('./failure-model');

const EVAL_CONFIG = {
  WINDOW: 21,       // forward trading bars for the outcome (≈ one month — a swing/position failure horizon)
  MIN_TOTAL: 40,    // total resolved picks before any verdict
  MIN_BUCKET: 10,   // min n in BOTH rejected and approved before comparing
  GAP_MIN: 1.0,     // approved−rejected mean forward return (pp) needed to call it predictive
  // PROMOTION (shadow → could bind) is a MUCH higher bar than the verdict. This app's research
  // is a graveyard of single-window edges that died out-of-sample, so a "predictive" verdict on
  // one regime window must NOT flip the model out of shadow. Promotion additionally requires a
  // multi-month span (a regime-diversity proxy) and a larger sample.
  PROMOTE_MIN_MONTHS: 3,
  PROMOTE_MIN_TOTAL: 150,
};

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const median = (a) => {
  const x = a.filter(Number.isFinite).sort((p, q) => p - q);
  if (!x.length) return null;
  const m = Math.floor(x.length / 2);
  return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2;
};

function detectIdx(candles, date) {
  let idx = -1;
  for (let k = 0; k < candles.length; k++) { if (candles[k].date <= date) idx = k; else break; }
  return idx;
}
// Point-in-time bench trend (SPY 20-bar slope sign) at a date, for the breadth feature.
function benchTrendAt(spyCandles, date) {
  if (!Array.isArray(spyCandles) || spyCandles.length < 21) return null;
  const idx = detectIdx(spyCandles, date);
  if (idx < 20) return null;
  const net = (spyCandles[idx].close - spyCandles[idx - 20].close) / spyCandles[idx - 20].close;
  return net < 0 ? Math.min(1, -net * 10) * -1 : Math.min(1, net * 10); // negative ⇒ weakening
}

function summarize(rows) {
  const rets = rows.map(r => r.ret);
  const excs = rows.map(r => r.exc).filter(Number.isFinite);
  return {
    n: rows.length,
    meanReturn: rets.length ? +mean(rets).toFixed(2) : null,
    medianReturn: rets.length ? +median(rets).toFixed(2) : null,
    winRate: rets.length ? +(rets.filter(r => r > 0).length / rets.length * 100).toFixed(1) : null,
    meanExcess: excs.length ? +mean(excs).toFixed(2) : null,
  };
}

// picks: first-appearance rows [{date,ticker,section,tier,entry,short}]. histMap: Map<ticker,candles>.
function evaluateFailureModel(picks, histMap, { spyCandles = null, config = {} } = {}) {
  const cfg = { ...EVAL_CONFIG, ...config };
  const scored = [];
  for (const p of picks || []) {
    const candles = histMap && (histMap.get ? histMap.get(p.ticker) : histMap[p.ticker]);
    if (!Array.isArray(candles)) continue;
    const idx = detectIdx(candles, p.date);
    if (idx < 21 || idx + cfg.WINDOW >= candles.length) continue; // need history + elapsed outcome
    const benchTrend = spyCandles ? benchTrendAt(spyCandles, p.date) : null;
    const fv = FM.featuresFromCandles(candles, idx, { benchTrend });
    const { failureProb, expectedMode } = FM.scoreFeatures(fv);
    const detect = (p.entry != null && p.entry > 0) ? p.entry : candles[idx].close;
    const isShort = p.short === true || p.tier === 'StrongSell';
    let ret = ((candles[idx + cfg.WINDOW].close - detect) / detect) * 100;
    if (isShort) ret = -ret;
    let exc = null;
    if (spyCandles) {
      const si = detectIdx(spyCandles, p.date);
      if (si >= 0 && si + cfg.WINDOW < spyCandles.length) {
        const spyRet = ((spyCandles[si + cfg.WINDOW].close - spyCandles[si].close) / spyCandles[si].close) * 100;
        exc = +(ret - (isShort ? -spyRet : spyRet)).toFixed(2);
      }
    }
    scored.push({ ticker: p.ticker, section: p.section, month: String(p.date).slice(0, 7), failureProb, expectedMode, ret: +ret.toFixed(2), exc });
  }
  const distinctMonths = new Set(scored.map(s => s.month)).size;

  // Split by the failure-score DISTRIBUTION (top third = the model's most-rejected names, bottom
  // third = most-approved), not an absolute cut. The candle-only subset produces a compressed
  // probability range, and the acceptance question is relative — "do the names this model scores
  // HIGHEST for failure actually do worse than the ones it scores lowest?" — so a rank split is
  // the honest test. Separation between the two buckets is required, else there's nothing to compare.
  const sorted = scored.slice().sort((a, b) => a.failureProb - b.failureProb);
  const n = sorted.length;
  const third = Math.max(1, Math.floor(n / 3));
  const approvedRows = sorted.slice(0, third);
  const rejectedRows = sorted.slice(n - third);
  const nearRows = sorted.slice(third, n - third);
  const separation = n ? +(rejectedRows[0].failureProb - approvedRows[approvedRows.length - 1].failureProb).toFixed(3) : 0;
  const buckets = {
    rejected: { ...summarize(rejectedRows), minProb: rejectedRows.length ? rejectedRows[0].failureProb : null },
    nearThreshold: summarize(nearRows),
    approved: { ...summarize(approvedRows), maxProb: approvedRows.length ? approvedRows[approvedRows.length - 1].failureProb : null },
  };
  const scoredForModes = scored;

  // Per-mode historical loss rate — the "historical analog" at the failure-mode level.
  const byMode = {};
  for (const s of scoredForModes) {
    if (!s.expectedMode) continue;
    (byMode[s.expectedMode] = byMode[s.expectedMode] || []).push(s.ret);
  }
  const modeStats = Object.entries(byMode).map(([mode, rets]) => ({
    mode, label: (FM.FAILURE_MODES[mode] || {}).label || mode, n: rets.length,
    lossRate: +(rets.filter(r => r <= 0).length / rets.length * 100).toFixed(1),
    meanReturn: +mean(rets).toFixed(2),
  })).sort((a, b) => b.lossRate - a.lossRate);

  // Verdict.
  let verdict, predictiveGap = null;
  if (scored.length < cfg.MIN_TOTAL) verdict = 'insufficient';
  else if (approvedRows.length < cfg.MIN_BUCKET || rejectedRows.length < cfg.MIN_BUCKET) verdict = 'insufficient';
  else if (separation <= 0.02) verdict = 'no-signal'; // the model gave everything ~the same score
  else {
    predictiveGap = +(buckets.approved.meanReturn - buckets.rejected.meanReturn).toFixed(2);
    verdict = predictiveGap >= cfg.GAP_MIN ? 'predictive'
      : predictiveGap <= -cfg.GAP_MIN ? 'inverted' : 'no-signal';
  }
  // Promotion is deliberately conservative: predictive AND multi-month span AND a large sample.
  const spanOk = distinctMonths >= cfg.PROMOTE_MIN_MONTHS && scored.length >= cfg.PROMOTE_MIN_TOTAL;
  const promoted = verdict === 'predictive' && spanOk;
  let promotionBlockedReason = null;
  if (verdict === 'predictive' && !promoted) {
    promotionBlockedReason = `Predictive on the available data, but held in SHADOW: it spans ${distinctMonths} month(s) / ${scored.length} picks — below the ${cfg.PROMOTE_MIN_MONTHS}-month, ${cfg.PROMOTE_MIN_TOTAL}-pick bar for a regime-robust result. This app's research has repeatedly shown single-window edges die out-of-sample; the failure model must clear multiple regimes before it can bind.`;
  }
  return {
    version: FM.FAILURE_MODEL_VERSION, config: cfg,
    coverage: { picks: (picks || []).length, evaluated: scored.length, benchmark: !!spyCandles, distinctMonths },
    buckets, separation, byMode: modeStats, verdict, predictiveGap,
    promoted, promotionBlockedReason,  // shadow unless promoted
    note: 'Historical replay of the CANDLE-DERIVABLE failure features only (earnings / single-factor / track-record features are not in the ledger). The model stays in SHADOW unless the rejected group demonstrably underperforms the approved group across MULTIPLE regime windows — a "predictive" verdict on one window is not enough to let it bind.',
  };
}

module.exports = { EVAL_CONFIG, evaluateFailureModel, benchTrendAt };

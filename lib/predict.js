// FORECAST — modernized predictions. Unlike the old manual "click correct" tracker,
// every prediction is FALSIFIABLE and AUTO-RESOLVED against real price data (like the
// app's other ledgers): {subject, direction, horizon, threshold}. The honest accuracy
// is computed from outcomes, not self-graded.

// Anthropic tool schema — the LLM must return measurable predictions.
const PREDICT_TOOL = {
  name: 'submit_predictions',
  description: 'Provide 5 FALSIFIABLE, measurable market predictions for the next 1-3 weeks. Each must be checkable against price data — no vague claims.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'the prediction in plain English (one sentence)' },
            subject: { type: 'string', description: 'the symbol to measure: SPY, QQQ, ^VIX, a sector ETF (XLK XLF XLE XLV XLY XLP XLI XLU XLRE XLB XLC), or a specific liquid stock ticker' },
            direction: { type: 'string', enum: ['up', 'down', 'outperform', 'underperform'], description: 'up/down = absolute move; outperform/underperform = vs SPY' },
            horizon: { type: 'integer', description: 'trading days until it resolves: 5, 10, or 21' },
            threshold: { type: 'number', description: 'percent move required for up/down (e.g. 3 means needs +3% / -3%). Use 0 for outperform/underperform.' },
            rationale: { type: 'string', description: 'one short sentence why' },
            confidence: { type: 'integer', description: '1-10 how confident' },
          },
          required: ['text', 'subject', 'direction', 'horizon'],
        },
      },
    },
    required: ['items'],
  },
};

function priceOnOrAfter(candles, date) {
  for (let i = 0; i < candles.length; i++) if (candles[i].date >= date) return i;
  return -1;
}

// Resolve a prediction against candle arrays. Returns {status, actualPct, excPct?, exitDate}
// or null if it hasn't matured yet (not enough forward bars).
function resolvePrediction(pred, subj, spy) {
  if (!subj || !subj.length) return null;
  const ai = priceOnOrAfter(subj, pred.date); if (ai < 0) return null;
  const bi = ai + (pred.horizon || 10); if (bi >= subj.length) return null;   // not matured
  const exitDate = subj[bi].date;
  const ret = (subj[bi].close / subj[ai].close - 1) * 100;
  const dir = pred.direction, thr = Math.abs(pred.threshold || 0);
  let status, excPct = null;
  if (dir === 'up') status = ret >= thr ? 'correct' : 'incorrect';
  else if (dir === 'down') status = ret <= -thr ? 'correct' : 'incorrect';
  else {
    if (!spy || !spy.length) return null;
    const sai = priceOnOrAfter(spy, pred.date), sbi = priceOnOrAfter(spy, exitDate);
    if (sai < 0 || sbi < 0) return null;
    const sret = (spy[sbi].close / spy[sai].close - 1) * 100;
    excPct = +(ret - sret).toFixed(2);
    status = (dir === 'outperform' ? excPct > 0 : excPct < 0) ? 'correct' : 'incorrect';
  }
  return { status, actualPct: +ret.toFixed(2), excPct, exitDate };
}

// Human label for a prediction's measurable claim (so the UI can show what it's checking).
function claimLabel(p) {
  const h = `${p.horizon}d`;
  if (p.direction === 'up') return `${p.subject} +${p.threshold || 0}% in ${h}`;
  if (p.direction === 'down') return `${p.subject} −${p.threshold || 0}% in ${h}`;
  if (p.direction === 'outperform') return `${p.subject} beats SPY in ${h}`;
  return `${p.subject} lags SPY in ${h}`;
}

// Forecast calibration — is the stated 1–10 confidence honest? Bucket resolved
// calls by confidence and compare to the actual hit rate; Brier score + verdict.
function computeCalibration(resolved) {
  const r = resolved.filter(p => typeof p.confidence === 'number' && p.confidence >= 1 && p.confidence <= 10);
  if (!r.length) return { n: 0 };
  const BUCKETS = [['low', 'Low (1–5)', c => c <= 5], ['med', 'Med (6–7)', c => c >= 6 && c <= 7], ['high', 'High (8–10)', c => c >= 8]];
  const buckets = BUCKETS.map(([key, label, test]) => {
    const sub = r.filter(p => test(p.confidence)); const n = sub.length;
    const correct = sub.filter(p => p.status === 'correct').length;
    return { key, label, n, correct, stated: n ? Math.round(sub.reduce((s, p) => s + p.confidence, 0) / n * 10) : null, actual: n ? Math.round(correct / n * 100) : null };
  });
  const brier = r.reduce((s, p) => s + Math.pow(p.confidence / 10 - (p.status === 'correct' ? 1 : 0), 2), 0) / r.length;
  const meanExp = r.reduce((s, p) => s + p.confidence / 10, 0) / r.length;
  const meanAct = r.filter(p => p.status === 'correct').length / r.length;
  const gap = meanAct - meanExp;
  const verdict = gap < -0.08 ? 'overconfident' : gap > 0.08 ? 'underconfident' : 'well-calibrated';
  return { n: r.length, buckets, brier: +brier.toFixed(3), meanStated: Math.round(meanExp * 100), meanActual: Math.round(meanAct * 100), gap: Math.round(gap * 100), verdict };
}

module.exports = { PREDICT_TOOL, resolvePrediction, claimLabel, priceOnOrAfter, computeCalibration };

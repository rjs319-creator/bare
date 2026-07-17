'use strict';
// FAILURE-MODEL VALIDATION route (op=failuremodel) — folded into api/tracker.js (no new
// Serverless Function). Replays the candle-derivable failure features point-in-time over the
// resolved ledger and reports whether the names the model REJECTS underperform the ones it
// APPROVES out-of-sample (spec §5 acceptance test). Heavy (candle fetch across the ledger
// universe) → EXPENSIVE_OPS rate-limited + CDN-cached. The model stays SHADOW unless this
// returns 'predictive'.

const { hasStore, readJSON, writeJSON } = require('./store');
const { fetchDailyHistory } = require('./screener');
const { assemblePicks, } = require('./leadtime-routes'); // same first-appearance ledger assembly
const { evaluateFailureModel } = require('./failure-model-eval');

const CACHE_PATH = 'apex/failure-model.json';

async function fetchHist(tickers) {
  const hist = new Map();
  let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++];
      try { const d = await fetchDailyHistory(t); if (d) hist.set(t, d.candles); } catch { /* skip a bad feed */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, tickers.length) }, worker));
  return hist;
}

async function runFailureModel(req, res) {
  if (!hasStore()) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, configured: false, verdict: 'insufficient', note: 'No ledger store configured yet.' });
  }
  const picks = await assemblePicks();
  if (!picks.length) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, configured: true, verdict: 'insufficient', coverage: { picks: 0, evaluated: 0 }, note: 'No resolvable first-appearance picks yet.' });
  }
  const hist = await fetchHist([...new Set(picks.map(p => p.ticker))]);
  const spy = await fetchDailyHistory('SPY').catch(() => null);
  const result = evaluateFailureModel(picks, hist, { spyCandles: spy ? spy.candles : null });
  const payload = { ok: true, configured: true, generatedAt: new Date().toISOString(), shadow: !result.promoted, ...result };
  try { await writeJSON(CACHE_PATH, payload, 0); } catch { /* cache optional */ }
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  return res.json(payload);
}

async function loadFailureModel() { return readJSON(CACHE_PATH, null).catch(() => null); }

module.exports = { runFailureModel, loadFailureModel, CACHE_PATH };

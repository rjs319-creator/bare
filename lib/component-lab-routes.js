'use strict';
// COMPONENT LABORATORY route (op=complab) — folded into api/tracker.js (no new Serverless
// Function). Builds a matched treated-vs-control study over the resolved ledger: reconstructs
// each pick's component flags + confounders point-in-time from candles, resolves its forward
// outcome, and runs the matching engine (lib/component-lab.js) to report each component's
// INCREMENTAL effect after controlling for regime / sector / prior-return / liquidity. Heavy
// (candle fetch across the ledger) → EXPENSIVE_OPS rate-limited + CDN-cached.

const { hasStore, readJSON, writeJSON } = require('./store');
const { fetchDailyHistory } = require('./screener');
const { assemblePicks } = require('./leadtime-routes');
const { SECTOR_OF } = require('./universe');
const FM = require('./failure-model');
const { benchTrendAt } = require('./failure-model-eval');
const { runComponentLab } = require('./component-lab');

const CACHE_PATH = 'apex/component-lab.json';
const WINDOW = 21; // forward trading bars for the outcome

// The components under test — each a binary treatment reconstructable point-in-time, chosen to
// be reasonably orthogonal to the confounders we match on (so matching doesn't erase the
// treatment). Faithful to the spec's examples (abnormal volume / volatility filter / tight vs
// extended entry / trend quality / repeated failed breakouts).
const COMPONENTS = [
  { key: 'abnormalVolume', label: 'Abnormal volume (RVOL ≥ 2)', blurb: 'Breakouts on ≥2× average volume vs otherwise-similar names without the volume surge.', detect: f => f.rvol >= 2 },
  { key: 'tightEntry', label: 'Tight (un-extended) entry', blurb: 'Names entered close to support vs those already extended above it.', detect: f => f.extension < 0.5 },
  { key: 'lowerVolatility', label: 'Lower-volatility filter', blurb: 'Calmer names (ATR < 3%/day) vs higher-volatility ones — OMEGA-SWING-style vol filter.', detect: f => f.atrPct < 0.03 },
  { key: 'aboveRising50', label: 'Above a rising 50-DMA', blurb: 'Confirmed uptrend (price over a rising 50-day) vs those without it.', detect: f => f.aboveRising50 === true },
  { key: 'cleanStructure', label: 'No recent failed breakouts', blurb: 'Clean overhead (no repeated failed breakout attempts) vs names with supply rejecting price.', detect: f => f.failedBreakouts < 0.25 },
];

async function fetchHist(tickers) {
  const hist = new Map();
  let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++];
      try { const d = await fetchDailyHistory(t); if (d) hist.set(t, d.candles); } catch { /* skip */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, tickers.length) }, worker));
  return hist;
}

// Point-in-time features + confounders at the detection bar.
function featuresAt(candles, idx, spyCandles, ticker, date) {
  if (idx < 50 || idx + WINDOW >= candles.length) return null;
  const c = candles[idx];
  const sma20 = FM.sma(candles, 20, idx), sma50 = FM.sma(candles, 50, idx), a = FM.atr(candles, 14, idx);
  if (!sma20 || !sma50 || !(a > 0) || !(c.close > 0)) return null;
  const vols = []; for (let k = idx - 20; k < idx; k++) if (Number.isFinite(candles[k].volume)) vols.push(candles[k].volume);
  const avgVol = vols.length ? vols.reduce((s, v) => s + v, 0) / vols.length : null;
  const rvol = (avgVol && Number.isFinite(c.volume) && avgVol > 0) ? c.volume / avgVol : 1;
  const dollarVol = avgVol ? avgVol * c.close : null;
  const priorReturn = candles[idx - 21] ? (c.close / candles[idx - 21].close - 1) * 100 : 0;
  const sma50Prev = FM.sma(candles, 50, idx - 10);
  const fmFv = FM.featuresFromCandles(candles, idx);
  const bt = benchTrendAt(spyCandles, date);
  return {
    rvol, extension: fmFv.extended, atrPct: a / c.close, failedBreakouts: fmFv.failedBreakouts,
    aboveRising50: c.close > sma50 && sma50Prev != null && sma50 > sma50Prev,
    priorReturn, logDollarVol: dollarVol ? Math.log10(Math.max(1, dollarVol)) : 0,
    regime: bt != null && bt < 0 ? 'risk-off' : 'risk-on',
    sector: SECTOR_OF[ticker] || 'Unknown',
  };
}

// Forward outcome from the detection bar: direction-aware return + MFE/MAE, and target-before-
// stop when the pick logged both levels (else null).
function outcomeAt(candles, idx, pick) {
  const detect = (pick.entry != null && pick.entry > 0) ? pick.entry : candles[idx].close;
  const isShort = pick.short === true || pick.tier === 'StrongSell';
  const end = idx + WINDOW;
  let ret = ((candles[end].close - detect) / detect) * 100; if (isShort) ret = -ret;
  let mfe = 0, mae = 0, tbs = null;
  const hasLevels = Number.isFinite(pick.stop) && Number.isFinite(pick.target);
  for (let k = idx + 1; k <= end; k++) {
    const cc = candles[k], hi = cc.high ?? cc.close, lo = cc.low ?? cc.close;
    const fav = isShort ? ((detect - lo) / detect) * 100 : ((hi - detect) / detect) * 100;
    const adv = isShort ? ((hi - detect) / detect) * 100 : ((detect - lo) / detect) * 100;
    if (fav > mfe) mfe = fav; if (adv > mae) mae = adv;
    if (hasLevels && tbs === null) {
      const hitT = isShort ? lo <= pick.target : hi >= pick.target;
      const hitS = isShort ? hi >= pick.stop : lo <= pick.stop;
      if (hitT) tbs = true; else if (hitS) tbs = false;
    }
  }
  return { ret: +ret.toFixed(2), targetBeforeStop: tbs, mfe: +mfe.toFixed(2), mae: +mae.toFixed(2) };
}

function detectIdx(candles, date) {
  let idx = -1;
  for (let k = 0; k < candles.length; k++) { if (candles[k].date <= date) idx = k; else break; }
  return idx;
}

async function runComponentLabRoute(req, res) {
  if (!hasStore()) { res.setHeader('Cache-Control', 'no-store'); return res.json({ ok: true, configured: false, components: [], note: 'No ledger store configured yet.' }); }
  const picks = await assemblePicks();
  if (!picks.length) { res.setHeader('Cache-Control', 'no-store'); return res.json({ ok: true, configured: true, components: [], coverage: { records: 0 }, note: 'No resolvable first-appearance picks yet.' }); }
  const hist = await fetchHist([...new Set(picks.map(p => p.ticker))]);
  const spy = await fetchDailyHistory('SPY').catch(() => null);
  const spyCandles = spy ? spy.candles : null;

  const records = [];
  for (const p of picks) {
    const candles = hist.get(p.ticker);
    if (!Array.isArray(candles)) continue;
    const idx = detectIdx(candles, p.date);
    if (idx < 0) continue;
    const features = featuresAt(candles, idx, spyCandles, p.ticker, p.date);
    if (!features) continue;
    const outcome = outcomeAt(candles, idx, p);
    records.push({ ticker: p.ticker, date: p.date, section: p.section, tier: p.tier, ...outcome, features });
  }
  const result = runComponentLab(records, { components: COMPONENTS });
  const payload = {
    ok: true, configured: true, generatedAt: new Date().toISOString(), window: WINDOW, ...result,
    note: 'Matched treated-vs-control: each component’s effect is measured against the most similar names WITHOUT it (same regime, similar sector / prior return / liquidity), so a component only reads "additive" if it beats comparable setups — not just because component-present names happened to do well. Never auto-removes a feature; recommendations only.',
  };
  try { await writeJSON(CACHE_PATH, payload, 0); } catch { /* cache optional */ }
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  return res.json(payload);
}

async function loadComponentLab() { return readJSON(CACHE_PATH, null).catch(() => null); }

module.exports = { runComponentLabRoute, loadComponentLab, COMPONENTS, featuresAt, outcomeAt, CACHE_PATH };

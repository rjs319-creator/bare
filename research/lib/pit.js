'use strict';
// Shared point-in-time helpers for the research panel (steps 03 + 04).
const fs = require('fs');
const path = require('path');
const fmp = require('./fmp');

const DAY = 86400000, LAG = 45 * DAY;             // statement report-availability lag
const CAP_LO = 300e6, CAP_HI = 10e9, ADV_FLOOR = 3e6;
const CACHE = path.join(__dirname, '..', 'data', 'cache');

// Per-symbol fetch with disk cache. Never persists a total failure (so 429'd
// symbols retry on the next run instead of being cached as empty forever).
async function fetchSymbol(sym) {
  const f = path.join(CACHE, `${sym}.json`);
  if (fs.existsSync(f)) {
    try { const c = JSON.parse(fs.readFileSync(f, 'utf8')); if (c.price?.length || c.income?.length) return c; } catch { /* refetch */ }
  }
  const out = { sym, price: null, income: null, fetchedAt: new Date().toISOString() };
  try { out.price = await fmp.priceHistory(sym); } catch (e) { out.error = `price:${String(e?.message || e).slice(0, 60)}`; }
  try { out.income = await fmp.incomeQuarterly(sym, 60); } catch (e) { out.error = (out.error || '') + ` inc:${String(e?.message || e).slice(0, 60)}`; }
  if (out.price?.length || out.income?.length) { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(f, JSON.stringify(out)); }
  return out;
}

const sharesSeries = income => (income || [])
  .map(r => ({ eff: Date.parse(r.filingDate || r.acceptedDate || r.date) + (r.filingDate || r.acceptedDate ? 0 : LAG), shares: r.weightedAverageShsOut ?? r.weightedAverageShsOutDil ?? null }))
  .filter(r => Number.isFinite(r.eff) && r.shares > 0).sort((a, b) => a.eff - b.eff);

const priceSeries = price => (price || [])
  .map(r => ({ ms: Date.parse(r.date), close: r.close, dollar: (r.close || 0) * (r.volume || 0) }))
  .filter(r => Number.isFinite(r.ms) && r.close > 0).sort((a, b) => a.ms - b.ms);

function asOfShares(series, dateMs) { let s = null; for (const r of series) { if (r.eff <= dateMs) s = r.shares; else break; } return s; }

function idxAsOf(series, dateMs) { let idx = -1; for (let k = 0; k < series.length; k++) { if (series[k].ms <= dateMs) idx = k; else break; } return idx; }

function asOfPriceAdv(series, dateMs) {
  const idx = idxAsOf(series, dateMs); if (idx < 0) return null;
  let sum = 0, c = 0; for (let k = Math.max(0, idx - 19); k <= idx; k++) { sum += series[k].dollar; c++; }
  return { idx, close: series[idx].close, adv: c ? sum / c : 0, stale: (dateMs - series[idx].ms) > 10 * DAY };
}

// Forward return over `bars` trading days from the bar at/just-before dateMs.
// If the window runs past the last bar (the name stopped trading), returns the
// partial return + delistedWithin=true so the caller can apply a delisting rule.
function fwdReturn(series, dateMs, bars) {
  const idx = idxAsOf(series, dateMs); if (idx < 0) return null;
  const entry = series[idx].close; if (!(entry > 0)) return null;
  const tgt = idx + bars;
  if (tgt < series.length) return { ret: series[tgt].close / entry - 1, delistedWithin: false };
  const last = series[series.length - 1];
  if (last.ms <= series[idx].ms) return null;          // no forward data at all
  return { ret: last.close / entry - 1, delistedWithin: true }; // ran out of bars → name stopped trading
}

function monthEnds(fromYM, toYM) {
  const out = []; let [y, m] = fromYM.split('-').map(Number); const [ty, tm] = toYM.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(Date.UTC(y, m, 0)); if (++m > 12) { m = 1; y++; } }
  return out;
}

module.exports = { DAY, LAG, CAP_LO, CAP_HI, ADV_FLOOR, CACHE, fetchSymbol, sharesSeries, priceSeries, asOfShares, asOfPriceAdv, fwdReturn, monthEnds };

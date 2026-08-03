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

// Public-availability ordering (PIT contract): acceptedDate (SEC acceptance
// timestamp) > filingDate > period date + conservative LAG. Shares are
// weighted-average (diluted fallback) — an APPROXIMATION of shares outstanding,
// disclosed in every consuming manifest.
const sharesSeries = income => (income || [])
  .map(r => ({ eff: Date.parse(r.acceptedDate || r.filingDate || r.date) + (r.acceptedDate || r.filingDate ? 0 : LAG), shares: r.weightedAverageShsOut ?? r.weightedAverageShsOutDil ?? null }))
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

// ── forward-outcome contract (fwd-outcome-v2) ────────────────────────────────
// The v1 fwdReturn conflated three different situations whenever the requested
// target bar ran past the cached series: a genuine delisting inside the horizon,
// an ACTIVE name whose outcome simply hasn't matured yet, and a stale/unknown
// series. That mislabeled recent active name-months as "delistings" (and let
// unmatured partial returns leak into labels). v2 makes the distinction explicit
// and fails closed on ambiguity.
const OUTCOME_POLICY_VERSION = 'fwd-outcome-v2';
// Canonical dataset known-good-through date. A name whose last bar is at/after
// (cutoff − grace) is treated as still trading; one whose last bar is more than
// DELIST_CONFIRM before it is confirmed to have stopped trading. The zone in
// between is ambiguous (free-feed lag vs a fresh delisting) → unresolved.
const DATA_CUTOFF_MS = Date.UTC(2026, 3, 1);          // 2026-04-01, same as secmaster
const PENDING_GRACE_DAYS = 10;                        // matches the asOfPriceAdv stale guard
const DELIST_CONFIRM_DAYS = 30;
const DELISTING_HAIRCUT = 0.30;                       // Shumway (1997) terminal penalty
const ENTRY_STALE_DAYS = 10;

const isoDate = ms => new Date(ms).toISOString().slice(0, 10);

// Full-provenance forward outcome over `bars` trading days from the bar at/just-
// before dateMs. ALWAYS returns an object; callers must branch on `status`:
//   mature     — the full horizon is observed; adjustedReturn === rawReturn.
//   delisted   — the name verifiably stopped trading inside the horizon;
//                rawReturn is the partial path, adjustedReturn applies the
//                delisting haircut. Usable as a label under the stated policy.
//   pending    — the name is still active and the horizon hasn't elapsed;
//                adjustedReturn is null. NEVER usable as a label.
//   unresolved — stale/ambiguous/unknown data; adjustedReturn is null. Fail closed.
function forwardOutcome(series, dateMs, bars, opts = {}) {
  const dataCutoffMs = opts.dataCutoffMs ?? DATA_CUTOFF_MS;
  const haircut = opts.delistingHaircut ?? DELISTING_HAIRCUT;
  const base = {
    status: 'unresolved', horizonBars: bars, observedBars: 0,
    entryDate: null, entryIndex: null, expectedExitIndex: null, expectedExitDate: null,
    actualExitDate: null, rawReturn: null, adjustedReturn: null, delistingAdjustment: null,
    reason: null, dataCutoff: isoDate(dataCutoffMs),
    securityMasterVersion: opts.securityMasterVersion ?? null,
    outcomePolicyVersion: OUTCOME_POLICY_VERSION,
  };
  if (!Array.isArray(series) || !series.length || !Number.isFinite(dateMs) || !(bars > 0)) {
    return { ...base, reason: 'invalid-input' };
  }
  const idx = idxAsOf(series, dateMs);
  if (idx < 0) return { ...base, reason: 'no-bar-at-or-before-date' };
  const entryBar = series[idx];
  if (!(entryBar.close > 0)) return { ...base, reason: 'non-positive-entry-price' };
  const entry = { ...base, entryDate: isoDate(entryBar.ms), entryIndex: idx, expectedExitIndex: idx + bars };
  if (dateMs - entryBar.ms > ENTRY_STALE_DAYS * DAY) {
    return { ...entry, reason: 'stale-entry-bar' };
  }
  const tgt = idx + bars;
  if (tgt < series.length) {
    const exitBar = series[tgt];
    if (!(exitBar.close > 0)) return { ...entry, reason: 'non-positive-exit-price' };
    const rawReturn = exitBar.close / entryBar.close - 1;
    return {
      ...entry, status: 'mature', observedBars: bars,
      expectedExitDate: isoDate(exitBar.ms), actualExitDate: isoDate(exitBar.ms),
      rawReturn, adjustedReturn: rawReturn, delistingAdjustment: 0, reason: 'horizon-observed',
    };
  }
  // Window runs past the cached series — decide WHY before touching the partial path.
  const lastBar = series[series.length - 1];
  const observedBars = (series.length - 1) - idx;
  if (observedBars <= 0) return { ...entry, reason: 'no-forward-bars' };
  if (!(lastBar.close > 0)) return { ...entry, observedBars, reason: 'non-positive-exit-price' };
  const rawReturn = lastBar.close / entryBar.close - 1;
  const partial = { ...entry, observedBars, actualExitDate: isoDate(lastBar.ms), rawReturn };
  const tailAgeDays = (dataCutoffMs - lastBar.ms) / DAY;
  if (tailAgeDays <= PENDING_GRACE_DAYS) {
    // Still trading at the data cutoff: the outcome simply hasn't matured.
    return { ...partial, status: 'pending', reason: 'horizon-not-elapsed' };
  }
  if (tailAgeDays >= DELIST_CONFIRM_DAYS) {
    // Confirmed stopped trading inside the horizon → genuine delisting.
    return {
      ...partial, status: 'delisted', delistingAdjustment: -haircut,
      adjustedReturn: (1 + rawReturn) * (1 - haircut) - 1, reason: 'stopped-trading-before-cutoff',
    };
  }
  return { ...partial, reason: 'stale-tail-ambiguous' };
}

// Legacy shape, now FAIL-CLOSED: only mature and verified-delisted outcomes
// produce a value; pending/unresolved return null (they are not labels).
// `ret` stays the RAW path return (v1 callers apply their own delisting rule);
// the full contract rides along as `.outcome`.
function fwdReturn(series, dateMs, bars, opts) {
  const o = forwardOutcome(series, dateMs, bars, opts);
  if (o.status === 'mature') return { ret: o.rawReturn, delistedWithin: false, status: o.status, outcome: o };
  if (o.status === 'delisted') return { ret: o.rawReturn, delistedWithin: true, status: o.status, outcome: o };
  return null;
}

function monthEnds(fromYM, toYM) {
  const out = []; let [y, m] = fromYM.split('-').map(Number); const [ty, tm] = toYM.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(Date.UTC(y, m, 0)); if (++m > 12) { m = 1; y++; } }
  return out;
}

module.exports = {
  DAY, LAG, CAP_LO, CAP_HI, ADV_FLOOR, CACHE,
  OUTCOME_POLICY_VERSION, DATA_CUTOFF_MS, PENDING_GRACE_DAYS, DELIST_CONFIRM_DAYS, DELISTING_HAIRCUT,
  fetchSymbol, sharesSeries, priceSeries, asOfShares, asOfPriceAdv, forwardOutcome, fwdReturn, monthEnds,
};

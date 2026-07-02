// SHORT INTEREST — high-SI soft-exclusion flag for the long screens.
//
// EVIDENCE (research/26-si + ALPHA-RESEARCH-2026-07 "Round 2"). On the survivorship-
// corrected rig (81,902 name-months), SI%shares is a SIGNIFICANT NEGATIVE cross-sectional
// predictor of fwd-63d return (monthly-mean rank-IC -0.061, t=-3.76) that SURVIVES the
// MAX/lottery control (residual IC -0.048). It is the only stat-sig NEW signal in the whole
// multi-session hunt — BUT it is a SHORT-SIDE predictor (the typical high-SI name
// underperforms; a few squeezes drag the mean up) and it INVERTED in the 2025 junk-bounce.
// So in this long-only app it is a SOFT, OPT-IN AVOIDANCE FLAG (sibling to a MAX/lottery
// exclusion) — a badge + an opt-in "hide high SI" filter — NOT a hard gate and NOT baked
// into the validated composite rankers.
//
// Data: FINRA consolidated short interest (free, no auth), semi-monthly, survivorship-safe
// (every name that existed at the settlement is reported). Latest settlement, cached.

const { readJSON, writeJSON, hasStore } = require('./store');

const SI_URL = 'https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest';
const PAGE = 5000;
const CACHE_KEY = 'si/latest.json';
const STALE_MS = 18 * 864e5;             // refresh when the cached settlement is >18d old (semi-monthly)

// Flag thresholds — conventional "crowded short" levels; the research says the EFFECT is
// cross-sectional so these are deliberately conservative (flag, don't over-flag).
const SI_HIGH_PCT = 0.20;                // short shares / shares-out >= 20% = high
const SI_ELEVATED_PCT = 0.10;            // >= 10% = elevated
const DTC_HIGH = 7;                       // days-to-cover >= 7 = crowded/squeeze-prone

let memo = null;                          // per-process cache {settlementDate, bySymbol}

async function post(body) {
  const res = await fetch(SI_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`FINRA http ${res.status}`);
  return res.json();
}

async function latestSettlementDate() {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
  // AAPL exists across the whole window → its recent settlements enumerate the schedule.
  const rows = await post({ limit: 20, fields: ['settlementDate'], compareFilters: [{ fieldName: 'symbolCode', fieldValue: 'AAPL', compareType: 'equal' }], dateRangeFilters: [{ fieldName: 'settlementDate', startDate: from, endDate: to }] });
  const dates = [...new Set(rows.map(r => r.settlementDate))].sort();
  return dates.at(-1) || null;
}

// Fetch the full consolidated SI for one settlement date, filtered to `universe` (a Set of
// symbols) to keep the payload small. Returns { SYMBOL: { si, dtc, adv } }.
async function fetchSettlement(date, universe) {
  const bySymbol = {};
  for (let offset = 0; ; offset += PAGE) {
    const rows = await post({ limit: PAGE, offset, fields: ['symbolCode', 'daysToCoverQuantity', 'currentShortPositionQuantity', 'averageDailyVolumeQuantity'], compareFilters: [{ fieldName: 'settlementDate', fieldValue: date, compareType: 'equal' }] });
    for (const r of rows) {
      const sym = r.symbolCode;
      if (universe && !universe.has(sym)) continue;
      bySymbol[sym] = { si: Number(r.currentShortPositionQuantity) || 0, dtc: Number(r.daysToCoverQuantity) || null, adv: Number(r.averageDailyVolumeQuantity) || null };
    }
    if (rows.length < PAGE) break;
  }
  return bySymbol;
}

// Latest short-interest lookup, cached (Blob + per-process). `universe` optional Set to
// shrink the payload. Degrades gracefully to null on any failure (flag simply absent).
async function fetchShortInterest(universe) {
  if (memo) return memo;
  let cache = null;
  if (hasStore()) { try { cache = await readJSON(CACHE_KEY, null); } catch {} }
  const fresh = cache && cache.settlementDate && (Date.now() - Date.parse(cache.fetchedAt || 0) < STALE_MS);
  if (fresh) { memo = cache; return cache; }
  try {
    const date = await latestSettlementDate();
    if (!date) return cache || null;                    // keep stale over nothing
    if (cache && cache.settlementDate === date && cache.bySymbol) { memo = cache; return cache; }
    const bySymbol = await fetchSettlement(date, universe);
    const out = { settlementDate: date, fetchedAt: new Date().toISOString(), bySymbol };
    if (hasStore()) { try { await writeJSON(CACHE_KEY, out, 0); } catch {} }
    memo = out; return out;
  } catch { return cache || null; }
}

// Pure: build the flag for one name. `sharesOut` (absolute share count) enables SI%shares
// (the strong signal); DTC is the always-available fallback. Returns null when nothing known.
function siFlag(rec, sharesOut) {
  if (!rec) return null;
  const pct = (sharesOut > 0 && rec.si > 0) ? rec.si / sharesOut : null;
  const dtc = Number.isFinite(rec.dtc) ? rec.dtc : null;
  if (pct == null && dtc == null) return null;
  let level = null;
  if ((pct != null && pct >= SI_HIGH_PCT) || (dtc != null && dtc >= DTC_HIGH)) level = 'high';
  else if (pct != null && pct >= SI_ELEVATED_PCT) level = 'elevated';
  return {
    pct: pct != null ? +(pct * 100).toFixed(1) : null,   // percent, 1dp
    dtc: dtc != null ? +dtc.toFixed(1) : null,
    level,                                                // 'high' | 'elevated' | null
  };
}

function _resetMemo() { memo = null; }   // test hook

module.exports = { fetchShortInterest, siFlag, SI_HIGH_PCT, SI_ELEVATED_PCT, DTC_HIGH, _resetMemo };

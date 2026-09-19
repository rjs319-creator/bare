'use strict';

// Point-in-time CFTC Traders-in-Financial-Futures (TFF) features for research.
// Anti-leakage contract: positions are OBSERVED on the Tuesday report date but only
// PUBLISHED ~Friday, so a report may inform a prediction only from report date + 4
// calendar days. asOfJoin() is the single joining door and enforces it.

const AVAILABILITY_LAG_DAYS = 4;
const Z_SHORT_WEEKS = 52;
const Z_LONG_WEEKS = 156;
const EXTREME_Z = 1.5;
const CHG_WEEKS = 4;

const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

function availableDate(reportDate) {
  const t = Date.parse(`${reportDate}T00:00:00Z`);
  return new Date(t + AVAILABILITY_LAG_DAYS * 864e5).toISOString().slice(0, 10);
}

// Socrata rows → Map(contractCode → {code, name, rows[]}) with ascending dates and
// validated numerics. Rows without positive open interest are unusable and dropped.
function parseCotRows(rawRows) {
  const out = new Map();
  for (const r of rawRows || []) {
    const code = r.cftc_contract_market_code;
    const date = String(r.report_date_as_yyyy_mm_dd || '').slice(0, 10);
    const oi = num(r.open_interest_all);
    if (!code || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !(oi > 0)) continue;
    const row = {
      date, oi,
      lev: { long: num(r.lev_money_positions_long), short: num(r.lev_money_positions_short) },
      assetMgr: { long: num(r.asset_mgr_positions_long), short: num(r.asset_mgr_positions_short) },
      dealer: { long: num(r.dealer_positions_long_all), short: num(r.dealer_positions_short_all) },
    };
    if (!out.has(code)) out.set(code, { code, name: r.contract_market_name, rows: [] });
    out.get(code).rows.push(row);
  }
  for (const s of out.values()) s.rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

function categoryFeatures(netOiSeries, i, zShort, zLong) {
  const cur = netOiSeries[i];
  if (cur == null) return null;
  const back = (k) => (i - k >= 0 ? netOiSeries[i - k] : null);
  const zOf = (weeks) => {
    if (i + 1 < weeks) return null;
    const win = netOiSeries.slice(i + 1 - weeks, i + 1).filter(Number.isFinite);
    if (win.length < Math.floor(weeks * 0.9)) return null;
    const m = mean(win);
    const sd = Math.sqrt(mean(win.map(x => (x - m) ** 2)) || 0);
    return sd > 1e-12 ? (cur - m) / sd : 0;
  };
  const pctileOf = (weeks) => {
    if (i + 1 < weeks) return null;
    const win = netOiSeries.slice(i + 1 - weeks, i + 1).filter(Number.isFinite);
    return win.length ? win.filter(x => x <= cur).length / win.length : null;
  };
  const z52 = zOf(zShort), z156 = zOf(zLong);
  const chg1w = back(1) != null ? cur - back(1) : null;
  const chg4w = back(CHG_WEEKS) != null ? cur - back(CHG_WEEKS) : null;
  const extremeLong = z52 != null && z52 > EXTREME_Z;
  const extremeShort = z52 != null && z52 < -EXTREME_Z;
  return {
    netOi: cur, chg1w, chg4w, z52, z156, pctile: pctileOf(zLong) ?? pctileOf(zShort),
    extremeLong, extremeShort,
    crowdingReversal: (extremeLong && chg4w != null && chg4w < 0)
      || (extremeShort && chg4w != null && chg4w > 0),
  };
}

// One market's parsed series → weekly feature rows with availability stamps.
function cotFeatureSeries(series, { zShort = Z_SHORT_WEEKS, zLong = Z_LONG_WEEKS } = {}) {
  const rows = (series && series.rows) || [];
  const netOf = (cat) => rows.map(r =>
    (r[cat].long != null && r[cat].short != null && r.oi > 0) ? (r[cat].long - r[cat].short) / r.oi : null);
  const nets = { lev: netOf('lev'), assetMgr: netOf('assetMgr'), dealer: netOf('dealer') };
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    out.push({
      reportDate: rows[i].date,
      availableDate: availableDate(rows[i].date),
      lev: categoryFeatures(nets.lev, i, zShort, zLong),
      assetMgr: categoryFeatures(nets.assetMgr, i, zShort, zLong),
      dealer: categoryFeatures(nets.dealer, i, zShort, zLong),
    });
  }
  return out;
}

// The ONLY legal join: latest feature row whose availableDate <= asOf. Null when
// nothing has been published yet — callers must treat null as unknown, not neutral.
function asOfJoin(featureRows, asOf) {
  let best = null;
  for (const f of featureRows || []) {
    if (f.availableDate <= asOf && (!best || f.reportDate > best.reportDate)) best = f;
  }
  return best;
}

module.exports = {
  AVAILABILITY_LAG_DAYS, EXTREME_Z,
  availableDate, parseCotRows, cotFeatureSeries, asOfJoin,
};

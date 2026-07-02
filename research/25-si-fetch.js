'use strict';
// Step 25 — fetch FINRA consolidated short interest (free, no auth) → disk cache.
//   node research/25-si-fetch.js
//
// Pulls one reading per calendar month (the last semi-monthly settlement <= month end)
// over 2021-2025 for the WHOLE US equity tape (~19.5k rows/date, 5000/page). Stores
// {settlementDate -> {SYMBOL: {dtc, si, adv}}} in data/short-interest.json. Survivorship-
// safe by construction: FINRA reports every name that existed AT that settlement,
// including ones later delisted.

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'data', 'short-interest.json');
const URL = 'https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest';
const PAGE = 5000;

async function post(body) {
  const res = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}

async function allDates() {
  // AAPL exists across the whole window → its settlement dates enumerate the schedule
  const rows = await post({ limit: 300, fields: ['settlementDate'], compareFilters: [{ fieldName: 'symbolCode', fieldValue: 'AAPL', compareType: 'equal' }], dateRangeFilters: [{ fieldName: 'settlementDate', startDate: '2021-01-01', endDate: '2025-12-31' }] });
  return [...new Set(rows.map(r => r.settlementDate))].sort();
}

async function fetchDate(date) {
  const out = {};
  for (let offset = 0; ; offset += PAGE) {
    const rows = await post({ limit: PAGE, offset, fields: ['symbolCode', 'daysToCoverQuantity', 'currentShortPositionQuantity', 'averageDailyVolumeQuantity'], compareFilters: [{ fieldName: 'settlementDate', fieldValue: date, compareType: 'equal' }] });
    for (const r of rows) out[r.symbolCode] = { dtc: r.daysToCoverQuantity, si: r.currentShortPositionQuantity, adv: r.averageDailyVolumeQuantity };
    if (rows.length < PAGE) break;
  }
  return out;
}

(async () => {
  const cache = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { generatedAt: null, byDate: {} };
  const dates = await allDates();
  console.log(`${dates.length} settlement dates 2021-2025.`);
  // one reading per month = the last settlement in each YYYY-MM
  const monthLast = {};
  for (const d of dates) { const ym = d.slice(0, 7); if (!monthLast[ym] || d > monthLast[ym]) monthLast[ym] = d; }
  const targets = Object.values(monthLast).sort();
  console.log(`pulling ${targets.length} month-end settlements…`);
  let done = 0;
  for (const d of targets) {
    if (cache.byDate[d]) { done++; continue; }
    try {
      const rows = await fetchDate(d);
      cache.byDate[d] = rows;
      fs.writeFileSync(OUT, JSON.stringify(cache));
      process.stdout.write(`  ${d}: ${Object.keys(rows).length} names  (${++done}/${targets.length})\n`);
    } catch (e) { console.log(`  ${d}: ERROR ${e.message}`); }
  }
  cache.generatedAt = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(cache));
  console.log(`Saved ${Object.keys(cache.byDate).length} settlement dates to ${OUT}`);
})();

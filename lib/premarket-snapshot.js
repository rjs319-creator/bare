'use strict';
// PREMARKET SNAPSHOT — "what has printed before the open" for a list of names, in a few
// bulk-quote requests, with an honest coverage report.
//
// Contract (other modules code against it — keep the shapes exact):
//   fetchPremarketSnapshot(tickers, { deps, now }) →
//     { asOf, session, rows:[{ ticker, prevClose, price, preMarketPrice, preMarketChangePct,
//                              preMarketVolume, postMarketPrice, postMarketChangePct,
//                              avgVolume, preRelVol, marketState }],
//       coverage:{ requested, returned, provider, degraded } }
//   premarketGapLane(rows, { minAbsGapPct = 3, minPreRelVol = 0.05, minAvgVolume = 300000 })
//     → [{ ticker, gapPct, preRelVol, direction:'up'|'down', prevClose, preMarketPrice }]
//       sorted by |gapPct| descending.
//
// Rules:
//   • `preRelVol` is premarket volume over the FULL-DAY 3-month average volume, labelled as
//     such. Premarket participation is never paced against the regular-hours volume curve —
//     0.05 means "5% of a normal day's volume has already printed before the open", which is
//     a lot; it is not "5% of expected".
//   • `preMarketChangePct` is the venue's own figure when present, otherwise derived from
//     preMarketPrice / prevClose. A row with no premarket print keeps nulls — "no print" is
//     information, and the gap lane skips such rows rather than reading yesterday's close as
//     a 0% gap.
//   • Never throws on provider failure: rows:[] with coverage.degraded:true and a reason.
const MS = require('./market-session');

const CHUNK = 500;   // fetchBulkQuotes chunks internally; this bounds one call's request list

const r2 = x => (Number.isFinite(x) ? +x.toFixed(2) : null);
const r4 = x => (Number.isFinite(x) ? +x.toFixed(4) : null);

function mapRow(q) {
  const prevClose = Number.isFinite(q.prevClose) ? q.prevClose : null;
  const pre = Number.isFinite(q.preMarketPrice) && q.preMarketPrice > 0 ? q.preMarketPrice : null;
  const preVol = Number.isFinite(q.preMarketVolume) ? q.preMarketVolume : null;
  const avgVolume = Number.isFinite(q.avgVolume) && q.avgVolume > 0 ? q.avgVolume : null;
  const venuePct = Number.isFinite(q.preMarketChangePct) ? q.preMarketChangePct : null;
  const derivedPct = pre != null && prevClose > 0 ? ((pre / prevClose) - 1) * 100 : null;
  return {
    ticker: q.ticker,
    prevClose,
    price: Number.isFinite(q.price) ? q.price : null,
    preMarketPrice: pre,
    preMarketChangePct: pre != null ? r2(venuePct != null ? venuePct : derivedPct) : null,
    preMarketVolume: preVol,
    postMarketPrice: Number.isFinite(q.postMarketPrice) && q.postMarketPrice > 0 ? q.postMarketPrice : null,
    postMarketChangePct: r2(Number.isFinite(q.postMarketChangePct) ? q.postMarketChangePct : NaN),
    avgVolume,
    preRelVol: preVol != null && avgVolume != null ? r4(preVol / avgVolume) : null,
    marketState: q.marketState || null,
  };
}

async function fetchPremarketSnapshot(tickers, { deps = {}, now = new Date() } = {}) {
  const fetchBulkQuotes = deps.fetchBulkQuotes || require('./quote-provider').fetchBulkQuotes;
  const wanted = [...new Set((tickers || []).map(t => String(t || '').trim().toUpperCase()).filter(Boolean))];
  const session = MS.sessionInfoAt(now).marketSession;
  const asOf = new Date(now).toISOString();
  if (!wanted.length) {
    return { asOf, session, rows: [], coverage: { requested: 0, returned: 0, provider: null, degraded: false } };
  }
  const rows = [];
  let provider = null, degraded = false, reason = null, volumeAvailable = null;
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const part = wanted.slice(i, i + CHUNK);
    try {
      const bulk = await fetchBulkQuotes(part);
      for (const q of (bulk && bulk.rows) || []) if (q && q.ticker) rows.push(mapRow(q));
      const cov = (bulk && bulk.coverage) || {};
      provider = provider && cov.provider && provider !== cov.provider ? 'mixed' : (cov.provider || provider);
      if (cov.degraded) degraded = true;
      if (cov.volumeAvailable != null) volumeAvailable = volumeAvailable === false ? false : !!cov.volumeAvailable;
    } catch (e) {
      degraded = true;
      reason = String((e && e.message) || e);
    }
  }
  const withPrint = rows.filter(r => r.preMarketPrice != null).length;
  return {
    asOf, session, rows,
    coverage: {
      requested: wanted.length, returned: rows.length, provider, degraded,
      premarketPrints: withPrint,
      volumeAvailable,
      reason,
      note: 'preRelVol = premarket volume / full-day 3-month average volume (never paced to the regular-hours curve).',
    },
  };
}

// Pure. Names with a real premarket print, a meaningful gap and SOME premarket participation.
function premarketGapLane(rows, { minAbsGapPct = 3, minPreRelVol = 0.05, minAvgVolume = 300000 } = {}) {
  const out = [];
  for (const r of rows || []) {
    if (!r || r.preMarketPrice == null || !(r.prevClose > 0)) continue;
    if (!(r.avgVolume >= minAvgVolume)) continue;
    if (!(r.preRelVol >= minPreRelVol)) continue;
    const gapPct = r2(((r.preMarketPrice / r.prevClose) - 1) * 100);
    if (gapPct == null || Math.abs(gapPct) < minAbsGapPct) continue;
    out.push({ ticker: r.ticker, gapPct, preRelVol: r.preRelVol, direction: gapPct > 0 ? 'up' : 'down', prevClose: r.prevClose, preMarketPrice: r.preMarketPrice });
  }
  return out.sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct) || a.ticker.localeCompare(b.ticker));
}

module.exports = { fetchPremarketSnapshot, premarketGapLane, mapRow };

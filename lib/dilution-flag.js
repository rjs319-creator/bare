'use strict';
// 424B5 DILUTION FLAG — SHADOW research overlay (weight 0, display + ledger only).
//
// The finding this operationalises (research/95-dilution-events.js, registry id
// dilution-events-2026-08): stocks that file a 424B5 prospectus supplement (follow-on /
// ATM / shelf takedown — new-share supply) lagged SPY by ~1% over the next 5 sessions
// and ~2-4.5% (median) over the next quarter, on 1,722 events 2021-2026, all cells
// surviving BH FDR, placebo-controlled and skew-robust. EDGAR filing dates are immutable
// public record, so the live flag's event clock is genuinely point-in-time.
//
// WHAT THIS IS NOT. It is an AVOID characteristic under prospective validation — not a
// sell signal, not a short signal (borrow reality untested), and it must never remove a
// name from a book, gate a rank, or size anything until the prospective ledger matures
// (>= 50 resolved decision dates) AND a manual registry change promotes it. Until then
// it renders as a labeled research badge and accrues its ledger. Nothing else.

const FROZEN = Object.freeze({
  version: 'dilution-flag-v1',
  form: '424B5',
  // The research measured 5/21/63-session horizons; the live flag window approximates the
  // 63-session cell in calendar time. Frozen here — do not tune against the ledger.
  flagWindowDays: 91,
  freshDays: 8,                 // ≈ the 5-session cell — the strongest, q = 0.0002
  prospectiveGate: { minResolvedDates: 50, note: 'then formal date-clustered eval + manual registry change; the flag stays shadow until both' },
  experimentId: 'dilution-events-2026-08',
});

const FTS = 'https://efts.sec.gov/LATEST/search-index';
const UA = 'market-news-app dilution-flag rjs319@gmail.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One EDGAR full-text-search hit → {ticker, cik, fileDate, adsh} or null. The ticker is
// parsed from display_names ("RadNet, Inc.  (RDNT)  (CIK 0000790526)"); dots become
// dashes to match the app's symbol convention (BRK.B → BRK-B).
function parseHit(hit) {
  const s = (hit && hit._source) || {};
  if (!s.file_date || !s.adsh) return null;
  const m = /\(([A-Z][A-Z.\-]{0,7})\)\s*\(CIK/.exec((s.display_names || [])[0] || '');
  if (!m) return null;
  return { ticker: m[1].replace(/\./g, '-'), cik: (s.ciks || [])[0] || null, fileDate: s.file_date, adsh: s.adsh };
}

// Fetch every 424B5 filed in the trailing `days` calendar days, in ≤14-day windows with
// pagination. Throws on an exhausted window (the caller fails closed — a partial snapshot
// silently missing a week of filings would read as "no dilution", which is worse than none).
async function fetchRecentFilings({ days = FROZEN.flagWindowDays + 7, now = Date.now(), fetchImpl = fetch } = {}) {
  const out = [];
  let start = new Date(now - days * 864e5);
  const end = new Date(now);
  while (start < end) {
    const stop = new Date(Math.min(end.getTime(), start.getTime() + 13 * 864e5));
    const sd = start.toISOString().slice(0, 10), ed = stop.toISOString().slice(0, 10);
    for (let from = 0; from < 10000; from += 100) {
      const url = `${FTS}?q=&forms=${FROZEN.form}&dateRange=custom&startdt=${sd}&enddt=${ed}&from=${from}&size=100`;
      let j = null;
      for (let attempt = 0; attempt < 3 && !j; attempt++) {
        try { const r = await fetchImpl(url, { headers: { 'user-agent': UA } }); if (r.ok) j = await r.json(); else await sleep(700 * (attempt + 1)); }
        catch { await sleep(700 * (attempt + 1)); }
      }
      if (!j) throw new Error(`EDGAR window ${sd}..${ed} failed after retries`);
      const hits = (j.hits && j.hits.hits) || [];
      for (const h of hits) { const p = parseHit(h); if (p) out.push(p); }
      if (hits.length < 100) break;
      await sleep(150);
    }
    start = new Date(stop.getTime() + 864e5);
    await sleep(150);
  }
  return out;
}

// Filings → per-symbol flag map, window/freshness applied at `asOf` (YYYY-MM-DD).
// A symbol is flagged while its most recent 424B5 is within flagWindowDays; `fresh`
// marks the freshDays sub-window the research found strongest.
function buildFlagSet(filings, asOf) {
  const asOfMs = Date.parse(asOf);
  const symbols = {};
  for (const f of filings || []) {
    if (!f || !f.ticker || !f.fileDate) continue;
    const age = Math.floor((asOfMs - Date.parse(f.fileDate)) / 864e5);
    if (!Number.isFinite(age) || age < 0 || age > FROZEN.flagWindowDays) continue;
    const cur = symbols[f.ticker];
    if (!cur || f.fileDate > cur.lastFiled) {
      symbols[f.ticker] = { lastFiled: f.fileDate, ageDays: age, fresh: age <= FROZEN.freshDays, filings: (cur ? cur.filings : 0) + 1 };
    } else {
      cur.filings += 1;
    }
  }
  const list = Object.values(symbols);
  return {
    version: FROZEN.version, asOf, symbols,
    counts: { flagged: list.length, fresh: list.filter((s) => s.fresh).length },
  };
}

module.exports = { FROZEN, parseHit, fetchRecentFilings, buildFlagSet };

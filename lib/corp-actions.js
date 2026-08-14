'use strict';
// CORPORATE ACTIONS — ex-dividend and split calendar, for the options false-positive ledger.
//
// WHY THIS EXISTS. `lib/options-hypotheses-v2` catalogues eight benign explanations for
// unusual options activity. Seven can be tested from the chain itself. The eighth —
// "a dividend, split, or other corporate action mechanically drove this" — needs a
// calendar, and without one it returned UNRESOLVED on EVERY event. Since only actively
// REFUTED hypotheses count as ruled out, that single missing feed was quietly holding
// down the evidence strength of every options read.
//
// Dividend capture is the specific mechanism: deep-ITM calls on a high-yield name get
// exercised early around the ex-date, which shows up as a volume spike that looks
// nothing like a directional bet. Split-adjustment flow does the same around a split.
//
// Both come from ONE calendar call each per scan (date-ranged, not per-ticker), so the
// cost is two requests regardless of universe size.
//
// Goes through lib/fmp-client, which already distinguishes `plan-gated` (401/402/403)
// from a transport failure. That distinction matters here: "your plan does not include
// this" is a permanent answer that should be reported as such, not retried forever or
// mistaken for "no corporate actions exist".
//
// Pure apart from the injected request function.

const { fmpRequest, CATEGORY } = require('./fmp-client');

const CORP_ACTIONS_VERSION = 'corp-actions-v1';

// FMP stable calendar endpoints. Date-ranged, all symbols in one response.
const DIVIDEND_PATH = 'dividends-calendar';
const SPLIT_PATH = 'splits-calendar';

const LOOKAHEAD_DAYS = 30;   // far enough to cover any near-dated option's expiry
const LOOKBACK_DAYS = 5;     // a just-passed ex-date still explains today's volume

const unavailable = (reason, category = null) => ({ available: false, reason: String(reason), category });
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);

/** Normalize one calendar row to { symbol, date }. Vendors vary the field names. */
function rowOf(r, kind) {
  if (!r || typeof r !== 'object') return null;
  const symbol = r.symbol || r.ticker;
  const date = kind === 'dividend'
    ? (r.date || r.exDate || r.exDividendDate || r.recordDate)
    : (r.date || r.splitDate);
  if (!symbol || !date) return null;
  const d = String(date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  return { symbol: String(symbol).toUpperCase(), date: d };
}

/**
 * Fetch one calendar. Returns { available, byTicker: Map<symbol, [dates]> } or an
 * explicit unavailable carrying the client's category. Never throws.
 */
async function fetchCalendar(path, kind, { from, to, requestImpl = fmpRequest, apiKey } = {}) {
  const r = await requestImpl(path, { from, to }, apiKey ? { apiKey } : {});
  if (!r || !r.ok) {
    const cat = r ? r.category : 'unknown';
    const why = cat === CATEGORY.NO_KEY ? 'FMP_API_KEY is not configured'
      : cat === CATEGORY.PLAN_GATED ? `the ${kind} calendar is not included in the current FMP plan (permanent — not a transient failure)`
        : cat === CATEGORY.NOT_FOUND ? `FMP has no ${kind} calendar at ${path}`
          : `FMP ${kind} calendar request failed (${cat})`;
    return unavailable(why, cat);
  }
  const rows = Array.isArray(r.body) ? r.body : (r.body && Array.isArray(r.body.data) ? r.body.data : null);
  if (!rows) return unavailable(`FMP ${kind} calendar returned an unexpected shape`, 'invalid-shape');
  const byTicker = new Map();
  for (const raw of rows) {
    const row = rowOf(raw, kind);
    if (!row) continue;
    if (!byTicker.has(row.symbol)) byTicker.set(row.symbol, []);
    byTicker.get(row.symbol).push(row.date);
  }
  for (const dates of byTicker.values()) dates.sort();
  return { available: true, byTicker, rows: rows.length, tickers: byTicker.size };
}

/**
 * Build the corporate-action index for a scan. Two calls total. Pure apart from the
 * injected request function.
 *
 * Returns { index, diagnostics }. `index` is a Map<ticker, corpAction-shaped object>
 * consumable directly by options-hypotheses-v2. A ticker with no action gets an entry
 * with null dates — which is what lets the hypothesis be actively REFUTED rather than
 * left open. That asymmetry is the whole value of this feed.
 */
async function buildCorpActionIndex({ tickers = [], now = Date.now(), requestImpl = fmpRequest, apiKey } = {}) {
  const from = isoDay(now - LOOKBACK_DAYS * 86_400_000);
  const to = isoDay(now + LOOKAHEAD_DAYS * 86_400_000);

  const [div, split] = await Promise.all([
    fetchCalendar(DIVIDEND_PATH, 'dividend', { from, to, requestImpl, apiKey }),
    fetchCalendar(SPLIT_PATH, 'split', { from, to, requestImpl, apiKey }),
  ]);

  // If NEITHER calendar resolved, the index is null: every hypothesis stays UNRESOLVED
  // with its existing reason. A half-index is still useful (a known ex-date refutes
  // nothing but confirms plenty), so one working calendar is enough to proceed.
  if (!div.available && !split.available) {
    return {
      index: null,
      diagnostics: {
        version: CORP_ACTIONS_VERSION, available: false, from, to,
        dividend: { available: false, reason: div.reason, category: div.category },
        split: { available: false, reason: split.reason, category: split.category },
        reason: 'no corporate-action calendar could be fetched — the corpAction hypothesis stays UNRESOLVED for every event',
      },
    };
  }

  const today = isoDay(now);
  const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
  const nextOnOrAfter = dates => (dates || []).find(d => daysBetween(today, d) >= -LOOKBACK_DAYS) || null;

  const index = new Map();
  for (const t of [...new Set((tickers || []).map(x => String(x).toUpperCase()))]) {
    const exDiv = div.available ? nextOnOrAfter(div.byTicker.get(t)) : null;
    const spl = split.available ? nextOnOrAfter(split.byTicker.get(t)) : null;
    const nearest = [exDiv, spl].filter(Boolean).sort()[0] || null;
    index.set(t, {
      exDivDate: exDiv,
      splitDate: spl,
      daysUntil: nearest ? daysBetween(today, nearest) : null,
      // Which calendars actually answered for this ticker. A null date from a calendar
      // that FAILED is not the same claim as a null from one that returned cleanly, and
      // the hypothesis layer needs to be able to tell them apart.
      coverage: { dividend: div.available, split: split.available },
    });
  }

  return {
    index,
    diagnostics: {
      version: CORP_ACTIONS_VERSION,
      available: true,
      from, to,
      window: { lookbackDays: LOOKBACK_DAYS, lookaheadDays: LOOKAHEAD_DAYS },
      dividend: div.available ? { available: true, rows: div.rows, tickers: div.tickers } : { available: false, reason: div.reason, category: div.category },
      split: split.available ? { available: true, rows: split.rows, tickers: split.tickers } : { available: false, reason: split.reason, category: split.category },
      tickersIndexed: index.size,
      withAction: [...index.values()].filter(v => v.exDivDate || v.splitDate).length,
      partial: !(div.available && split.available),
      partialNote: !(div.available && split.available)
        ? 'Only one calendar resolved. Tickers can still be CONFIRMED against it, but cannot be fully refuted, so the hypothesis stays open where that calendar is silent.'
        : null,
    },
  };
}

module.exports = {
  CORP_ACTIONS_VERSION, DIVIDEND_PATH, SPLIT_PATH, LOOKAHEAD_DAYS, LOOKBACK_DAYS,
  buildCorpActionIndex, fetchCalendar, rowOf,
};

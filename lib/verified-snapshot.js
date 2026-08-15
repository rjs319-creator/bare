'use strict';
// VERIFIED MARKET SNAPSHOT — deterministic, LLM-free ground truth for prompt injection.
//
// The Game Plan LLM is asked for "levels to watch" and market predictions, but its
// prompt carried no verified price data at all — every numeric index/level claim was
// parametric memory, i.e. a confabulation waiting to render. This module computes a
// compact snapshot (last close, 1d/5d/20d %, distance from the 3-month high/low) from
// exchange candles and renders it with an explicit source-of-truth contract: flag a
// discrepancy, never invent a reconciled number; cite no level the table can't derive.
//
// Integrity rules (shared app discipline):
//   • STALE REFUSAL — a frame whose latest bar is more than MAX_STALE_DAYS calendar
//     days old renders the anti-fabrication sentinel, never stale numbers;
//   • EMPTY ⇒ SENTINEL — a missing/empty frame renders the sentinel too, so an LLM
//     is never left with a mandate its data can't satisfy (it would fabricate).
//
// Pure: candles in, strings out. Callers own all IO.

const MAX_STALE_DAYS = 5;            // calendar days before a frame is refused as stale
const LOOKBACK_HI_LO_SESSIONS = 63;  // ~3 months of sessions for the high/low reference

const NO_DATA_SENTINEL = 'DATA UNAVAILABLE — do not estimate or fabricate values for this symbol.';

const r2 = (n) => Math.round(n * 100) / 100;
const pct = (a, b) => r2(((a - b) / b) * 100);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);

/**
 * Compute one symbol's snapshot row from daily candles ({date, close, high, low}).
 * `completedThrough` (optional, ET date of the last fully completed regular session —
 * lib/market-session lastCompletedRegularSession) drops any newer bar so a mid-session
 * FORMING bar is never rendered as a verified close: this block is cached into the
 * day's plan under a source-of-truth banner, exactly where a moving intraday print
 * would do the most damage.
 * Returns { ok:true, ... } or { ok:false, reason } (missing/empty/stale/bad data).
 * Pure.
 */
function snapshotRow(candles, asOfDate, completedThrough) {
  if (!Array.isArray(candles) || !candles.length) return { ok: false, reason: 'no-data' };
  const rows = candles.filter((c) => c && c.date && c.close > 0 && (!completedThrough || c.date <= completedThrough));
  if (!rows.length) return { ok: false, reason: 'no-data' };
  const last = rows[rows.length - 1];
  if (asOfDate && daysBetween(last.date, asOfDate) > MAX_STALE_DAYS) {
    return { ok: false, reason: `stale (latest bar ${last.date})` };
  }
  const at = (back) => (rows.length > back ? rows[rows.length - 1 - back].close : null);
  const win = rows.slice(-LOOKBACK_HI_LO_SESSIONS);
  const hi = Math.max(...win.map((c) => (c.high > 0 ? c.high : c.close)));
  const lo = Math.min(...win.map((c) => (c.low > 0 ? c.low : c.close)));
  return {
    ok: true,
    date: last.date,
    close: r2(last.close),
    d1: at(1) != null ? pct(last.close, at(1)) : null,
    d5: at(5) != null ? pct(last.close, at(5)) : null,
    d20: at(20) != null ? pct(last.close, at(20)) : null,
    hi3m: r2(hi), lo3m: r2(lo),
    fromHi3mPct: pct(last.close, hi),
    fromLo3mPct: pct(last.close, lo),
  };
}

const fmtPct = (v) => (v == null ? 'n/a' : `${v > 0 ? '+' : ''}${v}%`);

function rowLine(sym, row) {
  if (!row || !row.ok) return `- ${sym}: ${NO_DATA_SENTINEL}${row && row.reason ? ` [${row.reason}]` : ''}`;
  return `- ${sym}: close ${row.close} (${row.date}) | 1d ${fmtPct(row.d1)} · 5d ${fmtPct(row.d5)} · 20d ${fmtPct(row.d20)} | 3-month range ${row.lo3m}–${row.hi3m} (${fmtPct(row.fromHi3mPct)} from high, ${fmtPct(row.fromLo3mPct)} from low)`;
}

/**
 * Render the full prompt block from { SYMBOL: candles } (order preserved).
 * Always renders one line per requested symbol — sentinel lines included — so the
 * model can never mistake a fetch failure for "nothing notable". Pure.
 */
function snapshotBlock(candlesBySymbol, asOfDate, completedThrough) {
  const symbols = Object.keys(candlesBySymbol || {});
  if (!symbols.length) return '';
  const lines = symbols.map((s) => rowLine(s, snapshotRow(candlesBySymbol[s], asOfDate, completedThrough)));
  return [
    'VERIFIED MARKET SNAPSHOT (deterministic, computed from exchange data — the ONLY source of truth for exact index prices and levels. If another input conflicts with this table, flag the discrepancy; do not invent a reconciled number. Do not cite numeric price levels that cannot be derived from this table):',
    ...lines,
  ].join('\n');
}

/**
 * Compact prediction-market probabilities line for prompt injection: the top open
 * event markets by heat with market-implied probability and ~1-DAY odds drift (Kalshi
 * previous trade / Polymarket oneDayPriceChange — a day's move, never a week's).
 * Honesty guards: prob must be strictly inside (0,1) — an upstream num() coercion of
 * a missing price to 0 must not render as a confident "0%"; drift renders only when
 * probPrev is a real prior trade (probPrev > 0), so a first-traded-today market can't
 * show a fabricated N-point swing; one line per Kalshi series, so an index strike
 * ladder can't fill the whole block. Framed as crowd positioning, never an edge.
 * Empty string when nothing usable. Pure.
 */
function predMarketsLine(scoredMarkets, { top = 5 } = {}) {
  const seenSeries = new Set();
  const rows = [];
  for (const m of scoredMarkets || []) {
    if (!m || !m.title || !(m.prob > 0 && m.prob < 1)) continue;
    const key = m.venue === 'Kalshi' ? (m.group || m.id) : m.id;
    if (seenSeries.has(key)) continue;
    seenSeries.add(key);
    rows.push(m);
    if (rows.length >= top) break;
  }
  if (!rows.length) return '';
  const one = (m) => {
    const p = Math.round(m.prob * 100);
    const hasPrior = m.probPrev > 0;
    const drift = hasPrior && m.movePts != null && m.movePts >= 1
      ? ` (${m.prob >= m.probPrev ? '↑' : '↓'}${Math.round(m.movePts)}pts/1d)` : '';
    return `"${String(m.title).slice(0, 80)}" ${p}%${drift}`;
  };
  return `Event probabilities (prediction markets, market-implied crowd odds — positioning context, NOT an edge and NOT a forecast endorsement): ${rows.map(one).join('; ')}.`;
}

module.exports = {
  MAX_STALE_DAYS, LOOKBACK_HI_LO_SESSIONS, NO_DATA_SENTINEL,
  snapshotRow, snapshotBlock, predMarketsLine,
};

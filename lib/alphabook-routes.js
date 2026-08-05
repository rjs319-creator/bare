'use strict';
// COMPOSITE ALPHA BOOK (composite-book-v1) — op=alphabook, PUBLIC read.
//
// The portfolio-level reframe: no single surviving signal clears per-signal
// significance, but a book of INDIVIDUALLY-WEAK, MUTUALLY-UNCORRELATED sleeves
// can clear portfolio-level gates honestly — and pooling events across sleeves
// reaches a testable sample months sooner than any sleeve alone. This route is
// a TRACK-RECORD READ over ledgers that were logged live (PIT by construction);
// it never scores, ranks, or moves a live pick.
//
// FROZEN SLEEVES (v1 — registry `composite-book-v1` is the authority):
//   CERN    — forced-flow decisions from the live engine state, first-appearance
//             deduped, logOnly types EXCLUDED (they are archive-only by design),
//             graded at each type's own horizon.
//   DOWNDAY — red-tape V-reversal bounce picks, already resolved by the tick
//             (3-session SPY-excess, long-only).
// GAPGO-TAKE joins as book-v2 once its verified ledger matures — a NEW
// registration, not an edit to this one.
//
// Excess convention (comment-audited): forwardReturn() already sign-flips
// shorts (positive = profitable). Long alpha = fwd − spy. Short alpha is the
// symmetric market-neutral read (short stock / short benchmark): spy − stock
// = fwd + spy.
const { readCern, readAllDownDays, hasStore } = require('./store');
const { cernPicksFrom, forwardReturn, spyForwardReturn } = require('./apex-routes');
const { EVENT_TYPES } = require('./cern');
const { fetchDailyHistory } = require('./screener');

const BOOK_VERSION = 'composite-book-v1';
const REGISTERED_AFTER = '2026-08-05';          // the prospective boundary in the registry entry

const wilsonLo = (wins, n, z = 1.2816) => {     // 90% one-sided lower bound, matching the program's other books
  if (!n) return 0;
  const p = wins / n, z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
};
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const tOf = (a) => (a.length > 2 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : null);
const r2 = (x) => (x == null ? null : +x.toFixed(2));

function summarize(rows) {
  const alphas = rows.map((r) => r.alpha).filter((x) => x != null);
  const wins = alphas.filter((x) => x > 0).length;
  return {
    n: rows.length, resolved: alphas.length,
    beatRate: alphas.length ? +(wins / alphas.length).toFixed(3) : null,
    wilsonLo: alphas.length ? +wilsonLo(wins, alphas.length).toFixed(3) : null,
    meanAlpha: alphas.length ? r2(mean(alphas)) : null,
    t: alphas.length > 2 ? r2(tOf(alphas)) : null,
  };
}

async function runAlphaBook(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured', op: 'alphabook' });
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');

  // ── CERN sleeve: live-logged forced-flow events, graded here at each type's horizon ──
  const cernState = await readCern();
  const cernPicks = cernPicksFrom(cernState || {})
    .filter((p) => EVENT_TYPES[p.tier] && !EVENT_TYPES[p.tier].logOnly);
  const spyD = await fetchDailyHistory('SPY');
  const spy = spyD ? spyD.candles : null;
  const tickers = [...new Set(cernPicks.map((p) => p.ticker))];
  const hist = new Map(); let i = 0;
  const worker = async () => { while (i < tickers.length) { const t = tickers[i++]; try { const d = await fetchDailyHistory(t); if (d) hist.set(t, d.candles); } catch { /* skip name */ } } };
  await Promise.all(Array.from({ length: Math.min(8, tickers.length) }, worker));

  const cernRows = cernPicks.map((p) => {
    const candles = hist.get(p.ticker);
    const H = EVENT_TYPES[p.tier].horizon;
    if (!candles || !spy) return { ...p, alpha: null };
    const fwd = forwardReturn(candles, p, H);
    const spyR = spyForwardReturn(spy, p, H);
    if (fwd == null || spyR == null) return { ...p, alpha: null };
    return { ...p, alpha: r2(p.short ? fwd + spyR : fwd - spyR) };
  });

  // ── DOWNDAY sleeve: already resolved by its tick (3-session SPY-excess, long) ──
  const downDays = await readAllDownDays();
  const downRows = downDays.flatMap((d) => (d.picks || [])
    .filter((p) => p && p.resolved && p.excPct != null)
    .map((p) => ({ ticker: p.ticker, date: p.date, tier: p.tier, alpha: r2(p.excPct) })));

  const sleeves = { CERN: cernRows, DOWNDAY: downRows };
  const all = [...cernRows.map((r) => ({ ...r, sleeve: 'CERN' })), ...downRows.map((r) => ({ ...r, sleeve: 'DOWNDAY' }))];
  const prospective = all.filter((r) => r.date > REGISTERED_AFTER);

  // Cross-sleeve correlation of daily mean alpha (the diversification premise).
  const dailyMean = (rows) => { const m = new Map(); for (const r of rows) { if (r.alpha == null) continue; if (!m.has(r.date)) m.set(r.date, []); m.get(r.date).push(r.alpha); } const o = {}; for (const [d, a] of m) o[d] = mean(a); return o; };
  const cM = dailyMean(cernRows), dM = dailyMean(downRows);
  const common = Object.keys(cM).filter((d) => d in dM);
  let correlation = null;
  if (common.length >= 8) {
    const xs = common.map((d) => cM[d]), ys = common.map((d) => dM[d]);
    const mx = mean(xs), my = mean(ys);
    const cov = xs.reduce((s, x, k) => s + (x - mx) * (ys[k] - my), 0);
    const den = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * ys.reduce((s, y) => s + (y - my) ** 2, 0));
    correlation = den > 0 ? +(cov / den).toFixed(3) : null;
  }

  return res.status(200).json({
    ok: true, op: 'alphabook', bookVersion: BOOK_VERSION,
    sleeves: {
      CERN: { ...summarize(cernRows), note: 'graded at each event type\'s own horizon; logOnly types excluded' },
      DOWNDAY: { ...summarize(downRows), note: 'tick-resolved 3-session excess' },
    },
    portfolio: {
      ...summarize(all),
      pooledHorizonsCaveat: 'sleeves grade at different horizons — beatRate/wilsonLo are the scale-free pooled reads; meanAlpha pools heterogeneous horizons',
    },
    prospective: {
      ...summarize(prospective),
      boundary: REGISTERED_AFTER,
      note: 'events logged AFTER registration — the only rows the confirmatory hypothesis may ever use',
    },
    crossSleeve: { pairedDates: common.length, correlation, wantsNearZero: true },
    generatedAt: new Date().toISOString(),
  });
}

module.exports = { runAlphaBook, BOOK_VERSION, REGISTERED_AFTER, wilsonLo };

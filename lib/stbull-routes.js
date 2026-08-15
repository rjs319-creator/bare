'use strict';
// STOCKTWITS BULL-RATIO FLAG — shadow route handlers (weight 0; display + prospective ledger).
//
//   op=stbull         public read  — current flag snapshot + prospective-ledger progress
//   op=stbulltick     PRIVILEGED   — refresh the snapshot from StockTwits; append today's
//                                    write-once ledger day (fresh ≥90%-bull crossings)
//   op=stbullresolve  PRIVILEGED   — resolve ONE matured ledger day (≥9 calendar days
//                                    old): 5-session next-open SPY-excess per name,
//                                    byte-identical construction to the dilution overlay
//
// The flag never touches ranking, selection, sizing, alerts or governance. Promotion
// beyond a labeled read requires the frozen prospective gate (≥ 50 resolved decision
// dates) plus a manual registry change — see lib/stbull-flag.js FROZEN and
// docs/stbull-flag.md.

const FLAG = require('./stbull-flag');
const STORE = require('./store');
const { excess5 } = require('./dilution-routes');   // the research-identical outcome construction
const { sessionInfoAt } = require('./market-session');
const { fetchDailyHistory } = require('./screener');

const CURRENT_KEY = 'stbull/v1/current.json';
const INDEX_KEY = 'stbull/v1/prospective/index.json';
const dayKey = (date) => `stbull/v1/prospective/${date}.json`;
const RESOLVE_AFTER_CALENDAR_DAYS = 9;   // ≥ 5 sessions past the decision date
const RESOLVE_SYMBOL_CAP = 60;           // per invocation — stay inside the function budget

const cached = (res, s = 600) => res.setHeader('Cache-Control', `s-maxage=${s}, stale-while-revalidate=600`);
const noStore = (res) => res.setHeader('Cache-Control', 'no-store');
const today = () => sessionInfoAt(new Date()).etDate;   // decision dates live on the ET trading calendar

async function readIndex() {
  return STORE.readJSON(INDEX_KEY, { version: 'stbull-ledger-v1', dates: [], resolved: [], aggregate: { resolvedDates: 0, sumMeanExcess5: 0 } });
}

// ── op=stbull : public read ─────────────────────────────────────────────────
async function runStbull(req, res) {
  if (!STORE.hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  const snap = await STORE.readJSON(CURRENT_KEY, null);
  const idx = await readIndex();
  const agg = idx.aggregate || { resolvedDates: 0, sumMeanExcess5: 0 };
  // Never CDN-cache the empty state: a pre-first-tick response cached for 10 minutes
  // renders as "no crowd extremes anywhere" on every client behind the same edge node.
  if (snap) cached(res); else noStore(res);
  return res.status(200).json({
    ok: true,
    state: 'SHADOW',
    frozen: FLAG.FROZEN,
    available: !!snap,
    ...(snap ? { asOf: snap.asOf, counts: snap.counts, symbols: snap.symbols } : { reason: 'no snapshot yet — op=stbulltick has not run' }),
    prospective: {
      ledgerDays: idx.dates.length,
      resolvedDays: agg.resolvedDates,
      target: FLAG.FROZEN.prospectiveGate.minResolvedDates,
      meanExcess5SoFar: agg.resolvedDates ? +(agg.sumMeanExcess5 / agg.resolvedDates).toFixed(5) : null,
      note: 'running mean of per-date mean 5-session SPY-excess of freshly flagged names; a formal date-clustered eval (not this running mean) decides the gate',
    },
    disclosure: 'Shadow research flag from StockTwits user-labeled sentiment: >=90% bullish tags among the last 30 messages on a trending name. Contrarian over-extension hypothesis with a WEAK prior; unvalidated prospectively. NOT a sell signal, NOT a short signal, affects no ranking.',
  });
}

// ── op=stbulltick : refresh snapshot + append write-once ledger day ─────────
async function runStbullTick(req, res) {
  noStore(res);
  if (!STORE.hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  const date = today();

  let tickers;
  try { tickers = await FLAG.fetchTrending(); }
  catch (e) {
    // Fail closed: a broken trending fetch must not render as "no crowd extremes".
    return res.status(502).json({ ok: false, error: `StockTwits trending fetch failed — snapshot left unchanged: ${String(e && e.message || e)}` });
  }

  // Per-symbol streams, bounded concurrency; failures are RECORDED (a symbol whose
  // stream failed is absent from the universe and can neither flag nor un-flag).
  const rows = [];
  const failures = [];
  let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++];
      try {
        const msgs = await FLAG.fetchSymbolStream(t);
        rows.push({ ticker: t, ...FLAG.labeledRatio(msgs) });
      } catch (e) { failures.push({ ticker: t, error: String(e && e.message || e).slice(0, 80) }); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FLAG.STREAM_CONCURRENCY, tickers.length) }, worker));
  if (!rows.length) {
    return res.status(502).json({ ok: false, error: 'every symbol stream failed — snapshot left unchanged', failures: failures.length });
  }

  const snap = FLAG.buildFlagSet(rows, date);
  const prevSnap = await STORE.readJSON(CURRENT_KEY, null);
  await STORE.writeJSON(CURRENT_KEY, snap, 60);

  // Ledger day: write-once, idempotent. The decision unit is "fresh threshold
  // crossings vs the previous ledger day's flag set".
  const idx = await readIndex();
  if (idx.dates.includes(date)) {
    return res.status(200).json({ ok: true, date, snapshot: snap.counts, streamFailures: failures.length, ledger: 'already-written-today', ledgerDays: idx.dates.length });
  }
  const prevDate = idx.dates.length ? idx.dates[idx.dates.length - 1] : null;
  const prevDay = prevDate ? await STORE.readJSON(dayKey(prevDate), null) : null;
  const prevFlagged = prevDay ? (prevDay.flagged || []).map((f) => f.ticker)
    : prevSnap ? Object.keys(prevSnap.symbols || {}) : [];
  const flagged = Object.entries(snap.symbols).map(([t, v]) => ({ ticker: t, bullPct: v.bullPct, labeled: v.labeled }));
  const freshFlags = FLAG.selectFreshFlags(snap, prevFlagged);
  await STORE.writeJSON(dayKey(date), {
    version: 'stbull-ledger-v1', date, prevDate,
    freshFlags, flagged,
    universe: snap.universe, streamFailures: failures,
  }, 0);
  await STORE.writeJSON(INDEX_KEY, { ...idx, dates: [...idx.dates, date] }, 0);
  return res.status(200).json({ ok: true, date, snapshot: snap.counts, freshFlags: freshFlags.length, streamFailures: failures.length, ledgerDays: idx.dates.length + 1 });
}

// ── op=stbullresolve : resolve one matured, unresolved ledger day ───────────
async function runStbullResolve(req, res) {
  noStore(res);
  if (!STORE.hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  const idx = await readIndex();
  const resolvedSet = new Set(idx.resolved || []);
  const cutoff = new Date(Date.now() - RESOLVE_AFTER_CALENDAR_DAYS * 864e5).toISOString().slice(0, 10);
  const target = idx.dates.find((d) => !resolvedSet.has(d) && d <= cutoff);
  if (!target) return res.status(200).json({ ok: true, resolved: null, note: 'no matured unresolved ledger day', ledgerDays: idx.dates.length, resolvedDays: resolvedSet.size });

  const doc = await STORE.readJSON(dayKey(target), null);
  if (!doc) return res.status(502).json({ ok: false, error: `ledger day ${target} listed in the index but unreadable — refusing to mark it resolved` });

  let spy = null;
  try { const d = await fetchDailyHistory('SPY', '6mo'); spy = d && d.candles; } catch { spy = null; }
  if (!spy || !spy.length) return res.status(502).json({ ok: false, error: 'SPY history unavailable — resolution postponed, nothing marked' });

  const rows = (doc.freshFlags || []).slice(0, RESOLVE_SYMBOL_CAP);
  const outcomes = [];
  for (const f of rows) {
    try {
      const d = await fetchDailyHistory(f.ticker, '6mo');
      const c = d && d.candles;
      outcomes.push({ ticker: f.ticker, bullPct: f.bullPct, ...(c && c.length ? excess5(c, spy, target) : { excess5: null, reason: 'no-history' }) });
    } catch { outcomes.push({ ticker: f.ticker, bullPct: f.bullPct, excess5: null, reason: 'fetch-failed' }); }
  }
  const overflow = (doc.freshFlags || []).length - rows.length;
  const vals = outcomes.map((o) => o.excess5).filter(Number.isFinite);
  // An immature name means the DAY is not ready — postpone the whole day rather than
  // resolve a biased subset (the same anti-selection rule as the dilution ledger).
  if (outcomes.some((o) => o.reason === 'not-mature')) {
    return res.status(200).json({ ok: true, resolved: null, note: `day ${target} not fully mature yet — postponed`, ledgerDays: idx.dates.length, resolvedDays: resolvedSet.size });
  }
  const meanExcess5 = vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(5) : null;
  await STORE.writeJSON(dayKey(target), {
    ...doc,
    resolved5: { at: new Date().toISOString(), outcomes, n: vals.length, unresolvable: outcomes.length - vals.length, overflowSkipped: overflow, meanExcess5 },
  }, 0);
  const agg = idx.aggregate || { resolvedDates: 0, sumMeanExcess5: 0 };
  await STORE.writeJSON(INDEX_KEY, {
    ...idx,
    resolved: [...(idx.resolved || []), target],
    // Empty days (no fresh flags) count as resolved dates but contribute no mean.
    aggregate: meanExcess5 == null ? agg : { resolvedDates: agg.resolvedDates + 1, sumMeanExcess5: +(agg.sumMeanExcess5 + meanExcess5).toFixed(6) },
  }, 0);
  return res.status(200).json({ ok: true, resolved: target, n: vals.length, meanExcess5, overflowSkipped: overflow, resolvedDays: resolvedSet.size + 1 });
}

module.exports = { runStbull, runStbullTick, runStbullResolve };

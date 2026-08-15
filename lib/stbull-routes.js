'use strict';
// STOCKTWITS BULL-RATIO FLAG — shadow route handlers (weight 0; display + prospective ledger).
//
//   op=stbull         public read  — current flag snapshot + prospective-ledger progress
//   op=stbulltick     PRIVILEGED   — refresh the snapshot from StockTwits; append today's
//                                    write-once ledger day (fresh ≥90%-bull crossings).
//                                    TRADING DAYS ONLY — a weekend/holiday tick would mint
//                                    a pseudo-decision day whose excess5 decision bar
//                                    collapses onto the prior close (correlated, not
//                                    independent, observations).
//   op=stbullresolve  PRIVILEGED   — resolve ONE matured ledger day (≥9 calendar days
//                                    old): 5-session next-open SPY-excess per name,
//                                    byte-identical construction to the dilution overlay
//
// Ledger integrity rules (hardened per review — several of these defects exist verbatim
// in the dilution template and are fixed here first):
//   • FAIL-CLOSED INDEX READS: readJSON folds "absent" and "read failure" into the same
//     default, which would let one transient Blob error overwrite an immutable day doc
//     and rewrite the index from scratch (the ledger-wipe path lib/store.js:blobExists
//     documents). Every writer goes through readIndexChecked(), which probes existence
//     fail-closed and refuses to treat an unreadable index as empty.
//   • WRITE-ONCE DAY DOCS: the day doc's own existence is probed before writing; a day
//     doc orphaned by a crash between writes is re-indexed, never overwritten.
//   • FRESH-CROSSING BASELINE FAILS CLOSED: an unreadable previous day doc is a 502,
//     never silently "no previous flags" (which would re-mint week-long crowd extremes
//     as new independent decisions).
//   • SNAPSHOT WRITES LAST: the display snapshot can never become the baseline for the
//     same day's own crossings after a mid-tick crash.
//   • RESOLVE NEVER FAIL-OPENS A DAY: fetch failures postpone (up to
//     RESOLVE_MAX_FETCH_ATTEMPTS, then close out RECORDED as failures); a day still
//     not-mature past RESOLVE_MAX_AGE_DAYS (delisted/halted name — routine in the
//     trending universe) closes out as 'never-matured' instead of head-of-line
//     blocking the ledger forever.
//
// The flag never touches ranking, selection, sizing, alerts or governance. Promotion
// beyond a labeled read requires the frozen prospective gate — see lib/stbull-flag.js
// FROZEN and docs/stbull-flag.md.

const FLAG = require('./stbull-flag');
const STORE = require('./store');
const { mapLimit } = require('./map-limit');
const { excess5 } = require('./dilution-routes');   // the research-identical outcome construction
const { sessionInfoAt } = require('./market-session');
const { fetchDailyHistory } = require('./screener');

const CURRENT_KEY = 'stbull/v1/current.json';
const INDEX_KEY = 'stbull/v1/prospective/index.json';
const dayKey = (date) => `stbull/v1/prospective/${date}.json`;
const RESOLVE_AFTER_CALENDAR_DAYS = 9;    // ≥ 5 sessions past the decision date
const RESOLVE_SYMBOL_CAP = 60;            // per invocation — stay inside the function budget
const RESOLVE_FETCH_CONCURRENCY = 4;      // bounded Yahoo fan-out (22:00 burst hygiene)
const RESOLVE_MAX_FETCH_ATTEMPTS = 3;     // fetch-failed days postpone this many times, then close out recorded
const RESOLVE_MAX_AGE_DAYS = 30;          // a day still not-mature past this closes out as never-matured

const cached = (res, s = 600) => res.setHeader('Cache-Control', `s-maxage=${s}, stale-while-revalidate=600`);
const noStore = (res) => res.setHeader('Cache-Control', 'no-store');

const EMPTY_INDEX = () => ({ version: 'stbull-ledger-v1', dates: [], resolved: [], attempts: {}, aggregate: { resolvedDates: 0, sumMeanExcess5: 0 } });

// Fail-closed index read: blobExists throws on an infra failure (caller 502s) and
// distinguishes "genuinely absent" (first run → empty index) from "exists but
// unreadable" (refuse — treating it as empty would wipe the ledger on the next write).
async function readIndexChecked() {
  const exists = await STORE.blobExists(INDEX_KEY);
  if (!exists) return EMPTY_INDEX();
  const idx = await STORE.readJSON(INDEX_KEY, null);
  if (!idx) throw new Error('ledger index exists but is unreadable');
  return { attempts: {}, ...idx };
}

// ── op=stbull : public read ─────────────────────────────────────────────────
async function runStbull(req, res) {
  if (!STORE.hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  const snap = await STORE.readJSON(CURRENT_KEY, null);
  let idx = null, idxError = null;
  try { idx = await readIndexChecked(); } catch (e) { idxError = String(e && e.message || e); }
  // Never CDN-cache the empty state: a pre-first-tick response cached for 10 minutes
  // renders as "no crowd extremes anywhere" on every client behind the same edge node.
  if (snap) cached(res); else noStore(res);
  const agg = (idx && idx.aggregate) || { resolvedDates: 0, sumMeanExcess5: 0 };
  return res.status(200).json({
    ok: true,
    state: 'SHADOW',
    frozen: FLAG.FROZEN,
    available: !!snap,
    ...(snap ? { asOf: snap.asOf, counts: snap.counts, symbols: snap.symbols } : { reason: 'no snapshot yet — op=stbulltick has not run' }),
    prospective: idx ? {
      ledgerDays: idx.dates.length,
      // The GATE counter: resolved decision dates that produced >= 1 scored outcome.
      resolvedDays: agg.resolvedDates,
      // All closed-out days incl. empty/no-flag ones — reported separately so the two
      // numbers can never be conflated (they measure different things).
      resolvedTotal: (idx.resolved || []).length,
      target: FLAG.FROZEN.prospectiveGate.minResolvedDates,
      meanExcess5SoFar: agg.resolvedDates ? +(agg.sumMeanExcess5 / agg.resolvedDates).toFixed(5) : null,
      note: 'running mean of per-date mean 5-session SPY-excess of freshly flagged names; the gate counts only decision dates with scored outcomes; a formal date-clustered eval (not this running mean) decides the gate',
    } : { unavailable: true, reason: idxError },
    disclosure: 'Shadow research flag from StockTwits user-labeled sentiment: >=90% bullish tags among the last 30 messages on a trending name. Contrarian over-extension hypothesis with a WEAK prior; unvalidated prospectively. NOT a sell signal, NOT a short signal, affects no ranking.',
  });
}

// ── op=stbulltick : refresh snapshot + append write-once ledger day ─────────
async function runStbullTick(req, res) {
  noStore(res);
  if (!STORE.hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  const si = sessionInfoAt(new Date());
  if (!si.isTradingDay) {
    return res.status(200).json({ ok: true, skipped: 'non-trading day — no ledger day minted (a weekend tick would record correlated pseudo-decisions)' });
  }
  const date = si.etDate;

  let idx;
  try { idx = await readIndexChecked(); }
  catch (e) { return res.status(502).json({ ok: false, error: `ledger index unreadable — nothing written: ${String(e && e.message || e)}` }); }
  if (idx.dates.includes(date)) {
    return res.status(200).json({ ok: true, date, ledger: 'already-written-today', ledgerDays: idx.dates.length });
  }

  let tickers;
  try { tickers = await FLAG.fetchTrending(); }
  catch (e) {
    // Fail closed: a broken trending fetch must not render as "no crowd extremes".
    return res.status(502).json({ ok: false, error: `StockTwits trending fetch failed — snapshot left unchanged: ${String(e && e.message || e)}` });
  }

  // Per-symbol streams, bounded concurrency; failures are RECORDED (a symbol whose
  // stream failed is absent from the universe and can neither flag nor un-flag).
  const failures = [];
  const fetched = await mapLimit(tickers, FLAG.STREAM_CONCURRENCY, async (t) => {
    try { return { ticker: t, ...FLAG.labeledRatio(await FLAG.fetchSymbolStream(t)) }; }
    catch (e) { failures.push({ ticker: t, error: String(e && e.message || e).slice(0, 80) }); return null; }
  });
  const rows = fetched.filter(Boolean);
  if (!rows.length) {
    return res.status(502).json({ ok: false, error: 'every symbol stream failed — snapshot left unchanged', failures: failures.length });
  }
  const snap = FLAG.buildFlagSet(rows, date);

  // Fresh-crossing baseline: FAIL CLOSED on an unreadable previous day doc — silently
  // treating it as "no previous flags" would re-mint continuing extremes as new
  // independent decisions (the exact non-independence the decision unit rules out).
  const prevDate = idx.dates.length ? idx.dates[idx.dates.length - 1] : null;
  let prevFlagged = [];
  if (prevDate) {
    const prevDay = await STORE.readJSON(dayKey(prevDate), null);
    if (!prevDay) return res.status(502).json({ ok: false, error: `previous ledger day ${prevDate} unreadable — nothing written (baseline would be wrong)` });
    prevFlagged = (prevDay.flagged || []).map((f) => f.ticker);
  }
  const flagged = Object.entries(snap.symbols).map(([t, v]) => ({ ticker: t, bullPct: v.bullPct, labeled: v.labeled }));
  const freshFlags = FLAG.selectFreshFlags(snap, prevFlagged);

  // Write-once guard on the day doc itself (beyond the index): a doc orphaned by a
  // crash between writes is re-indexed, never overwritten.
  let dayExists;
  try { dayExists = await STORE.blobExists(dayKey(date)); }
  catch (e) { return res.status(502).json({ ok: false, error: `day-doc existence probe failed — nothing written: ${String(e && e.message || e)}` }); }
  if (!dayExists) {
    await STORE.writeJSON(dayKey(date), {
      version: 'stbull-ledger-v1', date, prevDate,
      freshFlags, flagged,
      universe: snap.universe, streamFailures: failures,
    }, 0);
  }
  await STORE.writeJSON(INDEX_KEY, { ...idx, dates: [...idx.dates, date] }, 0);
  // Snapshot LAST: written only after the ledger day is durable, so a mid-tick crash
  // can never leave today's own snapshot as the baseline for today's crossings.
  await STORE.writeJSON(CURRENT_KEY, snap, 60);
  return res.status(200).json({
    ok: true, date, snapshot: snap.counts, freshFlags: freshFlags.length,
    streamFailures: failures.length, ledgerDays: idx.dates.length + 1,
    ...(dayExists ? { recovered: 'day doc already existed — re-indexed, not overwritten' } : {}),
  });
}

// ── op=stbullresolve : resolve one matured, unresolved ledger day ───────────
async function runStbullResolve(req, res) {
  noStore(res);
  if (!STORE.hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  let idx;
  try { idx = await readIndexChecked(); }
  catch (e) { return res.status(502).json({ ok: false, error: `ledger index unreadable — nothing resolved: ${String(e && e.message || e)}` }); }
  const resolvedSet = new Set(idx.resolved || []);
  const cutoff = new Date(Date.now() - RESOLVE_AFTER_CALENDAR_DAYS * 864e5).toISOString().slice(0, 10);
  const target = idx.dates.find((d) => !resolvedSet.has(d) && d <= cutoff);
  if (!target) return res.status(200).json({ ok: true, resolved: null, note: 'no matured unresolved ledger day', ledgerDays: idx.dates.length, resolvedTotal: resolvedSet.size });

  const doc = await STORE.readJSON(dayKey(target), null);
  if (!doc) return res.status(502).json({ ok: false, error: `ledger day ${target} listed in the index but unreadable — refusing to mark it resolved` });

  let spy = null;
  try { const d = await fetchDailyHistory('SPY', '6mo'); spy = d && d.candles; } catch { spy = null; }
  if (!spy || !spy.length) return res.status(502).json({ ok: false, error: 'SPY history unavailable — resolution postponed, nothing marked' });

  const rows = (doc.freshFlags || []).slice(0, RESOLVE_SYMBOL_CAP);
  const outcomes = await mapLimit(rows, RESOLVE_FETCH_CONCURRENCY, async (f) => {
    try {
      const d = await fetchDailyHistory(f.ticker, '6mo');
      const c = d && d.candles;
      return { ticker: f.ticker, bullPct: f.bullPct, ...(c && c.length ? excess5(c, spy, target) : { excess5: null, reason: 'no-history' }) };
    } catch { return { ticker: f.ticker, bullPct: f.bullPct, excess5: null, reason: 'fetch-failed' }; }
  });
  const overflow = (doc.freshFlags || []).length - rows.length;
  const attempts = ((idx.attempts || {})[target] || 0) + 1;
  const ageDays = Math.floor((Date.now() - Date.parse(target + 'T00:00:00Z')) / 864e5);
  const postpone = async (note) => {
    await STORE.writeJSON(INDEX_KEY, { ...idx, attempts: { ...(idx.attempts || {}), [target]: attempts } }, 0);
    return res.status(200).json({ ok: true, resolved: null, note, attempt: attempts, ledgerDays: idx.dates.length, resolvedTotal: resolvedSet.size });
  };

  // Transient fetch failures postpone (bounded — a persistently unfetchable day closes
  // out RECORDED as failures rather than silently resolving empty on the first outage).
  const fetchFails = outcomes.filter((o) => o.reason === 'fetch-failed' || o.reason === 'no-history').length;
  if (fetchFails > 0 && attempts < RESOLVE_MAX_FETCH_ATTEMPTS) {
    return postpone(`day ${target}: ${fetchFails} fetch failure(s) — postponed (attempt ${attempts}/${RESOLVE_MAX_FETCH_ATTEMPTS})`);
  }
  // A genuinely young day postpones on any not-mature name (no partial resolve — the
  // early-stop-outs-first selection-bias rule). Past RESOLVE_MAX_AGE_DAYS the immature
  // names can never mature (delisting/halt) — close them out as 'never-matured' so one
  // dead ticker can't head-of-line-block the ledger forever.
  const hasNotMature = outcomes.some((o) => o.reason === 'not-mature');
  if (hasNotMature && ageDays <= RESOLVE_MAX_AGE_DAYS) {
    return postpone(`day ${target} not fully mature yet — postponed`);
  }
  const finalOutcomes = outcomes.map((o) => (o.reason === 'not-mature' ? { ...o, reason: 'never-matured' } : o));

  const vals = finalOutcomes.map((o) => o.excess5).filter(Number.isFinite);
  const meanExcess5 = vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(5) : null;
  await STORE.writeJSON(dayKey(target), {
    ...doc,
    resolved5: { at: new Date().toISOString(), outcomes: finalOutcomes, n: vals.length, unresolvable: finalOutcomes.length - vals.length, overflowSkipped: overflow, meanExcess5, attempts },
  }, 0);
  const agg = idx.aggregate || { resolvedDates: 0, sumMeanExcess5: 0 };
  const nextAttempts = { ...(idx.attempts || {}) };
  delete nextAttempts[target];
  await STORE.writeJSON(INDEX_KEY, {
    ...idx,
    resolved: [...(idx.resolved || []), target],
    attempts: nextAttempts,
    // The gate counter advances ONLY on decision dates with >= 1 scored outcome; empty
    // and unresolvable-only days close out (idx.resolved / resolvedTotal) but do not
    // count toward — or dilute — the frozen minResolvedDates gate.
    aggregate: meanExcess5 == null ? agg : { resolvedDates: agg.resolvedDates + 1, sumMeanExcess5: +(agg.sumMeanExcess5 + meanExcess5).toFixed(6) },
  }, 0);
  return res.status(200).json({
    ok: true, resolved: target, n: vals.length, meanExcess5, overflowSkipped: overflow,
    resolvedDays: meanExcess5 == null ? agg.resolvedDates : agg.resolvedDates + 1,
    resolvedTotal: resolvedSet.size + 1,
  });
}

module.exports = { runStbull, runStbullTick, runStbullResolve, readIndexChecked };

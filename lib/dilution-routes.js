'use strict';
// 424B5 DILUTION FLAG — shadow route handlers (weight 0; display + prospective ledger).
//
//   op=dilution         public read  — current flag snapshot + prospective-ledger progress
//   op=dilutiontick     PRIVILEGED   — refresh the snapshot from EDGAR; append today's
//                                      write-once ledger day (the new filings since the
//                                      previous ledger day)
//   op=dilutionresolve  PRIVILEGED   — resolve ONE matured ledger day (≥9 calendar days
//                                      old): 5-session next-open SPY-excess per name,
//                                      identical construction to research/95
//
// The flag never touches ranking, selection, sizing, alerts or governance. Promotion
// beyond a labeled badge requires the frozen prospective gate (≥ 50 resolved decision
// dates) plus a manual registry change — see lib/dilution-flag.js FROZEN and
// docs/dilution-flag.md.

const FLAG = require('./dilution-flag');
const STORE = require('./store');
const { fetchDailyHistory } = require('./screener');

const CURRENT_KEY = 'dilution/v1/current.json';
const INDEX_KEY = 'dilution/v1/prospective/index.json';
const dayKey = (date) => `dilution/v1/prospective/${date}.json`;
const RESOLVE_AFTER_CALENDAR_DAYS = 9;   // ≥ 5 sessions past the newest filing in a day doc
const RESOLVE_SYMBOL_CAP = 60;           // per invocation — stay inside the function budget
const HOLD_SESSIONS = 5;                 // the research's strongest cell (q = 0.0002)

const cached = (res, s = 600) => res.setHeader('Cache-Control', `s-maxage=${s}, stale-while-revalidate=600`);
const noStore = (res) => res.setHeader('Cache-Control', 'no-store');
const today = () => new Date().toISOString().slice(0, 10);

async function readIndex() {
  return STORE.readJSON(INDEX_KEY, { version: 'dilution-ledger-v1', dates: [], resolved: [], aggregate: { resolvedDates: 0, sumMeanExcess5: 0 } });
}

// Fail-closed index read for the WRITERS: readJSON folds "absent" and "read failure"
// into the same empty default, so one transient Blob error during a tick would pass the
// write-once guard, overwrite an immutable day doc and rewrite the index from scratch —
// wiping the ledger (the exact hazard lib/store.js blobExists exists for). The public
// read keeps the graceful readIndex(); every write path must use this instead.
async function readIndexCheckedForWrite() {
  const exists = await STORE.blobExists(INDEX_KEY);   // throws on infra failure → caller 502s
  if (!exists) return { version: 'dilution-ledger-v1', dates: [], resolved: [], aggregate: { resolvedDates: 0, sumMeanExcess5: 0 } };
  const idx = await STORE.readJSON(INDEX_KEY, null);
  if (!idx) throw new Error('ledger index exists but is unreadable');
  return idx;
}

// ── op=dilution : public read ───────────────────────────────────────────────
async function runDilution(req, res) {
  if (!STORE.hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  const snap = await STORE.readJSON(CURRENT_KEY, null);
  const idx = await readIndex();
  const agg = idx.aggregate || { resolvedDates: 0, sumMeanExcess5: 0 };
  // Never CDN-cache the empty state: a pre-first-tick response cached for 10 minutes
  // renders as "no dilution risk anywhere" on every client behind the same edge node.
  if (snap) cached(res); else noStore(res);
  return res.status(200).json({
    ok: true,
    state: 'SHADOW',
    frozen: FLAG.FROZEN,
    available: !!snap,
    ...(snap ? { asOf: snap.asOf, counts: snap.counts, symbols: snap.symbols } : { reason: 'no snapshot yet — op=dilutiontick has not run' }),
    prospective: {
      ledgerDays: idx.dates.length,
      resolvedDays: agg.resolvedDates,
      target: FLAG.FROZEN.prospectiveGate.minResolvedDates,
      meanExcess5SoFar: agg.resolvedDates ? +(agg.sumMeanExcess5 / agg.resolvedDates).toFixed(5) : null,
      note: 'running mean of per-date mean 5-session SPY-excess of newly flagged names; a formal date-clustered eval (not this running mean) decides the gate',
    },
    disclosure: 'Shadow research flag from EDGAR 424B5 filings (new-share/ATM offering paperwork). Historically such names lagged SPY on average; unvalidated prospectively. NOT a sell signal, NOT a short signal, affects no ranking.',
  });
}

// ── op=dilutiontick : refresh snapshot + append write-once ledger day ───────
async function runDilutionTick(req, res) {
  noStore(res);
  if (!STORE.hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  const date = today();
  let filings;
  try { filings = await FLAG.fetchRecentFilings({}); }
  catch (e) {
    // Fail closed: a partial fetch would render as "no dilution risk". Keep the previous
    // snapshot in place and report the failure.
    return res.status(502).json({ ok: false, error: `EDGAR fetch failed — snapshot left unchanged: ${String(e && e.message || e)}` });
  }
  const snap = FLAG.buildFlagSet(filings, date);
  await STORE.writeJSON(CURRENT_KEY, snap, 60);

  // Ledger day: write-once, idempotent. The day's decision unit is "names NEWLY filed
  // since the previous ledger day" — that is what the prospective evaluation scores.
  let idx;
  try { idx = await readIndexCheckedForWrite(); }
  catch (e) { return res.status(502).json({ ok: false, error: `ledger index unreadable — nothing written: ${String(e && e.message || e)}` }); }
  if (idx.dates.includes(date)) {
    return res.status(200).json({ ok: true, date, snapshot: snap.counts, ledger: 'already-written-today', ledgerDays: idx.dates.length });
  }
  const prevDate = idx.dates.length ? idx.dates[idx.dates.length - 1] : null;
  const newFilings = selectNewFilings(filings, date, prevDate);
  await STORE.writeJSON(dayKey(date), { version: 'dilution-ledger-v1', date, prevDate, newFilings, flaggedTotal: snap.counts.flagged }, 0);
  await STORE.writeJSON(INDEX_KEY, { ...idx, dates: [...idx.dates, date] }, 0);
  return res.status(200).json({ ok: true, date, snapshot: snap.counts, newFilings: newFilings.length, ledgerDays: idx.dates.length + 1 });
}

// The ledger day's decision unit: filings NEWER than the previous ledger day (first day:
// today's only), one row per ticker. Pure — the write-once semantics live in the caller.
function selectNewFilings(filings, date, prevDate) {
  const seen = new Set();
  return (filings || [])
    .filter((f) => f && f.ticker && f.fileDate && f.fileDate <= date && (!prevDate ? f.fileDate >= date : f.fileDate > prevDate))
    .filter((f) => (seen.has(f.ticker) ? false : (seen.add(f.ticker), true)))
    .map((f) => ({ ticker: f.ticker, fileDate: f.fileDate, adsh: f.adsh }));
}

// 5-session next-open SPY-excess for one name, identical to the research construction:
// decision bar = last session ≤ fileDate, entry = next session's open, exit = close 5
// sessions after the decision bar.
function excess5(candles, spy, fileDate) {
  const at = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i].date <= fileDate) return i; return -1; };
  const i = at(candles), j = at(spy);
  if (i < 0 || j < 0) return { excess5: null, reason: 'no-decision-bar' };
  if (i + HOLD_SESSIONS > candles.length - 1 || j + HOLD_SESSIONS > spy.length - 1) return { excess5: null, reason: 'not-mature' };
  const e = candles[i + 1], x = candles[i + HOLD_SESSIONS];
  const be = spy[j + 1], bx = spy[j + HOLD_SESSIONS];
  if (!(e && e.open > 0 && x && x.close > 0 && be && be.open > 0 && bx && bx.close > 0)) return { excess5: null, reason: 'bad-prices' };
  return { excess5: +((x.close / e.open - 1) - (bx.close / be.open - 1)).toFixed(5) };
}

// ── op=dilutionresolve : resolve one matured, unresolved ledger day ─────────
async function runDilutionResolve(req, res) {
  noStore(res);
  if (!STORE.hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  let idx;
  try { idx = await readIndexCheckedForWrite(); }
  catch (e) { return res.status(502).json({ ok: false, error: `ledger index unreadable — nothing resolved: ${String(e && e.message || e)}` }); }
  const resolvedSet = new Set(idx.resolved || []);
  const cutoff = new Date(Date.now() - RESOLVE_AFTER_CALENDAR_DAYS * 864e5).toISOString().slice(0, 10);
  const target = idx.dates.find((d) => !resolvedSet.has(d) && d <= cutoff);
  if (!target) return res.status(200).json({ ok: true, resolved: null, note: 'no matured unresolved ledger day', ledgerDays: idx.dates.length, resolvedDays: resolvedSet.size });

  const doc = await STORE.readJSON(dayKey(target), null);
  if (!doc) return res.status(502).json({ ok: false, error: `ledger day ${target} listed in the index but unreadable — refusing to mark it resolved` });

  let spy = null;
  try { const d = await fetchDailyHistory('SPY', '6mo'); spy = d && d.candles; } catch { spy = null; }
  if (!spy || !spy.length) return res.status(502).json({ ok: false, error: 'SPY history unavailable — resolution postponed, nothing marked' });

  const rows = (doc.newFilings || []).slice(0, RESOLVE_SYMBOL_CAP);
  const outcomes = [];
  for (const f of rows) {
    try {
      const d = await fetchDailyHistory(f.ticker, '6mo');
      const c = d && d.candles;
      outcomes.push({ ticker: f.ticker, fileDate: f.fileDate, ...(c && c.length ? excess5(c, spy, f.fileDate) : { excess5: null, reason: 'no-history' }) });
    } catch { outcomes.push({ ticker: f.ticker, fileDate: f.fileDate, excess5: null, reason: 'fetch-failed' }); }
  }
  const overflow = (doc.newFilings || []).length - rows.length;
  const vals = outcomes.map((o) => o.excess5).filter(Number.isFinite);
  // An immature name means the DAY is not ready — postpone the whole day rather than
  // resolve a biased subset (early stop-outs resolving first is exactly the selection
  // bias the NAV repair exists to prevent; the same rule applies here).
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
    // Empty days (no new filings) count as resolved dates but contribute no mean.
    aggregate: meanExcess5 == null ? agg : { resolvedDates: agg.resolvedDates + 1, sumMeanExcess5: +(agg.sumMeanExcess5 + meanExcess5).toFixed(6) },
  }, 0);
  return res.status(200).json({ ok: true, resolved: target, n: vals.length, meanExcess5, overflowSkipped: overflow, resolvedDays: resolvedSet.size + 1 });
}

module.exports = { runDilution, runDilutionTick, runDilutionResolve, selectNewFilings, excess5 };

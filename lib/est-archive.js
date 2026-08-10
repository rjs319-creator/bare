'use strict';
// ANALYST-ESTIMATE VINTAGE ARCHIVE (op=estarchive → estarchive/<date>.json)
//
// Consensus estimates are MUTABLE at the vendor: today's pull silently overwrites
// what the consensus "was" — which is exactly why every estimate-revision feature
// in this repo is marked unavailable ("vintage history unverified"). The only way
// to ever have revision features with valid point-in-time lineage is to start
// saving daily snapshots NOW and let vintages accrue. This stream does that and
// nothing else: no features, no signals, no reads into outcomes — collection
// first, research later (the alpha-archive doctrine).
//
// Storage follows the alpha-archive conventions exactly (lib/alpha-archive-routes.js):
// date-keyed write-once shards, NO read-modify-write races (the one same-day
// merge mirrors revarchive's, hours apart), truncation recorded never silent,
// 503 on total transient failure so the scheduler sees starvation, and a
// plan-gate recorded as data (gated:true) rather than retried or faked.
//
// PIT contract: doc.date is the ET snapshot day, doc.collectedAt is when the
// app knew it. A future training row may only use a snapshot whose collectedAt
// is at or before the row's decision time. Never backfill.
const { nowET } = require('./stats');
const { fmpRequest, CATEGORY } = require('./fmp-client');

const EST_MAX_SYMBOLS = 120;                 // × 2 periods = ≤240 calls/run, quiet-window scheduled
const EST_UPCOMING_DAYS = 21;                // earnings-soon names get priority slots
const EST_ROWS_PER_PERIOD = 6;               // next ~6 fiscal periods per horizon
const EST_DEADLINE_MS = 230_000;             // under the 300s function wall + workflow curl timeout
const EST_CALL_SPACING_MS = 150;             // serial and gentle — never a burst
const EST_PERIODS = Object.freeze(['annual', 'quarter']);
const GATE_PROBE_SYMBOLS = 3;                // all-gated first N symbols ⇒ the plan is the wall

const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

// Compact one vendor row to what revision features will need — mean/high/low for
// EPS + revenue, analyst counts, fiscal period end. Tolerant to field variants;
// a row with no period or no figures is dropped (never a null-stuffed vintage).
function compactEstimateRow(row) {
  if (!row || typeof row !== 'object') return null;
  const per = row.date ? String(row.date).slice(0, 10) : null;
  if (!per || !/^\d{4}-\d{2}-\d{2}$/.test(per)) return null;
  const out = {
    per,
    eps: num(row.epsAvg ?? row.estimatedEpsAvg), epsHi: num(row.epsHigh ?? row.estimatedEpsHigh), epsLo: num(row.epsLow ?? row.estimatedEpsLow),
    rev: num(row.revenueAvg ?? row.estimatedRevenueAvg), revHi: num(row.revenueHigh ?? row.estimatedRevenueHigh), revLo: num(row.revenueLow ?? row.estimatedRevenueLow),
    nA: num(row.numAnalystsEps ?? row.numberAnalystsEstimatedEps ?? row.numAnalystEstimatedEps),
    nR: num(row.numAnalystsRevenue ?? row.numberAnalystEstimatedRevenue),
  };
  return out.eps === null && out.rev === null ? null : out;
}

// Priority universe, pure: names with earnings inside the window first (they are
// where revision velocity concentrates), then the liquid LARGE list fills the
// remaining budget. calendarRows use the calarchive compact shape { s, d }.
function buildEstUniverse({ calendarRows, today, fill, max = EST_MAX_SYMBOLS }) {
  const horizon = new Date(new Date(`${today}T00:00:00Z`).getTime() + EST_UPCOMING_DAYS * 86_400_000).toISOString().slice(0, 10);
  const upcoming = (calendarRows || [])
    .filter((r) => r && r.s && r.d && r.d >= today && r.d <= horizon)
    .sort((a, b) => (a.d < b.d ? -1 : 1))
    .map((r) => String(r.s).toUpperCase());
  const seen = new Set();
  const out = [];
  for (const s of [...upcoming, ...(fill || []).map((t) => String(t || '').toUpperCase())]) {
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

// Same-day merge: union of symbols, the FRESHER pull wins per symbol (mirrors
// revarchive's merge — replacing wholesale would drop the earlier run's names).
function mergeEstDay(prior, freshSymbols) {
  const priorSymbols = (prior && prior.symbols && typeof prior.symbols === 'object') ? prior.symbols : {};
  return { ...priorSymbols, ...freshSymbols };
}

async function collectSymbol(symbol, { request, gatedPeriods }) {
  const entry = {};
  let anyOk = false;
  let allGated = true;
  for (const period of EST_PERIODS) {
    const r = await request('/analyst-estimates', { symbol, period, page: 0, limit: EST_ROWS_PER_PERIOD }, { attempts: 2 });
    if (r.category === CATEGORY.PLAN_GATED) { gatedPeriods[period] = (gatedPeriods[period] || 0) + 1; continue; }
    allGated = false;
    if (!r.ok || !Array.isArray(r.body)) continue;
    const rows = r.body.map(compactEstimateRow).filter(Boolean);
    if (rows.length) { entry[period === 'annual' ? 'a' : 'q'] = rows; anyOk = true; }
  }
  return { entry: anyOk ? entry : null, allGated };
}

// ── op=estarchive (PRIVILEGED — ≤240 FMP calls + one Blob write) ────────────
async function runEstArchive(req, res) {
  const { hasStore, readEstArchiveDay, writeEstArchiveDay, listCalArchiveDates, readCalArchiveDay } = require('./store');
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured', op: 'estarchive' });
  if (!process.env.FMP_API_KEY) return res.status(200).json({ ok: false, error: 'FMP_API_KEY required', op: 'estarchive' });
  const t0 = Date.now();
  const { date } = nowET();
  const request = fmpRequest;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Priority from the latest calendar snapshot (usually written 30 min earlier
  // by op=calarchive) — a missing snapshot degrades to the LARGE list, never blocks.
  let calendarRows = [];
  try {
    const dates = await listCalArchiveDates();
    if (dates.length) {
      const snap = await readCalArchiveDay(dates[dates.length - 1]);
      if (snap && Array.isArray(snap.rows)) calendarRows = snap.rows;
    }
  } catch { /* degrade to fill list */ }
  const { LARGE } = require('./universe');
  const symbols = buildEstUniverse({ calendarRows, today: date, fill: LARGE });

  const gatedPeriods = {};
  const captured = {};
  let attempted = 0;
  let truncatedAt = null;
  let gatedStreak = 0;                          // consecutive fully-gated symbols from the start
  for (let i = 0; i < symbols.length; i++) {
    if (Date.now() - t0 > EST_DEADLINE_MS) { truncatedAt = i; break; }   // recorded, never silent
    if (i > 0) await sleep(EST_CALL_SPACING_MS);
    const { entry, allGated } = await collectSymbol(symbols[i], { request, gatedPeriods });
    attempted++;
    if (entry) captured[symbols[i]] = entry;
    // Deterministic plan wall: EVERY period gated for the first N symbols in a
    // row. Stop spending the budget — record the gate as the day's honest result.
    gatedStreak = allGated && gatedStreak === i ? gatedStreak + 1 : -1;
    if (gatedStreak === GATE_PROBE_SYMBOLS) {
      return res.status(200).json({
        ok: false, op: 'estarchive', date, gated: true, gatedPeriods,
        error: 'analyst-estimates is plan-gated on this subscription — no vintage written (recorded, not fabricated)',
        elapsedMs: Date.now() - t0,
      });
    }
  }

  if (Object.keys(captured).length === 0) {
    // Transient starvation (429 burst / outage): 503 so the scheduler + op=health
    // see the missed day — the calarchive lesson, a silent-200 failure is invisible.
    return res.status(503).json({ ok: false, op: 'estarchive', date, error: 'no symbols captured (after retries) — no vintage written', attempted, elapsedMs: Date.now() - t0 });
  }

  const prior = await readEstArchiveDay(date);
  const merged = mergeEstDay(prior, captured);
  await writeEstArchiveDay(date, {
    date, source: 'fmp/analyst-estimates', periods: EST_PERIODS, rowsPerPeriod: EST_ROWS_PER_PERIOD,
    collectedAt: new Date().toISOString(),
    planned: symbols.length, attempted, truncatedAt, gatedPeriods,
    symbols: merged,
  });
  return res.status(200).json({
    ok: true, op: 'estarchive', date, planned: symbols.length, attempted,
    captured: Object.keys(captured).length, totalSymbols: Object.keys(merged).length,
    mergedWithPrior: !!prior, truncatedAt, gatedPeriods, elapsedMs: Date.now() - t0,
  });
}

module.exports = { runEstArchive, compactEstimateRow, buildEstUniverse, mergeEstDay, EST_MAX_SYMBOLS, EST_PERIODS };

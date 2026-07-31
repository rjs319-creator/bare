'use strict';
// POINT-IN-TIME CROSS-SECTIONAL DATASET — the training-data fix for the survival stack's
// selection bias.
//
// THE DEFECT THIS CLOSES. The learned models trained ONLY on first-ACTIONABLE_NOW episodes —
// stocks the current system already selected. That sample can never contain the false
// negatives (runners the system rejected or never discovered), so a model trained on it
// learns "among names the old gate liked, which won?" — not "which eligible stock is about
// to run?". This module captures the WHOLE eligible discovery universe at each scan pass
// (~5-minute decision times), with deterministic negative sampling so storage stays bounded
// while probability calibration stays meaningful.
//
// SAMPLING CONTRACT (pre-registered):
//   • Every "at-risk" row is kept with probability 1 (cusum/shock/day-move/participation
//     above the floor — the superset from which positives can come, INCLUDING names the
//     current system rejected).
//   • Other rows (ordinary negatives) are kept by a DETERMINISTIC hash of
//     date|bucket|ticker at NEG_RATE. The sampling probability is stored ON THE ROW
//     (sampleProb) so evaluation weights rows by 1/sampleProb.
//   • Labels come later (lib/intraday-labels, strictly-after bars) — a row NEVER knows its
//     future at capture time, and "kept because it later ran" is impossible by construction.
//
// Storage: one write-once doc per (date, 5-minute bucket) + a tiny best-effort index. No
// read-modify-write of a growing day file on the scan hot path.

const { readJSON, writeJSON, hasStore } = require('./store');

const DATASET_VERSION = 'intraday-dataset-v1';
const NEG_RATE = 0.06;             // deterministic keep-rate for ordinary negatives
const AT_RISK = Object.freeze({    // keep-all floor — the positive-capable superset
  MIN_CUSUM: 1.0,
  MIN_Z: 1.5,
  MIN_DAY_PCT: 1.5,
  MIN_REL_VOL: 1.5,
});
const MAX_ROWS_PER_SCAN = 400;     // hard cap (at-risk first) so one wild tape can't blow storage

const bucketKey = (date, bucket) => `lifecycle/daytrade/dataset/${date}/b${bucket}.json`;
const indexKey = date => `lifecycle/daytrade/dataset/${date}/index.json`;
const gradesKey = date => `lifecycle/daytrade/dataset/${date}/grades.json`;

// 5-minute decision bucket since 04:00 ET (premarket-capable), from an ISO instant.
function bucketOf(iso) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const get = t => (parts.find(p => p.type === t) || {}).value;
  let hh = parseInt(get('hour'), 10); if (hh === 24) hh = 0;
  const min = hh * 60 + parseInt(get('minute'), 10);
  return Math.max(0, Math.floor((min - 4 * 60) / 5));
}

// FNV-1a — deterministic, seedless, stable across runs (no RNG anywhere in sampling).
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

function isAtRisk(row) {
  return (row.cusum ?? 0) >= AT_RISK.MIN_CUSUM
    || (row.z ?? 0) >= AT_RISK.MIN_Z
    || (row.dayPct ?? 0) >= AT_RISK.MIN_DAY_PCT
    || (row.relVol ?? 0) >= AT_RISK.MIN_REL_VOL;
}

// Decide keep/drop for one row. Deterministic: same (date, bucket, ticker) → same answer.
function sampleDecision(row, date, bucket, negRate = NEG_RATE) {
  if (isAtRisk(row)) return { keep: true, sampleProb: 1 };
  const keep = (fnv1a(`${date}|${bucket}|${row.ticker}`) % 100000) < negRate * 100000;
  return { keep, sampleProb: negRate };
}

// Build the sampled rows for one scan pass. `universeRows` = one row per SCANNED ticker
// (alarmed or not), each already point-in-time. Pure.
function buildScanRows(universeRows, { date, at, sessionBucket = null } = {}) {
  const bucket = bucketOf(at);
  const out = [];
  for (const r of universeRows || []) {
    if (!r || !r.ticker) continue;
    const d = sampleDecision(r, date, bucket);
    if (!d.keep) continue;
    out.push({
      ticker: r.ticker, at, bucket, sessionBucket,
      last: r.last ?? null, prevClose: r.prevClose ?? null, atr: r.atr ?? null,
      dayPct: r.dayPct ?? null, excessPct: r.excessPct ?? null, relVol: r.relVol ?? null,
      cusum: r.cusum ?? null, z: r.z ?? null, intervalRet: r.intervalRet ?? null,
      avgDollarVol: r.avgDollarVol ?? null, sector: r.sector ?? null,
      quoteAsOf: r.quoteAsOf ?? null,
      sampleProb: d.sampleProb, atRisk: d.sampleProb === 1,
      datasetVersion: DATASET_VERSION,
    });
  }
  // Cap: at-risk rows first (never drop a potential positive to keep a sampled negative).
  out.sort((a, b) => (b.atRisk ? 1 : 0) - (a.atRisk ? 1 : 0));
  return { bucket, rows: out.slice(0, MAX_ROWS_PER_SCAN), dropped: Math.max(0, out.length - MAX_ROWS_PER_SCAN) };
}

// Persist one scan pass (write-once per bucket — idempotent under the 60s scan cadence).
async function appendScanRows(date, built) {
  if (!hasStore() || !built || !built.rows.length) return { persisted: false, reason: 'no-store-or-rows' };
  const key = bucketKey(date, built.bucket);
  const existing = await readJSON(key, null).catch(() => null);
  if (existing && existing.rows) return { persisted: false, reason: 'bucket-already-captured' };
  await writeJSON(key, { date, bucket: built.bucket, capturedAt: new Date().toISOString(), datasetVersion: DATASET_VERSION, rows: built.rows, dropped: built.dropped }, 0);
  try {
    const idx = await readJSON(indexKey(date), { date, buckets: [] }).catch(() => ({ date, buckets: [] }));
    if (!idx.buckets.includes(built.bucket)) {
      await writeJSON(indexKey(date), { date, buckets: [...idx.buckets, built.bucket].sort((a, b) => a - b), updatedAt: new Date().toISOString() }, 0);
    }
  } catch { /* index is best-effort; grading can still probe buckets */ }
  return { persisted: true, bucket: built.bucket, rows: built.rows.length };
}

async function loadDatasetDay(date) {
  if (!hasStore()) return { date, rows: [], buckets: [] };
  const idx = await readJSON(indexKey(date), null).catch(() => null);
  const buckets = idx && Array.isArray(idx.buckets) ? idx.buckets : [];
  const docs = await Promise.all(buckets.map(b => readJSON(bucketKey(date, b), null).catch(() => null)));
  return { date, buckets, rows: docs.filter(Boolean).flatMap(d => d.rows || []) };
}

// ── Grading: attach same-day labels (strictly-after bars) to captured rows ──────
// Bounded per invocation (external scheduler / manual op calls it repeatedly until done).
// Rows for tickers whose bars can't be fetched stay ungraded — never guessed.
async function gradeDatasetDay(date, { limit = 40, fetchFiveMin = null } = {}) {
  if (!hasStore()) return { ok: false, reason: 'no-store' };
  const { computeLabels } = require('./intraday-labels');
  const { sessionsFromResult } = require('./intraday-features');
  const fetcher = fetchFiveMin || require('./intraday-capture').fetchFiveMin;

  const day = await loadDatasetDay(date);
  if (!day.rows.length) return { ok: true, date, graded: 0, remaining: 0, note: 'no dataset rows captured for this date' };
  const gradesDoc = await readJSON(gradesKey(date), { date, grades: {} }).catch(() => ({ date, grades: {} }));
  const grades = gradesDoc.grades || {};

  const pending = day.rows.filter(r => !grades[`${r.ticker}|${r.at}`] && r.last > 0 && r.atr > 0);
  const byTicker = new Map();
  for (const r of pending) { if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []); byTicker.get(r.ticker).push(r); }
  const tickers = [...byTicker.keys()].sort().slice(0, Math.max(1, limit));

  let graded = 0, failedFetch = 0;
  for (const t of tickers) {
    let sessionBars = null;
    try {
      const res = await fetcher(t);
      if (res) sessionBars = (sessionsFromResult(res)[date]) || null;
    } catch { /* stays ungraded */ }
    if (!sessionBars || !sessionBars.length) { failedFetch++; continue; }
    for (const r of byTicker.get(t)) {
      const label = computeLabels({ decisionPrice: r.last, decisionAt: r.at, atr: r.atr, sessionBars, prevClose: r.prevClose });
      if (label) { grades[`${r.ticker}|${r.at}`] = { ticker: r.ticker, at: r.at, sampleProb: r.sampleProb, label }; graded++; }
    }
  }
  await writeJSON(gradesKey(date), { date, grades, updatedAt: new Date().toISOString() }, 0);
  const remaining = day.rows.filter(r => !grades[`${r.ticker}|${r.at}`] && r.last > 0 && r.atr > 0).length;
  return { ok: true, date, rows: day.rows.length, graded, failedFetch, remaining, gradedTotal: Object.keys(grades).length };
}

async function loadDatasetGrades(date) {
  if (!hasStore()) return { date, grades: {} };
  return await readJSON(gradesKey(date), { date, grades: {} }).catch(() => ({ date, grades: {} }));
}

module.exports = {
  DATASET_VERSION, NEG_RATE, AT_RISK, MAX_ROWS_PER_SCAN,
  bucketOf, fnv1a, isAtRisk, sampleDecision, buildScanRows,
  appendScanRows, loadDatasetDay, gradeDatasetDay, loadDatasetGrades,
};

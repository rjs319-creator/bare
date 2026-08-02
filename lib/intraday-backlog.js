'use strict';
// GRADING BACKLOG — cursor + retry index over the PIT dataset's per-date grading state.
//
// THE DEFECT THIS CLOSES. Post-close grading ran as a fixed number of bounded passes against
// TODAY only: an incomplete day (fetch failures, >240 tickers, a missed workflow run) was
// never revisited, so rows silently stayed unlabeled forever. This module keeps a small
// backlog doc of every captured dataset date and drives bounded grading passes across the
// OLDEST incomplete dates first, until each reaches remaining=0, becomes terminally
// unavailable (per-ticker attempt ceilings inside gradeDatasetDay), or ages past the
// RETENTION window (the free 5-minute-bar feed only serves ~5 trailing days — beyond that,
// grading that date is impossible and pretending otherwise would burn every pass forever).
//
// Nothing here fabricates a label; it only schedules honest, bounded retries.

const { readJSON, writeJSON, hasStore } = require('./store');
const { gradeDatasetDay } = require('./intraday-dataset');

const BACKLOG_KEY = 'lifecycle/daytrade/dataset/backlog.json';
const DATASET_PREFIX = 'lifecycle/daytrade/dataset/';
const RETENTION_DAYS = 5;        // free feed serves ~5 trailing days of 5-minute bars
const DEFAULT_MAX_DATES = 3;     // dates touched per invocation (each pass stays bounded)

// Discover every date that has a dataset index blob. Best-effort: listing failure returns []
// and the backlog simply grows on the next successful pass.
async function listDatasetDates() {
  if (!hasStore()) return [];
  try {
    const { list } = require('@vercel/blob');
    const dates = new Set();
    let cursor;
    do {
      const r = await list({ prefix: DATASET_PREFIX, cursor, limit: 1000 });
      for (const b of r.blobs || []) {
        const m = String(b.pathname || '').match(/dataset\/(\d{4}-\d{2}-\d{2})\//);
        if (m) dates.add(m[1]);
      }
      cursor = r.cursor;
    } while (cursor);
    return [...dates].sort();
  } catch { return []; }
}

const ageDays = (date, now) => Math.floor((now.getTime() - Date.parse(`${date}T12:00:00Z`)) / 86400000);

// One backlog pass: refresh the date index, then grade up to `maxDates` of the oldest
// incomplete dates with a bounded per-date ticker `limit`. Injectable deps (including the
// store) so tests can drive the full retry/expiry flow hermetically.
async function gradeDatasetBacklog({
  limit = 40, maxDates = DEFAULT_MAX_DATES, now = new Date(),
  gradeDay = gradeDatasetDay, listDates = listDatasetDates, fetchFiveMin = null,
  store = null,
} = {}) {
  const S = store || { readJSON, writeJSON, hasStore };
  if (!S.hasStore()) return { ok: false, reason: 'no-store' };

  const doc = await S.readJSON(BACKLOG_KEY, { dates: {} }).catch(() => ({ dates: {} }));
  const entries = doc.dates || {};
  for (const d of await listDates()) {
    if (!entries[d]) entries[d] = { status: 'pending', attempts: 0, remaining: null };
  }

  // Expire dates past the bar-retention window — their ungraded rows are terminally
  // unavailable, recorded as such rather than retried forever or silently forgotten.
  for (const [d, e] of Object.entries(entries)) {
    if (e.status === 'pending' && ageDays(d, now) > RETENTION_DAYS) {
      entries[d] = { ...e, status: 'expired', expiredAt: now.toISOString() };
    }
  }

  const todo = Object.keys(entries).filter(d => entries[d].status === 'pending').sort().slice(0, maxDates);
  const passes = [];
  for (const d of todo) {
    const r = await gradeDay(d, { limit, ...(fetchFiveMin ? { fetchFiveMin } : {}) });
    passes.push({ date: d, ...r });
    entries[d] = {
      ...entries[d],
      attempts: (entries[d].attempts || 0) + 1,
      lastAt: now.toISOString(),
      remaining: r.remaining ?? null,
      ungradeable: r.ungradeable ?? null,
      terminalTickers: r.terminalTickers ?? null,
      gradedTotal: r.gradedTotal ?? null,
      status: r.ok && (r.remaining === 0) ? 'complete' : 'pending',
    };
  }

  await S.writeJSON(BACKLOG_KEY, { dates: entries, updatedAt: now.toISOString() }, 0).catch(() => {});
  const counts = { pending: 0, complete: 0, expired: 0 };
  for (const e of Object.values(entries)) counts[e.status] = (counts[e.status] || 0) + 1;
  const remainingTotal = Object.values(entries)
    .filter(e => e.status === 'pending')
    .reduce((s, e) => s + (Number.isFinite(e.remaining) ? e.remaining : 0), 0);
  return { ok: true, passes, backlog: counts, remaining: remainingTotal };
}

async function readBacklog() {
  if (!hasStore()) return null;
  return await readJSON(BACKLOG_KEY, null).catch(() => null);
}

module.exports = { BACKLOG_KEY, RETENTION_DAYS, DEFAULT_MAX_DATES, listDatasetDates, gradeDatasetBacklog, readBacklog, ageDays };

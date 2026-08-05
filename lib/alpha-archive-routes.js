'use strict';
// ALPHA-ARCHIVE ROUTE HANDLERS — the three archive-first collection streams
// (op=calarchive / op=revarchive / op=gexarchive). See lib/alpha-archive.js for
// what each stream is for and why it must run DAILY (unrecoverable data).
//
// All three are PRIVILEGED (cron/manual-with-bearer): they are state-changing
// Blob writes. All storage is date-keyed write-once shards — deliberately NO
// read-modify-write anywhere (the apex/insider.json lost-update race is the
// documented failure mode this layout avoids). Overlap between daily pulls is
// resolved at READ time by the identity keys in alpha-archive.js.
const { nowET } = require('./stats');
const { hasStore, writeCalArchiveDay, writeCalRevDay, readCalArchiveDay, listCalArchiveDates,
        writeRevArchiveDay, writeGexArchiveShard } = require('./store');
const { diffCalendarSnapshots, nameGexRecord, dedupeEvents,
        gradeEventKey, targetEventKey, compactGradeEvent, compactTargetEvent } = require('./alpha-archive');

const FMP = () => process.env.FMP_API_KEY;

// Retries with growing pauses: these ops run inside the 22:00 UTC cron burst
// where altprobes alone drains ~450 sequential FMP calls, so transient 429s are
// EXPECTED — and the first live cron (2026-08-05) proved 2 tries insufficient:
// revarchive lost its whole day to the burst while calarchive (first in the
// chain) squeaked through. 4 tries with 2.5s/5s/7.5s pauses rides out a burst
// window ~15s long per call; a lost calendar day is unrecoverable, and a lost
// revarchive day is recoverable only while the feed's ~3-day depth covers it.
async function fetchJsonRetry(url, { tries = 4, pauseMs = 2500 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        const j = await r.json();
        if (Array.isArray(j)) return j;
      }
    } catch { /* retry below */ }
    if (i < tries - 1) await new Promise(res => setTimeout(res, pauseMs * (i + 1)));
  }
  return null;                                  // null ≠ [] — callers must not treat a failed fetch as "empty day"
}

// ── op=calarchive : snapshot the forward earnings calendar + diff ───────────
// FMP caps rows per call, so the 90-day forward window is pulled in 30-day
// chunks (the same workaround op=pead needed). Rows are compacted to
// { s, d, eps, rev, lu } before persisting.
const CAL_FORWARD_DAYS = 90;
const CAL_CHUNK_DAYS = 30;

async function fetchForwardCalendar(fromDate) {
  const from = new Date(`${fromDate}T00:00:00Z`);
  const rows = [];
  for (let off = 0; off < CAL_FORWARD_DAYS; off += CAL_CHUNK_DAYS) {
    const a = new Date(from.getTime() + off * 86_400_000).toISOString().slice(0, 10);
    const b = new Date(from.getTime() + Math.min(off + CAL_CHUNK_DAYS - 1, CAL_FORWARD_DAYS) * 86_400_000).toISOString().slice(0, 10);
    const j = await fetchJsonRetry(`https://financialmodelingprep.com/stable/earnings-calendar?from=${a}&to=${b}&apikey=${FMP()}`);
    if (j === null) return null;                // a missing chunk would fake mass "removals" in the diff
    for (const r of j) {
      const s = String(r.symbol || '').toUpperCase();
      if (!s || !r.date) continue;
      rows.push({ s, d: String(r.date).slice(0, 10), eps: r.epsEstimated ?? null, rev: r.revenueEstimated ?? null, lu: r.lastUpdated || null });
    }
  }
  return rows;
}

async function runCalArchive(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured', op: 'calarchive' });
  if (!FMP()) return res.status(200).json({ ok: false, error: 'FMP_API_KEY required', op: 'calarchive' });
  const t0 = Date.now();
  const { date } = nowET();                     // ET date keys the snapshot — one per calendar day

  const rows = await fetchForwardCalendar(date);
  if (rows === null) {
    // 503 (not 200+ok:false): the warmchain runner classifies steps by HTTP
    // status, so a silent-200 failure is invisible in op=health — the exact
    // blind spot the first live cron exposed on revarchive.
    return res.status(503).json({ ok: false, op: 'calarchive', date, error: 'calendar fetch failed (after retries) — no snapshot written' });
  }

  await writeCalArchiveDay(date, { date, rows });

  // Diff against the most recent PRIOR snapshot (usually yesterday; after a
  // missed day, the gap widens and the diff simply spans it — still valid,
  // observedAt records when WE saw the change, which is the PIT truth here).
  const dates = (await listCalArchiveDates()).filter(d => d < date).sort();
  const prevDate = dates.length ? dates[dates.length - 1] : null;
  let diff = null;
  if (prevDate) {
    const prev = await readCalArchiveDay(prevDate);
    if (prev && Array.isArray(prev.rows)) {
      diff = diffCalendarSnapshots(prev.rows, rows, { prevObservedAt: prevDate, observedAt: date });
      await writeCalRevDay(date, { date, prevSnapshotDate: prevDate, ...diff });
    }
  }
  return res.status(200).json({
    ok: true, op: 'calarchive', date, rows: rows.length, prevSnapshotDate: prevDate,
    revisions: diff ? diff.revisions.length : null, compared: diff ? diff.compared : null,
    addedCount: diff ? diff.addedCount : null, removedCount: diff ? diff.removedCount : null,
    firstSnapshot: !prevDate, elapsedMs: Date.now() - t0,
  });
}

// ── op=revarchive : analyst grade + price-target event feeds ────────────────
// Fixed page sweep (no cursor state — overlap dedups at read time). 3×250 per
// feed covers well over a typical day's event volume; `oldestFetched` in the
// telemetry makes any under-coverage visible rather than silent.
const REV_PAGES = 3, REV_PAGE_LIMIT = 250;

async function fetchEventFeed(path) {
  const rows = [];
  for (let p = 0; p < REV_PAGES; p++) {
    const j = await fetchJsonRetry(`https://financialmodelingprep.com/stable/${path}?page=${p}&limit=${REV_PAGE_LIMIT}&apikey=${FMP()}`);
    if (j === null) return rows.length ? rows : null;   // keep partial coverage, but never fake an empty day
    rows.push(...j);
    if (j.length < REV_PAGE_LIMIT) break;       // feed exhausted
  }
  return rows;
}

async function runRevArchive(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured', op: 'revarchive' });
  if (!FMP()) return res.status(200).json({ ok: false, error: 'FMP_API_KEY required', op: 'revarchive' });
  const t0 = Date.now();
  const { date } = nowET();

  const [gradesRaw, targetsRaw] = [await fetchEventFeed('grades-latest-news'), await fetchEventFeed('price-target-latest-news')];
  if (gradesRaw === null && targetsRaw === null) {
    // 503 so the warmchain report shows the starvation (see runCalArchive).
    return res.status(503).json({ ok: false, op: 'revarchive', date, error: 'both event feeds failed (after retries) — no shard written' });
  }
  const grades = dedupeEvents((gradesRaw || []).map(compactGradeEvent), gradeEventKey);
  const targets = dedupeEvents((targetsRaw || []).map(compactTargetEvent), targetEventKey);
  const oldest = (rows) => rows.length ? rows.reduce((m, r) => (r.publishedDate < m ? r.publishedDate : m), rows[0].publishedDate) : null;

  await writeRevArchiveDay(date, { date, grades, targets });
  return res.status(200).json({
    ok: true, op: 'revarchive', date, grades: grades.length, targets: targets.length,
    oldestGrade: oldest(grades), oldestTarget: oldest(targets),
    gradesFeedOk: gradesRaw !== null, targetsFeedOk: targetsRaw !== null,
    elapsedMs: Date.now() - t0,
  });
}

// ── op=gexarchive : per-name dealer-gamma snapshots, sliced ─────────────────
// The universe (~700 optionable-priority names) cannot fit one invocation, so
// the warmchain runs slice=0..2 in SEPARATE invocations (each with its own
// budget). The slice partition is deterministic per day: fixed priority order
// (liquid-options names first — they must never be the ones a timeout drops),
// contiguous ranges.
const GEX_SLICES = 3;
const GEX_DEADLINE_MS = 38_000;                 // leave headroom under the 60s function wall
const GEX_CONCURRENCY = 6;
const GEX_EXTRA_EXPIRY_TARGETS = [30];          // nearest expiry + one ~monthly

function gexUniverse() {
  const { LIQUID_OPTIONS } = require('./optionsflow');
  const { LARGE, SMALL_CAPS } = require('./universe');
  const seen = new Set(); const out = [];
  for (const t of [...LIQUID_OPTIONS, ...LARGE, ...SMALL_CAPS]) {
    const s = String(t || '').toUpperCase();
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

function sliceOf(list, slice, of) {
  const per = Math.ceil(list.length / of);
  return list.slice(slice * per, (slice + 1) * per);
}

async function runGexArchive(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured', op: 'gexarchive' });
  const t0 = Date.now();
  const { date, isMarketClosed } = nowET();
  // Closed sessions re-serve stale chains — skipping keeps the per-name daily
  // series one-observation-per-trading-day (same rule as op=archive).
  if (isMarketClosed && req.query.force !== '1') {
    return res.status(200).json({ ok: true, op: 'gexarchive', skipped: 'market-closed', date });
  }
  const of = Math.max(1, parseInt(req.query.of, 10) || GEX_SLICES);
  const slice = Math.min(of - 1, Math.max(0, parseInt(req.query.slice, 10) || 0));
  const names = sliceOf(gexUniverse(), slice, of);

  const { fetchChainMultiExpiry } = require('./options-baseline');
  const nowSec = Date.now() / 1000;
  const records = [];
  let idx = 0, noChain = 0, truncatedAt = null;
  const worker = async () => {
    while (idx < names.length) {
      if (Date.now() - t0 > GEX_DEADLINE_MS) { if (truncatedAt == null) truncatedAt = idx; return; }
      const t = names[idx++];
      try {
        const chain = await fetchChainMultiExpiry(t, { targets: GEX_EXTRA_EXPIRY_TARGETS, maxExtra: 1 });
        const rec = chain ? nameGexRecord(t, chain, nowSec) : null;
        if (rec) records.push(rec); else noChain++;
      } catch { noChain++; }
    }
  };
  await Promise.all(Array.from({ length: GEX_CONCURRENCY }, worker));

  await writeGexArchiveShard(date, slice, {
    date, slice, of, sliceNames: names.length, captured: records.length,
    noChain, truncatedAt,                       // truncation is RECORDED, never silent
    records,
  });
  return res.status(200).json({
    ok: true, op: 'gexarchive', date, slice, of, sliceNames: names.length,
    captured: records.length, noChain, truncatedAt, elapsedMs: Date.now() - t0,
  });
}

// ── op=archivehealth : PUBLIC counts-only telemetry ─────────────────────────
// The preregistration REQUIRES data-quality monitoring of the archive streams
// and simultaneously PROHIBITS outcome-shaped reads before each earliest-test
// condition. This view resolves that tension: it exposes ONLY shard counts,
// dates and row totals — no symbols, no revision directions, no gex values —
// so it can never constitute a peek. It is deliberately the only public read
// over the archive prefixes.
async function runArchiveHealth(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured', op: 'archivehealth' });
  const { archiveShardPaths, latestBlobDoc } = require('./store');
  const t0 = Date.now();
  const p = await archiveShardPaths();
  const [snap, rev, ra, gexDocsLatest] = await Promise.all([
    latestBlobDoc(p.snaps), latestBlobDoc(p.revs), latestBlobDoc(p.revarch), latestBlobDoc(p.gex),
  ]);
  const latestDateOf = (blobs, prefixLen) => (blobs.length
    ? [...blobs].sort((a, b) => (a.pathname < b.pathname ? -1 : 1)).pop().pathname.slice(prefixLen, prefixLen + 10)
    : null);
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
  return res.status(200).json({
    ok: true, op: 'archivehealth',
    calarchive: {
      snapshots: p.snaps.length, latestDate: latestDateOf(p.snaps, 'calarchive/'.length),
      latestRows: snap && Array.isArray(snap.rows) ? snap.rows.length : null,
      revisionDays: p.revs.length,
      latestRevisions: rev && Array.isArray(rev.revisions) ? rev.revisions.length : null,
      latestCompared: rev ? rev.compared ?? null : null,
    },
    revarchive: {
      days: p.revarch.length, latestDate: latestDateOf(p.revarch, 'revarchive/'.length),
      latestGrades: ra && Array.isArray(ra.grades) ? ra.grades.length : null,
      latestTargets: ra && Array.isArray(ra.targets) ? ra.targets.length : null,
    },
    gexarchive: {
      shards: p.gex.length, latestDate: latestDateOf(p.gex, 'gexarchive/'.length),
      latestShardCaptured: gexDocsLatest ? gexDocsLatest.captured ?? null : null,
      latestShardNoChain: gexDocsLatest ? gexDocsLatest.noChain ?? null : null,
      latestShardTruncatedAt: gexDocsLatest ? gexDocsLatest.truncatedAt ?? null : null,
    },
    elapsedMs: Date.now() - t0,
  });
}

module.exports = { runCalArchive, runRevArchive, runGexArchive, runArchiveHealth, fetchForwardCalendar, gexUniverse, sliceOf };

'use strict';
// FINRA REG SHO DAILY SHORT VOLUME — routes (shadow feature feed; weight 0).
//
//   op=shortvol[&symbol=X]  public read  — per-symbol short-volume ratio / 20d z / exempt
//                                          spike from the rolling doc, or the feed summary
//   op=shortvoltick         PRIVILEGED   — nightly: ONE ~0.5 MB download per missing session
//                                          (newest first, ≤5 back), per-day shard + CAS
//                                          append to the compact 30-day rolling doc
//
// Budgeted by TIME, not count: each day persists fully (shard, then rolling doc) before
// the next is attempted, so a budget skip leaves a consistent store and the next run
// back-fills what was skipped. The rolling doc is multi-writer-safe via updateJSON (CAS).
// FINRA publishes the file in the evening; a day that is not there yet answers 403 and is
// simply retried on the next tick. Terms: see lib/finra-shortvol.js header (non-commercial).

const STORE = require('./store');
const SV = require('./finra-shortvol');
const { fetchWithTimeout } = require('./http');
const { logWarn } = require('./log');

const TICK_DEADLINE_MS = 60_000;      // well inside the 300s function wall; one file is ~1–3s
const LOOKBACK_SESSIONS = 5;          // self-healing window for missed/late files
const FETCH_TIMEOUT_MS = 20_000;
const NO_FILE_STATUSES = new Set([403, 404]);

const noStore = (res) => res.setHeader('Cache-Control', 'no-store');
const cached = (res, s = 600) => res.setHeader('Cache-Control', `s-maxage=${s}, stale-while-revalidate=600`);

function defaultUniverse() {
  const U = require('./universe');
  return [...new Set([...U.LARGE, ...U.SMALL_CAPS, ...U.MICRO_CAPS, ...U.BIOTECH])];
}

async function defaultFetchText(url) {
  const r = await fetchWithTimeout(url, { timeoutMs: FETCH_TIMEOUT_MS, retries: 1, headers: { Accept: 'text/plain' } });
  return { ok: r.ok, status: r.status, text: r.ok ? await r.text() : '' };
}

// One session: fetch → validate → shard → rolling. Returns the outcome record for the report.
async function ingestDay(date, { store, fetchText, universe, now }) {
  const r = await fetchText(SV.urlFor(date));
  if (!r.ok) return { date, status: NO_FILE_STATUSES.has(r.status) ? 'no-file' : `http:${r.status}` };
  const parsed = SV.parseShortVolumeFile(r.text, { expectedDate: date });
  if (!parsed.ok) return { date, status: `invalid:${parsed.reason}`, health: parsed.health };
  const fetchedAt = new Date(now()).toISOString();
  const shard = SV.buildDayShard({ date, rows: parsed.rows, fetchedAt, sourceHash: SV.sourceHash(r.text), universe });
  await store.writeJSON(SV.shardPath(date), shard, 0);
  const up = await store.updateJSON(SV.ROLLING_PATH, (cur) => ({
    ...SV.appendRollingDay(cur, { date, rows: parsed.rows, universe, hypothesis: shard.hypothesis }), updatedAt: fetchedAt,
  }), { initial: null });
  return { date, status: 'written', rows: parsed.rows.length, universe: shard.counts.universe, topDecile: shard.hypothesis.topDecile.length, rollingAttempts: up.attempts, health: parsed.health };
}

/**
 * The tick. Every side effect is injectable so tests drive it without a network or Blob.
 * Dates are UTC weekdays ≤ today; the file for "today" exists only after FINRA posts it.
 */
async function tickCore({ store = STORE, fetchText = defaultFetchText, universe = defaultUniverse(), now = Date.now, deadlineMs = TICK_DEADLINE_MS, lookback = LOOKBACK_SESSIONS } = {}) {
  const t0 = now();
  const today = new Date(t0).toISOString().slice(0, 10);
  const rolling = await store.readJSON(SV.ROLLING_PATH, null);
  const candidates = SV.missingDates(rolling, SV.recentWeekdays(today, lookback));
  const processed = [];
  const skipped = [];
  for (const date of candidates) {
    if (now() - t0 > deadlineMs) { skipped.push(date); continue; }
    try {
      processed.push(await ingestDay(date, { store, fetchText, universe, now }));
    } catch (e) {
      // One bad day must not cost the rest; it stays missing and is retried next tick.
      logWarn('shortvol tick: day failed', { date, error: String((e && e.message) || e).slice(0, 160) });
      processed.push({ date, status: 'error', error: String((e && e.message) || e).slice(0, 160) });
    }
  }
  return {
    ok: processed.every((p) => p.status !== 'error') && skipped.length === 0,
    version: SV.FINRA_SHORTVOL_VERSION, today, candidates, processed, skipped,
    written: processed.filter((p) => p.status === 'written').map((p) => p.date),
    rollingDays: ((rolling && rolling.dates) || []).length + processed.filter((p) => p.status === 'written').length,
    ms: now() - t0,
  };
}

async function runShortVolTick(req, res) {
  noStore(res);
  if (!STORE.hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  try {
    return res.status(200).json(await tickCore({}));
  } catch (e) {
    return res.status(502).json({ ok: false, error: `shortvol tick failed: ${String((e && e.message) || e)}` });
  }
}

async function runShortVol(req, res, store = STORE) {
  if (!store.hasStore()) { noStore(res); return res.status(200).json({ ok: false, error: 'Blob storage not configured.' }); }
  const doc = await store.readJSON(SV.ROLLING_PATH, null);
  const summary = SV.summaryOf(doc);
  const symbol = req.query && req.query.symbol ? SV.normalizeSymbol(req.query.symbol) : null;
  const envelope = {
    ok: true, state: 'SHADOW', weight: 0, version: SV.FINRA_SHORTVOL_VERSION, source: SV.SOURCE,
    disclosure: 'FINRA daily short-sale volume is a liquidity/positioning FEATURE, not short interest and not a score input. The top-decile hypothesis is a weight-0 preregistered shadow (hypothesis-registry short-volume-ratio-top-decile). Personal, non-commercial use of FINRA data.',
  };
  if (!summary.days) { noStore(res); return res.status(200).json({ ...envelope, ok: false, reason: 'no short-volume history yet — op=shortvoltick has not written a day', summary }); }
  if (req.query && req.query.symbol && !symbol) { noStore(res); return res.status(400).json({ ...envelope, ok: false, reason: 'bad symbol' }); }
  if (symbol) {
    const features = SV.featuresFor(doc, symbol);
    if (!features) { noStore(res); return res.status(200).json({ ...envelope, ok: false, symbol, reason: 'symbol not in the tracked universe or no observations yet', summary }); }
    cached(res);
    return res.status(200).json({ ...envelope, symbol, features, summary });
  }
  cached(res);
  return res.status(200).json({ ...envelope, summary, dates: doc.dates });
}

module.exports = { runShortVol, runShortVolTick, tickCore, ingestDay, TICK_DEADLINE_MS, LOOKBACK_SESSIONS, NO_FILE_STATUSES };

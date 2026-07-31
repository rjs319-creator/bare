'use strict';
// SCHEDULER-INDEPENDENT SCAN RUNNER — a reusable, lockable, idempotent entry point an
// EXTERNAL scheduler can call (op=daytradescan) so discovery + dataset capture run on a
// steady cadence even when nobody has the page open.
//
// HONESTY. This deployment (Vercel Hobby) has ONE daily cron and no intraday scheduler —
// this module does NOT pretend otherwise. Without an external scheduler the system runs in
// the documented DEGRADED mode (request-driven scans while the page is open, nothing when
// closed) and the health doc says so plainly. Wiring an external scheduler (cron-job.org,
// GitHub Actions schedule, an upgraded plan's cron — see DAYTRADE-PREDICTIVE.md) is a
// deliberate, authorized step; nothing here provisions paid infrastructure.
//
// Guarantees:
//   • LOCK: a best-effort Blob lease so overlapping invocations don't double-scan.
//   • IDEMPOTENCY: a success within MIN_INTERVAL_MS short-circuits (safe to over-schedule).
//   • HEALTH: last run/success/error timestamps + gap diagnostics (missed-scan estimate),
//     so "was the scanner actually running?" has a factual answer every day.

const { readJSON, writeJSON, hasStore } = require('./store');

const LOCK_KEY = 'lifecycle/daytrade/scan-runner-lock.json';
const HEALTH_KEY = 'lifecycle/daytrade/scan-runner-health.json';
const LOCK_TTL_MS = 55 * 1000;      // a cycle far exceeding this is presumed dead — lease expires
const MIN_INTERVAL_MS = 40 * 1000;  // idempotency window (schedule every 1–5 min safely)
const TARGET_INTERVAL_MS = 60 * 1000;   // the cadence health diagnostics judge gaps against

async function readHealth() {
  if (!hasStore()) return null;
  return await readJSON(HEALTH_KEY, null).catch(() => null);
}

// One scan cycle. Injectable `scan` for tests (defaults to the real discovery scan, which
// also performs the PIT dataset capture as a side effect).
async function runScanCycle({ now = new Date(), scan = null } = {}) {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const doScan = scan || (o => require('./intraday-discovery').runDiscoveryScan(o));

  let health = (await readHealth()) || { lastRunAt: null, lastSuccessAt: null, lastError: null, consecutiveErrors: 0, missedScanEstimate: 0 };

  // Idempotency: a recent success means an overlapping scheduler tick has nothing to do.
  if (health.lastSuccessAt && nowMs - Date.parse(health.lastSuccessAt) < MIN_INTERVAL_MS) {
    return { ok: true, skipped: 'recent-success', lastSuccessAt: health.lastSuccessAt };
  }

  // Best-effort lease (Blob has no CAS — a rare double-scan is harmless and documented;
  // the dataset bucket write is itself write-once, so capture stays idempotent).
  if (hasStore()) {
    const lock = await readJSON(LOCK_KEY, null).catch(() => null);
    if (lock && lock.until && Date.parse(lock.until) > nowMs) {
      return { ok: true, skipped: 'locked', lockedUntil: lock.until };
    }
    try { await writeJSON(LOCK_KEY, { at: nowIso, until: new Date(nowMs + LOCK_TTL_MS).toISOString() }, 0); } catch { /* proceed unlocked */ }
  }

  // Missed-scan diagnostics: how many target intervals elapsed silently since last success?
  const gapMs = health.lastSuccessAt ? nowMs - Date.parse(health.lastSuccessAt) : null;
  const missedThisGap = gapMs != null ? Math.max(0, Math.floor(gapMs / TARGET_INTERVAL_MS) - 1) : 0;

  let result = null, error = null;
  try { result = await doScan({ now }); } catch (e) { error = String((e && e.message) || e); }
  const succeeded = !!(result && result.ok);

  health = {
    lastRunAt: nowIso,
    lastSuccessAt: succeeded ? nowIso : health.lastSuccessAt,
    lastError: succeeded ? null : (error || (result && result.note) || 'scan returned not-ok'),
    lastErrorAt: succeeded ? health.lastErrorAt || null : nowIso,
    consecutiveErrors: succeeded ? 0 : (health.consecutiveErrors || 0) + 1,
    lastGapMin: gapMs != null ? +(gapMs / 60000).toFixed(1) : null,
    missedScanEstimate: (health.missedScanEstimate || 0) + missedThisGap,
    lastSession: result ? result.session : null,
    lastAnomalies: result && result.anomalies ? result.anomalies.length : null,
    lastScanned: result ? result.scanned : null,
    targetIntervalMs: TARGET_INTERVAL_MS,
  };
  if (hasStore()) {
    try { await writeJSON(HEALTH_KEY, health, 0); } catch { /* health is diagnostics, not control flow */ }
    try { await writeJSON(LOCK_KEY, { at: nowIso, until: null }, 0); } catch { /* lease expires anyway */ }
  }
  return { ok: succeeded, skipped: null, session: result ? result.session : null, anomalies: result && result.anomalies ? result.anomalies.length : 0, missedThisGap, health };
}

// op=daytradescan — the external-scheduler entry point (privileged: it writes state).
async function runScanRunner(req, res) {
  const out = await runScanCycle({ now: new Date() });
  res.setHeader('Cache-Control', 'no-store');
  return res.status(out.ok || out.skipped ? 200 : 503).json({
    ...out,
    degradedMode: !hasStore() ? 'no durable store — scans cannot persist interval state' : undefined,
    honesty: 'Scans run ONLY when something invokes this op (or op=discover / the Day Trade page). No external scheduler is configured by default — until one calls this endpoint on a cadence, intraday coverage is request-driven and the health doc records the gaps honestly.',
  });
}

// op=daytradescanhealth — read-only health/last-success view (public, cacheable briefly).
async function runScanHealth(req, res) {
  const health = await readHealth();
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  return res.json({
    ok: true,
    configured: hasStore(),
    health: health || null,
    note: health && health.lastSuccessAt
      ? null
      : 'No scan-runner successes recorded — either no external scheduler is configured (documented degraded mode) or storage is unconfigured.',
  });
}

module.exports = { runScanCycle, runScanRunner, runScanHealth, readHealth, LOCK_KEY, HEALTH_KEY, MIN_INTERVAL_MS, LOCK_TTL_MS };

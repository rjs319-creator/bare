'use strict';
// SCHEDULER-INDEPENDENT SCAN RUNNER — a reusable, lockable, idempotent entry point an
// EXTERNAL scheduler can call (op=daytradescan) so discovery + dataset capture run on a
// steady cadence even when nobody has the page open.
//
// HONESTY. This deployment (Vercel Hobby) has ONE daily cron and no intraday scheduler —
// this module does NOT pretend otherwise. Without an external scheduler the system runs in
// the documented DEGRADED mode (request-driven scans while the page is open, nothing when
// closed) and the health doc says so plainly. The deployed scheduler is GitHub Actions at a
// 5-minute cadence (.github/workflows/daytrade-scan.yml) — the health target interval below
// matches it and is env-overridable, so cadence bookkeeping and the real scheduler cannot
// silently disagree again (they did: a hardcoded 60s target fabricated 4 "missed scans" per
// healthy 5-minute tick, plus hundreds more per overnight/weekend gap).
//
// Guarantees:
//   • LOCK: a best-effort Blob lease so overlapping invocations don't double-scan.
//   • IDEMPOTENCY: a success within MIN_INTERVAL_MS short-circuits (safe to over-schedule).
//   • HEALTH: last run/success/error timestamps + gap diagnostics where a "miss" is only
//     counted against SCANNABLE session time (regular hours + premarket when enabled),
//     never against nights/weekends, and the estimate resets each ET session date.

const { readJSON, writeJSON, hasStore } = require('./store');
const { sessionOf } = require('./lifecycle-eval');
const { etDate } = require('./freshness');
const { DISCOVERY } = require('./daytrade-config');

const LOCK_KEY = 'lifecycle/daytrade/scan-runner-lock.json';
const HEALTH_KEY = 'lifecycle/daytrade/scan-runner-health.json';
const LOCK_TTL_MS = 55 * 1000;      // a cycle far exceeding this is presumed dead — lease expires
const MIN_INTERVAL_MS = 40 * 1000;  // idempotency window (schedule every 1–5 min safely)
const DEFAULT_TARGET_INTERVAL_MS = 5 * 60 * 1000;   // deployed GitHub Actions cadence (*/5)
const STALE_AFTER_INTERVALS = 3;    // in-session, no success for 3× target ⇒ health is STALE
const MAX_GAP_WALK_DAYS = 14;       // bound the session-minute walk over pathological gaps

// Cadence the health diagnostics judge gaps against. Config-driven so a scheduler change is
// a one-variable change, not a code hunt. Falls back to the deployed 5-minute cadence.
function targetIntervalMs() {
  const env = parseInt(process.env.DAYTRADE_SCAN_INTERVAL_MS || '', 10);
  return Number.isFinite(env) && env >= 30 * 1000 ? env : DEFAULT_TARGET_INTERVAL_MS;
}

// Is this instant one the scheduler is expected to cover? Regular hours always; premarket
// only when premarket discovery is enabled. After-hours/closed time is NEVER a miss.
function isScannable(at) {
  const s = sessionOf(at instanceof Date ? at : new Date(at));
  if (s === 'regular') return true;
  return s === 'premarket' && !!(DISCOVERY && DISCOVERY.PREMARKET && DISCOVERY.PREMARKET.ENABLED);
}

// Milliseconds of SCANNABLE session time between two instants (minute-resolution walk,
// EST/EDT-safe via sessionOf). A weekend gap contributes 0; a mid-session outage
// contributes exactly the session minutes it actually covered.
function scannableMsBetween(fromMs, toMs) {
  if (!(toMs > fromMs)) return 0;
  const start = Math.max(fromMs, toMs - MAX_GAP_WALK_DAYS * 24 * 3600 * 1000);
  let ms = 0;
  for (let t = start; t < toMs; t += 60 * 1000) {
    if (isScannable(new Date(t))) ms += Math.min(60 * 1000, toMs - t);
  }
  return ms;
}

async function readHealth(store = null) {
  const S = store || { readJSON, hasStore };
  if (!S.hasStore()) return null;
  return await S.readJSON(HEALTH_KEY, null).catch(() => null);
}

// One scan cycle. Injectable `scan` and `store` for tests (defaults to the real discovery
// scan, which also performs the PIT dataset capture as a side effect).
async function runScanCycle({ now = new Date(), scan = null, store = null } = {}) {
  const S = store || { readJSON, writeJSON, hasStore };
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const doScan = scan || (o => require('./intraday-discovery').runDiscoveryScan(o));
  const targetMs = targetIntervalMs();

  let health = (await readHealth(S)) || { lastRunAt: null, lastSuccessAt: null, lastError: null, consecutiveErrors: 0, missedScanEstimate: 0 };

  // Idempotency: a recent success means an overlapping scheduler tick has nothing to do.
  if (health.lastSuccessAt && nowMs - Date.parse(health.lastSuccessAt) < MIN_INTERVAL_MS) {
    return { ok: true, skipped: 'recent-success', lastSuccessAt: health.lastSuccessAt };
  }

  // Best-effort lease (Blob has no CAS — a rare double-scan is harmless and documented;
  // the dataset bucket write is itself write-once, so capture stays idempotent).
  if (S.hasStore()) {
    const lock = await S.readJSON(LOCK_KEY, null).catch(() => null);
    if (lock && lock.until && Date.parse(lock.until) > nowMs) {
      return { ok: true, skipped: 'locked', lockedUntil: lock.until };
    }
    try { await S.writeJSON(LOCK_KEY, { at: nowIso, until: new Date(nowMs + LOCK_TTL_MS).toISOString() }, 0); } catch { /* proceed unlocked */ }
  }

  // Missed-scan diagnostics: how many target intervals of SCANNABLE time elapsed silently
  // since the last success? Off-session time (nights, weekends, after-hours) contributes
  // nothing, and the estimate is a per-ET-date figure, not an unbounded lifetime sum.
  const gapMs = health.lastSuccessAt ? nowMs - Date.parse(health.lastSuccessAt) : null;
  const scannableGapMs = gapMs != null ? scannableMsBetween(nowMs - gapMs, nowMs) : 0;
  const missedThisGap = Math.max(0, Math.floor(scannableGapMs / targetMs) - 1);
  const today = etDate(now);
  const priorMissed = health.missedScanDate === today ? (health.missedScanEstimate || 0) : 0;

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
    lastScannableGapMin: gapMs != null ? +(scannableGapMs / 60000).toFixed(1) : null,
    missedScanEstimate: priorMissed + missedThisGap,
    missedScanDate: today,
    lastSession: result ? result.session : null,
    lastAnomalies: result && result.anomalies ? result.anomalies.length : null,
    lastScanned: result ? result.scanned : null,
    targetIntervalMs: targetMs,
  };
  if (S.hasStore()) {
    try { await S.writeJSON(HEALTH_KEY, health, 0); } catch { /* health is diagnostics, not control flow */ }
    try { await S.writeJSON(LOCK_KEY, { at: nowIso, until: null }, 0); } catch { /* lease expires anyway */ }
  }
  return { ok: succeeded, skipped: null, session: result ? result.session : null, anomalies: result && result.anomalies ? result.anomalies.length : 0, missedThisGap, health };
}

// Health staleness verdict — pure so tests can drive it. A deployment whose privileged op
// has been 401-ing for a week must NOT look healthy: in-session, a lastSuccessAt older than
// STALE_AFTER_INTERVALS × target interval is reported STALE with an explicit reason.
function healthStatus(health, now = new Date()) {
  const targetMs = health && Number.isFinite(health.targetIntervalMs) ? health.targetIntervalMs : targetIntervalMs();
  if (!health || !health.lastSuccessAt) {
    return { status: 'never-succeeded', stale: true, reason: 'No scan-runner success has ever been recorded — scheduler unconfigured, CRON_SECRET missing/rejected, or storage unconfigured.' };
  }
  const ageMs = now.getTime() - Date.parse(health.lastSuccessAt);
  if (isScannable(now) && ageMs > STALE_AFTER_INTERVALS * targetMs) {
    return {
      status: 'stale', stale: true,
      lastSuccessAgeMin: +(ageMs / 60000).toFixed(1),
      reason: `In-session with no successful scan for ${(ageMs / 60000).toFixed(0)} min (target cadence ${(targetMs / 60000).toFixed(0)} min). Likely causes: scheduler stopped, CRON_SECRET missing or rejected (401/503 never reaches the runner, so lastRunAt freezes too), or upstream outage.`,
    };
  }
  return { status: 'ok', stale: false, lastSuccessAgeMin: +(ageMs / 60000).toFixed(1) };
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
// Also surfaces grading-backlog completeness so "is the learning loop actually fed?" has a
// factual answer in one place: scan coverage, dataset dates, per-date remaining labels.
async function runScanHealth(req, res) {
  const health = await readHealth();
  const verdict = healthStatus(health, new Date());
  let grading = null;
  try {
    const backlog = await require('./intraday-backlog').readBacklog();
    if (backlog && backlog.dates) {
      const entries = Object.entries(backlog.dates);
      grading = {
        dates: entries.length,
        pending: entries.filter(([, e]) => e.status === 'pending').length,
        complete: entries.filter(([, e]) => e.status === 'complete').length,
        expired: entries.filter(([, e]) => e.status === 'expired').length,
        remainingLabels: entries.filter(([, e]) => e.status === 'pending')
          .reduce((s, [, e]) => s + (Number.isFinite(e.remaining) ? e.remaining : 0), 0),
        updatedAt: backlog.updatedAt || null,
      };
    }
  } catch { /* grading summary is diagnostics — absence is reported as null, not faked */ }
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  return res.json({
    ok: true,
    configured: hasStore(),
    status: verdict.status,
    stale: verdict.stale,
    health: health || null,
    grading,
    note: verdict.stale ? verdict.reason : null,
  });
}

module.exports = {
  runScanCycle, runScanRunner, runScanHealth, readHealth, healthStatus,
  targetIntervalMs, isScannable, scannableMsBetween,
  LOCK_KEY, HEALTH_KEY, MIN_INTERVAL_MS, LOCK_TTL_MS, DEFAULT_TARGET_INTERVAL_MS, STALE_AFTER_INTERVALS,
};

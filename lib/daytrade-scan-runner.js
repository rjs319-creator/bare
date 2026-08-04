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
const historyKey = date => `lifecycle/daytrade/scan-health/${date}.json`;   // durable per-scan history
const LOCK_TTL_MS = 55 * 1000;      // a cycle far exceeding this is presumed dead — lease expires
const MIN_INTERVAL_MS = 40 * 1000;  // idempotency window (schedule every 1–5 min safely)
const DEFAULT_TARGET_INTERVAL_MS = 5 * 60 * 1000;   // deployed GitHub Actions cadence (*/5)
const STALE_AFTER_INTERVALS = 3;    // in-session, no success for 3× target ⇒ health is STALE
const MAX_GAP_WALK_DAYS = 14;       // bound the session-minute walk over pathological gaps
const COVERAGE_MIN_PCT = 80;        // below this the scan ran but coverage is not trustworthy
const HISTORY_MAX_ENTRIES = 240;    // per-day cap: 6.5h regular + premarket at ~1-min page cadence

// Outcomes a scan that ACTUALLY scanned tickers with usable quotes can produce. Only these
// stamp lastSuccessAt — this is the fix for the false-success defect where the market-closed
// no-op counted as a success and an off-hours-only scanner read healthy forever.
const SUCCESS_OUTCOMES = ['ok', 'ok-zero-anomalies', 'warming', 'insufficient-coverage'];

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

// Coverage ratio as a percent (1 decimal), null-safe: a scan without coverage info (or with
// nothing requested) reports null, never a fake 0 or 100.
function coveragePctOf(coverage) {
  if (!coverage || !Number.isFinite(coverage.requested) || coverage.requested <= 0) return null;
  const returned = Number.isFinite(coverage.returned) ? coverage.returned : 0;
  return +((returned / coverage.requested) * 100).toFixed(1);
}

// ── Outcome taxonomy (pure) ─────────────────────────────────────────────────────
// Every scan cycle classifies into EXACTLY ONE outcome so the health doc and per-scan
// history speak a fixed vocabulary instead of free-text notes. Severity-ordered checks:
// a provider outage during warmup is an outage, not "warming".
//   'market-closed'         — idle by design (session gate); NOT a success, NOT an error
//   'no-baselines'          — cannot scan honestly (candle caches empty / storage missing)
//   'error'                 — scan threw or returned not-ok for any other reason
//   'provider-outage'       — quotes requested but ZERO returned
//   'insufficient-coverage' — scanned, but < COVERAGE_MIN_PCT% of requested quotes returned
//   'warming'               — valid scan, interval state reset (anomalies start next scan)
//   'ok-zero-anomalies'     — valid scan, genuinely nothing alarmed
//   'ok'                    — valid scan, ≥1 anomaly surfaced
function classifyScanOutcome(result) {
  if (!result) return 'error';                          // thrown scan — the caller passes null
  if (result.marketClosed) return 'market-closed';
  if (result.noBaselines) return 'no-baselines';
  if (!result.ok) return 'error';
  const requested = result.coverage && Number.isFinite(result.coverage.requested) ? result.coverage.requested : null;
  if (requested > 0) {
    if (!(result.coverage.returned > 0)) return 'provider-outage';
    const pct = coveragePctOf(result.coverage);
    if (pct != null && pct < COVERAGE_MIN_PCT) return 'insufficient-coverage';
  }
  if (result.warming) return 'warming';
  const anomalies = Array.isArray(result.anomalies) ? result.anomalies.length : 0;
  return anomalies === 0 ? 'ok-zero-anomalies' : 'ok';
}

// ── Health-doc reducer (pure) ───────────────────────────────────────────────────
// (prevHealth, scanResult) → { health, outcome, missedThisGap }. Extracted from runScanCycle
// so the success/idle/error bookkeeping is directly testable without storage. Key contract:
// market-closed updates lastIdleAt ONLY — it must never stamp lastSuccessAt (the old code
// did, so a scanner that only ever fired off-hours read healthy) and it neither increments
// nor resets consecutiveErrors (an off-hours tick says nothing about scan health).
function nextHealth(prevHealth, scanResult, { nowMs, durationMs = null, error = null, targetMs = null } = {}) {
  const prev = prevHealth || { lastRunAt: null, lastSuccessAt: null, lastError: null, consecutiveErrors: 0, missedScanEstimate: 0 };
  const target = Number.isFinite(targetMs) ? targetMs : targetIntervalMs();
  const now = new Date(nowMs);
  const nowIso = now.toISOString();
  const outcome = error ? 'error' : classifyScanOutcome(scanResult);
  const idle = outcome === 'market-closed';
  const succeeded = SUCCESS_OUTCOMES.includes(outcome);

  // Missed-scan diagnostics: how many target intervals of SCANNABLE time elapsed silently
  // since the last success? Off-session time (nights, weekends, after-hours) contributes
  // nothing, and the estimate is a per-ET-date figure, not an unbounded lifetime sum.
  const gapMs = prev.lastSuccessAt ? nowMs - Date.parse(prev.lastSuccessAt) : null;
  const scannableGapMs = gapMs != null ? scannableMsBetween(nowMs - gapMs, nowMs) : 0;
  const missedThisGap = Math.max(0, Math.floor(scannableGapMs / target) - 1);
  const today = etDate(now);
  const priorMissed = prev.missedScanDate === today ? (prev.missedScanEstimate || 0) : 0;

  const coverage = scanResult && scanResult.coverage ? {
    requested: scanResult.coverage.requested ?? null,
    returned: scanResult.coverage.returned ?? null,
    provider: scanResult.coverage.provider ?? null,
    volumeAvailable: scanResult.coverage.volumeAvailable ?? null,
  } : null;

  const health = {
    lastRunAt: nowIso,
    lastSuccessAt: succeeded ? nowIso : prev.lastSuccessAt || null,
    lastIdleAt: idle ? nowIso : prev.lastIdleAt || null,
    lastError: succeeded ? null
      : idle ? prev.lastError || null
      : (error || (scanResult && scanResult.note) || 'scan returned not-ok'),
    lastErrorAt: succeeded || idle ? prev.lastErrorAt || null : nowIso,
    consecutiveErrors: succeeded ? 0 : idle ? (prev.consecutiveErrors || 0) : (prev.consecutiveErrors || 0) + 1,
    lastGapMin: gapMs != null ? +(gapMs / 60000).toFixed(1) : null,
    lastScannableGapMin: gapMs != null ? +(scannableGapMs / 60000).toFixed(1) : null,
    missedScanEstimate: priorMissed + missedThisGap,
    missedScanDate: today,
    lastSession: scanResult ? scanResult.session : null,
    lastAnomalies: scanResult && scanResult.anomalies ? scanResult.anomalies.length : null,
    lastScanned: scanResult ? scanResult.scanned : null,
    // Per-scan reporting (previously discarded): coverage, universe, eligibility, duration,
    // note, outcome — so "the scan ran" and "the scan saw the market" stop being conflated.
    lastDurationMs: Number.isFinite(durationMs) ? durationMs : null,
    lastCoverage: coverage,
    lastCoveragePct: coveragePctOf(coverage),
    lastUniverse: scanResult && Number.isFinite(scanResult.universe) ? scanResult.universe : null,
    lastEligible: scanResult && Number.isFinite(scanResult.eligible) ? scanResult.eligible : null,
    lastNote: (scanResult && scanResult.note) || null,
    lastOutcome: outcome,
    nextExpectedAt: new Date(nowMs + target).toISOString(),
    targetIntervalMs: target,
  };
  return { health, outcome, missedThisGap };
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

  let result = null, error = null;
  const scanStartMs = Date.now();
  try { result = await doScan({ now }); } catch (e) { error = String((e && e.message) || e); }
  const durationMs = Date.now() - scanStartMs;

  // Pure reducer computes the new health doc (gap diagnostics, success/idle/error semantics,
  // per-scan coverage reporting) — see nextHealth for the contract, incl. the fix where a
  // market-closed no-op no longer stamps lastSuccessAt.
  const step = nextHealth(health, error ? null : result, { nowMs, durationMs, error, targetMs });
  health = step.health;

  if (S.hasStore()) {
    try { await S.writeJSON(HEALTH_KEY, health, 0); } catch { /* health is diagnostics, not control flow */ }
    try { await S.writeJSON(LOCK_KEY, { at: nowIso, until: null }, 0); } catch { /* lease expires anyway */ }
  }
  // Durable per-scan history (best effort, never blocks the scan verdict).
  await recordScanObservation(error ? null : result, { source: 'scheduler', now, durationMs, store: S });

  // `ok` keeps its op-level meaning (the scheduler tick did its job — an off-hours no-op is
  // still HTTP 200); scan-quality truth lives in `outcome` and the health doc.
  const succeeded = !!(result && result.ok);
  return { ok: succeeded, skipped: null, outcome: step.outcome, session: result ? result.session : null, anomalies: result && result.anomalies ? result.anomalies.length : 0, missedThisGap: step.missedThisGap, health };
}

// ── Durable per-scan history ────────────────────────────────────────────────────
// One compact record per scan cycle under lifecycle/daytrade/scan-health/<date>.json,
// newest-last, capped. This is what makes "how did discovery actually behave today?"
// answerable after the fact — the health doc alone only remembers the LAST scan.
async function loadScanHealthHistory(date, store = null) {
  const S = store || { readJSON, hasStore };
  if (!S.hasStore() || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { date: date || null, scans: [] };
  const doc = await S.readJSON(historyKey(date), null).catch(() => null);
  return { date, scans: doc && Array.isArray(doc.scans) ? doc.scans : [] };
}

// Record one scan observation into the per-scan history. Page-driven scans (op=discover and
// inline board scans) call this too, with source:'page' — previously they were invisible to
// health, so DEGRADED (request-driven) mode had no coverage record at all. History ONLY:
// lastSuccessAt / the lease belong exclusively to the scheduled path (runScanCycle).
async function recordScanObservation(result, { source = 'page', now = new Date(), durationMs = null, store = null } = {}) {
  const S = store || { readJSON, writeJSON, hasStore };
  const outcome = classifyScanOutcome(result);
  const record = {
    at: now.toISOString(),
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    outcome,
    session: (result && result.session) || null,
    scanned: result && Number.isFinite(result.scanned) ? result.scanned : null,
    anomalies: result && Array.isArray(result.anomalies) ? result.anomalies.length : null,
    coveragePct: coveragePctOf(result && result.coverage),
    provider: (result && result.coverage && result.coverage.provider) || null,
    note: (result && result.note) || null,
    source,
  };
  if (!S.hasStore()) return record;
  const date = (result && result.date) || etDate(now);
  try {
    const doc = await S.readJSON(historyKey(date), null).catch(() => null);
    const scans = [...((doc && doc.scans) || []), record].slice(-HISTORY_MAX_ENTRIES);
    await S.writeJSON(historyKey(date), { date, scans, updatedAt: now.toISOString() }, 0);
  } catch { /* history is best-effort — never blocks or fails a scan */ }
  return record;
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

// ── Five-state health classification (pure) ─────────────────────────────────────
// healthStatus above stays for backward compatibility (its 'never-succeeded'/'stale'/'ok'
// values are consumed by data-health and the frontend); this is the richer verdict:
//   unavailable — never succeeded (or no store): CRON_SECRET/scheduler/storage problem
//   idle        — outside scannable sessions: no staleness implication, but NOT "healthy"
//   stale       — in-session, last success older than STALE_AFTER_INTERVALS × target
//   degraded    — in-session, recent success, but the last scan's QUALITY was compromised
//                 (thin/zero coverage, price-only fallback, or a fresh error streak)
//   healthy     — in-session, recent success, full-quality scan
// Order matters: a market-closed-only scanner has no lastSuccessAt and must read
// 'unavailable' — the old code let its off-hours "successes" masquerade as healthy.
function healthStateOf(health, nowMs = Date.now()) {
  if (!health || !health.lastSuccessAt) {
    return { status: 'unavailable', reason: 'No scan-runner success has ever been recorded — scheduler unconfigured, CRON_SECRET missing/rejected, or storage unconfigured.' };
  }
  const targetMs = Number.isFinite(health.targetIntervalMs) ? health.targetIntervalMs : targetIntervalMs();
  if (!isScannable(new Date(nowMs))) {
    return { status: 'idle', reason: 'Outside scannable sessions (market closed) — no scan is expected, so an aged last success implies nothing.' };
  }
  const ageMs = nowMs - Date.parse(health.lastSuccessAt);
  if (ageMs > STALE_AFTER_INTERVALS * targetMs) {
    return {
      status: 'stale',
      reason: `In-session with no successful scan for ${(ageMs / 60000).toFixed(0)} min (target cadence ${(targetMs / 60000).toFixed(0)} min). Likely causes: scheduler stopped, CRON_SECRET missing or rejected, or upstream outage.`,
    };
  }
  const degradedWhy = [];
  if (health.lastOutcome === 'insufficient-coverage' || health.lastOutcome === 'provider-outage') degradedWhy.push(`last scan outcome was ${health.lastOutcome}`);
  if (health.lastCoverage && health.lastCoverage.volumeAvailable === false) degradedWhy.push('quotes came from the price-only fallback (no volume — relVol/participation signals are blind)');
  if ((health.consecutiveErrors || 0) >= 1) degradedWhy.push(`${health.consecutiveErrors} consecutive scan error(s)`);
  if (degradedWhy.length) return { status: 'degraded', reason: degradedWhy.join('; ') };
  return { status: 'healthy', reason: null };
}

// One-line novice-readable message per state — surfaced as `explain` by op=daytradescanhealth.
const STATE_EXPLAIN = {
  healthy: 'Live discovery is healthy.',
  degraded: 'Discovery coverage is degraded; some movers may be missed.',
  stale: 'Discovery is stale — the scheduler may not be running.',
  idle: 'Market closed — discovery idle.',
  unavailable: 'Discovery has never run — scheduler or storage not configured.',
};

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
  const now = new Date();
  const health = await readHealth();
  const verdict = healthStatus(health, now);            // legacy 3-state (kept for consumers)
  const state = healthStateOf(health, now.getTime());   // 5-state verdict
  // Per-scan history summary for ?date= (default today); raw records only behind ?full=1.
  const qDate = (req.query && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ''))) ? req.query.date : etDate(now);
  const wantFull = !!(req.query && req.query.full === '1');
  let history = null;
  try {
    const hist = await loadScanHealthHistory(qDate);
    const byOutcome = {};
    for (const s of hist.scans) byOutcome[s.outcome || 'unknown'] = (byOutcome[s.outcome || 'unknown'] || 0) + 1;
    history = {
      date: qDate,
      scans: hist.scans.length,
      byOutcome,
      first: hist.scans.length ? hist.scans[0].at : null,
      last: hist.scans.length ? hist.scans[hist.scans.length - 1].at : null,
      ...(wantFull ? { records: hist.scans } : {}),
    };
  } catch { /* history is diagnostics — absence is reported as null, not faked */ }
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
  // BOARD-TICK health — the Stage-2/lifecycle/alert mutator's own record (a healthy Stage-A
  // scanner must never hide a dead lifecycle/alert process). Separate doc, separate verdict.
  let boardTick = null;
  try {
    const doc = await require('./store').readJSON('lifecycle/daytrade/boardtick-health.json', null);
    if (doc) {
      const ageMin = doc.lastSuccessAt ? (now.getTime() - Date.parse(doc.lastSuccessAt)) / 60000 : Infinity;
      boardTick = {
        ...doc,
        state: !doc.lastAttemptAt ? 'never-ran'
          : (doc.consecutiveErrors || 0) >= 3 ? 'failing'
            : ageMin > 20 ? 'stale'
              : (doc.consecutiveErrors || 0) > 0 ? 'degraded' : 'healthy',
      };
    }
  } catch { /* board-tick health is diagnostics — absence reported as null */ }
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  return res.json({
    ok: true,
    configured: hasStore(),
    status: verdict.status,          // legacy 3-state — existing consumers keep working
    stale: verdict.stale,
    state: state.status,             // 5-state verdict: unavailable/idle/stale/degraded/healthy
    outcome: (health && health.lastOutcome) || null,
    explain: STATE_EXPLAIN[state.status] || null,
    health: health || null,
    boardTick,
    grading,
    history,
    note: state.reason || (verdict.stale ? verdict.reason : null),
  });
}

module.exports = {
  runScanCycle, runScanRunner, runScanHealth, readHealth, healthStatus,
  classifyScanOutcome, nextHealth, healthStateOf, coveragePctOf,
  recordScanObservation, loadScanHealthHistory, STATE_EXPLAIN,
  targetIntervalMs, isScannable, scannableMsBetween, historyKey,
  LOCK_KEY, HEALTH_KEY, MIN_INTERVAL_MS, LOCK_TTL_MS, DEFAULT_TARGET_INTERVAL_MS, STALE_AFTER_INTERVALS,
  COVERAGE_MIN_PCT, HISTORY_MAX_ENTRIES, SUCCESS_OUTCOMES,
};

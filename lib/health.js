// System health / observability. The daily warm cron orchestrates ~20 stages
// (cache warms + tracker ticks) and used to discard the result — so a failing
// tick or a stale data feed was invisible. This persists a compact health record
// per run and exposes op=health (last run's failures + live data freshness).
const { readJSON, writeJSON, hasStore } = require('./store');

const HEALTH_PATH = 'health/runs.json';
const MAX_RUNS = 30;
const STALE_DAYS = 4;   // legacy calendar-day bound, kept for the reported `ageDays`

// Staleness is measured in COMPLETED EXCHANGE SESSIONS, not calendar days. The old
// bound was raw calendar days despite its "excl. weekends" comment, so it both
// false-alarmed after a long weekend and stayed quiet through a genuine missing bar
// mid-week. One session behind the calendar IS stale — that is exactly the 2026-08-18
// case where the provider had no 2026-08-17 SPY bar and the whole app served a
// four-day-old cross-section.
const STALE_SESSIONS = 1;
// The settle grace lives with the clock (market-session.sessionDue) so the freshness
// bound here and the fallback trigger in lib/screener.js can never drift apart.

// Keys in the warm result that aren't a stage to grade. `chains` is the dispatch report
// for lib/warm-chains.js roots — graded separately below, since "still running when warm
// returned" is the NORMAL outcome there and must not be scored as a stage.
const NON_STAGE = new Set(['ok', 'host', 'at', 'warmed', 'warmedExtra', 'stageStatus', 'elapsedMs',
  'aiTicksKicked', 'calibKicked', 'researchKicked', 'chains', 'chainsDispatched', 'chainRoots', 'healthLogError']);

// Compact a warm-cron result object into a health record: per-stage ok/error.
// A one-off budget skip is DEFERRED, not failed — it self-heals next run and shouldn't
// flip health red on a capacity-bound cron (alarm fatigue masks real errors). But
// "self-heals next run" is only true if it ACTUALLY heals: the warm tail skipped every
// run for weeks while each run reported healthy, because chronic deferral was recorded
// but never checked. So the per-run record stays lenient (tracked, not failed) and the
// CROSS-RUN check in runHealth (chronicSkips) is what enforces the premise. A real
// error / HTTP failure counts as failed; a legitimate weekend/degraded skip stays healthy.
function summarizeRun(result) {
  const stages = {};
  for (const [k, v] of Object.entries(result || {})) {
    if (NON_STAGE.has(k)) continue;
    if (v && typeof v === 'object') {
      if (v.error) stages[k] = { ok: false, error: String(v.error).slice(0, 160) };
      else if (v.skipped === 'budget') stages[k] = { ok: true, deferred: true };
      else stages[k] = { ok: v.ok !== false };
    }
  }
  // Cache-warm failures (array of { p, status, error }).
  const warmFails = (result.warmed || []).concat(result.warmedExtra || [])
    .filter(w => w && (w.error || (w.status && w.status >= 400)))
    .map(w => ({ path: w.p, status: w.status || null, error: w.error || null }));
  const failed = Object.entries(stages).filter(([, s]) => !s.ok).map(([k]) => k);
  const budgetSkipped = Object.entries(stages).filter(([, s]) => s.deferred).map(([k]) => k);

  // Ordered work is dispatched as warmchain roots. Three distinct outcomes, and only two
  // of them are failures — the whole point of the chain refactor was to stop conflating
  // "still running" with "done":
  //   • dispatch never left the door (reportError / HTTP >=400) → FAIL
  //   • the chain reported back with FAILED STEPS in its body    → FAIL (this is finding #1:
  //     a warmchain returns 200 even when its steps failed, so grading on status alone
  //     rubber-stamped exactly the silent skips the refactor set out to surface)
  //   • the chain was STILL RUNNING when warm returned (no body) → not a failure, normal
  // Chronic budget-SKIPS are reported (chainSkips) but do not flip health red on their own:
  // a slow day self-heals, and alarming on every capacity-bound run is the fatigue that
  // masked the original bug. Persisted so chronic starvation is visible, not invisible.
  const chains = result.chains && typeof result.chains === 'object' ? result.chains : null;
  const chainDispatchFails = chains
    ? Object.entries(chains)
      .filter(([, c]) => c && (c.reportError || (c.httpStatus && c.httpStatus >= 400)
        || c.status >= 400 || (Array.isArray(c.stepFails) && c.stepFails.length)))
      .map(([k]) => k)
    : [];
  const chainSkips = chains
    ? Object.entries(chains).filter(([, c]) => c && Array.isArray(c.skipped) && c.skipped.length)
      .map(([k, c]) => ({ chain: k, skipped: c.skipped }))
    : [];

  return {
    at: result.at || new Date().toISOString(),
    stageCount: Object.keys(stages).length, failed, warmFails, budgetSkipped,
    chains, chainDispatchFails, chainSkips,
    elapsedMs: result.elapsedMs || null,
    failCount: failed.length + warmFails.length + chainDispatchFails.length,
    ok: failed.length === 0 && warmFails.length === 0 && chainDispatchFails.length === 0,
    stages,
  };
}

async function writeHealthRun(record) {
  if (!hasStore()) return;
  const doc = await readJSON(HEALTH_PATH, { runs: [] });
  doc.runs = [record, ...(doc.runs || [])].slice(0, MAX_RUNS);
  await writeJSON(HEALTH_PATH, doc, 0);
}
const readHealth = () => readJSON(HEALTH_PATH, { runs: [] });

// op=health — last cron run's failed stages + live SPY data freshness.
// Chronic deferral detector (pure, testable). A single budget-skip self-heals; the SAME
// chain/stage skipped across recent runs does not — that is precisely how the whole warm
// tail stayed dead for weeks while each run reported healthy. This actually BACKS the
// "self-heals next run" premise instead of only asserting it: a name skipped on ≥CHRONIC_MIN
// of the last CHRONIC_WINDOW runs is surfaced, and its presence flips health to a warning.
const CHRONIC_WINDOW = 4, CHRONIC_MIN = 3;
function detectChronicSkips(runs) {
  const recent = (runs || []).slice(0, CHRONIC_WINDOW);
  const skipCount = {};
  for (const r of recent) {
    const names = new Set([
      ...((r && r.budgetSkipped) || []),
      ...((r && r.chainSkips) || []).map(s => s.chain),
    ]);
    for (const n of names) skipCount[n] = (skipCount[n] || 0) + 1;
  }
  const chronicSkips = Object.entries(skipCount)
    .filter(([, n]) => n >= CHRONIC_MIN).map(([name, n]) => ({ name, runs: n, of: recent.length }));
  return { chronicSkips, window: recent.length };
}

// Overlay durably-persisted per-chain reports (warm/chains/<name>.json, written by each
// warmchain invocation itself) onto the last run's chain records. Warm's drain only hears
// chains that report back before its ceiling — a chain that outlives the drain, or dies at
// the function wall, shows as 'running-past-warm' forever and its failures never reach
// op=health (on 2026-08-06 this hid a budget-skipped @decision — the day's decision
// snapshot was silently lost while health read green). Pure: returns a NEW run object.
//
// A persisted report only overlays when it is FRESHER than the run's dispatch time (an
// older report describes a previous night). A running-past-warm chain with NO fresh
// persisted report is marked loudly: it died before it could persist anything.
function overlayPersistedChains(run, persisted) {
  if (!run || !run.chains || !persisted) return run;
  const runAt = Date.parse(run.at || 0) || 0;
  const chains = { ...run.chains };
  const lateChainFails = [];
  for (const [name, c] of Object.entries(chains)) {
    if (!c || c.status !== 'running-past-warm') continue;
    const rep = persisted[name];
    const repAt = rep ? (Date.parse(rep.at || 0) || 0) : 0;
    // Dispatch precedes the run record's own timestamp by up to the drain ceiling, so
    // accept any report written after (runAt - 10 min) as this night's.
    if (rep && repAt >= runAt - 600000) {
      chains[name] = {
        dispatched: true, persistedReport: true, at: rep.at,
        complete: rep.complete === true,
        stepFails: rep.failed || [], skipped: rep.skipped || [],
        stepFailDetail: rep.failDetail || [], elapsedMs: rep.elapsedMs ?? null,
      };
      if ((rep.failed || []).length) lateChainFails.push(name);
    } else {
      chains[name] = { ...c, status: 'no-report', note: 'never persisted a report for this run — killed before finishing (function wall) or dispatch never landed' };
      lateChainFails.push(name);
    }
  }
  return { ...run, chains, ...(lateChainFails.length ? { lateChainFails } : {}) };
}

// Pure response assembly (runs + live-data facts in → response object out). Extracted from
// runHealth so it is unit-testable WITHOUT the network — the last edit shipped a
// ReferenceError here (`recent` out of scope) that the pure-helper tests could not see,
// because they never exercised the assembly. This is the same "node --check misses
// ReferenceError" lesson: the fix is to make the path executable in a test.
function buildHealthResponse(runs, { spyDate = null, spyDates = null, ageDays = null, now = Date.now(), dataQuality = null, auth = require('./auth').validateAuthEnv(), persistedChains = null } = {}) {
  const rs = runs || [];
  // How many completed sessions the benchmark is behind the exchange calendar. This —
  // not elapsed wall time — is what "stale market data" means.
  //
  // Measured against the newest bar AT OR BEFORE the session that is due, never the
  // newest bar outright. On 2026-08-18 the SPY series ran ...08-13, 08-14, 08-18: Monday
  // missing, today's partial bar present. Judging by the newest bar, the feed looked
  // current and the banner cleared itself — while every ranking was still computed on
  // Friday. A hole in the series is exactly as stale as a short tail.
  const { sessionDue } = require('./market-session');
  const { countSessionsBetween } = require('./cohort-freshness');
  const calendarSession = sessionDue(new Date(now)) || null;
  const settled = Array.isArray(spyDates) && spyDates.length && calendarSession
    ? spyDates.filter(d => d && d <= calendarSession).pop() || null
    : spyDate;
  const sessionsBehind = (settled && calendarSession)
    ? countSessionsBetween(settled, calendarSession, new Date(now)) : null;
  const stale = sessionsBehind != null ? sessionsBehind >= STALE_SESSIONS : (ageDays != null && ageDays > STALE_DAYS);
  const last = overlayPersistedChains(rs[0] || null, persistedChains);
  const { chronicSkips, window: chronicWindow } = detectChronicSkips(rs);
  return {
    ok: true,
    lastRun: last,
    // A production deploy missing CRON_SECRET makes every privileged op / the cron fail
    // closed (503) — surface it here so the misconfiguration is visible, not silent.
    auth: { ok: auth.ok, production: auth.production, secretConfigured: auth.secretConfigured, warnings: auth.warnings },
    healthy: !!last && last.ok && !stale && chronicSkips.length === 0 && auth.ok
      && !(last.lateChainFails || []).length,
    warning: chronicSkips.length ? `${chronicSkips.map(c => c.name).join(', ')} skipped on ${CHRONIC_MIN}+ of the last ${chronicWindow} runs — not self-healing`
      : (last && (last.lateChainFails || []).length) ? `chains failed or vanished after warm's report window: ${last.lateChainFails.join(', ')}` : null,
    chronicSkips,
    failStreak: (() => { let n = 0; for (const r of rs) { if (r.ok) break; n++; } return n; })(),
    data: { spyDate, ageDays: ageDays != null ? +ageDays.toFixed(1) : null, stale, sessionsBehind, calendarSession, lastSettledSession: settled },
    dataQuality,
    recentRuns: rs.slice(0, 10).map(r => ({ at: r.at, ok: r.ok, failCount: r.failCount, failed: r.failed, chainSkips: r.chainSkips || [] })),
    generatedAt: new Date(now).toISOString(),
  };
}

async function runHealth(req, res) {
  const { fetchDailyHistory } = require('./screener');
  const { validateSeries } = require('./market-data');
  const doc = await readHealth().catch(() => ({ runs: [] }));
  const runs = doc.runs || [];
  // Fetch durable per-chain reports ONLY for chains warm's drain never heard back from —
  // the one case where the run record alone cannot say whether the work happened.
  let persistedChains = null;
  const lastRun = runs[0];
  const unheard = lastRun && lastRun.chains
    ? Object.entries(lastRun.chains).filter(([, c]) => c && c.status === 'running-past-warm').map(([k]) => k)
    : [];
  if (unheard.length && hasStore()) {
    const entries = await Promise.all(unheard.map(async (name) => {
      const rep = await readJSON(`warm/chains/${name}.json`, null).catch(() => null);
      return [name, rep];
    }));
    persistedChains = Object.fromEntries(entries.filter(([, rep]) => rep));
  }
  let spyDate = null, spyDates = null, ageDays = null, dataQuality = null;
  try {
    const spy = await fetchDailyHistory('SPY');
    if (spy && spy.candles.length) {
      spyDate = spy.candles[spy.candles.length - 1].date;
      // The whole axis, so a MISSING mid-series session is visible — the newest bar alone
      // cannot distinguish "current" from "current plus a hole where Monday should be".
      spyDates = spy.candles.map(c => c.date);
      ageDays = (Date.now() - Date.parse(spyDate + 'T00:00:00Z')) / 86400000;
      // Integrity spot-check on the benchmark series (adjusted splits, dup/non-monotonic dates,
      // negatives, stale bar). SPY is the one series every scan depends on, so a provider glitch
      // here is worth surfacing rather than silently trusting.
      const v = validateSeries(spy.candles, { corporateActions: spy.corporateActions, asOf: spyDate });
      dataQuality = { ok: v.ok, issues: v.issues.map((i) => i.type), warnings: v.warnings.map((w) => w.type), priceBasis: spy.priceBasis, adjustment: spy.adjustment };
    }
  } catch { /* live check best-effort */ }
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400');
  return res.json(buildHealthResponse(runs, { spyDate, spyDates, ageDays, dataQuality, persistedChains }));
}

module.exports = { summarizeRun, detectChronicSkips, buildHealthResponse, overlayPersistedChains, writeHealthRun, readHealth, runHealth, HEALTH_PATH };

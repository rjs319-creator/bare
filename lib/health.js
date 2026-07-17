// System health / observability. The daily warm cron orchestrates ~20 stages
// (cache warms + tracker ticks) and used to discard the result — so a failing
// tick or a stale data feed was invisible. This persists a compact health record
// per run and exposes op=health (last run's failures + live data freshness).
const { readJSON, writeJSON, hasStore } = require('./store');

const HEALTH_PATH = 'health/runs.json';
const MAX_RUNS = 30;
const STALE_DAYS = 4;   // SPY EOD older than this (excl. weekends) → flag stale

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

async function runHealth(req, res) {
  const { fetchDailyHistory } = require('./screener');
  const doc = await readHealth().catch(() => ({ runs: [] }));
  const runs = doc.runs || [];
  let spyDate = null, ageDays = null;
  try {
    const spy = await fetchDailyHistory('SPY');
    if (spy && spy.candles.length) { spyDate = spy.candles[spy.candles.length - 1].date; ageDays = (Date.now() - Date.parse(spyDate + 'T00:00:00Z')) / 86400000; }
  } catch { /* live check best-effort */ }
  const last = runs[0] || null;
  const { chronicSkips } = detectChronicSkips(runs);

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400');
  return res.json({
    ok: true,
    lastRun: last,
    healthy: !!last && last.ok && !(ageDays != null && ageDays > STALE_DAYS) && chronicSkips.length === 0,
    warning: chronicSkips.length ? `${chronicSkips.map(c => c.name).join(', ')} skipped on ${CHRONIC_MIN}+ of the last ${recent.length} runs — not self-healing` : null,
    chronicSkips,
    failStreak: (() => { let n = 0; for (const r of runs) { if (r.ok) break; n++; } return n; })(),
    data: { spyDate, ageDays: ageDays != null ? +ageDays.toFixed(1) : null, stale: ageDays != null && ageDays > STALE_DAYS },
    recentRuns: runs.slice(0, 10).map(r => ({ at: r.at, ok: r.ok, failCount: r.failCount, failed: r.failed, chainSkips: r.chainSkips || [] })),
    generatedAt: new Date().toISOString(),
  });
}

module.exports = { summarizeRun, detectChronicSkips, writeHealthRun, readHealth, runHealth, HEALTH_PATH };

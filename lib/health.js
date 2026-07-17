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
// A stage the budget guard deferred (skipped:'budget') is DEFERRED, not failed —
// it self-heals next run and shouldn't flip health red on a capacity-bound cron
// (that would be alarm fatigue that masks real errors). It's tracked separately in
// `budgetSkipped` so chronic deferral is still visible. A real error / HTTP failure
// counts as failed; a legitimate weekend/degraded skip (ok:true) stays healthy.
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

  // Ordered work is dispatched as warmchain roots. A chain that hadn't reported by warm's
  // ceiling is STILL RUNNING in its own invocation — normal, and explicitly not a failure.
  // Only a dispatch that never left the door is one.
  const chains = result.chains && typeof result.chains === 'object' ? result.chains : null;
  const chainDispatchFails = chains
    ? Object.entries(chains).filter(([, c]) => c && (c.reportError || (c.status && c.status >= 400))).map(([k]) => k)
    : [];

  return {
    at: result.at || new Date().toISOString(),
    stageCount: Object.keys(stages).length, failed, warmFails, budgetSkipped,
    chains, chainDispatchFails,
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
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400');
  return res.json({
    ok: true,
    lastRun: last,
    healthy: !!last && last.ok && !(ageDays != null && ageDays > STALE_DAYS),
    failStreak: (() => { let n = 0; for (const r of runs) { if (r.ok) break; n++; } return n; })(),
    data: { spyDate, ageDays: ageDays != null ? +ageDays.toFixed(1) : null, stale: ageDays != null && ageDays > STALE_DAYS },
    recentRuns: runs.slice(0, 10).map(r => ({ at: r.at, ok: r.ok, failCount: r.failCount, failed: r.failed })),
    generatedAt: new Date().toISOString(),
  });
}

module.exports = { summarizeRun, writeHealthRun, readHealth, runHealth, HEALTH_PATH };

'use strict';
// OPTIONS DATA HEALTH v2 — coverage, freshness, and provider diagnostics.
//
// The iron rule: provider failure is NEVER converted into "no unusual activity".
// Every scan produces a health record from the per-ticker telemetry — attempted vs
// succeeded vs failed (with reasons), expiries requested vs returned, contracts
// inspected, latency, data age, coverage % — and the UI surfaces it. A scan that
// covered 40% of its universe SAYS it covered 40%.
//
// Pure summarizer; the route persists the result.

const { MODEL_VERSION } = require('./options-config-v2');

function pct(n, d) { return d > 0 ? Math.round((n / d) * 100) : 0; }

function latencyStats(latencies) {
  const l = latencies.filter(v => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!l.length) return null;
  const q = f => l[Math.min(l.length - 1, Math.floor(l.length * f))];
  return { p50: q(0.5), p90: q(0.9), max: l[l.length - 1] };
}

/**
 * Build the scan-health record from per-ticker observations/telemetry.
 * @param {Array} observations observeTicker() outputs (ok and failed alike)
 * @param {{session:string, scanId:string, universe:object, startedAt:string,
 *          finishedAt:string, sourceMode:string, capabilities?:object}} ctx
 */
function buildScanHealth(observations, ctx = {}) {
  const obs = observations || [];
  const failed = obs.filter(o => !o.ok);
  const succeeded = obs.filter(o => o.ok);
  const failureReasons = {};
  for (const f of failed) failureReasons[f.failure || 'unknown'] = (failureReasons[f.failure || 'unknown'] || 0) + 1;

  const expiriesRequested = obs.reduce((s, o) => s + (o.expiriesRequested || 0), 0);
  const expiriesReturned = obs.reduce((s, o) => s + (o.expiriesReturned || 0), 0);
  const contractsInspected = succeeded.reduce((s, o) => s + (o.contractsInspected || 0), 0);
  // Rate-limit signal: failures that look like throttling, plus a big
  // requested-vs-returned expiry gap.
  const rateLimitSuspected = failed.filter(f => /429|rate|too many/i.test(f.failure || '')).length > 0
    || (expiriesRequested > 0 && expiriesReturned / expiriesRequested < 0.6);

  const bySource = {};
  for (const o of obs) {
    const src = o.universeSource || 'unknown';
    bySource[src] = bySource[src] || { attempted: 0, succeeded: 0 };
    bySource[src].attempted++;
    if (o.ok) bySource[src].succeeded++;
  }

  const delays = succeeded.map(o => o.delayedByMin).filter(v => v != null);

  return {
    modelVersion: MODEL_VERSION,
    scanId: ctx.scanId || null,
    session: ctx.session || null,
    sourceMode: ctx.sourceMode || null,
    capabilities: ctx.capabilities || null,
    startedAt: ctx.startedAt || null,
    finishedAt: ctx.finishedAt || null,
    universe: ctx.universe || null,   // { budget, shardIndex, shardCount, truncated }
    tickersAttempted: obs.length,
    tickersSucceeded: succeeded.length,
    tickersFailed: failed.length,
    failedTickers: failed.slice(0, 30).map(f => ({ ticker: f.ticker, reason: f.failure })),
    failureReasons,
    coveragePct: pct(succeeded.length, obs.length),
    expiriesRequested, expiriesReturned,
    expiryCoveragePct: pct(expiriesReturned, expiriesRequested),
    contractsInspected,
    providerLatency: latencyStats(obs.map(o => o.latencyMs)),
    delayedByMin: delays.length ? Math.max(...delays) : null,
    rateLimitSuspected,
    bySource,
    ok: succeeded.length > 0,
    note: succeeded.length === 0
      ? 'PROVIDER FAILURE — no tickers scanned. This is a data outage, NOT "no unusual activity".'
      : (pct(succeeded.length, obs.length) < 70
        ? `Partial coverage (${pct(succeeded.length, obs.length)}%) — absent names are UNSCANNED, not normal.`
        : null),
  };
}

// Roll the per-scan record into the persistent health doc (bounded history).
function foldHealth(prevDoc, scanHealth, { maxHistory = 30 } = {}) {
  const doc = prevDoc && typeof prevDoc === 'object' ? { ...prevDoc } : {};
  const history = Array.isArray(doc.history) ? [...doc.history] : [];
  // Idempotent: a retried scan for the same session replaces its record.
  const idx = history.findIndex(h => h.session === scanHealth.session && h.scanId === scanHealth.scanId);
  if (idx >= 0) history[idx] = scanHealth; else history.push(scanHealth);
  const trimmed = history.slice(-maxHistory);
  const lastOk = [...trimmed].reverse().find(h => h.ok);
  return {
    updatedAt: scanHealth.finishedAt || null,
    modelVersion: MODEL_VERSION,
    latest: scanHealth,
    lastSuccessfulSession: lastOk ? lastOk.session : (doc.lastSuccessfulSession || null),
    history: trimmed,
  };
}

module.exports = { buildScanHealth, foldHealth, latencyStats };

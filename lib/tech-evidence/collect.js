'use strict';
// Tech Operational Evidence — collection + derivation orchestrator (cron-driven).
// Idempotent by construction: adapters emit deterministic observation IDs, the series
// fold decides freshness, day docs merge first-wins, and forward-event creation is
// guarded by index membership. One bad source or ticker degrades coverage — it never
// fails the run. Everything is deadline-aware; nothing is fire-and-forget.

const REGISTRY = require('./registry');
const TSTORE = require('./store');
const SIGNALS = require('./signals');
const FORWARD = require('./forward');
const MS = require('../market-session');

const COLLECT_VERSION = 'techev-collect-v1';
const DEFAULT_DEADLINE_MS = 120000;
const BACKFILL_SOURCES = Object.freeze(['npm', 'github', 'sec', 'statuspage']); // genuine PIT history only
const LIVE_SOURCES = Object.freeze(['sec', 'npm', 'github', 'greenhouse', 'lever', 'statuspage', 'huggingface', 'usaspending', 'pricing']);

const ADAPTERS = {
  npm: (o) => require('./adapters/npm').collectNpm(o),
  github: (o) => require('./adapters/github').collectGithub(o),
  statuspage: (o) => require('./adapters/statuspage').collectStatuspage(o),
  greenhouse: (o) => require('./adapters/jobs').collectJobs({ ...o, source: 'greenhouse' }),
  lever: (o) => require('./adapters/jobs').collectJobs({ ...o, source: 'lever' }),
  huggingface: (o) => require('./adapters/huggingface').collectHuggingface(o),
  usaspending: (o) => require('./adapters/usaspending').collectUsaspending(o),
  pricing: (o) => require('./adapters/pricing').collectPricing(o),
  sec: (o) => {
    const companies = uniqueCompanies(o.mappings.length ? o.mappings : REGISTRY.activeMappings());
    return require('./adapters/sec-facts').collectSec({ ...o, companies });
  },
};

function uniqueCompanies(mappings) {
  const byTicker = new Map();
  for (const m of mappings) if (!byTicker.has(m.ticker)) byTicker.set(m.ticker, { ticker: m.ticker, cik: m.cik });
  return [...byTicker.values()];
}

function healthPatch(source, result, startedAt) {
  const now = new Date().toISOString();
  return {
    [source]: {
      lastAttemptAt: startedAt,
      lastSuccessAt: result && (result.ok || result.partial) ? now : undefined,
      lastError: result && result.errors && result.errors.length ? result.errors[0] : null,
      errorClass: result ? (result.ok ? null : result.rateLimited ? 'rate_limited' : 'upstream') : 'exception',
      rateLimited: !!(result && result.rateLimited),
      partial: !!(result && result.partial),
      coverage: result ? result.coverage : null,
      freshObservations: result ? (result.freshCount ?? null) : null,
    },
  };
}

async function collectOneSource(source, { now, fetchImpl, basis = 'live', extra = {} } = {}) {
  const startedAt = new Date().toISOString();
  const mappings = REGISTRY.activeMappings({ source, asOf: now.toISOString().slice(0, 10) });
  if (!mappings.length && source !== 'sec') {
    return { source, configured: false, fresh: 0, health: { [source]: { lastAttemptAt: startedAt, configured: false, note: 'no verified active mappings for this source' } } };
  }
  let result;
  try {
    if (source === 'pricing') {
      const series = await TSTORE.readSeries('pricing');
      result = await ADAPTERS.pricing({ mappings, now, fetchImpl, prevSnapshots: (series.entities && series.entities.snapshots) || {} });
    } else {
      result = await ADAPTERS[source]({ mappings, now, fetchImpl, basis, ...extra });
    }
  } catch (e) {
    return { source, configured: true, fresh: 0, error: String((e && e.message) || e).slice(0, 200), health: healthPatch(source, null, startedAt) };
  }
  const series = await TSTORE.readSeries(source);
  const { series: nextSeries, freshObservations } = TSTORE.foldIntoSeries(source, series, result.observations);
  const withSnaps = source === 'pricing' && result.nextSnapshots
    ? { ...nextSeries, entities: { ...nextSeries.entities, snapshots: { ...((series.entities || {}).snapshots || {}), ...result.nextSnapshots } } }
    : nextSeries;
  if (freshObservations.length || source === 'pricing') await TSTORE.writeSeries(source, withSnaps);
  const day = now.toISOString().slice(0, 10);
  const appended = await TSTORE.appendObservations(source, day, freshObservations);
  result.freshCount = appended.added;
  return { source, configured: true, fresh: appended.added, partial: result.partial, errors: result.errors, rateLimited: result.rateLimited, health: healthPatch(source, result, startedAt) };
}

async function runCollection({ now = new Date(), deadlineMs = DEFAULT_DEADLINE_MS, t0 = Date.now(), fetchImpl = null, sources = LIVE_SOURCES } = {}) {
  const report = { v: COLLECT_VERSION, startedAt: now.toISOString(), sources: [], skippedBudget: [] };
  let health = {};
  for (const source of sources) {
    if (Date.now() - t0 > deadlineMs) { report.skippedBudget.push(source); continue; }
    const extra = source === 'sec' ? { sinceFiled: SIGNALS.addDays(now.toISOString().slice(0, 10), -30) } : {};
    const r = await collectOneSource(source, { now, fetchImpl, extra });
    health = { ...health, ...r.health };
    report.sources.push({ source: r.source, configured: r.configured, fresh: r.fresh, partial: !!r.partial, error: r.error || (r.errors && r.errors[0]) || null });
  }
  await TSTORE.mergeHealth({ sources: health });
  return report;
}

// ── signal derivation + forward-event creation for one cutoff ────────────────
function armEntries(arm, seriesDoc, asOfDay) {
  const mappings = REGISTRY.activeMappings({ source: arm, asOf: asOfDay });
  return mappings
    .map((m) => ({ ticker: m.ticker, entity: arm === 'sec' ? m.cik : m.sourceId, mappingId: m.mappingId, mappingVersion: m.version, monetizationWeight: m.monetizationWeight, bucket: (seriesDoc.entities || {})[arm === 'sec' ? m.cik : m.sourceId] }))
    .filter((e, i, arr) => arr.findIndex((x) => x.entity === e.entity) === i);
}

function secEntries(seriesDoc, asOfDay) {
  const companies = uniqueCompanies(REGISTRY.activeMappings({ asOf: asOfDay }));
  return companies.map((c) => ({ ticker: c.ticker, entity: c.cik, mappingId: null, mappingVersion: null, monetizationWeight: 'high', bucket: (seriesDoc.entities || {})[c.cik] }));
}

async function deriveAt(cutoffDate, { priorEvents, basis = 'live' } = {}) {
  const allSignals = [];
  for (const arm of ['npm', 'github', 'sec']) {
    const series = await TSTORE.readSeries(arm);
    const entries = arm === 'sec' ? secEntries(series, cutoffDate) : armEntries(arm, series, cutoffDate);
    if (!entries.length) continue;
    const sigs = SIGNALS.deriveArmSignals(arm, entries, cutoffDate).map((s) => ({ ...s, basis }));
    allSignals.push(...sigs);
  }
  const { events, skipped } = FORWARD.eventsFromSignals(allSignals, {
    cutoffDate, priorEvents, benchmarkFor: REGISTRY.benchmarkFor, createdAt: new Date().toISOString(),
  });
  return { signals: allSignals, events, skipped };
}

async function runDerivation({ now = new Date() } = {}) {
  const cutoffDate = MS.lastCompletedRegularSession(now);
  if (!cutoffDate) return { ok: false, reason: 'no completed regular session found' };
  const idx = await TSTORE.readForwardIndex();
  const priorEvents = idx.events || [];
  const { signals, events, skipped } = await deriveAt(cutoffDate, { priorEvents, basis: 'live' });
  await TSTORE.writeSignalsLatest({ v: COLLECT_VERSION, cutoffDate, generatedAt: new Date().toISOString(), signals });
  let created = 0;
  if (events.length && !idx.dates.includes(cutoffDate)) {
    await TSTORE.writeForwardDay(cutoffDate, { date: cutoffDate, events, savedAt: new Date().toISOString() });
    await TSTORE.writeForwardIndex({
      ...idx,
      dates: [...idx.dates, cutoffDate],
      events: [...priorEvents, ...events.map((e) => ({ d: e.cutoffDate, t: e.ticker, arm: e.arm }))].slice(-2000),
      eventCount: (idx.eventCount || 0) + events.length,
    });
    created = events.length;
  }
  return { ok: true, cutoffDate, signals: signals.length, eligible: signals.filter((s) => s.eligible).length, eventsCreated: created, skipped };
}

// ── bounded historical backfill (PIT sources only) ───────────────────────────
async function runBackfill({ source, now = new Date(), fetchImpl = null } = {}) {
  if (!BACKFILL_SOURCES.includes(source)) {
    return { ok: false, reason: `source "${source}" has no legitimate point-in-time history — forward collection only` };
  }
  const extra = source === 'npm' ? { days: 540 }
    : source === 'github' ? { maxPages: require('./adapters/github').MAX_BACKFILL_PAGES }
    : source === 'sec' ? { sinceFiled: null }
    : {};
  const r = await collectOneSource(source, { now, fetchImpl, basis: 'backfill', extra });
  await TSTORE.mergeHealth({ sources: r.health, cursors: { [`backfill:${source}`]: { at: new Date().toISOString(), fresh: r.fresh } } });
  return { ok: !r.error, ...r, health: undefined };
}

// Replay weekly cutoffs over backfilled series to seed the forward ledger (basis 'backfill').
async function runBackfillDerivation({ now = new Date(), stepDays = 7, maxCutoffs = 120 } = {}) {
  const endCutoff = SIGNALS.addDays(FORWARD.maturityCutoffDate(now), 0);
  const idx0 = await TSTORE.readForwardIndex();
  let idx = idx0;
  let createdTotal = 0;
  const cutoffs = [];
  for (let k = maxCutoffs; k >= 1; k -= 1) {
    const day = SIGNALS.addDays(endCutoff, -k * stepDays);
    if (!FORWARD.historyRangeFor(day, now)) continue; // beyond honest candle history — pointless event
    const info = MS.sessionInfoAt(new Date(day + 'T17:00:00Z'));
    if (info.isTradingDay) cutoffs.push(info.etDate);
  }
  for (const cutoffDate of cutoffs) {
    if (idx.dates.includes(cutoffDate)) continue; // idempotent replay
    const { events } = await deriveAt(cutoffDate, { priorEvents: idx.events || [], basis: 'backfill' });
    if (!events.length) continue;
    await TSTORE.writeForwardDay(cutoffDate, { date: cutoffDate, events, savedAt: new Date().toISOString() });
    idx = {
      ...idx,
      dates: [...idx.dates, cutoffDate].sort(),
      events: [...(idx.events || []), ...events.map((e) => ({ d: e.cutoffDate, t: e.ticker, arm: e.arm }))].slice(-2000),
      eventCount: (idx.eventCount || 0) + events.length,
    };
    createdTotal += events.length;
  }
  if (createdTotal > 0) await TSTORE.writeForwardIndex(idx);
  return { ok: true, cutoffsTried: cutoffs.length, eventsCreated: createdTotal };
}

module.exports = {
  COLLECT_VERSION, LIVE_SOURCES, BACKFILL_SOURCES, DEFAULT_DEADLINE_MS,
  runCollection, collectOneSource, runDerivation, runBackfill, runBackfillDerivation, deriveAt,
};

'use strict';
// Tech Operational Evidence — tracker ops.
//   op=techev          public read  — page summary: health, signals, scorecard, mapping coverage
//   op=techevdetail    public read  — per-ticker provenance + raw evidence (&ticker=)
//   op=techevtick      PRIVILEGED   — collect sources + derive signals + create forward events
//   op=techevresolve   PRIVILEGED   — resolve matured forward-ledger days (1/5/10 sessions)
//   op=techevbackfill  PRIVILEGED   — bounded PIT backfill (&src=npm|github|sec|statuspage|derive)
//
// Public reads never write. Privileged ops rely on the tracker PRIVILEGED_OPS gate
// (CRON_SECRET bearer) and are additionally harmless when replayed (idempotent stores).

const TSTORE = require('./tech-evidence/store');
const REGISTRY = require('./tech-evidence/registry');
const COLLECT = require('./tech-evidence/collect');
const FORWARD = require('./tech-evidence/forward');
const EXPERIMENT = require('./tech-evidence/experiment');
const SIGNALS = require('./tech-evidence/signals');

const cached = (res, s = 300) => res.setHeader('Cache-Control', `s-maxage=${s}, stale-while-revalidate=600`);
const noStore = (res) => res.setHeader('Cache-Control', 'no-store');
const err = (e) => String((e && e.message) || e).slice(0, 200);

const RESOLVE_DAY_LIMIT_DEFAULT = 3;
const RESOLVE_DAY_LIMIT_MAX = 20;
const RESOLVE_MAX_ATTEMPTS = 3;

const DISCLOSURE = 'Research evidence, not a trade recommendation. No source is assumed to provide alpha until the forward ledger validates it.';

// Every registry field is public information (official URLs, CIKs, evidence text) —
// this projection exists as the single choke point should a private field ever appear.
function publicMapping(m) {
  return { ...m };
}

function attentionFor(signals, cutoffDate, now = new Date()) {
  const ageDays = cutoffDate ? Math.max(0, Math.round((now - new Date(cutoffDate + 'T00:00:00Z')) / 86400000)) : 0;
  const weightOf = (s) => {
    const m = s.mappingId ? REGISTRY.mappingById(s.mappingId) : null;
    return m ? m.monetizationWeight : 'high'; // sec arm has no product mapping — company-level, high relevance
  };
  return signals.map((s) => ({ ...s, attention: SIGNALS.attentionScore(s, { monetizationWeight: weightOf(s), ageDays }) }));
}

function observedArmsFrom(health) {
  const set = new Set();
  for (const [source, h] of Object.entries((health && health.sources) || {})) {
    if (h && h.lastSuccessAt) set.add(source);
  }
  return set;
}

// ── public: page summary ─────────────────────────────────────────────────────
async function runTechEv(req, res) {
  try {
    if (!TSTORE.hasStore()) {
      noStore(res);
      return res.status(200).json({ ok: false, state: 'not-configured', reason: 'Blob storage not configured — collection cannot persist evidence.', disclosure: DISCLOSURE });
    }
    const [health, snap, idx, rowsDoc] = await Promise.all([
      TSTORE.readHealth(), TSTORE.readSignalsLatest(), TSTORE.readForwardIndex(), TSTORE.readForwardRows(),
    ]);
    const scorecard = EXPERIMENT.evaluateAll(rowsDoc.rows, { observedArms: observedArmsFrom(health), trimmedRows: rowsDoc.trimmed || 0 });
    const signals = snap ? attentionFor(snap.signals || [], snap.cutoffDate) : [];
    const payload = {
      ok: true, schema: 'techev-page-v1', readOnly: true,
      generatedAt: new Date().toISOString(),
      disclosure: DISCLOSURE,
      health: {
        updatedAt: health.updatedAt,
        sources: health.sources || {},
        collectionHasRun: !!health.updatedAt,
        note: health.updatedAt ? null : 'Collection has not run yet — the techev warm chain populates this nightly, or dispatch op=techevtick with the cron secret.',
      },
      coverage: {
        verifiedMappings: REGISTRY.activeMappings().length,
        verifiedTickers: REGISTRY.verifiedTickers(),
        inactiveMappings: REGISTRY.MAPPINGS.filter((m) => m.activeTo != null).length,
        candidates: REGISTRY.CANDIDATES,
        registryVersion: REGISTRY.REGISTRY_VERSION,
      },
      signals: { cutoffDate: snap ? snap.cutoffDate : null, generatedAt: snap ? snap.generatedAt : null, items: signals },
      forward: {
        observedDates: idx.dates.length, resolvedDates: idx.resolved.length,
        eligibleEvents: idx.eventCount || 0,
        resolvedEvents: rowsDoc.rows.length, rowsTrimmed: rowsDoc.trimmed || 0,
      },
      scorecard,
      mappingsPublic: REGISTRY.MAPPINGS.map(publicMapping),
    };
    // Never CDN-cache the empty state — a pre-first-tick response cached at the edge
    // would render as "no operational evidence anywhere" for every client behind it.
    if (snap) cached(res); else noStore(res);
    return res.status(200).json(payload);
  } catch (e) {
    noStore(res);
    return res.status(200).json({ ok: false, error: err(e), disclosure: DISCLOSURE });
  }
}

// ── public: per-ticker detail ────────────────────────────────────────────────
async function runTechEvDetail(req, res) {
  const ticker = String(req.query.ticker || '').toUpperCase();
  if (!/^[A-Z][A-Z.\-]{0,6}$/.test(ticker)) {
    noStore(res);
    return res.status(400).json({ ok: false, error: 'invalid ticker' });
  }
  try {
    if (!TSTORE.hasStore()) { noStore(res); return res.status(200).json({ ok: false, state: 'not-configured' }); }
    const mappings = REGISTRY.mappingsForTicker(ticker);
    if (!mappings.length) { noStore(res); return res.status(200).json({ ok: false, ticker, state: 'unmapped', note: 'No registry mapping (verified or candidate) exists for this ticker.' }); }
    const [snap, rowsDoc] = await Promise.all([TSTORE.readSignalsLatest(), TSTORE.readForwardRows()]);
    const evidence = {};
    for (const source of [...new Set(mappings.map((m) => m.source))]) {
      const series = await TSTORE.readSeries(source);
      // pricing observations are keyed by mappingId (one page per mapping); every other
      // source keys its series buckets by sourceId.
      const entities = mappings.filter((m) => m.source === source).map((m) => (source === 'pricing' ? m.mappingId : m.sourceId));
      evidence[source] = Object.fromEntries(entities.map((e) => [e, excerptBucket(source, (series.entities || {})[e])]));
    }
    const secSeries = await TSTORE.readSeries('sec');
    const cik = REGISTRY.cikFor(ticker);
    if (cik && secSeries.entities && secSeries.entities[cik]) evidence.sec = { [cik]: excerptBucket('sec', secSeries.entities[cik]) };
    const payload = {
      ok: true, ticker, readOnly: true, disclosure: DISCLOSURE,
      mappings: mappings.map(publicMapping),
      signals: snap ? attentionFor((snap.signals || []).filter((s) => s.ticker === ticker), snap.cutoffDate) : [],
      signalsCutoff: snap ? snap.cutoffDate : null,
      forwardRows: rowsDoc.rows.filter((r) => r.t === ticker).slice(-50),
      evidence,
    };
    if (snap) cached(res); else noStore(res);
    return res.status(200).json(payload);
  } catch (e) {
    noStore(res);
    return res.status(200).json({ ok: false, ticker, error: err(e) });
  }
}

function excerptBucket(source, bucket) {
  if (!bucket) return { present: false };
  if (source === 'npm') {
    const days = Object.keys(bucket.points || {}).sort();
    return { present: true, days: days.length, firstDay: days[0] || null, lastDay: days[days.length - 1] || null, recentPoints: days.slice(-30).map((d) => ({ d, v: bucket.points[d] })), revisions: (bucket.revisions || []).length };
  }
  if (source === 'github') {
    const keys = Object.keys(bucket.releases || {}).sort();
    return { present: true, releases: keys.length, recent: keys.slice(-10) };
  }
  if (source === 'sec') {
    const facts = Object.values(bucket.facts || {});
    return { present: true, facts: facts.length, recent: facts.filter((f) => f.filed).sort((a, b) => (a.filed < b.filed ? 1 : -1)).slice(0, 20) };
  }
  if (source === 'statuspage') {
    const incidents = Object.values(bucket.incidents || {});
    return { present: true, incidents: incidents.length, recent: incidents.slice(-10) };
  }
  const days = Object.keys(bucket.days || {}).sort();
  return { present: true, snapshots: days.length, recent: days.slice(-14).map((k) => ({ k, v: bucket.days[k] })) };
}

// ── privileged: collect + derive ─────────────────────────────────────────────
async function runTechEvTick(req, res) {
  noStore(res);
  if (!TSTORE.hasStore()) return res.status(503).json({ ok: false, reason: 'no blob store configured' });
  const t0 = Date.now();
  try {
    // Budget: the techev chain runs tick + resolve sequentially inside one warmchain
    // invocation (240s soft deadline, 300s wall). Collection ≤100s + derivation leaves
    // resolve its own ~110s (below) with headroom for the HTTP round-trips.
    const collection = await COLLECT.runCollection({ t0, deadlineMs: 100000 });
    const derivation = await COLLECT.runDerivation({});
    return res.status(200).json({ ok: true, collection, derivation, elapsedMs: Date.now() - t0 });
  } catch (e) {
    return res.status(502).json({ ok: false, error: err(e), elapsedMs: Date.now() - t0 });
  }
}

// ── privileged: forward resolution ───────────────────────────────────────────
async function runTechEvResolve(req, res) {
  noStore(res);
  if (!TSTORE.hasStore()) return res.status(503).json({ ok: false, reason: 'no blob store configured' });
  const limit = Math.min(RESOLVE_DAY_LIMIT_MAX, Math.max(1, parseInt(req.query.limit, 10) || RESOLVE_DAY_LIMIT_DEFAULT));
  const t0 = Date.now();
  try {
    const { fetchDailyHistory } = require('./screener');
    const idx = await TSTORE.readForwardIndex();
    const matured = idx.dates.filter((d) => d <= FORWARD.maturityCutoffDate() && !idx.resolved.includes(d)).sort();
    const report = { ok: true, considered: matured.length, days: [] };
    const candleCache = new Map();
    const getCandles = async (t, range) => {
      const key = `${t}|${range}`;
      if (!candleCache.has(key)) {
        const h = await fetchDailyHistory(t, range);
        candleCache.set(key, h && h.candles ? h.candles : null);
      }
      return candleCache.get(key);
    };
    let resolvedList = [...idx.resolved];
    for (const day of matured.slice(0, limit)) {
      if (Date.now() - t0 > 110000) { report.days.push({ day, status: 'skipped:budget' }); break; }
      const doc = await TSTORE.readForwardDay(day);
      if (!doc || !Array.isArray(doc.events)) { report.days.push({ day, status: 'unreadable — left unresolved' }); continue; }
      const range = FORWARD.historyRangeFor(day);
      if (!range) {
        await TSTORE.writeForwardDay(day, { ...doc, resolved: { at: new Date().toISOString(), outcomes: [], note: 'events too old to resolve honestly — excluded' } });
        resolvedList = [...resolvedList, day];
        report.days.push({ day, status: 'excluded:too-old' });
        continue;
      }
      const attempts = (doc.resolveAttempts || 0) + 1;
      const outcomes = [];
      let postponeKind = null; // 'maturity' stops the pass; 'fetch' retries next run but lets later days proceed
      let postponeWhy = null;
      let fetchFailures = 0;
      for (const event of doc.events) {
        const candles = await getCandles(event.ticker, range);
        const bench = await getCandles(event.benchmark, range);
        if (!bench) { postponeKind = 'fetch'; postponeWhy = `benchmark ${event.benchmark} unavailable`; break; }
        if (!candles) {
          fetchFailures += 1;
          if (attempts < RESOLVE_MAX_ATTEMPTS) { postponeKind = 'fetch'; postponeWhy = `${event.ticker} candles unavailable`; break; }
          outcomes.push({ id: event.id, status: 'no-history-after-retries' });
          continue;
        }
        const r = FORWARD.resolveEvent(event, candles, bench);
        if (r.status === 'not-mature') { postponeKind = 'maturity'; break; }
        outcomes.push(r);
      }
      if (postponeKind) {
        await TSTORE.writeForwardDay(day, { ...doc, resolveAttempts: attempts });
        report.days.push({ day, status: `postponed:${postponeKind} (attempt ${attempts}, fetchFailures ${fetchFailures}${postponeWhy ? ', ' + postponeWhy : ''})` });
        // A fetch failure is transient infrastructure, unrelated to outcomes — retrying
        // this day next run keeps it unbiased while later days proceed. Immaturity is
        // time-ordered: every later day is strictly less mature, so stop the pass.
        if (postponeKind === 'maturity') break;
        continue;
      }
      const resolvedEvents = outcomes.filter((o) => o.status === 'resolved');
      const rows = resolvedEvents.map((o) => FORWARD.toRow(doc.events.find((e) => e.id === o.id), o));
      await TSTORE.writeForwardDay(day, { ...doc, resolveAttempts: attempts, resolved: { at: new Date().toISOString(), outcomes, resolvedCount: resolvedEvents.length, excluded: outcomes.length - resolvedEvents.length } });
      if (rows.length) await TSTORE.appendForwardRows(rows);
      resolvedList = [...resolvedList, day];
      // Advance the index IMMEDIATELY: a crash later in the pass must not re-resolve
      // this day next run (the rows append is also deduped as a second belt).
      await TSTORE.writeForwardIndex({ ...idx, resolved: [...resolvedList].sort() });
      report.days.push({ day, status: 'resolved', events: outcomes.length, resolvedEvents: resolvedEvents.length });
    }
    return res.status(200).json({ ...report, elapsedMs: Date.now() - t0 });
  } catch (e) {
    return res.status(502).json({ ok: false, error: err(e), elapsedMs: Date.now() - t0 });
  }
}

// ── privileged: bounded PIT backfill (manual, not cron) ──────────────────────
async function runTechEvBackfill(req, res) {
  noStore(res);
  if (!TSTORE.hasStore()) return res.status(503).json({ ok: false, reason: 'no blob store configured' });
  const src = String(req.query.src || '');
  const t0 = Date.now();
  try {
    if (src === 'derive') {
      const r = await COLLECT.runBackfillDerivation({});
      return res.status(200).json({ ...r, elapsedMs: Date.now() - t0 });
    }
    if (!COLLECT.BACKFILL_SOURCES.includes(src)) {
      return res.status(400).json({ ok: false, error: `src must be one of ${COLLECT.BACKFILL_SOURCES.join('|')}|derive` });
    }
    const r = await COLLECT.runBackfill({ source: src });
    return res.status(r.ok ? 200 : 502).json({ ...r, elapsedMs: Date.now() - t0 });
  } catch (e) {
    return res.status(502).json({ ok: false, error: err(e), elapsedMs: Date.now() - t0 });
  }
}

module.exports = {
  runTechEv, runTechEvDetail, runTechEvTick, runTechEvResolve, runTechEvBackfill,
  excerptBucket, attentionFor, observedArmsFrom, DISCLOSURE,
  RESOLVE_DAY_LIMIT_DEFAULT, RESOLVE_MAX_ATTEMPTS,
};

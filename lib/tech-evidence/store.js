'use strict';
// Tech Operational Evidence — durable storage on Vercel Blob (via lib/store helpers).
//
// Layout under techev/v1/:
//   obs/<source>/<retrievalDay>.json  append-only audit ledger of NEWLY observed facts
//                                     (merged first-wins by observation id → idempotent retries,
//                                      historical entries never overwritten)
//   series/<source>.json              compact fold of all observations per source — the
//                                     working set signal math reads; rebuildable from obs docs
//   signals/latest.json               most recent derived-signal snapshot
//   forward/index.json                forward-ledger index (dates observed / resolved)
//   forward/<date>.json               events created at that cutoff (resolution annotates in place;
//                                     creation is write-once, guarded by index membership)
//   forward/rows.json                 compact resolved rows powering the scorecard stats
//   health.json                       per-source collection health + cursors (single writer: the tick)

const STORE = require('../store');

const PREFIX = 'techev/v1';
const KEYS = Object.freeze({
  obsDay: (source, day) => `${PREFIX}/obs/${source}/${day}.json`,
  series: (source) => `${PREFIX}/series/${source}.json`,
  signalsLatest: `${PREFIX}/signals/latest.json`,
  forwardIndex: `${PREFIX}/forward/index.json`,
  forwardDay: (day) => `${PREFIX}/forward/${day}.json`,
  forwardRows: `${PREFIX}/forward/rows.json`,
  health: `${PREFIX}/health.json`,
});

const SERIES_DAY_CAP = 600;    // ≈ npm's 18-month history ceiling
const EVENT_ROW_CAP = 6000;    // compact resolved rows hard cap (oldest trimmed, trim is disclosed)

const hasStore = () => STORE.hasStore();

// ── series folding: the canonical dedup. An observation is FRESH iff the series does
// not already represent it; a same-key different-value arrival is a revision (kept). ──

function emptySeries(source) {
  return { version: 'techev-series-v1', source, entities: {}, updatedAt: null };
}

const trimDateMap = (map, cap = SERIES_DAY_CAP) => {
  const keys = Object.keys(map).sort();
  if (keys.length <= cap) return map;
  return Object.fromEntries(keys.slice(keys.length - cap).map((k) => [k, map[k]]));
};

// Per-source fold handlers: (entity-bucket, obs) → { bucket, fresh } — pure, no mutation.
const FOLDS = {
  npm(bucket = { points: {}, revisions: [] }, o) {
    const prior = bucket.points[o.effectiveDate];
    if (prior === o.value) return { bucket, fresh: false };
    if (prior === undefined) {
      return { bucket: { ...bucket, points: trimDateMap({ ...bucket.points, [o.effectiveDate]: o.value }) }, fresh: true };
    }
    // restated day count — record the revision, keep the original point (PIT: first value stands)
    return { bucket: { ...bucket, revisions: [...bucket.revisions, { date: o.effectiveDate, value: o.value, at: o.retrievedAt }].slice(-50) }, fresh: true };
  },
  github(bucket = { releases: {} }, o) {
    const key = `${o.effectiveDate}|${(o.detail && o.detail.tag) || ''}`;
    if (bucket.releases[key]) return { bucket, fresh: false };
    return { bucket: { ...bucket, releases: trimDateMap({ ...bucket.releases, [key]: { prerelease: !!(o.detail && o.detail.prerelease) } }, SERIES_DAY_CAP) }, fresh: true };
  },
  sec(bucket = { facts: {} }, o) {
    const d = o.detail || {};
    const key = `${o.metric}|${d.start || ''}|${o.effectiveDate}|${o.value}`;
    if (bucket.facts[key]) return { bucket, fresh: false };
    return { bucket: { ...bucket, facts: { ...bucket.facts, [key]: { measure: o.metric, start: d.start || null, end: o.effectiveDate, val: o.value, filed: d.filed || null, form: d.form || null, unit: o.unit } } }, fresh: true };
  },
  statuspage(bucket = { incidents: {} }, o) {
    const id = (o.detail && o.detail.incidentId) || `${o.effectiveDate}|${o.id}`;
    const prior = bucket.incidents[id];
    const next = { day: o.effectiveDate, impact: o.detail && o.detail.impact, durationMin: o.detail && o.detail.durationMin, status: o.detail && o.detail.status };
    if (prior && prior.status === next.status && prior.durationMin === next.durationMin) return { bucket, fresh: false };
    const incidents = { ...bucket.incidents, [id]: next };
    const ids = Object.keys(incidents).sort((a, b) => (incidents[a].day < incidents[b].day ? -1 : 1));
    const trimmed = ids.length > 200 ? Object.fromEntries(ids.slice(-200).map((k) => [k, incidents[k]])) : incidents;
    return { bucket: { ...bucket, incidents: trimmed }, fresh: true };
  },
  snapshotDay(bucket = { days: {} }, o) {
    const key = `${o.effectiveDate}|${o.metric}`;
    if (bucket.days[key] !== undefined) return { bucket, fresh: false }; // one snapshot per metric per day — first wins
    return { bucket: { ...bucket, days: trimDateMap({ ...bucket.days, [key]: o.value }, SERIES_DAY_CAP * 8) }, fresh: true };
  },
  usaspending(bucket = { awards: {} }, o) {
    const id = (o.detail && o.detail.awardId) || `${o.effectiveDate}|${o.value}`;
    if (bucket.awards[id]) return { bucket, fresh: false };
    const awards = { ...bucket.awards, [id]: { date: o.effectiveDate, amount: o.value, agency: o.detail && o.detail.agency } };
    return { bucket: { ...bucket, awards }, fresh: true };
  },
  pricing(bucket = { changes: {} }, o) {
    if (bucket.changes[o.id]) return { bucket, fresh: false };
    return { bucket: { ...bucket, changes: { ...bucket.changes, [o.id]: { day: o.effectiveDate, hash: o.value } } }, fresh: true };
  },
};
FOLDS.greenhouse = FOLDS.snapshotDay;
FOLDS.lever = FOLDS.snapshotDay;
FOLDS.huggingface = FOLDS.snapshotDay;

function foldIntoSeries(source, seriesDoc, observations) {
  const fold = FOLDS[source];
  if (!fold) throw new Error(`no series fold for source "${source}"`);
  let entities = { ...(seriesDoc && seriesDoc.entities || {}) };
  const fresh = [];
  for (const o of observations) {
    const r = fold(entities[o.entity], o);
    entities = { ...entities, [o.entity]: r.bucket };
    if (r.fresh) fresh.push(o);
  }
  return {
    series: { ...(seriesDoc || emptySeries(source)), source, entities, updatedAt: new Date().toISOString() },
    freshObservations: fresh,
  };
}

// ── persistence ──

const readSeries = (source) => STORE.readJSON(KEYS.series(source), emptySeries(source));
const writeSeries = (source, doc) => STORE.writeJSON(KEYS.series(source), doc, 0);

// Append only the fresh observations to today's audit doc; first-wins merge keeps
// the run idempotent under cron retries and preserves firstObservedAt.
async function appendObservations(source, day, freshObs) {
  if (!freshObs.length) return { written: false, added: 0 };
  const key = KEYS.obsDay(source, day);
  const prior = await STORE.readJSON(key, { date: day, source, observations: [] });
  const byId = new Map((prior.observations || []).map((o) => [o.id, o]));
  let added = 0;
  for (const o of freshObs) {
    if (!byId.has(o.id)) { byId.set(o.id, o); added += 1; }
  }
  if (added === 0) return { written: false, added: 0 };
  const next = { ...prior, date: day, source, observations: [...byId.values()], savedAt: new Date().toISOString() };
  await STORE.writeJSON(key, next, 0);
  return { written: true, added };
}

const readObsDay = (source, day) => STORE.readJSON(KEYS.obsDay(source, day), null);

const readSignalsLatest = () => STORE.readJSON(KEYS.signalsLatest, null);
const writeSignalsLatest = (doc) => STORE.writeJSON(KEYS.signalsLatest, doc, 0);

const emptyForwardIndex = () => ({ version: 'techev-forward-v1', dates: [], resolved: [], eventCount: 0 });
const readForwardIndex = () => STORE.readJSON(KEYS.forwardIndex, emptyForwardIndex());
const writeForwardIndex = (idx) => STORE.writeJSON(KEYS.forwardIndex, idx, 0);
const readForwardDay = (day) => STORE.readJSON(KEYS.forwardDay(day), null);
const writeForwardDay = (day, doc) => STORE.writeJSON(KEYS.forwardDay(day), doc, 0);

const emptyRows = () => ({ version: 'techev-rows-v1', rows: [], trimmed: 0 });
const readForwardRows = () => STORE.readJSON(KEYS.forwardRows, emptyRows());
const rowKey = (r) => `${r.d}|${r.t}|${r.arm}`;

// rows.json is a DERIVED CACHE, rebuilt wholesale from the immutable forward day docs.
// It must never be maintained by read-modify-write appends: Blob overwrites propagate
// with a 10-30s read-back lag, so rapid append chains read stale bases and silently
// lose rows (observed live 2026-08-15: 139 resolved outcomes → 34 surviving rows).
// Sharded truth + full rebuild = no lost updates; any historical corruption self-heals
// on the next resolve pass.
function rowsFromDayDocs(dayDocs, { toRow }) {
  const rows = [];
  for (const doc of dayDocs) {
    if (!doc || !doc.resolved || !Array.isArray(doc.resolved.outcomes)) continue;
    for (const o of doc.resolved.outcomes) {
      if (o.status !== 'resolved') continue;
      const event = (doc.events || []).find((e) => e.id === o.id);
      if (event) rows.push(toRow(event, o));
    }
  }
  rows.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : rowKey(a) < rowKey(b) ? -1 : 1));
  const overflow = Math.max(0, rows.length - EVENT_ROW_CAP);
  return { version: 'techev-rows-v1', rows: rows.slice(overflow), trimmed: overflow, savedAt: new Date().toISOString() };
}

const FORWARD_DAY_RE = /^techev\/v1\/forward\/\d{4}-\d{2}-\d{2}\.json$/;
const readAllForwardDays = () => STORE.readAllByPrefix(`${PREFIX}/forward/`, FORWARD_DAY_RE);

// The rebuild UNIONS with the existing cache: an annotation is permanent, so a row can
// never legitimately disappear — but a day doc read during CDN propagation can serve
// its pre-annotation copy (observed live: 63 annotated days read back as 8, converging
// upward over the following hour). Union keeps the cache monotone under that flapping;
// a freshly-read row replaces its cached copy when both exist.
async function rebuildForwardRows({ toRow }) {
  const [dayDocs, prior] = await Promise.all([readAllForwardDays(), readForwardRows()]);
  const rebuilt = rowsFromDayDocs(dayDocs, { toRow });
  const byKey = new Map((prior.rows || []).map((r) => [rowKey(r), r]));
  for (const r of rebuilt.rows) byKey.set(rowKey(r), r);
  const rows = [...byKey.values()].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : rowKey(a) < rowKey(b) ? -1 : 1));
  const overflow = Math.max(0, rows.length - EVENT_ROW_CAP);
  const next = { version: 'techev-rows-v1', rows: rows.slice(overflow), trimmed: overflow, savedAt: new Date().toISOString() };
  await STORE.writeJSON(KEYS.forwardRows, next, 0);
  return { total: next.rows.length, trimmed: next.trimmed, days: dayDocs.length, fromDayDocs: rebuilt.rows.length };
}

const emptyHealth = () => ({ version: 'techev-health-v1', sources: {}, cursors: {}, updatedAt: null });
const readHealth = () => STORE.readJSON(KEYS.health, emptyHealth());

const dropUndefined = (obj) => Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== undefined));

// Per-source DEEP merge: a failing run must never erase the previous lastSuccessAt —
// its patch carries lastSuccessAt: undefined, which a shallow spread would clobber.
async function mergeHealth(patch) {
  const prior = await readHealth();
  const sources = { ...prior.sources };
  for (const [name, s] of Object.entries(patch.sources || {})) {
    sources[name] = { ...(prior.sources[name] || {}), ...dropUndefined(s) };
  }
  const next = {
    ...prior,
    sources,
    cursors: { ...prior.cursors, ...(patch.cursors || {}) },
    updatedAt: new Date().toISOString(),
  };
  await STORE.writeJSON(KEYS.health, next, 0);
  return next;
}

module.exports = {
  KEYS, PREFIX, SERIES_DAY_CAP, EVENT_ROW_CAP, hasStore,
  emptySeries, foldIntoSeries, FOLDS,
  readSeries, writeSeries, appendObservations, readObsDay,
  readSignalsLatest, writeSignalsLatest,
  readForwardIndex, writeForwardIndex, readForwardDay, writeForwardDay, emptyForwardIndex,
  readForwardRows, rowsFromDayDocs, rebuildForwardRows, readAllForwardDays,
  readHealth, mergeHealth,
};

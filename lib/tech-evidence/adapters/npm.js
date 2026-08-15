'use strict';
// npm daily download counts — official public API (api.npmjs.org).
// Genuine point-in-time history: the API serves historical per-day counts, so bounded
// backfill is legitimate. Counts for "today" are always partial — the adapter only ever
// emits COMPLETE days (strictly before the retrieval day, UTC).

const { guardedFetch, adapterResult, isoDay } = require('./common');
const SCHEMA = require('../schema');

const MAX_RANGE_DAYS = 540; // npm caps ranges at 18 months
const API = 'https://api.npmjs.org/downloads/range';

const dayMs = 24 * 60 * 60 * 1000;
const addDays = (iso, n) => new Date(new Date(iso + 'T00:00:00Z').getTime() + n * dayMs).toISOString().slice(0, 10);

function rangeUrl(pkg, startDate, endDate) {
  // Scoped names keep their "/" — npm expects the literal path.
  return `${API}/${startDate}:${endDate}/${pkg}`;
}

// Parse one npm range payload into observations. Missing days are NOT invented:
// they are reported in coverage so signal quality can degrade honestly.
function parseRange(body, { pkg, mapping, retrievedAt, endBound, basis }) {
  const rows = Array.isArray(body && body.downloads) ? body.downloads : null;
  if (!rows) return { observations: [], missingDays: null, error: 'malformed payload: no downloads[]' };
  const seen = new Set();
  const observations = [];
  for (const r of rows) {
    const day = isoDay(r && r.day);
    const value = Number(r && r.downloads);
    if (!day || !Number.isFinite(value) || value < 0) continue;
    if (endBound && day >= endBound) continue; // partial current day never enters the ledger
    seen.add(day);
    observations.push(SCHEMA.makeObservation({
      source: 'npm', ticker: mapping.ticker, entity: pkg, metric: 'downloads',
      effectiveDate: day, value, unit: 'downloads/day',
      sourceUrl: `https://www.npmjs.com/package/${pkg}`,
      // npm publishes a finished day's count the following day (UTC).
      publicAt: addDays(day, 1) + 'T00:00:00Z',
      basis, mappingId: mapping.mappingId, mappingVersion: mapping.version,
      retrievedAt,
    }));
  }
  let missingDays = 0;
  const start = isoDay(body.start);
  const end = isoDay(body.end);
  if (start && end) {
    for (let d = start; d <= end; d = addDays(d, 1)) {
      if ((!endBound || d < endBound) && !seen.has(d)) missingDays += 1;
    }
  }
  return { observations, missingDays, error: null };
}

// Collect a window of complete days for every active npm mapping.
async function collectNpm({ mappings, days = 45, now = new Date(), fetchImpl = null, basis = 'live' } = {}) {
  const retrievedAt = now.toISOString();
  const endBound = retrievedAt.slice(0, 10);               // today (UTC) is partial — excluded
  const endDate = addDays(endBound, -1);
  const startDate = addDays(endBound, -Math.min(Math.max(1, days), MAX_RANGE_DAYS));
  const observations = [];
  const errors = [];
  let rateLimited = false;
  const perEntity = {};
  for (const m of mappings) {
    const pkg = m.sourceId;
    const r = await guardedFetch(rangeUrl(pkg, startDate, endDate), { fetchImpl, retries: 1 });
    if (!r.ok) {
      rateLimited = rateLimited || !!r.rateLimited;
      errors.push(`${pkg}: ${r.error} (${r.category})`);
      perEntity[pkg] = { ok: false, error: r.category };
      continue;
    }
    const parsed = parseRange(r.body, { pkg, mapping: m, retrievedAt, endBound, basis });
    if (parsed.error) { errors.push(`${pkg}: ${parsed.error}`); perEntity[pkg] = { ok: false, error: 'malformed' }; continue; }
    observations.push(...parsed.observations);
    perEntity[pkg] = { ok: true, days: parsed.observations.length, missingDays: parsed.missingDays };
  }
  return adapterResult({ source: 'npm', observations, errors, rateLimited, coverage: { window: `${startDate}..${endDate}`, perEntity } });
}

module.exports = { collectNpm, parseRange, rangeUrl, addDays, MAX_RANGE_DAYS };

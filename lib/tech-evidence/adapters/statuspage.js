'use strict';
// Statuspage-compatible public endpoints (company-reported service status).
// /api/v2/incidents.json returns the recent incident history with immutable created_at
// timestamps — bounded point-in-time backfill of that window is legitimate. Scheduled
// maintenance is intentionally EXCLUDED from the unexpected-incident measure and
// captured separately. All status information is labeled company-reported.

const { guardedFetch, adapterResult, isoDay } = require('./common');
const SCHEMA = require('../schema');

const IMPACT_LEVELS = Object.freeze(['none', 'maintenance', 'minor', 'major', 'critical']);

const incidentsUrl = (host) => `https://${host}/api/v2/incidents.json`;
const maintenanceUrl = (host) => `https://${host}/api/v2/scheduled-maintenances.json`;

function durationMinutes(createdAt, resolvedAt) {
  if (!createdAt || !resolvedAt) return null;
  const ms = new Date(resolvedAt) - new Date(createdAt);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 60000) : null;
}

function parseIncidents(body, { mapping, retrievedAt, basis }) {
  const incidents = Array.isArray(body && body.incidents) ? body.incidents : null;
  if (!incidents) return { observations: [], error: 'malformed payload: no incidents[]' };
  const observations = [];
  for (const inc of incidents) {
    const day = isoDay(inc && inc.created_at);
    if (!day || !inc.id) continue;
    const impact = IMPACT_LEVELS.includes(inc.impact) ? inc.impact : 'none';
    if (impact === 'maintenance') continue; // scheduled work is not an unexpected incident
    observations.push(SCHEMA.makeObservation({
      source: 'statuspage', ticker: mapping.ticker, entity: mapping.sourceId,
      metric: 'incident', effectiveDate: day, value: 1, unit: 'incident',
      sourceUrl: typeof inc.shortlink === 'string' ? inc.shortlink.slice(0, 200) : mapping.sourceUrl,
      publicAt: inc.created_at,
      basis, mappingId: mapping.mappingId, mappingVersion: mapping.version,
      detail: {
        incidentId: String(inc.id).slice(0, 64),
        name: String(inc.name || '').slice(0, 140),
        impact, status: String(inc.status || '').slice(0, 40),
        createdAt: inc.created_at || null, resolvedAt: inc.resolved_at || null,
        durationMin: durationMinutes(inc.created_at, inc.resolved_at),
        components: Array.isArray(inc.components) ? inc.components.length : null,
        reporting: 'company-reported',
      },
      retrievedAt,
    }));
  }
  return { observations, error: null };
}

async function collectStatuspage({ mappings, now = new Date(), fetchImpl = null, basis = 'live' } = {}) {
  const retrievedAt = now.toISOString();
  const observations = [];
  const errors = [];
  let rateLimited = false;
  const perEntity = {};
  for (const m of mappings) {
    const r = await guardedFetch(incidentsUrl(m.sourceId), { fetchImpl, retries: 1 });
    if (!r.ok) {
      rateLimited = rateLimited || !!r.rateLimited;
      errors.push(`${m.sourceId}: ${r.error} (${r.category})`);
      perEntity[m.sourceId] = { ok: false };
      continue;
    }
    const parsed = parseIncidents(r.body, { mapping: m, retrievedAt, basis });
    if (parsed.error) { errors.push(`${m.sourceId}: ${parsed.error}`); perEntity[m.sourceId] = { ok: false }; continue; }
    observations.push(...parsed.observations);
    perEntity[m.sourceId] = { ok: true, incidents: parsed.observations.length };
  }
  return adapterResult({ source: 'statuspage', observations, errors, rateLimited, coverage: { perEntity } });
}

module.exports = { collectStatuspage, parseIncidents, durationMinutes, incidentsUrl, maintenanceUrl, IMPACT_LEVELS };

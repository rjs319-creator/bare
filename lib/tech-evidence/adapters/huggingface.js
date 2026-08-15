'use strict';
// Hugging Face public hub activity — documented public endpoints only.
// The hub exposes CURRENT rolling download counters, not per-day history. This adapter
// therefore snapshots the present as forward-collection evidence and NEVER reconstructs
// unavailable historical downloads from today's value. Signals stay COLLECTING until a
// real accrued baseline exists.

const { guardedFetch, adapterResult } = require('./common');
const SCHEMA = require('../schema');

const MODELS_LIMIT = 100;
const orgModelsUrl = (org) => `https://huggingface.co/api/models?author=${encodeURIComponent(org)}&sort=downloads&limit=${MODELS_LIMIT}`;

function parseOrgModels(body) {
  if (!Array.isArray(body)) return { summary: null, error: 'malformed payload: not an array' };
  let totalDownloads = 0;
  let models = 0;
  let topModel = null;
  for (const m of body) {
    const dl = Number(m && m.downloads);
    if (!m || !m.id || !Number.isFinite(dl)) continue;
    models += 1;
    totalDownloads += dl;
    if (!topModel || dl > topModel.downloads) topModel = { id: String(m.id).slice(0, 120), downloads: dl };
  }
  return { summary: { totalDownloads, models, topModel }, error: null };
}

async function collectHuggingface({ mappings, now = new Date(), fetchImpl = null, budget = null } = {}) {
  const retrievedAt = now.toISOString();
  const day = retrievedAt.slice(0, 10);
  const observations = [];
  const errors = [];
  let rateLimited = false;
  const perEntity = {};
  for (const m of mappings) {
    if (budget && Number.isFinite(budget.deadlineMs) && Date.now() - budget.t0 > budget.deadlineMs) {
      errors.push(`${m.sourceId}: skipped:budget`);
      perEntity[m.sourceId] = { ok: false };
      continue;
    }
    const r = await guardedFetch(orgModelsUrl(m.sourceId), { fetchImpl, retries: 1 });
    if (!r.ok) {
      rateLimited = rateLimited || !!r.rateLimited;
      errors.push(`${m.sourceId}: ${r.error} (${r.category})`);
      perEntity[m.sourceId] = { ok: false };
      continue;
    }
    const parsed = parseOrgModels(r.body);
    if (parsed.error) { errors.push(`${m.sourceId}: ${parsed.error}`); perEntity[m.sourceId] = { ok: false }; continue; }
    observations.push(SCHEMA.makeObservation({
      source: 'huggingface', ticker: m.ticker, entity: m.sourceId,
      metric: 'hubDownloads30d', effectiveDate: day, value: parsed.summary.totalDownloads, unit: 'downloads/30d-rolling',
      sourceUrl: m.sourceUrl, publicAt: retrievedAt,
      basis: 'live', mappingId: m.mappingId, mappingVersion: m.version,
      detail: { models: parsed.summary.models, topModel: parsed.summary.topModel, counterSemantics: 'rolling-30d snapshot; no per-day history exists upstream' },
      retrievedAt,
    }));
    perEntity[m.sourceId] = { ok: true, models: parsed.summary.models };
  }
  return adapterResult({ source: 'huggingface', observations, errors, rateLimited, coverage: { day, perEntity } });
}

module.exports = { collectHuggingface, parseOrgModels, orgModelsUrl, MODELS_LIMIT };

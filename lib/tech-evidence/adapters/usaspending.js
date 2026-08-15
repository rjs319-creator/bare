'use strict';
// USAspending prime awards — official public API (api.usaspending.gov).
// The award's own Start Date is the public action date; announcement or retrieval
// dates are never substituted for it. Recipient matching requires a verified alias
// from the registry — fuzzy name hits are dropped, not guessed.

const { guardedFetch, adapterResult, isoDay } = require('./common');
const SCHEMA = require('../schema');

const SEARCH_URL = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';
const AWARD_TYPES = Object.freeze(['A', 'B', 'C', 'D']); // contracts
const PAGE_LIMIT = 100;

function searchBody(alias, { startDate, endDate, page = 1 } = {}) {
  return {
    filters: {
      recipient_search_text: [alias],
      award_type_codes: [...AWARD_TYPES],
      time_period: [{ start_date: startDate, end_date: endDate }],
    },
    fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Start Date', 'End Date', 'Awarding Agency', 'Award Type', 'generated_internal_id'],
    limit: PAGE_LIMIT,
    page,
  };
}

// Only rows whose recipient name actually contains the verified alias survive.
function parseAwards(body, { alias, mapping, retrievedAt, basis }) {
  const rows = Array.isArray(body && body.results) ? body.results : null;
  if (!rows) return { observations: [], dropped: 0, error: 'malformed payload: no results[]' };
  const needle = alias.toLowerCase();
  const observations = [];
  let dropped = 0;
  for (const r of rows) {
    const recipient = String(r['Recipient Name'] || '');
    if (!recipient.toLowerCase().includes(needle)) { dropped += 1; continue; }
    const actionDate = isoDay(r['Start Date']);
    const amount = Number(r['Award Amount']);
    const awardId = r['Award ID'] || r.generated_internal_id;
    if (!actionDate || !Number.isFinite(amount) || !awardId) { dropped += 1; continue; }
    observations.push(SCHEMA.makeObservation({
      source: 'usaspending', ticker: mapping.ticker, entity: alias,
      metric: 'awardAmount', effectiveDate: actionDate, value: amount, unit: 'USD',
      sourceUrl: r.generated_internal_id
        ? `https://www.usaspending.gov/award/${encodeURIComponent(r.generated_internal_id)}`
        : 'https://www.usaspending.gov/search',
      publicAt: null, // reporting lag is real and unknown per-row; forward ledger treats these as context, not entries
      basis, mappingId: mapping.mappingId, mappingVersion: mapping.version,
      detail: {
        awardId: String(awardId).slice(0, 80), recipient: recipient.slice(0, 140),
        agency: String(r['Awarding Agency'] || '').slice(0, 120),
        awardType: String(r['Award Type'] || '').slice(0, 60),
        endDate: isoDay(r['End Date']),
      },
      retrievedAt,
    }));
  }
  return { observations, dropped, error: null };
}

async function collectUsaspending({ mappings, lookbackDays = 365, now = new Date(), fetchImpl = null, basis = 'live' } = {}) {
  const retrievedAt = now.toISOString();
  const endDate = retrievedAt.slice(0, 10);
  const startDate = new Date(now.getTime() - lookbackDays * 86400000).toISOString().slice(0, 10);
  const observations = [];
  const errors = [];
  let rateLimited = false;
  const perEntity = {};
  for (const m of mappings) {
    const alias = m.sourceId;
    const r = await guardedFetch(SEARCH_URL, {
      fetchImpl, retries: 1, method: 'POST', timeoutMs: 15000,
      body: searchBody(alias, { startDate, endDate }),
    });
    if (!r.ok) {
      rateLimited = rateLimited || !!r.rateLimited;
      errors.push(`${alias}: ${r.error} (${r.category})`);
      perEntity[alias] = { ok: false };
      continue;
    }
    const parsed = parseAwards(r.body, { alias, mapping: m, retrievedAt, basis });
    if (parsed.error) { errors.push(`${alias}: ${parsed.error}`); perEntity[alias] = { ok: false }; continue; }
    observations.push(...parsed.observations);
    perEntity[alias] = { ok: true, awards: parsed.observations.length, dropped: parsed.dropped };
  }
  return adapterResult({ source: 'usaspending', observations, errors, rateLimited, coverage: { window: `${startDate}..${endDate}`, perEntity } });
}

module.exports = { collectUsaspending, parseAwards, searchBody, SEARCH_URL, AWARD_TYPES, PAGE_LIMIT };

'use strict';
// Greenhouse + Lever public job boards — official public endpoints only.
// Postings are MANAGEMENT INTENT, not completed hiring. The derived measure is the
// hiring MIX by function (revenue-adjacent vs product vs AI-infra), never a simplistic
// bullish total. No applicant or employee data is ever collected — only posting titles,
// functions, locations and timestamps. Forward-collection: snapshots begin accruing at
// first run; there is no legitimate historical backfill for job boards.

const { guardedFetch, adapterResult } = require('./common');
const SCHEMA = require('../schema');

// Ordered — first match wins. AI-infrastructure checked before generic engineering.
const FUNCTION_RULES = Object.freeze([
  ['ai-infrastructure', /\b(ai|machine learning|\bml\b|llm|gpu|inference)\b/i],
  ['sales', /\b(sales|account executive|account manager|business development|revenue)\b/i],
  ['customer-success', /customer success|support engineer|technical account|solutions architect|professional services/i],
  ['product', /\bproduct (manager|management|design|marketing)/i],
  ['marketing', /marketing|growth|demand gen/i],
  ['engineering', /engineer|developer|\bsre\b|devops|software|infrastructure|security/i],
]);
const FUNCTIONS = Object.freeze([...FUNCTION_RULES.map(([f]) => f), 'other']);

function classifyTitle(title) {
  const t = String(title || '');
  for (const [fn, re] of FUNCTION_RULES) if (re.test(t)) return fn;
  return 'other';
}

// Reduce a normalized posting list to per-function counts + churn fingerprint.
function summarizePostings(postings, { sinceDays = 7, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - sinceDays * 86400000).toISOString();
  const byFunction = Object.fromEntries(FUNCTIONS.map((f) => [f, 0]));
  const locations = new Set();
  let recentlyPosted = 0;
  for (const p of postings) {
    byFunction[classifyTitle(p.title)] += 1;
    if (p.location) locations.add(String(p.location).toLowerCase());
    if (p.postedAt && p.postedAt >= cutoff) recentlyPosted += 1;
  }
  const fingerprint = SCHEMA.contentHash(postings.map((p) => `${p.id}|${p.title}`).sort().join('\n'));
  return { total: postings.length, byFunction, distinctLocations: locations.size, recentlyPosted, fingerprint };
}

function parseGreenhouse(body) {
  const jobs = Array.isArray(body && body.jobs) ? body.jobs : null;
  if (!jobs) return { postings: null, error: 'malformed payload: no jobs[]' };
  return {
    postings: jobs.map((j) => ({
      id: String(j.id ?? ''),
      title: String(j.title || '').slice(0, 160),
      location: j.location && j.location.name ? String(j.location.name).slice(0, 120) : null,
      postedAt: j.first_published || j.updated_at || null,
    })),
    error: null,
  };
}

function parseLever(body) {
  if (!Array.isArray(body)) return { postings: null, error: 'malformed payload: not an array' };
  return {
    postings: body.map((j) => ({
      id: String(j.id ?? ''),
      title: String(j.text || '').slice(0, 160),
      location: j.categories && j.categories.location ? String(j.categories.location).slice(0, 120) : null,
      postedAt: Number.isFinite(j.createdAt) ? new Date(j.createdAt).toISOString() : null,
    })),
    error: null,
  };
}

const boardUrl = {
  greenhouse: (token) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=false`,
  lever: (site) => `https://api.lever.co/v0/postings/${encodeURIComponent(site)}?mode=json`,
};
const parseBoard = { greenhouse: parseGreenhouse, lever: parseLever };

function snapshotObservations(summary, { source, mapping, day, retrievedAt }) {
  const base = {
    source, ticker: mapping.ticker, entity: mapping.sourceId,
    effectiveDate: day, sourceUrl: mapping.sourceUrl, publicAt: retrievedAt,
    basis: 'live', mappingId: mapping.mappingId, mappingVersion: mapping.version, retrievedAt,
  };
  const detail = { fingerprint: summary.fingerprint, distinctLocations: summary.distinctLocations, recentlyPosted: summary.recentlyPosted, intent: 'management intent — postings, not completed hiring' };
  const obs = [SCHEMA.makeObservation({ ...base, metric: 'jobsTotal', value: summary.total, unit: 'postings', detail })];
  for (const fn of FUNCTIONS) {
    obs.push(SCHEMA.makeObservation({ ...base, metric: `jobs:${fn}`, value: summary.byFunction[fn], unit: 'postings' }));
  }
  return obs;
}

async function collectJobs({ source, mappings, now = new Date(), fetchImpl = null } = {}) {
  if (!boardUrl[source]) throw new Error(`collectJobs: unsupported source "${source}"`);
  const retrievedAt = now.toISOString();
  const day = retrievedAt.slice(0, 10);
  const observations = [];
  const errors = [];
  let rateLimited = false;
  const perEntity = {};
  for (const m of mappings) {
    const r = await guardedFetch(boardUrl[source](m.sourceId), { fetchImpl, retries: 1 });
    if (!r.ok) {
      rateLimited = rateLimited || !!r.rateLimited;
      errors.push(`${m.sourceId}: ${r.error} (${r.category})`);
      perEntity[m.sourceId] = { ok: false };
      continue;
    }
    const parsed = parseBoard[source](r.body);
    if (parsed.error) { errors.push(`${m.sourceId}: ${parsed.error}`); perEntity[m.sourceId] = { ok: false }; continue; }
    const summary = summarizePostings(parsed.postings, { now });
    observations.push(...snapshotObservations(summary, { source, mapping: m, day, retrievedAt }));
    perEntity[m.sourceId] = { ok: true, total: summary.total };
  }
  return adapterResult({ source, observations, errors, rateLimited, coverage: { day, perEntity } });
}

module.exports = { collectJobs, parseGreenhouse, parseLever, classifyTitle, summarizePostings, FUNCTIONS, FUNCTION_RULES, boardUrl };

'use strict';
// GitHub public repository activity — official REST API, company-owned repos only.
// The economically interpretable measure is RELEASE CADENCE on the monetized client
// (releases have immutable published_at timestamps → genuine point-in-time history).
// Raw commit counts and stars are deliberately not collected — they do not measure
// customer demand. Uses an optional GITHUB_TOKEN; unauthenticated calls stay within
// the 60/hr budget (one page per repo per run) and degrade honestly on 403.

const { guardedFetch, adapterResult, isoDay, mapWithBudget } = require('./common');
const SCHEMA = require('../schema');

const API = 'https://api.github.com';
const PER_PAGE = 100;
const MAX_BACKFILL_PAGES = 5; // ≤500 releases per repo — plenty for cadence baselines

function authHeaders(token = process.env.GITHUB_TOKEN) {
  const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function parseReleases(body, { repo, mapping, retrievedAt, basis }) {
  if (!Array.isArray(body)) return { observations: [], error: 'malformed payload: not an array' };
  const observations = [];
  for (const rel of body) {
    if (!rel || rel.draft) continue;
    const publishedAt = rel.published_at || rel.created_at;
    const day = isoDay(publishedAt);
    if (!day) continue;
    observations.push(SCHEMA.makeObservation({
      source: 'github', ticker: mapping.ticker, entity: repo, metric: 'release',
      effectiveDate: day, value: 1, unit: 'release',
      sourceUrl: typeof rel.html_url === 'string' ? rel.html_url.slice(0, 300) : `https://github.com/${repo}/releases`,
      publicAt: publishedAt,
      basis, mappingId: mapping.mappingId, mappingVersion: mapping.version,
      discriminator: String(rel.tag_name || rel.id || '').slice(0, 80), // repos ship several releases per day
      detail: { tag: String(rel.tag_name || '').slice(0, 80), prerelease: !!rel.prerelease },
      retrievedAt,
    }));
  }
  return { observations, error: null };
}

async function fetchReleasePage(repo, page, { fetchImpl, token } = {}) {
  const url = `${API}/repos/${repo}/releases?per_page=${PER_PAGE}&page=${page}`;
  return guardedFetch(url, { fetchImpl, headers: authHeaders(token), retries: 0 });
}

async function collectGithub({ mappings, now = new Date(), fetchImpl = null, token = undefined,
  maxPages = 1, basis = 'live', budget = null } = {}) {
  const retrievedAt = now.toISOString();
  const observations = [];
  const errors = [];
  let rateLimited = false;
  const perEntity = {};
  const results = await mapWithBudget(mappings, async (m) => {
    const repo = m.sourceId;
    let repoObs = [];
    let failed = null;
    let rl = false;
    for (let page = 1; page <= Math.min(maxPages, MAX_BACKFILL_PAGES); page += 1) {
      const r = await fetchReleasePage(repo, page, { fetchImpl, token });
      if (!r.ok) {
        // 403 with no token is the unauthenticated rate limit — classify as such.
        rl = r.rateLimited || r.status === 403;
        failed = `${repo}: ${r.error} (${rl ? 'rate_limited' : r.category})`;
        break;
      }
      const parsed = parseReleases(r.body, { repo, mapping: m, retrievedAt, basis });
      if (parsed.error) { failed = `${repo}: ${parsed.error}`; break; }
      repoObs = repoObs.concat(parsed.observations);
      if (!Array.isArray(r.body) || r.body.length < PER_PAGE) break; // last page
    }
    return { repo, observations: repoObs, failed, rateLimited: rl };
  }, { budget });
  for (const res of results) {
    if (res.skippedBudget) { errors.push(`${res.item.sourceId}: skipped:budget`); perEntity[res.item.sourceId] = { ok: false }; continue; }
    rateLimited = rateLimited || res.rateLimited;
    if (res.failed && res.observations.length === 0) { errors.push(res.failed); perEntity[res.repo] = { ok: false }; continue; }
    if (res.failed) errors.push(res.failed + ' (partial)');
    observations.push(...res.observations);
    perEntity[res.repo] = { ok: true, releases: res.observations.length };
  }
  return adapterResult({ source: 'github', observations, errors, rateLimited, coverage: { perEntity } });
}

module.exports = { collectGithub, parseReleases, authHeaders, PER_PAGE, MAX_BACKFILL_PAGES };

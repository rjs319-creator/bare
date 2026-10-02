'use strict';
// Workday public job boards — the cxs JSON endpoint behind every <tenant>.wdN.myworkdayjobs.com
// careers site: POST /wday/cxs/<tenant>/<site>/jobs {appliedFacets, limit, offset, searchText}
// → { total, jobPostings:[{ title, externalPath, locationsText, postedOn, bulletFields }] }.
// Unofficial but stable since 2020 and unauthenticated for tenants that expose a public
// site (tenants without one answer 401/422 — recorded as candidates, never retried blindly).
// `postedOn` is RELATIVE text ("Posted Today", "Posted 30+ Days Ago"); an open-ended age is
// unknown (null), never clamped to a number. Pagination is capped by pages AND by the run
// budget so one tenant with thousands of requisitions cannot eat the night.

const { guardedFetch } = require('./common');

const PAGE_SIZE = 20;    // the endpoint's maximum
const MAX_PAGES = 15;    // 300 postings — enough for the mid-cap tenants registered here
const SOURCE_ID_RE = /^([a-z0-9-]+)\/(wd\d+)\/([A-Za-z0-9_-]+)$/;
const WORKDAY_HEADERS = Object.freeze({ Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 market-news-app tech-evidence' });

function parseSourceId(sourceId) {
  const m = SOURCE_ID_RE.exec(String(sourceId || ''));
  return m ? { tenant: m[1], wd: m[2], site: m[3] } : null;
}

function workdayJobsUrl(sourceId) {
  const p = parseSourceId(sourceId);
  return p ? `https://${p.tenant}.${p.wd}.myworkdayjobs.com/wday/cxs/${p.tenant}/${p.site}/jobs` : null;
}

const DAY_MS = 86400000;
function postedOnToIso(text, now) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  if (/^posted today$/.test(t)) return now.toISOString();
  if (/^posted yesterday$/.test(t)) return new Date(now.getTime() - DAY_MS).toISOString();
  const m = /^posted (\d+) days? ago$/.exec(t); // "30+ days ago" deliberately does not match
  return m ? new Date(now.getTime() - Number(m[1]) * DAY_MS).toISOString() : null;
}

function parseWorkdayPage(body, { now = new Date() } = {}) {
  const rows = body && Array.isArray(body.jobPostings) ? body.jobPostings : null;
  if (!rows) return { postings: null, total: null, error: 'malformed payload: no jobPostings[]' };
  const total = Number.isFinite(Number(body.total)) ? Number(body.total) : null;
  const postings = rows.map((j) => ({
    id: String((Array.isArray(j.bulletFields) && j.bulletFields[0]) || j.externalPath || '').slice(0, 160),
    title: String(j.title || '').slice(0, 160),
    location: j.locationsText ? String(j.locationsText).slice(0, 120) : null,
    postedAt: postedOnToIso(j.postedOn, now),
  }));
  return { postings, total, error: null };
}

const overBudget = (budget) => budget && Number.isFinite(budget.deadlineMs) && Date.now() - budget.t0 > budget.deadlineMs;

// Paginate one tenant; partial pages are kept and the result SAYS it was cut short.
async function fetchWorkdayPostings(mapping, { fetchImpl = null, now = new Date(), budget = null } = {}) {
  const url = workdayJobsUrl(mapping.sourceId);
  if (!url) return { postings: null, error: `malformed workday sourceId "${mapping.sourceId}" (want tenant/wdN/site)` };
  const postings = [];
  let total = null;
  let truncated = false;
  let rateLimited = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (overBudget(budget)) {
      if (!postings.length) return { postings: null, error: `${mapping.sourceId}: skipped:budget` };
      truncated = true;
      break;
    }
    const body = { appliedFacets: {}, limit: PAGE_SIZE, offset: page * PAGE_SIZE, searchText: '' };
    const r = await guardedFetch(url, { fetchImpl, method: 'POST', body, headers: WORKDAY_HEADERS, retries: 1 });
    if (!r.ok) {
      rateLimited = rateLimited || !!r.rateLimited;
      if (!postings.length) return { postings: null, error: `${mapping.sourceId}: ${r.error} (${r.category})`, rateLimited };
      truncated = true; // keep what we have; the fingerprint will differ, which is honest
      break;
    }
    const parsed = parseWorkdayPage(r.body, { now });
    if (parsed.error) return { postings: null, error: `${mapping.sourceId}: ${parsed.error}` };
    postings.push(...parsed.postings);
    total = parsed.total;
    if (!parsed.postings.length || (total != null && postings.length >= total)) break;
    if (page === MAX_PAGES - 1 && total != null && postings.length < total) truncated = true;
  }
  return { postings, total, truncated, error: null, rateLimited };
}

module.exports = { PAGE_SIZE, MAX_PAGES, parseSourceId, workdayJobsUrl, postedOnToIso, parseWorkdayPage, fetchWorkdayPostings };

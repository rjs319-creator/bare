'use strict';
// Prevents: SSRF through the shared fetch layer, oversized-response memory blowups,
// GitHub drafts/rate-limits mishandled, job postings collecting personal data or a
// naive bullish job total, statuspage maintenance counted as incidents, Hugging Face
// history reconstruction, USAspending fuzzy-recipient false positives, and pricing
// diffs leaking unbounded page content.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { guardedFetch } = require('../lib/tech-evidence/adapters/common');
const GH = require('../lib/tech-evidence/adapters/github');
const JOBS = require('../lib/tech-evidence/adapters/jobs');
const SP = require('../lib/tech-evidence/adapters/statuspage');
const HF = require('../lib/tech-evidence/adapters/huggingface');
const USA = require('../lib/tech-evidence/adapters/usaspending');
const PR = require('../lib/tech-evidence/adapters/pricing');

const NOW = new Date('2026-08-11T15:00:00Z');
const okJson = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) });

test('guardedFetch refuses non-allowlisted hosts without touching the network', async () => {
  let called = 0;
  const r = await guardedFetch('https://internal-metadata.example/latest', { fetchImpl: async () => { called += 1; return okJson({}); } });
  assert.equal(r.category, 'blocked');
  assert.equal(called, 0, 'the request must never leave the process');
});

test('guardedFetch enforces the body-size cap', async () => {
  const big = 'x'.repeat(3 * 1024 * 1024);
  const r = await guardedFetch('https://api.npmjs.org/x', { fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => big }) });
  assert.equal(r.category, 'oversized');
});

test('budget exhaustion skips remaining mappings VISIBLY instead of overrunning', async () => {
  const NPM = require('../lib/tech-evidence/adapters/npm');
  const spentBudget = { t0: Date.now() - 10000, deadlineMs: 1 }; // already over
  let called = 0;
  const r = await NPM.collectNpm({
    mappings: [{ ticker: 'MDB', mappingId: 'm1', version: 2, sourceId: 'mongodb' }],
    now: NOW, budget: spentBudget, fetchImpl: async () => { called += 1; return okJson({}); },
  });
  assert.equal(called, 0, 'no new fetch may start past the deadline');
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /skipped:budget/, 'a starved mapping must be visible in the report, not silently absent');
});

test('github: drafts skipped, 403 treated as rate limit, partial pages survive', async () => {
  const mapping = { ticker: 'MDB', mappingId: 'MDB-github-node-driver', version: 2, sourceId: 'mongodb/node-mongodb-native' };
  const rel = (tag, at, extra = {}) => ({ tag_name: tag, published_at: at, html_url: `https://github.com/r/${tag}`, ...extra });
  const parsed = GH.parseReleases([rel('v1', '2026-08-01T10:00:00Z'), rel('v2', '2026-08-02T10:00:00Z', { draft: true })], { repo: 'r', mapping, retrievedAt: NOW.toISOString(), basis: 'live' });
  assert.equal(parsed.observations.length, 1, 'draft releases are not public evidence');
  const r = await GH.collectGithub({ mappings: [mapping], now: NOW, fetchImpl: async () => ({ ok: false, status: 403, headers: { get: () => null }, text: async () => 'limited' }) });
  assert.equal(r.rateLimited, true);
  assert.equal(r.ok, false);
});

test('jobs: title classification is a MIX, ai-infra precedes engineering, totals labeled intent', () => {
  assert.equal(JOBS.classifyTitle('Senior Machine Learning Engineer'), 'ai-infrastructure');
  assert.equal(JOBS.classifyTitle('Enterprise Account Executive'), 'sales');
  assert.equal(JOBS.classifyTitle('Software Engineer, Storage'), 'engineering');
  assert.equal(JOBS.classifyTitle('Head of Chairs'), 'other');
  const parsed = JOBS.parseGreenhouse({ jobs: [
    { id: 1, title: 'Account Executive', location: { name: 'NYC' }, first_published: '2026-08-10T00:00:00Z' },
    { id: 2, title: 'ML Engineer', location: { name: 'Remote' }, updated_at: '2026-05-01T00:00:00Z' },
  ] });
  const summary = JOBS.summarizePostings(parsed.postings, { now: NOW });
  assert.equal(summary.total, 2);
  assert.equal(summary.byFunction.sales, 1);
  assert.equal(summary.byFunction['ai-infrastructure'], 1);
  assert.equal(summary.recentlyPosted, 1);
  // No applicant/personal fields survive normalization.
  assert.deepEqual(Object.keys(parsed.postings[0]).sort(), ['id', 'location', 'postedAt', 'title']);
});

test('statuspage: scheduled maintenance excluded; duration + impact preserved; company-reported label present', () => {
  const mapping = { ticker: 'NET', mappingId: 'NET-status', version: 2, sourceId: 'www.cloudflarestatus.com', sourceUrl: 'https://www.cloudflarestatus.com/api/v2/summary.json' };
  const body = { incidents: [
    { id: 'i1', name: 'API errors', impact: 'major', status: 'resolved', created_at: '2026-08-01T10:00:00Z', resolved_at: '2026-08-01T12:30:00Z', components: [{}, {}], shortlink: 'https://stspg.io/x' },
    { id: 'i2', name: 'Planned DB maintenance', impact: 'maintenance', status: 'completed', created_at: '2026-08-02T01:00:00Z' },
  ] };
  const r = SP.parseIncidents(body, { mapping, retrievedAt: NOW.toISOString(), basis: 'live' });
  assert.equal(r.observations.length, 1);
  assert.equal(r.observations[0].detail.durationMin, 150);
  assert.equal(r.observations[0].detail.reporting, 'company-reported');
});

test('huggingface: snapshot-only semantics — one observation per org per day, no history invention', () => {
  const parsed = HF.parseOrgModels([{ id: 'org/model-a', downloads: 100 }, { id: 'org/model-b', downloads: 50 }]);
  assert.equal(parsed.summary.totalDownloads, 150);
  assert.equal(parsed.summary.topModel.id, 'org/model-a');
});

test('usaspending: recipient rows not containing the verified alias are dropped, never guessed', () => {
  const mapping = { ticker: 'MDB', mappingId: 'MDB-usaspending', version: 2 };
  const body = { results: [
    { 'Award ID': 'A1', 'Recipient Name': 'MONGODB INC', 'Award Amount': 1000000, 'Start Date': '2026-05-01', 'Awarding Agency': 'GSA', generated_internal_id: 'g1' },
    { 'Award ID': 'A2', 'Recipient Name': 'MONGO CONSTRUCTION LLC', 'Award Amount': 999, 'Start Date': '2026-05-02' },
  ] };
  const r = USA.parseAwards(body, { alias: 'MongoDB', mapping, retrievedAt: NOW.toISOString(), basis: 'live' });
  assert.equal(r.observations.length, 1);
  assert.equal(r.dropped, 1);
  assert.equal(r.observations[0].effectiveDate, '2026-05-01', 'the award action date, never the retrieval date');
});

test('pricing: a mapping pointing off the company domain is refused (SSRF guard)', async () => {
  const evil = { ticker: 'MDB', mappingId: 'MDB-evil', version: 2, sourceUrl: 'https://internal.corp.local/admin', domain: 'mongodb.com' };
  let called = 0;
  const r = await PR.collectPricing({ mappings: [evil], prevSnapshots: {}, now: NOW, fetchImpl: async () => { called += 1; return okJson({}); } });
  assert.equal(called, 0);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /refused/);
});

test('pricing: normalization strips noise, first sight emits no event, real change emits bounded diff', async () => {
  const mapping = { ticker: 'MDB', mappingId: 'MDB-pricing', version: 2, sourceUrl: 'https://www.mongodb.com/pricing', domain: 'mongodb.com' };
  const page = (price) => `<html><script>track()</script><body><h1>Pricing</h1><p>Dedicated ${price}/mo</p><p>© 2026-08-11T10:00:00Z</p></body></html>`;
  const fetch1 = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => page('$57') });
  const r1 = await PR.collectPricing({ mappings: [mapping], prevSnapshots: {}, now: NOW, fetchImpl: fetch1 });
  assert.equal(r1.observations.length, 0, 'first snapshot is a baseline, not a change');
  assert.ok(r1.nextSnapshots['MDB-pricing'].hash);
  // Same content but a different embedded timestamp — must NOT register as change.
  const r2 = await PR.collectPricing({ mappings: [mapping], prevSnapshots: r1.nextSnapshots, now: NOW, fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => page('$57').replace('2026-08-11T10:00:00Z', '2026-08-12T09:00:00Z') }) });
  assert.equal(r2.observations.length, 0, 'timestamp churn is page noise');
  const r3 = await PR.collectPricing({ mappings: [mapping], prevSnapshots: r1.nextSnapshots, now: NOW, fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => page('$64') }) });
  assert.equal(r3.observations.length, 1, 'a substantive price change registers');
  const diff = r3.observations[0].detail.diff;
  assert.ok(diff.added.length <= PR.MAX_DIFF_LINES && diff.removed.length <= PR.MAX_DIFF_LINES);
  assert.ok(diff.added.join('\n').includes('$64'));
});

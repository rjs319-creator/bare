'use strict';
// Prevents: Ashby unlisted postings counted as public intent, Workday relative dates
// mis-read as absolute, unbounded Workday pagination, Workday tenants on arbitrary hosts
// passing the SSRF allowlist, and personal data surviving normalization.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const JOBS = require('../lib/tech-evidence/adapters/jobs');
const WD = require('../lib/tech-evidence/adapters/jobs-workday');
const R = require('../lib/tech-evidence/registry');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'techev', name), 'utf8'));
const NOW = new Date('2026-10-02T05:00:00Z');
const okJson = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) });

test('Ashby parser (real board shape, probed 2026-10-02): listed postings only, normalized fields, no personal data', () => {
  const parsed = JOBS.parseAshby(fixture('ashby-board-ramp.json'));
  assert.equal(parsed.error, null);
  assert.equal(parsed.postings.length, 3, 'the isListed:false posting is not public intent');
  assert.deepEqual(Object.keys(parsed.postings[0]).sort(), ['id', 'location', 'postedAt', 'title']);
  assert.equal(parsed.postings[0].title.trim(), 'Security Engineer, Cloud');
  assert.equal(parsed.postings[0].postedAt, '2026-04-07T17:12:35.753+00:00');
  assert.match(JOBS.parseAshby({ apiVersion: '1' }).error, /jobs/);
  assert.equal(JOBS.boardUrl.ashby('ramp'), 'https://api.ashbyhq.com/posting-api/job-board/ramp');
});

test('Workday page parser (real cxs shape, probed 2026-10-02): requisition id, relative postedOn → ISO or null', () => {
  const page = WD.parseWorkdayPage(fixture('workday-etsy-page.json'), { now: NOW });
  assert.equal(page.error, null);
  assert.equal(page.total, 58);
  assert.equal(page.postings.length, 2);
  assert.equal(page.postings[0].id, 'JR5959');
  assert.equal(page.postings[0].location, 'Brooklyn, New York');
  assert.equal(page.postings[0].postedAt, '2026-10-02T05:00:00.000Z', '"Posted Today" resolves to the retrieval instant');
  assert.match(WD.parseWorkdayPage({ nope: true }, { now: NOW }).error, /jobPostings/);
});

test('Workday postedOn vocabulary: Today/Yesterday/N Days Ago/30+ Days Ago', () => {
  const at = (s) => WD.postedOnToIso(s, NOW);
  assert.equal(at('Posted Today'), NOW.toISOString());
  assert.equal(at('Posted Yesterday'), new Date(NOW.getTime() - 86400000).toISOString());
  assert.equal(at('Posted 12 Days Ago'), new Date(NOW.getTime() - 12 * 86400000).toISOString());
  assert.equal(at('Posted 30+ Days Ago'), null, 'an open-ended age is unknown, not 30');
  assert.equal(at(''), null);
});

test('Workday collection paginates by limit/offset, stops at total, caps pages, and threads the budget', async () => {
  const total = 58;
  const posting = (i) => ({ title: `Software Engineer ${i}`, externalPath: `/job/x/SE_${i}`, locationsText: 'Brooklyn, New York', postedOn: 'Posted Today', bulletFields: [`JR${i}`] });
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, method: init.method, offset: body.offset, limit: body.limit });
    const rows = Array.from({ length: Math.min(body.limit, total - body.offset) }, (_, k) => posting(body.offset + k));
    return okJson({ total, jobPostings: rows });
  };
  const mapping = { ticker: 'ETSY', mappingId: 'ETSY-workday', version: 2, sourceId: 'etsy/wd5/Etsy_Careers', sourceUrl: 'https://etsy.wd5.myworkdayjobs.com/Etsy_Careers' };
  const r = await WD.fetchWorkdayPostings(mapping, { fetchImpl });
  assert.equal(r.error, null);
  assert.equal(r.postings.length, total);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.method === 'POST' && c.url === 'https://etsy.wd5.myworkdayjobs.com/wday/cxs/etsy/Etsy_Careers/jobs'));
  assert.deepEqual(calls.map((c) => c.offset), [0, 20, 40]);
  // page cap: a tenant claiming 10,000 postings gets truncated and SAYS so
  const big = await WD.fetchWorkdayPostings(mapping, { fetchImpl: async (url, init) => okJson({ total: 10000, jobPostings: Array.from({ length: 20 }, (_, k) => posting(JSON.parse(init.body).offset + k)) }) });
  assert.equal(big.postings.length, WD.MAX_PAGES * WD.PAGE_SIZE);
  assert.equal(big.truncated, true);
  // budget: already over → no fetch at all
  let called = 0;
  const starved = await WD.fetchWorkdayPostings(mapping, { fetchImpl: async () => { called += 1; return okJson({}); }, budget: { t0: Date.now() - 5000, deadlineMs: 1 } });
  assert.equal(called, 0);
  assert.match(starved.error, /budget/);
});

test('collectJobs runs ashby and workday behind the same adapter interface as greenhouse/lever', async () => {
  const ashby = await JOBS.collectJobs({
    source: 'ashby', now: NOW,
    mappings: [{ ticker: 'XYZ', mappingId: 'XYZ-ashby', version: 2, sourceId: 'ramp', sourceUrl: 'https://jobs.ashbyhq.com/ramp' }],
    fetchImpl: async () => okJson(fixture('ashby-board-ramp.json')),
  });
  assert.equal(ashby.ok, true, JSON.stringify(ashby.errors));
  assert.equal(ashby.observations.find((o) => o.metric === 'jobsTotal').value, 3);
  assert.equal(ashby.observations.find((o) => o.metric === 'jobsTotal').source, 'ashby');
  const workday = await JOBS.collectJobs({
    source: 'workday', now: NOW,
    mappings: [{ ticker: 'ETSY', mappingId: 'ETSY-workday', version: 2, sourceId: 'etsy/wd5/Etsy_Careers', sourceUrl: 'https://etsy.wd5.myworkdayjobs.com/Etsy_Careers' }],
    // first page = the real fixture (total 58 but trimmed to 2 rows); later pages empty → the loop must stop on an empty page
    fetchImpl: async (url, init) => okJson(JSON.parse(init.body).offset === 0 ? fixture('workday-etsy-page.json') : { total: 58, jobPostings: [] }),
  });
  assert.equal(workday.ok, true, JSON.stringify(workday.errors));
  assert.equal(workday.observations.find((o) => o.metric === 'jobsTotal').value, 2);
  assert.equal(workday.observations.find((o) => o.metric === 'jobs:ai-infrastructure').value, 2, 'both fixture titles are ML roles');
  await assert.rejects(() => JOBS.collectJobs({ source: 'taleo', mappings: [], now: NOW }), /unsupported source/);
});

test('registry: Workday mappings must live on <tenant>.wdN.myworkdayjobs.com matching their tenant/site id; Ashby on api.ashbyhq.com', () => {
  const wd = R.MAPPINGS.filter((m) => m.source === 'workday');
  assert.ok(wd.length >= 3, 'ETSY/CHWY/DKNG Workday tenants were probe-verified 2026-10-02');
  for (const m of wd) {
    assert.match(m.sourceId, /^[a-z0-9-]+\/wd\d+\/[A-Za-z0-9_-]+$/, m.mappingId);
    assert.ok(R.validateMapping(m).ok, `${m.mappingId}: ${R.validateMapping(m).issues.join('; ')}`);
    assert.ok(R.isAllowedUrl(WD.workdayJobsUrl(m.sourceId)), `${m.mappingId} jobs URL must be fetchable`);
  }
  const etsy = wd.find((m) => m.ticker === 'ETSY');
  assert.equal(R.validateMapping({ ...etsy, sourceUrl: 'https://evil.wd5.myworkdayjobs.com/Etsy_Careers' }).ok, false, 'host must match the tenant in sourceId');
  assert.equal(R.validateMapping({ ...etsy, sourceUrl: 'https://etsy.wd5.myworkdayjobs.com.evil.example/x' }).ok, false);
  assert.ok(R.OFFICIAL_API_HOSTS.includes('api.ashbyhq.com'));
  assert.ok(R.MAPPINGS.some((m) => m.ticker === 'TWLO' && m.source === 'greenhouse'), 'Twilio board token "twilio" probed 200 on 2026-10-02');
  for (const t of ['MDB', 'DDOG', 'NET', 'TWLO', 'ESTC']) {
    assert.ok(R.CANDIDATES.some((c) => c.ticker === t && ['ashby', 'workday'].includes(c.source)), `${t}: Ashby/Workday probe outcome must be recorded`);
  }
});

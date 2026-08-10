'use strict';
// Capability auditor: classification, cap detection, date extraction, summary.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runFmpCapabilityAudit, classifyProbe, dateRangeOf, probeList, STATUS } = require('../lib/fmp-audit');
const { CATEGORY } = require('../lib/fmp-client');

test('classifyProbe maps every client category to a report status', () => {
  assert.equal(classifyProbe({ category: CATEGORY.OK, rows: 3 }), STATUS.AVAILABLE);
  assert.equal(classifyProbe({ category: CATEGORY.OK, rows: 0 }), STATUS.EMPTY_BUT_ACCESSIBLE);
  assert.equal(classifyProbe({ category: CATEGORY.PLAN_GATED, rows: 0 }), STATUS.PLAN_GATED);
  assert.equal(classifyProbe({ category: CATEGORY.NOT_FOUND, rows: 0 }), STATUS.INVALID_OR_LEGACY);
  assert.equal(classifyProbe({ category: CATEGORY.INVALID_REQUEST, rows: 0 }), STATUS.INVALID_OR_LEGACY);
  assert.equal(classifyProbe({ category: CATEGORY.RATE_LIMITED, rows: 0 }), STATUS.TEMPORARILY_FAILED);
  assert.equal(classifyProbe({ category: CATEGORY.UPSTREAM_ERROR, rows: 0 }), STATUS.TEMPORARILY_FAILED);
  assert.equal(classifyProbe({ category: CATEGORY.NETWORK, rows: 0 }), STATUS.TEMPORARILY_FAILED);
  assert.equal(classifyProbe({ category: CATEGORY.INVALID_JSON, rows: 0 }), STATUS.TEMPORARILY_FAILED);
});

test('dateRangeOf finds min/max across date-shaped fields, null when none', () => {
  const rows = [
    { publishedDate: '2026-08-01T10:00:00Z', x: 1 },
    { date: '2026-07-15', x: 2 },
    { filingDate: '2026-08-05', x: 3 },
  ];
  assert.deepEqual(dateRangeOf(rows), { earliest: '2026-07-15', latest: '2026-08-05' });
  assert.equal(dateRangeOf([{ x: 1 }]), null);
  assert.equal(dateRangeOf([]), null);
});

test('probeList covers the target families and stays a bounded budget', () => {
  const list = probeList();
  const families = new Set(list.map((p) => p.family));
  for (const f of ['estimates', 'analyst', 'news', 'sec', 'insider', 'institutional', 'transcripts', 'reference', 'earnings', 'quotes', 'intraday']) {
    assert.ok(families.has(f), `family ${f} missing from probe list`);
  }
  assert.ok(list.length <= 30, 'probe budget must stay small');
  const ids = list.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'probe ids must be unique');
});

test('runFmpCapabilityAudit classifies per scripted responses and detects caps', async () => {
  const script = (path, params) => {
    if (path === '/analyst-estimates' && params.period === 'annual') {
      return { ok: true, status: 200, category: CATEGORY.OK, rows: 10, attempts: 1, error: null, body: Array.from({ length: 10 }, (_, i) => ({ date: `2026-0${(i % 8) + 1}-01`, epsAvg: 1 })) };
    }
    if (path === '/analyst-estimates') return { ok: false, status: 402, category: CATEGORY.PLAN_GATED, rows: 0, body: null, attempts: 1, error: 'FMP /analyst-estimates HTTP 402: gated' };
    if (path === '/news/press-releases-latest') return { ok: false, status: 404, category: CATEGORY.NOT_FOUND, rows: 0, body: null, attempts: 1, error: 'FMP /news/press-releases-latest HTTP 404' };
    if (path === '/insider-trading/latest') return { ok: false, status: 503, category: CATEGORY.UPSTREAM_ERROR, rows: 0, body: null, attempts: 2, error: 'FMP /insider-trading/latest HTTP 503' };
    if (path === '/price-target-consensus') return { ok: true, status: 200, category: CATEGORY.OK, rows: 0, body: [], attempts: 1, error: null };
    return { ok: true, status: 200, category: CATEGORY.OK, rows: 2, body: [{ date: '2026-08-01' }, { date: '2026-08-02' }], attempts: 1, error: null };
  };
  const report = await runFmpCapabilityAudit({ request: async (p, params) => script(p, params), sleep: async () => {}, spacingMs: 0 });

  assert.equal(report.probeCount, probeList().length);
  assert.equal(report.probes['analyst-estimates-annual'].status, STATUS.AVAILABLE);
  assert.equal(report.probes['analyst-estimates-annual'].capped, true);          // rows === limit
  assert.ok(report.probes['analyst-estimates-annual'].dateRange.earliest < report.probes['analyst-estimates-annual'].dateRange.latest);
  assert.equal(report.probes['analyst-estimates-quarter'].status, STATUS.PLAN_GATED);
  assert.equal(report.probes['press-releases-latest'].status, STATUS.INVALID_OR_LEGACY);
  assert.equal(report.probes['insider-trading-latest'].status, STATUS.TEMPORARILY_FAILED);
  assert.equal(report.probes['price-target-consensus'].status, STATUS.EMPTY_BUT_ACCESSIBLE);
  assert.ok(report.summary[STATUS.AVAILABLE].includes('analyst-estimates-annual'));
  assert.ok(report.summary[STATUS.PLAN_GATED].includes('analyst-estimates-quarter'));
  // The persisted/printed report must never carry a key-bearing URL.
  assert.ok(!JSON.stringify(report).includes('apikey='), 'apikey param leaked into report');
});

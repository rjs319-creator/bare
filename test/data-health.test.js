'use strict';
// Consolidated data-health report (Phase 10): absence of data is a finding, not a
// blank; secrets are booleans only; every section failure is captured, never thrown.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildDataHealthReport, DATA_HEALTH_VERSION } = require('../lib/data-health');

// With no Blob store configured (test env), every storage-backed section must degrade
// to an explicit warning/absence — and the report must still assemble.
test('report assembles without a store and reports absence explicitly', async () => {
  const report = await buildDataHealthReport({ now: Date.UTC(2026, 7, 1) });
  assert.equal(report.version, DATA_HEALTH_VERSION);
  assert.ok(Array.isArray(report.problems));
  assert.ok(report.sections.universe, 'universe section present');
  assert.ok(report.sections.decisionLedger, 'ledger section present');
  assert.ok(report.sections.outcomes, 'outcomes section present');
  // No store → not healthy, with named problems (never a silent green).
  assert.equal(report.healthy, false);
  assert.ok(report.problems.length > 0);
});

test('keys section exposes booleans only — never values', async () => {
  process.env.FMP_API_KEY = 'sk_live_SHOULD_NEVER_APPEAR';
  try {
    const report = await buildDataHealthReport({ now: Date.UTC(2026, 7, 1) });
    assert.equal(report.sections.keys.fmp, true);
    assert.ok(!JSON.stringify(report).includes('SHOULD_NEVER_APPEAR'), 'secret value leaked into the report');
  } finally { delete process.env.FMP_API_KEY; }
});

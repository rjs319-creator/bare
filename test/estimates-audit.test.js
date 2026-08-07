'use strict';
// PIT sample auditor: fixture-based contract tests. The auditor must never
// declare PIT safety from column names alone — only from observed revision
// structure — and must degrade to honest NOT_PIT / PIT_UNPROVEN /
// INSUFFICIENT_SAMPLE classifications with explicit reasons.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { auditEstimatesSample, inferColumns, parseCsv } = require('../lib/research/estimates-audit');

const NOW = '2026-08-01T00:00:00Z';
const TICKERS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOG', 'META', 'TSLA', 'AMD', 'ORCL', 'CRM'];

// 10 tickers × 3 dated observations of one fiscal period, values revised each time.
function revisionHistoryFixture() {
  const rows = [];
  TICKERS.forEach((t, ti) => {
    ['2026-05-01', '2026-06-01', '2026-07-01'].forEach((d, di) => {
      rows.push({
        ticker: t, security_id: `SEC${ti}`, per_end_date: '2026-09-30', est_type: 'EPS',
        mean_est: 1 + ti * 0.1 + di * 0.05, as_of_date: d, num_analysts: 12 + di,
        up_revisions: di, down_revisions: 0, status: 'active',
      });
    });
  });
  return rows;
}

test('1. valid revision history classifies PIT_LIKELY with explicit reasons', () => {
  const r = auditEstimatesSample(revisionHistoryFixture(), { now: NOW });
  assert.equal(r.classification, 'PIT_LIKELY');
  assert.equal(r.multiObsGroups, 10);
  assert.equal(r.valuesChange, true);
  assert.equal(r.futureTimestampViolations, 0);
  assert.ok(r.reasons.some(x => /as-of queries/.test(x)));
  assert.ok(r.limitations.some(x => /vendor documentation/i.test(x)), 'must stay preliminary');
});

test('2. latest-value-only/restated dataset classifies NOT_PIT', () => {
  const rows = TICKERS.flatMap((t, ti) => [
    { ticker: t, per_end_date: '2026-09-30', mean_est: 1 + ti * 0.1, as_of_date: '2026-07-01' },
    { ticker: t, per_end_date: '2026-12-31', mean_est: 2 + ti * 0.1, as_of_date: '2026-07-01' },
  ]);
  const r = auditEstimatesSample(rows, { now: NOW });
  assert.equal(r.classification, 'NOT_PIT');
  assert.equal(r.multiObsGroups, 0);
  assert.ok(r.reasons.some(x => /latest-value-only/.test(x)));
});

test('3. multiple records without a usable availability date classify NOT_PIT', () => {
  const rows = revisionHistoryFixture().map(({ as_of_date, ...rest }) => rest);
  const r = auditEstimatesSample(rows, { now: NOW });
  assert.equal(r.classification, 'NOT_PIT');
  assert.ok(r.reasons.some(x => /no usable observation\/as-of date/.test(x)));
});

test('4. sample with no active/inactive column reports survivorship as undetectable', () => {
  const rows = revisionHistoryFixture().map(({ status, ...rest }) => rest);
  const r = auditEstimatesSample(rows, { now: NOW });
  assert.equal(r.activeCoverage.detectable, false);
  assert.ok(r.limitations.some(x => /survivorship/i.test(x)));
  // and detectable when present:
  const r2 = auditEstimatesSample(revisionHistoryFixture(), { now: NOW });
  assert.equal(r2.activeCoverage.detectable, true);
});

test('5. conflicting ticker/security-id mappings are counted and surfaced', () => {
  const rows = revisionHistoryFixture();
  rows.push({ ...rows[0], as_of_date: '2026-04-01', security_id: 'SEC_OTHER' });
  const r = auditEstimatesSample(rows, { now: NOW });
  assert.ok(r.ambiguousIdentifierMappings >= 1);
  assert.ok(r.reasons.some(x => /ambiguous ticker\/security-id/.test(x)));
});

test('6. future-known estimates disqualify PIT_LIKELY', () => {
  const rows = revisionHistoryFixture().map(row => ({ ...row, as_of_date: row.as_of_date.replace('2026', '2027') }));
  const r = auditEstimatesSample(rows, { now: NOW });
  assert.ok(r.futureTimestampViolations > 0);
  assert.notEqual(r.classification, 'PIT_LIKELY');
  assert.ok(r.reasons.some(x => /future/.test(x)));
});

test('7. negative and near-zero EPS values audit cleanly', () => {
  const rows = revisionHistoryFixture().map((row, i) => ({ ...row, mean_est: [-0.42, 0, 0.001][i % 3] + (i * 1e-4) }));
  const r = auditEstimatesSample(rows, { now: NOW });
  assert.equal(r.classification, 'PIT_LIKELY');
  assert.equal(r.valuesChange, true);
  for (const v of Object.values(r.missingnessByField)) assert.ok(Number.isFinite(v.pct));
});

test('8. missing analyst coverage shows up in missingness, not as a crash', () => {
  const rows = revisionHistoryFixture().map(({ num_analysts, ...rest }) => ({ ...rest, num_analysts: '' }));
  const r = auditEstimatesSample(rows, { now: NOW });
  assert.equal(r.missingnessByField.num_analysts.pct, 100);
  assert.equal(r.classification, 'PIT_LIKELY', 'analyst count is diagnostic, not disqualifying');
});

test('tiny samples classify INSUFFICIENT_SAMPLE, never PIT', () => {
  const r = auditEstimatesSample(revisionHistoryFixture().slice(0, 6), { now: NOW });
  assert.equal(r.classification, 'INSUFFICIENT_SAMPLE');
});

test('column inference maps common vendor names and reports all candidates', () => {
  const m = inferColumns(['m_ticker', 'per_end_date', 'eps_mean_est', 'obs_date', 'num_analysts']);
  assert.equal(m.ticker.pick, 'm_ticker');
  assert.equal(m.fiscalPeriod.pick, 'per_end_date');
  assert.equal(m.asOfDate.pick, 'obs_date');
  assert.equal(m.analystCount.pick, 'num_analysts');
  assert.ok(Array.isArray(m.estimateValue.candidates));
});

test('csv parser handles quoted fields and CRLF', () => {
  const rows = parseCsv('ticker,note\r\nAAPL,"hello, ""world"""\r\nMSFT,plain\r\n');
  assert.deepEqual(rows, [{ ticker: 'AAPL', note: 'hello, "world"' }, { ticker: 'MSFT', note: 'plain' }]);
});

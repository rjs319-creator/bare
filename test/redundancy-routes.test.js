'use strict';

const test = require('node:test');
const assert = require('node:assert');
const RR = require('../lib/redundancy-routes');
const DR = require('../lib/decision-routes');

test('loadRedundancyModel returns null with no Blob store (never throws)', async () => {
  const prev = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    assert.strictEqual(await RR.loadRedundancyModel(), null);
  } finally {
    if (prev !== undefined) process.env.BLOB_READ_WRITE_TOKEN = prev;
  }
});

test('ledger sections resolve through the CANONICAL section→id map', () => {
  const D = require('../lib/decision');
  // The sections buildRows can actually ingest today (picks + ghost ledgers) must
  // resolve to sources the decision engine can address, else their measured
  // credits could never match a live signal.
  for (const section of ['screener', 'momentum', 'Ghost']) {
    const source = RR.sourceForSection(section);
    assert.ok(source, `${section} must map to a source`);
    assert.ok(D.SOURCE_FAMILY[source], `source "${source}" (from section "${section}") is absent from SOURCE_FAMILY`);
  }
  // THE regression the canonical map fixes: the old local table would have sent
  // CERN rows to 'cern', a key no registry id matches — silently emptying that
  // algorithm's series in every downstream join.
  assert.equal(RR.sourceForSection('CERN'), 'events');
  assert.equal(RR.sourceForSection('OMEGA'), 'omega');
  // Unmapped sections still fall back to lowercase, honestly unmatched.
  assert.equal(RR.sourceForSection('NotARealSection'), 'notarealsection');
});

test('the redundancy horizon matches the Scoreboard swing metric it is compared against', () => {
  const D = require('../lib/decision');
  assert.strictEqual(RR.HORIZON_DAYS, 5);
  assert.strictEqual(D.HORIZON_METRIC.swing, '5d', 'measured credits must be comparable to the 5d track record');
});

test('buildToday without a redundancy model reports method:prior honestly', () => {
  const payload = DR.buildToday({}, null, null);
  assert.strictEqual(payload.redundancy.method, 'prior');
  assert.strictEqual(payload.redundancy.priorCredit, require('../lib/decision').CORR_DISCOUNT);
  assert.match(payload.redundancy.note, /No measured redundancy model yet/);
});

test('buildToday surfaces a measured model as provenance', () => {
  const R = require('../lib/redundancy');
  const D = require('../lib/decision');
  const dates = Array.from({ length: 20 }, (_, i) => `2026-06-${String(i + 1).padStart(2, '0')}`);
  const rows = [];
  for (const date of dates) for (const ticker of ['AAA', 'BBB']) {
    const excess = (ticker.charCodeAt(0) % 5) - 2 + dates.indexOf(date) * 0.1;
    rows.push({ date, ticker, algorithm: 'screener', excess });
    rows.push({ date, ticker, algorithm: 'momentum', excess });
  }
  const model = R.buildRedundancyModel(rows, {
    priorCredit: D.CORR_DISCOUNT, familyOf: (s) => D.SOURCE_FAMILY[s] || null,
  });
  const payload = DR.buildToday({}, null, model);
  assert.strictEqual(payload.redundancy.method, 'measured');
  assert.strictEqual(payload.redundancy.verdict, 'more-redundant-than-assumed');
  assert.ok(payload.redundancy.measurablePairs >= 1);
  assert.strictEqual(payload.redundancy.priorCredit, D.CORR_DISCOUNT);
});

test('buildToday stays resilient with empty sources and a model present', () => {
  const payload = DR.buildToday({}, null, { credits: {}, summary: { measurablePairs: 0, totalPairs: 0 }, verdict: 'insufficient', priorCredit: 0.3 });
  assert.ok(payload.counts, 'payload must still assemble');
  assert.strictEqual(payload.redundancy.method, 'measured');
});

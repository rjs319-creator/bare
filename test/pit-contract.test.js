'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const P = require('../lib/pit-contract');

const rec = (o) => ({ securityId: 'SEC1', ticker: 'AAA', tradingDate: '2023-01-03', observationTs: '2023-01-03', ...o });

test('as-of join REJECTS future-dated information', () => {
  const records = [
    rec({ observationTs: '2023-01-03' }),
    rec({ tradingDate: '2023-01-10', observationTs: '2023-01-10' }),   // after the decision
    rec({ tradingDate: '2023-01-02', observationTs: '2023-01-02' }),
  ];
  const kept = P.asOfJoin(records, '2023-01-05');
  assert.strictEqual(kept.length, 2, 'only records knowable on/before 2023-01-05');
  assert.ok(kept.every(r => P.knownAt(r) <= '2023-01-05'));
});

test('as-of join REJECTS same-day information not yet PUBLISHED', () => {
  // A fundamental observed for 2023-01-03 but published 2023-01-20 is not knowable on the 3rd.
  const records = [rec({ observationTs: '2023-01-03', publicationTs: '2023-01-20', fundamentals: { eps: 1 } })];
  assert.strictEqual(P.asOfJoin(records, '2023-01-03').length, 0, 'publication after decision → excluded');
  assert.strictEqual(P.asOfJoin(records, '2023-01-20').length, 1, 'knowable once published');
});

test('pointInTimeValue returns the latest value knowable as-of the date', () => {
  const records = [
    rec({ observationTs: '2023-01-02', marketCap: 100 }),
    rec({ observationTs: '2023-01-04', marketCap: 120 }),
    rec({ observationTs: '2023-01-08', marketCap: 200 }),
  ];
  assert.strictEqual(P.pointInTimeValue(records, 'marketCap', '2023-01-05'), 120);
});

test('delisted securities can REMAIN in a historical universe (as-of before delisting)', () => {
  const r = rec({ securityId: 'DEAD', ticker: 'ZZZ', tradingDate: '2022-06-01', observationTs: '2022-06-01', listedDate: '2019-01-01', delistedDate: '2022-12-31' });
  const integ = P.checkIntegrity([r], { asOf: '2022-06-01' });
  assert.ok(integ.ok, 'a bar within [listed, delisted] is valid: ' + JSON.stringify(integ.issues));
});

test('integrity flags before-listing and after-delisting records', () => {
  const before = rec({ tradingDate: '2018-01-01', listedDate: '2019-01-01' });
  const after = rec({ tradingDate: '2023-06-01', delistedDate: '2022-12-31' });
  const integ = P.checkIntegrity([before, after]);
  assert.ok(integ.issues.some(i => i.type === 'before-listing'));
  assert.ok(integ.issues.some(i => i.type === 'after-delisting'));
});

test('integrity flags duplicate security/date, future fundamentals, ticker reuse, adjustment mismatch', () => {
  const dup1 = rec({}); const dup2 = rec({});
  const futFund = rec({ securityId: 'S2', tradingDate: '2023-01-03', fundamentalPublicationTs: '2023-02-01' });
  const reuse = rec({ securityId: 'S3', ticker: 'AAA' });   // ticker AAA now maps to SEC1 and S3
  const badAdj = rec({ securityId: 'S4', closeRaw: 100, adjFactor: 1, closeAdj: 130 });
  const integ = P.checkIntegrity([dup1, dup2, futFund, reuse, badAdj], { asOf: '2023-01-05' });
  assert.ok(integ.issues.some(i => i.type === 'duplicate-security-date'));
  assert.ok(integ.issues.some(i => i.type === 'future-fundamental'));
  assert.ok(integ.warnings.some(w => w.type === 'ticker-reuse'));
  assert.ok(integ.warnings.some(w => w.type === 'adjustment-mismatch'));
});

test('validateRecord rejects missing required fields and publication-before-observation', () => {
  assert.ok(!P.validateRecord({ ticker: 'X' }).ok);
  assert.ok(P.validateRecord(rec({})).ok);
  assert.ok(P.validateRecord(rec({ publicationTs: '2023-01-01', observationTs: '2023-01-03' })).issues.includes('publication-before-observation'));
});

test('suspiciousForwardCorrelation catches a planted future-leak feature', () => {
  const rows = Array.from({ length: 50 }, (_, i) => {
    const label = (i % 7) / 7 - 0.5;
    return { label, features: { honest: Math.sin(i), LEAK: label * 2 + 1e-9 } };  // LEAK ~ label
  });
  const out = P.suspiciousForwardCorrelation(rows, 'label', { threshold: 0.95 });
  assert.ok(out.flagged.some(f => f.feature === 'LEAK'), 'planted leak flagged');
  assert.ok(!out.flagged.some(f => f.feature === 'honest'), 'honest feature not flagged');
});

test('dataset suitability: old picks are EVAL-ONLY, not train-ready', () => {
  const picks = P.datasetSuitability({ hasRejectedCandidates: false, hasDelisted: false, pointInTimeUniverse: false });
  assert.strictEqual(picks.trainReady, false);
  assert.strictEqual(picks.evalOnly, true);
  assert.ok(picks.reasons.length >= 2);
  const full = P.datasetSuitability({ hasRejectedCandidates: true, hasDelisted: true, pointInTimeUniverse: true });
  assert.strictEqual(full.trainReady, true);
  assert.strictEqual(full.survivorshipSafe, true);
});

test('fingerprint is deterministic and order-independent', () => {
  const a = [rec({ tradingDate: '2023-01-03' }), rec({ securityId: 'S2', tradingDate: '2023-01-04' })];
  const b = [a[1], a[0]];
  assert.strictEqual(P.fingerprint(a), P.fingerprint(b));
});

'use strict';
// Tests for the Alpha Vantage listing-universe collector core
// (research/lib/av-listings.js): plan determinism/resume, CSV parsing with
// quoted fields, response classification (rate limits never mistaken for
// data), tamper-evident partitions, and every validation gate incl. the
// no-free-pass verdict rule.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const AV = require('../research/lib/av-listings');

test('plan: latest snapshots first, monthly actives from 2010-01, quarterly delisted; resume skips done keys', () => {
  const { plan, pending } = AV.snapshotPlan({ toYm: '2010-06' });
  assert.equal(plan[0].key, 'latest-active');
  assert.equal(plan[1].key, 'latest-delisted');
  const actives = plan.filter((p) => /^active-/.test(p.key));
  assert.equal(actives.length, 6);                       // 2010-01..2010-06
  assert.equal(actives[0].date, '2010-01-31');
  assert.equal(actives[1].date, '2010-02-28');           // month-end arithmetic
  const delisted = plan.filter((p) => /^delisted-/.test(p.key));
  assert.deepEqual(delisted.map((d) => d.key), ['delisted-2010-03', 'delisted-2010-06']);
  const resumed = AV.snapshotPlan({ toYm: '2010-06', doneKeys: new Set(['latest-active', 'active-2010-01']) });
  assert.equal(resumed.pending.length, plan.length - 2);
  assert.ok(!resumed.pending.some((p) => p.key === 'active-2010-01'));
});

test('csv: quoted company names with commas and doubled quotes parse correctly', () => {
  const text = 'symbol,name,exchange,assetType,ipoDate,delistingDate,status\n'
    + 'AAI,"AIRTRAN HOLDINGS, INC",NYSE,Stock,2001-09-17,2011-11-30,Delisted\r\n'
    + 'QQ,"He said ""hi"", Inc",NASDAQ,Stock,2010-01-04,null,Active\n';
  const out = AV.classifyResponse(text);
  assert.equal(out.kind, 'csv');
  assert.equal(out.records.length, 2);
  assert.equal(out.records[0].name, 'AIRTRAN HOLDINGS, INC');
  assert.equal(out.records[0].delistingDate, '2011-11-30');
  assert.equal(out.records[1].name, 'He said "hi", Inc');
  assert.equal(out.records[1].delistingDate, null, "the literal string 'null' becomes a real null");
});

test('classify: rate-limit and error JSON bodies are never mistaken for data; wrong headers rejected', () => {
  assert.equal(AV.classifyResponse('{"Information": "Thank you... our standard API rate limit is 25 requests per day"}').kind, 'rate-limited');
  assert.equal(AV.classifyResponse('{"Note": "premium plan required for higher frequency"}').kind, 'rate-limited');
  assert.equal(AV.classifyResponse('{"Error Message": "Invalid API call"}').kind, 'error');
  assert.equal(AV.classifyResponse('').kind, 'empty');
  assert.equal(AV.classifyResponse('foo,bar\n1,2\n').kind, 'error');
});

test('partitions: content-addressed and tamper-evident', () => {
  const records = [{ symbol: 'AAA', name: 'A', exchange: 'NYSE', assetType: 'Stock', ipoDate: '2010-01-04', delistingDate: null, status: 'Active' }];
  const doc = AV.partitionDoc({ key: 'active-2010-01', state: 'active', asOfDate: '2010-01-31', records, retrievedAt: 'T' });
  assert.equal(AV.partitionValid(doc), true);
  assert.equal(AV.partitionValid({ ...doc, records: [{ ...records[0], delistingDate: '2011-01-01' }] }), false);
  const doc2 = AV.partitionDoc({ key: 'active-2010-01', state: 'active', asOfDate: '2010-01-31', records: [{ ...records[0], symbol: 'BBB' }], retrievedAt: 'T' });
  assert.notEqual(doc.contentHash, doc2.contentHash);
});

test('gate 1: convention window (±21d, Form-25 effectiveness) counts as agreement; beyond it fails', () => {
  const av = Array.from({ length: 100 }, (_, i) => ({ symbol: `S${i}`, delistingDate: '2024-06-10', assetType: 'Stock' }));
  const knownGood = Array.from({ length: 100 }, (_, i) => ({ symbol: `S${i}`, date: '2024-06-20' }));   // the +10d convention offset
  const g1 = AV.gateDelistingReconciliation(av, knownGood);
  assert.equal(g1.status, 'pass');
  assert.equal(g1.offsetStats.median, 10, 'the convention offset is measured and reported');
  const knownBad = knownGood.map((k, i) => (i < 10 ? { ...k, date: '2024-09-01' } : k));               // 10% off by months
  const g2 = AV.gateDelistingReconciliation(av, knownBad);
  assert.equal(g2.status, 'fail');
  assert.equal(g2.tailCount, 10);
  assert.ok(g2.disagreements.length > 0);
  assert.equal(AV.gateDelistingReconciliation(av, knownGood.slice(0, 10)).status, 'insufficient-data');
});

test('gate 1 + adjudication: tail symbols EDGAR sides with AV on stop counting against it; the rest still do', () => {
  const av = Array.from({ length: 100 }, (_, i) => ({ symbol: `S${i}`, delistingDate: '2024-06-10', assetType: 'Stock' }));
  const known = Array.from({ length: 100 }, (_, i) => ({ symbol: `S${i}`, date: i < 10 ? '2024-09-01' : '2024-06-20' }));
  const unresolved = AV.gateDelistingReconciliation(av, known);
  assert.equal(unresolved.status, 'fail');
  // EDGAR adjudicates 8 of the 10 tail symbols in AV's favor → 98% ≥ 95%.
  const adjudication = { avConsistentSymbols: Array.from({ length: 8 }, (_, i) => `S${i}`) };
  const resolved = AV.gateDelistingReconciliation(av, known, { adjudication });
  assert.equal(resolved.status, 'pass');
  assert.equal(resolved.tailResolvedForAv, 8);
  assert.equal(resolved.adjudicated, true);
  assert.equal(resolved.disagreements.length, 2, 'unadjudicated tail symbols remain disclosed disagreements');
  // Adjudicating only 4 of 10 leaves 94% → still fail (no free pass).
  const partial = AV.gateDelistingReconciliation(av, known, { adjudication: { avConsistentSymbols: ['S0', 'S1', 'S2', 'S3'] } });
  assert.equal(partial.status, 'fail');
});

test('adjudicateDelistingCase: Form-25 filing anchors AV, filing+10 anchors the secmaster; no evidence fails closed', () => {
  // AV = last trading day ≈ filing date; secmaster carried a wrong date.
  const avRight = AV.adjudicateDelistingCase({ symbol: 'X', avDate: '2024-06-10', knownDate: '2024-09-01', form25FilingDate: '2024-06-11' });
  assert.equal(avRight.verdict, 'av-consistent');
  assert.equal(avRight.avConsistent, true);
  assert.equal(avRight.effectiveDate, '2024-06-21');
  // Secmaster matches filing+10; AV is months off.
  const secRight = AV.adjudicateDelistingCase({ symbol: 'Y', avDate: '2024-02-01', knownDate: '2024-06-21', form25FilingDate: '2024-06-11' });
  assert.equal(secRight.verdict, 'secmaster-consistent');
  assert.equal(secRight.avConsistent, false);
  // Neither side near the filing → EDGAR disagrees with both.
  assert.equal(AV.adjudicateDelistingCase({ symbol: 'Z', avDate: '2023-01-01', knownDate: '2023-06-01', form25FilingDate: '2024-06-11' }).verdict, 'edgar-disagrees-with-both');
  // Form 15 fallback uses a wider window on the filing date itself.
  assert.equal(AV.adjudicateDelistingCase({ symbol: 'W', avDate: '2024-05-20', knownDate: '2024-09-01', form15FilingDate: '2024-06-05' }).verdict, 'av-consistent');
  // No filings at all → never an AV agreement.
  const none = AV.adjudicateDelistingCase({ symbol: 'V', avDate: '2024-05-20', knownDate: '2024-09-01' });
  assert.equal(none.verdict, 'no-edgar-evidence');
  assert.equal(none.avConsistent, false);
});

test('gate 2: membership sanity catches out-of-band months and cliffs', () => {
  const good = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`20${10 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`, 4000 + i * 10]));
  assert.equal(AV.gateMembershipSanity(good).status, 'pass');
  const cliff = { ...good }; const yms = Object.keys(cliff).sort(); cliff[yms[15]] = 2000;             // out of band AND a cliff
  const g = AV.gateMembershipSanity(cliff);
  assert.equal(g.status, 'fail');
  assert.ok(g.outOfBandMonths.length >= 1);
  assert.ok(g.cliffs.length >= 1);
  assert.equal(AV.gateMembershipSanity({ '2010-01': 4000 }).status, 'insufficient-data');
});

test('gate 3: a symbol active AFTER its delisting date is a consistency violation', () => {
  const mk = (syms, asOfDate) => ({ asOfDate, records: syms.map((s) => ({ symbol: s, assetType: 'Stock' })) });
  const universe = Array.from({ length: 400 }, (_, i) => `S${i}`);
  const monthly = [mk(universe, '2015-06-30')];
  const delisted = [{ symbol: 'S0', delistingDate: '2014-01-15' }];                                    // claims S0 died in 2014, yet active mid-2015
  const g = AV.gateInternalConsistency(monthly, delisted);
  assert.equal(g.violations, 1);
  assert.equal(g.status, 'pass', 'one violation in 400 is inside the re-listing tolerance');
  const manyDelisted = universe.slice(0, 20).map((s) => ({ symbol: s, delistingDate: '2014-01-15' }));
  assert.equal(AV.gateInternalConsistency(monthly, manyDelisted).status, 'fail');
});

test('gate 4: rename spot-checks — old symbol active again means failure', () => {
  const active = [{ symbol: 'DAY' }, { symbol: 'RDUS' }];
  const delisted = [{ symbol: 'CDAY', delistingDate: '2023-08-01' }, { symbol: 'SCHN', delistingDate: '2023-11-01' }];
  const ok = AV.gateRenameSpotChecks(active, delisted, [{ old: 'CDAY', new: 'DAY' }, { old: 'SCHN', new: 'RDUS' }]);
  assert.equal(ok.status, 'pass');
  const bad = AV.gateRenameSpotChecks([...active, { symbol: 'CDAY' }], delisted, [{ old: 'CDAY', new: 'DAY' }]);
  assert.equal(bad.status, 'fail');
});

test('verdict: any failing gate → FAILED; missing data → ACCRUING, never a pass by default', () => {
  const pass = { gate: 'a', status: 'pass' };
  assert.equal(AV.gatesVerdict([pass, { gate: 'b', status: 'fail' }]).verdict, 'FAILED');
  assert.equal(AV.gatesVerdict([pass, { gate: 'b', status: 'insufficient-data' }]).verdict, 'ACCRUING');
  assert.equal(AV.gatesVerdict([pass, { gate: 'b', status: 'pass' }]).verdict, 'CANDIDATE_AUTHORITATIVE');
  assert.match(AV.gatesVerdict([pass, pass]).reason, /reviewed code change/);
});

'use strict';
// Insider-cluster prospective feed (2026-09): pure parsers/emitters + the shared FROZEN
// event definition, driven without a network.
const test = require('node:test');
const assert = require('node:assert/strict');
const IC = require('../lib/insider-cluster');
const F = require('../lib/insider-cluster-feed');
const S69 = require('../research/69-insider-cluster');
const K = require('../research/lib/experiment-kit');
const EDGAR = require('../lib/edgar');

// Real lines from form.20260908.idx (fixed-width; company names may contain digits/commas).
const IDX = `Description:           Daily Index of EDGAR Dissemination Feed by Form Type
Form Type   Company Name                                                  CIK         Date Filed  File Name
---------------------------------------------------------------------------------------------------------------------------------------------
1                Bitnomial Exchange, LLC (Security Futures Product Exchange)   2154047     20260904    edgar/data/2154047/9999999997-26-001474.txt
4                10x Genomics, Inc.                                            1770787     20260908    edgar/data/1770787/0001610717-26-000405.txt
4                ADAR1 Capital Management, LLC                                 1940272     20260908    edgar/data/1940272/0001940272-26-000020.txt
4/A              AEye, Inc.                                                    1818644     20260908    edgar/data/1818644/0001437749-26-029848.txt
8-K              Some Co 4 Holdings                                            1234567     20260908    edgar/data/1234567/0001234567-26-000001.txt
`;

test('parseDailyIndex: Form 4 and 4/A only, zero-padded CIK, ISO date, accession from the path', () => {
  const rows = F.parseDailyIndex(IDX);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { form: '4', amended: false, company: '10x Genomics, Inc.', cik: '0001770787', dateFiled: '2026-09-08', fileName: 'edgar/data/1770787/0001610717-26-000405.txt', accession: '0001610717-26-000405' });
  assert.equal(rows[2].amended, true);
  assert.equal(F.parseDailyIndex('').length, 0);
});

test('dailyIndexUrl: quarter folder + yyyymmdd file', () => {
  assert.equal(F.dailyIndexUrl('2026-09-08'), 'https://www.sec.gov/Archives/edgar/daily-index/2026/QTR3/form.20260908.idx');
  assert.equal(F.dailyIndexUrl('2026-01-02'), 'https://www.sec.gov/Archives/edgar/daily-index/2026/QTR1/form.20260102.idx');
  assert.equal(F.dailyIndexUrl('2025-12-31'), 'https://www.sec.gov/Archives/edgar/daily-index/2025/QTR4/form.20251231.idx');
});

test('fetchDailyForm4: a 404 is a legitimate no-index day, not an error', async () => {
  const r = await F.fetchDailyForm4('2026-09-06', { fetchImpl: async () => ({ status: 404, ok: false }) });
  assert.deepEqual(r, { date: '2026-09-06', missing: true, filings: [] });
  await assert.rejects(F.fetchDailyForm4('2026-09-08', { fetchImpl: async () => ({ status: 503, ok: false }) }), /503/);
  // EDGAR's archive says "no such day" with an S3-style 403 AccessDenied (measured), never a 404.
  const missing = await F.fetchDailyForm4('2026-09-07', { fetchImpl: async () => ({ status: 403, ok: false, text: async () => '<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>' }) });
  assert.equal(missing.missing, true);
  // Any OTHER 403 (the rate-limit block page) is an error — the tick must fail closed, not log a quiet day.
  await assert.rejects(F.fetchDailyForm4('2026-09-08', { fetchImpl: async () => ({ status: 403, ok: false, text: async () => '<html>Request Rate Threshold Exceeded</html>' }) }), /blocked/);
});

test('universeCikMap + selectUniverseFilings: universe only, known accessions dropped, ticker attached', () => {
  const map = F.universeCikMap({ TXG: '1770787', AEYE: '0001818644' }, ['TXG', 'AEYE', 'ZZZZ']);
  assert.equal(map.get('0001770787'), 'TXG');
  const rows = F.selectUniverseFilings(F.parseDailyIndex(IDX), map, new Set(['0001437749-26-029848']));
  assert.deepEqual(rows.map(r => r.ticker), ['TXG']);
});

const XML = (owners, { code = 'P', ad = 'A', tenB51 = false } = {}) => `<ownershipDocument>
${owners.map(o => `<reportingOwner><reportingOwnerId><rptOwnerName>${o}</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>0</isOfficer><isTenPercentOwner>0</isTenPercentOwner></reportingOwnerRelationship></reportingOwner>`).join('')}
<aff10b5One>${tenB51 ? 1 : 0}</aff10b5One>
<nonDerivativeTable><nonDerivativeTransaction><transactionDate><value>2026-09-05</value></transactionDate><transactionCoding><transactionCode>${code}</transactionCode></transactionCoding>
<transactionAmounts><transactionShares><value>10000</value></transactionShares><transactionPricePerShare><value>12.5</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>${ad}</value></transactionAcquiredDisposedCode></transactionAmounts></nonDerivativeTransaction></nonDerivativeTable></ownershipDocument>`;

test('parseForm4 (additive): 10b5-1 flag and reporting-owner count; buysFromXml keeps buys only, one row per filing', () => {
  const p = EDGAR.parseForm4(XML(['Jane Doe', 'Doe Family Trust'], { tenB51: true }));
  assert.equal(p.tenB51, true); assert.equal(p.ownerCount, 2); assert.equal(p.owner, 'Jane Doe');
  const filing = { ticker: 'TXG', cik: '0001770787', accession: '0001610717-26-000405', dateFiled: '2026-09-08', amended: false };
  const buys = F.buysFromXml(XML(['Jane Doe', 'Doe Family Trust']), filing);
  assert.equal(buys.length, 1);
  assert.equal(buys[0].value, 125000); assert.equal(buys[0].jointOwners, 2); assert.equal(buys[0].filingDate, '2026-09-08'); assert.equal(buys[0].tenB51, false);
  assert.equal(F.buysFromXml(XML(['Jane Doe'], { code: 'S', ad: 'D' }), filing).length, 0, 'sales excluded');
});

test('shared FROZEN constructor: identical to research/69 on the same rows; joint filings collapse to one owner', () => {
  const tx = (owner, date, filingDate, value, accession) => ({ date, code: 'P', shares: 1000, price: value / 1000, value, owner, filingDate, accession, isDirector: true });
  const rows = [tx('A', '2026-09-01', '2026-09-02', 40000, 'x1'), tx('B', '2026-09-03', '2026-09-05', 30000, 'x2'), tx('C', '2026-10-01', '2026-10-02', 90000, 'x3')];
  assert.deepEqual(IC.clusterEvents(rows).map(e => ({ d: e.eventDate, o: e.owners, v: e.combinedValue })), S69.clusterEvents(rows).map(e => ({ d: e.eventDate, o: e.owners, v: e.combinedValue })));
  assert.equal(IC.clusterEvents(rows)[0].eventDate, '2026-09-05', 'event dated at the LATEST filing');
  // A joint filing: two owners, same accession/date/shares/price → ONE decision, not a cluster.
  const joint = [{ ...tx('Fund LP', '2026-09-01', '2026-09-02', 60000, 'j1') }, { ...tx('Fund GP LLC', '2026-09-01', '2026-09-02', 60000, 'j1') }];
  assert.equal(IC.clusterEvents(joint).length, 1, 'naive count treats a joint filing as a cluster');
  const ded = IC.dedupeJointFilings(joint);
  assert.equal(ded.length, 1); assert.equal(ded[0].jointOwners, 2);
  assert.equal(IC.clusterEvents(ded).length, 0, 'deduped: one owner, no cluster');
});

test('tierForAdv mirrors the research cost tiers exactly; classifyEligibility applies the frozen exclusions', () => {
  for (const adv of [1e5, 5e5, 4.9e6, 5e6, 1.9e7, 2e7, 1e9]) assert.equal(IC.tierForAdv(adv), K.costFractions(adv).tier, `adv ${adv}`);
  const ok = IC.classifyEligibility({ adv: 3e6, close: 8, members: [{ tenB51: false }] });
  assert.deepEqual(ok, { tier: 'CLUSTER', liqTier: 'micro', reasons: [] });
  assert.deepEqual(IC.classifyEligibility({ adv: 5e7, close: 8, members: [] }).reasons, ['liquid-tier']);
  assert.deepEqual(IC.classifyEligibility({ adv: 3e5, close: 0.8, members: [{ tenB51: true }] }).reasons, ['10b5-1', 'illiquid', 'sub-dollar']);
  assert.equal(IC.classifyEligibility({ adv: 3e5, close: 0.8, members: [] }).tier, 'CLUSTER_EXCLUDED');
});

test('emitClusters: only clusters whose latest filing is on a tick date; cooldown marks, never drops silently', () => {
  const tx = (ticker, owner, date, filingDate, accession) => ({ ticker, date, code: 'P', shares: 5000, price: 10, value: 50000, owner, filingDate, accession, isDirector: true, isOfficer: false, isTenPct: false });
  const shards = [
    { date: '2026-09-04', buys: [tx('AAA', 'p', '2026-09-03', '2026-09-04', 'a1')] },
    { date: '2026-09-08', buys: [tx('AAA', 'q', '2026-09-05', '2026-09-08', 'a2'), tx('BBB', 'r', '2026-09-07', '2026-09-08', 'b1'), tx('BBB', 's', '2026-09-08', '2026-09-08', 'b2'), tx('OLD', 't', '2026-08-01', '2026-08-02', 'o1'), tx('OLD', 'u', '2026-08-02', '2026-08-03', 'o2')] },
  ];
  const out = F.emitClusters(shards, { eventDates: ['2026-09-07', '2026-09-08'], recentRows: [{ ticker: 'BBB', date: '2026-08-20' }], tickDate: '2026-09-08' });
  assert.deepEqual(out.map(c => [c.ticker, c.eventDate, !!c.cooled]), [['AAA', '2026-09-08', false], ['BBB', '2026-09-08', true]]);
  assert.equal(out[0].owners, 2); assert.equal(out[0].combinedValue, 100000); assert.deepEqual(out[0].accessions, ['a1', 'a2']);
  assert.equal(out[0].officerDirectorOnly, true);
});

test('decisionFacts + ledgerRow: last close, 60-bar $ADV, tier and reasons; missing history is an excluded row with reason', () => {
  const candles = Array.from({ length: 80 }, (_, i) => ({ date: `2026-06-${String(1 + (i % 28)).padStart(2, '0')}`, close: 10, volume: 100000 }));
  const facts = F.decisionFacts(candles);
  assert.equal(facts.close, 10); assert.equal(facts.adv60, 1000000); assert.equal(facts.bars, 80);
  const cluster = { ticker: 'AAA', eventDate: '2026-09-08', txDates: ['2026-09-03', '2026-09-05'], owners: 2, combinedValue: 100000, accessions: ['a1', 'a2'], officerDirectorOnly: true, tenB51: false, members: [{ tenB51: false }] };
  const row = F.ledgerRow(cluster, facts, '2026-09-08');
  assert.equal(row.tier, 'CLUSTER'); assert.equal(row.liqTier, 'micro'); assert.equal(row.scope, 'micro'); assert.equal(row.date, '2026-09-08'); assert.equal(row.entry, null); assert.equal(row.fillPolicy, 'next-session-open');
  assert.equal(require('../lib/costs').tierForPick({ section: 'InsiderCluster', scope: row.scope }), 'micro', 'the Scoreboard charges the measured tier');
  assert.equal(require('../lib/costs').tierForPick({ section: 'InsiderCluster' }), 'small', 'no history → conservative default, never liquid');
  const none = F.ledgerRow(cluster, null, '2026-09-08');
  assert.equal(none.tier, 'CLUSTER_EXCLUDED'); assert.deepEqual(none.reasons, ['no-history']);
});

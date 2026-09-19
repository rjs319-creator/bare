'use strict';
// op=insiderclustertick driven end-to-end with an in-memory store and canned EDGAR/history —
// write-once semantics, index-missing days, truncation accounting, ledger doc shape.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/insider-cluster-routes');

const XML = (owner, { date = '2026-09-05', shares = 5000, price = 10 } = {}) => `<ownershipDocument><reportingOwner><reportingOwnerId><rptOwnerName>${owner}</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>0</isOfficer><isTenPercentOwner>0</isTenPercentOwner></reportingOwnerRelationship></reportingOwner><aff10b5One>0</aff10b5One>
<nonDerivativeTable><nonDerivativeTransaction><transactionDate><value>${date}</value></transactionDate><transactionCoding><transactionCode>P</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>${shares}</value></transactionShares><transactionPricePerShare><value>${price}</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts></nonDerivativeTransaction></nonDerivativeTable></ownershipDocument>`;

function memStore(seed = {}) {
  const docs = new Map(Object.entries(seed));
  return {
    docs,
    insiderClusterDayKey: (d) => `insidercluster/${d}.json`,
    blobExists: async (k) => docs.has(k),
    writeInsiderClusterDay: async (d, o) => { docs.set(`insidercluster/${d}.json`, { date: d, ...o }); },
    writeInsiderClusterTxDay: async (d, o) => { docs.set(`insidercluster/tx/${d}.json`, { date: d, ...o }); },
    readAllInsiderClusterDays: async ({ since = null } = {}) => [...docs.entries()].filter(([k]) => /^insidercluster\/\d{4}-\d{2}-\d{2}\.json$/.test(k)).map(([, v]) => v).filter(v => !since || v.date >= since),
    readInsiderClusterTxDays: async ({ since = null } = {}) => [...docs.entries()].filter(([k]) => k.startsWith('insidercluster/tx/')).map(([, v]) => v).filter(v => !since || v.date >= since),
  };
}
const filing = (cik, accession, dateFiled) => ({ form: '4', amended: false, company: 'x', cik, dateFiled, fileName: 'f', accession });
const cikMap = async () => ({ AAA: '0000000001', BBB: '0000000002' });
const tickers = ['AAA', 'BBB'];
const history = async () => ({ candles: Array.from({ length: 70 }, (_, i) => ({ date: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}`, close: 10, volume: 200000 })) });

test('tick: two same-window buys by distinct insiders → one CLUSTER row dated the tick day; shard + day doc written once', async () => {
  const store = memStore();
  const xmlByAcc = { a1: XML('Alice', { date: '2026-09-03' }), a2: XML('Bob', { date: '2026-09-05' }) };
  const fetchIndex = async (d) => ({ date: d, missing: d === '2026-09-07', filings: d === '2026-09-08' ? [filing('0000000001', 'a1', '2026-09-08'), filing('0000000001', 'a2', '2026-09-08'), filing('0000000099', 'zz', '2026-09-08')] : [] });
  const r = await R.tickCore({ date: '2026-09-08', store, fetchIndex, fetchXml: async (cik, acc) => xmlByAcc[acc] || null, cikMap, tickers, history, now: Date.now });
  assert.equal(r.ledger, 'written');
  assert.equal(r.counts.policy, 1); assert.equal(r.counts.excluded, 0); assert.equal(r.feed.filings, 2, 'non-universe CIK never fetched');
  const day = store.docs.get('insidercluster/2026-09-08.json');
  assert.equal(day.picks[0].ticker, 'AAA'); assert.equal(day.picks[0].tier, 'CLUSTER'); assert.equal(day.picks[0].date, '2026-09-08'); assert.equal(day.picks[0].eventDate, '2026-09-08');
  assert.equal(day.picks[0].owners, 2); assert.equal(day.picks[0].combinedValue, 100000); assert.equal(day.picks[0].entry, null);
  assert.deepEqual(day.indexDates.map(x => x.missing), [true, false]);
  assert.ok(store.docs.get('insidercluster/tx/2026-09-08.json').buys.length === 2);
  // Second tick on the same day is a no-op — nothing rewritten.
  const again = await R.tickCore({ date: '2026-09-08', store, fetchIndex: async () => { throw new Error('must not fetch'); }, cikMap, tickers, history });
  assert.equal(again.ledger, 'already-written');
});

test('tick: cluster spanning two ticks — first filing alone is not a cluster; second tick completes it, counted once', async () => {
  const store = memStore();
  const xml = { a1: XML('Alice', { date: '2026-09-03' }), a2: XML('Bob', { date: '2026-09-08' }) };
  const idx = { '2026-09-04': [filing('0000000001', 'a1', '2026-09-04')], '2026-09-09': [filing('0000000001', 'a2', '2026-09-09')] };
  const fetchIndex = async (d) => ({ date: d, missing: !idx[d], filings: idx[d] || [] });
  const fetchXml = async (c, acc) => xml[acc] || null;
  const r1 = await R.tickCore({ date: '2026-09-04', store, fetchIndex, fetchXml, cikMap, tickers, history });
  assert.equal(r1.counts.policy, 0);
  const r2 = await R.tickCore({ date: '2026-09-09', store, fetchIndex, fetchXml, cikMap, tickers, history });
  assert.equal(r2.counts.policy, 1);
  assert.equal(r2.feed.filings, 1, 'the already-stored accession a1 is not refetched');
  // A third insider a week later re-clusters the same name → cooldown, marked not logged.
  const r3 = await R.tickCore({ date: '2026-09-16', store, fetchIndex: async (d) => ({ date: d, missing: d !== '2026-09-16', filings: d === '2026-09-16' ? [filing('0000000001', 'a3', '2026-09-16')] : [] }), fetchXml: async () => XML('Carol', { date: '2026-09-15' }), cikMap, tickers, history });
  assert.equal(r3.counts.cooled, 1); assert.equal(r3.counts.policy, 0);
});

test('tick: no history → CLUSTER_EXCLUDED with reason, never dropped; fetch budget truncation is counted', async () => {
  const store = memStore();
  const filings = Array.from({ length: 5 }, (_, i) => filing('0000000002', `b${i}`, '2026-09-08'));
  let t = 0;
  const r = await R.tickCore({ date: '2026-09-08', store, fetchIndex: async (d) => ({ date: d, missing: d !== '2026-09-08', filings: d === '2026-09-08' ? filings : [] }),
    fetchXml: async (c, acc) => XML(acc, { date: '2026-09-07' }), cikMap, tickers, history: async () => { throw new Error('yahoo down'); }, now: () => (t += 50_000) });
  assert.ok(r.feed.truncated > 0, 'budget exhausted → truncated counted');
  const day = store.docs.get('insidercluster/2026-09-08.json');
  if (day.picks.length) { assert.equal(day.picks[0].tier, 'CLUSTER_EXCLUDED'); assert.deepEqual(day.picks[0].reasons, ['no-history']); }
  assert.equal(day.counts.historyMisses, day.picks.length);
});

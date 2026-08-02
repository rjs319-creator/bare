'use strict';
// PIT-DATA-V2 shadow identity store (Phase 1 of the evidence-based redesign).
// Deterministic and offline: the collector runs against an injected fetch + an
// in-memory store; the resolvers are pure over the resulting shards.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/pitdata/schema');
const C = require('../lib/pitdata/collector');
const R = require('../lib/pitdata/resolve');
const { reconcile } = require('../lib/pitdata/reconcile');

// ── in-memory deps ─────────────────────────────────────────────────────────────
function memDeps(responses, { t0 = Date.UTC(2026, 7, 1, 12) } = {}) {
  const blobs = new Map();
  let clock = t0;
  return {
    blobs,
    apiKey: 'test-key-not-real',   // injected — tests never depend on ambient env
    fetchJson: async (url) => {
      const hit = responses.find((r) => url.includes(r.match));
      if (!hit) return { ok: false, status: 404, body: null };
      return typeof hit.reply === 'function' ? hit.reply(url) : hit.reply;
    },
    readJSON: async (path, fallback = null) => (blobs.has(path) ? blobs.get(path) : fallback),
    writeJSON: async (path, doc) => { blobs.set(path, JSON.parse(JSON.stringify(doc))); },
    now: () => (clock += 10),
  };
}

const page = (rows) => ({ ok: true, status: 200, body: rows });

async function runAllSteps(deps, steps = 6) {
  const outs = [];
  for (let i = 0; i < steps; i++) outs.push(await C.collectStep(deps));
  return outs;
}

function shardsOf(deps) {
  const shards = {};
  for (const [path, doc] of deps.blobs) {
    const m = path.match(/^pitdata\/identity\/(.)\.json$/);
    if (m) shards[m[1]] = doc;
  }
  return shards;
}

// One fixture universe:
//  AAA  — active large-cap
//  BBB  — renamed from BOLD (symbol-change)
//  CCC  — delisted 2024-03-15 (ipo 2020-01-02), ticker later REUSED by a new listing (ipo 2025-06-01)
const RESPONSES = [
  { match: '/stock-list', reply: page([
    { symbol: 'AAA', exchangeShortName: 'NASDAQ' },
    { symbol: 'BBB', exchangeShortName: 'NYSE' },
    { symbol: 'CCC', exchangeShortName: 'NASDAQ' },   // the REUSED (new) CCC listing
  ]) },
  { match: '/delisted-companies', reply: (url) => {
    const p = Number(new URL(url).searchParams.get('page'));
    return p === 0
      ? page([{ symbol: 'CCC', companyName: 'Old CCC Corp', ipoDate: '2020-01-02', delistedDate: '2024-03-15', exchange: 'NASDAQ' }])
      : page([]);   // short page ends pagination
  } },
  { match: '/symbol-change', reply: page([{ oldSymbol: 'BOLD', newSymbol: 'BBB', date: '2025-02-01' }]) },
];

test('collector is cursor-based, resumable, and reaches done', async () => {
  const deps = memDeps(RESPONSES);
  const outs = await runAllSteps(deps);
  assert.ok(outs.every((o) => o.ok), outs.map((o) => o.error).join('; '));
  const state = deps.blobs.get(C.STATE_PATH);
  assert.equal(state.step, 'done');
  assert.equal(state.counts.stockList, 3);
  assert.equal(state.counts.delisted, 1);
  assert.equal(state.counts.symbolChange, 1);
  // Raw snapshots are content-addressed and provenance-labeled reconstruction.
  const raws = [...deps.blobs.keys()].filter((k) => k.startsWith('pitdata/raw/'));
  assert.ok(raws.length >= 3);
  for (const k of raws) {
    assert.equal(deps.blobs.get(k).meta.provenance, 'historical_reconstruction');
    assert.ok(!JSON.stringify(deps.blobs.get(k).meta.params).match(/apikey/i), 'no key in stored params');
  }
});

test('confirmed delisting requires the vendor record; reuse never merges listings', async () => {
  const deps = memDeps(RESPONSES);
  await runAllSteps(deps);
  const shards = shardsOf(deps);

  // Two DISTINCT CCC listings exist (old delisted, new active).
  const cccListings = R.listingsForSymbol(shards, 'CCC');
  assert.equal(cccListings.length, 2, 'ticker reuse must produce two listings');

  // As-of inside the old listing's life: resolves to the OLD listing, active.
  const mid = R.resolveSymbolAsOf({ symbol: 'CCC', effectiveAt: '2022-06-01', knownAt: '2026-08-01' }, shards);
  assert.equal(mid.status, 'resolved');
  assert.equal(mid.listingStatus, 'active');

  // The delisted status interval carries the authoritative confirmation.
  const old = cccListings.find((l) => (l.status || []).some((iv) => iv.value === 'delisted'));
  const delistedIv = old.status.find((iv) => iv.value === 'delisted');
  assert.equal(delistedIv.confirmation.source, 'fmp-delisted-companies');
});

test('knownAt later than the query cannot leak future knowledge into an old universe', async () => {
  const deps = memDeps(RESPONSES);
  await runAllSteps(deps);
  const shards = shardsOf(deps);
  // Everything was ingested in 2026 as historical_reconstruction, so a query that
  // restricts knowledge to 2023 must find NOTHING known — fail closed, not invent.
  const u = R.universeAt({ effectiveAt: '2023-01-02', knownAt: '2023-01-02' }, shards);
  assert.equal(u.counts.selected, 0, 'backfilled knowledge must not time-travel');
  assert.ok(u.counts.unknown > 0, 'the names exist but their status is unknown AS OF 2023 knowledge');
  assert.equal(u.survivorshipSafe, false);
});

test('universeAt tri-partitions with reasons and fails closed on unknown', async () => {
  const deps = memDeps(RESPONSES);
  await runAllSteps(deps);
  const shards = shardsOf(deps);
  const u = R.universeAt({ effectiveAt: '2026-08-01', knownAt: '2026-08-01' }, shards);
  const sel = new Set(u.selected.map((x) => x.symbol));
  assert.ok(sel.has('AAA') && sel.has('BBB'), 'current actives selected');
  assert.ok(u.rejected.find((x) => x.symbol === 'CCC' && x.reason === 'delisted-before-effectiveAt'), 'old CCC rejected with reason');
  assert.equal(u.counts.selected + u.counts.rejected + u.counts.unknown,
    R.allListings(shards).length, 'every listing is accounted for — nothing silently dropped');
});

test('a ticker rename keeps one listing reachable under both symbols', async () => {
  const deps = memDeps(RESPONSES);
  await runAllSteps(deps);
  const shards = shardsOf(deps);
  const viaNew = R.resolveSymbolAsOf({ symbol: 'BBB', effectiveAt: '2026-08-01' }, shards);
  const viaOld = R.resolveSymbolAsOf({ symbol: 'BOLD', effectiveAt: '2024-06-01', knownAt: '2026-08-01' }, shards);
  assert.equal(viaNew.status, 'resolved');
  assert.equal(viaOld.candidates.length >= 1, true, 'old symbol still resolves to a candidate');
});

test('API capability failure is an error, never interpreted as empty data', async () => {
  const deps = memDeps([{ match: '/stock-list', reply: { ok: false, status: 402, body: null } }]);
  const out = await C.collectStep(deps);
  assert.equal(out.ok, false);
  assert.match(out.error, /capability failure/i);
  // Nothing was written: no shard, no state advance.
  assert.ok(![...deps.blobs.keys()].some((k) => k.startsWith('pitdata/identity/')));
});

test('corporateActionsBetween fails closed until actions are actually collected', async () => {
  const deps = memDeps(RESPONSES);
  await runAllSteps(deps);
  const shards = shardsOf(deps);
  const aaa = R.resolveSymbolAsOf({ symbol: 'AAA', effectiveAt: '2026-08-01' }, shards);
  const acts = R.corporateActionsBetween({ securityId: aaa.listingId, start: '2020-01-01', end: '2026-08-01' }, shards);
  assert.equal(acts.status, 'unknown');
  assert.equal(acts.reason, 'actions-never-collected');
});

test('classificationAt is unknown (never defaulted) when no classification was ingested', async () => {
  const deps = memDeps(RESPONSES);
  await runAllSteps(deps);
  const shards = shardsOf(deps);
  const aaa = R.resolveSymbolAsOf({ symbol: 'AAA', effectiveAt: '2026-08-01' }, shards);
  const c = R.classificationAt({ securityId: aaa.listingId, effectiveAt: '2026-08-01' }, shards);
  assert.equal(c.status, 'unknown');
});

test('reconciliation gates fail on thin coverage and never claim survivorshipSafe', async () => {
  const deps = memDeps(RESPONSES);
  await runAllSteps(deps);
  const shards = shardsOf(deps);
  const v1Master = { records: { AAA: {}, BBB: {}, ZZZ: {} }, removed: [{ symbol: 'OLD1' }] };
  const rep = reconcile({ shards, v1Master, now: Date.UTC(2026, 7, 1) });
  assert.equal(rep.passed, false, '3 listings cannot clear a 5000-listing gate');
  assert.equal(rep.survivorshipSafe, false);
  assert.ok(rep.counts.v1OnlySymbols >= 1, 'ZZZ missing from v2 is surfaced');
  assert.ok(rep.gates.symbolChangeCollected, 'rename feed was collected');
});

test('re-running the collector is idempotent at the raw layer (content-addressed)', async () => {
  const deps = memDeps(RESPONSES);
  await runAllSteps(deps);
  const rawKeys1 = [...deps.blobs.keys()].filter((k) => k.startsWith('pitdata/raw/')).sort();
  // Reset cursor and replay: same payloads → same hashes → same keys.
  deps.blobs.set(C.STATE_PATH, { version: S.PITDATA_VERSION, step: 'stock-list', delistedPage: 0, counts: {} });
  await runAllSteps(deps);
  const rawKeys2 = [...deps.blobs.keys()].filter((k) => k.startsWith('pitdata/raw/')).sort();
  assert.deepEqual(rawKeys2, rawKeys1, 'replay must not duplicate raw snapshots');
});

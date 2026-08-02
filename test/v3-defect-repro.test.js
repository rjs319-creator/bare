'use strict';
// PHASE 0 — EXECUTABLE REPRODUCTIONS of the 12 verified data-foundation defects.
//
// Each test DOCUMENTS the defective v2 behavior (pinned so the defect can never
// be silently "fixed" in place and re-broken — v2 is frozen for compatibility)
// and asserts the corrected v3 behavior beside it. The v3 modules are the fix;
// the deep v3 batteries live in the pitdata-v3-*, outcome-v3, stats-v3 and
// harness-v3 test files.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const pitV2 = require('../research/lib/pit');
const OV3 = require('../research/lib/outcome-v3');
const S2 = require('../lib/pitdata/schema');
const C2 = require('../lib/pitdata/collector');
const R2 = require('../lib/pitdata/resolve');
const REC2 = require('../lib/pitdata/reconcile');
const S3 = require('../lib/pitdata/v3/schema');
const H1 = require('../lib/research/harness');
const H3 = require('../lib/research/harness-v3');
const BR = require('../lib/research/baseline-ranker');
const REG = require('../lib/research/hypothesis-registry');
const ST = require('../lib/stats') || {};

const DAY = 86400000;

// ── shared harnesses ──────────────────────────────────────────────────────────
function memDeps(responses, { t0 = Date.UTC(2026, 7, 1, 12) } = {}) {
  const blobs = new Map();
  let clock = t0;
  let fetches = 0;
  return {
    blobs,
    apiKey: 'test-key-not-real',
    fetchCount: () => fetches,
    fetchJson: async (url) => {
      fetches++;
      const hit = responses.find((r) => url.includes(r.match));
      if (!hit) return { ok: false, status: 404, body: null };
      return typeof hit.reply === 'function' ? hit.reply(url) : hit.reply;
    },
    readJSON: async (path, fallback = null) => (blobs.has(path) ? blobs.get(path) : fallback),
    writeJSON: async (path, doc) => { blobs.set(path, JSON.parse(JSON.stringify(doc))); },
    now: () => (clock += 10),
    sleep: async () => {},
  };
}
const page = (rows) => ({ ok: true, status: 200, body: rows });

function dailySeries(startMs, n, close = 100) {
  return Array.from({ length: n }, (_, i) => ({ ms: startMs + i * DAY, close, dollar: close * 1e5 }));
}

// ── DEFECT 1: stale price tail alone labeled 'delisted' + haircut ─────────────
test('defect 1 (v2, documented): series ending 40d before cutoff is labeled delisted with NO authoritative record', () => {
  const cutoff = Date.UTC(2026, 3, 1);
  const series = dailySeries(cutoff - 240 * DAY, 200);   // last bar 41d before cutoff
  const entry = series[150].ms;
  const o = pitV2.forwardOutcome(series, entry, 63, { dataCutoffMs: cutoff });
  assert.equal(o.status, 'delisted');                    // the defect: no master was consulted
  assert.ok(o.adjustedReturn < o.rawReturn, 'haircut applied on staleness alone');
});

test('defect 1 (v3 fix): the same stale tail without confirmation is UNRESOLVED, never delisted', () => {
  const cutoff = Date.UTC(2026, 3, 1);
  const series = dailySeries(cutoff - 240 * DAY, 200);
  const entry = series[150].ms;
  const o = OV3.forwardOutcomeV3({
    series, dateMs: entry, bars: 63,
    security: { listingId: 'pitv3:tk:x', masterVersion: 'pit-secmaster-v3', status: 'unknown' },
    opts: { dataCutoffMs: cutoff },
  });
  assert.equal(o.status, 'unresolved');
  assert.equal(o.labelReady, false);
  assert.equal(o.trainingLabel, null);
});

// ── DEFECT 2: v2 collector reaches 'done' and is a permanent no-op ───────────
test('defect 2 (v2, documented): collector at step done never collects again, even a day later', async () => {
  const deps = memDeps([
    { match: '/stock-list', reply: page([{ symbol: 'AAA', exchangeShortName: 'NASDAQ' }]) },
    { match: '/delisted-companies', reply: page([]) },
    { match: '/symbol-change', reply: page([]) },
  ]);
  for (let i = 0; i < 4; i++) await C2.collectStep(deps);
  const state = deps.blobs.get(C2.STATE_PATH);
  assert.equal(state.step, 'done');
  const before = deps.fetchCount();
  const out = await C2.collectStep(deps);                // "next day" — same result forever
  assert.equal(out.did.step, 'done');
  assert.equal(deps.fetchCount(), before, 'no fetch ever happens again');
});

// v3 fix (new run on a new day) is proven in test/pitdata-v3-collector.test.js.

// ── DEFECT 3: v2 provenance hard-coded to historical_reconstruction ──────────
test('defect 3 (v2, documented): every v2 fact is historical_reconstruction — prospective_live is unreachable', async () => {
  const deps = memDeps([
    { match: '/stock-list', reply: page([{ symbol: 'AAA', exchangeShortName: 'NASDAQ' }]) },
    { match: '/delisted-companies', reply: page([]) },
    { match: '/symbol-change', reply: page([]) },
  ]);
  for (let i = 0; i < 4; i++) await C2.collectStep(deps);
  const provs = new Set();
  for (const [path, doc] of deps.blobs) {
    if (!path.startsWith('pitdata/identity/')) continue;
    for (const l of Object.values(doc.listings || {})) {
      for (const iv of [...(l.aliases || []), ...(l.status || [])]) provs.add(iv.provenance);
    }
  }
  assert.deepEqual([...provs], ['historical_reconstruction']);
});

// ── DEFECT 4: raw hash from row count; payload stored null ───────────────────
test('defect 4 (v2, documented): two DIFFERENT same-length stock lists hash identically and store no payload', async () => {
  const runWith = async (rows) => {
    const deps = memDeps([{ match: '/stock-list', reply: page(rows) }]);
    await C2.collectStep(deps);
    for (const [path, doc] of deps.blobs) {
      if (path.startsWith('pitdata/raw/')) return { hash: doc.meta.responseHash, payload: doc.payload };
    }
    return null;
  };
  const a = await runWith([{ symbol: 'AAA' }, { symbol: 'BBB' }]);
  const b = await runWith([{ symbol: 'XXX' }, { symbol: 'YYY' }]);
  assert.equal(a.hash, b.hash, 'hash covers only the row COUNT');
  assert.equal(a.payload, null, 'payload stored null — unauditable');
});

test('defect 4 (v3 fix): content hash covers the exact payload — same length, different content, different hash', () => {
  const a = S3.makeContentObject([{ symbol: 'AAA' }, { symbol: 'BBB' }]);
  const b = S3.makeContentObject([{ symbol: 'XXX' }, { symbol: 'YYY' }]);
  assert.notEqual(a.contentHash, b.contentHash);
  assert.deepEqual(a.payload, [{ symbol: 'AAA' }, { symbol: 'BBB' }]);
  // key-order invariance: same logical payload → same hash
  assert.equal(S3.contentHashOf({ x: 1, y: 2 }), S3.contentHashOf({ y: 2, x: 1 }));
});

// ── DEFECT 5: cross-shard rename loses the old ticker ────────────────────────
test('defect 5 (v2, documented): old ticker AAA renamed to ZZZ is unfindable when querying AAA', async () => {
  const deps = memDeps([
    { match: '/stock-list', reply: page([{ symbol: 'ZZZ', exchangeShortName: 'NYSE' }]) },
    { match: '/delisted-companies', reply: page([]) },
    { match: '/symbol-change', reply: page([{ oldSymbol: 'AAA', newSymbol: 'ZZZ', date: '2024-01-15' }]) },
  ]);
  for (let i = 0; i < 4; i++) await C2.collectStep(deps);
  const shards = {};
  for (const [path, doc] of deps.blobs) {
    const m = path.match(/^pitdata\/identity\/(.+)\.json$/);
    if (m) shards[m[1]] = doc;
  }
  // The alias 'AAA' exists — but on shard Z, where a lookup for 'AAA' never looks.
  const zHasAlias = Object.values(shards.Z.listings).some((l) => (l.aliases || []).some((a) => a.value === 'AAA'));
  assert.equal(zHasAlias, true);
  const res = R2.resolveSymbolAsOf({ symbol: 'AAA', effectiveAt: '2023-06-01' }, shards);
  assert.equal(res.status, 'unknown');                   // the defect: shard-of-current-ticker lookup
});

// v3 fix (alias index keyed by the alias's own letter) is proven in pitdata-v3-resolve.test.js.

// ── DEFECT 6: alias effective intervals ignored at resolution ────────────────
test('defect 6 (v2, documented): an alias expired years ago still resolves as the active listing', () => {
  const l = S2.makeListing({ listingId: 'pitv2:test1', symbol: 'NEWCO' });
  l.aliases.push(S2.makeInterval({ value: 'OLDCO', effectiveFrom: '2015-01-01', effectiveTo: '2020-01-01', knownAt: '2026-01-01', source: 't' }));
  l.status.push(S2.makeInterval({ value: 'active', effectiveFrom: '2015-01-01', knownAt: '2026-01-01', source: 't' }));
  const shards = { O: { listings: { 'pitv2:test1': l } } };
  const res = R2.resolveSymbolAsOf({ symbol: 'OLDCO', effectiveAt: '2025-06-01', knownAt: '2026-01-01' }, shards);
  assert.equal(res.status, 'resolved');                  // the defect: interval [2015,2020) ignored in 2025
  assert.equal(res.listingId, 'pitv2:test1');
});

// ── DEFECT 7: unknown exchange passes an exchange filter ─────────────────────
test('defect 7 (v2, documented): a listing with UNKNOWN exchange sails through an exchange-filtered universe', () => {
  const l = S2.makeListing({ listingId: 'pitv2:test2', symbol: 'MYST' });   // exchange: null
  l.status.push(S2.makeInterval({ value: 'active', effectiveFrom: '2020-01-01', knownAt: '2026-01-01', source: 't' }));
  const shards = { M: { listings: { 'pitv2:test2': l } } };
  const u = R2.universeAt({ effectiveAt: '2025-06-01', knownAt: '2026-01-01', filters: { exchange: 'NASDAQ' } }, shards);
  assert.equal(u.selected.length, 1, 'unknown exchange admitted by the filter');
});

// v3 fix (unknown fails the filter) is proven in pitdata-v3-universe.test.js.

// ── DEFECT 8: stock-list records get ticker-only low-confidence identity ─────
test('defect 8 (v2, documented): active stock-list ingestion yields ONLY low-confidence ticker identities', async () => {
  const deps = memDeps([
    { match: '/stock-list', reply: page([{ symbol: 'AAPL', exchangeShortName: 'NASDAQ' }, { symbol: 'MSFT', exchangeShortName: 'NASDAQ' }]) },
  ]);
  await C2.collectStep(deps);
  const confs = [];
  for (const [path, doc] of deps.blobs) {
    if (!path.startsWith('pitdata/identity/')) continue;
    for (const l of Object.values(doc.listings || {})) confs.push(l.identityConfidence);
  }
  assert.ok(confs.length >= 2);
  assert.ok(confs.every((c) => c === 'low'), 'every identity is ticker-only low confidence');
});

// ── DEFECT 9: v2 reconciliation gates too weak ───────────────────────────────
test('defect 9 (v2, documented): reconciliation PASSES with 100% low-confidence identity, zero prospective history and zero instrument typing', () => {
  const shards = { A: { listings: {} } };
  for (let i = 0; i < 5100; i++) {
    const sym = `T${i}`;
    const l = S2.makeListing({ listingId: `pitv2:x${i}`, symbol: sym });   // all identityConfidence 'low'
    if (i < 1100) {
      l.status.push(S2.makeInterval({ value: 'delisted', effectiveFrom: '2020-01-01', knownAt: '2026-01-01', source: 'fmp', confirmation: { source: 'fmp' } }));
    }
    if (i === 0) l.aliases.push(S2.makeInterval({ value: 'OLD0', knownAt: '2026-01-01', source: 'fmp-symbol-change' }));
    shards.A.listings[l.listingId] = l;
  }
  const report = REC2.reconcile({ shards, v1Master: { records: { T0: {}, T1: {} } } });
  assert.equal(report.passed, true);                     // the defect: 4 shallow gates
  assert.equal(report.counts.v2LowConfidenceIdentity, 5100, 'counted but not gated');
});

// v3 fix (identity/longitudinal/instrument gates bind) is proven in pitdata-v3-reconcile.test.js.

// ── DEFECT 10: "block bootstrap" resamples single dates IID ──────────────────
test('defect 10 (v2, documented): the v2 "block bootstrap" is single-date IID — its CI materially UNDERSTATES uncertainty for autocorrelated ICs', () => {
  const STV3 = require('../lib/research/stats-v3');
  // Strongly autocorrelated daily ICs (slow sine wave + drift).
  const ics = Array.from({ length: 120 }, (_, i) => ({ date: `d${String(i).padStart(3, '0')}`, ic: Math.sin(i / 8) * 0.1 + 0.02, n: 50 }));
  const v2 = H1.summarizeICs(ics, 12345);
  const v2Width = v2.ci90[1] - v2.ci90[0];
  const mbb = STV3.movingBlockBootstrap(ics.map((x) => x.ic), { seed: 12345 });
  const mbbWidth = mbb.ci90[1] - mbb.ci90[0];
  assert.ok(v2Width < mbbWidth * 0.7,
    `v2 IID CI width ${v2Width.toFixed(4)} vs dependence-aware ${mbbWidth.toFixed(4)} — the v2 resampler treats each date as independent (block length 1)`);
});

test('defect 10 (v3 fix): the moving-block bootstrap is order-AWARE and HAC is more conservative than IID inference', () => {
  const STV3 = require('../lib/research/stats-v3');
  const vals = Array.from({ length: 120 }, (_, i) => Math.sin(i / 8) * 0.1 + 0.02);
  let s = 42;
  const shuffled = [...vals];
  for (let i = shuffled.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) >>> 0;
    const j = s % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const mbbOrdered = STV3.movingBlockBootstrap(vals, { seed: 7 });
  const mbbShuffled = STV3.movingBlockBootstrap(shuffled, { seed: 7 });
  assert.notDeepEqual(mbbOrdered.ci90, mbbShuffled.ci90, 'block bootstrap responds to temporal order');
  const nw = STV3.neweyWest(vals, { lags: 10 });
  assert.ok(Math.abs(nw.tstat) < Math.abs(nw.naiveTstat), 'HAC t < naive IID t for positively autocorrelated data');
});

// ── DEFECT 11: missing mandatory benchmark feature scored as zero ────────────
test('defect 11 (v2, documented): a row with NO mom121 scores 0 and still enters the benchmark IC', () => {
  assert.equal(BR.momentum121Ranker.score(null, { features: {} }), 0);
  const rows = [
    { decisionTs: 'd1', features: { mom121: 0.5 }, outcome: 0.1 },
    { decisionTs: 'd1', features: { mom121: -0.5 }, outcome: -0.1 },
    { decisionTs: 'd1', features: {}, outcome: 0.3 },   // missing benchmark feature
  ];
  const ics = H1.perDateIC(rows, (r) => BR.momentum121Ranker.score(null, r));
  assert.equal(ics[0].n, 3, 'the missing-feature row was INCLUDED at score 0');
});

test('defect 11 (v3 fix): missing benchmark rows are EXCLUDED and the coverage is reported', () => {
  const rows = [
    { decisionTs: 'd1', features: { mom121: 0.5 }, outcome: 0.1 },
    { decisionTs: 'd1', features: { mom121: -0.5 }, outcome: -0.1 },
    { decisionTs: 'd1', features: { mom121: 0.1 }, outcome: 0.0 },
    { decisionTs: 'd1', features: {}, outcome: 0.3 },
  ];
  const { ics, coverage } = H3.perDateICv3(rows, (r) => r.features.mom121, { requireFeatures: ['mom121'] });
  assert.equal(ics[0].n, 3, 'missing-feature row excluded');
  assert.equal(coverage.excludedRows, 1);
  assert.equal(coverage.missingByFeature.mom121, 1);
});

// ── DEFECT 12: BH/FDR exists but binds no verdict ────────────────────────────
test('defect 12 (v2, documented): runExperiment verdicts carry NO q-values — benjaminiHochberg is dead code on the verdict path', () => {
  assert.equal(typeof REG.benjaminiHochberg, 'function');   // the utility exists…
  const rows = [];
  for (let d = 0; d < 12; d++) {
    for (let k = 0; k < 5; k++) {
      rows.push({ securityId: `s${k}`, ticker: `s${k}`, decisionTs: `2026-01-${String(d + 1).padStart(2, '0')}`, labelEndDate: `2026-02-${String(d + 1).padStart(2, '0')}`, horizon: 'swing', features: { mom121: k / 5 }, outcome: (k / 5) + d * 0.001 });
    }
  }
  const out = H1.runExperiment(rows, [BR.residualMomentumRanker], { folds: 3 }, {});
  assert.equal(JSON.stringify(out).includes('"q"'), false, '…but no q-value reaches the result');
  assert.ok(out.verdict, 'verdict is issued without any FDR correction');
});
// v3 fix (BH-bound verdicts, denominator ≥ family trials) is proven in harness-v3.test.js.

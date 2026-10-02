'use strict';
// MIGRATION of legacy persisted evidence summaries to the exact-precision schema.
// Idempotent; recomputes `exact` from the stored per-date series where it exists (every
// production dateNet carries `values` since F-11), and labels the record `rounded` /
// `partial` where only display fields survive. Never fired here against production.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ES = require('../lib/evidence-stats');
const MIG = require('../lib/evidence-exact-migrate');
const { dateLevelNetExcess } = require('../lib/apex-routes');

const series = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const rowsOf = (values) => values.map((v, i) => ({ date: `2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, netExc: v }));

// A legacy dateNet exactly as production wrote it before this change: display fields,
// avgExact/seExact, the series, the seBasis string with its lag count, and the bootstrap
// block length — but no `exact` block and no `precision`.
function legacyOf(dn) {
  const { exact, precision, params, ...rest } = dn;
  return rest;
}

test('isLegacySummary recognises a persisted dateNet and nothing else', () => {
  const dn = dateLevelNetExcess(rowsOf(series(30, i => 0.5 + (i % 4) * 0.2)), { horizonBars: 5 });
  assert.equal(MIG.isLegacySummary(legacyOf(dn)), true);
  assert.equal(MIG.isLegacySummary(dn), false, 'already exact');
  assert.equal(MIG.isLegacySummary({ avg: 1, n: 3 }), false);
  assert.equal(MIG.isLegacySummary({ avgCI: { lo: 1, hi: 2 }, avg: 1, n: 3 }), false, 'summarizeReturns output is not a date summary');
  assert.equal(MIG.isLegacySummary(null), false);
});

test('a legacy summary with its series is recomputed to the SAME exact block the live code produces', () => {
  for (const [h, f] of [[5, i => 0.0031 + (i % 2 ? 0.0004 : -0.0004)], [21, i => Math.sin(i / 3) + 0.6], [1, i => ((i * 37) % 11) / 10 - 0.3]]) {
    const dn = dateLevelNetExcess(rowsOf(series(45, f)), { horizonBars: h });
    const out = MIG.migrateSummary(legacyOf(dn));
    assert.equal(out.precision, 'exact', `h=${h}`);
    assert.equal(out.migration.method, 'recomputed-from-series');
    assert.deepEqual(out.exact, dn.exact, `h=${h}: exact block reproduced bit-for-bit`);
    assert.deepEqual(out.ci95, dn.ci95, 'display fields untouched');
    assert.deepEqual(out.values, dn.values);
  }
});

test('recomputation that cannot reproduce the stored display fields is REFUSED (falls back, says why)', () => {
  const dn = dateLevelNetExcess(rowsOf(series(30, i => 0.5 + (i % 4) * 0.2)), { horizonBars: 5 });
  const tampered = { ...legacyOf(dn), values: dn.values.map(v => v * 3) };
  const out = MIG.migrateSummary(tampered);
  assert.equal(out.precision, 'partial', 'avgExact/seExact are still there');
  assert.equal(out.migration.method, 'derived-from-stored-fields');
  assert.match(out.migration.note, /mismatch/);
});

test('a legacy summary whose series is gone is labelled by what remains', () => {
  const dn = dateLevelNetExcess(rowsOf(series(30, i => 0.5 + (i % 4) * 0.2)), { horizonBars: 5 });
  const { values, dates, ...noSeries } = legacyOf(dn);
  const partial = MIG.migrateSummary(noSeries);
  assert.equal(partial.precision, 'partial');
  assert.equal(partial.exact.avg, dn.avgExact);
  const { avgExact, seExact, ...roundedOnly } = noSeries;
  const rounded = MIG.migrateSummary(roundedOnly);
  assert.equal(rounded.precision, 'rounded');
  assert.equal(rounded.exact.avg, dn.avg);
  assert.match(rounded.migration.note, /no per-date series/);
});

test('migrateDoc walks a nested scoreboard document, is idempotent, and never mutates its input', () => {
  const a = dateLevelNetExcess(rowsOf(series(30, i => 0.5 + (i % 4) * 0.2)), { horizonBars: 5 });
  const b = dateLevelNetExcess(rowsOf(series(20, i => -0.2 + (i % 3) * 0.1)), { horizonBars: 21 });
  const { values, ...bNoSeries } = legacyOf(b);
  const doc = {
    generatedAt: 'x',
    groups: [
      { section: 'Ghost', tier: 'GHOST', horizons: { '5d': { avgExcess: 1, dateNet: legacyOf(a) }, '1m': { avgExcess: 2, dateNet: bNoSeries } } },
      { section: 'Fade', tier: 'F', horizons: { '5d': { avgExcess: 1, dateNet: a } } },   // already exact
      { section: 'None', tier: 'N', horizons: { '5d': { avgExcess: 1, dateNet: null } } },
    ],
  };
  const frozen = JSON.stringify(doc);
  const r1 = MIG.migrateDoc(doc);
  assert.equal(JSON.stringify(doc), frozen, 'input untouched');
  assert.deepEqual(r1.stats, { scanned: 3, migrated: 2, exact: 1, partial: 1, rounded: 0, alreadyExact: 1 });
  assert.equal(r1.doc.groups[0].horizons['5d'].dateNet.precision, 'exact');
  assert.equal(r1.doc.groups[0].horizons['1m'].dateNet.precision, 'partial');
  assert.equal(r1.doc.groups[1].horizons['5d'].dateNet, a, 'already-exact summaries pass through by reference');
  const r2 = MIG.migrateDoc(r1.doc);
  assert.equal(r2.stats.migrated, 0, 'second pass changes nothing');
  assert.equal(r2.stats.alreadyExact, 3);
});

// ── the route (store injected, so this never touches Blob) ───────────────────
function fakeStore(docs) {
  const writes = [];
  return {
    writes,
    deps: {
      hasStore: () => true,
      readJSON: async (p, fb) => (p in docs ? JSON.parse(JSON.stringify(docs[p])) : fb),
      writeJSON: async (p, obj, maxAge) => { writes.push({ p, obj, maxAge }); return { url: 'blob://' + p }; },
    },
  };
}
function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('op=evidencemigrate: dry run reports what would change and writes nothing', async () => {
  const a = dateLevelNetExcess(rowsOf(series(30, i => 0.5 + (i % 4) * 0.2)), { horizonBars: 5 });
  const store = fakeStore({ 'scoreboard/summary.json': { groups: [{ horizons: { '5d': { dateNet: legacyOf(a) } } }] } });
  const handler = MIG.createMigrateHandler(store.deps);
  const res = fakeRes();
  await handler({ query: { dry: '1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.dry, true);
  assert.equal(res.body.path, 'scoreboard/summary.json');
  assert.equal(res.body.stats.migrated, 1);
  assert.equal(store.writes.length, 0);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('op=evidencemigrate: a live run writes the migrated doc once and is a no-op the second time', async () => {
  const a = dateLevelNetExcess(rowsOf(series(30, i => 0.5 + (i % 4) * 0.2)), { horizonBars: 5 });
  const docs = { 'scoreboard/summary.json': { groups: [{ horizons: { '5d': { dateNet: legacyOf(a) } } }] } };
  const store = fakeStore(docs);
  const handler = MIG.createMigrateHandler(store.deps);
  const res1 = fakeRes();
  await handler({ query: {} }, res1);
  assert.equal(res1.body.written, true);
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].maxAge, 300, 'scoreboard/summary.json keeps its 300s cache age');
  assert.equal(store.writes[0].obj.groups[0].horizons['5d'].dateNet.precision, 'exact');
  docs['scoreboard/summary.json'] = store.writes[0].obj;
  const res2 = fakeRes();
  await handler({ query: {} }, res2);
  assert.equal(res2.body.written, false);
  assert.equal(res2.body.idempotent, true);
  assert.equal(store.writes.length, 1);
});

test('op=evidencemigrate: refuses paths outside the allowlist and reports a missing doc', async () => {
  const store = fakeStore({});
  const handler = MIG.createMigrateHandler(store.deps);
  const bad = fakeRes();
  await handler({ query: { path: 'apex/model.json' } }, bad);
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.ok, false);
  const missing = fakeRes();
  await handler({ query: {} }, missing);
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body.ok, false);
  const noStore = fakeRes();
  await MIG.createMigrateHandler({ ...store.deps, hasStore: () => false })({ query: {} }, noStore);
  assert.equal(noStore.body.ok, false);
  assert.match(noStore.body.error, /Blob/);
});

test('op=evidencemigrate is wired as a PRIVILEGED (bearer) op and dispatched', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'tracker.js'), 'utf8');
  const priv = src.slice(src.indexOf('const PRIVILEGED_OPS'), src.indexOf('const EXPENSIVE_OPS'));
  assert.match(priv, /'evidencemigrate'/);
  assert.match(src, /req\.query\.op === 'evidencemigrate'/);
  const ER = require('../lib/evidence-routes');
  assert.equal(typeof ER.runEvidenceMigrate, 'function');
});

'use strict';
// Ken French loader: zip → CSV → validated factor table → Blob cache doc. The CSV fixture
// mirrors the real Dartmouth layout (CRLF, prose preamble, header row starting with a
// comma, YYYYMMDD rows, blank line, copyright footer, -99.99 missing sentinel).
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const KF = require('../lib/factors/ken-french');
const ZIP = require('../lib/factors/zip-inflate');

const FF5_CSV = [
  'This file was created by using the 202608 CRSP database.',
  'The Tbill return is the simple daily rate.',
  '',
  ',Mkt-RF,SMB,HML,RMW,CMA,RF',
  '20260827,    0.50,   -0.10,    0.20,    0.05,   -0.15,    0.01',
  '20260828,   -0.34,   -0.37,    0.28,    1.66,    0.49,    0.01',
  '20260831,   -0.33,   -0.29,  -99.99,   -1.09,    0.03,    0.01',
  '',
  'Copyright 2026 Eugene F. Fama and Kenneth R. French',
].join('\r\n') + '\r\n';

const MOM_CSV = [
  'This file was created by using the 202608 CRSP database.  It',
  'contains a momentum factor.',
  '',
  'Missing data are indicated by -99.99 or -999.',
  '',
  ',Mom',
  '20260826,   0.10',
  '20260827,   0.55',
  '20260828,  -1.47',
  '20260831,  -0.14',
  '',
  'Copyright 2026 Eugene F. Fama and Kenneth R. French',
].join('\r\n') + '\r\n';

// Build a real single-entry zip (deflate, no data descriptor) the way the Dartmouth
// server does, so the reader is exercised end to end rather than on a mock.
function makeZip(name, text) {
  const raw = Buffer.from(text, 'latin1');
  const comp = zlib.deflateRawSync(raw);
  const nameB = Buffer.from(name, 'latin1');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameB.length, 26); local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameB.length, 28); central.writeUInt32LE(0, 42);
  const cdOffset = local.length + nameB.length + comp.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameB.length, 12); eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameB, comp, central, nameB, eocd]);
}

test('zip-inflate reads the first entry of a deflated single-file zip', () => {
  const { name, text } = ZIP.unzipFirstEntry(makeZip('F-F_Research_Data_5_Factors_2x3_daily.csv', FF5_CSV));
  assert.equal(name, 'F-F_Research_Data_5_Factors_2x3_daily.csv');
  assert.equal(text, FF5_CSV);
});

test('zip-inflate rejects a buffer that is not a zip', () => {
  assert.throws(() => ZIP.unzipFirstEntry(Buffer.from('<html>not a zip</html>')), /zip/i);
});

test('parseFrenchCsv skips the preamble, maps columns, stops at the blank line, nulls -99.99', () => {
  const t = KF.parseFrenchCsv(FF5_CSV);
  assert.deepEqual(t.columns, ['mktRf', 'smb', 'hml', 'rmw', 'cma', 'rf']);
  assert.equal(t.rows.length, 3);
  assert.equal(t.rows[0].date, '2026-08-27');
  assert.deepEqual(t.rows[0].values, [0.5, -0.1, 0.2, 0.05, -0.15, 0.01]);
  assert.equal(t.rows[2].values[2], null, '-99.99 is a missing sentinel, not a return');
});

test('parseFrenchCsv fails loudly on a body with no factor table (e.g. an HTML error page)', () => {
  assert.throws(() => KF.parseFrenchCsv('<html><body>Service unavailable</body></html>'), /header/i);
});

test('mergeFactorTables inner-joins FF5 and MOM on date in the canonical factor order', () => {
  const merged = KF.mergeFactorTables(KF.parseFrenchCsv(FF5_CSV), KF.parseFrenchCsv(MOM_CSV));
  assert.deepEqual(merged.factors, KF.FACTOR_KEYS);
  assert.deepEqual(merged.factors, ['mktRf', 'smb', 'hml', 'rmw', 'cma', 'mom', 'rf']);
  // 2026-08-26 exists only in MOM → dropped; the three shared dates survive.
  assert.deepEqual(merged.rows.map(r => r[0]), ['2026-08-27', '2026-08-28', '2026-08-31']);
  assert.deepEqual(merged.rows[0], ['2026-08-27', 0.5, -0.1, 0.2, 0.05, -0.15, 0.55, 0.01]);
  assert.equal(merged.rows[2][3], null);
});

test('buildCacheDoc stamps provenance and the publication-lag awareness flag', () => {
  const merged = KF.mergeFactorTables(KF.parseFrenchCsv(FF5_CSV), KF.parseFrenchCsv(MOM_CSV));
  const fresh = KF.buildCacheDoc(merged, { now: new Date('2026-10-02T00:00:00Z') });
  assert.equal(fresh.version, KF.FACTOR_CACHE_VERSION);
  assert.equal(fresh.lastDate, '2026-08-31');
  assert.equal(fresh.lagDays, 32);
  assert.equal(fresh.stale, false, 'a ~1-month lag is the normal French publication cadence');
  const old = KF.buildCacheDoc(merged, { now: new Date('2026-11-01T00:00:00Z') });
  assert.equal(old.stale, true, 'beyond the expected lag the doc is flagged so the Scoreboard says proxies are carrying the live window');
  assert.equal(KF.validateCacheDoc(fresh).valid, true);
  assert.equal(KF.validateCacheDoc({ version: 'x', rows: 'nope' }).valid, false);
});

test('needsRefresh: absent doc, old fetch, or force → true; a fetch within the weekly cadence → false', () => {
  const now = new Date('2026-10-02T00:00:00Z');
  assert.equal(KF.needsRefresh(null, { now }), true);
  assert.equal(KF.needsRefresh({ fetchedAt: '2026-09-30T00:00:00Z' }, { now }), false);
  assert.equal(KF.needsRefresh({ fetchedAt: '2026-09-20T00:00:00Z' }, { now }), true);
  assert.equal(KF.needsRefresh({ fetchedAt: '2026-09-30T00:00:00Z' }, { now, force: true }), true);
});

test('refreshFactorCache: fetches both zips, writes the validated doc, and is a no-op inside the cadence', async () => {
  const zips = {
    [KF.datasetUrl('ff5')]: makeZip('F-F_Research_Data_5_Factors_2x3_daily.csv', FF5_CSV),
    [KF.datasetUrl('mom')]: makeZip('F-F_Momentum_Factor_daily.csv', MOM_CSV),
  };
  let fetches = 0;
  const fetchImpl = async (url) => {
    fetches++;
    const buf = zips[url];
    if (!buf) return { ok: false, status: 404 };
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  };
  const written = [];
  const store = { readJSON: async () => null, writeJSON: async (path, doc) => { written.push({ path, doc }); } };
  const now = () => new Date('2026-10-02T00:00:00Z');
  // The production guard refuses a suspiciously short merged table (a truncated or
  // partial download must never replace a good cache). The 3-row fixture trips it.
  const guarded = await KF.refreshFactorCache({ store, fetchImpl, now });
  assert.equal(guarded.refreshed, false);
  assert.match(guarded.error, /only 3 merged rows/);
  assert.equal(written.length, 0);
  fetches = 0;
  const r1 = await KF.refreshFactorCache({ store, fetchImpl, now, minRows: 3 });
  assert.equal(r1.refreshed, true);
  assert.equal(fetches, 2);
  assert.equal(written.length, 1);
  assert.equal(written[0].path, KF.FACTOR_CACHE_PATH);
  assert.equal(written[0].doc.rows.length, 3);
  assert.equal(r1.lastDate, '2026-08-31');
  // Second call sees the fresh doc → skipped without a network call.
  const store2 = { readJSON: async () => written[0].doc, writeJSON: async () => { throw new Error('must not write'); } };
  const r2 = await KF.refreshFactorCache({ store: store2, fetchImpl, now });
  assert.equal(r2.refreshed, false);
  assert.match(r2.reason, /cadence/);
  assert.equal(fetches, 2);
});

test('refreshFactorCache fails closed on a vendor error — nothing written, error surfaced', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503 });
  const store = { readJSON: async () => null, writeJSON: async () => { throw new Error('must not write'); } };
  const r = await KF.refreshFactorCache({ store, fetchImpl, now: () => new Date('2026-10-02T00:00:00Z') });
  assert.equal(r.refreshed, false);
  assert.match(r.error, /503/);
});

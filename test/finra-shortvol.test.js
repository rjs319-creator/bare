'use strict';
// FINRA Reg SHO daily short volume — parser (live-captured fixture), feature math,
// cross-sectional deciles, shard/rolling documents, calendar helpers. Pure, no network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SV = require('../lib/finra-shortvol');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'datapack', 'CNMSshvol20261001.sample.txt'), 'utf8');
const line = (sym, short, exempt, total, date = '20261001') => `${date}|${sym}|${short}|${exempt}|${total}|B,Q,N`;
const file = (lines) => [SV.EXPECTED_HEADER, ...lines].join('\n');

// ── Parsing ──────────────────────────────────────────────────────────────────
test('parses the live FINRA fixture: fractional share counts, every row kept, date detected', () => {
  const p = SV.parseShortVolumeFile(FIXTURE, { expectedDate: '2026-10-01' });
  assert.equal(p.ok, true);
  assert.equal(p.date, '2026-10-01');
  assert.ok(p.rows.length >= 40);
  assert.equal(p.health.kept, p.rows.length);
  // The live file lists warrants/units with a "/" suffix (AAC/WS); those are not equities the
  // app can trade or grade, so the symbol rule rejects them and the parser COUNTS the rejection.
  assert.deepEqual(p.health.invalidReasons, { bad_symbol: 1 });
  assert.ok(!p.rows.some((r) => r.symbol.includes('/')));
  const a = p.rows.find((r) => r.symbol === 'A');
  assert.ok(Math.abs(a.shortVolume - 482143.150276) < 1e-6, 'fractional ShortVolume survives parsing');
  assert.equal(a.shortExemptVolume, 479);
  assert.ok(Math.abs(SV.shortVolRatio(a) - 0.5223) < 1e-3);
  assert.equal(a.market, 'B,Q,N');
});

test('fails fast on a wrong header, a wrong-day file, an empty or oversized body', () => {
  assert.equal(SV.parseShortVolumeFile('Date|Symbol|Short\n20261001|A|1').reason, 'bad_header');
  assert.equal(SV.parseShortVolumeFile(FIXTURE, { expectedDate: '2026-09-30' }).reason, 'date_mismatch');
  assert.equal(SV.parseShortVolumeFile('').reason, 'empty_body');
  assert.equal(SV.parseShortVolumeFile('x'.repeat(SV.MAX_FILE_BYTES + 1)).reason, 'oversized_body');
  assert.equal(SV.parseShortVolumeFile(SV.EXPECTED_HEADER + '\n').reason, 'no_rows');
});

test('per-row problems are counted and skipped, never coerced', () => {
  const p = SV.parseShortVolumeFile(file([
    line('GOOD', 50, 0, 100),
    line('OVER', 200, 0, 100),            // short > total
    line('ZERO', 0, 0, 0),                // total 0
    line('NEG', -5, 0, 100),
    line('bad sym!', 1, 0, 10),
    line('LATE', 1, 0, 10, '20261002'),   // mixed dates
    '20261001|SHORTROW|1|2',              // column count
  ]));
  assert.equal(p.ok, true);
  assert.deepEqual(p.rows.map((r) => r.symbol), ['GOOD']);
  assert.equal(p.health.invalid, 6);
  assert.deepEqual(p.health.invalidReasons, { short_gt_total: 1, bad_total_volume: 1, bad_short_volume: 1, bad_symbol: 1, mixed_dates: 1, bad_column_count: 1 });
});

test('urlFor builds the CDN path from an ISO date and rejects anything else', () => {
  assert.equal(SV.urlFor('2026-10-01'), 'https://cdn.finra.org/equity/regsho/daily/CNMSshvol20261001.txt');
  assert.throws(() => SV.urlFor('20261001'), /ISO date/);
  assert.equal(SV.shardPath('2026-10-01'), 'shortvol/2026-10-01.json');
});

// ── Feature math ─────────────────────────────────────────────────────────────
test('zScore: trailing-window z, null below the minimum history, null on a flat window', () => {
  const hist = Array.from({ length: 20 }, (_, i) => 0.4 + (i % 2 ? 0.02 : -0.02)); // mean 0.4, sd ≈ 0.0205
  const z = SV.zScore(0.46, hist);
  assert.equal(z.n, 20);
  assert.ok(z.z > 2.8 && z.z < 3.0, `z ${z.z}`);
  assert.equal(SV.zScore(0.46, hist.slice(0, 5)).z, null);
  assert.equal(SV.zScore(0.46, Array(20).fill(0.4)).z, null);
  assert.equal(SV.zScore(0.46, Array(20).fill(0.4)).flat, true);
  assert.equal(SV.zScore(null, hist).z, null);
});

test('exemptSpike: ≥3× the trailing median AND ≥1% of volume; null without history', () => {
  const hist = Array(12).fill(0.002);
  assert.equal(SV.exemptSpike(0.012, hist).spike, true);
  assert.equal(SV.exemptSpike(0.005, hist).spike, false, 'above 3× median but below the 1% floor');
  assert.equal(SV.exemptSpike(0.012, Array(12).fill(0.006)).spike, false, 'above the floor but under 3× median');
  assert.equal(SV.exemptSpike(0.012, hist.slice(0, 3)).spike, null);
  assert.equal(SV.exemptSpike(0.05, Array(12).fill(0)).spike, true, 'a zero median does not divide away the spike');
});

test('decileOf: within-eligible cross-sectional deciles, 10 = highest ratio; thin names excluded', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ symbol: `S${String(i).padStart(3, '0')}`, shortVolume: i + 1, shortExemptVolume: 0, totalVolume: 100, market: 'Q' }))
    .map((r) => ({ ...r, totalVolume: 1_000_000, shortVolume: (r.shortVolume / 100) * 1_000_000 }));
  const thin = { symbol: 'THIN', shortVolume: 99, shortExemptVolume: 0, totalVolume: 100, market: 'Q' };
  const d = SV.decileOf([...rows, thin]);
  assert.equal(d.size, 100);
  assert.equal(d.has('THIN'), false);
  assert.equal(d.get('S000'), 1);
  assert.equal(d.get('S099'), 10);
  assert.equal([...d.values()].filter((v) => v === 10).length, 10);
  assert.equal([...d.values()].filter((v) => v === 5).length, 10);
});

// ── Documents ────────────────────────────────────────────────────────────────
const UNI = ['A', 'AA', 'AAAA', 'GME', 'NVDA'];
const rowsOf = (text) => SV.parseShortVolumeFile(text).rows;

test('buildDayShard: compact rows for the whole file, hypothesis cohorts within the universe', () => {
  const rows = rowsOf(FIXTURE);
  const shard = SV.buildDayShard({ date: '2026-10-01', rows, fetchedAt: 'T', sourceHash: 'h', universe: UNI });
  assert.equal(shard.version, SV.FINRA_SHORTVOL_VERSION);
  assert.equal(shard.rows.length, rows.length);
  assert.deepEqual(shard.columns, ['symbol', 'shortVolume', 'shortExemptVolume', 'totalVolume', 'market']);
  assert.equal(shard.counts.universe, rows.filter((r) => UNI.includes(r.symbol)).length);
  assert.equal(shard.hypothesis.weight, 0);
  assert.equal(shard.hypothesis.id, 'short-volume-ratio-top-decile');
  for (const s of [...shard.hypothesis.topDecile, ...shard.hypothesis.placeboDecile]) assert.ok(UNI.includes(s), `${s} outside the universe`);
});

test('appendRollingDay: out-of-order arrival aligns in place, re-append is idempotent, gaps are null, cap holds', () => {
  const d1 = [line('A', 50, 1, 100), line('B', 20, 0, 100)];
  const d2 = [line('A', 60, 2, 100), line('C', 10, 0, 100)];
  const d3 = [line('A', 70, 3, 100)];
  let doc = SV.appendRollingDay(null, { date: '2026-10-01', rows: rowsOf(file(d1)), universe: ['A', 'B', 'C'] });
  doc = SV.appendRollingDay(doc, { date: '2026-10-03', rows: rowsOf(file(d3.map((l) => l.replace('20261001', '20261003')))), universe: ['A', 'B', 'C'] });
  doc = SV.appendRollingDay(doc, { date: '2026-10-02', rows: rowsOf(file(d2.map((l) => l.replace('20261001', '20261002')))), universe: ['A', 'B', 'C'], hypothesis: { topDecile: ['A'], placeboDecile: ['C'] } });
  assert.deepEqual(doc.dates, ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.deepEqual(doc.bySymbol.A.r, [0.5, 0.6, 0.7]);
  assert.deepEqual(doc.bySymbol.A.e, [0.01, 0.02, 0.03]);
  assert.deepEqual(doc.bySymbol.B.r, [0.2, null, null]);
  assert.deepEqual(doc.bySymbol.C.r, [null, 0.1, null]);
  assert.deepEqual(doc.hypothesisByDate, { '2026-10-02': { topDecile: ['A'], placeboDecile: ['C'] } });
  assert.equal(doc.asOf, '2026-10-03');
  // Idempotent: replaying day 2 changes nothing.
  const again = SV.appendRollingDay(doc, { date: '2026-10-02', rows: rowsOf(file(d2.map((l) => l.replace('20261001', '20261002')))), universe: ['A', 'B', 'C'], hypothesis: { topDecile: ['A'], placeboDecile: ['C'] } });
  assert.deepEqual(again, { ...doc, updatedAt: null });
  // Cap: the oldest day falls off, and its hypothesis entry with it.
  const capped = SV.appendRollingDay(doc, { date: '2026-10-04', rows: [], universe: ['A'], maxDays: 2 });
  assert.deepEqual(capped.dates, ['2026-10-03', '2026-10-04']);
  assert.deepEqual(capped.bySymbol.A.r, [0.7, null]);
  assert.deepEqual(capped.hypothesisByDate, {});
  // Inputs were not mutated.
  assert.deepEqual(doc.dates, ['2026-10-01', '2026-10-02', '2026-10-03']);
});

test('featuresFor: z20 appears once 10 trailing sessions exist; a symbol missing on asOf is stale', () => {
  let doc = null;
  const uni = ['A', 'B'];
  for (let i = 1; i <= 13; i++) {
    const date = `2026-09-${String(i).padStart(2, '0')}`;
    const compact = date.replace(/-/g, '');
    const rows = [line('A', 40 + (i % 2), 0, 100, compact), ...(i < 13 ? [line('B', 30, 0, 100, compact)] : [])];
    doc = SV.appendRollingDay(doc, { date, rows: rowsOf(file(rows)), universe: uni });
    if (i === 10) assert.equal(SV.featuresFor(doc, 'A').z20, null, '9 trailing obs: not enough');
    if (i === 11) assert.ok(Number.isFinite(SV.featuresFor(doc, 'A').z20), '10 trailing obs: z computed');
  }
  const a = SV.featuresFor(doc, 'A');
  assert.equal(a.date, '2026-09-13');
  assert.equal(a.stale, false);
  assert.equal(a.scoreInput, false);
  assert.equal(a.feature, true);
  const b = SV.featuresFor(doc, 'B');
  assert.equal(b.date, '2026-09-12');
  assert.equal(b.stale, true);
  assert.equal(SV.featuresFor(doc, 'ZZZ'), null);
  assert.equal(SV.featuresFor(null, 'A'), null);
  assert.equal(SV.summaryOf(doc).days, 13);
});

// ── Calendar helpers ─────────────────────────────────────────────────────────
test('recentWeekdays / previousWeekday / missingDates skip weekends and known dates', () => {
  assert.deepEqual(SV.recentWeekdays('2026-10-05', 3), ['2026-10-05', '2026-10-02', '2026-10-01']); // Mon → Fri, Thu
  assert.deepEqual(SV.recentWeekdays('2026-10-04', 2), ['2026-10-02', '2026-10-01']);              // Sunday start
  assert.equal(SV.previousWeekday('2026-10-05'), '2026-10-02');
  assert.deepEqual(SV.missingDates({ dates: ['2026-10-01'] }, ['2026-10-02', '2026-10-01', '2026-09-30']), ['2026-10-02', '2026-09-30']);
  assert.deepEqual(SV.missingDates(null, ['2026-10-02']), ['2026-10-02']);
});

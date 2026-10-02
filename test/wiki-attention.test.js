// research/104 Wikipedia-attention study — pure parsers and study mechanics.
// Locks: API parsers fail closed on junk, the z-spike lands on the spike day and only
// there, the PIT rule (decision on D sees pageviews ≤ D−1), the placebo shift lands on
// the first session ≥ +30 calendar days, purged blocks drop the embargo rows, and the
// verdict is mechanical against the frozen gates.
const { test } = require('node:test');
const assert = require('node:assert');

const CORE = require('../research/lib/wiki-attention-core');
const PV = require('../research/lib/wiki-pageviews');
const WD = require('../research/lib/wikidata-tickers');
const YH = require('../research/lib/yahoo-history');
const { FROZEN } = require('../research/104-wiki-attention');

// ── parsers ──────────────────────────────────────────────────────────────────
test('parsePageviews keeps well-formed daily items, drops junk, sorts ascending', () => {
  const json = { items: [
    { timestamp: '2025010300', views: 5 }, { timestamp: '2025010100', views: 7 },
    { timestamp: 'bad', views: 1 }, { timestamp: '2025010200', views: -3 }, { timestamp: '2025010400', views: 'x' },
  ] };
  assert.deepStrictEqual(PV.parsePageviews(json), [['20250101', 7], ['20250103', 5]]);
  assert.deepStrictEqual(PV.parsePageviews(null), []);
  assert.deepStrictEqual([...PV.toDailyMap([['20250101', 7]]).entries()], [['2025-01-01', 7]]);
});

test('encodeTitle uses underscores and percent-encodes path-breaking characters', () => {
  assert.strictEqual(PV.encodeTitle('Apple Inc.'), 'Apple_Inc.');
  assert.strictEqual(PV.encodeTitle('AT&T'), 'AT%26T');
  assert.strictEqual(PV.encodeTitle('Berkshire Hathaway/Energy'), 'Berkshire_Hathaway%2FEnergy');
});

test('parseBindings maps tickers to one article and drops ambiguous tickers', () => {
  const b = (ticker, title, item) => ({ ticker: { value: ticker }, title: { value: title }, item: { value: item } });
  const parsed = WD.parseBindings({ results: { bindings: [
    b('AAPL', 'Apple Inc.', 'Q312'), b('aapl', 'Apple Inc.', 'Q312'), b('BRK.B', 'Berkshire Hathaway', 'Q217583'),
    b('DUP', 'Company A', 'Q1'), b('DUP', 'Company B', 'Q2'), b('not a ticker', 'X', 'Q3'),
  ] } });
  assert.deepStrictEqual(Object.keys(parsed.map), ['AAPL', 'BRK-B']);
  assert.deepStrictEqual(parsed.ambiguous, ['DUP']);
  assert.strictEqual(parsed.map.AAPL.title, 'Apple Inc.');
});

test('parseChart converts Yahoo chart JSON to ET-dated candles and drops null closes', () => {
  // 2025-01-02 14:30 UTC (09:30 ET) and 2025-01-03 14:30 UTC
  const json = { chart: { result: [{ timestamp: [1735828200, 1735914600, 1736001000], indicators: { quote: [{
    open: [10, 11, null], high: [12, 13, null], low: [9, 10, null], close: [11, 12, null], volume: [100, 200, null] }] } }] } };
  const c = YH.parseChart(json);
  assert.strictEqual(c.length, 2);
  assert.deepStrictEqual(c[0], { date: '2025-01-02', open: 10, high: 12, low: 9, close: 11, volume: 100 });
  assert.strictEqual(YH.toCacheDoc('X', c).price[0].date, '2025-01-03', 'cache doc is newest-first like FMP');
  assert.deepStrictEqual(YH.parseChart({}), []);
});

// ── attention z ──────────────────────────────────────────────────────────────
function flatViewsWithSpike({ days = 120, base = 100, spikeAt = 100, spikeMult = 20 } = {}) {
  const out = new Map();
  for (let i = 0; i < days; i++) {
    const iso = CORE.isoShift('2024-01-01', i);
    const noise = (i % 3) - 1;                     // deterministic ±1 wiggle so the baseline SD > 0
    out.set(iso, base + noise + (i >= spikeAt && i < spikeAt + 7 ? base * spikeMult : 0));
  }
  return out;
}

test('attentionSeries: z is large on the spike days and ≈0 before them', () => {
  const z = CORE.attentionSeries(flatViewsWithSpike(), FROZEN.attention);
  const before = z.get(CORE.isoShift('2024-01-01', 99));
  const during = z.get(CORE.isoShift('2024-01-01', 103));
  assert.ok(Math.abs(before) < 1, `pre-spike z should be ≈0, got ${before}`);
  assert.ok(during > 10, `spike z should be large, got ${during}`);
  assert.strictEqual(z.get('2024-01-10'), undefined, 'no z before window+baseline days of history');
});

test('attentionSeries: a constant series has no baseline variance → null z, never a fabricated number', () => {
  const flat = new Map(Array.from({ length: 90 }, (_, i) => [CORE.isoShift('2024-01-01', i), 50]));
  const z = CORE.attentionSeries(flat, FROZEN.attention);
  assert.strictEqual(z.get(CORE.isoShift('2024-01-01', 80)), null);
});

test('lastUsableDay enforces the PIT rule: session D sees pageviews through D−1 only', () => {
  assert.strictEqual(CORE.lastUsableDay('2025-03-03'), '2025-03-02');
  assert.strictEqual(CORE.lastUsableDay('2025-01-01'), '2024-12-31');
});

test('selectTopDecile returns the top 10% by z, requires ≥10 names and z > minZ', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ ticker: `T${i}`, z: i - 10 }));
  const top = CORE.selectTopDecile(rows, { decile: 0.1, minZ: 0 });
  assert.deepStrictEqual(top.map((r) => r.ticker), ['T29', 'T28', 'T27']);
  assert.deepStrictEqual(CORE.selectTopDecile(rows.slice(0, 9), { decile: 0.1 }), []);
  assert.deepStrictEqual(CORE.selectTopDecile(rows.map((r, i) => ({ ...r, z: -(i + 1) })), { decile: 0.1, minZ: 0 }), [], 'all-negative z → no spike');
});

// ── quiet filter, cooldown, placebo, blocks ─────────────────────────────────
function candles(closes) {
  return closes.map((c, i) => ({ date: CORE.isoShift('2024-01-01', i), open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1e6 }));
}

test('isQuiet: flat tape passes, a 5-session move larger than one ATR fails', () => {
  const flat = candles(Array.from({ length: 30 }, () => 100));
  assert.strictEqual(CORE.isQuiet(flat, 29, FROZEN.quietFilter), true);
  const moved = candles([...Array.from({ length: 25 }, () => 100), 101, 103, 106, 110, 115]);
  assert.strictEqual(CORE.isQuiet(moved, 29, FROZEN.quietFilter), false);
  assert.strictEqual(CORE.isQuiet(flat, 3, FROZEN.quietFilter), false, 'too little history fails closed');
});

test('applyCooldown keeps one event per ticker per cooldown window', () => {
  const sessions = Array.from({ length: 60 }, (_, i) => CORE.isoShift('2024-01-01', i));
  const idx = new Map(sessions.map((d, i) => [d, i]));
  const events = [{ ticker: 'A', date: sessions[5] }, { ticker: 'A', date: sessions[10] }, { ticker: 'A', date: sessions[30] }, { ticker: 'B', date: sessions[6] }];
  const kept = CORE.applyCooldown(events, idx, 21);
  assert.deepStrictEqual(kept.map((e) => `${e.ticker}@${e.date}`), [`A@${sessions[5]}`, `B@${sessions[6]}`, `A@${sessions[30]}`]);
});

test('shiftPlaceboDate lands on the first session ≥ +30 calendar days, null past the calendar', () => {
  const sessions = ['2024-01-02', '2024-01-31', '2024-02-01', '2024-02-02'];
  assert.strictEqual(CORE.shiftPlaceboDate('2024-01-02', 30, sessions), '2024-02-01');
  assert.strictEqual(CORE.shiftPlaceboDate('2024-01-03', 30, sessions), '2024-02-02');
  assert.strictEqual(CORE.shiftPlaceboDate('2024-01-04', 30, sessions), null);
});

test('purgedBlockMeans drops the embargo rows at every block boundary after the first', () => {
  const series = Array.from({ length: 40 }, (_, i) => ({ date: CORE.isoShift('2024-01-01', i), value: i < 10 ? 1 : i < 20 ? -1 : i < 30 ? 1 : -1 }));
  const plain = CORE.purgedBlockMeans(series, { blocks: 4, embargo: 0 });
  assert.deepStrictEqual(plain, [1, -1, 1, -1]);
  // With embargo 5 the first 5 rows of blocks 2-4 are removed; the means are unchanged
  // here because each block is homogeneous, but the row counts shrink.
  const purged = CORE.purgedBlockMeans(series.map((r, i) => ({ ...r, value: i % 10 === 0 ? 100 : r.value })), { blocks: 4, embargo: 1 });
  assert.strictEqual(purged[0] > 1, true, 'block 1 keeps its first row (the 100)');
  assert.strictEqual(purged[1], -1, 'block 2 lost its first row (the 100) to the embargo');
  assert.deepStrictEqual(CORE.purgedBlockMeans(series.slice(0, 5), { blocks: 4 }), [], 'too few rows → no blocks');
});

test('verdictOf is mechanical: gates pass → research-promising; placebo too large → not-confirmed; thin → insufficient', () => {
  const primary = { n: 200, dates: 90, mean: -1.2, t: -2.5, q: 0.04, negativeBlocks: 3 };
  assert.strictEqual(CORE.verdictOf(primary, { mean: 0.1 }, FROZEN).verdict, 'research-promising');
  assert.strictEqual(CORE.verdictOf(primary, { mean: -0.9 }, FROZEN).verdict, 'not-confirmed');
  assert.strictEqual(CORE.verdictOf({ ...primary, mean: 0.5, t: 1.1 }, null, FROZEN).verdict, 'not-confirmed');
  assert.strictEqual(CORE.verdictOf({ ...primary, n: 20 }, null, FROZEN).verdict, 'insufficient-data');
});

test('frozen study parameters match the preregistered row (primary quiet@21, negative, +30d placebo)', () => {
  assert.deepStrictEqual(FROZEN.primary, { variant: 'quiet', H: 21 });
  assert.strictEqual(FROZEN.placeboShiftDays, 30);
  assert.strictEqual(FROZEN.expectedDirection, 'negative');
  assert.strictEqual(FROZEN.attention.window, 7);
  assert.strictEqual(FROZEN.attention.decile, 0.1);
});

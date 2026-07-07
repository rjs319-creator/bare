const { test } = require('node:test');
const assert = require('node:assert');
const { verdictFor, summarizeClass, firstAppearance, computeCalibration, MIN_RESOLVED,
  attributeStats, convictionVerdict, ATTR_MIN_IC } = require('../lib/calibration');
const { spearman } = require('../lib/stats');

test('verdictFor stays CALIBRATING below the minimum sample, whatever the streak', () => {
  assert.equal(verdictFor(MIN_RESOLVED - 1, MIN_RESOLVED - 1), 'CALIBRATING'); // perfect but too few
  assert.equal(verdictFor(0, MIN_RESOLVED - 1), 'CALIBRATING');                 // awful but too few
});

test('verdictFor promotes a class that beats its sector with confidence', () => {
  assert.equal(verdictFor(25, 28), 'PROVEN');   // 89% beat rate, Wilson floor well above 0.5
  assert.equal(verdictFor(15, 15), 'PROVEN');
});

test('verdictFor demotes a class that reliably fails to beat its sector', () => {
  assert.equal(verdictFor(3, 28), 'DUD');       // 11% beat rate, Wilson ceiling below 0.5
  assert.equal(verdictFor(0, 20), 'DUD');
});

test('verdictFor holds a coin-flip class at CALIBRATING even past the sample floor', () => {
  assert.equal(verdictFor(8, 15), 'CALIBRATING'); // ~53% but the interval straddles 0.5
});

test('summarizeClass reports beat rate, average excess and the sample floor', () => {
  const s = summarizeClass([1, -1, 2, -3]);
  assert.equal(s.n, 4);
  assert.equal(s.beat, 2);
  assert.equal(s.beatRate, 50);
  assert.equal(s.avgExcess, -0.25);
  assert.equal(s.min, MIN_RESOLVED);
  assert.equal(s.verdict, 'CALIBRATING'); // n below the floor
});

test('firstAppearance keeps the earliest record per tier:ticker and drops untagged rows', () => {
  const kept = firstAppearance([
    { ticker: 'AAA', tier: 'Fresh', date: '2026-02-01' },
    { ticker: 'AAA', tier: 'Fresh', date: '2026-01-15' }, // earlier → wins
    { ticker: 'AAA', tier: 'Moved', date: '2026-01-20' }, // different tier → separate
    { ticker: 'BBB', tier: 'Fresh', date: '2026-01-10' },
    { ticker: 'CCC', date: '2026-01-10' },                // no tier → dropped
  ]);
  const aaaFresh = kept.find(p => p.ticker === 'AAA' && p.tier === 'Fresh');
  assert.equal(aaaFresh.date, '2026-01-15');
  assert.equal(kept.filter(p => p.ticker === 'AAA').length, 2);
  assert.equal(kept.some(p => p.ticker === 'CCC'), false);
});

test('computeCalibration resolves excess vs the sector bench and groups by class', async () => {
  // Two synthetic candle series: the pick rips +10% over the week while its sector ETF is
  // flat → positive excess. Injected fetcher keeps the test offline & deterministic.
  const day = (date, close) => ({ date, close, high: close, low: close });
  const rising = { candles: [
    day('2026-01-05', 100), day('2026-01-06', 101), day('2026-01-07', 102),
    day('2026-01-08', 104), day('2026-01-09', 106), day('2026-01-12', 110),
  ] };
  const flat = { candles: [
    day('2026-01-05', 50), day('2026-01-06', 50), day('2026-01-07', 50),
    day('2026-01-08', 50), day('2026-01-09', 50), day('2026-01-12', 50),
  ] };
  const histBy = { WIN: rising, XLK: flat, SPY: flat };
  const fetchHistory = async t => histBy[t] || null;

  // Injected section reader drives the pipeline offline (no Blob store needed).
  const sections = [{ key: 'Anomaly', read: async () => [{ picks: [
    { ticker: 'WIN', tier: 'Accumulation', date: '2026-01-05', bench: 'XLK', short: false },
  ] }] }];

  const out = await computeCalibration(fetchHistory, sections);
  const acc = out.sections.Anomaly.classes.Accumulation;
  assert.ok(acc, 'Accumulation class present');
  assert.equal(acc.n, 1);
  assert.equal(acc.beat, 1);          // +10% vs a flat sector = beat
  assert.ok(acc.avgExcess > 5, 'excess reflects the ~10% outperformance');
  assert.equal(acc.verdict, 'CALIBRATING'); // one pick is far below the floor
});

// ── Layer 3: attribute-level (conviction) calibration ──

test('spearman orders a monotonic relationship as a strong positive rank-IC', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const ys = xs.map(x => x * 2 - 1); // strictly increasing → IC = 1
  assert.equal(spearman(xs, ys, 2), 1);
  assert.equal(spearman(xs, [...ys].reverse(), 2), -1); // strictly decreasing → -1
  assert.equal(spearman([1, 2], [3, 4], 5), null);      // below minN → null
});

test('convictionVerdict needs the sample floor, then splits on the ±0.10 edge', () => {
  assert.equal(convictionVerdict(0.9, ATTR_MIN_IC - 1), 'CALIBRATING'); // too few
  assert.equal(convictionVerdict(null, ATTR_MIN_IC + 5), 'CALIBRATING'); // no IC
  assert.equal(convictionVerdict(0.2, ATTR_MIN_IC + 5), 'CALIBRATED');  // conviction predicts
  assert.equal(convictionVerdict(-0.2, ATTR_MIN_IC + 5), 'INVERTED');   // backwards
  assert.equal(convictionVerdict(0.03, ATTR_MIN_IC + 5), 'NOISE');      // no edge
});

test('attributeStats computes conviction rank-IC, buckets, and Read-Through link-type breakdown', () => {
  // 24 records where higher confidence tracks higher excess → positive IC, CALIBRATED.
  const records = Array.from({ length: 24 }, (_, i) => ({
    pick: { confidence: (i % 5) + 1 }, exc: ((i % 5) + 1) - 3, // conf 1..5 → exc -2..+2
  }));
  const a = attributeStats('Anomaly', records);
  assert.ok(a.conviction, 'conviction block present');
  assert.equal(a.conviction.key, 'confidence');
  assert.ok(a.conviction.rankIC > 0.9, 'near-perfect monotonic → high IC');
  assert.equal(a.conviction.verdict, 'CALIBRATED');
  assert.equal(a.conviction.buckets.length, 5); // one per confidence level

  // Read-Through also breaks down by link type (categorical).
  const rt = attributeStats('ReadThrough', [
    { pick: { directness: 5, linkType: 'supplier' }, exc: 3 },
    { pick: { directness: 4, linkType: 'supplier' }, exc: 1 },
    { pick: { directness: 2, linkType: 'substitute' }, exc: -2 },
  ]);
  assert.ok(rt.categories.linkType, 'linkType breakdown present');
  assert.equal(rt.categories.linkType.values[0].value, 'supplier'); // best avg excess first
});

const { test } = require('node:test');
const assert = require('node:assert');
const { verdictFor, summarizeClass, firstAppearance, computeCalibration, MIN_RESOLVED } = require('../lib/calibration');

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
  const acc = out.sections.Anomaly.Accumulation;
  assert.ok(acc, 'Accumulation class present');
  assert.equal(acc.n, 1);
  assert.equal(acc.beat, 1);          // +10% vs a flat sector = beat
  assert.ok(acc.avgExcess > 5, 'excess reflects the ~10% outperformance');
  assert.equal(acc.verdict, 'CALIBRATING'); // one pick is far below the floor
});

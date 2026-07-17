const test = require('node:test');
const assert = require('node:assert');
const N = require('../lib/decision-normalizers');

// ── op=downday → mean-reversion signals ─────────────────────────────────────
// Shapes taken from the LIVE prod payload (op=downday), not invented.
const downday = {
  ok: true, horizon: 3,
  bounces: [{
    ticker: 'JOBY', sector: 'Industrials', bucket: 'bounce', side: 'long',
    label: 'Oversold Bounce', tier: 'WATCH', score: 27, price: 7.45, dollarVol: 387730708,
    signals: { side: 'long', entry: 7.45, stop: 6.89, target: 12.48, rr: 9.07, expired: false },
  }],
  fades: [{
    ticker: 'HOT', sector: 'Technology', bucket: 'fade', side: 'short',
    label: 'Overheated / Rollover', tier: 'EMERGING', score: 61, price: 23.15, dollarVol: 5e7,
    signals: { side: 'short', entry: 23.15, stop: 24.32, target: 16.17, rr: 5.94, expired: false },
  }],
};

test('fromDownDay: emits both the bounce (long) and the fade (short)', () => {
  const out = N.fromDownDay(downday);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out.find(s => s.ticker === 'JOBY').side, 'long');
  assert.strictEqual(out.find(s => s.ticker === 'HOT').side, 'short');
});

test('fromDownDay: carries levels so the cost model has a target to charge', () => {
  const [b] = N.fromDownDay(downday);
  assert.strictEqual(b.entry, 7.45);
  assert.strictEqual(b.stop, 6.89);
  assert.strictEqual(b.target, 12.48);
});

test('fromDownDay: reads the MEAN-REVERSION family, not priceTrend', () => {
  // The whole point: a bounce is not the same evidence as a breakout. If this maps to
  // priceTrend the redundancy engine will treat a bounce and a breakout as one family.
  const [b] = N.fromDownDay(downday);
  assert.deepStrictEqual(b.evidenceFamilies, ['meanReversion']);
});

test('fromDownDay: real dollar-volume reaches liquidity (so the cost tier is measured)', () => {
  const [b] = N.fromDownDay(downday);
  assert.strictEqual(b.liquidity.dollarVol, 387730708);
  assert.strictEqual(b.liquidity.price, 7.45);
});

test('fromDownDay: a 3-day hold is a SWING, never intraday', () => {
  const [b] = N.fromDownDay(downday);
  assert.strictEqual(b.horizon, 'swing');
});

test('fromDownDay: drops expired and level-less rows rather than ranking them', () => {
  const out = N.fromDownDay({
    bounces: [
      { ticker: 'OLD', side: 'long', score: 50, signals: { entry: 1, stop: 0.9, target: 2, expired: true } },
      { ticker: 'NOLVL', side: 'long', score: 50, signals: { expired: false } },
    ], fades: [],
  });
  assert.strictEqual(out.length, 0);
});

test('fromDownDay: empty / malformed input never throws', () => {
  assert.deepStrictEqual(N.fromDownDay(null), []);
  assert.deepStrictEqual(N.fromDownDay({}), []);
  assert.deepStrictEqual(N.fromDownDay({ bounces: [null], fades: undefined }), []);
});

// ── op=optionsflow → options-positioning evidence ───────────────────────────
const optionsflow = {
  ok: true,
  byTicker: [
    { ticker: 'MU', isIndex: false, underlying: 853.2, score: -45, grade: 'Bearish', net: 'bearish', bullishPct: 25, totalPremium: 567070305, contracts: 21 },
    { ticker: 'BULL', isIndex: false, underlying: 40, score: 80, grade: 'Very Bullish', net: 'bullish', bullishPct: 90, totalPremium: 2e7, contracts: 9 },
    { ticker: 'SPY', isIndex: true, underlying: 600, score: 70, grade: 'Very Bullish', net: 'bullish', bullishPct: 85, totalPremium: 9e8, contracts: 40 },
  ],
};

test('fromOptionsFlow: bearish positioning becomes a SHORT, bullish a LONG', () => {
  const out = N.fromOptionsFlow(optionsflow);
  assert.strictEqual(out.find(s => s.ticker === 'MU').side, 'short');
  assert.strictEqual(out.find(s => s.ticker === 'BULL').side, 'long');
});

test('fromOptionsFlow: INDEX rows are excluded — SPY is the tape, not a stock pick', () => {
  const out = N.fromOptionsFlow(optionsflow);
  assert.ok(!out.some(s => s.ticker === 'SPY'));
});

test('fromOptionsFlow: emits the optionsPositioning family — the point of adding it', () => {
  // This is the first genuinely NON-PRICE evidence family on the board. If it maps to
  // anything price-derived, adding the source buys nothing the screener did not have.
  const [s] = N.fromOptionsFlow(optionsflow);
  assert.deepStrictEqual(s.evidenceFamilies, ['optionsPositioning']);
});

test('fromOptionsFlow: confidence scales with conviction magnitude, not direction', () => {
  const out = N.fromOptionsFlow(optionsflow);
  const mu = out.find(s => s.ticker === 'MU');     // |score| 45
  const bull = out.find(s => s.ticker === 'BULL'); // |score| 80
  assert.ok(bull.rawConfidence > mu.rawConfidence, 'a stronger read must carry more confidence');
});

test('fromOptionsFlow: carries NO levels — positioning is evidence, not a trade plan', () => {
  const [s] = N.fromOptionsFlow(optionsflow);
  assert.strictEqual(s.entry, undefined);
  assert.strictEqual(s.target, undefined);
});

test('fromOptionsFlow: a flat/neutral read is not a signal', () => {
  const out = N.fromOptionsFlow({ byTicker: [{ ticker: 'MEH', isIndex: false, score: 3, net: 'neutral', underlying: 10 }] });
  assert.strictEqual(out.length, 0);
});

test('fromOptionsFlow: empty / malformed input never throws', () => {
  assert.deepStrictEqual(N.fromOptionsFlow(null), []);
  assert.deepStrictEqual(N.fromOptionsFlow({}), []);
  assert.deepStrictEqual(N.fromOptionsFlow({ byTicker: [null] }), []);
});

// ── the merge SAFETY guard ──────────────────────────────────────────────────
// Regression for a real bug this diff made reachable: mergeSignals keyed on
// ticker|horizon with NO side, so a long and a short on the same name at the same horizon
// collapsed into one row and the loser's evidence was unioned onto the winner. Adding
// downday (bounce long + fade short) and optionsflow (bullish + bearish) at swing put
// both sides in one bucket for the first time.
test('MERGE SAFETY: a bearish read never becomes confirming evidence for a long', () => {
  const D = require('../lib/decision');
  const long = { source: 'screener', ticker: 'SNOW', horizon: 'swing', side: 'long', price: 100, entry: 100, stop: 95, target: 115, rawConfidence: 80, evidenceFamilies: ['priceTrend'] };
  const short = { source: 'optionsflow', ticker: 'SNOW', horizon: 'swing', side: 'short', price: 100, rawConfidence: 70, evidenceFamilies: ['optionsPositioning'] };
  const merged = D.mergeSignals([long, short]);
  assert.strictEqual(merged.length, 2, 'disagreement must stay two competing rows, not one');
  const l = merged.find(m => m.side === 'long');
  assert.deepStrictEqual(l.evidenceFamilies, ['priceTrend'],
    'the long must NOT absorb the bearish options family as confirmation');
  assert.ok(merged.find(m => m.side === 'short'), 'the short survives as its own row');
});

test('MERGE SAFETY: same-side signals on one name still merge (the feature is intact)', () => {
  const D = require('../lib/decision');
  const a = { source: 'screener', ticker: 'X', horizon: 'swing', side: 'long', entry: 10, stop: 9, target: 12, rawConfidence: 70, evidenceFamilies: ['priceTrend'] };
  const b = { source: 'optionsflow', ticker: 'X', horizon: 'swing', side: 'long', rawConfidence: 60, evidenceFamilies: ['optionsPositioning'] };
  const merged = D.mergeSignals([a, b]);
  assert.strictEqual(merged.length, 1);
  assert.deepStrictEqual(merged[0].evidenceFamilies.sort(), ['optionsPositioning', 'priceTrend']);
});

// ── the merge payoff ────────────────────────────────────────────────────────
test('MERGE: options positioning adds an INDEPENDENT family to a screener row', () => {
  const D = require('../lib/decision');
  const screenerRow = {
    source: 'screener', ticker: 'BULL', horizon: 'swing', side: 'long', price: 40,
    entry: 40, stop: 37, target: 46, rawConfidence: 70, evidenceFamilies: ['priceTrend'],
  };
  const [opt] = N.fromOptionsFlow(optionsflow).filter(s => s.ticker === 'BULL');
  const merged = D.mergeSignals([screenerRow, opt]);
  assert.strictEqual(merged.length, 1, 'same ticker+horizon must merge into one row');
  const fams = merged[0].evidenceFamilies;
  assert.ok(fams.includes('priceTrend') && fams.includes('optionsPositioning'),
    `expected both families, got ${JSON.stringify(fams)}`);
});

// research/lib/export-pbo-matrices — the exported challenger matrix must reproduce the
// gate's own PBO byte-for-byte (same filter, same IC, same row order), the screener-family
// matrix must be dates × sections with nulls where a section had no pick, and the per-pick
// rows must carry the Scoreboard's own next-open returns.
const { test } = require('node:test');
const assert = require('node:assert');

const X = require('../research/lib/export-pbo-matrices');
const PBO = require('../lib/research/pbo');
const EVAL = require('../lib/challenger-eval');

function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function syntheticPreds({ dates = 40, perDate = 12, seed = 7 } = {}) {
  const r = rng(seed);
  const out = [];
  for (let d = 0; d < dates; d++) {
    const predDate = `2025-01-${String(1 + (d % 28)).padStart(2, '0')}-${d}`.slice(0, 10) + (d >= 28 ? `x${d}` : '');
    for (let i = 0; i < perDate; i++) {
      const outcome = r() - 0.5;
      out.push({ predDate, outcome, residualScore: outcome * 0.6 + r(), baselineProd: r(), baselineOmega: r(), baselineMomentum: d % 3 ? r() : null });
    }
  }
  return out;
}

test('challengerMatrix reproduces pboOverVariants exactly (same PBO, dates, variants)', () => {
  const preds = syntheticPreds();
  const m = X.challengerMatrix(preds);
  const js = EVAL.pboOverVariants(preds);
  assert.deepStrictEqual(m.variants, js.variantKeys, 'baselineMomentum (67% coverage) is excluded on both sides');
  assert.strictEqual(m.matrix.length, js.dates);
  assert.strictEqual(PBO.pbo(m.matrix).pbo, js.pbo);
  assert.ok(m.dates.every((d, i) => i === 0 || m.dates[i - 1] < d), 'dates ascending');
});

test('challengerMatrix fails closed below two covered variants', () => {
  const m = X.challengerMatrix([{ predDate: '2025-01-02', outcome: 1, residualScore: 1 }]);
  assert.deepStrictEqual(m.matrix, []);
  assert.match(m.reason, /need ≥2 variant columns/);
});

function candles(start, closes, openOffset = 0) {
  return closes.map((c, i) => ({ date: `2025-01-${String(start + i).padStart(2, '0')}`, open: c + openOffset, high: c + 1, low: c - 1, close: c, volume: 1e6 }));
}

test('pickRows carries the Scoreboard next-open returns and SPY-excess per horizon', () => {
  const byTicker = new Map([['AAA', candles(1, [10, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32])]]);
  const spy = candles(1, Array.from({ length: 24 }, () => 100));
  const rows = X.pickRows([{ ticker: 'AAA', date: '2025-01-01', section: 'screener', tier: 'Buy' }, { ticker: 'ZZZ', date: '2025-01-01', section: 'screener' }], byTicker, spy);
  assert.strictEqual(rows.length, 1, 'a pick without candles is dropped, never fabricated');
  // entry at next open (10), exit close at idx+5 = 14 → +40%; SPY flat → excess +40
  assert.strictEqual(rows[0].ret[5], 40);
  assert.strictEqual(rows[0].spy[5], 0);
  assert.strictEqual(rows[0].excess[5], 40);
  assert.strictEqual(rows[0].ret[1], 0, '1-session horizon exits at the entry bar\'s own close (JS semantics)');
});

test('screenerFamilyMatrix is dates × sections with null for a section absent that date', () => {
  const rows = [
    { date: '2025-01-02', section: 'b', excess: { 5: 1 } }, { date: '2025-01-02', section: 'b', excess: { 5: 3 } },
    { date: '2025-01-02', section: 'a', excess: { 5: -1 } }, { date: '2025-01-03', section: 'a', excess: { 5: 2 } },
    { date: '2025-01-03', section: 'b', excess: { 5: null } },
  ];
  const m = X.screenerFamilyMatrix(rows, 5);
  assert.deepStrictEqual(m.variants, ['a', 'b']);
  assert.deepStrictEqual(m.dates, ['2025-01-02', '2025-01-03']);
  assert.deepStrictEqual(m.matrix, [[-1, 2], [2, null]]);
  assert.strictEqual(m.bars, 5);
});

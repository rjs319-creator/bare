// Tests for the dual-read Fable narrative parse/clamp layer (lib/dualread-fable.js).
const test = require('node:test');
const assert = require('node:assert');
const { parseDualRead, buildPrompt, SETUP_CLASSES, STANCES } = require('../lib/dualread-fable');

test('parseDualRead: keeps valid enums, clips strings', () => {
  const r = parseDualRead({ verdict: 'Buyable dip', setupClass: 'pullback-buy', stance: 'watch', note: 'reclaim VWAP' });
  assert.equal(r.verdict, 'Buyable dip');
  assert.equal(r.setupClass, 'pullback-buy');
  assert.equal(r.stance, 'watch');
  assert.equal(r.note, 'reclaim VWAP');
});

test('parseDualRead: drops hallucinated enum values to null', () => {
  const r = parseDualRead({ verdict: 'x', setupClass: 'moon-shot', stance: 'yolo' });
  assert.equal(r.setupClass, null);
  assert.equal(r.stance, null);
});

test('parseDualRead: missing verdict → null (unusable)', () => {
  assert.equal(parseDualRead({ setupClass: 'range' }), null);
  assert.equal(parseDualRead(null), null);
});

test('parseDualRead: over-long verdict is clipped', () => {
  const r = parseDualRead({ verdict: 'a'.repeat(400), setupClass: 'range', stance: 'wait' });
  assert.ok(r.verdict.length <= 240);
});

test('buildPrompt: includes both horizons and forces the tool', () => {
  const p = buildPrompt({
    ticker: 'AAPL', price: 310,
    st: { action: 'SELL', confidence: 6, reasons: ['Below VWAP'] },
    lt: { trend: 'bullish', score: 9, reasons: ['Above 200-day'], factors: { pctFrom200: 14, rs3mPct: 6 } },
    mech: { verdict: 'Pullback in an uptrend', setupClass: 'pullback-buy' },
  });
  assert.match(p, /SHORT-TERM/);
  assert.match(p, /LONG-TERM/);
  assert.match(p, /submit_dual_read/);
  assert.match(p, /AAPL/);
});

test('enum vocab exports are non-empty and consistent', () => {
  assert.ok(SETUP_CLASSES.includes('pullback-buy'));
  assert.ok(STANCES.includes('avoid'));
});

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildPrompt, parseDualRead } = require('../lib/dualread-fable');

const base = {
  ticker: 'AAPL', price: 190,
  st: { action: 'SELL', confidence: 5, reasons: ['Below VWAP'] },
  lt: { trend: 'bullish', score: 6, reasons: ['Above 200-day'], factors: { pctFrom200: 12 } },
  mech: { verdict: 'Pullback in an uptrend', setupClass: 'pullback-buy' },
};

test('prompt includes the swing horizon when provided', () => {
  const p = buildPrompt({ ...base, sw: { action: 'BUY', evidenceStrength: 6, reasons: ['Fresh reclaim'], plan: { trigger: 192, invalidation: 180, objective: 210 } } });
  assert.match(p, /SWING/);
  assert.match(p, /BUY \(evidence 6\/10/);
  assert.match(p, /trigger \$192/);
});

test('prompt instructs Fable NOT to change the mechanical action or invent prices', () => {
  const p = buildPrompt({ ...base, sw: { action: 'WAIT', evidenceStrength: 2, reasons: [] } });
  assert.match(p, /Do NOT change any mechanical action/);
  assert.match(p, /Do NOT invent prices/);
  assert.match(p, /prioritizes the SWING/);
});

test('prompt still works with no swing context (backward compatible)', () => {
  const p = buildPrompt(base);
  assert.ok(!/SWING \(daily/.test(p));
  assert.match(p, /SHORT-TERM/);
});

test('parseDualRead never returns a numeric action/price — only enum labels', () => {
  const out = parseDualRead({ verdict: 'x', setupClass: 'pullback-buy', stance: 'watch', note: 'reclaim 192' });
  assert.strictEqual(out.setupClass, 'pullback-buy');
  assert.ok(!('action' in out), 'fable never emits a mechanical action');
});

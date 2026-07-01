'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePulse, PULSE_TOOL } = require('../lib/pulse-routes');

const toolMsg = items => ({ content: [{ type: 'tool_use', name: 'submit_pulse', input: { items } }] });

test('parsePulse: ranks by popularity + velocity (exploding beats a more-popular steady)', () => {
  const items = parsePulse(toolMsg([
    { headline: 'A steady but very popular', idea: 'x', whyMoves: 'y', sentiment: 'bullish', popularity: 90, velocity: 'steady', sources: 's', tickers: ['aapl'] },
    { headline: 'B exploding', idea: 'x', whyMoves: 'y', sentiment: 'mixed', popularity: 80, velocity: 'exploding', sources: 's', tickers: ['tsla'] },
  ]));
  // B: 80 + 3*8 = 104 ; A: 90 + 1*8 = 98 → B ranks #1
  assert.equal(items[0].headline, 'B exploding');
  assert.equal(items[0].rank, 1);
  assert.equal(items[1].rank, 2);
});

test('parsePulse: sanitizes tickers (uppercase, strips junk, caps at 6)', () => {
  const [it] = parsePulse(toolMsg([{ headline: 'h', idea: 'i', whyMoves: 'w', sentiment: 'bullish', popularity: 50, velocity: 'rising', sources: 's', tickers: ['aapl', '$tsla!', 'brk.b', 'a', 'b', 'c', 'd'] }]));
  assert.deepEqual(it.tickers, ['AAPL', 'TSLA', 'BRK.B', 'A', 'B', 'C']);
});

test('parsePulse: clamps popularity to 1-100 and defaults bad enums', () => {
  const [it] = parsePulse(toolMsg([{ headline: 'h', idea: 'i', whyMoves: 'w', sentiment: 'wat', popularity: 999, velocity: 'nope', sources: 's', tickers: [] }]));
  assert.equal(it.popularity, 100);
  assert.equal(it.sentiment, 'mixed');
  assert.equal(it.velocity, 'steady');
});

test('parsePulse: drops items missing headline/idea and caps at 10', () => {
  const many = Array.from({ length: 14 }, (_, i) => ({ headline: 'h' + i, idea: 'i', whyMoves: 'w', sentiment: 'bullish', popularity: 50 + i, velocity: 'rising', sources: 's', tickers: [] }));
  many.push({ idea: 'no headline' }, { headline: 'no idea' });
  const items = parsePulse(toolMsg(many));
  assert.equal(items.length, 10);
  assert.ok(items.every(x => x.headline && x.idea));
});

test('parsePulse: empty / non-tool message yields empty list, no throw', () => {
  assert.deepEqual(parsePulse({ content: [{ type: 'text', text: 'hi' }] }), []);
  assert.deepEqual(parsePulse({}), []);
});

test('PULSE_TOOL schema requires the render-critical fields', () => {
  const req = PULSE_TOOL.input_schema.properties.items.items.required;
  ['rank', 'headline', 'tickers', 'idea', 'whyMoves', 'sentiment', 'popularity', 'velocity', 'sources'].forEach(f => assert.ok(req.includes(f), `${f} required`));
});

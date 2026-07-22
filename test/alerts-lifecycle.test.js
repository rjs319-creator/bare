'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const lc = require('../lib/alerts-lifecycle');

const side = seg => lc.classifySegment(seg);

test('option exposure matrix: buy call=long, sell call=short, buy put=short, sell put=long', () => {
  assert.equal(lc.optionExposure('buy', 'call'), 'long');
  assert.equal(lc.optionExposure('sell', 'call'), 'short');
  assert.equal(lc.optionExposure('buy', 'put'), 'short');
  assert.equal(lc.optionExposure('sell', 'put'), 'long');
});

test('SOLD PUT is bullish, not bearish (the classic keyword-bot error)', () => {
  const r = side('sold $NVDA 100 puts for income');
  assert.equal(r.direction, 'long');
  assert.ok(r.event === 'ENTRY_LONG' || r.event === 'ADD_LONG');
});

test('BOUGHT PUT is bearish', () => {
  const r = side('bought $SPY 400 puts, hedging downside');
  assert.equal(r.direction, 'short');
  assert.equal(r.event, 'ENTRY_SHORT');
});

test('"trimmed" is a position update on a LONG, not a new bearish call', () => {
  const r = side('trimmed my $AAPL long into strength');
  assert.equal(r.event, 'TRIM_LONG');
  assert.equal(r.isNewThesis, false);          // must NOT become a new prediction
});

test('bare "sold" closes a long — a position update, not bearish', () => {
  const r = side('sold $TSLA here, taking profit');
  assert.equal(r.event, 'EXIT_LONG');
  assert.equal(r.isNewThesis, false);
});

test('entry vs exit vs recap are distinguished', () => {
  assert.equal(side('bought $AMD calls, breakout setup').event, 'ENTRY_LONG');
  assert.equal(side('closed $AMD, done here').event, 'EXIT_LONG');
  assert.equal(side('recap: $AMD up 12% nice trade').event, 'RECAP');
});

test('stop-hit and target-hit are terminal, non-directional', () => {
  assert.equal(side('stopped out of $NIO').event, 'STOP_HIT');
  assert.equal(side('$NIO target hit, out').event, 'TARGET_HIT');
  assert.equal(side('stopped out of $NIO').isNewThesis, false);
});

test('negation: "not buying puts" is not treated as a bearish short entry', () => {
  const r = side('definitely not buying puts on $QQQ here');
  assert.notEqual(r.event, 'ENTRY_SHORT');
});

test('rhetorical/uncertain language raises uncertainty and avoids a hard call', () => {
  const r = side('who is still short $GME? maybe a bounce');
  assert.equal(r.uncertainty, 'high');
});

test('parsePost: multi-ticker post assigns per-ticker lifecycle events', () => {
  const p = lc.parsePost('bought $AAPL calls, and sold my $TSLA position');
  const aapl = p.perTicker.find(x => x.ticker === 'AAPL');
  const tsla = p.perTicker.find(x => x.ticker === 'TSLA');
  assert.equal(aapl.direction, 'long');
  assert.equal(tsla.event, 'EXIT_LONG');
});

test('parsePost: extracts levels, timeframe, catalysts, option', () => {
  const p = lc.parsePost('swing long $ABCD, entry 50 stop 45 target 65, earnings catalyst, 55 calls');
  assert.equal(p.levels.target, 65);
  assert.equal(p.timeframe, 'swing');
  assert.ok(p.catalysts.includes('earnings'));
  assert.equal(p.option.type, 'call');
});

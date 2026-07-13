'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const R = require('../lib/ignition-routes');

function upSeries() {
  const rows = []; let px = 100; let d = new Date('2026-01-01T00:00:00Z');
  for (let i = 0; i < 40; i++) {
    px *= (i < 33 ? 1.001 : 1 + 0.004 * (i - 32));
    const v = 1e6 * (i < 33 ? 1 : 1 + 0.4 * (i - 32));
    rows.push({ date: d.toISOString().slice(0, 10), open: px, high: px * 1.02, low: px * 0.98, close: px, volume: v });
    d = new Date(d.getTime() + 86400000);
  }
  return rows;
}

test('shortlistFromToday keeps momentum families, dedups by ticker, caps', () => {
  const today = { horizons: {
    intraday: [{ ticker: 'AAA', strategyFamily: 'trend', horizon: 'intraday', score: 80 }],
    swing: [{ ticker: 'AAA', strategyFamily: 'trend', horizon: 'swing', score: 60 }, { ticker: 'CTX', strategyFamily: 'context', horizon: 'swing', score: 90 }],
    position: [{ ticker: 'BBB', strategyFamily: 'event', horizon: 'position', score: 70 }],
    portfolio: [],
  } };
  const sl = R.shortlistFromToday(today);
  const tks = sl.map(s => s.ticker);
  assert.ok(tks.includes('AAA') && tks.includes('BBB'));
  assert.ok(!tks.includes('CTX'), 'pure context/sentiment excluded');
  assert.strictEqual(sl.filter(s => s.ticker === 'AAA').length, 1, 'deduped');
  assert.strictEqual(sl.find(s => s.ticker === 'AAA').score, 80, 'kept highest-scored instance');
});

test('catalystFromSignal: gap/breakout → age 0; passed event → |inDays|', () => {
  assert.strictEqual(R.catalystFromSignal({ catalyst: 'gap-up' }).ageDays, 0);
  assert.strictEqual(R.catalystFromSignal({ event: { type: 'earnings', kind: 'passed', inDays: -4 } }).ageDays, 4);
  assert.strictEqual(R.catalystFromSignal({}).catalyst, null);
});

test('buildIgnition ranks by score, produces stages, honest N/A fields', () => {
  const signals = [{ ticker: 'AAA', company: 'A', sector: 'Tech', sources: ['daytrade'], catalyst: 'contract', score: 80 }];
  const out = R.buildIgnition(signals, { AAA: upSeries() }, { riskOn: true });
  assert.strictEqual(out.cards.length, 1);
  const c = out.cards[0];
  assert.ok(c.score >= 0 && c.score <= 100);
  assert.strictEqual(c.distanceToLuld, null);      // honest N/A on EOD data
  assert.strictEqual(c.float, null);
  assert.ok(out.dataNote.includes('LULD'));
  assert.ok(['Watch', 'Ignition', 'Pressure', 'Extended'].includes(c.stage));
});

test('buildIgnition skips names without enough candle history (no fabrication)', () => {
  const out = R.buildIgnition([{ ticker: 'ZZZ', sources: ['daytrade'] }], { ZZZ: [{ date: '2026-01-01', close: 10, high: 10, low: 10, volume: 1 }] }, {});
  assert.strictEqual(out.cards.length, 0);
});

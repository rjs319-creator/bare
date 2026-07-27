'use strict';
// Cross-cutting pre-move contracts (docs/premove-transition-v2.md):
//   - next-open eligibility: nothing can trigger or fill on the decision bar;
//   - Day Trade output is byte-identical under every PREMOVE_V2_MODE value;
//   - shadow mode preserves the exact op=today projection.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const LT2 = require('../lib/leadtime2');
const { buildToday } = require('../lib/decision-routes');
const { SOURCES, project } = require('./fixtures/today-sources');

function bars(closes, overrides = {}) {
  return closes.map((c, i) => {
    const o = overrides[i] || {};
    const d = new Date(Date.UTC(2026, 0, 5 + Math.floor(i / 5) * 7 + (i % 5)));
    return { date: d.toISOString().slice(0, 10), open: o.open ?? c, high: o.high ?? c * 1.005, low: o.low ?? c * 0.995, close: c, volume: 1e6 };
  });
}
const flat30 = (px = 100) => Array.from({ length: 30 }, (_, i) => px * (1 + (i % 2 ? 0.002 : -0.002)));

test('next-open eligibility: the decision bar itself can never trigger or fill', () => {
  // The DECISION bar (idx 29) spikes through the trigger; every later bar is flat.
  const closes = [...flat30(), 100, 100, 100, 100, 100, 100];
  const candles = bars(closes, { 29: { high: 150, open: 100 } });
  const r = LT2.episodeLeadTime({ date: candles[29].date, ticker: 'T', entry: 110, stop: 90 }, candles);
  assert.equal(r.horizons[5].outcome, 'no-trigger',
    'a same-bar spike on the decision bar must not count — the earliest eligible session is the NEXT one');
});

test('Day Trade rows are byte-identical under every PREMOVE_V2_MODE value', () => {
  const dayTradeRows = (proj) => Object.values(proj.horizons).flat()
    .filter(r => r.source === 'daytrade').sort((a, b) => a.ticker.localeCompare(b.ticker));
  const prev = process.env.PREMOVE_V2_MODE;
  try {
    delete process.env.PREMOVE_V2_MODE;
    const base = dayTradeRows(project(buildToday(SOURCES, null, null, null)));
    assert.ok(base.length >= 2, 'fixture must carry Day Trade rows');
    for (const mode of ['off', 'shadow', 'enforce']) {
      process.env.PREMOVE_V2_MODE = mode;
      const rows = dayTradeRows(project(buildToday(SOURCES, null, null, null)));
      assert.deepEqual(rows, base, `Day Trade rows must be unchanged under PREMOVE_V2_MODE=${mode}`);
    }
  } finally {
    if (prev === undefined) delete process.env.PREMOVE_V2_MODE; else process.env.PREMOVE_V2_MODE = prev;
  }
});

test('the full op=today projection is unchanged under every PREMOVE_V2_MODE value', () => {
  const prev = process.env.PREMOVE_V2_MODE;
  try {
    delete process.env.PREMOVE_V2_MODE;
    const base = project(buildToday(SOURCES, null, null, null));
    for (const mode of ['off', 'shadow', 'enforce']) {
      process.env.PREMOVE_V2_MODE = mode;
      assert.deepEqual(project(buildToday(SOURCES, null, null, null)), base,
        `op=today must be byte-identical under PREMOVE_V2_MODE=${mode}`);
    }
  } finally {
    if (prev === undefined) delete process.env.PREMOVE_V2_MODE; else process.env.PREMOVE_V2_MODE = prev;
  }
});

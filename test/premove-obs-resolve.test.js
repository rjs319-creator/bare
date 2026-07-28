'use strict';
// The ghostobs observation records captured selected AND rejected candidates but
// nothing ever graded them — outcome.state stayed 'unresolved' forever, so the
// false-negative question ("do rejected names go on to win?") was unanswerable.
// These tests pin the resolver's honesty contract: censor-aware maturity, gap
// fills at the worse price, same-bar ambiguity resolving to the stop, rejected
// cohorts graded exactly like selected ones, gross-basis labeling.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveObsRow, resolveObservationDays, OBS_HORIZON_SESSIONS } = require('../lib/premove-obs-resolve');

// Build `n` flat daily candles after `date0`, then apply overrides by index.
function bars(n, { base = 100, date0 = '2026-06-01' } = {}, overrides = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(`${date0}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
    out.push({ date: d.toISOString().slice(0, 10), open: base, high: base, low: base, close: base, ...(overrides[i] || {}) });
  }
  return out;
}

const ROW = Object.freeze({
  ticker: 'TEST', date: '2026-06-01', decisionPrice: 100,
  tier: 'WATCH', score: 60, triggerLevel: 105, invalidation: 95, target: 115,
});

test('censored rows stay null — no partial grades before the window elapses', () => {
  // Only 4 sessions of forward data exist; nothing terminal happened.
  const candles = bars(5); // index 0 is the decision date itself
  assert.equal(resolveObsRow(ROW, candles), null);
});

test('NO_TRIGGER resolves only after the full window, with the forward return', () => {
  const candles = bars(OBS_HORIZON_SESSIONS + 2);
  candles[OBS_HORIZON_SESSIONS].close = 108; // last in-window session
  const out = resolveObsRow(ROW, candles);
  assert.ok(out, 'full window elapsed — must resolve');
  assert.equal(out.state, 'NO_TRIGGER');
  assert.equal(out.triggered, false);
  assert.equal(out.fwdPct, 8);
  assert.equal(out.returnsBasis, 'gross');
});

test('trigger then target resolves EARLY (before window end) at the target price', () => {
  const candles = bars(6, {}, {
    2: { high: 106 },            // trigger day (105 crossed)
    4: { high: 116 },            // target day (115 crossed)
  });
  const out = resolveObsRow(ROW, candles);
  assert.ok(out, 'terminal event inside an incomplete window still resolves');
  assert.equal(out.state, 'TRIGGERED_TARGET');
  assert.equal(out.fillPrice, 105);
  assert.equal(out.fwdPct, +(((115 / 105) - 1) * 100).toFixed(2));
});

test('same-bar stop AND target resolves CONSERVATIVELY to the stop', () => {
  const candles = bars(6, {}, {
    2: { high: 106 },
    3: { high: 120, low: 90 },   // both barriers reachable in one bar
  });
  const out = resolveObsRow(ROW, candles);
  assert.equal(out.state, 'TRIGGERED_STOP');
  assert.equal(out.fwdPct, +(((95 / 105) - 1) * 100).toFixed(2));
});

test('a gap-open through the trigger fills at the WORSE open price', () => {
  const candles = bars(6, {}, {
    2: { open: 109, high: 110 }, // gaps over the 105 trigger
    4: { high: 116 },
  });
  const out = resolveObsRow(ROW, candles);
  assert.equal(out.state, 'TRIGGERED_TARGET');
  assert.equal(out.fillPrice, 109, 'fill must be the worse of open vs trigger');
});

test('a gap-open at/through the target is CONSUMED_AT_FILL — no imaginary profit', () => {
  const candles = bars(6, {}, {
    2: { open: 116, high: 118 }, // gaps beyond the 115 target
  });
  const out = resolveObsRow(ROW, candles);
  assert.equal(out.state, 'CONSUMED_AT_FILL');
  assert.equal(out.fwdPct, 0);
});

test('rows without a trigger plan grade as a plain FORWARD_WINDOW — rejected cohorts included', () => {
  const day = {
    date: '2026-06-01',
    selected: [{ ticker: 'SEL', decisionPrice: 100, triggerLevel: 105, invalidation: 95, target: 115, tier: 'GHOST', score: 82 }],
    rejected: [{ ticker: 'REJ', decisionPrice: 50, triggerLevel: null, invalidation: null, target: null, tier: 'WATCH', score: 40 }],
  };
  const rejCandles = bars(OBS_HORIZON_SESSIONS + 2, { base: 50 });
  rejCandles[OBS_HORIZON_SESSIONS].close = 60; // the rejected name ripped +20%
  const selCandles = bars(OBS_HORIZON_SESSIONS + 2);
  const candleFor = (t) => (t === 'REJ' ? rejCandles : selCandles);

  const { outcomes, censored, missingCandles } = resolveObservationDays([day], candleFor);
  assert.equal(missingCandles, 0);
  assert.equal(censored, 0);
  const rej = outcomes.find(o => o.ticker === 'REJ');
  assert.ok(rej, 'the REJECTED cohort must be graded, not just the selected one');
  assert.equal(rej.cohort, 'rejected');
  assert.equal(rej.state, 'FORWARD_WINDOW');
  assert.equal(rej.fwdPct, 20);
  const sel = outcomes.find(o => o.ticker === 'SEL');
  assert.equal(sel.state, 'NO_TRIGGER');
});

test('already-resolved keys are skipped; missing candles are counted, not faked', () => {
  const day = {
    date: '2026-06-01',
    selected: [{ ticker: 'AAA', decisionPrice: 100 }],
    rejected: [{ ticker: 'BBB', decisionPrice: 100 }],
  };
  const { outcomes, missingCandles } = resolveObservationDays(
    [day], () => null, { existingKeys: new Set(['2026-06-01|AAA']) });
  assert.equal(outcomes.length, 0);
  assert.equal(missingCandles, 1, 'only the unresolved row counts as missing');
});

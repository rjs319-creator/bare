'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { scoreGapGo, gapTake, freezeGapLedgerPick, GAP_BIG_AVOID } = require('../lib/gapgo');

// `n` bars of history via price fn(i), then a final gap-up day `gapPct`% above the
// prior close. Ascending real weekday dates; liquidity well above the floor.
function tapeWithGap(gapPct, fn, n = 260, vol = 3_000_000) {
  const candles = [];
  const start = Date.parse('2025-01-01');
  let added = 0, t = 0;
  while (added < n) {
    const d = new Date(start + t * 864e5); t++;
    const dow = d.getUTCDay(); if (dow === 0 || dow === 6) continue;
    const p = fn(added);
    candles.push({ date: d.toISOString().slice(0, 10), open: p, high: p * 1.01, low: p * 0.99, close: p, volume: vol });
    added++;
  }
  const prevClose = candles[candles.length - 1].close;
  const open = +(prevClose * (1 + gapPct / 100)).toFixed(2);
  const close = +(open * 1.02).toFixed(2);
  candles.push({ date: '2026-01-30', open, high: +(close * 1.01).toFixed(2), low: +(open * 0.995).toFixed(2), close, volume: vol * 2 });
  return candles;
}

const uptrend = i => 50 + i * 0.25;   // passes the strict trend template
const flat = () => 50;                // close === SMA50 ⇒ template fails

test('a >=10% gap in a template-passing uptrend is flagged avoidExtendedGap', () => {
  const s = scoreGapGo(tapeWithGap(12, uptrend));
  assert.ok(s, 'expected a signal');
  assert.ok(s.gapPct >= GAP_BIG_AVOID);
  assert.strictEqual(s.avoidExtendedGap, true);
});

test('a >=10% gap without the trend template is NOT flagged', () => {
  const s = scoreGapGo(tapeWithGap(12, flat));
  assert.ok(s);
  assert.strictEqual(s.avoidExtendedGap, false);
});

test('a moderate gap in a template-passing uptrend is NOT flagged', () => {
  const s = scoreGapGo(tapeWithGap(6, uptrend));
  assert.ok(s);
  assert.strictEqual(s.avoidExtendedGap, false);
});

test('insufficient history yields avoidExtendedGap null (unknown), never a guess', () => {
  const s = scoreGapGo(tapeWithGap(12, flat, 30));
  assert.ok(s);
  assert.strictEqual(s.avoidExtendedGap, null);
});

test('gapTake skips flagged gaps only when skipExtendedAvoid is opted in', () => {
  assert.strictEqual(gapTake(60, 'neutral', { avoidExtendedGap: true }), true, 'default: annotation only');
  assert.strictEqual(gapTake(60, 'neutral', { avoidExtendedGap: true, skipExtendedAvoid: true }), false);
  assert.strictEqual(gapTake(60, 'neutral', { avoidExtendedGap: false, skipExtendedAvoid: true }), true);
  assert.strictEqual(gapTake(60, 'neutral', { avoidExtendedGap: null, skipExtendedAvoid: true }), true, 'unknown is kept, never silently dropped');
});

test('freezeGapLedgerPick persists the avoid flag for forward grading', () => {
  const base = { ticker: 'T', tier: 'STRONG', gapPct: 12, date: '2026-01-30', plan: { trigger: 1 } };
  assert.strictEqual(freezeGapLedgerPick({ ...base, avoidExtendedGap: true }, { decisionTs: 'x', sessionDate: 'y' }).avoidExtendedGap, true);
  assert.strictEqual(freezeGapLedgerPick({ ...base, avoidExtendedGap: null }, { decisionTs: 'x', sessionDate: 'y' }).avoidExtendedGap, null);
  assert.strictEqual(freezeGapLedgerPick({ ...base, avoidExtendedGap: false }, { decisionTs: 'x', sessionDate: 'y' }).avoidExtendedGap, false);
});

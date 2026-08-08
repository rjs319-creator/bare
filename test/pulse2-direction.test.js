'use strict';
// Market Pulse v2 — DIRECTION-AWARE REACTION + CATALYST MATRIX.
// Required behaviors #6, #7, #8: bullish confirmation requires bullish price behavior,
// bearish confirmation requires bearish price behavior, and mixed/unknown direction can
// never become a directional trade read. (v1's priceConfirms() checked "up + volume"
// regardless of the thesis — the exact defect these lock out.)

const test = require('node:test');
const assert = require('node:assert');
const D = require('../lib/pulse2-direction');

const bullishTape = { residualPct: 2.0, vsVWAP: 0.5, sameTimeRelVol: 2.0, atrExt: 1.0 };
const bearishTape = { residualPct: -2.0, vsVWAP: -0.5, sameTimeRelVol: 2.0, atrExt: -1.0 };

test('#6: bullish thesis + bullish tape (above VWAP, participation) = PRICE_CONFIRMED', () => {
  const r = D.assessReaction({ direction: 'BULLISH', features: bullishTape, dataFresh: true });
  assert.equal(r.reaction, 'PRICE_CONFIRMED');
});

test('#7: bearish thesis + FALLING price = confirmation, not contradiction (v1 got this wrong)', () => {
  const r = D.assessReaction({ direction: 'BEARISH', features: bearishTape, dataFresh: true });
  assert.equal(r.reaction, 'PRICE_CONFIRMED');
});

test('#7b: a bearish thesis is NOT confirmed by a rally — it is CONTRADICTED', () => {
  const r = D.assessReaction({ direction: 'BEARISH', features: bullishTape, dataFresh: true });
  assert.equal(r.reaction, 'CONTRADICTED');
});

test('#6b: a bullish thesis with price falling hard is CONTRADICTED', () => {
  const r = D.assessReaction({ direction: 'BULLISH', features: bearishTape, dataFresh: true });
  assert.equal(r.reaction, 'CONTRADICTED');
});

test('#8: MIXED / NON_DIRECTIONAL / UNKNOWN never reach PRICE_CONFIRMED', () => {
  for (const dir of ['MIXED', 'NON_DIRECTIONAL', 'UNKNOWN']) {
    const r = D.assessReaction({ direction: dir, features: bullishTape, dataFresh: true });
    assert.notEqual(r.reaction, 'PRICE_CONFIRMED', dir);
    assert.notEqual(r.reaction, 'CONTRADICTED', dir);
  }
});

test('confirmation requires participation — direction alone is only REACTING_AS_EXPECTED', () => {
  const r = D.assessReaction({ direction: 'BULLISH', features: { ...bullishTape, sameTimeRelVol: 0.7 }, dataFresh: true });
  assert.equal(r.reaction, 'REACTING_AS_EXPECTED');
});

test('a thesis-aligned move beyond the ATR ceiling is EXTENDED, not confirmed', () => {
  const r = D.assessReaction({ direction: 'BULLISH', features: { ...bullishTape, atrExt: 3.0 }, dataFresh: true });
  assert.equal(r.reaction, 'EXTENDED');
  // A deep NEGATIVE extension confirms a BEARISH thesis as extended too (sign flipped).
  const rb = D.assessReaction({ direction: 'BEARISH', features: { ...bearishTape, atrExt: -3.0 }, dataFresh: true });
  assert.equal(rb.reaction, 'EXTENDED');
});

test('stale data yields INSUFFICIENT_DATA — never a confident reaction read', () => {
  const r = D.assessReaction({ direction: 'BULLISH', features: bullishTape, dataFresh: false });
  assert.equal(r.reaction, 'INSUFFICIENT_DATA');
});

test('broken structure after confirming = FAILED', () => {
  const r = D.assessReaction({ direction: 'BULLISH', features: { ...bullishTape, brokeStructure: true }, dataFresh: true });
  assert.equal(r.reaction, 'FAILED');
});

// ── Catalyst reaction matrix ────────────────────────────────────────────────
test('matrix: verified positive unreacted / confirming / extended cells', () => {
  assert.equal(D.catalystMatrixCell({ evidence: 'VERIFIED', direction: 'BULLISH', reaction: 'UNREACTED' }), 'VERIFIED_POSITIVE_UNREACTED');
  assert.equal(D.catalystMatrixCell({ evidence: 'VERIFIED', direction: 'BULLISH', reaction: 'PRICE_CONFIRMED' }), 'VERIFIED_POSITIVE_CONFIRMING');
  assert.equal(D.catalystMatrixCell({ evidence: 'VERIFIED', direction: 'BULLISH', reaction: 'EXTENDED' }), 'VERIFIED_POSITIVE_EXTENDED');
});

test('matrix: verified negative side mirrors correctly', () => {
  assert.equal(D.catalystMatrixCell({ evidence: 'VERIFIED', direction: 'BEARISH', reaction: 'UNREACTED' }), 'VERIFIED_NEGATIVE_UNREACTED');
  assert.equal(D.catalystMatrixCell({ evidence: 'SUPPORTED', direction: 'BEARISH', reaction: 'REACTING_AS_EXPECTED' }), 'VERIFIED_NEGATIVE_CONFIRMING');
});

test('matrix: unverified rumor with a big move = UNVERIFIED_LARGE_REACTION (hype/fade risk)', () => {
  assert.equal(D.catalystMatrixCell({ evidence: 'UNVERIFIED', direction: 'BULLISH', reaction: 'PRICE_CONFIRMED', movePct: 8 }), 'UNVERIFIED_LARGE_REACTION');
});

test('matrix: conflicted + volatile = avoid; repeated stale story = suppressed', () => {
  assert.equal(D.catalystMatrixCell({ evidence: 'CONFLICTED', direction: 'BULLISH', reaction: 'REACTING_AS_EXPECTED' }), 'CONFLICTED_VOLATILE_REACTION');
  assert.equal(D.catalystMatrixCell({ evidence: 'VERIFIED', direction: 'BULLISH', reaction: 'UNREACTED', isRepeat: true }), 'STALE_REPEATED_INFORMATION');
});

test('sanitizeDirection normalizes loose inputs and rejects junk', () => {
  assert.equal(D.sanitizeDirection('bullish'), 'BULLISH');
  assert.equal(D.sanitizeDirection('short'), 'BEARISH');
  assert.equal(D.sanitizeDirection('banana'), 'UNKNOWN');
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { explain } = require('../lib/swing-explain');

test('still-valid explanation names the measured numbers', () => {
  const s = explain({ lifecycle: 'THESIS_INTACT', thesis: 'INTACT', reasonCodes: [] },
    { returnSinceSuggestion: 0.034, excessVsSpy: 0.021, priceVsMa20: 0.5, consumedPct: 0.42 }, {});
  assert.match(s, /Still valid/);
  assert.match(s, /\+3\.4% since suggestion/);
  assert.match(s, /SPY/);
  assert.match(s, /58% of the original target remaining/);
});

test('strengthening explanation cites the score change', () => {
  const s = explain({ lifecycle: 'THESIS_INTACT', thesis: 'STRENGTHENING', reasonCodes: ['SCORE_IMPROVED'] },
    { currentScore: 79, returnSinceSuggestion: 0.05 }, { originalScore: 64 });
  assert.match(s, /Strengthening/);
  assert.match(s, /from 64 to 79/);
});

test('weakening explanation lists the cracks and the score fall', () => {
  const s = explain({ lifecycle: 'WEAKENING', thesis: 'WEAKENING', reasonCodes: ['RS_DETERIORATION', 'VOLUME_FADE', 'SCORE_DECLINED'] },
    { currentScore: 54 }, { originalScore: 78 });
  assert.match(s, /Weakening/);
  assert.match(s, /relative strength turned negative/);
  assert.match(s, /from 78 to 54/);
});

test('displaced explanation cites the rank move', () => {
  const s = explain({ lifecycle: 'VALID_BUT_DISPLACED', thesis: 'INTACT', reasonCodes: ['RANK_CUTOFF', 'STRONGER_CANDIDATES'] },
    { currentRank: 18 }, { originalRank: 7 });
  assert.match(s, /Valid but displaced/);
  assert.match(s, /rank 7 to rank 18/);
});

test('source-dropped-only explanation is not a negative judgment', () => {
  const s = explain({ lifecycle: 'VALID_BUT_DISPLACED', thesis: 'INTACT', reasonCodes: ['SOURCE_DROPPED'] }, { returnSinceSuggestion: 0.02 }, {});
  assert.match(s, /Source no longer selects/);
  assert.match(s, /remain intact/);
});

test('no-fill explanation states it is not a loss', () => {
  const s = explain({ lifecycle: 'NO_FILL', thesis: 'INTACT', reasonCodes: ['ENTRY_NOT_TRIGGERED'] }, {}, {});
  assert.match(s, /no-fill, not a loss/);
});

test('extended explanation says do not chase with remaining target', () => {
  const s = explain({ lifecycle: 'EXTENDED', thesis: 'INTACT', reasonCodes: ['EDGE_CONSUMED', 'RISK_REWARD_INADEQUATE'] }, { consumedPct: 0.88, remainingRewardRisk: 0.4 }, {});
  assert.match(s, /Do not chase/);
  assert.match(s, /12% of the original target/);
});

test('target and invalidation explanations are terminal and clear', () => {
  assert.match(explain({ lifecycle: 'TARGET_HIT', reasonCodes: [] }, { returnSinceSuggestion: 0.15 }, {}), /Target reached/);
  assert.match(explain({ lifecycle: 'INVALIDATED', reasonCodes: ['STOP_BREACH'] }, {}, {}), /No longer actionable/);
});

test('stale-data explanation retains last state without judgment', () => {
  const s = explain({ lifecycle: 'DATA_STALE', reasonCodes: ['DATA_STALE'] }, {}, {});
  assert.match(s, /Re-evaluation unavailable/);
  assert.match(s, /retaining the last confirmed state/);
});

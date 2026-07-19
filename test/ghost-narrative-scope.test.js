'use strict';
// audit #12/#14: the live ghost BONUS pillar blends an LLM narrative (0.6·fund + 0.4·narr), but the
// historical walk-forward pins narrativeStrength null — the LLM half is structurally
// unreconstructable (re-running an LLM "as of today" would leak post-decision info). These guard
// that the exclusion is real, material, and declared, so it can't silently regress into leakage.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const ghost = require('../lib/ghost');

test('BONUS: the LLM narrative MATERIALLY changes the pillar → pinning it null is a partial reconstruction', () => {
  const withNarr = ghost.pillarsOf({ pct: {}, narrativeStrength: 9, fundamentals: { revGrowth: 20 } });
  const noNarr = ghost.pillarsOf({ pct: {}, narrativeStrength: null, fundamentals: { revGrowth: 20 } });
  assert.notEqual(withNarr.BONUS, noNarr.BONUS, 'narrative shifts BONUS, so excluding it drops real information');
  // narrativeStrength:null reduces BONUS to the fundamental-only score — exactly what the WF reconstructs.
  const fundOnly = ghost.pillarsOf({ pct: {}, fundamentals: { revGrowth: 20 } });   // no narrativeStrength field
  assert.equal(noNarr.BONUS, fundOnly.BONUS);
});

test('guard: the historical backtest PINS narrativeStrength null (no leaky live LLM knowledge in history)', () => {
  const src = fs.readFileSync(require.resolve('../lib/ghost-backtest.js'), 'utf8');
  assert.ok(src.includes('narrativeStrength: null'),
    'ghost-backtest must pin narrativeStrength null — using live "as-of-today" narrative in a historical cohort is look-ahead leakage');
});

test('guard: the backtest DECLARES its feature scope and names the excluded live-only features', () => {
  const src = fs.readFileSync(require.resolve('../lib/ghost-backtest.js'), 'utf8');
  assert.ok(src.includes('featureScope'), 'backtest output must declare featureScope');
  assert.ok(/BONUS-narrative/.test(src), 'scope must name the excluded LLM narrative');
  assert.ok(/AI-screeners/.test(src), 'scope must name the forward-only AI screeners');
});

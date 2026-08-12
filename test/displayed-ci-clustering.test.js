'use strict';
// THE DISPLAYED CONFIDENCE INTERVAL WAS IID OVER OVERLAPPING PICKS (pass 3).
//
// summarizeReturns computed `avgCI` as avg ± 1.645·sd/√n over PICKS. Same-day picks
// share the market factor and overlapping multi-session horizons share days, so n is
// not a count of independent observations and the interval is too narrow. That was the
// interval surfaced to the user (lib/decision.js passes it through as `ci`, and the
// Scoreboard tooltip rendered it as "90% CI").
//
// The dependence-aware statistic — HAC/Newey-West SE, Student-t at the effective sample
// size, widened by a seeded moving-block bootstrap — was already computed in the SAME
// returned object as `dateNet`, and displayed nowhere.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const A = require('../lib/apex-routes');

// `dateLevelNetExcess` reads r.netExc (not netExcess) — using the wrong field silently
// yields no date-level statistic and a fallback interval.
function rows(dates, perDate) {
  const out = [];
  for (let d = 0; d < dates; d++) {
    const dt = `2025-${String(1 + (d % 12)).padStart(2, '0')}-${String(10 + Math.floor(d / 12)).padStart(2, '0')}`;
    for (let k = 0; k < perDate; k++) {
      out.push({ date: dt, ret: 1.2 + ((k % 3) - 1) * 0.4, excess: 1.0 + ((k % 3) - 1) * 0.4, netExc: 0.9 + ((k % 3) - 1) * 0.4 });
    }
  }
  return out;
}

test('the displayed interval is the date-clustered one when available', () => {
  const s = A.summarizeReturns(rows(40, 1), { horizonBars: 21 });
  assert.equal(s.avgCI.basis, 'date-clustered');
  assert.equal(s.avgCI.level, 95);
  assert.ok(Number.isFinite(s.avgCI.effectiveN));
});

test('clustering is not cosmetic — it changes the reported sample', () => {
  // 40 picks on 5 decision dates. The pick-level statistic claims 40 independent
  // observations; clustered, there are 5 dates and an effective sample of ~1.
  const s = A.summarizeReturns(rows(5, 8), { horizonBars: 21 });
  assert.equal(s.n, 40, 'the pick count is unchanged');
  assert.equal(s.avgCI.n, 5, 'the interval is computed over decision dates, not picks');
  assert.ok(s.avgCI.effectiveN <= 5, 'effective sample cannot exceed the date count');
  assert.ok(s.avgCI.effectiveN < s.n, 'and must be far below the pick count');
});

test('the superseded pick-level interval is retained but marked', () => {
  const s = A.summarizeReturns(rows(5, 8), { horizonBars: 21 });
  assert.equal(s.avgCIPickLevel.basis, 'pick-level-iid');
  // The gap between the two is the dependence being corrected for.
  const width = (ci) => ci.hi - ci.lo;
  assert.ok(width(s.avgCIPickLevel) >= 0 && width(s.avgCI) >= 0);
});

test('a record with no date-level channel falls back and SAYS it is pick-level', () => {
  // Older rows carry no netExc, so no clustered statistic can be formed. The fallback
  // must never be mistakable for a clustered interval.
  const legacy = rows(10, 2).map(({ netExc, ...r }) => r);
  const s = A.summarizeReturns(legacy, { horizonBars: 21 });
  assert.equal(s.avgCI.basis, 'pick-level-iid');
  assert.equal(s.avgCI.level, 90);
});

test('the frontend renders the level and basis from the payload, not a hardcoded 90%', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.ok(!/· 90% CI \[\$\{s\.avgCI\.lo\}/.test(app),
    'a hardcoded 90% label would mislabel the 95% clustered interval');
  assert.match(app, /\$\{s\.avgCI\.level \|\| 95\}% CI/);
  assert.match(app, /date-clustered/);
  assert.match(app, /same-day picks not independent/);
});

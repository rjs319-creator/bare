'use strict';
// DAY-TRADE ISOLATION IN CAPITAL ALLOCATION (alpha-research brief, non-negotiable
// boundary: "If shared infrastructure currently lets Day Trade output affect broader
// rankings, weights, or portfolio construction, isolate that connection while
// preserving the Day Trade module's behavior.")
//
// The intraday Gap & Go sleeve used to be merged into `sleeveRecs` before
// computeAllocation. Two separate contamination effects, both demonstrated below:
//
//   1. WEIGHTS — computeAllocation normalises inverse-vol weights across ALL sleeves
//      (`weights = inv / invSum`), so a Day-Trade sleeve's realized vol moved the
//      deployed weight of every swing sleeve. The replaced source comment said so
//      approvingly: "the lowest-vol sleeve, so risk parity leans weight toward it".
//   2. ESTIMATION WINDOW — computeAllocation intersects months across sleeves, so the
//      Day-Trade ledger's date range truncated the sample every swing sleeve was
//      estimated from.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { computeAllocation } = require('../lib/allocation');

const APEX = fs.readFileSync(path.join(__dirname, '..', 'lib', 'apex-routes.js'), 'utf8');

// Deterministic monthly ledgers. Swing sleeves span 2025-01..2025-12; the Day-Trade
// sleeve deliberately spans only 2025-07..2025-12 so the intersection effect is visible.
function months(start, count, retAt) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const m = start + i;
    const ym = `2025-${String(m).padStart(2, '0')}`;
    out.push({ date: `${ym}-15`, ret: retAt(i) });
  }
  return out;
}

const SWING = {
  Breakout: months(1, 12, i => 0.02 + 0.01 * Math.sin(i)),
  Momentum: months(1, 12, i => 0.015 + 0.02 * Math.cos(i)),
  Ghost:    months(1, 12, i => 0.01 + 0.015 * Math.sin(i * 1.7)),
  DownDay:  months(1, 12, i => 0.012 + 0.008 * Math.cos(i * 2.3)),
};
// Low-vol, late-starting Day-Trade sleeve — the exact shape that both pulls risk-parity
// weight and truncates the shared window.
// Low vol but NOT zero: computeAllocation guards `volAnn > 0 ? 1/volAnn : 0`, so a
// perfectly flat sleeve would score weight 0 and hide the normalisation effect.
const DT = { 'Gap & Go': months(7, 6, i => 0.004 + 0.002 * Math.sin(i * 3)) };

test('a Day-Trade sleeve changes every non-Day-Trade weight when pooled', () => {
  const clean = computeAllocation(structuredClone(SWING), {});
  const contaminated = computeAllocation(structuredClone({ ...SWING, ...DT }), {});

  assert.equal(clean.status, 'ok', 'fixture must produce a real allocation');
  assert.equal(contaminated.status, 'ok');

  const sleeveOf = (r, name) => r.sleeves.find(d => d.name === name) || {};
  const swing = ['Breakout', 'Momentum', 'Ghost', 'DownDay'];

  const moved = swing.filter(n => sleeveOf(clean, n).weight !== sleeveOf(contaminated, n).weight);
  assert.ok(moved.length > 0,
    'this fixture must demonstrate the contamination the isolation prevents');

  // And the Day-Trade sleeve takes a real share of the book when pooled — capital that
  // the risk-parity normaliser removes from the swing sleeves.
  const dtWeight = sleeveOf(contaminated, 'Gap & Go').weight;
  assert.ok(dtWeight > 0, 'the pooled Day-Trade sleeve draws weight away from swing sleeves');
});

test('a Day-Trade sleeve truncates the non-Day-Trade estimation window when pooled', () => {
  const clean = computeAllocation(structuredClone(SWING), {});
  const contaminated = computeAllocation(structuredClone({ ...SWING, ...DT }), {});
  assert.ok(
    contaminated.overlapMonths < clean.overlapMonths,
    `pooling must shrink the shared window (clean ${clean.overlapMonths} vs pooled ${contaminated.overlapMonths})`,
  );
});

test('the Day-Trade sleeve is not assembled into the allocated sleeve set', () => {
  // The Gap & Go ledger is still read and still reported — it is collected into a
  // separate object that never reaches computeAllocation.
  assert.match(APEX, /const dtSleeveRecs = \{\}/);
  assert.match(APEX, /dtSleeveRecs\['Gap & Go'\] = gapRecs/);
  assert.ok(!/sleeveRecs\['Gap & Go'\] = gapRecs/.test(APEX),
    'the Day-Trade sleeve must not be merged into the allocated sleeve set');
  assert.match(APEX, /computeAllocation\(sleeveRecs, \{ govWeights, govStatus, routerCaps \}\)/);
});

test('Day-Trade sections are not mapped into sleeve governance or router caps', () => {
  assert.match(APEX, /const SLEEVE_BY_SECTION = \{ \.\.\.LONG_SLEEVE \};/,
    'GapGo must not be re-added to the sleeve governance map');
  const routerMap = APEX.slice(APEX.indexOf('const SECTION_BY_ID'), APEX.indexOf('const SECTION_BY_ID') + 300);
  assert.ok(!/gapgo:/.test(routerMap), 'gapgo must not carry a router cap in the non-DT allocation');
});

test('exclusion is disclosed, not hidden', () => {
  assert.match(APEX, /allocation\.excludedSleeves = \{/);
  assert.match(APEX, /reason: 'day-trade-isolation'/);
});

test('Day Trade behaviour itself is preserved — the ledger is still read and counted', () => {
  // Isolation must not change what Gap & Go does, only what it influences.
  assert.match(APEX, /const gapDays = await readAllGapDays\(\)/);
  assert.match(APEX, /sleeves: Object\.keys\(dtSleeveRecs\)\.map/);
});

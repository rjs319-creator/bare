'use strict';
// ALPHA FOUNDRY ISOLATION INVARIANT — research data artifacts and the v3
// research-label stack must have ZERO live-app readers.
//
// The promise (research/MIGRATION-FWD-OUTCOME-2026-08.md: "No live code path
// reads any panel-derived artifact") was prose; this makes it a failing test.
// A RESEARCH/SHADOW/REJECTED model output can only influence a production pick
// ranking by being read from live code — so the guard is at the read site:
// nothing under lib/ (outside lib/research/ and lib/pitdata/) or api/ may
// reference the research panel, the research security master, the research
// outcome contract, or the research price cache.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Forbidden references for live code. Kept as plain strings so a rename that
// dodges the guard has to be deliberate and visible in this file's diff.
const FORBIDDEN = [
  'panel-features',            // panel-v2/v3 artifacts
  'secmaster-v3',              // research security master
  'research/lib/outcome-v3',   // research label contract
  'research/lib/pit',          // research PIT slice + price cache
  'research/lib/edgar',        // research EDGAR enrichment
  'pitdata-v3-listings',       // raw listing export
];

// Live-app surfaces that must stay isolated. lib/research/ is the app-side
// research harness (shadow-only by construction); lib/pitdata/ is the shadow
// collector — both are excluded because they ARE the research side.
function liveFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (p.includes(`lib${path.sep}research`) || p.includes(`lib${path.sep}pitdata`)) continue;
        walk(p);
      } else if (e.name.endsWith('.js')) {
        // lib/pitdata-routes.js is the shadow collector's route surface — part
        // of the research side (its v3export comment cites the migration path).
        if (e.name === 'pitdata-routes.js') continue;
        out.push(p);
      }
    }
  };
  walk(path.join(ROOT, 'lib'));
  walk(path.join(ROOT, 'api'));
  return out;
}

test('no live code path reads research panel/master/label artifacts', () => {
  const offenders = [];
  for (const f of liveFiles()) {
    const src = fs.readFileSync(f, 'utf8');
    for (const needle of FORBIDDEN) {
      if (src.includes(needle)) offenders.push(`${path.relative(ROOT, f)} references "${needle}"`);
    }
  }
  assert.deepEqual(offenders, [], `research artifacts leaked into live code:\n${offenders.join('\n')}`);
});

test('research maturities can never be live-trade eligible', () => {
  const { isTradeEligible } = require('../lib/strategy-gate');
  const registry = require('../lib/strategy-registry');
  const list = registry.STRATEGY_REGISTRY || registry.REGISTRY || registry;
  for (const s of list) {
    if (['shadow', 'experimental', 'rejected'].includes(s.maturity)) {
      assert.equal(isTradeEligible(s.id), false, `${s.id} (${s.maturity}) must not be trade-eligible`);
    }
  }
  assert.equal(isTradeEligible('some-unregistered-model'), false, 'unknown ids fail closed');
});

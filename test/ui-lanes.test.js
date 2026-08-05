'use strict';
// PHASE 10 — the UI must render the three lanes structurally (not as a per-card chip), tell
// a novice what to DO, give an expert the decomposition, and never call a rank a probability.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SP = require('../lib/strategy-presentation');

const today = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'today.js'), 'utf8');
const ensemble = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'omega-ensemble.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');

test('THREE LANES exist as separate sections with distinct headings', () => {
  assert.match(today, /✅ Executable ideas/);
  assert.match(today, /🟡 Qualified leads/);
  assert.match(today, /🔬 Research watchlist/);
  assert.match(today, /qualifiedLeadsByHorizon/, 'the lead lane reads its own payload field');
});

test('each lane says what it can and cannot do, and is honestly empty rather than padded', () => {
  assert.match(today, /The only lane that can be sized/);
  assert.match(today, /never backfilled|never padded/);
  assert.match(today, /never enter the book, never boost an executable idea/);
});

test('QUALIFIED_LEAD has its own card chip — it is never rendered as actionable or research', () => {
  assert.match(today, /QUALIFIED_LEAD.*td-class-lead/s);
  assert.match(today, /🟡 QUALIFIED LEAD/);
  assert.match(css, /\.td-class-lead/);
});

test('a non-actionable card states WHY, in plain language, from the machine-readable codes', () => {
  assert.match(today, /REASON_TEXT/);
  for (const code of ['NO_PLAN', 'LEAD_ONLY', 'DATA_STALE', 'REDUCE_ONLY', 'CONDITION_UNMET', 'LIQUIDITY_UNKNOWN']) {
    assert.match(today, new RegExp(code), `${code} must have a plain-language rendering`);
  }
});

test('the novice line distinguishes enter / wait / hold and names the invalidation', () => {
  assert.match(today, /ENTER on the trigger/);
  assert.match(today, /WAIT for the trigger/);
  assert.match(today, /HOLD \/ manage/);
  assert.match(today, /invalidated below/);
  assert.match(today, /round-trip cost/);
});

test('retained picks are labeled MONITOR / HOLD / INVALIDATED / DATA_STALE, never dropped silently', () => {
  for (const k of ['MONITOR', 'HOLD', 'INVALIDATED', 'DATA_STALE']) assert.match(today, new RegExp(`${k}:`));
  assert.match(today, /retainedChip/);
});

test('the expert lane exposes the score decomposition, sample size and calibration status', () => {
  assert.match(today, /Expert detail — how this number was built/);
  assert.match(today, /scoreDecomposition/);
  assert.match(today, /mergedConviction/);
  assert.match(today, /Realized record/);
  assert.match(today, /relative setup score, not an out-of-fold calibrated probability/);
});

test('a degraded-data banner is rendered with per-source reasons', () => {
  assert.match(today, /degradedBanner/);
  assert.match(today, /Degraded data/);
  assert.match(today, /not offered as fresh entries/);
});

test('the ensemble page states the Book basis and puts research overlays in an annotation panel', () => {
  assert.match(ensemble, /bookBasisPanel/);
  assert.match(ensemble, /annotation only, never sized/);
  assert.match(ensemble, /Book basis/);
});

test('no lane heading or card text promises a probability of going up', () => {
  const forbidden = /probability of (rising|going up|profit)|chance of (rising|profit)/i;
  assert.doesNotMatch(today, forbidden);
  assert.doesNotMatch(ensemble.replace(/not calibrated/g, ''), /calibrated probability of/i);
});

test('PRESENTATION ROLES are derived from the registry + contract, not written per tab', () => {
  const breakout = SP.presentationFor('screener');
  assert.equal(breakout.role, 'candidate-generation');
  assert.match(breakout.headline, /candidate prioritization/i);
  assert.match(breakout.caveat, /NOT demonstrated/);

  const ghost = SP.presentationFor('ghost');
  assert.equal(ghost.role, 'overlay');
  assert.equal(ghost.incrementalOver, 'screener');

  const coil = SP.presentationFor('coil');
  assert.equal(coil.role, 'watchlist-detector');
  assert.match(coil.caveat, /NOT a probability of profit/);
  assert.ok(coil.twoStage && coil.twoStage.stageA.promotable === false);

  const dd = SP.presentationFor('downday');
  assert.equal(dd.role, 'conditional-sleeve');
  assert.match(dd.caveat, /RED tape/);
  assert.equal(dd.metric, '3d');

  const gg = SP.presentationFor('gapgo');
  assert.equal(gg.role, 'research-challenger');
  assert.match(gg.caveat, /inherits nothing/);
  assert.equal(gg.maturity, 'shadow');

  const om = SP.presentationFor('omega');
  assert.equal(om.role, 'baseline');
  assert.match(om.caveat, /No reliable market-relative edge/);
});

test('a lead-only strategy is labeled a lead, and its status line follows the REGISTRY', () => {
  const bio = SP.presentationFor('biotech');
  assert.equal(bio.leadOnly, true);
  assert.match(bio.statusLine, /Research \/ shadow/);
  const scr = SP.presentationFor('screener');
  assert.match(scr.statusLine, /Cleared for live use by the registry/);
  assert.doesNotMatch(scr.statusLine, /validated|proven/i, 'operational status must never read as earned validation');
});

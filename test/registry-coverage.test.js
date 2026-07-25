'use strict';
// Every strategy that LOGS picks to the Scoreboard must be registered, or it silently
// escapes the evidence system: no maturity grade, no Evidence-tab row, and (since the
// verdict banner is driven by the grade) no honesty banner on its own tab.
//
// Momentum Ignition was exactly that hole — 557 logged picks across two tiers and no
// registry entry, so the one strategy whose resolved record actually clears the
// Validated bar was the one strategy the grader never looked at.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');
const { poolSectionTrack, gradeTrack } = require('../lib/maturity');

test('Momentum Ignition is registered so it earns a grade like every other screener', () => {
  // Arrange / Act
  const entry = STRATEGY_REGISTRY.find(e => e.id === 'ignition');

  // Assert
  assert.ok(entry, 'ignition missing from the strategy registry');
  assert.equal(entry.section, 'Ignition', 'must join the Scoreboard section it logs under');
  assert.equal(entry.kind, 'signal');
});

test('Ignition is graded on its real SWING horizon, not the intraday nav grouping', () => {
  // The engine measures acceleration over 3-10 SESSION windows on end-of-day data, so
  // scoring it on a 1-day horizon would judge it on a timeframe it cannot even see.
  const entry = STRATEGY_REGISTRY.find(e => e.id === 'ignition');
  assert.equal(entry.horizon, 'swing');
});

test('registry sections are unique — two strategies cannot claim one Scoreboard section', () => {
  // Arrange
  const sections = STRATEGY_REGISTRY.map(e => e.section).filter(Boolean);

  // Act / Assert
  assert.equal(new Set(sections).size, sections.length, 'duplicate section join key in the registry');
});

test('a section with logged picks grades from its pooled record, both tiers counted', () => {
  // Arrange — Ignition's live shape: a small strong tier plus a large watch tier.
  const groups = [
    { section: 'Ignition', tier: 'IGNITION', horizons: { '5d': { excessN: 37, avgExcess: 2.58, beatMktRate: 62, secExcN: 35, avgSecExcess: 2.1, beatSecRate: 55 } } },
    { section: 'Ignition', tier: 'WATCH', horizons: { '5d': { excessN: 136, avgExcess: 1.22, beatMktRate: 57, secExcN: 125, avgSecExcess: 0.7, beatSecRate: 46 } } },
  ];

  // Act — pooling is excessN-weighted, so the 136-pick tier dominates as it should.
  const track = poolSectionTrack(groups, 'swing');

  // Assert
  assert.equal(track.excessN, 173);
  assert.ok(track.avgExcess > 1 && track.avgExcess < 2, `pooled average out of range: ${track.avgExcess}`);
});

test('Validated still requires beating the SECTOR, not just the market', () => {
  // Guards the bar Ignition clears: a strategy that beats SPY purely by riding a hot
  // sector must NOT be able to reach Validated on the back of this registration.
  const beatsBoth = gradeTrack({ excessN: 173, avgExcess: 1.51, beatMktRate: 58, secExcN: 160, avgSecExcess: 0.99, beatSecRate: 48 });
  const sectorBeta = gradeTrack({ excessN: 173, avgExcess: 1.51, beatMktRate: 58, secExcN: 160, avgSecExcess: -0.4, beatSecRate: 48 });

  assert.equal(beatsBoth.grade, 'validated');
  assert.equal(sectorBeta.grade, 'promising');
  assert.match(sectorBeta.reason, /NOT its sector/);
});

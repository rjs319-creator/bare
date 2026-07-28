'use strict';
// The router's evidence inputs must be measured or null — never guessed.
// These tests pin the two new measured inputs (recent rank IC from tier
// conviction; net/gross basis propagation) and the fail-closed contract that
// protects them: no declared tier ordinal → no rank IC, thin evidence → null.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recentRankICFor, TIER_ORDINAL, longTermFromStats } = require('../lib/algo-router-routes');

// Build a series of `days` dates; each date carries one row per [tier, excess] pair.
function seriesOf(days, rowsPerDay) {
  const out = [];
  for (let d = 0; d < days; d++) {
    const date = `2026-06-${String(d + 1).padStart(2, '0')}`;
    for (const [tier, excess] of rowsPerDay) out.push({ date, tier, excess });
  }
  return out;
}

test('rank IC is FAIL CLOSED: no declared tier ordinal → null, even with rich data', () => {
  // momentum has one conviction level per side — an ordinal would be invented.
  const series = seriesOf(20, [['StrongBuy', 2], ['StrongBuy', 1], ['StrongBuy', -1], ['StrongBuy', 0]]);
  assert.equal(recentRankICFor('momentum', series), null);
  assert.equal(recentRankICFor('not-an-algo', series), null);
  assert.ok(!('momentum' in TIER_ORDINAL), 'momentum must not gain a guessed ordinal');
});

test('a genuinely monotone tier→outcome relationship yields a positive rank IC', () => {
  // Arrange — Breakout beats Setup beats Early on every date, 4 names/date.
  const series = seriesOf(10, [
    ['Breakout', 3.0], ['Breakout', 2.5], ['Setup', 1.0], ['Early', -0.5],
  ]);

  // Act
  const ric = recentRankICFor('screener', series);

  // Assert
  assert.ok(ric, 'expected a measured IC');
  assert.ok(ric.ic >= 0.75, `monotone payoff should give strongly positive IC, got ${ric.ic}`);
  assert.equal(ric.dates, 10);
});

test('an INVERTED tier→outcome relationship reports a negative IC — no whitewash', () => {
  const series = seriesOf(10, [
    ['Breakout', -2.0], ['Breakout', -1.5], ['Setup', 0.5], ['Early', 2.0],
  ]);
  const ric = recentRankICFor('screener', series);
  assert.ok(ric && ric.ic <= -0.75, `inverted payoff must show up negative, got ${ric && ric.ic}`);
});

test('thin evidence stays null: too few dates, too few names, or no tier spread', () => {
  // 5 qualifying dates < the 8-date minimum.
  assert.equal(recentRankICFor('screener', seriesOf(5, [['Breakout', 2], ['Breakout', 1], ['Setup', 0], ['Early', -1]])), null);
  // Plenty of dates but only 3 names per date (< 4 minimum).
  assert.equal(recentRankICFor('screener', seriesOf(20, [['Breakout', 2], ['Setup', 0], ['Early', -1]])), null);
  // Plenty of rows but a single tier — no conviction spread to rank.
  assert.equal(recentRankICFor('ghost', seriesOf(20, [['GHOST', 2], ['GHOST', 1], ['GHOST', 0], ['GHOST', -1]])), null);
  // Unresolved rows (excess null) never count.
  assert.equal(recentRankICFor('screener', seriesOf(20, [['Breakout', null], ['Setup', null], ['Early', null], ['Breakout', null]])), null);
});

test('longTermFromStats carries the net/gross basis instead of dropping it', () => {
  const gross = longTermFromStats({ excessN: 40, avgExcess: 1.2, beatMktRate: 55, beatLo: 45, beatHi: 65, basis: 'gross' });
  const net = longTermFromStats({ excessN: 40, avgExcess: 0.8, beatMktRate: 52, beatLo: 42, beatHi: 62, basis: 'net' });
  assert.equal(gross.basis, 'gross');
  assert.equal(net.basis, 'net');
  // Unknown basis stays null — not defaulted to the flattering label.
  assert.equal(longTermFromStats({ excessN: 10, avgExcess: 1 }).basis, null);
});

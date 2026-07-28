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

// ---------------------------------------------------------------------------
// The GENERAL invariant the Ignition hole (and later the Evidence hole) proved
// necessary: every section the Scoreboard emits must resolve to a registered
// strategy, and every bridge table must resolve both of its ends. Source-scanned
// so a new `section: 'X'` emission cannot ship unregistered.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const { SECTION_TO_ID } = require('../lib/strategy-contracts');

function emittedSections() {
  const src = fs.readFileSync(path.join(__dirname, '../lib/apex-routes.js'), 'utf8');
  const out = new Set();
  // Both emission shapes runScoreboard uses: inline `section: 'X'` on a logged row,
  // and the shared `sectionRows(days, 'X')` helper.
  for (const m of src.matchAll(/section: '([A-Za-z]+)'/g)) out.add(m[1]);
  for (const m of src.matchAll(/sectionRows\([A-Za-z]+, '([A-Za-z]+)'\)/g)) out.add(m[1]);
  return out;
}

test('every Scoreboard section emitted by runScoreboard is a registered section', () => {
  // Arrange
  const registered = new Set(STRATEGY_REGISTRY.map(e => e.section).filter(Boolean));
  const emitted = emittedSections();
  assert.ok(emitted.size >= 15, `source scan looks broken — only found ${emitted.size} sections`);

  // Act / Assert — an emitted-but-unregistered section escapes grading entirely.
  for (const sec of emitted) {
    assert.ok(registered.has(sec), `Scoreboard emits section '${sec}' with no registry entry — it gets no maturity grade, no Evidence row, no honesty banner`);
  }
});

test('SECTION_TO_ID resolves both ends: registry sections in, registry ids out', () => {
  const ids = new Set(STRATEGY_REGISTRY.map(e => e.id));
  const registered = new Set(STRATEGY_REGISTRY.map(e => e.section).filter(Boolean));
  for (const [section, id] of Object.entries(SECTION_TO_ID)) {
    assert.ok(registered.has(section), `SECTION_TO_ID maps unknown section '${section}'`);
    assert.ok(ids.has(id), `SECTION_TO_ID maps section '${section}' to unknown strategy id '${id}'`);
  }
});

test('every emitted section resolves through SECTION_TO_ID — no silent default cooldowns', () => {
  for (const sec of emittedSections()) {
    assert.ok(SECTION_TO_ID[sec], `emitted section '${sec}' missing from SECTION_TO_ID — episode cooldown silently defaults`);
  }
});

test('every evidence-badge tab mapping resolves to a registered strategy id', () => {
  // The TAB_STRATEGY exceptions table is how a stale entry once wore production
  // momentum's "Proven" banner on the shadow Core Momentum tab.
  const src = fs.readFileSync(path.join(__dirname, '../public/js/evidence-badge.js'), 'utf8');
  const block = src.match(/const TAB_STRATEGY = \{([\s\S]*?)\};/);
  assert.ok(block, 'TAB_STRATEGY table not found in evidence-badge.js');
  const ids = new Set(STRATEGY_REGISTRY.map(e => e.id));
  const pairs = [...block[1].matchAll(/([A-Za-z]+):\s*'([A-Za-z-]+)'/g)];
  assert.ok(pairs.length >= 4, 'TAB_STRATEGY scan looks broken');
  for (const [, tab, id] of pairs) {
    assert.ok(ids.has(id), `TAB_STRATEGY maps tab '${tab}' to unknown strategy id '${id}'`);
  }
  // A tab must never be re-pointed at a DIFFERENT strategy that has higher maturity
  // than the tab's own registered strategy — that is exactly the coremo defect.
  const byId = new Map(STRATEGY_REGISTRY.map(e => [e.id, e]));
  for (const [, tab, id] of pairs) {
    const own = byId.get(tab);
    if (own && own.id !== id) {
      assert.ok(!(own.maturity !== 'production' && byId.get(id).maturity === 'production'),
        `tab '${tab}' is a registered ${own.maturity} strategy but wears production '${id}' verdict banner`);
    }
  }
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

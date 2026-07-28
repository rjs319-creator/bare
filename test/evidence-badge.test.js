'use strict';
// The shared evidence verdict (public/js/evidence-badge.js) is what stops a tab from
// showing pick cards while the app's own grade for that strategy is "Disabled". The
// wording rules are pure, so they are pinned here without a DOM or a network.
//
// The live case that motivated this: 👻 Ghost is a CORE tab with entry/stop/target
// cards, and its earned grade is Disabled — "underperforms the market over 166
// resolved (avg -4.2% vs SPY, beats 30%)". The tab never said a word about it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadBadge() {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/evidence-badge.js'), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '');
  const factory = new Function('esc', 'fetchJSON', 'OPTIONAL_TIMEOUT_MS', 'module',
    `${src}\nmodule.exports = { GRADE, gradeFace, strategyIdFor, verdictFor, verdictBannerHTML };`);
  const mod = { exports: {} };
  factory(x => String(x), async () => null, 0, mod);
  return mod.exports;
}

const GHOST = {
  id: 'ghost', label: '👻 Ghost Accumulation', grade: 'disabled',
  reason: 'Underperforms the market over 166 resolved (avg -4.2% vs SPY, beats 30%).',
  stats: { excessN: 166, avgExcess: -4.2, beatMktRate: 30 },
};

test('verdictFor: a Disabled strategy leads with a watch-only headline, not its label', () => {
  // Arrange / Act
  const { verdictFor } = loadBadge();
  const v = verdictFor(GHOST);

  // Assert — the first thing a beginner reads is the warning, in plain English.
  assert.equal(v.grade, 'disabled');
  assert.equal(v.face.icon, '⛔');
  assert.match(v.headline, /behind the market/i);
  assert.match(v.advice, /lost to simply buying the S&P 500/i);
});

test('verdictFor: the record sentence states sample, average AND beat-rate', () => {
  // Arrange / Act — beat-rate is the number the raw `reason` string buries.
  const { verdictFor } = loadBadge();
  const v = verdictFor(GHOST);

  // Assert
  assert.match(v.record, /166 past picks/);
  assert.match(v.record, /-4\.2% against the S&P 500/);
  assert.match(v.record, /beat it 30% of the time/);
});

test('verdictFor: a Validated strategy still carries a sizing caution', () => {
  // Arrange — a genuinely good record must not read as a licence to over-bet.
  const { verdictFor } = loadBadge();

  // Act
  const v = verdictFor({ id: 'x', grade: 'validated', stats: { excessN: 40, avgExcess: 2.1, beatMktRate: 62 } });

  // Assert
  assert.equal(v.face.icon, '✅');
  assert.match(v.advice, /size positions so a loss is survivable/i);
});

test('verdictFor: Informational strategies are never framed as trade signals', () => {
  // Arrange / Act
  const { verdictFor } = loadBadge();
  const v = verdictFor({ id: 'news', grade: 'informational', reason: 'Summarized headlines — context.' });

  // Assert
  assert.match(v.advice, /not to pick a trade/i);
  assert.equal(v.record, null); // no record to quote, and none invented
});

test('verdictFor: an ungraded or missing strategy produces no banner at all', () => {
  // Arrange / Act / Assert — silence beats a fabricated verdict.
  const { verdictFor, verdictBannerHTML } = loadBadge();
  assert.equal(verdictFor(null), null);
  assert.equal(verdictFor({ id: 'x' }), null);
  assert.equal(verdictBannerHTML(undefined), '');
});

test('verdictBannerHTML: renders the grade as a data attribute so a re-mount can diff it', () => {
  // Arrange / Act
  const { verdictBannerHTML } = loadBadge();
  const html = verdictBannerHTML(GHOST);

  // Assert
  assert.match(html, /class="ev-banner bad ev-verdict"/);
  assert.match(html, /data-grade="disabled"/);
});

test('strategyIdFor: tabs that share a strategy map onto it; the rest pass through', () => {
  // Arrange / Act / Assert — Picks is the momentum strategy's tab. Core Momentum is
  // NOT: coremo is its own registered shadow strategy (section CoreMomentum), and
  // mapping it onto production momentum put a "Proven" banner on a shadow book.
  const { strategyIdFor } = loadBadge();
  assert.equal(strategyIdFor('coremo'), 'coremo');
  assert.equal(strategyIdFor('picks'), 'momentum');
  assert.equal(strategyIdFor('rltlab'), 'rlt');
  assert.equal(strategyIdFor('atlas'), 'atlasx');
  assert.equal(strategyIdFor('options'), 'optionsflow');
  assert.equal(strategyIdFor('ghost'), 'ghost');       // no entry needed when ids match
  assert.equal(strategyIdFor('biotech'), 'biotech');
});

test('every grade in the app vocabulary has a plain-English face and advice', () => {
  // Arrange — mirrors lib/maturity GRADE_META; a new grade must not render blank.
  const { GRADE, verdictFor } = loadBadge();

  // Act / Assert
  for (const g of ['validated', 'promising', 'experimental', 'informational', 'disabled']) {
    assert.ok(GRADE[g], `${g} has no face`);
    assert.ok(GRADE[g].label && GRADE[g].icon && GRADE[g].lead, `${g} face is incomplete`);
    const v = verdictFor({ id: 'x', grade: g });
    assert.ok(v.advice.length > 0, `${g} has no advice line`);
  }
});

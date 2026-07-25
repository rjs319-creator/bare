'use strict';
// Pure helpers behind the ⚡ Events (CERN) novice view (public/js/cern.js).
//
// The view's job is to stop a beginner reading "Target +18%" and acting on it without
// seeing the −38% stop sitting next to it. rewardRisk is what makes that visible, so
// its arithmetic — especially on the short side — is worth pinning down.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadCernView() {
  const src = fs.readFileSync(path.join(__dirname, '../public/js/cern.js'), 'utf8')
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '');
  const factory = new Function('esc', 'fetchJSON', 'OPTIONAL_TIMEOUT_MS', 'module',
    `${src}\nmodule.exports = { rewardRisk, eventName };`);
  const mod = { exports: {} };
  factory(x => x, async () => null, 0, mod);
  return mod.exports;
}

test('rewardRisk: flags the live BLLN plan as risking more than it stands to make', () => {
  // Arrange — the real TRADE card: +18% target against a −38% stop.
  const { rewardRisk } = loadCernView();
  const plan = { side: 'long', entry: 103.95, target: 122.88, stop: 63.96 };

  // Act
  const rr = rewardRisk(plan);

  // Assert — under 1:1, which is what the card must warn about.
  assert.ok(rr.ratio < 1, `expected a sub-1 ratio, got ${rr.ratio}`);
  assert.equal(Math.round(rr.rewardPct), 18);
  assert.equal(Math.round(rr.riskPct), 38);
});

test('rewardRisk: a healthy long plan reports a ratio above 1', () => {
  // Arrange — target 20 above, stop 5 below.
  const { rewardRisk } = loadCernView();

  // Act
  const rr = rewardRisk({ side: 'long', entry: 100, target: 120, stop: 95 });

  // Assert
  assert.equal(rr.ratio, 4);
  assert.equal(rr.rewardPct, 20);
  assert.equal(rr.riskPct, 5);
});

test('rewardRisk: short plans invert correctly (target below entry, stop above)', () => {
  // Arrange — a fade: sell at 100, cover at 90, stop out at 105.
  const { rewardRisk } = loadCernView();

  // Act
  const rr = rewardRisk({ side: 'short', entry: 100, target: 90, stop: 105 });

  // Assert — 10 of reward against 5 of risk.
  assert.equal(rr.ratio, 2);
  assert.equal(rr.rewardPct, 10);
  assert.equal(rr.riskPct, 5);
});

test('rewardRisk: an incoherent or incomplete plan yields no ratio rather than a wrong one', () => {
  // Arrange
  const { rewardRisk } = loadCernView();

  // Act / Assert — missing levels, and a "target" the wrong side of entry.
  assert.equal(rewardRisk({ side: 'long', entry: 100, target: null, stop: 90 }), null);
  assert.equal(rewardRisk({ side: 'long', entry: 100, target: 120, stop: null }), null);
  assert.equal(rewardRisk({ side: 'long', entry: 100, target: 95, stop: 90 }), null);
  assert.equal(rewardRisk({ side: 'long', entry: 100, target: 120, stop: 100 }), null);
});

test('eventName: every raw event enum has a plain-English name', () => {
  // Arrange — the seven types in lib/cern.js EVENT_TYPES.
  const { eventName } = loadCernView();
  const TYPES = ['INDEX_DELETE', 'INDEX_ADD_FADE', 'LOCKUP_EXPIRY', 'TAX_LOSS', 'FIRE_SALE', 'MARGIN_SPIRAL', 'FORCED_DOWNGRADE'];

  // Act / Assert — no SCREAMING_SNAKE ever reaches the page.
  for (const t of TYPES) {
    const name = eventName(t);
    assert.doesNotMatch(name, /_/, `${t} still renders as a raw enum`);
    assert.notEqual(name, t);
  }
  // An unknown type degrades to something readable rather than throwing.
  assert.equal(eventName('SOME_NEW_TYPE'), 'some new type');
});

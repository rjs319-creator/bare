'use strict';
// THE REGIME LATCH LIVED IN localStorage (alpha-research pass 3).
//
// The Apex tab debounced the market regime in the BROWSER: a 3-refresh hysteresis
// counter persisted as `localStorage.apexRegime`, gating tier assignment (apexTier caps
// apex/loaded → watch in RISK_OFF) and dropping names (apexRegimeFilter). Two real
// consequences:
//   • two browsers could show DIFFERENT tiers for the same stock at the same instant;
//   • the hysteresis advanced per REFRESH, so the switch speed depended on how often the
//     user opened the tab.
// The brief states that regime state cannot live only in browser storage.
//
// The latch is now a pure server-side function of SPY's dated history.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../lib/swing-screener-engine');
const S = require('../lib/screener');

const COHORT = [{ above50: true }, { above50: true }];
// A long uptrend (well above the 200-DMA) followed by a decisive break below it.
function spySeries(nAbove, nBelow) {
  const out = []; let px = 100;
  for (let i = 0; i < nAbove; i++) { px *= 1.0015; out.push({ date: 'd' + i, close: px }); }
  for (let i = 0; i < nBelow; i++) { px *= 0.972; out.push({ date: 'x' + i, close: px }); }
  return out;
}
const regimeAt = (nBelow) => E.computeRegime(COHORT, spySeries(260, nBelow), S);

test('the payload carries a server-computed active regime alongside the raw read', () => {
  const r = regimeAt(0);
  assert.equal(typeof r.active, 'string');
  assert.equal(typeof r.raw, 'string');
  assert.ok(r.latch && r.latch.holdSessions >= 2, 'the hold requirement is disclosed');
  assert.match(r.latch.basis, /session-debounced server-side/);
});

test('a fresh flip does NOT take effect until it has held the required sessions', () => {
  // This is the hysteresis, now measured in market sessions rather than page views.
  const early = regimeAt(6);
  assert.equal(early.raw, 'RISK_OFF', 'today reads risk-off');
  assert.equal(early.active, 'RISK_ON', 'but the latch has not switched yet');
});

test('once the flip HAS held, the active regime switches', () => {
  const held = regimeAt(7);
  assert.equal(held.raw, 'RISK_OFF');
  assert.equal(held.active, 'RISK_OFF');
  assert.equal(held.latch.sessionsAgo, 0, 'the held run reaches the newest session');
});

test('the latch is DETERMINISTIC — same input, same answer, every time and every client', () => {
  // The defect was that the answer depended on per-browser counters. Purity is the fix.
  const a = regimeAt(7), b = regimeAt(7), c = regimeAt(7);
  assert.equal(a.active, b.active);
  assert.equal(b.active, c.active);
  assert.equal(a.latch.sessionsAgo, c.latch.sessionsAgo);
});

test('it does not depend on how often the value is computed', () => {
  // Calling it ten times must not advance anything — the old counter did exactly that.
  const first = regimeAt(6).active;
  for (let i = 0; i < 10; i++) regimeAt(6);
  assert.equal(regimeAt(6).active, first, 'repeated evaluation must not advance the latch');
});

test('a sustained uptrend stays RISK_ON', () => {
  const r = regimeAt(0);
  assert.equal(r.active, 'RISK_ON');
});

test('missing benchmark history yields no regime rather than a fabricated one', () => {
  assert.equal(E.computeRegime(COHORT, [], S), null);
  assert.equal(E.computeRegime(COHORT, null, S), null);
});

// ── the client must consume it, and must not keep its own ────────────────────────

test('the Apex tab reads the server regime and no longer latches in localStorage', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(app, /function apexActiveRegime\(rg\)/);
  assert.match(app, /rg\.active/, 'it must read the server-computed field');
  assert.match(app, /const regime = apexActiveRegime\(large\.regime\)/,
    'the render path must use it');

  // The browser latch is gone: no writer, no counter, no stale-heal timer.
  assert.ok(!/localStorage\.setItem\('apexRegime'/.test(app), 'must not persist a regime latch');
  assert.ok(!/function apexAdvanceState/.test(app), 'the refresh counter must be gone');
  assert.ok(!/function apexLoadState/.test(app), 'the latch reader must be gone');
  // ...and the old key is actively cleared so a stale value cannot be mistaken for state.
  assert.match(app, /localStorage\.removeItem\('apexRegime'\)/);
});

test('no regime value that DRIVES a decision is written to browser storage', () => {
  // The brief forbids regime state living only client-side. The distinction that matters
  // is whether the value GATES anything:
  //   • forbidden — a latch that changes tier assignment or filters candidates, because
  //     then two browsers rank the same stock differently (the defect just fixed);
  //   • allowed — a pure VIEW filter over statistics the server already computed.
  //
  // `sbRegime` is the second kind: it selects which slice of the Scoreboard's own
  // server-computed `byRegime` stats to display (app.js: `g.byRegime[sbRegime]`). It
  // changes no ranking, no tier and no candidate set — it is a reader's preference about
  // which numbers to look at, and it is correct for that to be per-device.
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const VIEW_FILTER_KEYS = new Set(['sbRegime']);
  const writes = [...app.matchAll(/localStorage\.setItem\('([^']+)'/g)].map(m => m[1]);
  const offenders = writes.filter(k => /regime/i.test(k) && !VIEW_FILTER_KEYS.has(k));
  assert.deepEqual(offenders, [],
    `a decision-driving regime value must not be persisted client-side: ${offenders.join(',')}`);

  // And the allowance is only valid while sbRegime stays a view filter — if it ever
  // starts gating, this pins the fact that it must be re-examined.
  assert.match(app, /g\.byRegime && g\.byRegime\[sbRegime\]/,
    'sbRegime must remain a selector over server-computed byRegime stats');
});

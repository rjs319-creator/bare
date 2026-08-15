'use strict';
// CORE PERFORMANCE surface guard — the since-inception headline must be the daily
// mark-to-market NAV, the resolved-only compound may survive only as a relabeled
// diagnostic, and a missing mark must render as an explicit fail-closed gap.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('the headline is the portfolio NAV, not the resolved-only compound', () => {
  const app = read('public/js/app.js');
  assert.match(app, /SINCE INCEPTION — PORTFOLIO NAV \(marked daily, cost-net\)/);
  assert.doesNotMatch(app, /SINCE INCEPTION \(realized\)/, 'the old resolved-only headline label must not come back');
});

test('the resolved-only compound survives only as a clearly relabeled diagnostic', () => {
  const app = read('public/js/app.js');
  assert.match(app, /RESOLVED-ONLY COMPOUND \(diagnostic — ignores open positions\)/);
  assert.match(app, /never a compound of partial-quarter resolved-only averages/);
});

test('missing marks render as an explicit fail-closed message, never silently', () => {
  const app = read('public/js/app.js');
  assert.match(app, /Portfolio NAV unavailable \(fail-closed\)/);
  assert.match(app, /NAV coverage gap \(fail-closed\)/);
  assert.match(app, /withheld, never guessed/);
});

test('the three lanes are named and kept separate in the UI', () => {
  const app = read('public/js/app.js');
  assert.match(app, /resolved-trade avg/);
  assert.match(app, /open-position MTM avg/);
  assert.match(app, /portfolio NAV return/);
});

test('the route wires the NAV ledger and withholds NAV over the fetch budget instead of serving partial coverage', () => {
  const routes = read('lib/stablecore-routes.js');
  assert.match(routes, /require\('\.\/nav-ledger'\)/);
  assert.match(routes, /buildNavLedger\(signals, resolved, histories/);
  assert.match(routes, /NAV withheld rather than computed on partial coverage/);
});

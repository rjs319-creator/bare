'use strict';
// 2026-09-20 simplification: five destinations, a curated Simple-mode tab set, and
// legacy top-level keys redirected so old bookmarks / localStorage keep working.
// Source-string pins over app.js + index.html (the nav is static HTML + a JS literal).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const TOP = ['home', 'trade', 'markets', 'proof', 'lab'];
const SIMPLE = ['today', 'session', 'daytrade', 'ignitionlive', 'screener', 'swingsup', 'tech-command', 'rotation', 'news', 'pulse', 'scoreboard', 'evidence'];

function tabGroups() {
  const m = APP.match(/const TAB_GROUPS = \{([\s\S]*?)\n  \};/);
  assert.ok(m, 'TAB_GROUPS literal found');
  const groups = {};
  for (const line of m[1].split('\n')) {
    const g = line.match(/^\s*([a-z]+):\s*\[(.*)\],?\s*$/);
    if (g) groups[g[1]] = [...g[2].matchAll(/'([^']+)'/g)].map(x => x[1]);
  }
  return groups;
}

test('TAB_GROUPS has exactly the five destinations, in order', () => {
  assert.deepStrictEqual(Object.keys(tabGroups()), TOP);
});

test('every legacy top-level key is redirected and no longer a group', () => {
  const groups = tabGroups();
  for (const old of ['candidates', 'positions', 'tech', 'predict']) assert.ok(!groups[old], `${old} is gone`);
  assert.match(APP, /const LEGACY_TOP = \{ candidates: 'trade', positions: 'trade', tech: 'trade', predict: 'markets' \}/);
  assert.match(APP, /if \(LEGACY_TOP\[id\]\) id = LEGACY_TOP\[id\];/, 'showTab redirects legacy ids');
  assert.match(APP, /if \(LEGACY_TOP\[h\]\) return LEGACY_TOP\[h\];/, 'initial hash redirects legacy ids');
});

test('SIMPLE_TABS is the curated twelve and every member is a registered section', () => {
  const m = APP.match(/const SIMPLE_TABS = new Set\(\[(.*?)\]\);/);
  assert.ok(m, 'SIMPLE_TABS literal found');
  const simple = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  assert.deepStrictEqual(simple, SIMPLE);
  const all = Object.values(tabGroups()).flat();
  for (const id of simple) assert.ok(all.includes(id), `${id} registered in TAB_GROUPS`);
  // No Simple-mode tab lives in the Research Lab (the lab link is hidden in Simple).
  for (const id of simple) assert.ok(!tabGroups().lab.includes(id), `${id} not in lab`);
});

test('nothing was dropped from the nav registry: every section in index.html is still routable', () => {
  const all = new Set(Object.values(tabGroups()).flat());
  const sections = [...HTML.matchAll(/<section\b[^>]*>/g)]
    .map(x => x[0])
    .filter(tag => /class="[^"]*\bscreener-section\b/.test(tag))
    .map(tag => (tag.match(/\bid="([^"]+)"/) || [])[1])
    .filter(Boolean);
  assert.ok(sections.length >= 40, `sections found: ${sections.length}`);
  for (const id of sections) assert.ok(all.has(id), `section #${id} still in TAB_GROUPS (deep links + palette)`);
});

test('the sub-nav filters by mode and each group opens on a visible tab', () => {
  assert.match(APP, /const isTabVisible = s => !isSimpleMode\(\) \|\| SIMPLE_TABS\.has\(s\);/);
  assert.match(APP, /\.filter\(s => isTabVisible\(s\) \|\| s === sub\)/, 'renderHubSubnav keeps the active hidden tab visible');
  assert.match(APP, /const defaultSubOf = top =>/);
  assert.match(APP, /hubSub = \{ home: 'today', trade: 'daytrade', markets: 'rotation', proof: 'scoreboard', lab: 'events' \}/);
});

test('all three static navs carry exactly the five destinations', () => {
  for (const nav of ['header-nav', 'mobile-top-tabs', 'mobile-bottom-nav']) {
    const block = HTML.match(new RegExp(`<nav class="${nav}"[\\s\\S]*?</nav>`));
    assert.ok(block, `${nav} present`);
    const tabs = [...block[0].matchAll(/data-tab="([a-z]+)"/g)].map(x => x[1]);
    assert.deepStrictEqual(tabs, TOP, `${nav} destinations`);
  }
});

test('the Scoreboard is fetched lazily on first open, not at boot', () => {
  assert.match(APP, /function ensureScoreboard\(\)/);
  assert.match(APP, /sub === 'scoreboard' && typeof ensureScoreboard === 'function'/);
  assert.doesNotMatch(APP, /addEventListener\('click', fetchScoreboard\);\n  fetchScoreboard\(\);/, 'no eager boot fetch');
});

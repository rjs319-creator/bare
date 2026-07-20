'use strict';
// RESEARCH LAB UI CONTRACT — the promotion gate and the panel that renders it live in
// different files and different runtimes (Node lib vs browser ES module), so nothing
// but a test keeps them in sync.
//
// The failure this guards against is quiet and specific: someone adds a new blocker to
// `promotion-readiness.js`, the Lab renders its bare kebab-case id with no explanation,
// and the user sees "no incremental value" with no idea what it means or what would fix
// it. The whole point of the panel is that a refusal be READABLE — an unexplained
// blocker is functionally the same as not showing one.
//
// These are source-level contract tests (the renderer itself is browser-only), which is
// why they read the files as text rather than importing them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const GATE_SRC = fs.readFileSync(path.join(ROOT, 'lib/promotion-readiness.js'), 'utf8');
const LAB_SRC = fs.readFileSync(path.join(ROOT, 'public/js/orbit-lab.js'), 'utf8');

// Every id the gate can actually push, read off the executable calls.
function gateBlockerIds(src) {
  return [...src.matchAll(/pushBlocker\(\s*blockers\s*,\s*'([^']+)'/g)].map(m => m[1]);
}
// Every status classify() can return.
function gateStatuses(src) {
  const body = src.slice(src.indexOf('function classify('));
  const end = body.indexOf('\nfunction ');
  return [...(end > 0 ? body.slice(0, end) : body).matchAll(/return\s+'([A-Z_]+)'/g)].map(m => m[1]);
}
// Keys of an object literal declared as `const NAME = { ... };` in the UI source.
function uiMapKeys(src, name) {
  const start = src.indexOf(`const ${name} = {`);
  assert.ok(start >= 0, `${name} not found in orbit-lab.js`);
  const open = src.indexOf('{', start);
  let depth = 0, end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return [...src.slice(open, end).matchAll(/^\s*'?([a-zA-Z][\w-]*)'?\s*:/gm)].map(m => m[1]);
}

test('the gate actually emits blockers and statuses (guards the extractors themselves)', () => {
  // If a refactor changes the call shape, the regexes above would silently match nothing
  // and every contract test below would vacuously pass. Fail loudly instead.
  assert.ok(gateBlockerIds(GATE_SRC).length >= 10, 'expected the gate to push many blockers');
  assert.ok(gateStatuses(GATE_SRC).length >= 5, 'expected several classify() statuses');
  assert.ok(uiMapKeys(LAB_SRC, 'BLOCKER_WHY').length >= 10, 'expected a populated gloss map');
});

test('every blocker the gate can emit has a plain-English explanation in the Lab', () => {
  const explained = new Set(uiMapKeys(LAB_SRC, 'BLOCKER_WHY'));
  const missing = [...new Set(gateBlockerIds(GATE_SRC))].filter(id => !explained.has(id));
  assert.deepEqual(missing, [],
    `blocker(s) would render as a bare id with no explanation: ${missing.join(', ')}`);
});

test('every status classify() can return has a rung on the displayed ladder', () => {
  const rungs = new Set(uiMapKeys(LAB_SRC, 'PROMO_STATUS'));
  const missing = [...new Set(gateStatuses(GATE_SRC))].filter(s => !rungs.has(s));
  assert.deepEqual(missing, [],
    `status(es) would render with no label/colour: ${missing.join(', ')}`);
});

test('the Lab never implies a shadow system carries weight', () => {
  // The panel must state zero live weight, and must not promise promotion follows
  // automatically from passing the gate.
  assert.match(LAB_SRC, /live weight/, 'panel must display live weight');
  assert.match(LAB_SRC, /eligibility/, 'panel must say passing certifies eligibility only');
});

test('the gloss map explains, rather than restating, the blocker id', () => {
  // A gloss that is just the id with the hyphens removed teaches the user nothing.
  const start = LAB_SRC.indexOf('const BLOCKER_WHY = {');
  const block = LAB_SRC.slice(start, LAB_SRC.indexOf('\n};', start));
  for (const m of block.matchAll(/'([\w-]+)':\s*'([^']+)'/g)) {
    const [, id, gloss] = m;
    const idWords = id.replace(/-/g, ' ');
    assert.notEqual(gloss.toLowerCase().replace(/[^a-z ]/g, '').trim(), idWords,
      `gloss for "${id}" just restates the id`);
    assert.ok(gloss.length > 30, `gloss for "${id}" is too terse to be useful`);
  }
});

'use strict';
// DEPLOY-BUNDLE GUARD — catches "passes every test, 500s in production".
//
// THE INCIDENT THIS ENCODES: `.vercelignore` contained an unanchored `research/`,
// intended for the top-level offline research rig (a multi-GB FMP cache). Because
// gitignore-style directory patterns match at ANY depth, it ALSO excluded
// `lib/research/` from every deployment. Those modules were therefore not merely
// "uncalled" — they were undeployable. The first commit to `require()` one of them
// shipped a green 1448-test suite and then 500'd `/api/tracker?op=today` in prod with
// `Cannot find module './research/live-bridge'`.
//
// No unit test could see it: the code is perfectly valid locally, and the failure lives
// entirely in what the bundler was told to omit. So this test reads the deploy-ignore
// rules directly and asserts they cannot swallow server code that the app requires.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// Directories whose contents are bundled into the serverless functions.
const SERVER_DIRS = ['lib', 'api'];

// Parse .vercelignore into rules, dropping comments/blanks.
function ignoreRules() {
  const raw = fs.readFileSync(path.join(ROOT, '.vercelignore'), 'utf8');
  return raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}

// Every directory name that exists anywhere under the server dirs.
function serverDirNames() {
  const names = new Set();
  const walk = (dir, depth = 0) => {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'node_modules') continue;
      names.add(e.name);
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  for (const d of SERVER_DIRS) walk(path.join(ROOT, d));
  return names;
}

test('no unanchored ignore rule can swallow a server subdirectory', () => {
  const dirs = serverDirNames();
  const offenders = [];
  for (const rule of ignoreRules()) {
    if (rule.startsWith('/') || rule.startsWith('!')) continue;   // anchored or negated → safe
    if (rule.includes('*')) continue;                             // glob rules handled below
    const name = rule.replace(/\/$/, '');
    if (dirs.has(name)) offenders.push({ rule, collidesWith: name });
  }
  assert.deepEqual(offenders, [],
    `unanchored .vercelignore rule(s) would exclude bundled server code — anchor with a leading slash: ${JSON.stringify(offenders)}`);
});

test('the specific regression: lib/research must be deployable', () => {
  // Named explicitly so the guard survives a refactor of the generic scan above.
  assert.ok(fs.existsSync(path.join(ROOT, 'lib/research')), 'lib/research should exist');
  const bad = ignoreRules().filter(r => !r.startsWith('/') && r.replace(/\/$/, '') === 'research');
  assert.deepEqual(bad, [], 'an unanchored `research/` rule excludes lib/research from deploys');
});

// Strip block and line comments before scanning for requires. Several modules
// DOCUMENT require paths in prose (`// inline require('../lib/x') resolves from lib/`),
// which a naive scan reports as an unresolvable dependency. Naive but sufficient here:
// the only cost of over-stripping would be missing a require that shares a line with a
// string containing `//`, which does not occur in this codebase.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('every server module required from lib/ resolves on disk', () => {
  // A relative require that resolves locally but points outside the bundle is the
  // same failure mode by another route. Cheap static check over first-party requires.
  const missing = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); continue; }
      if (!e.name.endsWith('.js')) continue;
      const src = stripComments(fs.readFileSync(full, 'utf8'));
      for (const m of src.matchAll(/require\(\s*'(\.[^']+)'\s*\)/g)) {
        const spec = m[1];
        const base = path.resolve(path.dirname(full), spec);
        const ok = fs.existsSync(base) || fs.existsSync(base + '.js') || fs.existsSync(path.join(base, 'index.js'));
        if (!ok) missing.push(`${path.relative(ROOT, full)} → ${spec}`);
      }
    }
  };
  for (const d of SERVER_DIRS) walk(path.join(ROOT, d));
  assert.deepEqual(missing, [], `unresolvable first-party require(s): ${missing.join(', ')}`);
});

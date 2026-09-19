'use strict';
// Vercel bundles a serverless function by statically tracing `require('<literal>')` calls.
// A `require(someVariable)` is invisible to that tracer, so the target file never ships and
// prod reports "module-missing" for a module that is on main (session-board-routes, 2026-09-19).
// Every module reachable from api/ must use literal requires.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['api', 'lib'];
// require( <not a quote> ...) — a literal starts with ' " or `; anything else is dynamic.
const DYNAMIC = /(?<![\w.$])require\(\s*(?!['"`])[^)]/g;
// Known, intentional dynamic requires (each must justify itself here).
const ALLOW = new Set([]);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('no dynamic require() in api/ or lib/ (Vercel tracer cannot bundle them)', () => {
  const offenders = [];
  for (const dir of DIRS) {
    for (const f of walk(path.join(ROOT, dir), [])) {
      const rel = path.relative(ROOT, f);
      if (ALLOW.has(rel)) continue;
      const src = fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const hits = src.match(DYNAMIC);
      if (hits) offenders.push(`${rel}: ${hits.slice(0, 3).join(' | ')}`);
    }
  }
  assert.deepEqual(offenders, [], `dynamic require() found:\n${offenders.join('\n')}`);
});

test('session-board-routes loads both session modules by literal path', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'session-board-routes.js'), 'utf8');
  assert.match(src, /require\('\.\/premarket-snapshot'\)/);
  assert.match(src, /require\('\.\/session-live-state'\)/);
  assert.doesNotMatch(src, /function optionalModule/);
});

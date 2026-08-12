'use strict';
// `npm run check` VALIDATED 10 OF 598 FILES (alpha-research pass 3).
//
// `node --check` parses only its FIRST argument and silently ignores the rest. The old
// script was a chain of `node --check <glob>` calls, so each glob contributed exactly
// one validated file — `lib/*.js` checked `adaptive-layers.js` and skipped the other
// 487. A syntax error anywhere else shipped green.
//
// Demonstrated:
//   node --check ok.js broken.js  -> exit 0   (broken file never read)
//   node --check broken.js ok.js  -> exit 1
//
// This matters beyond syntax: CI runs `npm run check` before auto-deploying to
// production on every push to main, so the pre-deploy gate was ~1.7% effective.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const CHECK = pkg.scripts.check;

test('node --check really does ignore every argument after the first', () => {
  // Pin the underlying Node behaviour this test exists because of. If a future Node
  // release fixes it, this test fails loudly and the guard below can be reconsidered
  // rather than silently becoming cargo cult.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkprobe-'));
  const ok = path.join(dir, 'ok.js');
  const bad = path.join(dir, 'bad.js');
  fs.writeFileSync(ok, 'const a = 1;\n');
  fs.writeFileSync(bad, 'function ( broken {{{\n');

  let firstArgOnly = false;
  try {
    execFileSync(process.execPath, ['--check', ok, bad], { stdio: 'ignore' });
    firstArgOnly = true; // exited 0 despite a broken second argument
  } catch { /* would mean Node now checks all args */ }

  assert.equal(firstArgOnly, true,
    'node --check reads only argv[1]; the check script must invoke it once per file');

  // ...and it does fail when the broken file is first, proving the file is genuinely bad.
  assert.throws(() => execFileSync(process.execPath, ['--check', bad, ok], { stdio: 'ignore' }));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the check script invokes node --check once per file', () => {
  assert.match(CHECK, /xargs\s+-0\s+-n1/,
    'must pipe through `xargs -n1` so each file is its own invocation');
  assert.ok(!/node --check \S*\*\.js/.test(CHECK),
    'a `node --check <glob>` argument list validates only the glob\'s first file');
});

test('the check script covers whole trees, not a hand-maintained directory list', () => {
  // The previous script enumerated eight lib/ subdirectories by hand, so a ninth would
  // have shipped unchecked. `find` removes that failure mode entirely.
  assert.match(CHECK, /find api lib public\/js scripts/,
    'api, lib, public/js and scripts must all be swept');
  assert.match(CHECK, /-not -path '\*\/node_modules\/\*'/, 'node_modules must be excluded');
});

test('every lib subdirectory is reached by the sweep', () => {
  const subdirs = fs.readdirSync(path.join(ROOT, 'lib'), { withFileTypes: true })
    .filter(d => d.isDirectory()).map(d => d.name);
  assert.ok(subdirs.length > 0, 'fixture sanity: lib has subdirectories');
  // `find lib` is recursive, so this is structural rather than enumerated — the
  // assertion is that we did NOT go back to naming directories one by one.
  for (const d of subdirs) {
    assert.ok(!CHECK.includes(`lib/${d}/*.js`),
      `lib/${d} must be covered by the recursive sweep, not a hand-written glob`);
  }
});

test('the frontend is no longer exempt', () => {
  // public/js was never checked at all — 36 files including the ~10k-line app.js.
  const frontend = fs.readdirSync(path.join(ROOT, 'public', 'js')).filter(f => f.endsWith('.js'));
  assert.ok(frontend.length > 10, 'fixture sanity: public/js has many modules');
  assert.match(CHECK, /public\/js/);
});

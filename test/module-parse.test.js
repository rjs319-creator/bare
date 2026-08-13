'use strict';
// MODULE-parse every frontend file. The 2026-08-13 Today-tab outage: a stray backtick
// in public/js/app.js broke it as an ES MODULE — the browser threw "Unexpected token
// '<'" at load and every tab hung on its spinner — while `npm run check`'s script-mode
// `node --check` passed. Script-mode and module-mode parse differently; the browser
// only ever uses module mode, so the gate must too.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('every public/js file parses as an ES module (the mode the browser uses)', () => {
  const dir = path.join(__dirname, '../public/js');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  assert.ok(files.length > 20, 'expected the frontend module set');
  const failures = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f));
    const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: src });
    if (r.status !== 0) failures.push(`${f}: ${String(r.stderr).split('\n').slice(0, 2).join(' ')}`);
  }
  assert.deepEqual(failures, [], `module-parse failures:\n${failures.join('\n')}`);
});

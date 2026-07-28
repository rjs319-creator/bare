'use strict';
// The source dump is what external reviews read — if the generator silently drops
// files, a review can "audit" a codebase missing whole subsystems (a 17-file
// subsystem once vanished this way because `git ls-files` excludes untracked
// files). These tests run the real generator in a scratch checkout and pin:
//   1. an UNTRACKED file matching a source glob IS included;
//   2. an oversized file is excluded from the body but DISCLOSED with its hash;
//   3. env/secret-style files never enter the dump.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const GENERATOR = path.join(__dirname, '../scripts/gen-full-source.js');

// A minimal throwaway git repo shaped like the app (api/lib/scripts dirs).
function scratchRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gensrc-'));
  const run = (cmd) => cp.execSync(cmd, { cwd: dir, stdio: 'pipe' });
  run('git init -q');
  run('git config user.email t@t && git config user.name t');
  for (const d of ['api', 'lib', 'scripts', 'test', 'public/js', 'public/css']) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"scratch"}\n');
  fs.writeFileSync(path.join(dir, 'vercel.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'public/index.html'), '<!-- x -->\n');
  fs.writeFileSync(path.join(dir, 'public/sw.js'), '// sw\n');
  fs.writeFileSync(path.join(dir, 'lib/tracked.js'), '// tracked module\n');
  // The generator resolves ROOT from its own location, so copy it into the
  // scratch repo and run it from there.
  fs.copyFileSync(GENERATOR, path.join(dir, 'scripts/gen-full-source.js'));
  run('git add -A && git commit -qm init');
  return { dir, run };
}

test('generator includes tracked, untracked and oversized-disclosed files correctly', () => {
  const { dir } = scratchRepo();
  try {
    // Arrange — one untracked source file, one oversized file, one secret-style file.
    fs.writeFileSync(path.join(dir, 'lib/untracked-new-module.js'), '// brand new, not yet git-added\n');
    fs.writeFileSync(path.join(dir, 'public/js/huge.js'), '// big\n' + 'x'.repeat(260 * 1000));
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET_TOKEN=hunter2\n');
    fs.writeFileSync(path.join(dir, 'lib/.env.local'), 'SECRET_TOKEN=hunter2\n');

    // Act
    cp.execSync('node scripts/gen-full-source.js', { cwd: dir, stdio: 'pipe' });
    const dump = fs.readFileSync(path.join(dir, 'APP-FULL-SOURCE.md'), 'utf8');

    // Assert — untracked source is present in index AND body.
    assert.match(dump, /^- lib\/untracked-new-module\.js$/m, 'untracked source file missing from index');
    assert.match(dump, /brand new, not yet git-added/, 'untracked source body missing');
    // Tracked source still present.
    assert.match(dump, /^- lib\/tracked\.js$/m);
    // Oversized: not in the index/body, but disclosed with size and sha256.
    assert.ok(!/^- public\/js\/huge\.js$/m.test(dump), 'oversized file must not be in the file index');
    assert.match(dump, /public\/js\/huge\.js — [\d,]+ bytes .* — sha256 [0-9a-f]{64}/, 'oversized exclusion must be disclosed with hash');
    // Secrets: structurally excluded (globs never match dotfiles).
    assert.ok(!dump.includes('hunter2'), 'secret values must never enter the dump');
    assert.ok(!dump.includes('.env'), 'env files must never be listed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the exclusion manifest is honest when nothing is oversized', () => {
  const { dir } = scratchRepo();
  try {
    cp.execSync('node scripts/gen-full-source.js', { cwd: dir, stdio: 'pipe' });
    const dump = fs.readFileSync(path.join(dir, 'APP-FULL-SOURCE.md'), 'utf8');
    assert.match(dump, /## Intentionally excluded \(oversized\)\n\n- \(none\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

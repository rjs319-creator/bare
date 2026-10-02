'use strict';
// .github/workflows/nightly-chains.yml — the warm root chains as a GitHub Actions matrix.
// The matrices are GENERATED from lib/warm-chains.js; this pins them (and the workflow's
// load-bearing knobs) so the two can never drift.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const WC = require('../lib/warm-chains');
const GEN = require('../scripts/gen-nightly-matrix');

const WF = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'nightly-chains.yml'), 'utf8');

test('matrix: spine ∪ chains == ROOT_CHAINS, in order, with ledger alone in the spine', () => {
  const spine = GEN.extractMatrix(WF, 'spine');
  const chains = GEN.extractMatrix(WF, 'chains');
  assert.deepEqual(spine, ['ledger']);
  assert.deepEqual([...spine, ...chains], WC.ROOT_CHAINS);
  // No nested chain (reached via @ from its parent) may be a matrix job of its own.
  const roots = new Set(WC.ROOT_CHAINS);
  for (const c of chains) assert.ok(roots.has(c), `${c} is not a root`);
});

test('matrix: the generator reports the workflow current (--check), and would rewrite a drifted file identically', () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'gen-nightly-matrix.js'), '--check'], { encoding: 'utf8' });
  assert.match(out, /current/);
  const drifted = GEN.applyGenerated(WF, 'chains', ['capture']);
  assert.notEqual(drifted, WF);
  assert.equal(GEN.render(drifted), WF, 'render restores the pinned list and indentation');
  assert.throws(() => GEN.applyGenerated('jobs: {}', 'spine', ['x']), /missing the generated block/);
});

test('workflow knobs: 22:05 UTC + three retry schedules (same ET session), fail-fast off, max-parallel 4, 6-minute jobs, ordered spine, always-on summary', () => {
  assert.match(WF, /cron: '5 22 \* \* \*'/, 'runs after the 22:00 UTC Vercel cron has warmed the caches');
  // Retry schedules: GitHub delays this repo's schedules by hours (2026-10-02). Every one must
  // land before 04:00 UTC so lib/chain-summary.js keys it to the same ET session date.
  const crons = [...WF.matchAll(/- cron: '(\d+) (\d+) \* \* \*'/g)].map((m) => ({ min: +m[1], hour: +m[2] }));
  assert.deepEqual(crons, [{ min: 5, hour: 22 }, { min: 40, hour: 22 }, { min: 20, hour: 23 }, { min: 0, hour: 1 }]);
  for (const c of crons) assert.ok(c.hour >= 22 || c.hour < 4, `${c.hour}:${c.min} UTC would be the next ET session date`);
  assert.equal((WF.match(/\n      fail-fast: false\n/g) || []).length, 2, 'both chain jobs keep going when one root fails');
  assert.match(WF, /max-parallel: 4/);
  assert.equal((WF.match(/\n    timeout-minutes: 6\n/g) || []).length, 2, 'both chain jobs are capped at 6 minutes');
  assert.match(WF, /\n  chains:\n    needs: \[preflight, spine\]\n    if: \$\{\{ !cancelled\(\) && needs\.preflight\.outputs\.skip != 'true' \}\}/, 'the rest waits for the decision spine, survives its failure, and skips a covered night');
  assert.match(WF, /\n  summary:[\s\S]*needs: \[preflight, spine, chains\]\n    if: \$\{\{ always\(\) && needs\.preflight\.outputs\.skip != 'true' \}\}/, 'the summary records cancelled/timed-out jobs too, unless the night was skipped');
  assert.match(WF, /run: node scripts\/run-nightly-chain\.js "\$\{\{ matrix\.chain \}\}"/);
  assert.match(WF, /run: node scripts\/nightly-chains-summary\.js/);
  assert.match(WF, /pattern: chain-\*/); assert.match(WF, /merge-multiple: true/);
  assert.match(WF, /concurrency:\n  group: nightly-chains\n  cancel-in-progress: false/);
  assert.match(WF, /workflow_dispatch:/);
});

test('preflight job: idempotence gate — needs nothing, fails open, feeds skip/already_ok to every chain job', () => {
  assert.match(WF, /\n  preflight:\n(?:(?!\n  \w).)*?outputs:\n      skip: \$\{\{ steps\.probe\.outputs\.skip \}\}\n      already_ok: \$\{\{ steps\.probe\.outputs\.already_ok \}\}/s);
  assert.match(WF, /run: node scripts\/nightly-chains-preflight\.js/);
  assert.match(WF, /\n  spine:\n    needs: preflight\n    if: \$\{\{ !cancelled\(\) && needs\.preflight\.outputs\.skip != 'true' \}\}/, 'a failed preflight (!cancelled) still runs the night');
  assert.equal((WF.match(/ALREADY_OK: \$\{\{ needs\.preflight\.outputs\.already_ok \}\}/g) || []).length, 2, 'both chain jobs pass the already-ok set to the runner');
  assert.match(WF, /FORCE: \$\{\{ github\.event\.inputs\.force \}\}/);
  assert.match(WF, /\n      force:\n/, 'workflow_dispatch exposes force');
});

test('runner contract: bearer header against the single-chain endpoint, graceful skip without the secret', () => {
  const RUN = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-nightly-chain.js'), 'utf8');
  assert.match(RUN, /authorization: `Bearer \$\{secret\}`/);
  assert.match(RUN, /op=warmchain&name=/);
  assert.match(RUN, /CRON_SECRET repo secret not set/);
  assert.ok(require('../scripts/run-nightly-chain').REQUEST_TIMEOUT_MS + require('../scripts/run-nightly-chain').FAST_FAIL_MS + require('../scripts/run-nightly-chain').RETRY_DELAY_MS < 6 * 60 * 1000,
    'worst-case runner path must fit the 6-minute job timeout');
});

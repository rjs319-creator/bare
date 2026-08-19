'use strict';
// THE SCAN LOOP, EXECUTED THE WAY GITHUB EXECUTES IT.
//
// The polling scheduler's whole purpose is that one delivered trigger keeps scanning for
// ~55 minutes, so a transient 5xx costs one tick rather than the rest of the window. That
// property lives entirely in bash, which no other test in this repo runs — and it was
// broken on the first attempt in a way static reading did not reveal.
//
// GitHub invokes a `run:` block as `bash -e {0}`. Errexit is therefore ON before the
// script's own `set` line, and `set -uo pipefail` does not clear it. The first draft's
// `call` returned 1 on failure, so a single failed board tick aborted the entire loop:
// verified on the real runner log (`shell: /usr/bin/bash -e {0}`), then reproduced here —
// 1 iteration instead of 7. Testing with plain `bash` had shown 7 and hidden the bug.
//
// So this executes the ACTUAL script extracted from the workflow, under `bash -e`, with a
// stub curl on PATH. No network, no secrets, no GitHub.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const WF = path.join(__dirname, '..', '.github', 'workflows', 'daytrade-scan.yml');

// Pull the scan job's run: block out of the YAML without a yaml dependency: take the
// block scalar after the scan step's `run: |` and dedent it.
function scanScript() {
  const wf = fs.readFileSync(WF, 'utf8');
  const job = wf.slice(wf.indexOf('  scan:'), wf.indexOf('  postclose:'));
  const i = job.indexOf('run: |');
  assert.ok(i > 0, 'scan job has a run: block');
  const lines = job.slice(job.indexOf('\n', i) + 1).split('\n');
  const indent = (lines.find(l => l.trim()) || '').match(/^ */)[0].length;
  return lines.map(l => l.slice(indent)).join('\n');
}

// Run the script under `bash -e` (GitHub's shell) with a curl stub that fails whichever
// ops are named in failOps. Returns { code, out }.
function runLoop({ failOps = [], singlePass = false, loopSeconds = 6, tickSeconds = 1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanloop-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env bash
out=""; prev=""; url=""
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  case "$a" in http*) url="$a";; esac
  prev="$a"
done
code=200
for bad in ${failOps.join(' ')}; do
  case "$url" in *"$bad"*) code=503;; esac
done
[ -n "$out" ] && printf '{"ok":true}' > "$out"
printf '%s' "$code"
`, { mode: 0o755 });

  const script = scanScript()
    .replace('LOOP_SECONDS=3300', `LOOP_SECONDS=${loopSeconds}`)
    .replace('TICK_SECONDS=300', `TICK_SECONDS=${tickSeconds}`);
  const file = path.join(dir, 'scan.sh');
  fs.writeFileSync(file, script);

  let code = 0, out = '';
  try {
    out = execFileSync('bash', ['-e', file], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CRON_SECRET: 'x',
             APP_URL: 'http://app', SINGLE_PASS: String(singlePass) },
    });
  } catch (e) {
    code = e.status; out = String(e.stdout || '') + String(e.stderr || '');
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { code, out, iterations: (out.match(/── iteration/g) || []).length };
}

test('the happy path loops to its budget and exits clean', () => {
  const r = runLoop();
  assert.strictEqual(r.code, 0);
  assert.ok(r.iterations >= 5, `expected several iterations, got ${r.iterations}`);
});

test('A FAILING TICK DOES NOT ABORT THE LOOP — the regression this file exists for', () => {
  // Under `bash -e` with a returning-1 helper this stopped at 1 iteration.
  const r = runLoop({ failOps: ['daytradeboardtick'] });
  assert.ok(r.iterations >= 5,
    `a failed board tick must not end the window — got ${r.iterations} iteration(s)`);
  assert.strictEqual(r.code, 1, 'but the job still fails visibly');
  assert.ok(r.out.includes('::error::op=daytradeboardtick'), 'and each failure is annotated');
});

test('every op failing still runs the full window and still fails the job', () => {
  const r = runLoop({ failOps: ['daytradescan', 'daytradeboardtick', 'lowfloattick'] });
  assert.ok(r.iterations >= 5, `got ${r.iterations}`);
  assert.strictEqual(r.code, 1);
});

test('the low-float tick runs at HALF the scan cadence', () => {
  // ~24 bulk-quote requests a pass, and this app has hit a provider plan limit before.
  const r = runLoop({ failOps: ['daytradescan', 'lowfloattick'] });
  const scans = (r.out.match(/::error::op=daytradescan /g) || []).length;
  const lows = (r.out.match(/::error::op=lowfloattick /g) || []).length;
  assert.ok(scans > 0 && lows > 0, 'both ops ran');
  assert.strictEqual(lows, Math.ceil(scans / 2), `expected half cadence, got ${lows}/${scans}`);
});

test('manual dispatch does a single pass so the workflow stays hand-testable', () => {
  const r = runLoop({ singlePass: true });
  assert.strictEqual(r.iterations, 1);
  assert.strictEqual(r.code, 0);
  assert.ok(r.out.includes('single pass'));
});

test('no unconditional-success suffix anywhere in the job', () => {
  // This is how real failures were swallowed here before; keep the guard literal.
  const wf = fs.readFileSync(WF, 'utf8');
  const job = wf.slice(wf.indexOf('  scan:'), wf.indexOf('  postclose:'));
  assert.ok(!job.includes('|| true'), 'failures must not be swallowed');
  assert.ok(!job.includes('|| :'), 'nor swallowed by a colon builtin');
});

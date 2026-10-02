'use strict';
// .github/workflows/paper-exec.yml — schedule, secret handling and op contract pins, plus
// the run: block executed under `bash -e` (GitHub's shell) with a stub curl.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const WF_PATH = path.join(__dirname, '..', '.github', 'workflows', 'paper-exec.yml');
const WF = fs.readFileSync(WF_PATH, 'utf8');

test('schedule: 13:35 UTC open, 30-min polls 14:05→20:05, 19:50 flatten, weekdays only; dispatchable; serialized', () => {
  assert.match(WF, /cron: '35 13 \* \* 1-5'/);
  assert.match(WF, /cron: '5,35 14-19 \* \* 1-5'/);
  assert.match(WF, /cron: '50 19 \* \* 1-5'/);
  assert.match(WF, /cron: '5 20 \* \* 1-5'/);
  assert.ok(!/\* \* \* \*'/.test(WF), 'never runs on weekends');
  assert.match(WF, /workflow_dispatch:/);
  assert.match(WF, /concurrency:\n  group: paper-exec\n  cancel-in-progress: false/);
  assert.match(WF, /timeout-minutes: 10/);
});

test('contract: CRON_SECRET bearer, graceful skip without it, open-then-poll, flatten only on the 19:50 schedule or by input, no Alpaca secrets in the workflow', () => {
  assert.match(WF, /CRON_SECRET: \$\{\{ secrets\.CRON_SECRET \}\}/);
  assert.match(WF, /CRON_SECRET repo secret not set/);
  assert.match(WF, /-H "Authorization: Bearer \$CRON_SECRET"/);
  assert.match(WF, /op=paperopen"/);
  assert.match(WF, /op=paperpoll\$FLAT"/);
  assert.match(WF, /github\.event\.schedule == '50 19 \* \* 1-5' && '1' \|\| github\.event\.inputs\.flatten/);
  assert.ok(WF.indexOf('op=paperopen') < WF.indexOf('op=paperpoll'), 'placement precedes the poll so a late EST open still places');
  assert.ok(!/ALPACA_(KEY_ID|SECRET_KEY|PAPER)/.test(WF.replace(/^#.*$/gm, '')), 'Alpaca keys live in Vercel env, never in the workflow');
  assert.ok(!/\|\| true/.test(WF), 'no unconditional-success suffix swallowing failures');
});

// Pull the run: block out of the YAML (no yaml dependency) and dedent it.
function runScript() {
  const i = WF.indexOf('run: |');
  const lines = WF.slice(WF.indexOf('\n', i) + 1).split('\n');
  const indent = (lines.find((l) => l.trim()) || '').match(/^ */)[0].length;
  return lines.map((l) => l.slice(indent)).join('\n');
}

function runTick({ failOps = [], secret = 'shh', bodies = {}, flatten = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperexec-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env bash
out=""; prev=""; url=""
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  case "$a" in http*) url="$a";; esac
  prev="$a"
done
echo "$url" >> "${dir}/urls.txt"
code=200
for bad in ${failOps.join(' ')}; do case "$url" in *"$bad"*) code=503;; esac; done
body='{"ok":true}'
case "$url" in *paperopen*) body='${bodies.paperopen || '{"ok":true}'}';; *paperpoll*) body='${bodies.paperpoll || '{"ok":true}'}';; esac
[ -n "$out" ] && printf '%s' "$body" > "$out"
printf '%s' "$code"
`, { mode: 0o755 });
  const script = runScript();
  let out = '', code = 0;
  try {
    out = execFileSync('bash', ['-e', '-c', script], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, CRON_SECRET: secret, APP_URL: 'https://example.test', FLATTEN: flatten }, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); code = e.status; }
  const urls = fs.existsSync(path.join(dir, 'urls.txt')) ? fs.readFileSync(path.join(dir, 'urls.txt'), 'utf8').trim().split('\n') : [];
  return { code, out, urls };
}

test('run block under bash -e: no secret → exit 0 with a warning and no calls', () => {
  const r = runTick({ secret: '' });
  assert.equal(r.code, 0); assert.match(r.out, /::warning::CRON_SECRET/); assert.deepEqual(r.urls, []);
});

test('run block: open then poll; flatten appends &flatten=1 only when FLATTEN=1; dormant bodies are a notice, not a failure', () => {
  const r = runTick({ bodies: { paperopen: '{"ok":true,"skipped":true,"dormant":true,"reason":"ALPACA_KEY_ID / ALPACA_SECRET_KEY not set"}' } });
  assert.equal(r.code, 0);
  assert.deepEqual(r.urls, ['https://example.test/api/tracker?op=paperopen', 'https://example.test/api/tracker?op=paperpoll']);
  assert.match(r.out, /::notice::paperopen is dormant/);
  const f = runTick({ flatten: '1' });
  assert.equal(f.urls[1], 'https://example.test/api/tracker?op=paperpoll&flatten=1');
});

test('run block: a failed open does not stop the poll; the job still exits non-zero; ok:false bodies count as failures', () => {
  const r = runTick({ failOps: ['paperopen'] });
  assert.equal(r.code, 1); assert.equal(r.urls.length, 2, 'poll still ran after the open failed'); assert.match(r.out, /::error::op=paperopen returned HTTP 503/);
  const b = runTick({ bodies: { paperpoll: '{"ok":false,"error":"boom"}' } });
  assert.equal(b.code, 1); assert.match(b.out, /::error::paperpoll reported ok:false/);
});

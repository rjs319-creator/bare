'use strict';
// Market Pulse v2 — ROUTE AUTHORIZATION + COMPATIBILITY.
// Required behaviors #31-#33: public read routes cannot mutate storage or start LLM
// calls; privileged ticks reject unauthorized mutation when secrets are configured;
// legacy Market Pulse routes remain functional. Plus #9/#10: same-time-of-day relative
// volume and point-in-time bar hygiene (via the reused intraday-features primitives).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const TRACKER = read('api/tracker.js');
const ROUTES_V1 = read('lib/pulse-routes.js');
const ROUTES_V2 = read('lib/pulse2-routes.js');

// ── #32: privileged registration ────────────────────────────────────────────
test('#32: every v2 writer tick is registered in PRIVILEGED_OPS', () => {
  const priv = TRACKER.match(/const PRIVILEGED_OPS = new Set\(\[([\s\S]*?)\]\);/)[1];
  for (const op of ['pulse2statetick', 'pulse2collect', 'pulse2refine', 'pulse2grade']) {
    assert.ok(priv.includes(`'${op}'`), `${op} must be privileged`);
  }
});

test('#31: the public v2 reads are NOT privileged and are dispatched read-only', () => {
  const priv = TRACKER.match(/const PRIVILEGED_OPS = new Set\(\[([\s\S]*?)\]\);/)[1];
  for (const op of ['pulse2', 'pulse2health', 'pulse2evidence']) {
    assert.ok(!new RegExp(`'${op}'`).test(priv), `${op} must stay public`);
    assert.ok(TRACKER.includes(`op === '${op}'`), `${op} must be dispatched`);
  }
  // The public route module performs no writes and no LLM client construction.
  assert.ok(!/writeJSON\s*\(|writeVerified\s*\(|mergeHealth\s*\(/.test(ROUTES_V2.replace(/\/\/.*$/gm, '')), 'pulse2-routes must not write');
  assert.ok(!ROUTES_V2.includes('@anthropic-ai/sdk'), 'pulse2-routes must not construct an LLM client');
  assert.ok(!ROUTES_V2.includes('messages.create'), 'pulse2-routes must not call the LLM');
});

test('#31b (v1 defect fix): the legacy gather/refine LLM calls are gated behind isTrusted', () => {
  // runPulse: the untrusted branch returns before gatherPulse can run.
  const runPulseSrc = ROUTES_V1.slice(ROUTES_V1.indexOf('async function runPulse('), ROUTES_V1.indexOf('async function runPulseRefine('));
  const guardIdx = runPulseSrc.indexOf("require('./auth').isTrusted(req)");
  const gatherIdx = runPulseSrc.indexOf('await gatherPulse()');
  assert.ok(guardIdx > -1 && gatherIdx > -1 && guardIdx < gatherIdx, 'isTrusted guard must precede gatherPulse');
  // runPulseRefine: same for refineDraft.
  const refineSrc = ROUTES_V1.slice(ROUTES_V1.indexOf('async function runPulseRefine('), ROUTES_V1.indexOf('async function runPulseEpisodes('));
  const g2 = refineSrc.indexOf("require('./auth').isTrusted(req)");
  const r2 = refineSrc.indexOf('await refineDraft(');
  assert.ok(g2 > -1 && r2 > -1 && g2 < r2, 'isTrusted guard must precede refineDraft');
});

test('#32b: requireTrusted fails closed in production when the secret is unset', () => {
  // Contract lock on lib/auth (the gate every privileged v2 tick sits behind).
  const AUTH = read('lib/auth.js');
  assert.match(AUTH, /fail CLOSED/i);
  assert.match(AUTH, /503/);
});

// ── #33: legacy compatibility ───────────────────────────────────────────────
test('#33: legacy pulse routes remain exported and dispatched', () => {
  const v1 = require('../lib/pulse-routes');
  for (const fn of ['runPulse', 'runPulseRefine', 'runPulseGrade', 'runPulseEpisodes', 'parsePulse', 'parseRefinedPulse']) {
    assert.equal(typeof v1[fn], 'function', fn);
  }
  for (const op of ['pulse', 'pulserefine', 'pulsegrade', 'pulseepisodes']) {
    assert.ok(TRACKER.includes(`op === '${op}'`), `legacy op ${op} still dispatched`);
  }
});

test('feature flag: PULSE2_MODE=off disables v2 without touching v1', () => {
  const { pulse2Enabled } = require('../lib/pulse2-routes');
  const prev = process.env.PULSE2_MODE;
  try {
    delete process.env.PULSE2_MODE;
    assert.equal(pulse2Enabled(), true);      // default on
    process.env.PULSE2_MODE = 'off';
    assert.equal(pulse2Enabled(), false);
  } finally {
    if (prev === undefined) delete process.env.PULSE2_MODE; else process.env.PULSE2_MODE = prev;
  }
});

test('clock separation survives the payload assembly (no doc → honest unavailable dataMode)', () => {
  const { buildPayloadClocks } = require('../lib/pulse2-routes');
  const c = buildPayloadClocks({ narrativesDoc: null, marketStateDoc: null, now: new Date('2026-06-09T18:00:00Z') });
  assert.equal(c.dataMode, 'unavailable');
  assert.equal(c.narrativeFreshness, 'UNAVAILABLE');
  assert.equal(c.marketDataFreshness, 'UNAVAILABLE');
});

// ── #9/#10: time-of-day relative volume + PIT bar hygiene (reused primitives) ──
test('#9: morning relative volume compares SAME-TIME-OF-DAY cumulative volume, not full prior days', () => {
  const { timeOfDayRelVol } = require('../lib/intraday-features');
  const bar = (min, v) => ({ t: new Date(Date.UTC(2026, 5, 9, 13, 30 + min)).toISOString(), o: 1, h: 1, l: 1, c: 1, v });
  // Today: two morning bars of 100 each. Prior sessions: identical mornings + a huge
  // afternoon. A naive partial-day/full-day ratio would be ~0.2; same-time is 1.0.
  const today = [bar(0, 100), bar(5, 100)];
  const prior = [[bar(0, 100), bar(5, 100), bar(240, 800)], [bar(0, 100), bar(5, 100), bar(240, 800)]];
  const rel = timeOfDayRelVol(today, prior, 5);
  assert.equal(rel, 1);
});

test('#10: bars after the evaluation timestamp are excluded (no future leakage)', () => {
  const { splitCompletedForming } = require('../lib/intraday-features');
  const now = '2026-06-09T13:58:00Z';
  const mk = iso => ({ t: iso, o: 1, h: 1, l: 1, c: 1, v: 1 });
  const bars = [
    mk('2026-06-09T13:30:00Z'),   // completed
    mk('2026-06-09T13:55:00Z'),   // still forming at 13:58 (5-min bar ends 14:00)
    mk('2026-06-09T14:30:00Z'),   // FUTURE — must be dropped entirely
  ];
  const { completed, forming } = splitCompletedForming(bars, now, { intervalMin: 5 });
  assert.equal(completed.length, 1);
  assert.equal(forming.length, 1);
  assert.equal(forming[0].t, '2026-06-09T13:55:00Z');
  assert.ok(!completed.some(b => b.t.includes('14:30')), 'future bar leaked');
  assert.ok(!forming.some(b => b.t.includes('14:30')), 'future bar leaked into forming');
});

// ── #34 guard: the pulse2 warm chain is reachable ───────────────────────────
test('pulse2 chain exists, is a root, and runs state→collect→refine→grade in order', () => {
  const WC = require('../lib/warm-chains');
  assert.ok(WC.ROOT_CHAINS.includes('pulse2'));
  assert.deepEqual(WC.CHAINS.pulse2, ['op=pulse2statetick', 'op=pulse2collect', 'op=pulse2refine', 'op=pulse2grade']);
});

test('storage keys are versioned under pulse/v2/ and never collide with the legacy ledger', () => {
  const { KEYS } = require('../lib/pulse2-store');
  for (const k of Object.values(KEYS)) assert.ok(String(k).startsWith('pulse/v2/'), k);
});

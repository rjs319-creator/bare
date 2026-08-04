'use strict';
// Phase-11 claim honesty — no hard-coded user-visible text may assert validation,
// proven alpha, deflation-survival, survivorship safety or calibrated probabilities
// that current governance does not back (no strategy is Validated; no promotion
// artifact exists; the failure model is an uncalibrated heuristic).
//
// Source-scan style (same pattern as map-limit.test.js): these exact phrases were
// found contradicting the registry in the 2026-08 audit and must not return.
// Day-Trade-only copy is NOT asserted here (frozen by user directive).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const R = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');

const FORBIDDEN = [
  ['public/js/app.js', [
    'the one validated event edge',
    '(the validated primary)',
    'passes deflation',
    'the proven edge is',
    '(the validated signal)',
    'in risk-off (validated)',
    "trendrider: { level: 'validated'",
  ]],
  ['public/index.html', [
    'calibrated odds',
    'The most validated factor.',
    'the validated large-cap top-quartile',
    'a <b>modest, real edge',
    'id="coremo-meta">· survivorship-safe',
  ]],
  ['public/js/today.js', [
    'validated track record',
    'validated-expectancy',
    'Failure prob ',
  ]],
  ['lib/challenger-decision.js', ['failure probability ${']],
];

for (const [file, phrases] of FORBIDDEN) {
  test(`no resurrected hard-coded claim in ${file}`, () => {
    const src = R(file);
    for (const phrase of phrases) {
      assert.ok(!src.includes(phrase),
        `${file} contains the forbidden claim ${JSON.stringify(phrase)} — user-visible validation language must be generated from registry/maturity/governance data, never hard-coded`);
    }
  });
}

test('the heuristic failure score is never presented as a probability in served notes', () => {
  const src = R('lib/decision-routes.js');
  assert.ok(!src.includes("carries a failure probability"), 'decision-routes note must say failure-risk score');
});

test('evidence badges derive from the maturity endpoint, not hard-coded per tab', () => {
  const src = R('public', 'js', 'evidence-badge.js');
  assert.match(src, /op=maturity/, 'badges must load grades from the maturity endpoint');
});

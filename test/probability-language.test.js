'use strict';
// Score-vs-probability display honesty (Phase 5 of the evidence-based redesign).
// A heuristic score is never presented as a probability/confidence, and every
// probability-looking number discloses its calibration lineage. These are
// source-scan regression tests: each locks a specific relabeling so the old
// flattering language cannot quietly return.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const appJs = read('public/js/app.js');
const indexHtml = read('public/index.html');
const evolveJs = read('public/js/evolve.js');
const tickerJs = read('public/js/ticker-lookup.js');
const omegaEnsJs = read('public/js/omega-ensemble.js');
const momentumApi = read('api/momentum.js');

test('learned screener model renders a /100 ranking score, never a bare %', () => {
  assert.ok(!appJs.includes('`🤖 ${wp}%`'), 'raw sigmoid must not render as a percentage');
  assert.ok(appJs.includes('🤖 model ${wp}/100'), 'model tag renders as an explicit 0-100 score');
  assert.ok(!indexHtml.includes("learned model's win-probability"), 'toggle tooltip must not claim win-probability');
  assert.ok(!indexHtml.includes('learned win-probability model'), 'help copy must not claim win-probability');
});

test('fade engine posterior is labeled backtested, not "confidence"', () => {
  assert.ok(!appJs.includes('Engine confidence the edge is positive'), 'old confidence tooltip removed');
  assert.ok(appJs.includes('NOT a calibrated live probability'), 'posterior discloses its uncalibrated basis');
  assert.ok(!appJs.includes('Confidence</b> is how sure it is the edge is real'), 'caveat copy no longer oversells');
});

test('coil % is an empirical decile base rate, never a "calibrated chance"', () => {
  assert.ok(!appJs.includes('calibrated chance'), 'the phrase "calibrated chance" is banned');
  assert.ok(appJs.includes('not a calibrated live probability'), 'coil copy discloses the study basis');
  assert.ok(appJs.includes('survivorship-unsafe'), 'coil copy surfaces the survivorship caveat the server already declares');
});

test('EVOLVE per-card tooltip only claims "calibrated" when modelHealth says so', () => {
  assert.ok(evolveJs.includes('health.calibrated'), 'tooltip branches on model health');
  assert.ok(evolveJs.includes('NOT yet calibrated'), 'uncalibrated branch is explicit');
  assert.ok(!evolveJs.includes('"calibrated P(upside barrier first)'), 'no unconditional calibrated claim');
});

test('alert card evidence strength is not called confidence', () => {
  assert.ok(!appJs.includes('Conf: ${c.confidence}/10'), 'old "Conf:" label removed');
  assert.ok(appJs.includes('Evidence: ${c.confidence}/10'), 'renamed to Evidence strength');
  assert.ok(appJs.includes('NOT a probability or win rate'), 'card discloses what the number is not');
});

test('momentum API ships the honest evidenceStrength alias and thesis wording', () => {
  assert.ok(momentumApi.includes('evidenceStrength: r.live.confidence'), 'alias field present');
  assert.ok(momentumApi.includes('not a probability'), 'thesis text discloses the basis');
  assert.ok(!momentumApi.includes('(conf ${card.confidence}/10)'), 'old conf framing removed');
});

test('ticker-lookup barrier row carries the calibrated/model-estimate branch', () => {
  assert.ok(tickerJs.includes("Barrier ${pred.calibrated ?"), 'barrier row branches on calibration');
  assert.ok(tickerJs.includes('(model-estimate, not calibrated)'), 'uncalibrated branch labeled');
});

test('omega-ensemble header matches its cells (not calibrated)', () => {
  assert.ok(omegaEnsJs.includes('2/5/10d probability (not calibrated)'), 'header no longer promises a probability');
});

test('no user-facing surface uses forbidden certainty language', () => {
  for (const [name, src] of [['app.js', appJs], ['index.html', indexHtml], ['evolve.js', evolveJs]]) {
    // "sure thing" / "guaranteed" may appear ONLY in negations or pump-detection copy.
    for (const line of src.split('\n')) {
      if (!/\b(sure thing|guaranteed|highly accurate)\b/i.test(line)) continue;
      const ctx = line.toLowerCase();
      // Allowed: negations ("no signal is a sure thing"), and non-outcome resource language
      // ("guaranteed N slots"). Banned: any unqualified claim about returns or accuracy.
      assert.ok(/no |not |don't |never |isn'?t |pretend|slots|reserve/.test(ctx), `${name}: unqualified certainty language: "${line.trim().slice(0, 90)}"`);
    }
    assert.ok(!/market-beating number/i.test(src), `${name}: "market-beating" framing removed`);
  }
});

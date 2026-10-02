'use strict';
// Preregistration + wiring pins for the factor-adjusted Scoreboard (proposal #18):
// the shadow gate is a registry row (weight 0, placebo + minimum N stated), the nightly
// refresh is a bearer-only step on an existing chain, and the UI line is labelled shadow.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const REG = require('../lib/research/hypothesis-registry');
const FA = require('../lib/factors/factor-alpha');
const CHAINS = require('../lib/warm-chains');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('factor-adjusted alpha gate is registered: confirmatory, open, weight-0 shadow, placebo and minimum N stated', () => {
  const h = REG.find(FA.HYPOTHESIS_ID);
  assert.ok(h, 'registered');
  assert.equal(REG.validateHypothesis(h).valid, true);
  assert.equal(h.mode, 'confirmatory');
  assert.equal(h.status, 'open');
  assert.match(h.primaryMetric, /alphaFF ≥ 0/);
  assert.match(h.primaryMetric, /q ≤ 0\.10?/);
  assert.match(h.stoppingRule, /2027-04-02/, 'six months of shadow from 2026-10-02');
  assert.match(h.baseline, /placebo/i);
  assert.match(h.primaryMetric, /60/, 'minimum N (dates) stated');
  assert.match(h.note, /0\.8/, 'proxy-vs-FF beta correlation threshold stated');
  assert.match(h.note, /weight[- ]0|shadow/i);
});

test('nightly refresh rides the maturity chain after op=maturity (no new root → matrix unchanged)', () => {
  assert.deepEqual(CHAINS.CHAINS.maturity, ['op=maturity', 'op=factorsrefresh']);
  assert.ok(!CHAINS.ROOT_CHAINS.includes('factors'), 'no new root chain');
});

test('tracker routes: op=factors public read, op=factorsrefresh privileged write', () => {
  const src = read('api/tracker.js');
  assert.match(src, /'factorsrefresh',/);
  assert.match(src, /req\.query\.op === 'factors'\) return require\('\.\.\/lib\/factors\/factors-routes'\)\.runFactors/);
  assert.match(src, /req\.query\.op === 'factorsrefresh'\) return require\('\.\.\/lib\/factors\/factors-routes'\)\.runFactorsRefresh/);
  const privileged = src.slice(src.indexOf('const PRIVILEGED_OPS'), src.indexOf(']);', src.indexOf('const PRIVILEGED_OPS')));
  assert.match(privileged, /'factorsrefresh'/);
  assert.doesNotMatch(privileged, /'factors',/, 'the read stays public');
});

test('Scoreboard tab renders a "vs factors" line next to "vs S&P" with a shadow tooltip', () => {
  const app = read('public/js/app.js');
  assert.match(app, /sb-h-ff/);
  assert.match(app, /vs factors/);
  assert.match(app, /factorAlpha/);
  assert.match(app, /shadow/i);
  const css = read('public/css/app.css');
  assert.match(css, /\.sb-h-ff \{/);
});

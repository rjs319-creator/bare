'use strict';
// CROSS-BOUNDARY MODEL-CONTRACT SYNC — the client applies the server-trained logistic
// model (api/backtest.js → localStorage → app.js modelProb), so the FEATURE ORDER of
// app.js cardFeatVec must match the server's MODEL_KEYS/featVec exactly; the contract
// used to live in a comment only ("Feature order must match the server's MODEL_KEYS"),
// so silent drift reordered probabilities without any failure. Same for the screener
// composite: app.js SCR_DEFAULT_W must equal lib/swing-screener-engine.js
// DEFAULT_WEIGHTS (live vs replay must not drift). These tests regex-extract both
// sides from source and assert equality, so any drift is a test failure.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const APP = readFileSync(join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const BACKTEST = readFileSync(join(__dirname, '..', 'api', 'backtest.js'), 'utf8');
const ENGINE = readFileSync(join(__dirname, '..', 'lib', 'swing-screener-engine.js'), 'utf8');

// ── Feature-vector order (client cardFeatVec vs server MODEL_KEYS/featVec) ──────

// Canonical MODEL_KEYS ↔ the identifiers each side's vector element must reference.
// Every element of a feature vector must match EXACTLY ONE pattern (ambiguity or a
// new unmapped feature is itself a failure — it means the contract changed).
const CLIENT_PATTERNS = [
  ['breakout', /status === 'Breakout'/],
  ['rs', /\brsNewHigh\b/],
  ['trend', /\baboveSma200\b/],
  ['obv', /\bobvRising\b/],
  ['vcp', /\bvcp\b/],
  ['pocket', /\bpocketPivot\b/],
  ['vdu', /\bvdu\b/],
  ['ud', /\budVol\b/],
  ['longbase', /\blongBase\b/],
];
const SERVER_PATTERNS = [
  ['breakout', /tier === 'Breakout'/],
  ['rs', /\brsHigh\b/],
  ['trend', /\btrendUp\b/],
  ['obv', /\bobvRising\b/],
  ['vcp', /\bvcp\b/],
  ['pocket', /\bpocketPivot\b/],
  ['vdu', /\bvolDryUp\b/],
  ['ud', /\budStrong\b/],
  ['longbase', /\blongBase\b/],
];

// Pull the `return [ ... ]` array body out of a vector-builder function's source.
function extractVectorElements(src, headRe, label) {
  const head = src.match(headRe);
  assert.ok(head, `could not locate ${label} in source — the anchor changed; update this test's regex`);
  const after = src.slice(head.index);
  const ret = after.match(/return \[([\s\S]*?)\];/);
  assert.ok(ret, `could not find the return array of ${label}`);
  const elements = ret[1].split(/,(?![^(]*\))/).map(s => s.trim()).filter(Boolean);
  assert.ok(elements.length >= 5, `${label}: implausibly few vector elements (${elements.length})`);
  return elements;
}

// Map each vector element to its canonical key via the pattern table (exactly one hit).
function keysOf(elements, patterns, label) {
  return elements.map((el, i) => {
    const hits = patterns.filter(([, re]) => re.test(el)).map(([k]) => k);
    assert.equal(hits.length, 1,
      `${label} element ${i} (${el}) matched ${hits.length} known features [${hits.join(', ')}] — `
      + 'the feature set changed; update BOTH sides and this test\'s pattern table together');
    return hits[0];
  });
}

function extractModelKeys() {
  const m = BACKTEST.match(/const MODEL_KEYS = \[([^\]]+)\]/);
  assert.ok(m, 'MODEL_KEYS not found in api/backtest.js');
  return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

test('server featVec order matches its own MODEL_KEYS (api/backtest.js internal consistency)', () => {
  const keys = extractModelKeys();
  const elements = extractVectorElements(BACKTEST, /const featVec = t =>/, 'api/backtest.js featVec');
  assert.deepEqual(keysOf(elements, SERVER_PATTERNS, 'server featVec'), keys);
});

test('client cardFeatVec feature order matches server MODEL_KEYS (app.js ↔ api/backtest.js)', () => {
  const keys = extractModelKeys();
  const elements = extractVectorElements(APP, /function cardFeatVec\(c\)/, 'app.js cardFeatVec');
  const clientKeys = keysOf(elements, CLIENT_PATTERNS, 'client cardFeatVec');
  assert.deepEqual(clientKeys, keys,
    'app.js cardFeatVec order drifted from api/backtest.js MODEL_KEYS — '
    + 'the client would apply server-trained weights to the wrong features');
});

// ── Default screener weights (client SCR_DEFAULT_W vs engine DEFAULT_WEIGHTS) ──

function parseWeights(body, label) {
  const out = {};
  for (const m of body.matchAll(/(\w+):\s*(-?\d+(?:\.\d+)?)/g)) out[m[1]] = Number(m[2]);
  assert.ok(Object.keys(out).length >= 5, `${label}: implausibly few weights parsed`);
  return out;
}

test('client SCR_DEFAULT_W equals lib/swing-screener-engine.js DEFAULT_WEIGHTS', () => {
  const clientM = APP.match(/const SCR_DEFAULT_W = \{([^}]+)\}/);
  assert.ok(clientM, 'SCR_DEFAULT_W not found in app.js');
  const serverM = ENGINE.match(/const DEFAULT_WEIGHTS = Object\.freeze\(\{([^}]+)\}\)/);
  assert.ok(serverM, 'DEFAULT_WEIGHTS not found in lib/swing-screener-engine.js');
  const client = parseWeights(clientM[1], 'SCR_DEFAULT_W');
  const server = parseWeights(serverM[1], 'DEFAULT_WEIGHTS');
  assert.deepEqual(Object.keys(client).sort(), Object.keys(server).sort(),
    'weight FACTOR SETS drifted between app.js and the engine');
  assert.deepEqual(client, server,
    'weight VALUES drifted between app.js SCR_DEFAULT_W and engine DEFAULT_WEIGHTS');
});

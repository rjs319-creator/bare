'use strict';
// STRUCTURED BEAR CASE — guard tests: evidence-only prompt with anti-hedging judge
// language, ticker-whitelisted parsing, selection order (actionable → leads, unique
// tickers, capped), weight-0 wiring (side-map attached AFTER the board hash; the UI
// line is labeled model-generated and never a rank input), fail-closed tick semantics,
// and chain + privilege registration.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const BC = require('../lib/bearcase');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const sig = (t, extra = {}) => ({ ticker: t, side: 'long', setup: 'Breakout', state: 'ready', score: 70, entry: 10, stop: 9, target: 12, sector: 'Tech', ...extra });

test('sigLine renders only served evidence fields — compact, no invented context', () => {
  const line = BC.sigLine(sig('NVDA', { catalyst: 'earnings beat', evidence: { families: ['price', 'options'] } }));
  assert.match(line, /\$NVDA · LONG Breakout · state=ready · score=70/);
  assert.match(line, /entry 10 · stop 9 · target 12/);
  assert.match(line, /evidence: price\/options/);
  assert.match(line, /catalyst: earnings beat/);
});

test('selectSignals: actionable lanes first, then leads; unique tickers; capped at MAX_CASES', () => {
  const payload = {
    actionableByHorizon: { swing: [sig('AAA'), sig('BBB')], intraday: [sig('AAA')] },
    qualifiedLeadsByHorizon: { swing: [sig('CCC'), sig('BBB')].concat(Array.from({ length: 10 }, (_, i) => sig('L' + i))) },
  };
  const out = BC.selectSignals(payload);
  assert.strictEqual(out.length, BC.MAX_CASES);
  assert.deepStrictEqual(out.slice(0, 3).map((s) => s.ticker), ['AAA', 'BBB', 'CCC'], 'actionable first, deduped');
  assert.deepStrictEqual(BC.selectSignals({}), [], 'empty board → no signals, no call');
});

test('the prompt is judge-grade: evidence-only, anti-hedging, invalidation required', () => {
  const p = BC.buildPrompt([sig('NVDA')], 'Risk-on');
  assert.match(p, /ONLY the fields shown/);
  assert.match(p, /Do NOT invent prices, events, fundamentals, or news/);
  assert.match(p, /No hedging/);
  assert.match(p, /"It could go either way" and probability talk are banned/);
  assert.match(p, /evidence gives the bear nothing/, 'an honest empty is the sanctioned alternative to a manufactured objection');
  assert.match(p, /prove the bear WRONG/);
  assert.match(p, /regime read: Risk-on/);
});

test('parseBearCases whitelists tickers, clips fields, drops junk', () => {
  const out = BC.parseBearCases({
    cases: [
      { ticker: 'nvda', bearCase: 'x'.repeat(900), invalidation: 'reclaims 10' },
      { ticker: 'EVIL', bearCase: 'not on the board' },
      { ticker: 'NVDA', bearCase: 'duplicate — ignored' },
      { ticker: 'AAA' },   // no bearCase → dropped
    ],
  }, ['NVDA', 'AAA']);
  assert.deepStrictEqual(Object.keys(out), ['NVDA']);
  assert.ok(out.NVDA.bearCase.length <= 500);
  assert.strictEqual(out.NVDA.invalidation, 'reclaims 10');
});

test('tick semantics: trading-days only, idempotent per day, degraded-vs-abstained distinguished, failures loud', () => {
  const src = read('lib/bearcase-routes.js');
  assert.match(src, /if \(!si\.isTradingDay\)/, 'no weekend/holiday LLM spend against a carried-over board');
  assert.match(src, /alreadyGenerated: true/, 'a re-dispatch is a no-op');
  assert.match(src, /boardHadRows/, 'gated-lanes-empty + board-has-rows = degraded read');
  assert.match(src, /degraded op=today read, nothing persisted/, 'a degraded read must never stick a false empty doc for the day');
  assert.match(src, /board abstained — no rows served/, 'a genuine abstention persists an honest empty');
  assert.match(src, /op=today unavailable — nothing generated/);
  assert.match(src, /status\(502\)\.json\(\{ ok: false, error: 'bear-case LLM call failed/, 'LLM failure is a 502 so the warm chain records it (a 200 would render the chain permanently healthy while the feature is dead)');
  assert.doesNotMatch(src, /retried next dispatch/, 'no false retry promise — there is no same-day retry mechanism');
  assert.match(src, /logWarn\('bearcase\.tick'/, 'failures are logged, never silently swallowed');
  assert.match(src, /if \(doc\) cached\(res\); else noStore\(res\);/, 'never CDN-cache the empty state');
  assert.match(src, /boardHash: payload\.boardHash && payload\.boardHash\.hash/, 'the argued-against board is stamped for audit (authenticated origin read is deliberate — atlasx writer rule)');
});

test('SERVING KEY: cases key to the last COMPLETED session so they stay visible through premarket/RTH', () => {
  const src = read('lib/bearcase-routes.js');
  assert.match(src, /lastCompletedRegularSession/, 'read key = last completed session, not the raw calendar date');
  assert.match(src, /servingDate = \(\) => lastCompletedRegularSession/);
  assert.match(src, /arguedAgainst: date/, 'the public read labels WHICH close board was argued against');
  // The public read picks fields explicitly — spreading the stored doc would auto-leak
  // any future writer-side field onto the anonymous endpoint.
  assert.doesNotMatch(src, /\.\.\.\(doc \|\|/, 'no doc spread on the public read');
});

test('SIDE IDENTITY: each case is stamped with the argued side; the UI refuses a cross-side render', () => {
  const src = read('lib/bearcase-routes.js');
  assert.match(src, /sideByTicker/, 'the tick stamps the side of the signal it argued against');
  const ui = read('public/js/today.js');
  assert.match(ui, /\(bc\.side \|\| 'long'\) !== rowSide/, 'a LONG-argued case never renders on the SHORT card of the same ticker');
});

test('WEIGHT-0 WIRING: the side-map attaches AFTER the board hash, mutates no row, adds no wall time', () => {
  const src = read('lib/decision-routes.js');
  const hashIdx = src.indexOf('payload.boardHash = ');
  const bcIdx = src.indexOf('payload.bearCases');
  assert.ok(hashIdx > 0 && bcIdx > hashIdx, 'bearCases must attach after the hash is computed');
  assert.match(src, /SIDE-MAP — no row is mutated/);
  assert.match(src, /payload\.bearCases = null/, 'absent doc degrades to null, never blocks the board');
  const startIdx = src.indexOf('const bearcasePromise');
  const prevIdx = src.indexOf('const prev = await STORE.readJSON(SNAP_PATH');
  assert.ok(startIdx > 0 && startIdx < prevIdx, 'the read STARTS with the pre-reads and is awaited only after the hash — zero added latency on the hot path');
});

test('rate-limit hardening: the public read is in EXPENSIVE_OPS (its empty state is deliberately no-store)', () => {
  const tracker = read('api/tracker.js');
  const start = tracker.indexOf('const EXPENSIVE_OPS');
  const expensive = tracker.slice(start, tracker.indexOf(']);', start));
  assert.match(expensive, /'bearcase'/);
});

test('UI: the bear line is labeled model-generated, shows the invalidation, and is never a rank input', () => {
  const ui = read('public/js/today.js');
  assert.match(ui, /function bearLine\(sig\)/);
  assert.match(ui, /model view, not a rank input/);
  assert.match(ui, /does NOT affect this rank/);
  assert.match(ui, /wrong if:/, 'the invalidation renders so the bear case reads as a check, not a verdict');
  assert.match(ui, /\+ bearLine\(sig\)\n\s*\+ levels\(sig\)/, 'rendered inside the signal card');
  assert.doesNotMatch(ui, /BEARCASES[^\n]*score/, 'bear cases never touch a score');
});

test('chain + privilege registration: tick is PRIVILEGED, read is public, chain is a root', () => {
  const chains = read('lib/warm-chains.js');
  assert.match(chains, /bearcase: \['op=bearcasetick'\]/);
  assert.match(chains.slice(chains.indexOf('ROOT_CHAINS')), /'bearcase'/);
  const tracker = read('api/tracker.js');
  const privileged = tracker.slice(tracker.indexOf('const PRIVILEGED_OPS'), tracker.indexOf('const EXPENSIVE_OPS'));
  assert.match(privileged, /'bearcasetick'/);
  assert.doesNotMatch(privileged, /'bearcase'[,\]]/, 'the public read must not be gated');
  assert.match(tracker, /op === 'bearcase'/);
});

test('frozen call bounds (cheap generator per the two-tier policy)', () => {
  assert.strictEqual(BC.MODEL, 'claude-haiku-4-5-20251001');
  assert.strictEqual(BC.MAX_CASES, 8);
  assert.match(BC.BEAR_TOOL.input_schema.properties.cases.items.properties.bearCase.description, /No hedging|banned/);
});

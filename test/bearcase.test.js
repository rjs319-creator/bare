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

test('tick semantics: idempotent per day, honest-empty on an abstained board, 502 when op=today is down', () => {
  const src = read('lib/bearcase-routes.js');
  assert.match(src, /alreadyGenerated: true/, 'a re-dispatch is a no-op');
  assert.match(src, /board served no actionable\/lead rows/, 'abstained board → explicit empty doc, never a fabricated case');
  assert.match(src, /op=today unavailable — nothing generated/);
  assert.match(src, /nothing persisted \(retried next dispatch\)/, 'a failed LLM call persists nothing');
  assert.match(src, /if \(doc\) cached\(res\); else noStore\(res\);/, 'never CDN-cache the empty state');
  assert.match(src, /sessionInfoAt\(new Date\(\)\)\.etDate/, 'day keys live on the ET calendar');
});

test('WEIGHT-0 WIRING: the side-map attaches AFTER the board hash and mutates no row', () => {
  const src = read('lib/decision-routes.js');
  const hashIdx = src.indexOf('payload.boardHash = ');
  const bcIdx = src.indexOf('payload.bearCases');
  assert.ok(hashIdx > 0 && bcIdx > hashIdx, 'bearCases must attach after the hash is computed');
  assert.match(src, /SIDE-MAP — no row is mutated/);
  assert.match(src, /payload\.bearCases = null/, 'absent doc degrades to null, never blocks the board');
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

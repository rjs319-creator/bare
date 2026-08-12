'use strict';
// THE TICKER-LOOKUP STACK WAS UNGOVERNED (alpha-research pass 3).
//
// /api/chart -> lib/signal.analyze publishes an ACTION (STRONG_BUY / BUY / SELL /
// STRONG_SELL) plus a concrete entry / stop / target triple, per horizon, straight to the
// user on the app's most-used surface — while appearing in NO strategy registry and NO
// contract. lib/eligibility, lib/strategy-gate and lib/maturity therefore never saw it,
// so the four control points docs/non-daytrade-signal-inventory.md calls unbypassable
// were bypassed by the single-ticker lookup.
//
// Every weight in it is asserted, never fitted: lib/signal.js (EMA +/-3, VWAP +/-2,
// MACD +/-2, RSI +/-2, volume +/-1), lib/swingread.js ({trend .45, rs .35, part .20}),
// lib/longterm.js (7 factors summing to 1.0).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const S = require('../lib/signal');
const gate = require('../lib/strategy-gate');
const SC = require('../lib/strategy-contracts');
const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');

const IDS = ['lookup-intraday', 'lookup-swing', 'lookup-longterm'];

// ── registration ────────────────────────────────────────────────────────────────

test('all three horizon reads are registered, shadow, and weight-0', () => {
  for (const id of IDS) {
    const e = STRATEGY_REGISTRY.find(x => x.id === id);
    assert.ok(e, `${id} must exist in the registry`);
    assert.equal(e.maturity, 'shadow', `${id} has no resolved record and must not be production`);
    assert.equal(gate.isTradeEligible(id), false, `${id} must not originate or boost a live trade`);
    assert.ok(e.note && /asserted|not fitted|never fitted/i.test(e.note),
      `${id} must disclose that its weights are asserted rather than fitted`);
    assert.ok(e.criteria && e.criteria.length > 80, `${id} must state what would earn promotion`);
  }
});

test('the reads are registered as THREE horizons, not blended into one', () => {
  // Brief §8: horizons keep their own label, model, costs and evidence. One combined
  // "lookup" grade would repeat the horizon-averaging the brief forbids.
  const horizons = IDS.map(id => STRATEGY_REGISTRY.find(x => x.id === id).horizon);
  assert.deepEqual(horizons, ['intraday', 'swing', 'position']);
});

test('each read has an outcome contract with an honest fill status', () => {
  for (const id of IDS) {
    const c = SC.contractFor(id);
    assert.ok(c, `${id} must have a contract`);
    assert.equal(c.fillVerified, false, `${id} publishes an ATR risk reference, not a verified fill`);
    assert.ok(c.metric && c.horizon && c.benchmark, `${id} contract must be complete`);
  }
});

// ── enforcement on the payload ──────────────────────────────────────────────────

test('analyze() stamps registry state on every horizon read', () => {
  const out = S.stampLookupGovernance({
    intraday: { action: 'STRONG_BUY', levels: { entry: '10', stop: '9', target: '12' } },
    swing: { action: 'BUY', plan: { trigger: 11 } },
    longTerm: { trend: 'bullish' },
  });
  for (const [key, id] of Object.entries(S.LOOKUP_STRATEGY_IDS)) {
    assert.equal(out[key].strategyId, id);
    assert.equal(out[key].maturity, 'shadow');
    assert.equal(out[key].tradeEligible, false);
    assert.match(out[key].planBasis, /NOT a validated trade plan/);
  }
});

test('the stamp reads the central gate, so a wording change cannot grant live status', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'signal.js'), 'utf8');
  assert.match(src, /const SG = require\('\.\/strategy-gate'\)/);
  assert.match(src, /read\.tradeEligible = SG\.isTradeEligible\(id\)/);
});

test('a missing or malformed read is skipped, never fabricated', () => {
  const out = S.stampLookupGovernance({ intraday: null, swing: 'nonsense' });
  assert.equal(out.intraday, null);
  assert.equal(out.swing, 'nonsense');
});

test('planBasis clears when a read is genuinely cleared', () => {
  // Proves the note is state-driven rather than a hardcoded string: promote the id in an
  // injected registry and the disclaimer disappears on its own.
  const promoted = STRATEGY_REGISTRY.map(e => (e.id === 'lookup-swing' ? { ...e, maturity: 'production' } : e));
  assert.equal(gate.isTradeEligible('lookup-swing', promoted), true,
    'the gate must honour an injected promotion — the stamp derives from exactly this call');
});

// ── client vocabulary ───────────────────────────────────────────────────────────

test('the lookup UI drops the buy/sell imperative for an uncleared read', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ticker-lookup.js'), 'utf8');
  assert.match(ui, /function govSign\(sign, read, action\)/);
  assert.match(ui, /RESEARCH · strongly bullish read/);
  // Fails closed: only an explicit true keeps the imperative.
  assert.match(ui, /read\.tradeEligible === true/);
  // Applied at the intraday and swing action chips, not merely defined.
  assert.match(ui, /const sign = govSign\(HZ_SIGN\[intraday\.action\]/);
  assert.match(ui, /const sign = govSign\(\(rec && HZ_SIGN\[rec\.action\]\)/);
});

test('levels stay visible but are labelled a risk reference, not a plan', () => {
  // Removing an ATR stop would make the card less safe, not more. The fix is framing.
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ticker-lookup.js'), 'utf8');
  assert.match(ui, /const planNote = \(read\)/);
  assert.match(ui, /planNote\(intraday\)/);
  assert.match(ui, /planNote\(sw\)/);
});

// ── the structural acceptance check ─────────────────────────────────────────────

test('every module publishing an entry/stop/target triple resolves to a registry id', () => {
  // The audit's acceptance test. A module that hands the user an executable-looking
  // triple must be answerable to the registry; this fails when a new one appears
  // without an entry, which is exactly how the lookup stack went ungoverned.
  const LIB = path.join(__dirname, '..', 'lib');
  const registered = new Set(STRATEGY_REGISTRY.map(e => e.id));
  // Modules known to emit a triple, each mapped to the id that answers for it.
  // NOTE: lookup-longterm is registered and gated like the others, but longterm.js is
  // deliberately NOT listed here — it publishes a trend direction and score, not a price
  // triple (the UI derives its invalidation line from the 200-day SMA). Listing it would
  // make this test assert something false about the module.
  const OWNERS = {
    'signal.js': 'lookup-intraday',
    'swingread.js': 'lookup-swing',
  };
  // Two naming conventions for the same executable-looking triple: signal.js uses
  // entry/stop/target, swingread.js uses trigger/invalidation/objective. Both are a
  // price to act at, a price to be wrong at, and a price to aim for.
  const ENTRY = /\b(entry|trigger)\b/;
  const INVALID = /\b(stop|invalidation)\b/;
  const OBJECTIVE = /\b(target|objective)\b/;
  for (const [file, id] of Object.entries(OWNERS)) {
    const src = fs.readFileSync(path.join(LIB, file), 'utf8');
    assert.ok(ENTRY.test(src) && INVALID.test(src) && OBJECTIVE.test(src),
      `${file} is mapped as a levels publisher but no longer looks like one — re-check this map`);
    assert.ok(registered.has(id), `${file} publishes levels but ${id} is not registered`);
    assert.equal(gate.isTradeEligible(id), false,
      `${id} publishes actionable-looking levels and must stay gated until it earns a record`);
  }
});

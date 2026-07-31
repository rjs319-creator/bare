'use strict';
// GRIDLOCK routes-layer invariants: feature flag, shadow isolation, cron wiring,
// registry/scoreboard integration, resolution honesty. No network, no Blob.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const GL = require('../lib/gridlock-routes');

test('feature flag: default shadow, off only when explicitly off, unknown fails to shadow', () => {
  assert.strictEqual(GL.resolveGridlockMode('off'), 'off');
  assert.strictEqual(GL.resolveGridlockMode('shadow'), 'shadow');
  assert.strictEqual(GL.resolveGridlockMode(''), 'shadow');
  assert.strictEqual(GL.resolveGridlockMode('enforce-now-please'), 'shadow');   // fail-closed
});

test('op=gridlock and writers no-op cleanly when GRIDLOCK_MODE=off (app unaffected)', async () => {
  const prev = process.env.GRIDLOCK_MODE;
  process.env.GRIDLOCK_MODE = 'off';
  try {
    const mkRes = () => { const r = { headers: {}, code: 200 }; r.setHeader = (k, v) => { r.headers[k] = v; }; r.status = c => { r.code = c; return r; }; r.json = o => { r.body = o; return r; }; return r; };
    for (const fn of [GL.runGridlock, GL.runGridlockTick, GL.runGridlockResolve]) {
      const res = mkRes();
      await fn({ query: {} }, res);
      assert.strictEqual(res.body.disabled, true, fn.name);
      assert.strictEqual(res.code, 200, fn.name);
    }
  } finally {
    if (prev == null) delete process.env.GRIDLOCK_MODE; else process.env.GRIDLOCK_MODE = prev;
  }
});

test('SHADOW_FLAGS carry weight-0 / paper / no-probability / not-portfolio-eligible', () => {
  assert.strictEqual(GL.SHADOW_FLAGS.deploymentWeight, 0);
  assert.strictEqual(GL.SHADOW_FLAGS.governanceStatus, 'paper');
  assert.strictEqual(GL.SHADOW_FLAGS.probability, null);
  assert.strictEqual(GL.SHADOW_FLAGS.portfolioEligible, false);
  assert.strictEqual(GL.SHADOW_FLAGS.affectsLiveRank, false);
});

test('shadow isolation: the live decision engine never references gridlock', () => {
  // Same discipline as test/govdemand.test.js — the files that build live picks
  // must not import or branch on gridlock. (lib/decision.js may carry the
  // physicalConstraint VOCABULARY, but no SOURCE_FAMILY mapping routes to it.)
  for (const f of ['decision-sources.js', 'decision-routes.js', 'decision-normalizers.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8');
    assert.ok(!/gridlock/i.test(src), `${f} must not reference gridlock`);
  }
  const decision = require('../lib/decision');
  assert.ok(decision.EVIDENCE_FAMILIES.includes('physicalConstraint'));
  assert.ok(!Object.values(decision.SOURCE_FAMILY).includes('physicalConstraint'),
    'no live screener may map to physicalConstraint while gridlock is shadow');
});

test('strategy registry: gridlock is shadow → not trade eligible; section joins the Scoreboard', () => {
  const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');
  const entry = STRATEGY_REGISTRY.find(s => s.id === 'gridlock');
  assert.ok(entry, 'gridlock registered');
  assert.strictEqual(entry.maturity, 'shadow');
  assert.strictEqual(entry.section, 'Gridlock');
  const { isTradeEligible, statusOf } = require('../lib/strategy-gate');
  assert.strictEqual(statusOf('gridlock'), 'shadow');
  assert.strictEqual(isTradeEligible('gridlock'), false);
});

test('warm cron: gridlock has its own root chain ordered tick → resolve', () => {
  const WC = require('../lib/warm-chains');
  assert.ok(WC.ROOT_CHAINS.includes('gridlock'));
  assert.deepStrictEqual(WC.CHAINS.gridlock, ['op=gridlocktick', 'op=gridlockresolve']);
});

test('pipelineFromLedger sums only live, non-rumored events for the region', () => {
  const events = {
    a: { isoRegion: 'PJM', lifecycle: 'BUILDING', certainty: 'CONTRACTED', demandDeltaMW: 500, eventType: 'DATA_CENTER_LOAD' },
    b: { isoRegion: 'PJM', lifecycle: 'CANCELLED', certainty: 'CONTRACTED', demandDeltaMW: 900, eventType: 'DATA_CENTER_LOAD' },
    c: { isoRegion: 'PJM', lifecycle: 'NEW', certainty: 'RUMORED', demandDeltaMW: 700, eventType: 'DATA_CENTER_LOAD' },
    d: { isoRegion: 'ERCOT', lifecycle: 'NEW', certainty: 'ANNOUNCED', demandDeltaMW: 300, eventType: 'DATA_CENTER_LOAD' },
    e: { isoRegion: 'PJM', lifecycle: 'EMERGING', certainty: 'ANNOUNCED', generationDeltaMW: 1000, eventType: 'GENERATOR_RETIREMENT' },
  };
  const p = GL.pipelineFromLedger(events, 'PJM');
  assert.strictEqual(p.announcedLargeLoadMW, 500);           // cancelled/rumored/out-of-region excluded
  assert.strictEqual(p.retirementPipelineMW, 1000);
});

test('summarizeResolution refuses a verdict on a small sample', () => {
  const small = GL.summarizeResolution({ 'a|X': { horizons: { 5: { excessSpyPct: 1.2 } } } });
  assert.match(small.note, /below promotion bar/);
  assert.strictEqual(small.byHorizon[5].n, 1);
  const empty = GL.summarizeResolution(null);
  assert.strictEqual(empty.predictions, 0);
});

test('relative-value pairs never recommend a short and disclose missing correlation', () => {
  const pairs = GL.buildRelativeValue([{
    ticker: 'TST', exposureRole: 'MERCHANT_GENERATOR', isoRegion: 'PJM',
    gate: { status: 'ACTIONABLE_RESEARCH' }, score: { total: 70 },
    tape: { excessMovePct: 1, dollarVol: 5e7 }, causalChain: { invalidatingEvidence: ['x'] },
  }]);
  assert.strictEqual(pairs.length, 1);
  assert.strictEqual(pairs[0].comparison, 'XLU');
  assert.match(pairs[0].shortSideNote, /no short position/i);
  assert.strictEqual(pairs[0].correlation, null);            // honest: not computed yet
});

test('tracker wires the four ops and marks the writers privileged', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'tracker.js'), 'utf8');
  for (const op of ['gridlock', 'gridlockscenario', 'gridlocktick', 'gridlockresolve']) {
    assert.ok(src.includes(`op === '${op}'`), `dispatch for ${op}`);
  }
  const priv = src.slice(src.indexOf('PRIVILEGED_OPS'), src.indexOf('EXPENSIVE_OPS'));
  assert.ok(priv.includes('gridlocktick') && priv.includes('gridlockresolve'));
});

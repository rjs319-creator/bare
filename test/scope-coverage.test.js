// Defect 4 — unified-board full-scope coverage. Micro/expanded swing candidates
// are OBSERVED (deduplicated inventory, reason-coded retention, coverage report)
// but can never change production ranks before promotion.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildToday } = require('../lib/decision-routes');

const row = (ticker, over = {}) => ({
  ticker, company: ticker + ' Co', sector: 'Technology', price: 20,
  status: 'Setup', emergingLeader: false,
  levels: { entry: 20.5, stop: 19, target: 24, rr: 2.3 },
  factors: { dollarVol: 5_000_000 },
  quant: { score: 60 },
  ...over,
});
const sj = (scope, rows) => ({ scope, results: rows, regime: { riskOn: true, bearish: false } });

test('micro/expanded observations cannot change production ranks', () => {
  const base = { screener: sj('large', [row('AAA')]), screenerSmall: sj('small', [row('BBB')]) };
  const withScopes = {
    ...base,
    screenerMicro: sj('micro', [row('MMM')]),
    screenerExpanded: sj('expanded', [row('EEE')]),
  };
  const p1 = buildToday(base, null, null, null);
  const p2 = buildToday(withScopes, null, null, null);
  const proj = p => Object.values(p.horizons).flat().map(x => ({ id: x.id, rank: x.rank, score: x.score }));
  assert.deepStrictEqual(proj(p2), proj(p1), 'board identical with and without micro/expanded sources');
  // …and the observations exist in the shadow inventory.
  const tickers = p2.swingResearch.inventory.filter(r => r.researchLane === 'scopeObservation').map(r => r.ticker).sort();
  assert.deepStrictEqual(tickers, ['EEE', 'MMM']);
});

test('same ticker across scopes deduplicates deterministically to the most authoritative scope', () => {
  const sources = {
    screenerMicro: sj('micro', [row('DUP')]),
    screenerExpanded: sj('expanded', [row('DUP')]),
  };
  const p = buildToday(sources, null, null, null);
  const kept = p.swingResearch.inventory.filter(r => r.ticker === 'DUP');
  assert.strictEqual(kept.length, 1, 'one inventory row');
  assert.strictEqual(kept[0].universeScope, 'micro', 'micro outranks expanded');
  assert.deepStrictEqual(kept[0].alsoInScopes, ['expanded']);
  const retained = p.swingResearch.retained.filter(r => r.ticker === 'DUP');
  assert.strictEqual(retained.length, 1);
  assert.strictEqual(retained[0].retainedReason, 'duplicate-lower-authority-scope');
  assert.strictEqual(retained[0].universeScope, 'expanded');
});

test('a research observation that duplicates a production board row is retained with a reason, not shown twice', () => {
  const sources = {
    screener: sj('large', [row('SAME')]),
    screenerMicro: sj('micro', [row('SAME')]),
  };
  const p = buildToday(sources, null, null, null);
  assert.strictEqual(p.swingResearch.inventory.filter(r => r.ticker === 'SAME').length, 0);
  const retained = p.swingResearch.retained.filter(r => r.ticker === 'SAME');
  assert.strictEqual(retained.length, 1);
  assert.strictEqual(retained[0].retainedReason, 'duplicate-production-board');
});

test('coverage reports which scope caches were unavailable', () => {
  const p = buildToday({ screener: sj('large', [row('AAA')]) }, null, null, null);
  assert.deepStrictEqual(p.swingResearch.coverage.missingScopeCache, ['micro', 'expanded']);
  assert.strictEqual(p.swingResearch.coverage.scopes.large, true);
  assert.strictEqual(p.swingResearch.coverage.scopes.micro, false);
});

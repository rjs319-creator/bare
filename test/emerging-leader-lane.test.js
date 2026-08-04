// Defect 1 — Emerging Leader downstream loss. A valid null-status emergingLeader
// row must survive into the Swing Research/Shadow lane with an explicit identity,
// must never originate or boost a production pick while shadow, and can be
// promoted ONLY by the strategy registry.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const N = require('../lib/decision-normalizers');
const { buildToday } = require('../lib/decision-routes');

const emergingRow = (over = {}) => ({
  ticker: 'EMRG', company: 'Emerging Co', sector: 'Technology', price: 12.5,
  status: null, emergingLeader: true,
  levels: { entry: 12.6, stop: 11.8, target: 14.9, rr: 2.9 },
  factors: { dollarVol: 8_000_000, mom21: 6.1, mom63: 18.2, mom126: 40.0 },
  quant: { score: 71 }, pct: { rs: 88 },
  ...over,
});
const screenerJson = (rows, scope = 'large') => ({ scope, dataCutoff: '2026-07-31', results: rows, regime: { riskOn: true, bearish: false } });

test('null-status Emerging Leader is captured into the research lane with explicit identity', () => {
  const { rows, dropped } = N.mapEmergingLeaderRows(screenerJson([emergingRow()]));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(dropped.length, 0);
  const r = rows[0];
  assert.strictEqual(r.section, 'EmergingLeader');
  assert.strictEqual(r.tier, 'EmergingLeader');
  assert.strictEqual(r.setup, 'EmergingLeader');
  assert.strictEqual(r.scoringVersion, 'emergingleader-v1');
  assert.strictEqual(r.universeScope, 'large');
  assert.strictEqual(r.research.decisionCutoff, '2026-07-31');
  assert.strictEqual(r.research.shadow, true);
  assert.strictEqual(r.entry, 12.6);
  assert.strictEqual(r.liquidity.dollarVol, 8_000_000);
});

test('ordinary null-status non-Emerging rows remain excluded everywhere', () => {
  const plain = emergingRow({ ticker: 'PLAIN', emergingLeader: false });
  const json = screenerJson([plain]);
  assert.strictEqual(N.fromScreener(json).length, 0, 'production adapter still requires status');
  assert.strictEqual(N.mapEmergingLeaderRows(json).rows.length, 0, 'research lane requires the emerging flag');
});

test('invalid plan / unknown liquidity fail closed with reason codes, never imputed', () => {
  const noPlan = emergingRow({ ticker: 'NOPLAN', levels: null });
  const noLiq = emergingRow({ ticker: 'NOLIQ', factors: {} });
  const { rows, dropped } = N.mapEmergingLeaderRows(screenerJson([noPlan, noLiq]));
  assert.strictEqual(rows.length, 0);
  assert.deepStrictEqual(dropped.map(d => d.reason).sort(), ['invalid-trade-plan', 'missing-liquidity']);
});

test('an Emerging Leader that ALSO has a production status is deduplicated: one screener signal carrying the emerging origin', () => {
  const both = emergingRow({ ticker: 'BOTH', status: 'Setup' });
  const json = screenerJson([both]);
  const prod = N.fromScreener(json);
  assert.strictEqual(prod.length, 1);
  assert.strictEqual(prod[0].alsoEmergingLeader, true, 'emerging evidence origin retained as metadata');
  assert.strictEqual(prod[0].evidenceFamilies.includes('priceTrend'), true);
  // No double count: the research lane refuses the row with an explicit reason.
  const { rows, dropped } = N.mapEmergingLeaderRows(json);
  assert.strictEqual(rows.length, 0);
  assert.deepStrictEqual(dropped, [{ ticker: 'BOTH', reason: 'duplicate-production-signal' }]);
  // And the metadata does not change the production confidence (no boost).
  const withoutFlag = N.fromScreener(screenerJson([{ ...both, emergingLeader: false }]));
  assert.strictEqual(prod[0].rawConfidence, withoutFlag[0].rawConfidence);
});

test('shadow Emerging signal cannot boost or originate a production score (board byte-identical)', () => {
  const base = { screener: screenerJson([emergingRow({ ticker: 'PRDA', status: 'Breakout', emergingLeader: false })]) };
  const withEmerging = { screener: screenerJson([emergingRow({ ticker: 'PRDA', status: 'Breakout', emergingLeader: false }), emergingRow()]) };
  const p1 = buildToday(base, null, null, null);
  const p2 = buildToday(withEmerging, null, null, null);
  const proj = p => Object.values(p.horizons).flat().map(x => ({ id: x.id, rank: x.rank, score: x.score }));
  assert.deepStrictEqual(proj(p2), proj(p1), 'production board unchanged by the standalone emerging row');
  // …but the research lane captured it.
  const inv = p2.swingResearch.inventory.filter(r => r.researchLane === 'emergingLeader');
  assert.strictEqual(inv.length, 1);
  assert.strictEqual(inv[0].ticker, 'EMRG');
  assert.strictEqual(p1.swingResearch.inventory.filter(r => r.researchLane === 'emergingLeader').length, 0);
});

test('promotion can only come from the strategy registry — never a UI flag or option', () => {
  const json = screenerJson([emergingRow()]);
  // Default registry: shadow → the gated live adapter emits nothing.
  assert.strictEqual(N.fromEmergingLeader(json).length, 0);
  // A UI-style flag changes nothing.
  assert.strictEqual(N.fromEmergingLeader(json, { promoted: true, uiFlag: true, force: true }).length, 0);
  // Only an explicit registry maturity flip enables the rows.
  const promotedRegistry = [{ id: 'emergingleader', maturity: 'production' }];
  const rows = N.fromEmergingLeader(json, { registry: promotedRegistry });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].section, 'EmergingLeader');
  // A typo'd maturity fails closed.
  assert.strictEqual(N.fromEmergingLeader(json, { registry: [{ id: 'emergingleader', maturity: 'prodcution' }] }).length, 0);
});

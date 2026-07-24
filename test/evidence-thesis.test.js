'use strict';
const test = require('node:test');
const assert = require('node:assert');

const schema = require('../lib/evidence-schema');
const { clusterEvents } = require('../lib/evidence-cluster');
const { scoreConsensus } = require('../lib/evidence-consensus');
const { buildThesisChange, directionalPressure } = require('../lib/thesis-change');
const routes = require('../lib/evidence-routes');

function ev(raw, sources = []) {
  return schema.normalizeEvent(raw, { ticker: raw.ticker || 'ABC', sources, detectedAt: raw.detectedAt || '2026-07-24' });
}

// ── Thesis change ──────────────────────────────────────────────────────────────
test('strong positive events → strengthened thesis, swing+long horizon', () => {
  const day = '2026-07-24';
  const e1 = ev({ ticker: 'ABC', claim: 'ABC raises FY guidance sharply', eventType: 'guidance', direction: 'positive', affectedHorizon: 'both', materialityScore: 0.9, noveltyScore: 0.8, catalystDate: day }, [{ url: 'https://www.businesswire.com/x' }]);
  const e2 = ev({ ticker: 'ABC', claim: 'ABC CEO buys $5M stock', eventType: 'insider_activity', direction: 'positive', affectedHorizon: 'long_term', materialityScore: 0.7, noveltyScore: 0.7, catalystDate: day }, [{ url: 'https://www.sec.gov/x' }]);
  const clusters = clusterEvents([e1, e2]);
  const consensus = scoreConsensus({ clusters, marketConfirmation: 0.6, regimeFit: 0.4 });
  const t = buildThesisChange({ ticker: 'ABC', clusters, consensus });
  assert.equal(t.changed, true);
  assert.ok(['improving', 'strengthened'].includes(t.level));
  assert.equal(t.horizon, 'both');
  assert.ok(t.directionPressure > 0);
  assert.ok(t.drivers.length >= 1);
});

test('a lone negative guidance cut → weakening thesis', () => {
  const e1 = ev({ ticker: 'XYZ', claim: 'XYZ slashes guidance on demand slump', eventType: 'guidance', direction: 'negative', affectedHorizon: 'both', materialityScore: 0.9, noveltyScore: 0.8 }, [{ url: 'https://www.reuters.com/x' }]);
  const clusters = clusterEvents([e1]);
  const consensus = scoreConsensus({ clusters });
  const t = buildThesisChange({ ticker: 'XYZ', clusters, consensus });
  assert.ok(['deteriorating', 'weakened'].includes(t.level));
  assert.ok(t.directionPressure < 0);
});

test('no events → level none, changed false', () => {
  const t = buildThesisChange({ ticker: 'ABC', clusters: [], consensus: null });
  assert.equal(t.changed, false);
  assert.equal(t.level, 'none');
});

test('directionalPressure weights material+novel events over trivial ones', () => {
  const big = ev({ ticker: 'A', claim: 'big', direction: 'positive', materialityScore: 1, noveltyScore: 1 });
  const trivial = ev({ ticker: 'A', claim: 'small', direction: 'negative', materialityScore: 0.05, noveltyScore: 0.05 });
  assert.ok(directionalPressure([big, trivial]) > 0.5, 'the material positive should dominate');
});

// ── Route pure helpers ──────────────────────────────────────────────────────────
test('regimeFitOf maps risk-off negative, risk-on positive', () => {
  assert.ok(routes.regimeFitOf('risk-off') < 0);
  assert.ok(routes.regimeFitOf('risk-on') > 0);
  assert.equal(routes.regimeFitOf('neutral'), 0);
});

test('marketConfirmationOf: momentum agreeing with direction confirms, opposing contradicts', () => {
  assert.ok(routes.marketConfirmationOf({ mom: 8 }, 'positive') > 0);
  assert.ok(routes.marketConfirmationOf({ mom: 8 }, 'negative') < 0);
  assert.equal(routes.marketConfirmationOf({ mom: null }, 'positive'), null);
  assert.equal(routes.marketConfirmationOf({ mom: 8 }, 'neutral'), null);
});

test('rotateByDay covers the full list across days (count-neutral)', () => {
  const arr = ['a', 'b', 'c', 'd', 'e'];
  const r = routes.rotateByDay(arr, '2026-07-24');
  assert.equal(r.length, arr.length);
  assert.deepEqual([...r].sort(), [...arr].sort());
});

test('filterView splits improving vs deteriorating vs swing vs longterm', () => {
  const mk = (level, horizon) => ({ thesis: { changed: true, level, horizon }, consensus: { score: 50, direction: 'positive', subscores: {}, hasPrimarySource: true } });
  const results = [mk('improving', 'swing'), mk('weakened', 'long_term'), mk('strengthened', 'both')];
  assert.equal(routes.filterView(results, 'improving').length, 2); // improving + strengthened
  assert.equal(routes.filterView(results, 'deteriorating').length, 1);
  assert.equal(routes.filterView(results, 'swing').length, 2); // swing + both
  assert.equal(routes.filterView(results, 'longterm').length, 2); // long_term + both
});

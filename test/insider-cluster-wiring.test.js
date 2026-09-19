'use strict';
// The insider-cluster shadow ledger is wired end-to-end: contract, section map, registry
// (shadow, weight 0, policy cohort), warm chain (own root, last wave, muted in health),
// privileged op, scoreboard fold, UI label. Each assertion cites the source it pins.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SC = require('../lib/strategy-contracts');
const REG = require('../lib/strategy-registry');
const WC = require('../lib/warm-chains');
const { BACKGROUND_CHAINS } = require('../lib/health');
const D = require('../lib/decision');
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('contract: next-open, 1m, long, SPY+sector, cost by dollar volume; section maps to the id', () => {
  const c = SC.contractFor('insidercluster');
  assert.ok(c); assert.equal(c.metric, '1m'); assert.equal(c.side, 'long'); assert.equal(c.fillPolicy, 'next-session-open'); assert.equal(c.fillVerified, false);
  assert.deepEqual(c.benchmark, ['SPY', 'sector']); assert.equal(c.episodeCooldownSessions, 21);
  assert.equal(SC.SECTION_TO_ID.InsiderCluster, 'insidercluster');
  assert.equal(SC.contractForSection('InsiderCluster'), c);
  assert.equal(SC.metricFor('insidercluster', '5d').metric, '1m');
});

test('registry: shadow, non-core, policy cohort CLUSTER, criteria carry the robust gates', () => {
  const list = REG.STRATEGY_REGISTRY || REG.REGISTRY || REG.strategies || REG;
  const arr = Array.isArray(list) ? list : (Array.isArray(list.STRATEGIES) ? list.STRATEGIES : Object.values(list).find(Array.isArray));
  const e = arr.find(x => x && x.id === 'insidercluster');
  assert.ok(e, 'registered');
  assert.equal(e.maturity, 'shadow'); assert.equal(e.core, false); assert.equal(e.section, 'InsiderCluster'); assert.equal(e.horizon, 'position');
  assert.deepEqual(e.policyTiers, ['CLUSTER']);
  assert.match(e.criteria, /median > 0/); assert.match(e.criteria, /top 1% of episodes/); assert.match(e.criteria, /≥50 resolved episodes over ≥20 independent dates/);
  assert.match(e.note, /MUST NOT originate, boost, or add verdict weight/);
  assert.equal(D.SOURCE_FAMILY.insidercluster, 'insider', 'every SECTION_TO_ID id resolves to an evidence family');
});

test('warm chain: own root, dispatched in the last wave, muted as a background chain', () => {
  assert.deepEqual(WC.CHAINS.insidercluster, ['op=insiderclustertick']);
  assert.ok(WC.ROOT_CHAINS.includes('insidercluster'));
  assert.ok(WC.dispatchDelayMs(WC.ROOT_CHAINS.length - 1) <= 90000, 'the last wave must still fit the drain');
  assert.ok(BACKGROUND_CHAINS.has('insidercluster'));
});

test('tracker: tick is privileged, read is public, both wired; scoreboard folds the ledger; UI labels the section', () => {
  const tracker = src('api/tracker.js');
  const priv = tracker.slice(tracker.indexOf('const PRIVILEGED_OPS'), tracker.indexOf('const EXPENSIVE_OPS'));
  assert.match(priv, /'insiderclustertick'/);
  assert.doesNotMatch(priv, /'insidercluster'[,\s]/, 'the public read must not be privileged');
  assert.match(tracker, /op === 'insidercluster'\) return require\('\.\.\/lib\/insider-cluster-routes'\)\.runInsiderCluster/);
  assert.match(tracker, /op === 'insiderclustertick'\) return require\('\.\.\/lib\/insider-cluster-routes'\)\.runInsiderClusterTick/);
  const apex = src('lib/apex-routes.js');
  assert.match(apex, /load\('readAllInsiderClusterDays'/);
  assert.match(apex, /sectionRows\(icDays, 'InsiderCluster'\)/);
  assert.match(apex, /InsiderCluster:\$\{p\.tier\}:\$\{p\.ticker\}/);
  assert.match(apex, /rawAnom\.length \+ rawIC\.length/, 'loggedRows counts the new ledger');
  assert.match(src('public/js/app.js'), /InsiderCluster: '🧾 Insider Cluster Buys/);
});

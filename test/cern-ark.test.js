'use strict';
// ARK forced-flow types inside CERN: the two logOnly types, persisted-state migration (a
// type added after apex/cern.json was first written must still be accepted), the decay
// ledger's side mapping, the capture-chain ordering, the registry rows, and the tab labels.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CERN, EVENT_TYPES } = require('../lib/cern');
const { cernPicksFrom } = require('../lib/apex-routes');
const WC = require('../lib/warm-chains');
const HR = require('../lib/research/hypothesis-registry');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('ARK_NET_BUY / ARK_NET_SELL exist as logOnly (weight-0 shadow) types on a 21-session horizon', () => {
  for (const t of ['ARK_NET_BUY', 'ARK_NET_SELL']) {
    assert.ok(EVENT_TYPES[t], `${t} missing`);
    assert.equal(EVENT_TYPES[t].logOnly, true, `${t} must never produce a TRADE/PROBE`);
    assert.equal(EVENT_TYPES[t].horizon, 21);
  }
});

test('CERN.load migrates a persisted state that predates a type: the new type is added with fresh priors, existing posteriors untouched', () => {
  // Arrange — a state written when only the original seven types existed (the live
  // apex/cern.json shape as of 2026-10-02).
  const legacy = CERN.freshState();
  for (const k of Object.keys(legacy.types)) if (!['INDEX_DELETE', 'FIRE_SALE'].includes(k)) delete legacy.types[k];
  legacy.types.INDEX_DELETE.mu = 0.91; legacy.types.INDEX_DELETE.n = 7;
  const json = JSON.stringify(legacy);

  // Act
  const c = CERN.load(json);

  // Assert — every current type present; the old posterior preserved; migration logged.
  assert.deepEqual(Object.keys(c.s.types).sort(), Object.keys(EVENT_TYPES).sort());
  assert.equal(c.s.types.INDEX_DELETE.mu, 0.91);
  assert.equal(c.s.types.INDEX_DELETE.n, 7);
  assert.equal(c.s.types.ARK_NET_BUY.n, 0);
  assert.equal(c.s.types.ARK_NET_BUY.mu, EVENT_TYPES.ARK_NET_BUY.priorKappa);
  assert.equal(c.s.types.ARK_NET_BUY.cfg.logOnly, true);
  const added = c.s.changeLog.filter((x) => x.type === 'TYPE_ADDED').map((x) => x.eventType).sort();
  assert.ok(added.includes('ARK_NET_BUY') && added.includes('INDEX_DELETE_SMID'));
  assert.equal(JSON.parse(json).types.ARK_NET_BUY, undefined, 'the caller’s input object is not mutated');
  // And the migrated engine now ACCEPTS the event (it used to return false silently).
  assert.equal(c.addEvent({ type: 'ARK_NET_BUY', symbol: 'AAA', dateMs: Date.parse('2026-10-01T00:00:00Z'), sessionDate: '2026-10-02', direction: -1, estFlowShares: 1 }), true);
  assert.equal(c.addEvent({ type: 'INDEX_DELETE_SMID', symbol: 'BBB', dateMs: Date.parse('2026-10-01T00:00:00Z'), sessionDate: '2026-10-02', direction: -1, estFlowShares: 1 }), true);
});

test('CERN.load of a current state is a no-op migration (no TYPE_ADDED entries)', () => {
  const c = CERN.load(JSON.stringify(CERN.freshState()));
  assert.equal(c.s.changeLog.filter((x) => x.type === 'TYPE_ADDED').length, 0);
});

test('decay ledger side: ARK_NET_BUY is a long pick (pressure continuation), ARK_NET_SELL a short/avoid pick', () => {
  const rows = cernPicksFrom({ ledger: [
    { type: 'ARK_NET_BUY', symbol: 'AAA', dateMs: Date.parse('2026-10-01T00:00:00Z'), sessionDate: '2026-10-02', direction: -1 },
    { type: 'ARK_NET_SELL', symbol: 'BBB', dateMs: Date.parse('2026-10-01T00:00:00Z'), sessionDate: '2026-10-02', direction: 1 },
  ], archive: [] });
  const by = Object.fromEntries(rows.map((r) => [r.ticker, r]));
  assert.equal(by.AAA.short, false); assert.equal(by.AAA.tier, 'ARK_NET_BUY'); assert.equal(by.AAA.date, '2026-10-02');
  assert.equal(by.BBB.short, true); assert.equal(by.BBB.tier, 'ARK_NET_SELL');
});

test('capture chain runs op=arktick strictly BEFORE op=cerntick (the tick writes the trades doc cerntick ingests)', () => {
  const steps = WC.CHAINS.capture;
  const a = steps.indexOf('op=arktick'), c = steps.indexOf('op=cerntick');
  assert.ok(a >= 0, 'op=arktick missing from capture');
  assert.ok(c > a, 'op=cerntick must follow op=arktick');
  assert.ok(!WC.ROOT_CHAINS.includes('ark'), 'no new root chain — the nightly matrix is unchanged');
});

test('registry rows: buy-pressure and sell-avoid hypotheses are preregistered, open, weight-0, with placebo + min N stated', () => {
  for (const id of ['ark-net-buy-pressure', 'ark-net-sell-avoid']) {
    const h = HR.find(id);
    assert.ok(h, `${id} missing from the hypothesis registry`);
    assert.equal(h.status, 'open');
    assert.equal(h.mode, 'confirmatory');
    assert.ok(HR.validateHypothesis(h).valid);
    assert.match(h.primaryMetric, /126/, 'same-name placebo 126 sessions earlier');
    assert.match(h.primaryMetric + h.stoppingRule, /300/, 'minimum N 300');
    assert.match(h.baseline + h.primaryMetric, /ARKK/, 'ARKK return as an added factor control');
    assert.match(h.note + h.stoppingRule, /weight[- ]0|shadow/i);
  }
});

test('api/tracker: op=arktick is PRIVILEGED (bearer) and both ops are routed', () => {
  const tracker = read('api', 'tracker.js');
  const priv = tracker.slice(tracker.indexOf('const PRIVILEGED_OPS'), tracker.indexOf('const EXPENSIVE_OPS'));
  assert.match(priv, /'arktick'/);
  assert.match(tracker, /op === 'ark'\)/);
  assert.match(tracker, /op === 'arktick'\)/);
});

test('Events tab: the two ARK types have plain-English names and a Today-card label like their siblings', () => {
  const view = read('public', 'js', 'cern.js');
  assert.match(view, /ARK_NET_BUY: \{ name: '[^_']+'/);
  assert.match(view, /ARK_NET_SELL: \{ name: '[^_']+'/);
  const app = read('public', 'js', 'app.js');
  const lbl = app.slice(app.indexOf('const CERN_LBL'), app.indexOf('\n', app.indexOf('const CERN_LBL')));
  assert.match(lbl, /ARK_NET_BUY/); assert.match(lbl, /ARK_NET_SELL/);
});

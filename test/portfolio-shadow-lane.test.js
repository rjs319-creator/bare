'use strict';
// OPTIMIZER SHADOW LANE (optimizer-v1 wired into buildToday) — the contract under test:
//
//   1. NO INFLUENCE. The live book and every user-facing key of the payload are
//      deep-identical whether the optimizer runs, throws, or is absent. The shadow can
//      only ever ADD its own explicitly-shadowed key.
//   2. SHAPE. When sizing-eligible candidates exist, `portfolioShadow` carries
//      shadow:true, weights within the optimizer's caps, cash accounting, the honest
//      candidate-mapping counts, and the live-vs-shadow agreement diagnostic.
//   3. NEVER FAILS THE ENDPOINT. An optimizer throw is recorded as { shadow:true,
//      error } and op=today still answers ok:true.
//   4. HONEST EMPTY. No sizing-eligible candidates ⇒ an all-cash empty shadow book,
//      not a crash and not an invented position.
//
// The optimizer is stubbed via the module object (PO.optimizeBook) — decision-routes
// deliberately never destructures it, precisely so this suite can prove (1).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildToday, runToday } = require('../lib/decision-routes');
const PO = require('../lib/portfolio-optimizer');
const PF = require('../lib/decision-portfolio');
const { SOURCES } = require('./fixtures/today-sources');

// 'off' = the legacy escape hatch: sizingSet is the whole active board, so the shadow
// lane sees a real candidate set from the frozen fixture (under the default fail-closed
// mode this fixture has no governance doc, so every row is refused sizing — that path
// is exercised by the honest-empty test below).
// nowMs is pinned so the two comparison runs share one dataGate timestamp — the
// comparison must fail on INFLUENCE, never on the clock.
const NOW_MS = Date.UTC(2026, 7, 14, 12, 0, 0);
const OFF = { eligibilityMode: 'off', nowMs: NOW_MS };

// Async-safe stub: restored only after the run completes.
const withOptimizerStubbed = async (fn, run) => {
  const orig = PO.optimizeBook;
  PO.optimizeBook = fn;
  try { return await run(); } finally { PO.optimizeBook = orig; }
};

// Everything user-facing/deterministic in the payload EXCEPT the shadow key itself.
const liveView = (p) => {
  const { generatedAt, portfolioShadow, ...rest } = p;
  return rest;
};

test('shadow cannot influence: the entire live payload is deep-identical with the optimizer stubbed to throw', async () => {
  // Arrange/Act — one run with the real optimizer, one with it violently broken.
  const withOpt = buildToday(SOURCES, null, null, null, OFF);
  const withoutOpt = await withOptimizerStubbed(() => { throw new Error('stubbed out'); },
    () => buildToday(SOURCES, null, null, null, OFF));

  // Assert — the real run produced a book, the stubbed run recorded the failure...
  assert.equal(withOpt.portfolioShadow.error, undefined);
  assert.equal(withOpt.portfolioShadow.shadow, true);
  assert.equal(withoutOpt.portfolioShadow.shadow, true);
  assert.equal(withoutOpt.portfolioShadow.error, 'stubbed out');
  // ...and NOTHING else moved: live book, ranks, lanes, counts, opportunity — all of it.
  assert.deepEqual(liveView(withoutOpt), liveView(withOpt),
    'the optimizer must not be able to change a single live byte');
});

test('shadow shape: weights within caps, cash accounting, agreement diagnostic, honest mapping counts', () => {
  // Arrange/Act
  const p = buildToday(SOURCES, null, null, null, OFF);
  const sh = p.portfolioShadow;

  // Assert — explicit shadow identity.
  assert.equal(sh.method, 'optimizer-v1');
  assert.equal(sh.shadow, true);
  assert.equal(sh.liveWeight, 0);
  assert.match(sh.note, /influences nothing/i);
  assert.match(sh.riskModel, /no pairwise covariance/i);

  // A real book over this fixture: at least one allocated name, valid weights.
  assert.ok(Array.isArray(sh.selected) && sh.selected.length > 0, 'fixture must yield allocations');
  const gross = Object.values(sh.weights).reduce((a, w) => a + w, 0);
  assert.ok(gross <= 1 + 1e-9, 'never levered');
  for (const row of sh.selected) {
    assert.equal(typeof row.ticker, 'string');
    assert.ok(row.weight > 0 && row.weight <= sh.config.maxWeight + 1e-9, `weight ${row.weight} within name cap`);
    assert.equal(row.weight, sh.weights[row.ticker]);
  }
  assert.ok(Math.abs(sh.book.gross + sh.book.cash - 1) < 1e-6, 'gross + cash = 100%');
  assert.equal(sh.cash, sh.book.cash);

  // Candidate mapping is fully accounted for: eligible = mapped + no-net-EV + deduped.
  const cb = sh.candidateBasis;
  assert.equal(cb.sizingEligible, cb.mapped + cb.skippedNoNetEv + cb.dedupedByTicker);
  assert.ok(cb.skippedNoNetEv > 0, 'fixture leads without levels have no net-EV and must be counted out, not sized');
  assert.match(cb.fieldMapping, /cost\.netMovePct/);

  // Agreement diagnostic vs the live selection — names only.
  const liveTickers = new Set(p.portfolio.selected.map(x => x.ticker));
  const shadowTickers = new Set(sh.selected.map(x => x.ticker));
  const expectedOverlap = [...liveTickers].filter(t => shadowTickers.has(t)).length;
  assert.equal(sh.agreement.overlapCount, expectedOverlap);
  assert.ok(sh.agreement.jaccardVsLive === null
    || (sh.agreement.jaccardVsLive >= 0 && sh.agreement.jaccardVsLive <= 1));
  assert.deepEqual(new Set([...sh.agreement.onlyLive, ...sh.agreement.onlyShadow, ...[...liveTickers].filter(t => shadowTickers.has(t))]),
    new Set([...liveTickers, ...shadowTickers]), 'onlyLive/onlyShadow/overlap partition the union');
});

test('optimizer throw never fails the endpoint: op=today still answers ok:true with the error recorded', async () => {
  // Arrange — optimizer broken AND every upstream source offline.
  const origFetch = global.fetch;
  global.fetch = async () => { throw new Error('offline'); };
  let out = null;
  const res = { setHeader() {}, json(x) { out = x; return x; } };
  try {
    await withOptimizerStubbed(() => { throw new Error('boom'); },
      () => runToday({ query: {} }, res));
  } finally { global.fetch = origFetch; }

  // Assert
  assert.equal(out.ok, true, 'the endpoint must answer ok:true regardless of the shadow lane');
  assert.equal(out.portfolioShadow.shadow, true);
  assert.equal(out.portfolioShadow.error, 'boom');
  assert.ok(out.portfolio, 'the live book is still served');
});

test('empty candidate set: honest all-cash empty shadow, no crash', () => {
  // Arrange/Act — the default fail-closed mode with no governance doc refuses sizing for
  // every row, so the sizing-eligible set is genuinely empty (golden: sizingEligible 0).
  const p = buildToday(SOURCES, null, null, null);

  // Assert
  assert.equal(p.counts.sizingEligible, 0, 'precondition: nothing is sizing-eligible');
  const sh = p.portfolioShadow;
  assert.equal(sh.shadow, true);
  assert.equal(sh.error, undefined, 'an empty set is not an error');
  assert.deepEqual(sh.selected, []);
  assert.deepEqual(sh.weights, {});
  assert.equal(sh.cash, 1);
  assert.deepEqual(sh.agreement, { overlapCount: 0, jaccardVsLive: null, onlyLive: [], onlyShadow: [] });
  assert.equal(sh.candidateBasis.sizingEligible, 0);
});

test('daily log row carries the compact shadow record on the SAME opportunity-log doc (no new write)', async () => {
  // Arrange — a store that captures writes; ?log=1 triggers the existing daily log path.
  const store = require('../lib/store');
  const origHas = store.hasStore, origRead = store.readJSON, origWrite = store.writeJSON;
  const writes = {};
  store.hasStore = () => true;
  store.readJSON = async () => null;
  store.writeJSON = async (path, doc) => { writes[path] = doc; };
  const origFetch = global.fetch;
  global.fetch = async () => { throw new Error('offline'); };
  let out = null;
  const res = { setHeader() {}, json(x) { out = x; return x; } };
  try {
    await runToday({ query: { log: '1' } }, res);
  } finally {
    global.fetch = origFetch;
    store.hasStore = origHas; store.readJSON = origRead; store.writeJSON = origWrite;
  }

  // Assert — the rolling opportunity log's daily row gained the additive shadow field.
  assert.equal(out.ok, true);
  const oppDoc = writes['today/opportunity-log.json'];
  assert.ok(oppDoc, 'the existing opportunity log is still written');
  const row = oppDoc.days[oppDoc.days.length - 1];
  assert.equal(row.portfolioShadow.method, 'optimizer-v1');
  assert.equal(row.portfolioShadow.shadow, true);
  assert.ok('weights' in row.portfolioShadow && 'cash' in row.portfolioShadow && 'agreement' in row.portfolioShadow);
  // And no shadow-specific Blob path appeared — the same three doc families as before.
  assert.ok(!Object.keys(writes).some(p => /shadow/i.test(p)), 'no new Blob write for the shadow lane');
});

test('the sector placeholder rule the shadow uses is the live book\'s own (exported, not duplicated)', () => {
  assert.equal(PF.knownSector('?'), null);
  assert.equal(PF.knownSector('n/a'), null);
  assert.equal(PF.knownSector(' Technology '), 'Technology');
});

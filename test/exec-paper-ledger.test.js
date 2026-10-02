'use strict';
// lib/exec-paper-ledger — pure order planning + reconciliation for the Alpaca paper ledger.
// Fixture: test/fixtures/session-board-sample.json (A/B/C/D/F rows, one short).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const L = require('../lib/exec-paper-ledger');

const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'session-board-sample.json'), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

test('snapshotIdOf: ET date from the session block, generatedAt fallback', () => {
  assert.equal(L.snapshotIdOf(FIXTURE), 'sb-2026-09-21');
  assert.equal(L.snapshotIdOf({ generatedAt: '2026-09-22T13:40:00.000Z' }), 'sb-2026-09-22');
  assert.equal(L.snapshotIdOf({}), null);
});

test('planOrders: one 1-share order per A/B row; C/D/F and held-out rows carry notPlaced reasons', () => {
  const plan = L.planOrders(FIXTURE);
  assert.equal(plan.snapshotId, 'sb-2026-09-21');
  assert.equal(plan.date, '2026-09-21');
  assert.deepEqual(plan.orders.map((o) => o.rowId).sort(), ['coremo:portfolio:IJKL', 'gapgo:intraday:ABCD']);
  const reasons = Object.fromEntries(plan.notPlaced.map((n) => [n.rowId, n.reason]));
  assert.equal(reasons['screener:swing:EFGH'], 'grade-below-B');
  assert.equal(reasons['crossasset:position:MNOP'], 'grade-below-B');
  assert.equal(reasons['downday:swing:QRST'], 'held-out', 'held-out beats the grade reason — the lane is proven negative');
  // every snapshot row id is accounted for exactly once
  const all = [...plan.orders.map((o) => o.rowId), ...plan.notPlaced.map((n) => n.rowId)].sort();
  assert.deepEqual(all, FIXTURE.items.map((i) => i.id).sort());
  for (const o of plan.orders) {
    assert.equal(o.body.qty, '1');
    assert.equal(o.clientOrderId, `sb-2026-09-21:${o.rowId}`);
    assert.equal(o.body.client_order_id, o.clientOrderId);
    assert.ok(o.clientOrderId.length <= L.MAX_CLIENT_ORDER_ID);
    assert.ok(['liquid', 'small', 'micro', 'biotech'].includes(o.costTier));
  }
  // input untouched
  assert.deepEqual(FIXTURE, JSON.parse(readFileSync(join(__dirname, 'fixtures', 'session-board-sample.json'), 'utf8')));
});

test('planOrders: entry above the reference price → stop_limit parent (exits armed on fill); at/through → limit bracket', () => {
  const plan = L.planOrders(FIXTURE);
  const abcd = plan.orders.find((o) => o.rowId === 'gapgo:intraday:ABCD');   // pre 21.35 < entry 21.4 → breakout
  assert.equal(abcd.entryType, 'stop_limit');
  assert.equal(abcd.body.type, 'stop_limit');
  assert.equal(abcd.body.stop_price, '21.40');
  assert.equal(abcd.body.limit_price, (21.4 * (1 + L.STOP_LIMIT_BUFFER_PCT / 100)).toFixed(2));
  assert.equal(abcd.body.order_class, undefined);
  assert.equal(abcd.body.time_in_force, 'gtc');
  assert.equal(abcd.body.side, 'buy');
  const ijkl = plan.orders.find((o) => o.rowId === 'coremo:portfolio:IJKL');   // prevClose 88 == entry 88 → pullback limit
  assert.equal(ijkl.entryType, 'limit');
  assert.equal(ijkl.body.order_class, 'bracket');
  assert.equal(ijkl.body.limit_price, '88.00');
  assert.deepEqual(ijkl.body.take_profit, { limit_price: '105.00' });
  assert.deepEqual(ijkl.body.stop_loss, { stop_price: '79.00' });
});

test('planOrders: short rows mirror the geometry (sell parent, take-profit below, stop above)', () => {
  const snap = clone(FIXTURE);
  const short = snap.items.find((i) => i.side === 'short');
  short.grade.letter = 'B'; short.flags.heldOut = false; short.flags.negativeLane = false;
  short.premarket = { preMarketPrice: 29.5 };
  const o = L.planOrders(snap).orders.find((x) => x.rowId === short.id);
  assert.ok(o, 'short row planned');
  assert.equal(o.body.side, 'sell');
  assert.equal(o.entryType, 'limit');
  assert.equal(o.body.take_profit.limit_price, '26.80');
  assert.equal(o.body.stop_loss.stop_price, '31.20');
  const exit = L.exitOrderBody(o);
  assert.equal(exit.side, 'buy');
  assert.equal(exit.order_class, 'oco');
  assert.equal(exit.client_order_id, `${o.clientOrderId}:exit`);
});

test('planOrders notPlaced reasons: no-stop, no-target, levels-inverted, sub-dollar, held-out, illiquid, bad-symbol, duplicate-symbol', () => {
  const base = clone(FIXTURE.items[2]);   // IJKL, A
  const mk = (patch, id) => ({ ...clone(base), id: id || base.id, ...patch });
  const snap = { ...clone(FIXTURE), items: [
    mk({ levels: { ...base.levels, stop: null } }, 'r:nostop'),
    mk({ levels: { ...base.levels, target: null } }, 'r:notarget'),
    mk({ levels: { ...base.levels, stop: 90 } }, 'r:inverted'),
    mk({ levels: { entry: 0.8, stop: 0.7, target: 1.1 } }, 'r:subdollar'),
    mk({ flags: { ...base.flags, heldOut: true } }, 'r:heldout'),
    mk({ liquidity: { dollarVol: 100000 } }, 'r:illiquid'),
    mk({ ticker: 'bad ticker!' }, 'r:badsym'),
    mk({}, 'r:dup1'),
    mk({}, 'r:dup2'),
  ] };
  const plan = L.planOrders(snap);
  const reasons = Object.fromEntries(plan.notPlaced.map((n) => [n.rowId, n.reason]));
  assert.equal(reasons['r:nostop'], 'no-stop');
  assert.equal(reasons['r:notarget'], 'no-target');
  assert.equal(reasons['r:inverted'], 'levels-inverted');
  assert.equal(reasons['r:subdollar'], 'sub-dollar');
  assert.equal(reasons['r:heldout'], 'held-out');
  assert.equal(reasons['r:illiquid'], 'illiquid');
  assert.equal(reasons['r:badsym'], 'bad-symbol');
  assert.equal(reasons['r:dup2'], 'duplicate-symbol');
  assert.deepEqual(plan.orders.map((o) => o.rowId), ['r:dup1']);
});

test('planOrders: empty / malformed snapshot → empty plan, never throws', () => {
  assert.deepEqual(L.planOrders(null).orders, []);
  assert.deepEqual(L.planOrders({ items: 'nope' }).orders, []);
  assert.equal(L.planOrders({ items: [] }).snapshotId, null);
});

// ── order normalisation + union-monotonic merge ─────────────────────────────────
const raw = (over = {}) => ({ id: 'o1', client_order_id: 'sb-2026-09-21:r1', symbol: 'ABCD', side: 'buy', type: 'stop_limit', status: 'new', qty: '1', filled_qty: '0', filled_avg_price: null, filled_at: null, submitted_at: '2026-09-21T13:35:00Z', limit_price: '21.51', stop_price: '21.40', legs: null, ...over });

test('normalizeOrder: strings → numbers, legs recursed, malformed → null', () => {
  const n = L.normalizeOrder(raw({ filled_qty: '1', filled_avg_price: '21.43', status: 'filled', legs: [raw({ id: 'l1', type: 'limit', side: 'sell', limit_price: '23.60' })] }));
  assert.equal(n.filledAvgPrice, 21.43);
  assert.equal(n.filledQty, 1);
  assert.equal(n.limitPrice, 21.51);
  assert.equal(n.legs[0].id, 'l1');
  assert.equal(n.legs[0].limitPrice, 23.6);
  assert.equal(L.normalizeOrder({ symbol: 'X' }), null);
  assert.equal(L.normalizeOrder('junk'), null);
});

test('mergeOrders: union by order id; status never regresses; fill fields never erased', () => {
  const a = L.normalizeOrder(raw({ status: 'filled', filled_qty: '1', filled_avg_price: '21.43', filled_at: '2026-09-21T14:00:00Z' }));
  const stale = L.normalizeOrder(raw({ status: 'new' }));
  const other = L.normalizeOrder(raw({ id: 'o2', client_order_id: 'sb-2026-09-21:r2' }));
  const merged = L.mergeOrders({ o1: a }, { o1: stale, o2: other });
  assert.equal(merged.o1.status, 'filled');
  assert.equal(merged.o1.filledAvgPrice, 21.43);
  assert.equal(Object.keys(merged).length, 2);
  // forward move wins
  const fwd = L.mergeOrders({ o1: stale }, { o1: a });
  assert.equal(fwd.o1.status, 'filled');
  // inputs untouched
  assert.equal(stale.status, 'new');
});

// ── reconcile ───────────────────────────────────────────────────────────────────
function planFor(items) { return L.planOrders({ ...clone(FIXTURE), items }); }
const longRow = () => ({ ...clone(FIXTURE.items[2]), premarket: { preMarketPrice: 88 } });   // IJKL entry 88 stop 79 target 105, R = 9

test('reconcile: unfilled parent → filled:false, exitKind none, null prices', () => {
  const plan = planFor([longRow()]);
  const cid = plan.orders[0].clientOrderId;
  const orders = { o1: L.normalizeOrder(raw({ client_order_id: cid, symbol: 'IJKL', type: 'limit', status: 'new' })) };
  const [row] = L.reconcile(plan, orders);
  assert.equal(row.filled, false); assert.equal(row.fillPx, null); assert.equal(row.exitKind, 'none'); assert.equal(row.realizedR, null); assert.equal(row.slippageVsFrozen, null);
  assert.equal(row.status, 'new');
});

test('reconcile: bracket target leg filled → exitKind target, realized R vs FROZEN risk, slippage sign adverse-positive', () => {
  const plan = planFor([longRow()]);
  const cid = plan.orders[0].clientOrderId;
  const parent = raw({ client_order_id: cid, symbol: 'IJKL', type: 'limit', status: 'filled', filled_qty: '1', filled_avg_price: '88.20', filled_at: '2026-09-21T14:00:00Z', legs: [
    raw({ id: 'tp', type: 'limit', side: 'sell', status: 'filled', filled_qty: '1', filled_avg_price: '105.00', filled_at: '2026-09-21T18:00:00Z' }),
    raw({ id: 'sl', type: 'stop', side: 'sell', status: 'canceled' }),
  ] });
  const [row] = L.reconcile(plan, { o1: L.normalizeOrder(parent) });
  assert.equal(row.filled, true);
  assert.equal(row.fillPx, 88.2);
  assert.equal(row.exitKind, 'target');
  assert.equal(row.exitPx, 105);
  assert.equal(row.realizedR, +((105 - 88.2) / 9).toFixed(3));
  assert.equal(row.realizedRetPct, +(((105 - 88.2) / 88.2) * 100).toFixed(3));
  assert.equal(row.slippageVsFrozen.px, +(88.2 - 88).toFixed(4));          // paid 0.20 above the frozen entry → adverse
  assert.equal(row.slippageVsFrozen.bps, +(((88.2 - 88) / 88) * 10000).toFixed(1));
});

test('reconcile: stop_limit parent + OCO exit stop filled → exitKind stop, negative R; placed :flat order → horizon', () => {
  const item = { ...longRow(), premarket: { preMarketPrice: 87 } };   // breakout → stop_limit parent
  const plan = planFor([item]);
  const o = plan.orders[0];
  assert.equal(o.entryType, 'stop_limit');
  const parent = raw({ client_order_id: o.clientOrderId, symbol: 'IJKL', status: 'filled', filled_qty: '1', filled_avg_price: '88.30', filled_at: '2026-09-21T14:10:00Z' });
  const oco = raw({ id: 'x1', client_order_id: `${o.clientOrderId}:exit`, type: 'limit', side: 'sell', status: 'canceled', legs: [
    raw({ id: 'x1s', type: 'stop', side: 'sell', status: 'filled', filled_qty: '1', filled_avg_price: '78.90', filled_at: '2026-09-21T16:00:00Z' }),
  ] });
  const [row] = L.reconcile(plan, { o1: L.normalizeOrder(parent), x1: L.normalizeOrder(oco) });
  assert.equal(row.exitKind, 'stop');
  assert.equal(row.exitPx, 78.9);
  assert.ok(row.realizedR < -1, 'stop filled through the level → worse than −1R');
  assert.equal(row.exitArmed, true);

  // horizon flatten: a close-position order recorded under the :flat tag
  const flat = raw({ id: 'f1', client_order_id: 'alpaca-generated', type: 'market', side: 'sell', status: 'filled', filled_qty: '1', filled_avg_price: '90.00', filled_at: '2026-09-21T19:52:00Z' });
  const oco2 = { ...L.normalizeOrder(oco), legs: [{ ...L.normalizeOrder(oco).legs[0], status: 'canceled', filledAvgPrice: null, filledAt: null }] };
  const [row2] = L.reconcile(plan, { o1: L.normalizeOrder(parent), x1: oco2, f1: L.normalizeOrder(flat) }, { placed: { [`${o.clientOrderId}:flat`]: { orderId: 'f1', ok: true } } });
  assert.equal(row2.exitKind, 'horizon');
  assert.equal(row2.exitPx, 90);
  assert.equal(row2.realizedR, +((90 - 88.3) / 9).toFixed(3));
});

test('reconcile: short → mirrored R and slippage sign', () => {
  const snap = clone(FIXTURE);
  const s = snap.items.find((i) => i.side === 'short');   // entry 29.5 stop 31.2 target 26.8, R = 1.7
  s.grade.letter = 'A'; s.flags.heldOut = false; s.premarket = { preMarketPrice: 29.5 };
  const plan = L.planOrders({ ...snap, items: [s] });
  const cid = plan.orders[0].clientOrderId;
  const parent = raw({ client_order_id: cid, symbol: s.ticker, type: 'limit', side: 'sell', status: 'filled', filled_qty: '1', filled_avg_price: '29.40', filled_at: '2026-09-21T14:00:00Z', legs: [
    raw({ id: 'tp', type: 'limit', side: 'buy', status: 'filled', filled_qty: '1', filled_avg_price: '26.80', filled_at: '2026-09-21T17:00:00Z' }),
  ] });
  const [row] = L.reconcile(plan, { o1: L.normalizeOrder(parent) });
  assert.equal(row.exitKind, 'target');
  assert.equal(row.realizedR, +((29.4 - 26.8) / 1.7).toFixed(3));
  assert.equal(row.slippageVsFrozen.px, +(29.5 - 29.4).toFixed(4), 'sold 0.10 below the frozen entry → adverse positive');
});

// ── ledger doc lifecycle ─────────────────────────────────────────────────────────
test('newLedgerDoc → recordPlacements → applyPoll: immutable, union-monotonic, polls capped', () => {
  const plan = planFor([longRow()]);
  const doc0 = L.newLedgerDoc({ snapshot: FIXTURE, plan, at: '2026-09-21T13:35:00Z' });
  assert.equal(doc0.version, L.LEDGER_VERSION);
  assert.deepEqual(doc0.snapshotRowIds, FIXTURE.items.map((i) => i.id));
  const cid = plan.orders[0].clientOrderId;
  const doc1 = L.recordPlacements(doc0, [{ key: cid, ok: true, orderId: 'o1', status: 'accepted', at: '2026-09-21T13:35:01Z' }]);
  assert.equal(doc0.placed[cid], undefined, 'input not mutated');
  assert.equal(doc1.placed[cid].orderId, 'o1');
  // a later failure never overwrites an ok placement
  const doc2 = L.recordPlacements(doc1, [{ key: cid, ok: false, error: 'boom', at: '2026-09-21T13:36:00Z' }]);
  assert.equal(doc2.placed[cid].ok, true);
  const filled = L.normalizeOrder(raw({ client_order_id: cid, symbol: 'IJKL', type: 'limit', status: 'filled', filled_qty: '1', filled_avg_price: '88.00', filled_at: '2026-09-21T14:00:00Z' }));
  const doc3 = L.applyPoll(doc2, { ordersById: { o1: filled }, at: '2026-09-21T14:05:00Z' });
  assert.equal(doc3.orders.o1.status, 'filled');
  assert.equal(doc3.rows[0].filled, true);
  assert.equal(doc3.polls.length, 1);
  assert.equal(doc3.polls[0].filled, 1);
  // stale poll cannot regress
  const doc4 = L.applyPoll(doc3, { ordersById: { o1: L.normalizeOrder(raw({ client_order_id: cid, symbol: 'IJKL', status: 'new' })) }, at: '2026-09-21T14:35:00Z' });
  assert.equal(doc4.orders.o1.status, 'filled');
  let d = doc4;
  for (let i = 0; i < L.POLL_CAP + 5; i++) d = L.applyPoll(d, { ordersById: {}, at: `2026-09-21T15:${String(i % 60).padStart(2, '0')}:00Z` });
  assert.equal(d.polls.length, L.POLL_CAP);
});

test('pendingPlacements / exitsToArm / rowsToFlatten select exactly the work left', () => {
  const item = { ...longRow(), premarket: { preMarketPrice: 87 } };   // stop_limit → exit must be armed on fill
  const intraday = { ...clone(FIXTURE.items[0]), premarket: { preMarketPrice: 21.4 } };   // ABCD B intraday, limit bracket
  const plan = planFor([item, intraday]);
  const doc0 = L.newLedgerDoc({ snapshot: FIXTURE, plan, at: '2026-09-21T13:35:00Z' });
  assert.equal(L.pendingPlacements(doc0).length, 2);
  const [a, b] = plan.orders;
  const doc1 = L.recordPlacements(doc0, [{ key: a.clientOrderId, ok: true, orderId: 'o1', status: 'accepted', at: 't' }, { key: b.clientOrderId, ok: true, orderId: 'o2', status: 'accepted', at: 't' }]);
  assert.equal(L.pendingPlacements(doc1).length, 0);
  const orders = {
    o1: L.normalizeOrder(raw({ client_order_id: a.clientOrderId, symbol: 'IJKL', status: 'filled', filled_qty: '1', filled_avg_price: '88.10', filled_at: 't' })),
    o2: L.normalizeOrder(raw({ id: 'o2', client_order_id: b.clientOrderId, symbol: 'ABCD', type: 'limit', status: 'filled', filled_qty: '1', filled_avg_price: '21.40', filled_at: 't', legs: [raw({ id: 'l', type: 'stop', status: 'new' })] })),
  };
  const doc2 = L.applyPoll(doc1, { ordersById: orders, at: 't2' });
  assert.deepEqual(L.exitsToArm(doc2).map((o) => o.rowId), [item.id], 'only the stop_limit parent needs an OCO exit');
  assert.deepEqual(L.rowsToFlatten(doc2).map((o) => o.rowId), [intraday.id], 'only filled, still-open INTRADAY rows are flattened');
  const doc3 = L.recordPlacements(doc2, [{ key: `${a.clientOrderId}:exit`, ok: true, orderId: 'x1', status: 'accepted', at: 't3' }]);
  assert.deepEqual(L.exitsToArm(doc3), []);
});

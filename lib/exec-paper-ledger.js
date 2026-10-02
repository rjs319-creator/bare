'use strict';
// PAPER-EXECUTION LEDGER (paper-exec-v1) — pure order planning + reconciliation for the
// Alpaca PAPER account that shadows the Session Board (proposal #28, GitHub scan 2026-10-02).
//
// WHAT IT MEASURES. The Scoreboard resolves every row on DAILY bars, which cannot say
// whether the stop or the target was touched first inside one session, and it charges
// friction from lib/costs.js TIERS, which are priors. One 1-share order per A/B row at the
// FROZEN entry/stop/target gives timestamped fills: fill rate per grade/time frame, the
// stop-first vs target-first answer, and a `fill − frozenLevel` distribution per cost tier.
// Alpaca paper fills on NBBO touch with no queue or impact, so every friction number here
// is a LOWER BOUND, never realism. Sizing is irrelevant to fillability — hence 1 share.
//
// PURE: no I/O, no clock (every timestamp is injected), no mutation of inputs — every
// function returns a new object. lib/exec-paper-routes.js owns the fetches and the store.
//
// ORDER SHAPES. Alpaca's bracket parent may only be `market` or `limit`, so:
//   • price already at/through the entry (pullback) → LIMIT parent, order_class bracket
//     (take-profit + stop legs attached at placement);
//   • price still short of the entry (breakout)     → STOP_LIMIT parent alone; the OCO exit
//     (take-profit limit + stop) is armed by the next poll once the parent has filled.
// A limit at a level above the market would fill at the ask immediately — that would
// measure a chase, not the plan — which is why the breakout case is a stop entry.

const { tierForPick } = require('./costs');

const LEDGER_VERSION = 'paper-exec-v1';
const TRADEABLE_GRADES = Object.freeze(new Set(['A', 'B']));
const QTY = '1';
const TIME_IN_FORCE = 'gtc';
// Breakout stop-limit: the limit sits this far beyond the trigger so a fast tape still
// fills while a gap through the level is refused (a resting stop-market would chase it).
const STOP_LIMIT_BUFFER_PCT = 0.5;
// Sub-$1 names price in $0.0001 increments and are not what the board grades A/B; refuse.
const MIN_PRICE = 1;
// lib/session-board THIN_DOLLAR_VOL — below it a 1-share paper fill says nothing useful.
const ILLIQUID_DOLLAR_VOL = 500_000;
const MAX_CLIENT_ORDER_ID = 128;                  // Alpaca's documented cap
const POLL_CAP = 60;                              // 13:35 → 20:05 UTC every 30 min is 14; headroom for manual runs
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const INTRADAY = 'intraday';

// Order status rank — a poll may only move an order FORWARD through this ladder, so a
// stale listing (Blob read-back lag, an out-of-order poll) can never un-fill an order.
const STATUS_RANK = Object.freeze({
  pending_new: 1, accepted_for_bidding: 1,
  new: 2, accepted: 2, held: 2,
  pending_cancel: 3, pending_replace: 3,
  partially_filled: 4,
  canceled: 5, expired: 5, rejected: 5, replaced: 5, done_for_day: 5, stopped: 5, suspended: 5, calculated: 5,
  filled: 6,
});
const EXIT_KIND_BY_TYPE = Object.freeze({ limit: 'target', stop: 'stop', stop_limit: 'stop', trailing_stop: 'stop' });

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : null));
const str = (v) => (typeof v === 'string' && v ? v : null);
const fmtPx = (p) => p.toFixed(2);
const r3 = (v) => +v.toFixed(3);
const r4 = (v) => +v.toFixed(4);
const dirOf = (side) => (side === 'short' ? -1 : 1);
const dateOfIso = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);

// ── Snapshot identity ────────────────────────────────────────────────────────
function snapshotDateOf(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return dateOfIso(snapshot.session && snapshot.session.etDate) || dateOfIso(snapshot.generatedAt);
}
function snapshotIdOf(snapshot) {
  const d = snapshotDateOf(snapshot);
  return d ? `sb-${d}` : null;
}

// ── Planning ─────────────────────────────────────────────────────────────────
function refPriceOf(item) {
  const pre = item.premarket || {};
  const live = item.live || {};
  return num(live.price) ?? num(pre.preMarketPrice) ?? num(item.levels && item.levels.prevClose) ?? null;
}

// The first reason a row cannot be traded, or null when it can.
function notPlacedReason(item, seenSymbols) {
  const grade = item.grade && item.grade.letter;
  if (item.flags && item.flags.heldOut) return 'held-out';
  if (!TRADEABLE_GRADES.has(grade)) return 'grade-below-B';
  if (!TICKER_RE.test(String(item.ticker || ''))) return 'bad-symbol';
  const L = item.levels || {};
  const entry = num(L.entry), stop = num(L.stop), target = num(L.target);
  if (entry == null) return 'no-entry';
  if (stop == null) return 'no-stop';
  if (target == null) return 'no-target';
  if (entry < MIN_PRICE || stop < MIN_PRICE || target < MIN_PRICE) return 'sub-dollar';
  const dir = dirOf(item.side);
  if (!((entry - stop) * dir > 0 && (target - entry) * dir > 0)) return 'levels-inverted';
  const dv = num(item.liquidity && item.liquidity.dollarVol) ?? num(item.avgDollarVol);
  if (dv != null && dv < ILLIQUID_DOLLAR_VOL) return 'illiquid';
  if (seenSymbols.has(item.ticker)) return 'duplicate-symbol';
  return null;
}

function parentBody(order) {
  const { symbol, side, entry, stop, target, clientOrderId, entryType } = order;
  const dir = dirOf(side);
  const base = { symbol, qty: QTY, side: dir > 0 ? 'buy' : 'sell', time_in_force: TIME_IN_FORCE, client_order_id: clientOrderId, extended_hours: false };
  if (entryType === 'stop_limit') {
    return { ...base, type: 'stop_limit', stop_price: fmtPx(entry), limit_price: fmtPx(entry * (1 + dir * STOP_LIMIT_BUFFER_PCT / 100)) };
  }
  return { ...base, type: 'limit', limit_price: fmtPx(entry), order_class: 'bracket', take_profit: { limit_price: fmtPx(target) }, stop_loss: { stop_price: fmtPx(stop) } };
}

// OCO exit for a filled stop_limit parent: take-profit limit + stop, opposite side.
function exitOrderBody(order) {
  const dir = dirOf(order.side);
  return {
    symbol: order.symbol, qty: QTY, side: dir > 0 ? 'sell' : 'buy', type: 'limit', time_in_force: TIME_IN_FORCE,
    order_class: 'oco', take_profit: { limit_price: fmtPx(order.target) }, stop_loss: { stop_price: fmtPx(order.stop) },
    client_order_id: `${order.clientOrderId}:exit`,
  };
}

function plannedOrder(item, snapshotId) {
  const L = item.levels;
  const entry = num(L.entry), stop = num(L.stop), target = num(L.target);
  const ref = refPriceOf(item);
  const dir = dirOf(item.side);
  // At/through the entry (or no reference at all) → resting limit; short of it → stop entry.
  const entryType = ref != null && (ref - entry) * dir < 0 ? 'stop_limit' : 'limit';
  const order = {
    rowId: item.id, clientOrderId: `${snapshotId}:${item.id}`, symbol: item.ticker, side: item.side === 'short' ? 'short' : 'long',
    grade: item.grade.letter, timeframe: (item.timeframe && item.timeframe.key) || item.horizon || null,
    section: item.section || null, costTier: tierForPick({ section: item.section, scope: item.scope }),
    entry, stop, target, risk: r4(Math.abs(entry - stop)), refPrice: ref, entryType,
  };
  return { ...order, body: parentBody(order) };
}

// planOrders(snapshot) → { snapshotId, date, orders:[…], notPlaced:[{rowId,ticker,reason}] }
function planOrders(snapshot) {
  const snapshotId = snapshotIdOf(snapshot);
  const date = snapshotDateOf(snapshot);
  const items = snapshot && Array.isArray(snapshot.items) ? snapshot.items.filter((i) => i && i.id) : [];
  const orders = [];
  const notPlaced = [];
  const seen = new Set();
  for (const item of items) {
    const reason = snapshotId ? notPlacedReason(item, seen) : 'no-snapshot-id';
    if (reason) { notPlaced.push({ rowId: item.id, ticker: item.ticker || null, grade: (item.grade && item.grade.letter) || null, reason }); continue; }
    const o = plannedOrder(item, snapshotId);
    if (o.clientOrderId.length > MAX_CLIENT_ORDER_ID) { notPlaced.push({ rowId: item.id, ticker: item.ticker, grade: o.grade, reason: 'client-order-id-too-long' }); continue; }
    seen.add(item.ticker);
    orders.push(o);
  }
  return { version: LEDGER_VERSION, snapshotId, date, orders, notPlaced };
}

// ── Alpaca order normalisation + union-monotonic merge ──────────────────────
function normalizeOrder(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(raw.id), symbol = str(raw.symbol), status = str(raw.status);
  if (!id || !symbol || !status) return null;
  const legs = Array.isArray(raw.legs) ? raw.legs.map(normalizeOrder).filter(Boolean) : [];
  return {
    id, clientOrderId: str(raw.client_order_id), symbol, side: str(raw.side), type: str(raw.type), status,
    qty: num(raw.qty), filledQty: num(raw.filled_qty) ?? 0, filledAvgPrice: num(raw.filled_avg_price), filledAt: str(raw.filled_at),
    submittedAt: str(raw.submitted_at), limitPrice: num(raw.limit_price), stopPrice: num(raw.stop_price), legs,
  };
}

const rank = (o) => (o && STATUS_RANK[o.status]) || 0;

function mergeOne(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  const [lead, trail] = rank(next) >= rank(prev) ? [next, prev] : [prev, next];
  const legsById = mergeOrders(Object.fromEntries((trail.legs || []).map((l) => [l.id, l])), Object.fromEntries((lead.legs || []).map((l) => [l.id, l])));
  return {
    ...trail, ...lead,
    filledAvgPrice: lead.filledAvgPrice ?? trail.filledAvgPrice, filledAt: lead.filledAt ?? trail.filledAt,
    filledQty: Math.max(lead.filledQty || 0, trail.filledQty || 0), legs: Object.values(legsById),
  };
}

// mergeOrders(existing, incoming) → new map keyed by order id; status only moves forward.
function mergeOrders(existing = {}, incoming = {}) {
  const out = { ...existing };
  for (const [id, o] of Object.entries(incoming || {})) out[id] = mergeOne(existing[id], o);
  return out;
}

// ── Reconciliation ───────────────────────────────────────────────────────────
function byClientId(ordersById) {
  const m = new Map();
  for (const o of Object.values(ordersById || {})) if (o && o.clientOrderId) m.set(o.clientOrderId, o);
  return m;
}

const isFilled = (o) => !!o && o.status === 'filled' && o.filledAvgPrice != null;

function exitOf(order, parent, ordersById, cidMap, placed) {
  const flat = placed && placed[`${order.clientOrderId}:flat`];
  const flatOrder = flat && flat.ok && flat.orderId ? ordersById[flat.orderId] : null;
  if (isFilled(flatOrder)) return { kind: 'horizon', order: flatOrder };
  const oco = cidMap.get(`${order.clientOrderId}:exit`);
  const candidates = [...((parent && parent.legs) || []), ...(oco ? [oco, ...(oco.legs || [])] : [])];
  const hit = candidates.find(isFilled);
  if (hit) return { kind: EXIT_KIND_BY_TYPE[hit.type] || 'target', order: hit };
  return { kind: 'none', order: null, armed: !!oco || !!((parent && parent.legs) || []).length };
}

function reconcileRow(order, ordersById, cidMap, placed) {
  const parent = cidMap.get(order.clientOrderId) || null;
  const dir = dirOf(order.side);
  const filled = isFilled(parent);
  const placement = placed && placed[order.clientOrderId];
  const base = {
    rowId: order.rowId, clientOrderId: order.clientOrderId, symbol: order.symbol, side: order.side, grade: order.grade, timeframe: order.timeframe,
    costTier: order.costTier, entryType: order.entryType, entry: order.entry, stop: order.stop, target: order.target, risk: order.risk,
    orderId: parent ? parent.id : null, status: parent ? parent.status : (placement ? placement.status || 'placed' : 'not-placed'),
    filled, fillPx: null, fillTs: null, exitKind: 'none', exitPx: null, exitTs: null, realizedR: null, realizedRetPct: null, slippageVsFrozen: null, exitArmed: false,
  };
  if (!filled) return base;
  const fillPx = parent.filledAvgPrice;
  const slipPx = (fillPx - order.entry) * dir;   // positive = paid through the frozen level (adverse)
  const exit = exitOf(order, parent, ordersById, cidMap, placed);
  const exitPx = exit.order ? exit.order.filledAvgPrice : null;
  return {
    ...base, fillPx, fillTs: parent.filledAt, exitKind: exit.kind, exitPx, exitTs: exit.order ? exit.order.filledAt : null,
    realizedR: exitPx != null && order.risk > 0 ? r3(((exitPx - fillPx) * dir) / order.risk) : null,
    realizedRetPct: exitPx != null ? r3((((exitPx - fillPx) * dir) / fillPx) * 100) : null,
    slippageVsFrozen: { px: r4(slipPx), bps: +((slipPx / order.entry) * 10000).toFixed(1) },
    exitArmed: exit.kind !== 'none' || !!exit.armed,
  };
}

// reconcile(plan, ordersById, { placed }) → one row per planned order.
function reconcile(plan, ordersById = {}, { placed = {} } = {}) {
  const cidMap = byClientId(ordersById);
  return (plan && Array.isArray(plan.orders) ? plan.orders : []).map((o) => reconcileRow(o, ordersById, cidMap, placed));
}

// ── Ledger document ──────────────────────────────────────────────────────────
function newLedgerDoc({ snapshot, plan, at }) {
  return {
    version: LEDGER_VERSION, date: plan.date, snapshotId: plan.snapshotId, snapshotGeneratedAt: (snapshot && snapshot.generatedAt) || null,
    snapshotRowIds: (snapshot && Array.isArray(snapshot.items) ? snapshot.items : []).map((i) => i && i.id).filter(Boolean),
    createdAt: at, placedAt: null, plan: { orders: plan.orders, notPlaced: plan.notPlaced }, placed: {}, orders: {}, rows: reconcile(plan, {}), polls: [],
  };
}

// placements: [{ key, ok, orderId, status, error, at }] — key = client_order_id or `<cid>:flat`.
// An ok placement is never overwritten by a later failure (the order exists at the broker).
function recordPlacements(doc, placements) {
  const placed = { ...(doc.placed || {}) };
  for (const p of placements || []) {
    if (!p || !p.key) continue;
    const prev = placed[p.key];
    if (prev && prev.ok && !p.ok) continue;
    placed[p.key] = { ok: !!p.ok, orderId: p.orderId || null, status: p.status || null, error: p.error || null, at: p.at || null };
  }
  const firstOk = (placements || []).find((p) => p && p.ok);
  const placedAt = doc.placedAt || (firstOk ? firstOk.at || null : null);
  return { ...doc, placed, placedAt, rows: reconcile(doc.plan, doc.orders, { placed }) };
}

function applyPoll(doc, { ordersById, at, note = null }) {
  const orders = mergeOrders(doc.orders, ordersById);
  const rows = reconcile(doc.plan, orders, { placed: doc.placed });
  const poll = { at, orders: Object.keys(orders).length, filled: rows.filter((r) => r.filled).length, exited: rows.filter((r) => r.exitKind !== 'none').length, note };
  return { ...doc, orders, rows, polls: [...(doc.polls || []), poll].slice(-POLL_CAP), lastPollAt: at };
}

// ── Work selectors (what the next tick still has to do) ──────────────────────
const placedOk = (doc, key) => !!(doc.placed && doc.placed[key] && doc.placed[key].ok);
function pendingPlacements(doc) { return (doc.plan.orders || []).filter((o) => !placedOk(doc, o.clientOrderId)); }
function exitsToArm(doc) {
  const rows = new Map((doc.rows || []).map((r) => [r.rowId, r]));
  return (doc.plan.orders || []).filter((o) => { const r = rows.get(o.rowId); return o.entryType === 'stop_limit' && r && r.filled && r.exitKind === 'none' && !r.exitArmed && !placedOk(doc, `${o.clientOrderId}:exit`); });
}
function rowsToFlatten(doc) {
  const rows = new Map((doc.rows || []).map((r) => [r.rowId, r]));
  return (doc.plan.orders || []).filter((o) => { const r = rows.get(o.rowId); return o.timeframe === INTRADAY && r && r.filled && r.exitKind === 'none' && !placedOk(doc, `${o.clientOrderId}:flat`); });
}

module.exports = {
  LEDGER_VERSION, TRADEABLE_GRADES, QTY, STOP_LIMIT_BUFFER_PCT, MIN_PRICE, ILLIQUID_DOLLAR_VOL, MAX_CLIENT_ORDER_ID, POLL_CAP, STATUS_RANK,
  snapshotIdOf, snapshotDateOf, planOrders, parentBody, exitOrderBody, normalizeOrder, mergeOrders, reconcile,
  newLedgerDoc, recordPlacements, applyPoll, pendingPlacements, exitsToArm, rowsToFlatten,
};

'use strict';
// PAPER-EXECUTION ops — the I/O shell around lib/exec-paper-ledger (pure) and
// lib/alpaca-paper (raw fetch). Driven by .github/workflows/paper-exec.yml.
//
//   op=paperopen   PRIVILEGED  at the open: pull today's Session Board, plan one 1-share order
//                              per A/B row, place what is not placed yet (idempotent — every
//                              order carries client_order_id = <snapshotId>:<rowId>; a duplicate
//                              is looked up, never re-placed), write paper-exec/<date>.json.
//   op=paperpoll   PRIVILEGED  list the day's orders, arm OCO exits for filled stop_limit
//                              parents, `flatten=1` closes still-open INTRADAY rows (horizon
//                              exit), merge union-monotonically by order id via updateJSON.
//   op=paperexec   public read paper-exec/<date>.json + measurement summary; `compare=1` adds
//                              the daily-bar comparison from the day's candles.
//
// DORMANT BY DESIGN: until ALPACA_KEY_ID / ALPACA_SECRET_KEY / ALPACA_PAPER=1 exist in the
// environment, both writers answer ok:true skipped:true (the workflow stays green) and the
// read op reports exists:false. docs/paper-execution.md has the one-step enable.

const STORE = require('./store');
const SB = require('./session-board');
const L = require('./exec-paper-ledger');
const M = require('./exec-paper-measure');
const { paperConfig, createAlpacaPaperClient } = require('./alpaca-paper');
const { mapLimit } = require('./map-limit');

const LEDGER_PREFIX = 'paper-exec/';
// op=sessionboard's own slowest path is its 30s PULL_TIMEOUT_MS (measured 2026-09-19) plus
// assembly; 45s clears a cache-miss rebuild while leaving most of the function budget.
const SNAPSHOT_PULL_TIMEOUT_MS = 45_000;
const BARS_CAP = 40;              // tickers per compare read — one daily-history fetch each
const BARS_CONCURRENCY = 4;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ledgerPath = (date) => `${LEDGER_PREFIX}${date}.json`;
const noStore = (res) => res.setHeader('Cache-Control', 'no-store');
const cached = (res, s = 60) => res.setHeader('Cache-Control', `s-maxage=${s}, stale-while-revalidate=${s * 2}`);
const errMsg = (e) => String((e && e.message) || e).slice(0, 300);

// The day's bar per ticker from the daily-history feed (compare=1 only).
async function fetchDailyBarsDefault(tickers, date) {
  const { fetchDailyHistory } = require('./screener');
  const out = {};
  await mapLimit(tickers.slice(0, BARS_CAP), BARS_CONCURRENCY, async (t) => {
    try {
      const h = await fetchDailyHistory(t, '1mo');
      const bar = ((h && h.candles) || []).find((c) => c && c.date === date);
      if (bar) out[t] = { open: bar.open, high: bar.high, low: bar.low, close: bar.close };
    } catch { /* no bar → no comparison for this row, reported as noBar */ }
  });
  return out;
}

function defaultDeps() {
  return {
    now: () => new Date(),
    env: process.env,
    hasStore: () => STORE.hasStore(),
    readJSON: (p) => STORE.readJSON(p, null),
    updateJSON: (p, fn, opts) => STORE.updateJSON(p, fn, opts),
    pullSnapshot: () => require('./decision-routes').pull('/api/tracker?op=sessionboard', { timeoutMs: SNAPSHOT_PULL_TIMEOUT_MS }).then((r) => (r.ok ? r.data : null)),
    createClient: () => createAlpacaPaperClient(),
    fetchDailyBars: fetchDailyBarsDefault,
  };
}

// Shared preamble: dormant / no-store / session gating. Returns a skip payload or null.
function gate(deps, { requireRegular = false, force = false } = {}) {
  const cfg = paperConfig(deps.env);
  if (!cfg.enabled) return { ok: true, skipped: true, dormant: true, reason: cfg.reason };
  if (!deps.hasStore()) return { ok: false, error: 'Blob storage not configured.' };
  const session = SB.sessionPhase(deps.now());
  if (requireRegular && !force && session.phase !== 'regular') return { ok: true, skipped: true, reason: `market-${session.phase}`, date: session.etDate };
  return null;
}

async function ensureLedger(deps, date, at) {
  const path = ledgerPath(date);
  const existing = await deps.readJSON(path);
  if (existing && existing.version === L.LEDGER_VERSION) return { doc: existing, created: false };
  const snapshot = await deps.pullSnapshot();
  if (!snapshot || snapshot.ok === false || snapshot.empty || !Array.isArray(snapshot.items)) return { skip: 'no-snapshot' };
  if (L.snapshotDateOf(snapshot) !== date) return { skip: 'snapshot-date-mismatch', snapshotDate: L.snapshotDateOf(snapshot) };
  const fresh = L.newLedgerDoc({ snapshot, plan: L.planOrders(snapshot), at });
  // Create-only CAS: a concurrent tick that created it first wins and we adopt its doc.
  const r = await deps.updateJSON(path, (cur) => (cur && cur.version === L.LEDGER_VERSION ? cur : fresh), { initial: null });
  return { doc: r.value, created: r.written };
}

async function placeAll(client, orders, bodyOf, keyOf, at) {
  const placements = [];
  for (const o of orders) {
    try {
      const r = await client.placeOrder(bodyOf(o));
      placements.push(r.ok
        ? { key: keyOf(o), ok: true, orderId: r.order.id, status: r.order.status, at, duplicate: !!r.duplicate }
        : { key: keyOf(o), ok: false, error: r.error || `HTTP ${r.status}`, status: 'rejected', at });
    } catch (e) {
      placements.push({ key: keyOf(o), ok: false, error: errMsg(e), status: 'error', at });
    }
  }
  return placements;
}

// ── open ─────────────────────────────────────────────────────────────────────
async function openCore(deps, { force = false } = {}) {
  const t0 = Date.now();
  const skip = gate(deps, { requireRegular: true, force });
  if (skip) return skip;
  const now = deps.now();
  const date = SB.sessionPhase(now).etDate;
  const at = now.toISOString();
  const led = await ensureLedger(deps, date, at);
  if (led.skip) return { ok: true, skipped: true, reason: led.skip, date, snapshotDate: led.snapshotDate || null };
  const base = { ok: true, date, snapshotId: led.doc.snapshotId, planned: led.doc.plan.orders.length, notPlaced: led.doc.plan.notPlaced.length, ledgerCreated: led.created };
  const pending = L.pendingPlacements(led.doc);
  if (!pending.length) return { ...base, alreadyPlaced: true, placed: 0, failed: [], ms: Date.now() - t0 };
  const client = deps.createClient();
  const placements = await placeAll(client, pending, (o) => o.body, (o) => o.clientOrderId, at);
  await deps.updateJSON(ledgerPath(date), (cur) => L.recordPlacements(cur || led.doc, placements), { initial: null });
  const bySymbol = new Map(pending.map((o) => [o.clientOrderId, o.symbol]));
  return {
    ...base, placed: placements.filter((p) => p.ok).length,
    failed: placements.filter((p) => !p.ok).map((p) => ({ clientOrderId: p.key, symbol: bySymbol.get(p.key) || null, error: p.error })),
    ms: Date.now() - t0,
  };
}

// ── poll ─────────────────────────────────────────────────────────────────────
function ownOrders(doc, rawOrders) {
  const prefix = `${doc.snapshotId}:`;
  const known = new Set(Object.values(doc.placed || {}).map((p) => p && p.orderId).filter(Boolean));
  const out = {};
  for (const raw of rawOrders) {
    const o = L.normalizeOrder(raw);
    if (!o) continue;
    if ((o.clientOrderId && o.clientOrderId.startsWith(prefix)) || known.has(o.id)) out[o.id] = o;
  }
  return out;
}

async function pollCore(deps, { flatten = false } = {}) {
  const t0 = Date.now();
  const skip = gate(deps);
  if (skip) return skip;
  const now = deps.now();
  const date = SB.sessionPhase(now).etDate;
  const at = now.toISOString();
  const path = ledgerPath(date);
  const doc = await deps.readJSON(path);
  if (!doc || doc.version !== L.LEDGER_VERSION) return { ok: true, skipped: true, reason: 'no-ledger', date };
  const client = deps.createClient();
  const ordersById = ownOrders(doc, await client.listOrders({ after: `${date}T00:00:00Z` }));
  const staged = L.applyPoll(doc, { ordersById, at });
  const toFlatten = flatten ? L.rowsToFlatten(staged) : [];
  const flattenIds = new Set(toFlatten.map((o) => o.rowId));
  const toArm = L.exitsToArm(staged).filter((o) => !flattenIds.has(o.rowId));
  const armed = await placeAll(client, toArm, L.exitOrderBody, (o) => `${o.clientOrderId}:exit`, at);
  const flattened = [];
  for (const o of toFlatten) {
    try {
      const r = await client.closePosition(o.symbol);
      flattened.push(r.ok ? { key: `${o.clientOrderId}:flat`, ok: true, orderId: r.order.id, status: r.order.status, at } : { key: `${o.clientOrderId}:flat`, ok: false, error: r.error, status: 'rejected', at });
    } catch (e) { flattened.push({ key: `${o.clientOrderId}:flat`, ok: false, error: errMsg(e), status: 'error', at }); }
  }
  const note = flatten ? 'flatten' : null;
  const r = await deps.updateJSON(path, (cur) => L.applyPoll(L.recordPlacements(cur || doc, [...armed, ...flattened]), { ordersById, at, note }), { initial: null });
  const rows = r.value.rows || [];
  return {
    ok: true, date, snapshotId: doc.snapshotId, orders: Object.keys(ordersById).length,
    filled: rows.filter((x) => x.filled).length, exited: rows.filter((x) => x.exitKind !== 'none').length,
    exitsArmed: armed.filter((p) => p.ok).length, flattened: flattened.filter((p) => p.ok).length,
    failed: [...armed, ...flattened].filter((p) => !p.ok).map((p) => ({ key: p.key, error: p.error })),
    polls: (r.value.polls || []).length, ms: Date.now() - t0,
  };
}

// ── handlers ─────────────────────────────────────────────────────────────────
async function runWriter(core, req, res, injected, opts) {
  noStore(res);
  const deps = { ...defaultDeps(), ...injected };
  try {
    return res.status(200).json(await core(deps, opts));
  } catch (e) {
    // Fail closed and say so — a broker/store error must never be written as a quiet poll.
    return res.status(502).json({ ok: false, error: `paper-exec failed — nothing written: ${errMsg(e)}` });
  }
}
const runPaperOpen = (req, res, injected = {}) => runWriter(openCore, req, res, injected, { force: req && req.query && req.query.force === '1' });
const runPaperPoll = (req, res, injected = {}) => runWriter(pollCore, req, res, injected, { flatten: req && req.query && req.query.flatten === '1' });

async function runPaperExec(req, res, injected = {}) {
  const deps = { ...defaultDeps(), ...injected };
  const q = (req && req.query) || {};
  const date = q.date ? String(q.date) : SB.sessionPhase(deps.now()).etDate;
  if (!DATE_RE.test(date)) { noStore(res); return res.status(400).json({ ok: false, error: 'date must be YYYY-MM-DD' }); }
  if (!deps.hasStore()) { noStore(res); return res.status(200).json({ ok: true, exists: false, date, error: 'Blob storage not configured.' }); }
  const doc = await deps.readJSON(ledgerPath(date));
  if (!doc || doc.version !== L.LEDGER_VERSION) { noStore(res); return res.status(200).json({ ok: true, exists: false, date }); }   // never CDN-cache the empty state
  let barByTicker = null;
  if (q.compare === '1') {
    const tickers = [...new Set((doc.rows || []).map((r) => r.symbol).filter(Boolean))];
    try { barByTicker = await deps.fetchDailyBars(tickers, date); } catch { barByTicker = {}; }
  }
  cached(res);
  return res.status(200).json({
    ok: true, exists: true, date, snapshotId: doc.snapshotId, placedAt: doc.placedAt || null, lastPollAt: doc.lastPollAt || null,
    summary: M.summarize(doc, { barByTicker }), rows: doc.rows || [], notPlaced: (doc.plan && doc.plan.notPlaced) || [], polls: doc.polls || [],
  });
}

module.exports = {
  runPaperOpen, runPaperPoll, runPaperExec, openCore, pollCore, ledgerPath, ownOrders,
  LEDGER_PREFIX, SNAPSHOT_PULL_TIMEOUT_MS, BARS_CAP,
};

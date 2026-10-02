'use strict';
// PAPER PORTFOLIO — the simulated "house book" that takes every Session Board A/B row.
//
// WHAT IT IS. A Ghostfolio-style ACTIVITIES ledger (schema idea only — Ghostfolio is AGPL,
// none of its code is here): {id, type: BUY|SELL|FEE, date, symbol, quantity, unitPrice,
// fee, currency, source}. The book buys every A/B long row the Session Board graded, at the
// NEXT session's open under exec-v1 (lib/execution-policy: adverse entry-side slippage from
// the lib/costs tier), equal notional per row, and exits at the row's stop / target or at
// the board's time-frame horizon — the exit leg carries the other half of the tier's
// round-trip friction, so a round trip costs exactly what lib/costs charges the Scoreboard.
//
// WHY IT EXISTS. Not alpha: ACCOUNTING. The Scoreboard reports an equal-weight aggregate of
// the same rows; a portfolio that actually holds them must land within the cost tiers of
// that aggregate. `reconcile` measures the gap — a divergence is a dedup / episode /
// bookkeeping bug detector (the real payoff of proposal #30). Weight 0 everywhere.
//
// PURE. No I/O, no clock (as-of dates are injected), no mutation of inputs; every function
// returns new objects. lib/house-book-routes.js owns fetches and Blob writes.

const { planFill, POLICIES, signalBarIndex, perSideSlippagePct } = require('./execution-policy');
const { tierForPick, roundTripCostPct } = require('./costs');
const MS = require('./market-session');

const VERSION = 'paper-portfolio-v1';
const RECONCILE_VERSION = 'housebook-reconcile-v1';
const INITIAL_CASH_USD = 1_000_000;
const NOTIONAL_PER_POSITION_USD = 5_000;      // constant equal notional (0.5% of the start)
// Sessions held per Session Board time frame — each is one of the Scoreboard's own horizon
// columns (1d / 10d / 1m / 3m), so a horizon exit is directly comparable to its column.
const HORIZON_SESSIONS = Object.freeze({ intraday: 1, swing: 10, position: 21, portfolio: 63 });
const TAKEN_GRADES = new Set(['A', 'B']);
const PENDING_MAX_CALENDAR_DAYS = 10;         // an unfilled row older than this is dropped
const CLOSED_RETENTION = 400;                 // closed positions kept in full; older ones archived
const SKIP_SAMPLE = 50;
const MAX_HORIZON_SESSIONS = 63;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sum = (arr) => arr.reduce((a, b) => a + b, 0);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const byDateThenType = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.type === b.type ? 0 : a.type === 'BUY' ? -1 : 1);

// ── State ───────────────────────────────────────────────────────────────────
function initialState({ initialCash = INITIAL_CASH_USD } = {}) {
  return {
    version: VERSION, initialCash, cash: initialCash, notionalPerPosition: NOTIONAL_PER_POSITION_USD,
    pending: [], positions: {}, closed: [], activities: [],
    archived: { closedCount: 0, realizedPnl: 0, activityCount: 0 },
    ingestedSnapshotIds: [], skipped: { counts: {}, recent: [] },
    lastSessionDate: null, equity: null, reconcile: null,
  };
}

function withSkips(state, skips) {
  if (!skips.length) return state;
  const counts = { ...state.skipped.counts };
  for (const s of skips) counts[s.reason] = (counts[s.reason] || 0) + 1;
  const recent = [...state.skipped.recent, ...skips].slice(-SKIP_SAMPLE);
  return { ...state, skipped: { counts, recent } };
}

// ── Snapshot → rows ─────────────────────────────────────────────────────────
// The board's signal is the last COMPLETED session before it was generated: an after-hours
// board carries that day's close, a premarket board the prior session's.
function signalDateOf(snapshot) {
  const t = snapshot && snapshot.generatedAt ? new Date(snapshot.generatedAt) : null;
  if (!t || !Number.isFinite(t.getTime())) return null;
  return MS.lastCompletedRegularSession(t);
}

function rowFromItem(it, signalDate, snapshotId) {
  const tf = (it.timeframe && it.timeframe.key) || it.horizon || 'swing';
  const letter = it.grade && it.grade.letter;
  return {
    rowId: it.id || `${it.section}:${tf}:${it.ticker}`, ticker: String(it.ticker).toUpperCase(), side: 'long', signalDate,
    horizonSessions: HORIZON_SESSIONS[tf] || HORIZON_SESSIONS.swing, timeframe: tf,
    stop: num(it.levels && it.levels.stop), target: num(it.levels && it.levels.target),
    costTier: tierForPick({ section: it.section, scope: it.scope || null }),
    source: { sessionboardSnapshotId: snapshotId, rowId: it.id || null, grade: letter || null, timeframe: tf, section: it.section || null, tier: it.tier || null, signalDate },
  };
}

// { rows, skipped:[{ticker, reason}], signalDate, snapshotId }
function rowsFromSnapshot(snapshot) {
  const signalDate = signalDateOf(snapshot);
  if (!snapshot || !signalDate) return { rows: [], skipped: [], signalDate: null, snapshotId: null };
  const snapshotId = snapshot.generatedAt;
  const rows = [], skipped = [];
  for (const it of (Array.isArray(snapshot.items) ? snapshot.items : [])) {
    if (!it || !it.ticker) continue;
    const letter = it.grade && it.grade.letter;
    if (it.flags && it.flags.heldOut) { skipped.push({ ticker: it.ticker, reason: 'held-out-lane' }); continue; }
    if (!TAKEN_GRADES.has(letter)) { skipped.push({ ticker: it.ticker, reason: 'grade-below-B' }); continue; }
    if (String(it.side || 'long').toLowerCase() === 'short') { skipped.push({ ticker: it.ticker, reason: 'short-side' }); continue; }
    rows.push(rowFromItem(it, signalDate, snapshotId));
  }
  return { rows, skipped, signalDate, snapshotId };
}

// ── Ingest ──────────────────────────────────────────────────────────────────
function ingestSnapshot(state, snapshot) {
  const { rows, skipped, snapshotId, signalDate } = rowsFromSnapshot(snapshot);
  if (!snapshotId || state.ingestedSnapshotIds.includes(snapshotId)) return { state, added: 0 };
  const openTickers = new Set([...Object.values(state.positions).map((p) => p.symbol), ...state.pending.map((p) => p.ticker)]);
  const fresh = [], skips = [...skipped];
  for (const r of rows) {
    if (openTickers.has(r.ticker)) { skips.push({ ticker: r.ticker, reason: 'already-open' }); continue; }
    openTickers.add(r.ticker);
    fresh.push(r);
  }
  const next = { ...state, pending: [...state.pending, ...fresh], ingestedSnapshotIds: [...state.ingestedSnapshotIds, snapshotId] };
  return { state: withSkips(next, skips.map((s) => ({ ...s, date: signalDate }))), added: fresh.length };
}

// ── Fills ───────────────────────────────────────────────────────────────────
const barsThrough = (candles, asOfDate) => (Array.isArray(candles) ? candles.filter((c) => c && c.date <= asOfDate) : []);
const positionIdOf = (row) => `${row.rowId}@${row.signalDate}`;

function activityFor(type, row, positionId, date, quantity, unitPrice, meta) {
  return {
    id: `${type.toLowerCase()}:${positionId}`, type, date, symbol: row.ticker, quantity, unitPrice, fee: 0, currency: 'USD',
    source: { ...row.source }, meta: { positionId, ...meta },
  };
}

function fillPending(state, prices, asOfDate) {
  let cash = state.cash;
  const positions = { ...state.positions };
  const activities = [...state.activities];
  const pending = [], fills = [], skips = [];
  for (const row of state.pending) {
    const candles = barsThrough(prices[row.ticker], asOfDate);
    const plan = planFill(candles, row.signalDate, { policy: POLICIES.NEXT_OPEN_PLUS_SLIPPAGE, side: 'long', tier: row.costTier });
    if (!plan.filled) {
      if (daysBetween(row.signalDate, asOfDate) > PENDING_MAX_CALENDAR_DAYS) skips.push({ ticker: row.ticker, reason: 'stale-unfilled', date: asOfDate, detail: plan.fillReason });
      else pending.push(row);
      continue;
    }
    const notional = state.notionalPerPosition;
    if (cash < notional) { skips.push({ ticker: row.ticker, reason: 'insufficient-cash', date: candles[plan.fillIdx].date }); continue; }
    const quantity = notional / plan.fillPrice;
    const id = positionIdOf(row);
    cash -= notional;
    positions[id] = {
      id, symbol: row.ticker, side: 'long', quantity, fillPrice: plan.fillPrice, fillDate: candles[plan.fillIdx].date,
      referencePrice: plan.referencePrice, slippagePct: plan.slippagePct, signalDate: row.signalDate,
      horizonSessions: row.horizonSessions, timeframe: row.timeframe, stop: row.stop, target: row.target, costTier: row.costTier,
      source: row.source, executionPolicy: plan.version, mark: null,
    };
    activities.push(activityFor('BUY', row, id, positions[id].fillDate, quantity, plan.fillPrice, { referencePrice: plan.referencePrice, slippagePct: plan.slippagePct, fillReason: plan.fillReason, policy: plan.policy }));
    fills.push({ symbol: row.ticker, positionId: id, date: positions[id].fillDate, fillPrice: plan.fillPrice });
  }
  return { state: withSkips({ ...state, cash, positions, activities, pending }, skips), fills };
}

// ── Exits ───────────────────────────────────────────────────────────────────
// Walk the held bars (the fill bar included — a fill at the open is exposed to that bar's
// range) up to the horizon. Stop first on a bar that touches both (conservative, like
// lib/outcome); a barrier the session OPENS beyond fills at the open (gap-through).
function resolveExit(candles, pos, asOfDate) {
  const fillIdx = candles.findIndex((c) => c.date === pos.fillDate);
  if (fillIdx < 0) return null;
  const stop = pos.stop != null && pos.stop > 0 && pos.stop < pos.fillPrice ? pos.stop : null;
  const target = pos.target != null && pos.target > pos.fillPrice ? pos.target : null;
  const lastIdx = fillIdx + Math.min(pos.horizonSessions, MAX_HORIZON_SESSIONS) - 1;
  const slip = perSideSlippagePct(pos.costTier);
  for (let k = fillIdx; k < candles.length && k <= lastIdx; k++) {
    const c = candles[k];
    if (c.date > asOfDate) return null;
    let ref = null, reason = null, gapThrough = false;
    if (stop != null && c.low <= stop) { gapThrough = c.open < stop; ref = gapThrough ? c.open : stop; reason = 'stop'; }
    else if (target != null && c.high >= target) { gapThrough = c.open > target; ref = gapThrough ? c.open : target; reason = 'target'; }
    else if (k === lastIdx) { ref = c.close; reason = 'horizon'; }
    if (ref == null) continue;
    return { date: c.date, referencePrice: ref, price: ref * (1 - slip), reason, gapThrough, slippagePct: slip, barsHeld: k - fillIdx + 1 };
  }
  return null;
}

function closePosition(pos, exit) {
  const realizedPnl = pos.quantity * (exit.price - pos.fillPrice);
  return { ...pos, mark: null, exit, realizedPnl, netReturnPct: (exit.price / pos.fillPrice - 1) * 100 };
}

function processExits(state, prices, asOfDate) {
  let cash = state.cash;
  const positions = {}, closed = [...state.closed], activities = [...state.activities], exits = [];
  for (const pos of Object.values(state.positions)) {
    const exit = resolveExit(barsThrough(prices[pos.symbol], asOfDate), pos, asOfDate);
    if (!exit) { positions[pos.id] = pos; continue; }
    cash += pos.quantity * exit.price;
    closed.push(closePosition(pos, exit));
    activities.push(activityFor('SELL', { ticker: pos.symbol, source: pos.source }, pos.id, exit.date, pos.quantity, exit.price, { referencePrice: exit.referencePrice, slippagePct: exit.slippagePct, reason: exit.reason, gapThrough: exit.gapThrough }));
    exits.push({ symbol: pos.symbol, positionId: pos.id, date: exit.date, reason: exit.reason, netReturnPct: (exit.price / pos.fillPrice - 1) * 100 });
  }
  return { state: archiveClosed({ ...state, cash, positions, closed, activities }), exits };
}

// Older closed positions fold into an archive total so the doc stays bounded; their
// activities go with them (the P&L identity in `reconcile` reads the archive, not a replay).
function archiveClosed(state) {
  if (state.closed.length <= CLOSED_RETENTION) return state;
  const sorted = [...state.closed].sort((a, b) => (a.exit.date < b.exit.date ? -1 : 1));
  const drop = sorted.slice(0, sorted.length - CLOSED_RETENTION);
  const dropIds = new Set(drop.map((p) => p.id));
  const activities = state.activities.filter((a) => !dropIds.has(a.meta && a.meta.positionId));
  return {
    ...state, closed: sorted.slice(drop.length), activities,
    archived: { closedCount: state.archived.closedCount + drop.length, realizedPnl: state.archived.realizedPnl + sum(drop.map((p) => p.realizedPnl)), activityCount: state.archived.activityCount + (state.activities.length - activities.length) },
  };
}

// ── Mark ────────────────────────────────────────────────────────────────────
function lastCloseThrough(candles, asOfDate) {
  const bars = barsThrough(candles, asOfDate);
  const last = bars[bars.length - 1];
  return last && num(last.close) != null ? { price: last.close, date: last.date } : null;
}

function markBook(state, prices, asOfDate) {
  const positions = {};
  for (const pos of Object.values(state.positions)) {
    const m = lastCloseThrough(prices[pos.symbol], asOfDate);
    positions[pos.id] = { ...pos, mark: m ? { ...m, stale: false } : { price: (pos.mark && pos.mark.price) || pos.fillPrice, date: (pos.mark && pos.mark.date) || pos.fillDate, stale: true } };
  }
  const marked = Object.values(positions);
  const unrealizedPnl = sum(marked.map((p) => p.quantity * (p.mark.price - p.fillPrice)));
  const equity = state.cash + sum(marked.map((p) => p.quantity * p.mark.price));
  const spy = lastCloseThrough(prices.SPY, asOfDate);
  const point = { date: asOfDate, equity, cash: state.cash, openPositions: marked.length, spyClose: spy ? spy.price : null, realizedPnl: state.archived.realizedPnl + sum(state.closed.map((p) => p.realizedPnl)), unrealizedPnl };
  return { state: { ...state, positions, equity: point }, point };
}

// ── The step ────────────────────────────────────────────────────────────────
// Advance the book to `asOfDate` (the last settled session): ingest the snapshot (once per
// snapshot id), fill what has a next-session bar, run exits, mark. Deterministic and
// idempotent: the same inputs always produce the same state — a re-run of a date is a
// no-op, never a double entry.
function houseBookStep(snapshot, prevState, prices, { asOfDate, summary = null } = {}) {
  if (!asOfDate) throw new TypeError('houseBookStep: asOfDate is required');
  const base = prevState && prevState.version === VERSION ? prevState : initialState(prevState && prevState.initialCash ? { initialCash: prevState.initialCash } : {});
  const ingested = ingestSnapshot(base, snapshot);
  const filled = fillPending(ingested.state, prices || {}, asOfDate);
  const exited = processExits(filled.state, prices || {}, asOfDate);
  const marked = markBook(exited.state, prices || {}, asOfDate);
  const lastSessionDate = base.lastSessionDate && base.lastSessionDate > asOfDate ? base.lastSessionDate : asOfDate;
  const state0 = { ...marked.state, lastSessionDate };
  const state = { ...state0, reconcile: reconcile(state0, prices || {}, { summary, asOfDate }) };
  const noop = ingested.added === 0 && !filled.fills.length && !exited.exits.length && base.lastSessionDate != null && asOfDate <= base.lastSessionDate;
  return { state, point: marked.point, fills: filled.fills, exits: exited.exits, noop, skipped: state.skipped.counts };
}

// A fresh book over caller-supplied rows (op=mybook): fill → exit → mark, no snapshot.
function simulateRows(rows, prices, { asOfDate, initialCash = INITIAL_CASH_USD } = {}) {
  if (!asOfDate) throw new TypeError('simulateRows: asOfDate is required');
  const seeded = { ...initialState({ initialCash }), pending: [...(rows || [])] };
  const filled = fillPending(seeded, prices || {}, asOfDate);
  const exited = processExits(filled.state, prices || {}, asOfDate);
  const marked = markBook(exited.state, prices || {}, asOfDate);
  return { state: { ...marked.state, lastSessionDate: asOfDate }, point: marked.point, fills: filled.fills, exits: exited.exits };
}

// ── Equity series doc (housebook/equity.json) ───────────────────────────────
function appendEquityPoint(doc, point) {
  const points = (doc && Array.isArray(doc.points) ? doc.points : []).filter((p) => p && p.date !== point.date);
  return { version: VERSION, points: [...points, point].sort((a, b) => (a.date < b.date ? -1 : 1)) };
}

// ── Ledger replay (client books, tests) ─────────────────────────────────────
// Replays an Activities list against prices: cash, open lots, marks, equity and the two
// P&L legs. Lots are keyed by positionId (meta) so the same symbol can be held twice.
function applyActivities(activities, prices, { asOfDate, initialCash = INITIAL_CASH_USD } = {}) {
  const acts = [...(activities || [])].filter((a) => a && (!asOfDate || a.date <= asOfDate)).sort(byDateThenType);
  let cash = initialCash, realizedPnl = 0;
  const lots = {};
  for (const a of acts) {
    const id = (a.meta && a.meta.positionId) || `${a.symbol}:${a.date}`;
    if (a.type === 'BUY') { cash -= a.quantity * a.unitPrice + (a.fee || 0); lots[id] = { symbol: a.symbol, quantity: a.quantity, costBasis: a.unitPrice, fillDate: a.date }; }
    else if (a.type === 'SELL') { cash += a.quantity * a.unitPrice - (a.fee || 0); const lot = lots[id]; if (lot) { realizedPnl += a.quantity * (a.unitPrice - lot.costBasis); delete lots[id]; } }
    else if (a.type === 'FEE') cash -= (a.fee || 0);
  }
  const positions = {};
  let unrealizedPnl = 0, marketValue = 0;
  for (const [id, lot] of Object.entries(lots)) {
    const m = lastCloseThrough(prices[lot.symbol], asOfDate || '9999-12-31');
    const price = m ? m.price : lot.costBasis;
    positions[id] = { ...lot, mark: m ? { ...m, stale: false } : { price, date: lot.fillDate, stale: true } };
    unrealizedPnl += lot.quantity * (price - lot.costBasis);
    marketValue += lot.quantity * price;
  }
  return { cash, positions, equity: cash + marketValue, realizedPnl, unrealizedPnl, initialCash };
}

// One equity point per SPY session from the first activity through asOfDate.
function equitySeries(activities, prices, { asOfDate, initialCash = INITIAL_CASH_USD } = {}) {
  const acts = (activities || []).filter(Boolean);
  if (!acts.length) return [];
  const first = acts.map((a) => a.date).sort()[0];
  const dates = barsThrough(prices.SPY, asOfDate || '9999-12-31').map((c) => c.date).filter((d) => d >= first);
  return dates.map((date) => {
    const b = applyActivities(acts, prices, { asOfDate: date, initialCash });
    const spy = lastCloseThrough(prices.SPY, date);
    return { date, equity: b.equity, cash: b.cash, openPositions: Object.keys(b.positions).length, spyClose: spy ? spy.price : null };
  });
}

// ── Reconciliation ──────────────────────────────────────────────────────────
// The Scoreboard's method for the same row: next-open entry (no slippage), close at
// signal bar + H sessions, gross minus the tier's round-trip cost (lib/costs).
function scoreboardMethodNetPct(candles, pos) {
  const bars = Array.isArray(candles) ? candles : [];
  const sigIdx = signalBarIndex(bars, pos.signalDate);
  const entryBar = bars[sigIdx + 1], exitBar = bars[sigIdx + pos.horizonSessions];
  if (sigIdx < 0 || !entryBar || !exitBar || !(entryBar.open > 0)) return null;
  return (exitBar.close / entryBar.open - 1) * 100 - roundTripCostPct(pos.costTier);
}

function duplicateBuyCount(activities) {
  const seen = new Map();
  for (const a of activities || []) {
    if (!a || a.type !== 'BUY') continue;
    const k = `${a.symbol}:${a.source && a.source.signalDate}`;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  return sum([...seen.values()].map((n) => n - 1));
}

function reconcile(state, prices, { summary = null, asOfDate = null } = {}) {
  const horizon = state.closed.filter((p) => p.exit && p.exit.reason === 'horizon');
  // Book side re-derived from the raw fill/exit prices — never the cached netReturnPct, so a
  // drifted cache cannot vouch for itself.
  const pairs = horizon.map((p) => ({ book: (p.exit.price / p.fillPrice - 1) * 100, sb: scoreboardMethodNetPct(prices[p.symbol], p), tier: p.costTier })).filter((x) => x.sb != null);
  const bookMean = pairs.length ? sum(pairs.map((x) => x.book)) / pairs.length : null;
  const sbMean = pairs.length ? sum(pairs.map((x) => x.sb)) / pairs.length : null;
  const tolerancePct = pairs.length ? Math.max(...pairs.map((x) => roundTripCostPct(x.tier))) : roundTripCostPct('liquid');
  const divergencePct = pairs.length ? Math.abs(bookMean - sbMean) : null;
  const duplicateBuys = duplicateBuyCount(state.activities);
  const open = Object.values(state.positions);
  const marked = open.filter((p) => p.mark);
  const equity = state.cash + sum(marked.map((p) => p.quantity * p.mark.price));
  const pnlEquity = state.initialCash + state.archived.realizedPnl + sum(state.closed.map((p) => p.realizedPnl)) + sum(marked.map((p) => p.quantity * (p.mark.price - p.fillPrice)));
  const ledgerIdentityGapUsd = Math.abs(equity - pnlEquity);
  const graded = summary && Array.isArray(summary.groups) ? new Set(summary.groups.map((g) => g.section)) : null;
  const rowsMissingInScoreboard = graded
    ? [...new Map([...open, ...state.closed].filter((p) => p.source && !graded.has(p.source.section)).map((p) => [`${p.symbol}:${p.source.section}`, { ticker: p.symbol, section: p.source.section }])).values()]
    : null;
  const problems = [];
  if (divergencePct != null && divergencePct > tolerancePct) problems.push(`equity-curve divergence ${divergencePct.toFixed(3)}% vs Scoreboard method exceeds the ${tolerancePct}% cost-tier tolerance`);
  if (duplicateBuys > 0) problems.push(`${duplicateBuys} duplicate BUY activit${duplicateBuys === 1 ? 'y' : 'ies'} for one row/date (dedup or episode bug)`);
  if (ledgerIdentityGapUsd > 0.01) problems.push(`cash-flow equity and P&L equity differ by $${ledgerIdentityGapUsd.toFixed(2)}`);
  const status = problems.length ? 'divergent' : pairs.length ? 'ok' : 'no-data';
  return {
    version: RECONCILE_VERSION, asOfDate, status, problems, rows: pairs.length,
    bookMeanNetPct: bookMean, scoreboardMeanNetPct: sbMean, divergencePct, tolerancePct,
    duplicateBuys, ledgerIdentityGapUsd,
    rowsMissingInScoreboard, rowsMissingInBook: { counts: { ...state.skipped.counts }, recent: state.skipped.recent.slice(-10) },
    basis: 'horizon-exited positions only (stop/target exits differ from the Scoreboard column by design); Scoreboard method = next-open to close at signal+H, gross minus lib/costs round trip; tolerance = the widest cost tier among compared rows',
  };
}

module.exports = {
  VERSION, RECONCILE_VERSION, INITIAL_CASH_USD, NOTIONAL_PER_POSITION_USD, HORIZON_SESSIONS, PENDING_MAX_CALENDAR_DAYS, CLOSED_RETENTION,
  initialState, signalDateOf, rowFromItem, rowsFromSnapshot, ingestSnapshot, fillPending, resolveExit, processExits, markBook,
  houseBookStep, simulateRows, appendEquityPoint, applyActivities, equitySeries, reconcile, scoreboardMethodNetPct,
};

'use strict';
// HOUSE BOOK — route handlers for the simulated paper portfolio (lib/paper-portfolio).
//
//   op=housebooktick  PRIVILEGED  — advance the book one settled session: ingest the Session
//                                   Board snapshot, fill / exit / mark, reconcile, persist via
//                                   CAS (housebook/state.json) + append the equity point
//                                   (housebook/equity.json). Idempotent per date and per
//                                   snapshot; time-budgeted (candles are fetched until the
//                                   budget is spent, the rest wait for the next tick).
//   op=housebook      public read — book, equity vs SPY, perf metrics, reconciliation.
//   op=mybook         public read — the caller's own "taking this" rows simulated under the
//                                   identical policy (validated at the boundary, ≤25 rows).
//
// SHADOW / weight 0: nothing here feeds a ranking. Every side effect is injectable.

const STORE = require('./store');
const MS = require('./market-session');
const PP = require('./paper-portfolio');
const PM = require('./perf-metrics');
const { mapLimit } = require('./map-limit');

const SNAPSHOT_PATH = 'sessionboard/latest.json';
const SUMMARY_PATH = 'scoreboard/summary.json';
const STATE_PATH = 'housebook/state.json';
const EQUITY_PATH = 'housebook/equity.json';
const BENCH = 'SPY';
// MEASURED (insider-cluster tick, 2026-09): ≤40 six-month Yahoo histories at concurrency 3
// finish well inside a chain step; one history ≈ 0.3–1.2s. The budget is TIME, not count:
// fetching stops once it is spent and the unfilled rows simply wait for the next tick. 150s
// leaves ≥90s of the 240s chain deadline for the two CAS writes and the step itself.
const FETCH_BUDGET_MS = 150_000;
const FETCH_CONCURRENCY = 3;
const HISTORY_RANGE = '6mo';
const MY_BOOK_MAX_ROWS = 25;
const MY_BOOK_CACHE_S = 300;
const READ_CACHE_S = 300;
const RECENT_CLOSED = 20;
const RECENT_ACTIVITIES = 50;

const noStore = (res) => res.setHeader('Cache-Control', 'no-store');
const cached = (res, s) => res.setHeader('Cache-Control', `s-maxage=${s}, stale-while-revalidate=${s * 2}`);
const errMsg = (e) => String((e && e.message) || e).slice(0, 300);

function defaultDeps() {
  return {
    now: () => new Date(),
    readJSON: (p, fallback = null) => STORE.readJSON(p, fallback),
    updateJSON: (p, fn, opts) => STORE.updateJSON(p, fn, opts),
    hasStore: () => STORE.hasStore(),
    history: (t) => require('./screener').fetchDailyHistory(t, HISTORY_RANGE),
    sessionDue: (now) => MS.sessionDue(now),
    fetchBudgetMs: FETCH_BUDGET_MS,
  };
}

// Candles for `tickers` (benchmark first, always) until the time budget is spent.
// { prices:{T→candles}, unpriced:[T], truncated }
async function fetchPrices(tickers, deps) {
  const t0 = deps.now().getTime();
  const prices = {};
  const unpriced = [];
  let truncated = false;
  const one = async (t) => {
    if (deps.now().getTime() - t0 > deps.fetchBudgetMs) { truncated = true; unpriced.push(t); return; }
    try {
      const d = await deps.history(t);
      if (d && Array.isArray(d.candles) && d.candles.length) prices[t] = d.candles; else unpriced.push(t);
    } catch { unpriced.push(t); }
  };
  await one(BENCH);
  await mapLimit([...new Set(tickers)].filter((t) => t !== BENCH), FETCH_CONCURRENCY, one);
  return { prices, unpriced: unpriced.sort(), truncated };
}

function tickersFor(state, snapshotRows) {
  return [...new Set([
    ...(state ? state.pending.map((p) => p.ticker) : []),
    ...(state ? Object.values(state.positions).map((p) => p.symbol) : []),
    ...snapshotRows.map((r) => r.ticker),
  ])];
}

async function tickCore(injected = {}) {
  const deps = { ...defaultDeps(), ...injected };
  const t0 = deps.now().getTime();
  const [snapshot, state, summary] = await Promise.all([deps.readJSON(SNAPSHOT_PATH), deps.readJSON(STATE_PATH), deps.readJSON(SUMMARY_PATH)]);
  const due = deps.sessionDue(deps.now());
  if (!due) return { ok: false, error: 'no settled session is due yet — nothing to advance to', ms: deps.now().getTime() - t0 };
  const snap = PP.rowsFromSnapshot(snapshot);
  const prev = state && state.version === PP.VERSION ? state : null;
  const snapshotSeen = !snap.snapshotId || (prev && prev.ingestedSnapshotIds.includes(snap.snapshotId));
  const nothingOpen = !prev || (!prev.pending.length && !Object.keys(prev.positions).length);
  if (snapshotSeen && (nothingOpen || prev.lastSessionDate === due)) {
    return { ok: true, noop: true, asOfDate: due, reason: nothingOpen && !prev ? 'no board and no book' : 'already advanced to this session', ms: deps.now().getTime() - t0 };
  }
  const { prices, unpriced, truncated } = await fetchPrices(tickersFor(prev, snap.rows), deps);
  const spy = prices[BENCH] || [];
  const asOfDate = spy.length && spy[spy.length - 1].date < due ? spy[spy.length - 1].date : due;
  let result = null;
  await deps.updateJSON(STATE_PATH, (cur) => { result = PP.houseBookStep(snapshot, cur, prices, { asOfDate, summary }); return result.state; }, { initial: null });
  await deps.updateJSON(EQUITY_PATH, (cur) => PP.appendEquityPoint(cur, result.point), { initial: null });
  return {
    ok: true, noop: result.noop, asOfDate, fills: result.fills.length, exits: result.exits.length,
    openPositions: Object.keys(result.state.positions).length, pending: result.state.pending.length,
    skipped: result.skipped, unpriced, truncated, priced: Object.keys(prices).length,
    reconcile: result.state.reconcile ? result.state.reconcile.status : null, equity: result.point.equity, ms: deps.now().getTime() - t0,
  };
}

async function runHouseBookTick(req, res, injected = {}) {
  noStore(res);
  const deps = { ...defaultDeps(), ...injected };
  if (!deps.hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  try { return res.status(200).json(await tickCore(deps)); }
  catch (e) { return res.status(502).json({ ok: false, error: `house-book tick failed — nothing written: ${errMsg(e)}` }); }
}

// ── Reads ───────────────────────────────────────────────────────────────────
function metricsFromPoints(points) {
  const pts = (points || []).filter((p) => p && Number.isFinite(p.equity));
  const equity = PM.simpleReturns(pts.map((p) => p.equity));
  const withSpy = pts.every((p) => Number.isFinite(p.spyClose));
  const bench = withSpy ? PM.simpleReturns(pts.map((p) => p.spyClose)) : null;
  return PM.summarize(equity, { benchmarkReturns: bench && bench.length === equity.length ? bench : null });
}

const trimPosition = (p) => ({ id: p.id, symbol: p.symbol, fillDate: p.fillDate, fillPrice: p.fillPrice, quantity: p.quantity, stop: p.stop, target: p.target, horizonSessions: p.horizonSessions, timeframe: p.timeframe, costTier: p.costTier, source: p.source, mark: p.mark, unrealizedPct: p.mark ? (p.mark.price / p.fillPrice - 1) * 100 : null });
const trimClosed = (p) => ({ id: p.id, symbol: p.symbol, fillDate: p.fillDate, fillPrice: p.fillPrice, exit: p.exit, netReturnPct: p.netReturnPct, realizedPnl: p.realizedPnl, timeframe: p.timeframe, costTier: p.costTier, source: p.source });

const DISCLOSURE = 'Simulated paper book, weight 0: every Session Board A/B long row bought at the next open under exec-v1 with tier slippage, equal $5,000 notional, exited at stop / target / the time-frame horizon. Not a track record of anything tradeable — an accounting cross-check of the Scoreboard.';

async function runHouseBook(req, res, injected = {}) {
  const deps = { ...defaultDeps(), ...injected };
  const [state, equity] = await Promise.all([deps.readJSON(STATE_PATH), deps.readJSON(EQUITY_PATH)]);
  const points = (equity && Array.isArray(equity.points)) ? equity.points : [];
  if (!state || !points.length) { noStore(res); return res.status(200).json({ ok: true, empty: true, state: 'SHADOW', weight: 0, disclosure: DISCLOSURE, note: 'The house book starts with the first nightly op=housebooktick after deploy.' }); }
  cached(res, READ_CACHE_S);
  const open = Object.values(state.positions).map(trimPosition).sort((a, b) => (a.fillDate < b.fillDate ? 1 : -1));
  const closed = [...state.closed].sort((a, b) => (a.exit.date < b.exit.date ? 1 : -1));
  return res.status(200).json({
    ok: true, version: PP.VERSION, state: 'SHADOW', weight: 0, asOfDate: state.lastSessionDate,
    policy: { execution: 'exec-v1 NEXT_OPEN_PLUS_SLIPPAGE', notionalPerPosition: state.notionalPerPosition, initialCash: state.initialCash, horizons: PP.HORIZON_SESSIONS, grades: ['A', 'B'], side: 'long only' },
    book: {
      cash: state.cash, equity: state.equity ? state.equity.equity : null, initialCash: state.initialCash,
      openPositions: open, recentClosed: closed.slice(0, RECENT_CLOSED).map(trimClosed),
      recentActivities: [...state.activities].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, RECENT_ACTIVITIES),
      counts: { open: open.length, closed: state.closed.length + state.archived.closedCount, pending: state.pending.length, activities: state.activities.length + state.archived.activityCount, skipped: state.skipped.counts },
      realizedPnl: state.equity ? state.equity.realizedPnl : null, unrealizedPnl: state.equity ? state.equity.unrealizedPnl : null,
    },
    equity: { points: points.map((p) => ({ date: p.date, equity: p.equity, spyClose: p.spyClose, openPositions: p.openPositions })) },
    metrics: metricsFromPoints(points),
    reconcile: state.reconcile,
    disclosure: DISCLOSURE,
  });
}

// ── My book (client rows) ───────────────────────────────────────────────────
// `rows` = comma-separated `TICKER~DATE~TIMEFRAME~STOP~TARGET~GRADE~SECTION`; DATE is a
// session date or the board's ISO generatedAt (resolved to its last completed session).
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SECTION_RE = /^[A-Za-z0-9_\-]{0,32}$/;

function parseDateField(raw) {
  if (DATE_RE.test(raw) && Number.isFinite(Date.parse(`${raw}T00:00:00Z`))) return raw;
  if (/T/.test(raw) && Number.isFinite(Date.parse(raw))) return MS.lastCompletedRegularSession(new Date(raw));
  return null;
}
function parseLevel(raw, name) {
  if (raw === '') return { value: null };
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? { value: v } : { error: `${name} must be a positive number` };
}

function parseClientRow(part, i) {
  const [ticker = '', date = '', tf = '', stopRaw = '', targetRaw = '', grade = '', section = ''] = part.split('~').map((s) => s.trim());
  const at = `row ${i + 1}`;
  if (!TICKER_RE.test(ticker)) return { error: `${at}: ticker must be 1-10 upper-case symbol characters` };
  const signalDate = parseDateField(date);
  if (!signalDate) return { error: `${at}: date must be YYYY-MM-DD or an ISO timestamp` };
  if (!PP.HORIZON_SESSIONS[tf]) return { error: `${at}: time frame must be one of ${Object.keys(PP.HORIZON_SESSIONS).join(', ')}` };
  const stop = parseLevel(stopRaw, 'stop'); if (stop.error) return { error: `${at}: ${stop.error}` };
  const target = parseLevel(targetRaw, 'target'); if (target.error) return { error: `${at}: ${target.error}` };
  if (grade && !/^[A-F]$/.test(grade)) return { error: `${at}: grade must be a letter A-F` };
  if (!SECTION_RE.test(section)) return { error: `${at}: section has invalid characters` };
  const item = { id: `${section || 'mybook'}:${tf}:${ticker}`, ticker, side: 'long', horizon: tf, timeframe: { key: tf }, section: section || null, tier: null, grade: { letter: grade || null }, levels: { stop: stop.value, target: target.value }, flags: {} };
  return { row: PP.rowFromItem(item, signalDate, `mybook:${signalDate}`) };
}

// { rows, error } — fail fast on the first bad row, never trust the query.
function parseClientRows(raw) {
  const parts = String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { rows: [], error: 'no rows supplied' };
  if (parts.length > MY_BOOK_MAX_ROWS) return { rows: [], error: `at most ${MY_BOOK_MAX_ROWS} rows per request` };
  const rows = [];
  for (let i = 0; i < parts.length; i++) {
    const r = parseClientRow(parts[i], i);
    if (r.error) return { rows: [], error: r.error };
    rows.push(r.row);
  }
  return { rows, error: null };
}

function rowStatus(sim, row) {
  const id = `${row.rowId}@${row.signalDate}`;
  const open = sim.state.positions[id];
  if (open) return { ticker: row.ticker, signalDate: row.signalDate, status: 'open', fillDate: open.fillDate, fillPrice: open.fillPrice, mark: open.mark, unrealizedPct: open.mark ? (open.mark.price / open.fillPrice - 1) * 100 : null, exit: null, netReturnPct: null, costTier: row.costTier };
  const closed = sim.state.closed.find((p) => p.id === id);
  if (closed) return { ticker: row.ticker, signalDate: row.signalDate, status: 'closed', fillDate: closed.fillDate, fillPrice: closed.fillPrice, mark: null, unrealizedPct: null, exit: closed.exit, netReturnPct: closed.netReturnPct, costTier: row.costTier };
  const skip = sim.state.skipped.recent.find((s) => s.ticker === row.ticker);
  return { ticker: row.ticker, signalDate: row.signalDate, status: sim.state.pending.some((p) => p.rowId === row.rowId) ? 'pending' : 'skipped', reason: skip ? skip.reason : null, fillDate: null, fillPrice: null, mark: null, unrealizedPct: null, exit: null, netReturnPct: null, costTier: row.costTier };
}

async function runMyBook(req, res, injected = {}) {
  const deps = { ...defaultDeps(), ...injected };
  const parsed = parseClientRows(req && req.query && req.query.rows);
  if (parsed.error) { noStore(res); return res.status(400).json({ ok: false, error: parsed.error }); }
  try {
    const due = deps.sessionDue(deps.now());
    const { prices, unpriced } = await fetchPrices(parsed.rows.map((r) => r.ticker), deps);
    const spy = prices[BENCH] || [];
    const asOfDate = due && spy.length && spy[spy.length - 1].date < due ? spy[spy.length - 1].date : (due || (spy.length ? spy[spy.length - 1].date : null));
    if (!asOfDate) throw new Error('no benchmark series — cannot value the book');
    const sim = PP.simulateRows(parsed.rows, prices, { asOfDate });
    const points = PP.equitySeries(sim.state.activities, prices, { asOfDate, initialCash: sim.state.initialCash });
    if (unpriced.length) noStore(res); else cached(res, MY_BOOK_CACHE_S);
    return res.status(200).json({
      ok: true, version: PP.VERSION, asOfDate, policy: 'exec-v1 NEXT_OPEN_PLUS_SLIPPAGE · equal $5,000 notional · stop / target / horizon exits',
      rows: parsed.rows.map((r) => rowStatus(sim, r)), unpriced,
      equity: { points: points.map((p) => ({ date: p.date, equity: p.equity, spyClose: p.spyClose })) },
      metrics: metricsFromPoints(points), initialCash: sim.state.initialCash, cash: sim.state.cash,
      disclosure: 'Your marked rows, simulated under the house policy — a paper valuation, not a brokerage record.',
    });
  } catch (e) {
    noStore(res);
    return res.status(502).json({ ok: false, error: `my-book valuation failed: ${errMsg(e)}` });
  }
}

module.exports = {
  runHouseBookTick, runHouseBook, runMyBook, tickCore, fetchPrices, parseClientRows, metricsFromPoints,
  SNAPSHOT_PATH, SUMMARY_PATH, STATE_PATH, EQUITY_PATH, FETCH_BUDGET_MS, FETCH_CONCURRENCY, MY_BOOK_MAX_ROWS,
};

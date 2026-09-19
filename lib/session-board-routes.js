'use strict';
// op=sessionboard — public GET. Owns every fetch/store call for lib/session-board (pure).
//
// Sources, each FAIL-SOFT (an unavailable source removes its component, never the board):
//   today      op=today (CDN-cached 600s, session-blind) → decision rows + regime + density
//   daytrade   op=daytrade → lifecycle lanes (active states only)
//   scoreboard scoreboard/summary.json (persisted; the record maturity/governance judge on)
//   governance governance/latest.json → per-section maturity grade + "any weight > 0"
//   market     pulse/v2/market-state/latest.json → mode + SPY day return
//   premarket  lib/premarket-snapshot (builder B2) — pre/post-market quote fields + gap lane
//   live       lib/session-live-state (builder B4) — entry/stop/target status per item
//
// Snapshot freshness is SESSION-AWARE (the tech-command pattern): a persisted board is served
// as-is for SNAPSHOT_FRESH_MS inside a session and SNAPSHOT_FRESH_CLOSED_MS outside one, so
// a closed-market page load does not pay a 750-name quote fan-out for a board that cannot
// have changed. CDN: never cache an empty or degraded board (the bearcase trap).
const SB = require('./session-board');
const MS = require('./market-session');
const STORE = require('./store');
const NL = require('./negative-lanes');
const SC = require('./strategy-contracts');

const SNAPSHOT_PATH = 'sessionboard/latest.json';
const SCOREBOARD_SUMMARY_PATH = 'scoreboard/summary.json';
const GOVERNANCE_PATH = 'governance/latest.json';
const SNAPSHOT_FRESH_MS = 60 * 1000;                 // inside a session
const SNAPSHOT_FRESH_CLOSED_MS = 15 * 60 * 1000;     // market closed — nothing moves
// MEASURED 2026-09-19: persisted scoreboard read ~0.6s; op=today CDN hit <1s, miss ~16-20s;
// op=daytrade ~10s cache-miss; a 750-name Yahoo bulk quote ≈ 8 requests ≈ 2-3s. The route
// runs its pulls in parallel, so the wall is the slowest one; 30s clears the measured
// worst case with headroom (never set a timeout without measuring the slowest dep).
const PULL_TIMEOUT_MS = 30000;
const LIVE_BARS_TOP_N = 30;
const OPEN_PHASES = new Set(['premarket', 'regular']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function isFresh(snapshot, now) {
  if (!snapshot || !snapshot.generatedAt) return false;
  const age = now.getTime() - Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(age) || age < 0) return false;
  const phase = MS.sessionInfoAt(now).marketSession;
  return age <= (phase === 'closed' ? SNAPSHOT_FRESH_CLOSED_MS : SNAPSHOT_FRESH_MS);
}

function cacheHeaderFor(payload, phase) {
  const degraded = payload.empty || (payload.sources || []).some((s) => s && s.ok === false);
  if (degraded) return 'no-store';
  return OPEN_PHASES.has(phase) ? 's-maxage=60, stale-while-revalidate=120' : 's-maxage=300, stale-while-revalidate=600';
}

async function timed(name, fn, sources) {
  const t0 = Date.now();
  try {
    const data = await fn();
    const ok = data != null;
    sources.push({ source: name, ok, ms: Date.now() - t0, reason: ok ? null : 'empty' });
    return data;
  } catch (e) {
    sources.push({ source: name, ok: false, ms: Date.now() - t0, reason: String((e && e.message) || e).slice(0, 200) });
    return null;
  }
}

function optionalModule(path) {
  try { return require(path); } catch { return null; }
}

// Per-section maturity grade from the persisted governance doc (op=maturity writes it).
function maturityBySectionOf(governance) {
  const out = {};
  for (const s of ((governance && governance.strategies) || [])) {
    if (!s || !s.grade) continue;
    if (s.section) out[s.section] = s.grade;
    if (s.id) out[s.id] = s.grade;
  }
  for (const [section, id] of Object.entries(SC.SECTION_TO_ID)) if (!out[section] && out[id]) out[section] = out[id];
  return out;
}

function daytradeRowsOf(dt) {
  if (!dt || !dt.lanes) return [];
  const lanes = dt.lanes;
  return ['actionableNow', 'reversalReclaim', 'armed', 'managing', 'buildingWatch']
    .flatMap((k) => (Array.isArray(lanes[k]) ? lanes[k] : []));
}

function defaultDeps() {
  const R = require('./decision-routes');
  const pre = optionalModule('./premarket-snapshot');
  const live = optionalModule('./session-live-state');
  return {
    now: () => new Date(),
    pullToday: () => R.pull('/api/tracker?op=today', { timeoutMs: PULL_TIMEOUT_MS }).then((r) => (r.ok ? r.data : null)),
    pullDaytrade: () => R.pull('/api/tracker?op=daytrade', { timeoutMs: PULL_TIMEOUT_MS }).then((r) => (r.ok ? r.data : null)),
    readJSON: (p) => STORE.readJSON(p, null),
    writeJSON: (p, doc) => STORE.writeJSON(p, doc, 0),
    hasStore: () => STORE.hasStore(),
    readMarketState: () => require('./pulse2-store').readMarketState(),
    fetchPremarketSnapshot: pre ? pre.fetchPremarketSnapshot : null,
    premarketGapLane: pre ? pre.premarketGapLane : null,
    liveStatus: live ? live.liveStatus : null,
    fetchIntradayBatch: (tickers, opts) => require('./intraday-data').fetchIntradayBatch(tickers, opts),
    universe: () => { const U = require('./universe'); return [...new Set([...U.LARGE, ...U.SMALL_CAPS, ...U.MICRO_CAPS])]; },
  };
}

// The tickers the premarket/after-hours snapshot should cover: every board name plus the
// screener universe pools (so the gap lane can surface names no engine has picked yet).
// Inside regular hours only the board names are quoted (the intraday scanner owns discovery).
function snapshotUniverse(phase, itemTickers, deps) {
  if (phase === 'regular') return [...new Set(itemTickers)];
  let pool = [];
  try { pool = deps.universe ? deps.universe() : []; } catch { pool = []; }
  return [...new Set([...itemTickers, ...pool])];
}

async function buildBoard(deps) {
  const now = deps.now();
  const session = SB.sessionPhase(now);
  const sources = [];
  const [today, daytrade, summary, governance, market] = await Promise.all([
    timed('today', deps.pullToday, sources),
    timed('daytrade', deps.pullDaytrade, sources),
    timed('scoreboard', () => deps.readJSON(SCOREBOARD_SUMMARY_PATH), sources),
    timed('governance', () => deps.readJSON(GOVERNANCE_PATH), sources),
    timed('market', deps.readMarketState, sources),
  ]);
  const todayRows = SB.collectTodayRows(today);
  const daytradeRows = daytradeRowsOf(daytrade).filter((c) => c && (!c.lifecycleState || SB.DAYTRADE_ACTIVE.has(c.lifecycleState)));
  const itemTickers = [...new Set([...todayRows.map((r) => r.ticker), ...daytradeRows.map((c) => c.ticker)].filter(Boolean))];

  let premarket = null;
  if (deps.fetchPremarketSnapshot) {
    premarket = await timed('premarket', async () => {
      const snap = await deps.fetchPremarketSnapshot(snapshotUniverse(session.phase, itemTickers, deps), { now });
      if (!snap || !Array.isArray(snap.rows)) return null;
      const gapLane = (deps.premarketGapLane && session.phase !== 'regular') ? deps.premarketGapLane(snap.rows) : [];
      return { ...snap, gapLane };
    }, sources);
  } else {
    sources.push({ source: 'premarket', ok: false, ms: 0, reason: 'module-missing' });
  }

  const quoteByTicker = new Map(((premarket && premarket.rows) || []).map((r) => [r.ticker, r]));
  const liveByTicker = {};
  if (deps.liveStatus) {
    let barsByTicker = {};
    if (session.phase === 'regular' && deps.fetchIntradayBatch && itemTickers.length) {
      barsByTicker = (await timed('bars', async () => {
        const res = await deps.fetchIntradayBatch(itemTickers.slice(0, LIVE_BARS_TOP_N), { now });
        const out = {};
        for (const r of (Array.isArray(res) ? res : Object.values(res || {}))) if (r && r.ok && r.ticker) out[r.ticker] = r;
        return out;
      }, sources)) || {};
    }
    const rowsByTicker = new Map([...todayRows, ...daytradeRows.map(SB.daytradeToRow)].map((r) => [r.ticker, r]));
    for (const t of itemTickers) {
      try {
        liveByTicker[t] = deps.liveStatus({ row: rowsByTicker.get(t), quote: quoteByTicker.get(t) || null, bars: barsByTicker[t] || null, session: session.phase, now });
      } catch (e) {
        liveByTicker[t] = { status: 'unknown', note: `live read failed: ${String((e && e.message) || e).slice(0, 80)}` };
      }
    }
  } else {
    sources.push({ source: 'live', ok: false, ms: 0, reason: 'module-missing' });
  }

  const negativeLanes = summary ? ((Array.isArray(summary.negativeLanes) && summary.negativeLanes.length) ? summary.negativeLanes : NL.negativeLanes(summary)) : [];
  const payload = SB.assembleSessionBoard({
    now, session, todayRows, daytradeRows, premarket, liveByTicker,
    regime: today ? today.regime : null,
    market: market || (today && today.sectors ? { leading: today.sectors.leading, weakening: today.sectors.weakening } : null),
    negativeLanes, maturityBySection: maturityBySectionOf(governance),
    governance, density: today ? today.opportunity || null : null, sources,
  });
  payload.elapsedMs = Date.now() - now.getTime();
  payload.governanceWeightSeen = !!(governance && (governance.strategies || []).some((s) => num(s && s.weight) > 0));
  return payload;
}

async function runSessionBoard(req, res, injected = {}) {
  const deps = { ...defaultDeps(), ...injected };
  const now = deps.now();
  const phase = MS.sessionInfoAt(now).marketSession;
  const wantFresh = req && req.query && req.query.refresh === '1';
  if (!wantFresh) {
    const snap = await Promise.resolve(deps.readJSON(SNAPSHOT_PATH)).catch(() => null);
    if (snap && snap.version === SB.VERSION && isFresh(snap, now)) {
      res.setHeader('Cache-Control', cacheHeaderFor(snap, phase));
      return res.status(200).json({ ...snap, served: 'persisted-snapshot', snapshotAgeMs: now.getTime() - Date.parse(snap.generatedAt) });
    }
  }
  let payload;
  try { payload = await buildBoard(deps); }
  catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: false, version: SB.VERSION, error: String((e && e.message) || e).slice(0, 300), empty: true, items: [], heldOut: [] });
  }
  payload.served = 'built';
  if (deps.hasStore && deps.hasStore() && !payload.empty) {
    try { await deps.writeJSON(SNAPSHOT_PATH, payload); payload.persisted = true; }
    catch (e) { payload.persisted = false; payload.persistError = String((e && e.message) || e).slice(0, 200); }
  }
  res.setHeader('Cache-Control', cacheHeaderFor(payload, phase));
  return res.status(200).json(payload);
}

module.exports = {
  runSessionBoard, buildBoard, cacheHeaderFor, isFresh, maturityBySectionOf, daytradeRowsOf, snapshotUniverse,
  SNAPSHOT_PATH, SNAPSHOT_FRESH_MS, SNAPSHOT_FRESH_CLOSED_MS, PULL_TIMEOUT_MS, LIVE_BARS_TOP_N,
};

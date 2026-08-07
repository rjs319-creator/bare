'use strict';
// TECH COMMAND CENTER — SNAPSHOT BUILDER (tech-command-build-v1).
//
// Gathers the inputs and assembles the versioned snapshot the page renders. Two
// modes, and the difference between them is the whole cost/honesty contract:
//
//   'full'  — run by the AUTHENTICATED tick only. Loads the technology universe,
//             pulls the already-cached public boards, fetches a bounded set of
//             daily candles, computes the regime with real breadth, evaluates the
//             long-term model over a bounded shortlist, and builds the event
//             timeline. This is the only mode that may be persisted.
//
//   'lite'  — the PUBLIC read's fallback when no fresh snapshot exists. Benchmarks
//             only (no breadth), no fundamentals, no news fan-out, no persistence.
//             Everything it cannot compute is reported as unavailable BY NAME, so
//             a lite payload can never be mistaken for a full one.
//
// Nothing here writes. Persistence and lifecycle advancement live in the routes.

const { internalHeaders } = require('./auth');
const { sessionInfoAt } = require('./market-session');
const { fetchDailyHistory } = require('./screener');
const { loadCandleCache, cacheGet } = require('./candle-cache');

const UNI = require('./tech-command-universe');
const REG = require('./tech-command-regime');
const DT = require('./tech-command-daytrade');
const SW = require('./tech-command-swing');
const LT = require('./tech-command-longterm');
const EVT = require('./tech-command-events');
const RTH = require('./tech-command-readthrough');
const OPT = require('./tech-command-options');
const SOC = require('./tech-command-sentiment');
const RISK = require('./tech-command-risk');
const DOS = require('./tech-command-dossier');

const SNAPSHOT_VERSION = 'tech-command-v1';
const HOST = process.env.WARM_HOST || 'market-news-app-chi.vercel.app';

const LIMITS = Object.freeze({
  full: { breadthSample: 300, contextTickers: 60, fundamentals: 18, news: 10, candleConcurrency: 8, deadlineMs: 45000 },
  lite: { breadthSample: 0, contextTickers: 18, fundamentals: 0, news: 0, candleConcurrency: 6, deadlineMs: 20000 },
});
const BOARD_LIMIT = 5;   // max names per horizon on the default view

const num = v => (Number.isFinite(v) ? v : null);
const closesOf = c => (Array.isArray(c) ? c.map(x => x && x.close).filter(Number.isFinite) : []);

// ── Bounded self-fetch of an already-cached PUBLIC op ────────────────────────
// Public reads send NO Authorization header: a CDN will not serve a cached
// response to an authenticated request, so adding one would recompute at origin
// on every call (the defect fixed in lib/ignition-routes / swing-supervisor).
async function pull(path, { authenticated = false, timeoutMs = 15000 } = {}) {
  const t0 = Date.now();
  try {
    const headers = authenticated ? internalHeaders() : { 'x-warm': '1' };
    const r = await fetch(`https://${HOST}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { ok: false, status: r.status, ms: Date.now() - t0, data: null };
    return { ok: true, ms: Date.now() - t0, data: await r.json() };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), ms: Date.now() - t0, data: null };
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

/** Fetch daily candles for `tickers`, preferring the shared candle cache. */
async function gatherCandles(tickers, { concurrency = 6, deadline = null, t0 = Date.now(), range = '1y', cacheDoc = null } = {}) {
  const out = {};
  const need = [];
  for (const t of [...new Set(tickers)].filter(Boolean)) {
    const hit = cacheDoc ? cacheGet(cacheDoc, t) : null;
    if (hit && hit.candles && hit.candles.length >= 60) out[t] = hit.candles;
    else need.push(t);
  }
  await mapLimit(need, concurrency, async (t) => {
    if (deadline && Date.now() - t0 > deadline) return;
    try {
      const h = await fetchDailyHistory(t, range);
      if (h && Array.isArray(h.candles) && h.candles.length) out[t] = h.candles;
    } catch { /* a missing name is missing, not zero */ }
  });
  return out;
}

// ── Per-ticker technology context ───────────────────────────────────────────
function contextFor(ticker, candles, { qqq, benchCandles, subsectorRanks, earnings, asOf }) {
  const c = closesOf(candles);
  if (c.length < 25) return { asOf, insufficient: true };
  const q = closesOf(qqq);
  const b = closesOf(benchCandles);
  const ret = n => REG.retPct(c, n);
  const rel = (series, n) => {
    const a = ret(n), s = REG.retPct(series, n);
    return (a == null || s == null) ? null : +(a - s).toFixed(2);
  };
  // ATR% from true ranges over 14 sessions.
  let atrPct = null;
  if (Array.isArray(candles) && candles.length >= 15) {
    const win = candles.slice(-15);
    let sum = 0, n = 0;
    for (let i = 1; i < win.length; i++) {
      const h = win[i].high, l = win[i].low, pc = win[i - 1].close;
      if (![h, l, pc].every(Number.isFinite)) continue;
      sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)); n++;
    }
    const last = c[c.length - 1];
    if (n && last > 0) atrPct = +((sum / n / last) * 100).toFixed(2);
  }
  // Median 20-session dollar volume (median, so one halt-day spike cannot carry it).
  let dollarVolume = null;
  if (Array.isArray(candles)) {
    const dv = candles.slice(-20).map(x => (Number.isFinite(x.close) && Number.isFinite(x.volume) ? x.close * x.volume : null)).filter(v => v != null);
    if (dv.length >= 5) dollarVolume = Math.round([...dv].sort((a, b) => a - b)[Math.floor(dv.length / 2)]);
  }
  const rankRec = subsectorRanks && subsectorRanks[ticker] ? subsectorRanks[ticker] : null;
  const e = earnings && earnings[ticker] ? earnings[ticker] : null;
  return {
    rsVsQqq21: rel(q, 21), rsVsQqq126: rel(q, 126),
    rsVsSubsector21: b.length ? rel(b, 21) : null,
    rsVsSubsector126: b.length ? rel(b, 126) : null,
    subsectorRank: rankRec ? rankRec.rank : null,
    subsectorCount: rankRec ? rankRec.count : null,
    rankAccel: rankRec ? rankRec.accel : null,
    atrPct, dollarVolume,
    betaVsQqq: betaOf(c, q),
    pctChange1d: ret(1), pctChange5d: ret(5), pctChange21d: ret(21),
    earningsInDays: e ? num(e.earningsInDays) : null,
    earningsDate: e ? e.earningsDate || null : null,
    asOf,
  };
}

function betaOf(c, q) {
  const a = REG.dailyReturns(c).slice(-126), b = REG.dailyReturns(q).slice(-126);
  const n = Math.min(a.length, b.length);
  if (n < 40) return null;
  const x = b.slice(-n), y = a.slice(-n);
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let cov = 0, vx = 0;
  for (let i = 0; i < n; i++) { cov += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) ** 2; }
  return vx > 0 ? +(cov / vx).toFixed(2) : null;
}

/** Rank each ticker inside its own subsector by 21-session return, plus the change vs 10 sessions ago. */
function subsectorRanksOf(universe, candlesByTicker) {
  const out = {};
  for (const [subsector, tickers] of Object.entries((universe && universe.bySubsector) || {})) {
    const scored = tickers
      .map(t => {
        const c = closesOf(candlesByTicker[t]);
        if (c.length < 32) return null;
        return { t, now: REG.retPct(c, 21), then: REG.retPct(c.slice(0, c.length - 10), 21) };
      })
      .filter(x => x && x.now != null);
    if (scored.length < 2) continue;
    const byNow = [...scored].sort((a, b) => b.now - a.now);
    const byThen = [...scored].filter(x => x.then != null).sort((a, b) => b.then - a.then);
    const thenRank = Object.fromEntries(byThen.map((x, i) => [x.t, i + 1]));
    byNow.forEach((x, i) => {
      const prev = thenRank[x.t] ?? null;
      out[x.t] = { subsector, rank: i + 1, count: byNow.length, accel: prev == null ? null : prev - (i + 1) };
    });
  }
  return out;
}

// ── The snapshot ────────────────────────────────────────────────────────────
/**
 * @param {{mode?: 'full'|'lite', now?: Date, t0?: number}} opts
 */
async function buildSnapshot({ mode = 'lite', now = new Date(), t0 = Date.now(), forceUniverseRebuild = false } = {}) {
  const L = LIMITS[mode] || LIMITS.lite;
  const nowIso = new Date(now).toISOString();
  const session = sessionInfoAt(now);
  const warnings = [];
  const sourceHealth = {};
  const unavailable = [];

  // 1. Universe (one Blob read + at most one provider build).
  // forceUniverseRebuild is an OPERATIONAL escape hatch, reachable only from the
  // authenticated tick. The version stamp on the artifact already handles the normal
  // case (a code change that alters the artifact's contents invalidates the cache);
  // this exists for the times it doesn't — a provider outage that poisoned a build,
  // or a directory correction landing mid-day.
  const universe = await UNI.loadTechUniverse({ now, forceRebuild: forceUniverseRebuild }).catch(e => {
    warnings.push(`Universe load failed: ${String((e && e.message) || e)}`);
    return null;
  });
  if (!universe) {
    return degradedSnapshot({ nowIso, session, reason: 'The technology universe could not be loaded.', mode });
  }
  if (universe.degraded) warnings.push('Technology universe is running on the CURATED FALLBACK — coverage is partial and labeled.');
  universe.warnings.forEach(w => warnings.push(w));

  // 2. Already-cached public boards (no recomputation at origin).
  const paths = {
    daytrade: '/api/tracker?op=daytrade',
    today: '/api/tracker?op=today',
    optionsflow: '/api/tracker?op=optionsflow',
    attention: '/api/tracker?op=attention',
  };
  const keys = Object.keys(paths);
  const pulled = await Promise.all(keys.map(k => pull(paths[k])));
  const src = {};
  keys.forEach((k, i) => {
    src[k] = pulled[i].data;
    sourceHealth[k] = { ok: pulled[i].ok, status: pulled[i].status || null, ms: pulled[i].ms, error: pulled[i].error || null };
    if (!pulled[i].ok) warnings.push(`Source ${k} unavailable (${pulled[i].status || pulled[i].error}) — the sections that depend on it are empty for that reason, not because nothing qualified.`);
  });

  // 3. Candles. Benchmarks always; members only in full mode (from the shared cache).
  const cacheDoc = await loadCandleCache('large').catch(() => null);
  const benchmarks = await gatherCandles(REG.REGIME_TICKERS, { concurrency: L.candleConcurrency, deadline: L.deadlineMs, t0, cacheDoc });

  const dtTickers = collectTickers(src.daytrade);
  const swingSignals = ((src.today && src.today.horizons && src.today.horizons.swing) || [])
    .filter(s => s && universe.byTicker[String(s.ticker).toUpperCase()]);
  const focusTickers = [...new Set([
    ...dtTickers.filter(t => universe.byTicker[t]),
    ...swingSignals.map(s => String(s.ticker).toUpperCase()),
  ])].slice(0, L.contextTickers);

  let memberCandles = {};
  if (L.breadthSample > 0) {
    const sample = universe.securities.slice(0, L.breadthSample).map(s => s.ticker);
    // Cache-only for the breadth sample: a wide fan-out is exactly what this page
    // must not do. Names absent from the cache simply do not enter breadth.
    for (const t of sample) {
      const hit = cacheDoc ? cacheGet(cacheDoc, t) : null;
      if (hit && hit.candles && hit.candles.length >= 60) memberCandles[t] = hit.candles;
    }
    if (!Object.keys(memberCandles).length) warnings.push('Shared candle cache held no technology names — breadth is withheld this cycle.');
  } else {
    unavailable.push({ what: 'technology breadth (% above moving averages, advancers/decliners, new highs/lows, dispersion, crowding)', why: 'the public read does not run a universe-wide candle fan-out; these are computed by the scheduled tick' });
  }

  const focusCandles = await gatherCandles(focusTickers, { concurrency: L.candleConcurrency, deadline: L.deadlineMs, t0, cacheDoc });
  const allCandles = { ...memberCandles, ...focusCandles };

  // 4. Regime.
  const regime = REG.buildRegime({ benchmarks, members: memberCandles, now, sessionInfo: session });

  // 5. Per-ticker context.
  const ranks = subsectorRanksOf(universe, allCandles);
  const earnings = {};
  if (L.fundamentals > 0) {
    const { fetchEarningsInfo } = require('./fundamentals');
    const wanted = focusTickers.slice(0, L.fundamentals);
    await mapLimit(wanted, 4, async (t) => {
      if (Date.now() - t0 > L.deadlineMs) return;
      try { const e = await fetchEarningsInfo(t); if (e) earnings[t] = e; } catch { /* unknown stays unknown */ }
    });
  } else {
    unavailable.push({ what: 'earnings dates', why: 'the public read does not call the earnings calendar; the scheduled tick supplies them' });
  }

  const benchCandlesFor = (t) => {
    const u = universe.byTicker[t];
    return (u && u.benchmark && benchmarks[u.benchmark]) || null;
  };
  const context = {};
  for (const t of focusTickers) {
    if (!allCandles[t]) continue;
    context[t] = contextFor(t, allCandles[t], {
      qqq: benchmarks.QQQ, benchCandles: benchCandlesFor(t), subsectorRanks: ranks, earnings,
      asOf: lastBarDate(allCandles[t]),
    });
  }

  // 6. Boards.
  const daytrade = DT.projectDaytradeBoard({
    payload: src.daytrade, universe, now,
    annotations: Object.fromEntries(Object.entries(context).map(([t, c]) => [t, {
      rsVsQqqPct: c.rsVsQqq21, rsVsSubsectorPct: c.rsVsSubsector21,
      subsectorBenchmark: universe.byTicker[t] ? universe.byTicker[t].benchmark : null, asOf: c.asOf,
    }])),
  });

  const swing = SW.buildSwingBoard({ signals: swingSignals, universe, context, regime, now, limit: BOARD_LIMIT });

  let longterm;
  if (L.fundamentals > 0) {
    longterm = await buildLongTermSection({ universe, context, allCandles, benchmarks, regime, focusTickers, limit: L.fundamentals, now, t0, deadline: L.deadlineMs });
  } else {
    longterm = LT.buildLongTermBoard({ candidates: [], universe, regime, now, limit: BOARD_LIMIT });
    unavailable.push({ what: 'long-term investment board', why: 'it needs company fundamentals, which the public read does not fetch. The scheduled tick computes it.' });
  }

  // 7. Options / social / read-through / events.
  const optRows = (src.optionsflow && (src.optionsflow.byTicker || src.optionsflow.tickers || src.optionsflow.rollup)) || [];
  const setups = {};
  for (const r of swing.rows) setups[r.ticker] = { direction: r.side === 'short' ? 'short' : 'long', valid: r.action === 'ENTER' || r.action === 'READY' };
  const options = OPT.buildOptionsSection({
    rollup: optRows, universe, setups, now,
    asOf: (src.optionsflow && (src.optionsflow.generatedAt || src.optionsflow.asOf)) || null,
  });

  const attention = (src.attention && (src.attention.classification || src.attention)) || null;
  const priceContext = Object.fromEntries(Object.entries(context).map(([t, c]) => [t, { pctChange1d: c.pctChange1d, pctChange5d: c.pctChange5d }]));
  const sentiment = SOC.buildSentimentSection({ attention, universe, priceContext, now });

  const moves = {};
  for (const [t, c] of Object.entries(context)) {
    moves[t] = { pctChange: c.pctChange1d, relVol: null, rsVsQqq: c.rsVsQqq21, rsVsSubsector: c.rsVsSubsector21, asOf: c.asOf };
  }
  const readthrough = RTH.buildReadThrough({ universe, moves, earningsByTicker: earnings, now });

  const events = EVT.buildTimeline({
    events: assembleEvents({ src, universe, earnings, context, now, limit: L.news }),
    present: { byTicker: Object.fromEntries(Object.entries(context).map(([t, c]) => [t, {
      pctChange: c.pctChange1d, relVol: null, rsVsQqq: c.rsVsQqq21, rsVsSubsector: c.rsVsSubsector21,
      attentionState: (sentiment.rows.find(r => r.ticker === t) || {}).state || null,
      optionsState: (options.rows.find(r => r.ticker === t) || {}).state || null,
    }])) },
    now,
  });

  // 8. Scenarios for the names actually on a board.
  const featured = [...new Set([
    ...daytrade.rows.slice(0, BOARD_LIMIT).map(r => r.ticker),
    ...swing.featured.map(r => r.ticker),
    ...longterm.featured.map(r => r.ticker),
  ])];
  const scenarios = {};
  for (const t of featured) {
    const swRow = swing.rows.find(r => r.ticker === t);
    const dtRow = daytrade.rows.find(r => r.ticker === t);
    const nextEvent = events.upcoming.find(e => e.ticker === t) || null;
    scenarios[t] = EVT.buildScenarios({
      ticker: t, universeRecord: universe.byTicker[t], nextEvent,
      levels: {
        trigger: (swRow && swRow.trigger) ?? (dtRow && dtRow.trigger) ?? null,
        invalidation: (swRow && swRow.invalidation) ?? (dtRow && dtRow.invalidation) ?? null,
        target: (swRow && swRow.target) ?? (dtRow && dtRow.target) ?? null,
        price: (dtRow && dtRow.price) ?? (swRow && swRow.price) ?? null,
      },
      expectedMovePct: (options.rows.find(r => r.ticker === t) || {}).expectedMovePct ?? null,
      peers: ((universe.bySubsector[universe.byTicker[t].subsector] || []).filter(p => p !== t)).slice(0, 6),
      present: context[t] || null,
    });
  }

  // 9. Alignment + risk.
  const alignment = DOS.buildAlignment({ daytrade, swing, longterm });
  const selections = [
    ...daytrade.rows.filter(r => ['TRIGGERED', 'READY', 'MANAGE', 'WATCH'].includes(r.action)).map(r => ({ ticker: r.ticker, horizon: 'daytrade', action: r.action, side: 'long' })),
    ...swing.rows.filter(r => ['ENTER', 'READY', 'HOLD', 'WATCH'].includes(r.action)).map(r => ({ ticker: r.ticker, horizon: 'swing', action: r.action, side: r.side })),
    ...longterm.rows.filter(r => ['ACCUMULATE', 'WATCH_VALUATION', 'HOLD'].includes(r.action)).map(r => ({ ticker: r.ticker, horizon: 'longterm', action: r.action, side: 'long' })),
  ];
  const risk = RISK.buildRiskMap({ selections, universe, context, now });

  return {
    schema: SNAPSHOT_VERSION,
    mode,
    generatedAt: nowIso,
    marketSession: session.marketSession,
    sessionDate: session.etDate,
    isTradingDay: session.isTradingDay,
    universe: publicUniverse(universe),
    regime, daytrade, swing, longterm, events, scenarios,
    readthrough, options, sentiment, alignment, risk,
    dataHealth: buildDataHealth({ universe, regime, daytrade, swing, longterm, options, sentiment, sourceHealth, unavailable, nowIso }),
    disclosures: DISCLOSURES,
    warnings,
    // Internal handles the routes need; stripped from the public payload.
    _internal: { universeDoc: universe, context, allCandles, focusTickers },
  };
}

function collectTickers(daytradePayload) {
  try { return DT.allCardsOf(daytradePayload).map(c => String(c.ticker).toUpperCase()); }
  catch { return []; }
}

function lastBarDate(candles) {
  const c = Array.isArray(candles) ? candles[candles.length - 1] : null;
  return c && c.date ? c.date : null;
}

async function buildLongTermSection({ universe, context, allCandles, benchmarks, regime, focusTickers, limit, now, t0, deadline }) {
  const { fetchFundamentals, fetchRecommendation } = require('./fundamentals');
  const { longTermRead } = require('./longterm');
  // Bounded shortlist with a RESERVED split. The naive version concatenated board
  // names then mega-caps and sliced — so whenever the intraday board was busy it
  // filled every slot and the long-term board evaluated nothing but today's movers.
  // A 6-36 month model whose candidate set is chosen by intraday volume is not a
  // long-term model. Mega-caps get a protected majority of the budget; board names
  // fill the rest so a name surfaced elsewhere still gets a long-term stance for
  // its dossier, and any unused reservation flows back to the other side.
  const megaAll = universe.securities.filter(s => (s.marketCap || 0) >= UNI.MEGA_CAP_USD).map(s => s.ticker);
  const megaReserve = Math.ceil(limit * 0.6);
  const shortlist = [...new Set([
    ...megaAll.slice(0, megaReserve),
    ...focusTickers.slice(0, limit - Math.min(megaAll.length, megaReserve)),
    ...megaAll.slice(megaReserve),          // unused board budget flows back to mega-caps
    ...focusTickers,
  ])].slice(0, limit);
  const spy = benchmarks.SPY || null;

  const candidates = await mapLimit(shortlist, 4, async (t) => {
    if (Date.now() - t0 > deadline) return null;
    const candles = allCandles[t] || (await gatherCandles([t], { concurrency: 1, t0, deadline }))[t] || null;
    let fundamentals = null, revisions = null;
    try { fundamentals = await fetchFundamentals(t); } catch { /* unavailable stays unavailable */ }
    try { revisions = await fetchRecommendation(t); } catch { /* display-only anyway */ }
    const trend = candles ? longTermRead(candles, spy) : null;
    return { ticker: t, fundamentals, trend, revisions, context: context[t] || null };
  });

  return LT.buildLongTermBoard({
    candidates: candidates.filter(Boolean), universe, regime, now, limit: BOARD_LIMIT,
  });
}

// News + scheduled events. In lite mode `limit` is 0 and only scheduled items from
// data already in hand are used — no provider fan-out.
function assembleEvents({ src, universe, earnings, context, now, limit }) {
  const out = [];
  const today = new Date(now).toISOString();

  // Scheduled: earnings dates already fetched.
  for (const [ticker, e] of Object.entries(earnings || {})) {
    if (!e || !e.earningsDate) continue;
    out.push(EVT.makeEvent({
      ticker, kind: 'earnings', scope: 'company',
      title: `${ticker} earnings report`, scheduledFor: e.earningsDate,
      publisher: 'Finnhub earnings calendar', retrievedAt: today,
      metrics: { inDays: e.earningsInDays ?? null },
    }));
  }
  // Scheduled: monthly options expiry (third Friday) — a deterministic calendar fact.
  const opex = thirdFridayOnOrAfter(new Date(now));
  if (opex) {
    out.push(EVT.makeEvent({
      kind: 'options-expiry', scope: 'market', title: 'Monthly options expiration',
      scheduledFor: opex, publisher: 'exchange calendar (computed)', retrievedAt: today,
    }));
  }
  // Past: material price responses already measured (facts, not stories).
  for (const [ticker, c] of Object.entries(context || {})) {
    if (c.pctChange1d == null || Math.abs(c.pctChange1d) < 5) continue;
    out.push(EVT.makeEvent({
      ticker, kind: 'price-response', scope: 'company',
      title: `${ticker} moved ${c.pctChange1d > 0 ? '+' : ''}${c.pctChange1d}% on the last completed session`,
      publishedAt: c.asOf ? `${c.asOf}T21:00:00Z` : null, publisher: 'daily candles', retrievedAt: today,
      metrics: { pctChange: c.pctChange1d, rsVsQqq: c.rsVsQqq21, rsVsSubsector: c.rsVsSubsector21 },
    }));
  }
  // Emerging: news, bounded, with full provenance. Skipped entirely in lite mode.
  const news = (src.today && src.today.news) || [];
  for (const n of news.slice(0, limit)) {
    if (!n || !n.title) continue;
    const tickers = (n.tickers || [n.ticker]).filter(Boolean).map(x => String(x).toUpperCase());
    const t = tickers.find(x => universe.byTicker[x]) || null;
    out.push(EVT.makeEvent({
      ticker: t, kind: 'news', scope: t ? 'company' : 'sector',
      title: n.title, summary: n.summary || n.description || null,
      url: n.url || null, publisher: n.publisher || n.source || null,
      publishedAt: n.publishedAt || n.datetime || null, retrievedAt: today,
    }));
  }
  return out;
}

function thirdFridayOnOrAfter(now) {
  for (let m = 0; m < 3; m++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + m, 1));
    let count = 0;
    while (d.getUTCMonth() === (now.getUTCMonth() + m) % 12) {
      if (d.getUTCDay() === 5) { count++; if (count === 3) break; }
      d.setUTCDate(d.getUTCDate() + 1);
    }
    if (count === 3 && d.getTime() >= now.getTime() - 86400000) return d.toISOString().slice(0, 10);
  }
  return null;
}

function publicUniverse(u) {
  return {
    schema: u.schema, taxonomyVersion: u.taxonomyVersion, overlayVersion: u.overlayVersion,
    basis: u.basis, degraded: u.degraded, metadataThin: u.metadataThin,
    universeAsOf: u.universeAsOf, builtAt: u.builtAt,
    coverage: u.coverage, exclusions: u.exclusions, warnings: u.warnings,
    pointInTime: u.pointInTime, pointInTimeNote: u.pointInTimeNote,
    bySubsector: u.bySubsector,
    byTicker: u.byTicker,
    count: u.securities.length,
  };
}

function buildDataHealth({ universe, regime, daytrade, swing, longterm, options, sentiment, sourceHealth, unavailable, nowIso }) {
  const state = (ok, asOf, maxAgeMin) => {
    if (!ok) return 'unavailable';
    if (!asOf) return 'partial';
    const ageMin = (Date.parse(nowIso) - Date.parse(asOf)) / 60000;
    if (!Number.isFinite(ageMin)) return 'partial';
    return ageMin <= maxAgeMin ? 'fresh' : ageMin <= maxAgeMin * 8 ? 'delayed' : 'stale';
  };
  return {
    generatedAt: nowIso,
    sources: {
      universe: { state: universe.degraded ? 'partial' : 'fresh', asOf: universe.universeAsOf, note: universe.degraded ? 'curated fallback in use' : `${universe.securities.length} classified technology securities` },
      daytrade: { state: state(sourceHealth.daytrade && sourceHealth.daytrade.ok, daytrade.sourceGeneratedAt, 10), asOf: daytrade.sourceGeneratedAt, note: 'read-only projection of the frozen Day Trade board' },
      swing: { state: state(sourceHealth.today && sourceHealth.today.ok, swing.generatedAt, 24 * 60), asOf: swing.generatedAt, note: 'governed swing cross-section (op=today)' },
      longterm: { state: longterm.rows.length ? 'fresh' : 'unavailable', asOf: longterm.generatedAt, note: longterm.rows.length ? `${longterm.rows.length} names evaluated` : 'requires the scheduled tick' },
      regime: { state: regime.coverage.breadthSufficient ? 'fresh' : 'partial', asOf: regime.generatedAt, note: `${regime.coverage.dimensionsKnown}/${regime.coverage.dimensionsTotal} dimensions measured` },
      options: { state: options.stale ? 'stale' : state(sourceHealth.optionsflow && sourceHealth.optionsflow.ok, options.asOf, 60), asOf: options.asOf, note: `delayed by ~${options.delayedByMin} min` },
      social: { state: sentiment.trustworthy ? state(true, sentiment.asOf, 24 * 60) : 'partial', asOf: sentiment.asOf, note: sentiment.trustNote || `${sentiment.windowDays}-day archive window` },
    },
    sourceHealth,
    unavailable,
    partialCoverage: [
      ...(universe.degraded ? ['technology universe (curated fallback)'] : []),
      ...(regime.coverage.breadthSufficient ? [] : ['technology breadth']),
      ...(sentiment.trustworthy ? [] : ['social attention archive']),
    ],
  };
}

const DISCLOSURES = Object.freeze({
  evidenceLadder: [
    { level: 'heuristic', meaning: 'a documented rule with no track record', applies: ['long-term board', 'technology regime classification'] },
    { level: 'research', meaning: 'measured, but never allowed to affect an action', applies: ['read-through inferred edges', 'technology-relative annotations'] },
    { level: 'shadow', meaning: 'runs alongside production at weight zero', applies: ['options positioning', 'social attention'] },
    { level: 'evidence-supported', meaning: 'passed the app\'s central eligibility gate upstream', applies: ['swing candidates marked ACTIONABLE'] },
    { level: 'calibrated', meaning: 'has a valid out-of-sample calibration artifact', applies: [] },
    { level: 'validated-executable', meaning: 'a frozen production engine with its own governance', applies: ['Day Trade board (consumed read-only)'] },
  ],
  noAlphaClaim: 'Nothing on this page is a claim of new predictive edge. No horizon model here has passed a prospective validation protocol; the swing board inherits its governance from the app\'s existing gate, and the day-trade board is a read-only view of an engine this page does not modify.',
  probabilityPolicy: 'A number is labeled a probability only with a precisely-defined outcome, an explicit horizon, and a current out-of-sample calibration artifact for that exact model version. No such artifact exists here, so no probabilities are shown.',
});

function degradedSnapshot({ nowIso, session, reason, mode }) {
  return {
    schema: SNAPSHOT_VERSION, mode, generatedAt: nowIso,
    marketSession: session.marketSession, sessionDate: session.etDate, isTradingDay: session.isTradingDay,
    degraded: true, reason,
    universe: null, regime: null,
    daytrade: { rows: [], empty: true, emptyReason: reason },
    swing: { rows: [], featured: [], empty: true, emptyReason: reason },
    longterm: { rows: [], featured: [], empty: true, emptyReason: reason },
    events: { past: [], present: [], upcoming: [], byBucket: {}, empty: true, emptyReason: reason },
    scenarios: {}, readthrough: null, options: null, sentiment: null,
    alignment: { rows: [] }, risk: null,
    dataHealth: { generatedAt: nowIso, sources: {}, unavailable: [{ what: 'everything', why: reason }], partialCoverage: ['all'] },
    disclosures: DISCLOSURES,
    warnings: [reason],
    _internal: null,
  };
}

/** Strip internal handles before the payload leaves the process. */
function toPublicPayload(snapshot) {
  if (!snapshot) return null;
  const { _internal, ...rest } = snapshot;
  return rest;
}

module.exports = {
  SNAPSHOT_VERSION, LIMITS, BOARD_LIMIT, DISCLOSURES,
  buildSnapshot, toPublicPayload, gatherCandles, contextFor, subsectorRanksOf,
  assembleEvents, thirdFridayOnOrAfter, betaOf, pull, mapLimit, buildDataHealth,
};

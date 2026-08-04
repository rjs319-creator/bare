'use strict';
// MOMENTUM IGNITION — HTTP ops (folded into api/tracker.js, no new Serverless Function).
//
// One unified, ACCELERATION-ranked view over the app's existing momentum scanners. It does
// NOT re-scan the universe: Stage 1 reuses the already-merged, already-cached op=today
// signals (Day Trade, Gap & Go, Momentum Run, Ghost, Breakout, …) as the candidate set;
// Stage 2 runs the deep acceleration + catalyst scoring (lib/ignition.js) only on that
// shortlist. Honest by construction: EOD/daily data, no real-time, no LULD — the payload
// says so and the "distance to halt" fields are explicitly N/A.
//
//   op=ignition       the ranked Momentum Ignition table
//   op=ignitionlog    persist today's ignition picks to the Scoreboard ledger (warm cron)

const { internalHeaders } = require('./auth');
const { nowET } = require('./stats');
const S = require('./store');
const IG = require('./ignition');

const HOST = process.env.WARM_HOST || 'market-news-app-chi.vercel.app';
const SHORTLIST_MAX = 60;         // Stage-2 deep-analysis cap (bounds candle fetches)
// Candle-pool width. The shortlist is capped at SHORTLIST_MAX (60), so at 6 this ran
// 10 sequential rounds against Yahoo and dominated the whole request (~6-7s at origin).
// 24 matches lib/apex-routes HIST_FETCH_CONCURRENCY, the pool width PR #206 already
// proved safe against the same fetchDailyHistory endpoint in the same runtime.
const FETCH_CONCURRENCY = 24;

// Momentum-relevant strategy families (Stage-1 filter — skip pure context/sentiment names).
const MOMENTUM_FAMILIES = new Set(['trend', 'earlyMomentum', 'event', 'intraday']);

// `public: true` sends NO Authorization header. That matters for cost, not access:
// internalHeaders() attaches `Authorization: Bearer <CRON_SECRET>`, and a CDN will not
// serve a cached response to an authenticated request. Pulling the PUBLIC op=today with
// that header therefore missed the edge every single time and recomputed it at origin —
// ~5.5s of op=ignition's ~6.5s, measured with op=today sitting warm on the edge at 0.17s
// in the same instant. We want exactly the cached view a user sees, so ask for it as a
// user would. Fails soft: runIgnition already degrades when the pull fails.
async function pull(path, { timeout = 12000, isPublic = false } = {}) {
  try {
    const headers = isPublic ? { 'x-warm': '1' } : internalHeaders();
    const r = await fetch('https://' + HOST + path, { headers, signal: AbortSignal.timeout(timeout) });
    if (!r.ok) return { ok: false, status: r.status, data: null };
    return { ok: true, data: await r.json() };
  } catch (e) { return { ok: false, error: String((e && e.message) || e), data: null }; }
}

// Bounded-concurrency map.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch { out[k] = null; } } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Extract a catalyst {catalyst, ageDays, confidence} from an op=today signal.
function catalystFromSignal(sig) {
  let label = sig.catalyst || (sig.event && sig.event.type) || null;
  let ageDays = null;
  if (sig.event) {
    if (sig.event.kind === 'passed' && Number.isFinite(sig.event.inDays)) ageDays = Math.abs(sig.event.inDays);
  }
  if (label && /gap|breakout/i.test(String(label))) ageDays = 0;      // happened today
  return { catalyst: label, ageDays, confidence: null };
}

// Collect the momentum candidate signals from an op=today payload, deduped by ticker
// (keep the highest-ranked instance), capped to the Stage-2 budget.
function shortlistFromToday(today) {
  const horizons = (today && today.horizons) || {};
  const all = [];
  for (const arr of Object.values(horizons)) for (const s of arr || []) {
    // Momentum families only. Fall back to horizon ONLY when a signal has no family tag,
    // so a pure context/sentiment name on a swing horizon isn't swept in.
    const keep = s.strategyFamily ? MOMENTUM_FAMILIES.has(s.strategyFamily) : ['intraday', 'swing'].includes(s.horizon);
    if (keep) all.push(s);
  }
  const byTicker = new Map();
  for (const s of all) {
    const cur = byTicker.get(s.ticker);
    if (!cur || (s.score || 0) > (cur.score || 0)) byTicker.set(s.ticker, s);
  }
  return [...byTicker.values()].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, SHORTLIST_MAX);
}

// ── PURE assembly (unit-testable) ────────────────────────────────────────────────────
// signals: shortlist; candlesByTicker: {T: candles[]}; regime: op=today regime.
function buildIgnition(signals, candlesByTicker, regime = {}) {
  const cards = [];
  for (const sig of signals) {
    const candles = candlesByTicker[sig.ticker];
    const f = IG.accelerationMetrics(candles);
    if (!f) continue;                                       // not enough history → skip (honest)
    const cat = IG.catalystQuality(catalystFromSignal(sig));
    const scoreObj = IG.ignitionScore(f, { catalyst: cat, regime });
    const stage = IG.ignitionStage(f, scoreObj);
    const tier = IG.ignitionTier(scoreObj);
    cards.push({
      ticker: sig.ticker, company: sig.company || null, sector: sig.sector || null,
      score: scoreObj.score, stage, stageMeta: IG.STAGE_META[stage], tier,
      changePct: f.changePct, price: f.price,
      priceAccel: f.priceAccel, volAccel: f.volAccel, dvAccel: f.dvAccel,
      relVol5: f.relVol5, relVol20: f.relVol20, dollarVol: f.dollarVol,
      vwapStatus: f.aboveVwap ? (f.vwapRising ? 'Above & rising' : 'Above') : 'Below',
      spreadProxy: f.adrPct, extAbove20: f.extAbove20, move10: f.move10,
      structure: f.structure, pullbackQuality: f.pullbackQuality, trendPersistence: f.trendPersistence,
      catalyst: cat.label, catalystFresh: cat.fresh, catalystQuality: cat.quality,
      catalystAgeDays: catalystFromSignal(sig).ageDays,
      float: null, distanceToLuld: null,                   // honest N/A on EOD data
      components: scoreObj.components, penalties: scoreObj.penalties,
      sources: sig.sources || [sig.source], reasons: reasonsFor(f, cat, scoreObj), risks: risksFor(f, scoreObj),
    });
  }
  cards.sort((a, b) => b.score - a.score || b.priceAccel - a.priceAccel);
  const byStage = {};
  for (const st of IG.STAGES) byStage[st] = cards.filter(c => c.stage === st);
  return {
    version: IG.IGNITION_VERSION,
    regime: { label: regime.bearish ? 'risk-off' : regime.riskOn ? 'risk-on' : 'neutral', riskOn: regime.riskOn === true, bearish: regime.bearish === true },
    cards, byStage,
    counts: { total: cards.length, ignition: cards.filter(c => c.tier === 'IGNITION').length, watch: cards.filter(c => c.tier === 'WATCH').length },
    stageMeta: IG.STAGE_META,
    dataNote: 'EOD/daily data + once-daily 5-min capture. No real-time quotes or LULD — “distance to halt”, sub-minute forward returns, and live Near-Halt/Post-Halt stages are not available on this feed.',
  };
}

function reasonsFor(f, cat, scoreObj) {
  const r = [];
  if (f.priceAccel > 0.5) r.push(`Price accelerating (+${f.priceAccel}%/day 2nd-deriv)`);
  if (f.volAccel > 30) r.push(`Volume expanding +${f.volAccel}% vs baseline`);
  if (cat.label) r.push(`Catalyst: ${cat.label}${cat.fresh ? ' (fresh)' : ''}`);
  if (f.aboveVwap && f.vwapRising) r.push('Above a rising volume-weighted trend');
  if (f.extAbove20 < 15 && f.changePct > 0) r.push('Early — not yet extended');
  return r.slice(0, 4);
}
function risksFor(f, scoreObj) {
  const r = [...(scoreObj.penalties || [])];
  if (f.extAbove20 > 15 && !r.includes('extended') && !r.includes('exhausted / extended')) r.push(`${f.extAbove20}% above 20-day avg`);
  return r.slice(0, 4);
}

// ── BROAD SHADOW STAGE-1 (non-daytrade redesign 2026-08) ─────────────────────────────
// The production funnel above re-ranks ONLY the already-ranked op=today shortlist — a
// name the Today merge never surfaced can never ignite here, so discovery inherits every
// upstream filter. This lane scans the large/small/micro candle caches INDEPENDENTLY
// with the same frozen scoring engine and surfaces what the funnel missed, as SHADOW:
// broad cards are visually separated, carry no catalyst enrichment (price/volume only,
// deterministic), and are ledgered under their own BROAD_* tiers so their prospective
// record accrues apart from the funnel's. They cannot originate or boost anything until
// that record clears promotion (registry criteria on `ignition`).
const BROAD_SCOPES = ['large', 'small', 'micro', 'expanded'];
const BROAD_MAX = 40;             // bounded: top-N by score across all scopes
const BROAD_MIN_BARS = 60;
const BROAD_MIN_PRICE = 1;              // explicit eligibility floor — sub-$1 names are not scannable candidates
const BROAD_MIN_DOLLAR_VOL = 1_000_000; // explicit liquidity floor (avg $ volume)
const BROAD_MAX_STALE_DAYS = 5;         // a cache row whose newest bar is older than this is NOT today's discovery

async function broadShadowCards(excludeTickers, regime) {
  const { loadCandleCache, cacheGet } = require('./candle-cache');
  const scored = [];
  const scopesMissing = [];
  const cacheStates = {};
  // Honest eligibility funnel: every dropped name lands in exactly one reason bucket,
  // so "0 cards" from empty caches and "0 cards" from a quiet tape are distinguishable.
  const excludedByReason = {
    funnelOverlap: 0,        // recorded + deduplicated against the funnel lane (never pooled with it)
    duplicateScope: 0,       // same ticker in more than one cache — scored once
    insufficientHistory: 0, staleBars: 0, subMinPrice: 0, subMinDollarVol: 0, featuresUnavailable: 0,
  };
  let attempted = 0;
  const seen = new Set();
  const staleCut = new Date(Date.now() - BROAD_MAX_STALE_DAYS * 86400000).toISOString().slice(0, 10);
  for (const scope of BROAD_SCOPES) {
    const doc = await loadCandleCache(scope).catch(() => null);
    if (!doc || !doc.data) { scopesMissing.push(scope); cacheStates[scope] = { present: false }; continue; }
    cacheStates[scope] = { present: true, names: Object.keys(doc.data).length, fetchedAt: doc.fetchedAt || doc.generatedAt || null };
    for (const t of Object.keys(doc.data)) {
      attempted++;
      if (excludeTickers.has(t)) { excludedByReason.funnelOverlap++; continue; }
      if (seen.has(t)) { excludedByReason.duplicateScope++; continue; }
      const entry = cacheGet(doc, t);
      if (!entry || !Array.isArray(entry.candles) || entry.candles.length < BROAD_MIN_BARS) { excludedByReason.insufficientHistory++; continue; }
      const lastDate = entry.candles[entry.candles.length - 1] && entry.candles[entry.candles.length - 1].date;
      if (!lastDate || lastDate < staleCut) { excludedByReason.staleBars++; continue; }
      const f = IG.accelerationMetrics(entry.candles);
      if (!f) { excludedByReason.featuresUnavailable++; continue; }
      if (!(f.price >= BROAD_MIN_PRICE)) { excludedByReason.subMinPrice++; continue; }
      if (!(f.dollarVol >= BROAD_MIN_DOLLAR_VOL)) { excludedByReason.subMinDollarVol++; continue; }
      seen.add(t);
      const cat = IG.catalystQuality({ catalyst: null, ageDays: null, confidence: null });
      const scoreObj = IG.ignitionScore(f, { catalyst: cat, regime });
      const stage = IG.ignitionStage(f, scoreObj);
      const tier = IG.ignitionTier(scoreObj);
      scored.push({
        ticker: t, company: entry.meta?.shortName || null, scope,
        score: scoreObj.score, stage, tier,
        changePct: f.changePct, price: f.price, priceAccel: f.priceAccel,
        volAccel: f.volAccel, relVol5: f.relVol5, dollarVol: f.dollarVol,
        components: scoreObj.components, penalties: scoreObj.penalties,
        discovery: 'broad-cache-shadow',
      });
    }
  }
  scored.sort((a, b) => b.score - a.score || b.priceAccel - a.priceAccel);
  return {
    cards: scored.slice(0, BROAD_MAX),
    // `scanned` historically meant "successfully scored" — kept as an alias, but the
    // honest funnel is attempted → eligible (passed every gate; all eligible names are
    // scored, so the two counts coincide by construction) with per-reason exclusions.
    attempted, eligible: scored.length, scored: scored.length, scanned: scored.length,
    excludedByReason, scopesMissing, cacheStates,
    note: 'SHADOW independent Stage-1 over the large/small/micro/expanded candle caches (price/volume only, no catalyst enrichment — the funnel lane and this lane are separate evidence versions; overlap with the funnel is recorded in excludedByReason.funnelOverlap and deduplicated, never pooled). Weight-0: ledgered under BROAD_* tiers for a prospective record; cannot originate or boost anything until that record clears promotion.',
  };
}

// ── Fetch candles for the shortlist (Stage 2) ────────────────────────────────────────
async function fetchCandles(tickers) {
  const { fetchDailyHistory } = require('./screener');
  const map = {};
  await mapLimit(tickers, FETCH_CONCURRENCY, async (t) => {
    const d = await fetchDailyHistory(t, '6mo').catch(() => null);
    if (d && d.candles) map[t] = d.candles;
  });
  return map;
}

// ── op=ignition ──────────────────────────────────────────────────────────────────────
async function runIgnition(req, res) {
  const today = await pull('/api/tracker?op=today', { isPublic: true });
  if (!today.ok || !today.data) {
    // The funnel lane needs op=today; the broad lane is INDEPENDENT by design and
    // must keep discovering when the funnel is dark (empty exclusion set — there is
    // no funnel to overlap with; regime enrichment degrades to none, disclosed).
    const degraded = { ok: true, degraded: true, note: 'op=today unavailable — funnel lane skipped; broad shadow lane ran independently (no regime enrichment)', cards: [], byStage: {}, counts: {} };
    try { degraded.broadShadow = await broadShadowCards(new Set(), {}); } catch { degraded.broadShadow = null; }
    degraded.configured = S.hasStore();
    res.setHeader('Cache-Control', 's-maxage=60');
    return res.json(degraded);
  }
  const shortlist = shortlistFromToday(today.data);
  const candles = await fetchCandles(shortlist.map(s => s.ticker));
  const payload = buildIgnition(shortlist, candles, today.data.regime || {});
  // Broad shadow lane — never merged into `cards`; failure degrades to null, honestly.
  // Exclusion set = the DISPLAYED funnel cards, matching the ledger path exactly so the
  // displayed broad set and the ledgered broad set describe the same population.
  try {
    payload.broadShadow = await broadShadowCards(new Set(payload.cards.map(c => c.ticker)), today.data.regime || {});
  } catch (e) { payload.broadShadow = null; }
  payload.freshness = { today: today.ok, generatedAt: new Date().toISOString() };
  payload.configured = S.hasStore();
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=86400');
  return res.json({ ok: true, ...payload });
}

// ── op=ignitionlog (persist to Scoreboard ledger) ────────────────────────────────────
async function runIgnitionLog(req, res) {
  const { date, isMarketClosed } = nowET();
  const today = await pull('/api/tracker?op=today');
  const todayOk = !!(today.ok && today.data);
  // The funnel lane needs op=today; the broad lane logs INDEPENDENTLY — a dark funnel
  // must not blind broad discovery's prospective record.
  let payload = { cards: [] };
  let picks = [];
  if (todayOk) {
    const shortlist = shortlistFromToday(today.data);
    const candles = await fetchCandles(shortlist.map(s => s.ticker));
    payload = buildIgnition(shortlist, candles, today.data.regime || {});
    // Log the actionable tiers (IGNITION/WATCH) with entry = current price, for EOD forward
    // tracking (1w/1m/3m + MFE) via the same Scoreboard machinery the other ledgers use.
    picks = payload.cards.filter(c => c.tier === 'IGNITION' || c.tier === 'WATCH').map(c => ({
      ticker: c.ticker, section: 'Ignition', tier: c.tier, date, entry: c.price,
      score: c.score, stage: c.stage, catalyst: c.catalyst || null,
    }));
  }
  // Broad shadow lane: same section, OWN tiers (BROAD_IGNITION / BROAD_WATCH) so the
  // Scoreboard grades this discovery lane as a SEPARATE record — evidence from the
  // funnel lane never pools with it (different candidate universe = different version).
  // Exclusion set = the displayed funnel cards (same set the display path uses).
  let broadPicks = [];
  try {
    const broad = await broadShadowCards(new Set(payload.cards.map(c => c.ticker)), todayOk ? (today.data.regime || {}) : {});
    broadPicks = (broad ? broad.cards : []).filter(c => c.tier === 'IGNITION' || c.tier === 'WATCH').map(c => ({
      ticker: c.ticker, section: 'Ignition', tier: `BROAD_${c.tier}`, date, entry: c.price,
      score: c.score, stage: c.stage, catalyst: null, discovery: 'broad-cache-shadow',
    }));
  } catch { broadPicks = []; }
  let logged = 0;
  const all = [...picks, ...broadPicks];
  if (S.hasStore() && !isMarketClosed && all.length) {
    try { await S.writeIgnitionDay(date, all); logged = all.length; }
    catch (e) { payload.logError = String((e && e.message) || e); }
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, date, logged, funnel: todayOk ? 'ok' : 'unavailable (op=today) — broad lane ran independently', funnelPicks: picks.length, broadShadowPicks: broadPicks.length, candidates: payload.cards.length, closed: isMarketClosed });
}

// ── op=ignitionbackfill (seed the Scoreboard from history) ───────────────────────────
// Heavy + writes → cron/manual-with-bearer only. Writes point-in-time ignition picks into
// the per-day ledger so the Scoreboard resolves their forward returns automatically.
async function runIgnitionBackfillOp(req, res) {
  if (!S.hasStore()) return res.json({ ok: false, note: 'Blob storage not configured' });
  const { runIgnitionBackfill } = require('./ignition-backfill');
  const scope = req.query.scope || 'large';
  const limit = req.query.limit != null ? +req.query.limit : 90;
  const months = req.query.months != null ? +req.query.months : 18;
  const { byDate, stats } = await runIgnitionBackfill({ scope, limit, months });
  let written = 0;
  for (const [date, picks] of Object.entries(byDate)) {
    try {
      // MERGE with any existing picks for this day (e.g. a prior large-cap run) so
      // running multiple scopes accumulates instead of overwriting. Dedup by ticker+tier.
      const existing = (await S.readJSON(`ignition/${date}.json`, null));
      const prior = (existing && Array.isArray(existing.picks)) ? existing.picks : [];
      const seen = new Set(prior.map(p => `${p.ticker}:${p.tier}`));
      const merged = [...prior, ...picks.filter(p => !seen.has(`${p.ticker}:${p.tier}`))];
      await S.writeIgnitionDay(date, merged); written++;
    } catch { /* skip a failed day */ }
  }
  stats.ledgerDaysWritten = written;
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, stats });
}

module.exports = { runIgnition, runIgnitionLog, runIgnitionBackfillOp, buildIgnition, shortlistFromToday, catalystFromSignal, broadShadowCards, SHORTLIST_MAX, FETCH_CONCURRENCY, BROAD_MAX };

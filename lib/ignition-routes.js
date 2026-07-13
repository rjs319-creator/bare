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
const FETCH_CONCURRENCY = 6;

// Momentum-relevant strategy families (Stage-1 filter — skip pure context/sentiment names).
const MOMENTUM_FAMILIES = new Set(['trend', 'earlyMomentum', 'event', 'intraday']);

async function pull(path, timeout = 12000) {
  try {
    const r = await fetch('https://' + HOST + path, { headers: internalHeaders(), signal: AbortSignal.timeout(timeout) });
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
  const today = await pull('/api/tracker?op=today');
  if (!today.ok || !today.data) {
    res.setHeader('Cache-Control', 's-maxage=60');
    return res.json({ ok: true, degraded: true, note: 'op=today unavailable', cards: [], byStage: {}, counts: {} });
  }
  const shortlist = shortlistFromToday(today.data);
  const candles = await fetchCandles(shortlist.map(s => s.ticker));
  const payload = buildIgnition(shortlist, candles, today.data.regime || {});
  payload.freshness = { today: today.ok, generatedAt: new Date().toISOString() };
  payload.configured = S.hasStore();
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=86400');
  return res.json({ ok: true, ...payload });
}

// ── op=ignitionlog (persist to Scoreboard ledger) ────────────────────────────────────
async function runIgnitionLog(req, res) {
  const { date, isMarketClosed } = nowET();
  const today = await pull('/api/tracker?op=today');
  if (!today.ok || !today.data) return res.json({ ok: false, note: 'op=today unavailable' });
  const shortlist = shortlistFromToday(today.data);
  const candles = await fetchCandles(shortlist.map(s => s.ticker));
  const payload = buildIgnition(shortlist, candles, today.data.regime || {});
  // Log the actionable tiers (IGNITION/WATCH) with entry = current price, for EOD forward
  // tracking (1w/1m/3m + MFE) via the same Scoreboard machinery the other ledgers use.
  const picks = payload.cards.filter(c => c.tier === 'IGNITION' || c.tier === 'WATCH').map(c => ({
    ticker: c.ticker, section: 'Ignition', tier: c.tier, date, entry: c.price,
    score: c.score, stage: c.stage, catalyst: c.catalyst || null,
  }));
  let logged = 0;
  if (S.hasStore() && !isMarketClosed && picks.length) {
    try { await S.writeIgnitionDay(date, picks); logged = picks.length; }
    catch (e) { payload.logError = String((e && e.message) || e); }
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, date, logged, candidates: payload.cards.length, closed: isMarketClosed });
}

module.exports = { runIgnition, runIgnitionLog, buildIgnition, shortlistFromToday, catalystFromSignal };

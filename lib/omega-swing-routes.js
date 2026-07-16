'use strict';
// OMEGA-SWING — HTTP ops (folded into api/tracker.js, no new Serverless Function; Hobby caps
// a deployment at 12 functions). Like EVOLVE / Momentum Ignition, OMEGA-SWING does NOT re-scan
// the universe: Stage 1 reuses the already-merged, already-cached op=today signals (Day Trade,
// Gap & Go, Breakout, Coil, Momentum Run, …) as its candidate set; Stage 2 runs the deep
// 5–10 day continuation scoring (lib/omega-swing.js) only on that shortlist, with SPY + the
// relevant sector ETFs fetched once for the sector-/market-relative label.
//
//   op=omega          the ranked OMEGA-SWING table (Prime / Qualified / Watch)
//   op=omegalog       persist today's Prime/Qualified/Watch picks to the Scoreboard ledger (cron)
//   op=omegawf        purged walk-forward: residual 5d/10d expectancy, rank-IC, calibration
//   op=omegabackfill  seed the Scoreboard ledger from point-in-time history (cron/manual)
//   op=omegamodel     active scoring config / version (for the client)

const { internalHeaders } = require('./auth');
const { nowET } = require('./stats');
const S = require('./store');
const O = require('./omega-swing');

const HOST = process.env.WARM_HOST || 'market-news-app-chi.vercel.app';
const SHORTLIST_MAX = 60;
const FETCH_CONCURRENCY = 6;
const TODAY_TIMEOUT = 30000;      // op=today is ~12s cold; the tracker fn has a 60s budget

// GICS sector name (as screeners emit) → sector SPDR ETF (mirrors evolve-routes).
const SECTOR_ETF = {
  'technology': 'XLK', 'information technology': 'XLK',
  'financials': 'XLF', 'financial services': 'XLF', 'financial': 'XLF',
  'health care': 'XLV', 'healthcare': 'XLV', 'energy': 'XLE', 'industrials': 'XLI',
  'consumer discretionary': 'XLY', 'cons discret': 'XLY', 'consumer cyclical': 'XLY',
  'consumer staples': 'XLP', 'cons staples': 'XLP', 'consumer defensive': 'XLP',
  'materials': 'XLB', 'basic materials': 'XLB', 'real estate': 'XLRE', 'utilities': 'XLU',
  'communication services': 'XLC', 'comm services': 'XLC', 'communication': 'XLC',
};
const etfForSector = (name) => name ? SECTOR_ETF[String(name).trim().toLowerCase()] || null : null;

// Momentum-relevant families — OMEGA-SWING is a continuation engine, so skip pure
// context/sentiment names (fall back to horizon only when a signal has no family tag).
const MOMENTUM_FAMILIES = new Set(['trend', 'earlyMomentum', 'event', 'intraday']);

async function pull(path, timeout = 12000) {
  try {
    const r = await fetch('https://' + HOST + path, { headers: internalHeaders(), signal: AbortSignal.timeout(timeout) });
    if (!r.ok) return { ok: false, status: r.status, data: null };
    return { ok: true, data: await r.json() };
  } catch (e) { return { ok: false, error: String((e && e.message) || e), data: null }; }
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch { out[k] = null; } } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Catalyst {catalyst, quality, binary?} from an op=today signal (event/catalyst tags).
function catalystFromSignal(sig) {
  const label = sig.catalyst || (sig.event && sig.event.type) || null;
  const binaryEventInWindow = !!(sig.event && sig.event.kind === 'binary');
  // A fresh, named event scores higher than momentum-without-a-reason.
  let quality = label ? 0.55 : 0.25;
  if (label && /beat|approval|contract|merger|acquisition|guidance|upgrade/i.test(String(label))) quality = 0.75;
  return { catalyst: label, catalystQuality: quality, binaryEventInWindow };
}

// Collect swing-continuation candidates from op=today, dedup by ticker (best-ranked), capped.
function shortlistFromToday(today) {
  const horizons = (today && today.horizons) || {};
  const all = [];
  for (const [h, arr] of Object.entries(horizons)) for (const s of arr || []) {
    const keep = s.strategyFamily ? MOMENTUM_FAMILIES.has(s.strategyFamily) : ['intraday', 'swing', 'position'].includes(h);
    if (keep) all.push(s);
  }
  const byTicker = new Map();
  for (const s of all) { const cur = byTicker.get(s.ticker); if (!cur || (s.score || 0) > (cur.score || 0)) byTicker.set(s.ticker, s); }
  return [...byTicker.values()].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, SHORTLIST_MAX);
}

// Fetch ~1y daily candles for every ticker + the benchmarks (SPY + the sectors present).
async function fetchCandleSet(tickers, sectors) {
  const { fetchDailyHistory } = require('./screener');
  const map = {};
  await mapLimit(tickers, FETCH_CONCURRENCY, async (t) => {
    const d = await fetchDailyHistory(t, '1y').catch(() => null); if (d && d.candles) map[t] = d.candles;
  });
  const etfs = [...new Set(['SPY', ...sectors.map(etfForSector).filter(Boolean)])];
  const bench = {};
  await mapLimit(etfs, FETCH_CONCURRENCY, async (e) => { const d = await fetchDailyHistory(e, '1y').catch(() => null); if (d && d.candles) bench[e] = d.candles; });
  return { map, bench };
}

// ── PURE assembly (unit-testable): shortlist + candles → ranked OMEGA-SWING payload ──────
function buildOmega(signals, candlesByTicker, benchCandles, regime = {}, opts = {}) {
  const spy = benchCandles.SPY || null;
  const cards = [];
  for (const sig of signals) {
    const candles = candlesByTicker[sig.ticker];
    if (!candles) continue;
    const etf = etfForSector(sig.sector);
    const bench = { spy, sector: etf ? benchCandles[etf] : null };
    const cat = catalystFromSignal(sig);
    const card = O.evaluateCandidate({
      ticker: sig.ticker, candles, bench,
      ctx: { ...cat, regime, dilutionRisk: false, maxRiskPct: opts.maxRiskPct || 0.01 },
    });
    if (!card) continue;                          // not enough history → skip (honest)
    card.company = sig.company || null; card.sector = sig.sector || null;
    card.sectorEtf = etf || null;
    card.sources = sig.sources || (sig.source ? [sig.source] : []);
    card.catalyst = cat.catalyst; card.reasons = reasonsFor(card); card.risks = card.penalties.slice(0, 4);
    cards.push(card);
  }
  // Rank by expected utility (§11), then score, then relative strength.
  cards.sort((a, b) => (b.utility - a.utility) || (b.score - a.score) || ((b.features.rsSpy10 || 0) - (a.features.rsSpy10 || 0)));
  const byTier = {};
  for (const t of O.TIERS) byTier[t] = cards.filter(c => c.tier === t);
  return {
    version: O.OMEGA_VERSION,
    regime: { label: regime.bearish ? 'risk-off' : regime.riskOn ? 'risk-on' : 'neutral', riskOn: regime.riskOn === true, bearish: regime.bearish === true },
    cards, byTier,
    counts: { total: cards.length, prime: byTier.OMEGA_PRIME.length, qualified: byTier.OMEGA_QUALIFIED.length, watch: byTier.OMEGA_WATCH.length, avoid: byTier.AVOID.length },
    tierMeta: O.TIER_META, stageMeta: O.STAGE_META, setupLegend: O.SETUP_META, scoreWeights: O.SCORE_WEIGHTS,
    dataNote: 'EOD/daily candles (free/Starter feeds). Probabilities are a transparent baseline until the point-in-time ledger + purged walk-forward (op=omegawf) confirm them. No real-time quotes/spread — entry levels are next-session positioning, not intraday fills.',
  };
}

function reasonsFor(card) {
  const f = card.features, r = [];
  if ((f.rsSpy10 || 0) > 0.02) r.push(`Leading SPY (+${(f.rsSpy10 * 100).toFixed(1)}% over 10d, RS ${(f.rsSpy5 || 0) > 0 ? 'accelerating' : 'holding'})`);
  if (f.efficiency > 0.5 && f.fit20 > 0.6) r.push(`Smooth, efficient trend (${f.efficiency} directional efficiency)`);
  if ((f.upDownVol || 1) > 1.3) r.push(`Accumulation — up/down volume ${f.upDownVol}×`);
  if (card.setup) r.push(`Setup: ${card.setup} — ${O.SETUP_META[card.setup]}`);
  if (f.extAbove20 != null && f.extAbove20 < 10) r.push('Not yet extended — early/middle stage');
  return r.slice(0, 5);
}

// ── op=omega (live) ──────────────────────────────────────────────────────────────────────
async function runOmega(req, res) {
  const today = await pull('/api/tracker?op=today', TODAY_TIMEOUT);
  if (!today.ok || !today.data) {
    res.setHeader('Cache-Control', 's-maxage=60');
    return res.json({ ok: true, degraded: true, note: 'op=today unavailable', cards: [], byTier: {}, counts: {} });
  }
  const shortlist = shortlistFromToday(today.data);
  const { map, bench } = await fetchCandleSet(shortlist.map(s => s.ticker), shortlist.map(s => s.sector));
  const payload = buildOmega(shortlist, map, bench, today.data.regime || {});
  payload.freshness = { today: today.ok, generatedAt: new Date().toISOString() };
  payload.configured = S.hasStore();
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=86400');
  return res.json({ ok: true, ...payload });
}

// ── op=omegalog (persist actionable picks to the Scoreboard ledger) ──────────────────────
async function runOmegaLog(req, res) {
  const { date, isMarketClosed } = nowET();
  const today = await pull('/api/tracker?op=today', TODAY_TIMEOUT);
  if (!today.ok || !today.data) return res.json({ ok: false, note: 'op=today unavailable' });
  const shortlist = shortlistFromToday(today.data);
  const { map, bench } = await fetchCandleSet(shortlist.map(s => s.ticker), shortlist.map(s => s.sector));
  const payload = buildOmega(shortlist, map, bench, today.data.regime || {});
  const picks = payload.cards
    .filter(c => c.tier === 'OMEGA_PRIME' || c.tier === 'OMEGA_QUALIFIED' || c.tier === 'OMEGA_WATCH')
    .map(c => ({
      ticker: c.ticker, section: 'OMEGA', tier: c.tier, date, entry: c.price,
      score: c.score, stage: c.stage, setup: c.setup || null, catalyst: c.catalyst || null,
      target: c.risk ? c.risk.target1 : null, stop: c.risk ? c.risk.invalidation : null,
    }));
  let logged = 0;
  if (S.hasStore() && !isMarketClosed && picks.length) {
    try { await S.writeOmegaDay(date, picks); logged = picks.length; }
    catch (e) { payload.logError = String((e && e.message) || e); }
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, date, logged, candidates: payload.cards.length, closed: isMarketClosed });
}

// ── op=omegamodel (active scoring config) ────────────────────────────────────────────────
async function runOmegaModel(req, res) {
  const model = await S.readJSON('omega/model.json', null).catch(() => null);
  res.setHeader('Cache-Control', 's-maxage=600');
  return res.json({
    ok: true, version: O.OMEGA_VERSION, scoreWeights: O.SCORE_WEIGHTS,
    tiers: O.TIERS, stages: O.STAGES, horizons: O.OMEGA_HORIZONS,
    trainedModel: model ? { activeId: model.activeId, promoted: !!model.promoted, resolved: model.resolved || 0 } : null,
    note: 'Interpretable formula is the shipped ranker; a trained model overrides weights only after it beats this baseline out-of-sample in op=omegawf.',
  });
}

// ── op=omegawf (purged walk-forward — the evidence that decides if it works) ──────────────
async function runOmegaWf(req, res) {
  const { runOmegaWalkforward } = require('./omega-backfill');
  const scope = req.query.scope || 'large';
  const limit = req.query.limit != null ? +req.query.limit : 60;
  const months = req.query.months != null ? +req.query.months : 24;
  const range = req.query.range || '2y';
  const out = await runOmegaWalkforward({ scope, limit, months, range });
  res.setHeader('Cache-Control', 's-maxage=600');
  return res.json({ ok: true, ...out });
}

// ── op=omegabackfill (seed the Scoreboard ledger from history) ───────────────────────────
async function runOmegaBackfillOp(req, res) {
  if (!S.hasStore()) return res.json({ ok: false, note: 'Blob storage not configured' });
  const { runOmegaLedgerBackfill } = require('./omega-backfill');
  const scope = req.query.scope || 'large';
  const limit = req.query.limit != null ? +req.query.limit : 80;
  const months = req.query.months != null ? +req.query.months : 12;
  const { byDate, stats } = await runOmegaLedgerBackfill({ scope, limit, months });
  let written = 0;
  for (const [date, picks] of Object.entries(byDate)) {
    try {
      const existing = await S.readJSON(`omega/${date}.json`, null);
      const prior = (existing && Array.isArray(existing.picks)) ? existing.picks : [];
      const seen = new Set(prior.map(p => `${p.ticker}:${p.tier}`));
      const merged = [...prior, ...picks.filter(p => !seen.has(`${p.ticker}:${p.tier}`))];
      await S.writeOmegaDay(date, merged); written++;
    } catch { /* skip a failed day */ }
  }
  stats.ledgerDaysWritten = written;
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, stats });
}

module.exports = {
  runOmega, runOmegaLog, runOmegaModel, runOmegaWf, runOmegaBackfillOp,
  buildOmega, shortlistFromToday, catalystFromSignal, etfForSector, reasonsFor,
};

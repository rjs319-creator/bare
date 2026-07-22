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
const { PROVENANCE, makeOmegaObservation, observationId } = require('./omega-contract');
const { assessCalibration } = require('./omega-calibration');
const { statusOf } = require('./strategy-gate');
const { OMEGA_EXECUTION_VERSION } = require('./omega-execution');
const { COST_MODEL_VERSION } = require('./costs');
const OF = require('./omega-funnel');

const OMEGA_MATURITY = statusOf('omega');   // 'shadow' — enforced from the registry, not hard-coded

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
  const provenance = opts.provenance || PROVENANCE.PROSPECTIVE_LIVE;
  // Source-funnel provenance (Phase 4): the shortlist order IS the cross-strategy candidate
  // funnel. Capture each name's source rank/percentile so replay can reproduce the same funnel.
  const n = signals.length;
  const cards = [];
  signals.forEach((sig, i) => {
    const candles = candlesByTicker[sig.ticker];
    if (!candles) return;
    const etf = etfForSector(sig.sector);
    const bench = { spy, sector: etf ? benchCandles[etf] : null };
    const cat = catalystFromSignal(sig);
    const card = O.evaluateCandidate({
      ticker: sig.ticker, candles, bench,
      // maturity:'shadow' shrinks the (educational) size; calibrated:false keeps probs as bands.
      ctx: { ...cat, regime, dilutionRisk: false, maxRiskPct: opts.maxRiskPct || 0.01, maturity: OMEGA_MATURITY, calibrated: false },
    });
    if (!card) return;                            // not enough history → skip (honest)
    card.company = sig.company || null; card.sector = sig.sector || null;
    card.sectorEtf = etf || null;
    card.sources = sig.sources || (sig.source ? [sig.source] : []);
    card.catalyst = cat.catalyst; card.reasons = reasonsFor(card); card.risks = card.penalties.slice(0, 4);
    // Source-funnel provenance.
    card.candidateSource = sig.strategyFamily || (card.sources[0] || null);
    card.sourceRawScore = sig.score != null ? +sig.score : null;
    card.sourceRank = i + 1;
    card.sourcePercentile = n > 1 ? +(100 * (1 - i / (n - 1))).toFixed(0) : 100;
    // Calibration maturity (Phase 9): no calibration artifact ships → probabilities are a
    // transparent baseline. The UI must show evidence BANDS, not percentages.
    const p = card.pred || {};
    card.calibration = {
      pPositive: assessCalibration(p.pPositive, null),
      p3pct: assessCalibration(p.p3pct, null),
      p5pct: assessCalibration(p.p5pct, null),
    };
    card.provenance = provenance;
    cards.push(card);
  });
  // Rank by expected utility (§11), then score, then relative strength.
  cards.sort((a, b) => (b.utility - a.utility) || (b.score - a.score) || ((b.features.rsSpy10 || 0) - (a.features.rsSpy10 || 0)));
  const byTier = {};
  for (const t of O.TIERS) byTier[t] = cards.filter(c => c.tier === t);
  return {
    version: O.OMEGA_VERSION, strategyVersion: 'omega-swing-v2', provenance,
    executionPolicyVersion: OMEGA_EXECUTION_VERSION, costModelVersion: COST_MODEL_VERSION,
    // GOVERNANCE STATUS surfaced next to the picks (Phase 12): shadow ⇒ research candidates,
    // NOT buy signals. Enforced from the strategy registry, not editable wording.
    maturity: OMEGA_MATURITY,
    evidenceStatus: OMEGA_MATURITY === 'production'
      ? 'validated'
      : 'SHADOW RESEARCH — weight-0. Ranked research candidates, NOT buy signals. Probabilities are an uncalibrated baseline (shown as evidence bands). Not promotable until purged walk-forward + prospective-live evidence clears the promotion gate.',
    regime: { label: regime.bearish ? 'risk-off' : regime.riskOn ? 'risk-on' : 'neutral', riskOn: regime.riskOn === true, bearish: regime.bearish === true },
    cards, byTier,
    counts: { total: cards.length, prime: byTier.OMEGA_PRIME.length, qualified: byTier.OMEGA_QUALIFIED.length, watch: byTier.OMEGA_WATCH.length, avoid: byTier.AVOID.length },
    tierMeta: O.TIER_META, stageMeta: O.STAGE_META, setupLegend: O.SETUP_META, scoreWeights: O.SCORE_WEIGHTS,
    dataNote: 'EOD/daily candles (free/Starter feeds). Entries are next-session (T+1 open / conditional trigger) — the signal-day close is NOT tradeable. Probabilities are an uncalibrated baseline shown as evidence bands, not calibrated percentages. Point-in-time ledger + purged walk-forward (op=omegawf) decide whether it predicts anything.',
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
      ticker: c.ticker, section: 'OMEGA', tier: c.tier, date,
      // signalRef is the signal-day CLOSE — a REFERENCE, not a fill. We do NOT log `entry`
      // (the un-tradeable same-close): the Scoreboard's next-open realistic-entry path then
      // measures the honest T+1 fill. signalDate lets the resolver find the signal bar.
      signalRef: c.price, signalDate: date,
      executableState: c.execution ? c.execution.executableState : null,
      maxAcceptableEntryPrice: c.execution ? c.execution.maxAcceptableEntryPrice : null,
      maxAcceptableGapPct: c.execution ? c.execution.maxAcceptableGapPct : null,
      score: c.score, stage: c.stage, setup: c.setup || null, catalyst: c.catalyst || null,
      planTarget: c.risk ? c.risk.target1 : null, planStop: c.risk ? c.risk.invalidation : null,
      candidateSource: c.candidateSource || null, sourceRank: c.sourceRank || null,
      provenance: PROVENANCE.PROSPECTIVE_LIVE, strategyVersion: 'omega-swing-v2',
      executionPolicyVersion: OMEGA_EXECUTION_VERSION,
      observationId: observationId({ provenance: PROVENANCE.PROSPECTIVE_LIVE, strategyVersion: 'omega-swing-v2', signalDate: date, ticker: c.ticker, episodeId: c.tier }),
    }));
  let logged = 0;
  if (S.hasStore() && !isMarketClosed && picks.length) {
    try { await S.writeOmegaLiveDay(date, picks); logged = picks.length; }
    catch (e) { payload.logError = String((e && e.message) || e); }
  }
  // PHASE 4 — capture the exact live candidate funnel (write-once) so a future replay can
  // reproduce it and earn live-funnel parity. Independent of pick logging.
  const funnel = await captureFunnel(today.data, payload, date, { skip: isMarketClosed }).catch(e => ({ error: String((e && e.message) || e) }));
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, date, logged, candidates: payload.cards.length, closed: isMarketClosed, funnel });
}

// Build the immutable funnel snapshot from an op=today payload + OMEGA cards and persist it
// WRITE-ONCE. Shared by op=omegalog (cron) and op=omegafunnel (on-demand).
async function captureFunnel(todayData, payload, date, { skip = false, force = false } = {}) {
  const snapshot = OF.buildFunnelSnapshot({
    date, today: todayData, omegaCards: payload.cards,
    meta: {
      candidateCap: SHORTLIST_MAX, familyFilter: OF.MOMENTUM_FAMILIES,
      generatedAt: new Date().toISOString(),
      sourceStrategyVersion: (todayData.freshness && todayData.freshness.dataVersion) || null,
      universeSnapshotId: (todayData.freshness && todayData.freshness.dataVersion) || null,
      regime: todayData.regime || null,
    },
  });
  const summary = { snapshotId: snapshot.snapshotId, counts: snapshot.counts, strategies: snapshot.strategies };
  if (skip) return { ...summary, written: false, reason: 'market-closed' };
  if (!S.hasStore()) return { ...summary, written: false, reason: 'no-store' };
  const w = await S.writeOmegaFunnelDay(date, snapshot, { force });
  return { ...summary, ...w };
}

// ── op=omegafunnel (build / persist today's candidate-funnel snapshot + report parity coverage) ──
async function runOmegaFunnel(req, res) {
  const { date } = nowET();
  const today = await pull('/api/tracker?op=today', TODAY_TIMEOUT);
  if (!today.ok || !today.data) { res.setHeader('Cache-Control', 's-maxage=60'); return res.json({ ok: false, note: 'op=today unavailable' }); }
  const shortlist = shortlistFromToday(today.data);
  const { map, bench } = await fetchCandleSet(shortlist.map(s => s.ticker), shortlist.map(s => s.sector));
  const payload = buildOmega(shortlist, map, bench, today.data.regime || {});
  const persist = req.query.log === '1';
  const funnel = await captureFunnel(today.data, payload, date, { skip: !persist, force: req.query.force === '1' });
  // Parity coverage — how many days of funnel have accrued (the blocker to a promotable challenger).
  const capturedDates = await S.readOmegaFunnelDates().catch(() => []);
  res.setHeader('Cache-Control', persist ? 'no-store' : 's-maxage=300');
  return res.json({
    ok: true, date, version: OF.OMEGA_FUNNEL_VERSION, funnel,
    parity: {
      capturedSnapshots: capturedDates.length,
      firstCaptured: capturedDates[0] || null, lastCaptured: capturedDates[capturedDates.length - 1] || null,
      note: 'Live-funnel parity accrues going forward. A challenger becomes promotable only once the walk-forward can run over a date range fully covered by captured funnels AND a survivorship-complete universe.',
    },
  });
}

// ── op=omegamodel (active scoring config) ────────────────────────────────────────────────
async function runOmegaModel(req, res) {
  const model = await S.readJSON('omega/model.json', null).catch(() => null);
  const funnelDates = await S.readOmegaFunnelDates().catch(() => []);
  res.setHeader('Cache-Control', 's-maxage=600');
  return res.json({
    ok: true, version: O.OMEGA_VERSION, strategyVersion: 'omega-swing-v2', scoreWeights: O.SCORE_WEIGHTS,
    tiers: O.TIERS, stages: O.STAGES, horizons: O.OMEGA_HORIZONS,
    maturity: OMEGA_MATURITY, executionPolicyVersion: OMEGA_EXECUTION_VERSION, costModelVersion: COST_MODEL_VERSION,
    calibration: { status: 'uncalibrated', display: false, note: 'No out-of-fold-calibrated model artifact. Probabilities are a transparent baseline shown as evidence bands, never as calibrated percentages.' },
    funnelParity: { version: OF.OMEGA_FUNNEL_VERSION, capturedSnapshots: funnelDates.length, firstCaptured: funnelDates[0] || null, lastCaptured: funnelDates[funnelDates.length - 1] || null, historicalLiveParity: false, note: 'Live-funnel snapshots are captured going forward (op=omegafunnel / op=omegalog). Promotion needs a replay range fully covered by captured funnels + a survivorship-complete universe.' },
    trainedModel: model ? { activeId: model.activeId, promoted: !!model.promoted, resolved: model.resolved || 0 } : null,
    note: 'Interpretable formula is the shipped ranker; a trained challenger overrides weights ONLY after it clears every gate in op=omegawf AND is promotable (live-funnel parity + survivorship-safe) — which the current static-universe harness can never satisfy.',
  });
}

// ── op=omegawf (purged walk-forward — the evidence that decides if it works) ──────────────
async function runOmegaWf(req, res) {
  const { runOmegaWalkforward } = require('./omega-backfill');
  const scope = req.query.scope || 'large';
  const limit = req.query.limit != null ? +req.query.limit : 60;
  const months = req.query.months != null ? +req.query.months : 24;
  const range = req.query.range || '2y';
  // Pass captured funnel dates so parity flips automatically once a replay range is fully covered.
  const funnelDates = await S.readOmegaFunnelDates().catch(() => []);
  const out = await runOmegaWalkforward({ scope, limit, months, range, funnelDates });
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
  // Reconstructed picks go to the RESEARCH ledger ONLY (omega/research/) — never merged into
  // the prospective live ledger. This is the structural fix for the shared-namespace defect.
  for (const [date, picks] of Object.entries(byDate)) {
    try {
      const existing = await S.readJSON(`${S.OMEGA_RESEARCH_PREFIX}${date}.json`, null);
      const prior = (existing && Array.isArray(existing.picks)) ? existing.picks : [];
      const seen = new Set(prior.map(p => `${p.ticker}:${p.tier}`));
      const merged = [...prior, ...picks.filter(p => !seen.has(`${p.ticker}:${p.tier}`))];
      await S.writeOmegaResearchDay(date, merged); written++;
    } catch { /* skip a failed day */ }
  }
  stats.researchLedgerDaysWritten = written;
  stats.ledger = 'omega/research/ (reconstruction — separate from the prospective live ledger)';
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, stats });
}

module.exports = {
  runOmega, runOmegaLog, runOmegaModel, runOmegaWf, runOmegaBackfillOp, runOmegaFunnel,
  buildOmega, shortlistFromToday, catalystFromSignal, etfForSector, reasonsFor, captureFunnel,
};

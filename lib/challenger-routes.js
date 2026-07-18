'use strict';
// challenger-routes.js — HTTP surface for the shadow challenger decision system.
//   op=challenger        public cached read  — the four-outcome board (TRADE/WAIT/AVOID/NO_TRADE)
//   op=challengerlog     privileged (cron)   — log the board point-in-time (immutable) BEFORE outcomes
//   op=challengerresolve privileged (cron)   — append forward outcomes to matured predictions
//   op=challengereval    expensive           — walk-forward validation + promotion check (cached)
//
// SHADOW ONLY: reads/writes its own shadow/* Blob prefix + `challenger` immutable ledger.
// It never mutates production ranks, allocation or governance weight.

const { internalHeaders } = require('./auth');
const { gatherRankedSignals } = require('./decision-sources');
const { decideBoard } = require('./challenger-decision');
const { buildSurvivalTable } = require('./challenger-survival');

function hostFrom(req) {
  return (req && (req.headers['x-forwarded-host'] || req.headers.host)) || process.env.WARM_HOST || 'market-news-app-chi.vercel.app';
}
// Injected JSON fetcher (self-fetch cached endpoints with the internal bearer).
function makeFetchJSON(host) {
  return async (path) => {
    const r = await fetch(`https://${host}${path}`, { headers: internalHeaders() });
    if (!r.ok) return null;
    return r.json();
  };
}

// Build the challenger board from an injected fetcher (testable). Survival history comes from
// this challenger's OWN resolved barrier outcomes (empty at cold start => zero TRADE, honest).
async function buildChallengerBoard(fetchJSON, opts = {}) {
  const { readShadowResolved } = require('./store');
  const gathered = await gatherRankedSignals(fetchJSON, opts);
  let survivalTable = new Map();
  try {
    const resolved = await readShadowResolved();
    const rows = Object.values(resolved || {}).filter((r) => r && r.keyParts && r.barrier);
    survivalTable = buildSurvivalTable(rows);
  } catch { /* cold start */ }

  let snapshotCode = null;
  try { snapshotCode = require('./run-manifest').codeVersion(); } catch { /* dev */ }

  const asOf = opts.asOf || (safeNowET() && safeNowET().iso) || null;
  const board = decideBoard(gathered.ranked, {
    asOf,
    regime: gathered.regime,
    density: gathered.density,
    survivalTable,
    governanceStatus: 'paper', // registered core:false; stays paper/weight-0 until validated
    snapshot: { code: snapshotCode, inputCount: gathered.count, asOf },
  });
  board.sourceCount = gathered.count;
  board.provenance = { code: snapshotCode, survivalHistoryCells: survivalTable.size, asOf };
  return board;
}

function safeNowET() { try { return require('./stats').nowET(); } catch { return null; } }

// ---- op=challenger : public cached read ---------------------------------------------------
async function runChallenger(req, res) {
  try {
    const board = await buildChallengerBoard(makeFetchJSON(hostFrom(req)), {});
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=86400');
    return res.json({ ok: true, ...board });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: false, error: String((e && e.message) || e), shadow: true });
  }
}

// Extract the compact point-in-time prediction record stored for later resolution + eval.
function predictionRecord(d, predDate) {
  const feats = {};
  const src = d.challengerRank && d.challengerRank.features;
  if (src) for (const k of Object.keys(src)) feats[k] = { norm: src[k].norm };
  return {
    predDate, ticker: d.ticker, id: d.id, horizon: d.horizon, side: d.side, decision: d.decision,
    entry: d.entry, stop: d.stop, target: d.target,
    residualScore: d.residualScore, percentileRank: d.percentileRank, expectedNetUtilityPct: d.expectedNetUtilityPct,
    confidence: d.confidence, features: feats,
    regimeLabel: d.regimeLabel, capTier: d.capTier, stage: d.stage, eventType: d.eventType,
    strategyFamily: d.strategyFamily,
    baselineProd: d.productionScore, baselineMomentum: d.momentumBaseline, baselineOmega: null,
    survivalEntryState: d.survival && d.survival.entryState,
  };
}

// ---- op=challengerlog : privileged point-in-time immutable logging ------------------------
async function runChallengerLog(req, res) {
  const { hasStore, writeShadowDay } = require('./store');
  res.setHeader('Cache-Control', 'no-store');
  if (!hasStore()) return res.json({ ok: false, error: 'Blob storage not configured.' });
  const et = safeNowET();
  const date = (et && et.date) || (req.query.date || null);
  if (!date) return res.json({ ok: false, error: 'no date' });
  let board;
  try { board = await buildChallengerBoard(makeFetchJSON(hostFrom(req)), { asOf: (et && et.iso) || date }); }
  catch (e) { return res.json({ ok: false, error: String((e && e.message) || e) }); }

  // Log TRADE + WAIT (the actionable predictions) point-in-time, before any outcome is known.
  const preds = [...board.decisions.TRADE, ...board.decisions.WAIT].map((d) => predictionRecord(d, date));
  await writeShadowDay(date, {
    version: board.version, boardDecision: board.boardDecision, noTradeCause: board.noTradeCause,
    counts: board.counts, predictions: preds, regime: board.regime, provenance: board.provenance,
  });

  // Tamper-evident: append the day's predictions to the hash-chained `challenger` stream.
  let ledgerSeq = null;
  try {
    const entry = await require('./immutable-ledger').append('challenger', {
      kind: 'prediction-batch', date, version: board.version, code: board.provenance && board.provenance.code,
      counts: board.counts, boardDecision: board.boardDecision,
      predictions: preds.map((p) => ({ ticker: p.ticker, decision: p.decision, horizon: p.horizon, residualScore: p.residualScore, entry: p.entry, stop: p.stop, target: p.target })),
    });
    ledgerSeq = entry && entry.seq;
  } catch { /* ledger append best-effort (needs store); daily doc is the durable copy */ }

  return res.json({ ok: true, date, logged: preds.length, boardDecision: board.boardDecision, ledgerSeq });
}

// ---- forward-outcome resolution -----------------------------------------------------------
const RES_WINDOW = { intraday: 3, swing: 10, position: 21, portfolio: 63 };
function resolveBarrier(candles, predDate, entry, stop, target, side, window) {
  const idx = candles.findIndex((c) => c.date >= predDate);
  if (idx < 0 || idx + 1 >= candles.length) return null;
  const c0 = candles[idx].close;
  const end = Math.min(idx + window, candles.length - 1);
  let barrier = 'time', barsToBarrier = null;
  for (let k = idx + 1; k <= end; k++) {
    const c = candles[k];
    const hitStop = side === 'long' ? (stop != null && c.low <= stop) : (stop != null && c.high >= stop);
    const hitTgt = side === 'long' ? (target != null && c.high >= target) : (target != null && c.low <= target);
    if (hitStop) { barrier = 'lower'; barsToBarrier = k - idx; break; } // conservative: same-bar => stop
    if (hitTgt) { barrier = 'upper'; barsToBarrier = k - idx; break; }
  }
  if (barrier === 'time' && end - idx < window) return null; // window not fully elapsed => still open
  return { barrier, barsToBarrier, c0, c1: candles[end].close, endDate: candles[end].date, idx, end };
}

async function runChallengerResolve(req, res) {
  const { hasStore, readAllShadowDays, readShadowResolved, writeShadowResolved } = require('./store');
  const { fetchDailyHistory } = require('./screener');
  const { roundTripCostPct, tierForPick } = require('./costs');
  res.setHeader('Cache-Control', 'no-store');
  if (!hasStore()) return res.json({ ok: false, error: 'Blob storage not configured.' });

  const days = await readAllShadowDays();
  const resolved = (await readShadowResolved()) || {};
  const pending = [];
  for (const d of days) for (const p of (d.predictions || [])) {
    const key = `${p.predDate}|${p.ticker}|${p.horizon}`;
    if (!resolved[key] && p.entry != null && p.stop != null) pending.push({ ...p, key });
  }
  if (!pending.length) return res.json({ ok: true, resolved: 0, open: 0, note: 'nothing to resolve' });

  const spy = await fetchDailyHistory('SPY', '1y').catch(() => null);
  const spyC = spy && spy.candles;
  const tickers = [...new Set(pending.map((p) => p.ticker))];
  const candleMap = {};
  let i = 0;
  const worker = async () => { while (i < tickers.length) { const t = tickers[i++]; try { const h = await fetchDailyHistory(t, '1y'); candleMap[t] = h && h.candles; } catch { candleMap[t] = null; } } };
  await Promise.all(Array.from({ length: 6 }, worker));

  let done = 0, stillOpen = 0;
  const ledgerEntries = [];
  for (const p of pending) {
    const c = candleMap[p.ticker];
    const window = RES_WINDOW[p.horizon] || 10;
    const rb = c && spyC ? resolveBarrier(c, p.predDate, p.entry, p.stop, p.target, p.side, window) : null;
    if (!rb) { stillOpen++; continue; }
    const spyIdx = spyC.findIndex((x) => x.date >= p.predDate);
    const spyEnd = spyC.findIndex((x) => x.date >= rb.endDate);
    const spyRet = spyIdx >= 0 && spyEnd >= 0 ? (spyC[spyEnd].close - spyC[spyIdx].close) / spyC[spyIdx].close : 0;
    const tickRet = (rb.c1 - rb.c0) / rb.c0;
    const tier = tierForPick({ section: p.strategyFamily === 'biotech' ? 'Biotech' : undefined, scope: p.capTier === 'small' || p.capTier === 'mid' ? 'small' : undefined });
    const grossExcess = (tickRet - spyRet) * 100;
    const outcome = +(grossExcess - roundTripCostPct(tier)).toFixed(3); // residual excess, net of estimated costs
    const rec = {
      key: p.key, predDate: p.predDate, ticker: p.ticker, horizon: p.horizon, decision: p.decision,
      barrier: rb.barrier, barsToBarrier: rb.barsToBarrier, windowUsed: window,
      keyParts: [p.horizon, p.strategyFamily || 'trend', p.regimeLabel || 'neutral', p.capTier || 'unknown', p.stage || 'unknown', p.eventType || 'none'],
      outcome, won: outcome > 0, residualScore: p.residualScore,
      baselineProd: p.baselineProd, baselineMomentum: p.baselineMomentum, baselineOmega: p.baselineOmega,
      features: p.features, regimeLabel: p.regimeLabel, capTier: p.capTier, eventType: p.eventType,
      resolvedAt: rb.endDate,
    };
    resolved[p.key] = rec; // append-only map keyed predDate|ticker|horizon; never overwrites a prediction
    ledgerEntries.push({ kind: 'resolution', refKey: p.key, barrier: rb.barrier, outcome, won: rec.won });
    done++;
  }
  await writeShadowResolved(resolved);
  if (ledgerEntries.length) {
    try { await require('./immutable-ledger').append('challenger', { kind: 'resolution-batch', at: (safeNowET() && safeNowET().date) || null, resolutions: ledgerEntries }); } catch { /* best-effort */ }
  }
  return res.json({ ok: true, resolved: done, open: stillOpen, totalResolved: Object.keys(resolved).length });
}

// ---- op=challengereval : validation + promotion (cached) ----------------------------------
async function runChallengerEval(req, res) {
  const { hasStore, readShadowResolved, readShadowEval, writeShadowEval } = require('./store');
  const evalLib = require('./challenger-eval');
  if (req.query.force !== '1') {
    const cached = await readShadowEval().catch(() => null);
    if (cached) { res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400'); return res.json({ ok: true, cached: true, ...cached }); }
  }
  if (!hasStore()) { res.setHeader('Cache-Control', 'no-store'); return res.json({ ok: false, error: 'Blob storage not configured.' }); }
  const resolved = (await readShadowResolved()) || {};
  const preds = Object.values(resolved).filter((r) => r && r.predDate);
  const now = (safeNowET() && safeNowET().date) || null;
  const evaluation = evalLib.evaluate(preds, { now });
  const promotion = evalLib.promotionCheck(evaluation);
  const payload = { version: evalLib.EVAL_VERSION, generatedAt: now, resolvedCount: preds.length, evaluation, promotion, shadow: true, note: 'Shadow challenger — evaluation is advisory; governance keeps it paper/weight-0 until it sustains a live-forward record.' };
  await writeShadowEval(payload).catch(() => {});
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  return res.json({ ok: true, cached: false, ...payload });
}

module.exports = {
  buildChallengerBoard, predictionRecord, resolveBarrier, RES_WINDOW,
  runChallenger, runChallengerLog, runChallengerResolve, runChallengerEval,
};

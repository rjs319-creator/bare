'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// PSRL routes — HTTP layer only (params, budget, cache headers, JSON).
// All logic lives in pure lib/psrl/* modules.
//
//   op=psrl        public read  — Persistent Trends board (latest + ledger)
//   op=psrldetail  public read  — one ticker's full card + episode history
//   op=psrlhealth  public read  — tick health + ledger stats
//   op=psrltick    PRIVILEGED   — nightly job: scan universe, score, update
//                                 episode ledger, persist (idempotent per asOf)
//   op=psrlresearch EXPENSIVE   — registered experiments + accrual status
//                                 (never interim confirmatory metrics)
//
// SHADOW / weight-0: nothing here feeds production ranking. Universe rows and
// benchmarks are the SAME loaders RLT uses (one loader, one sector→ETF map).
// ═══════════════════════════════════════════════════════════════════════════

const CFG = require('./psrl/config');
const { runPsrl } = require('./psrl/engine');
const EP = require('./psrl/episodes');
const PS = require('./psrl/store');

const noStore = (res) => res.setHeader('Cache-Control', 'no-store');
const cached = (res, s = 120) => res.setHeader('Cache-Control', `s-maxage=${s}, stale-while-revalidate=600`);

// ── novice / expert projections (data-side, rlt-lab pattern) ────────────────

function noviceOf(card) {
  const q = card.quadrant, st = card.absPath?.state;
  let read;
  if (q === 'TRUE_LEADER' && (st === 'STEADY_ADVANCE' || st === 'JUMP_CONTINUING')) read = 'Rising faster than the market and its sector';
  else if (q === 'TRUE_LEADER' && (st === 'ORDERLY_PAUSE' || st === 'JUMP_HOLDING')) read = 'Steady advance taking a constructive pause';
  else if (q === 'TRUE_LEADER' && st === 'ACCELERATING') read = 'Steady multi-month advance, currently accelerating';
  else if (q === 'MARKET_CARRIED_LAGGARD') read = 'Price is rising, but mostly because the market is strong';
  else if (q === 'DEFENSIVE_LEADER') read = 'Holding up better than the market, but not yet advancing';
  else if (st === 'JUMP_PLATEAU') read = 'One-day jump followed by little progress';
  else if (card.stage === 'LOSING_LEADERSHIP') read = 'Leadership weakening';
  else if (card.entry?.state === 'WAIT_FOR_PULLBACK') read = 'Strong trend, but currently too extended';
  else read = 'Mixed evidence';
  const risk = (card.penalties || [])[0]?.detail || (card.eventRisk ? 'binary event ahead' : 'ordinary market risk');
  return { read, risk, actionable: card.entry?.state || null };
}

function expertOf(card) {
  const r = card.residual || {};
  return {
    beta: r.beta, betaObs: r.betaObs, sectorLoading: r.sectorLoading,
    residualVol: r.residualVol, residualAccel: r.residualAccel, supportBasis: r.supportBasis,
    residual21: r.byHorizon?.[21]?.residual ?? null, residual63: r.byHorizon?.[63]?.residual ?? null,
    marketRel63: r.byHorizon?.[63]?.marketRel ?? null, sectorRel63: r.byHorizon?.[63]?.sectorRel ?? null,
    id63: card.continuity?.w63?.discreteness?.id ?? null,
    efficiency63: card.continuity?.w63?.efficiency?.efficiency ?? null,
    top3Share: card.continuity?.w63?.concentration?.top3Share ?? null,
    gapDependence: card.continuity?.w63?.gaps?.gapDependence ?? null,
    rsMarketSlope: card.rsLines?.market?.slope ?? null,
    rsSectorSlope: card.rsLines?.sector?.available ? card.rsLines.sector.slope : null,
    speeds: card.speeds?.interpretation ?? null,
    calibrationStatus: 'uncalibrated',
  };
}

function compactCard(card) {
  const t = (h) => (card.trend?.byHorizon?.[h]?.available ? card.trend.byHorizon[h].totalReturn : null);
  return {
    rank: card.rank, ticker: card.ticker, sector: card.sector,
    price: card.liquidity?.price ?? null, dollarVol: card.liquidity?.dollarVol ?? null,
    arrows: card.arrows, glyphs: card.arrowGlyphs,
    entry: card.entry?.state, entryReasons: card.entry?.reasons,
    quadrant: card.quadrant, stage: card.stage, pathState: card.absPath?.state ?? null,
    scores: {
      combined: card.scores?.combinedAfterPenalties ?? null,
      persistentTrend: card.scores?.persistentTrend ?? null,
      relativeLeadership: card.scores?.relativeLeadership ?? null,
    },
    ret21: t(21), ret63: t(63), ret126: t(126),
    residual21: card.residual?.byHorizon?.[21]?.residual ?? null,
    residual63: card.residual?.byHorizon?.[63]?.residual ?? null,
    continuity: card.continuity?.w63?.discreteness?.continuity ?? null,
    jumpConcentration: card.continuity?.w63?.concentration?.top1Share ?? null,
    plateauRisk: card.absPath?.state === 'JUMP_PLATEAU' ? 'HIGH'
      : card.absPath?.state === 'DECELERATING' ? 'ELEVATED' : 'LOW',
    extensionAtr: card.extensionAtr, trendAge: card.trendAge,
    support: card.support?.grade, penalties: (card.penalties || []).map((p) => p.code),
    sectorDataAvailable: card.sectorDataAvailable,
    vetoed: card.vetoes?.vetoed ?? null,
    vetoCodes: card.vetoes
      ? ['stagnation', 'plateau', 'breakdown', 'data'].filter((k) => card.vetoes[k]?.triggered) : [],
    trendLife: card.trendLife?.available
      ? { expectedRemaining: card.trendLife.expectedRemaining, medianRemaining: card.trendLife.medianRemaining, calibrationStatus: 'uncalibrated' }
      : { available: false, reason: card.trendLife?.reason ?? 'INSUFFICIENT_SAMPLE' },
    changepoint: card.changepoint?.residual?.likelyTransition
      ?? card.changepoint?.absolute?.likelyTransition ?? null,
    sectorState: card.sectorStructure?.state ?? null,
    horizonsDisagree: card.opportunity?.horizonsDisagree ?? null,
    novice: noviceOf(card), expert: expertOf(card),
  };
}

function ledgerSummary(ledger) {
  if (!ledger) return { available: false, episodes: [], closed: [] };
  const eps = Object.values(ledger.episodes || {});
  const brief = (e) => ({
    symbol: e.symbol, status: e.status, startDate: e.startDate, trendAge: e.trendAge,
    entry: e.currentEntry, quadrant: e.currentQuadrant, stage: e.currentStage,
    combined: e.currentScores?.combined ?? null, peakScore: e.peakScore,
    mfe: e.mfe, mae: e.mae, rightCensored: e.rightCensored,
    lastReason: (e.reasonHistory || []).slice(-1)[0] || null,
    terminalEvent: e.terminalEvent, terminalDate: e.terminalDate,
  });
  return {
    available: true, asOf: ledger.asOf,
    counts: { active: eps.length, closed: (ledger.closed || []).length },
    episodes: eps.map(brief).sort((a, b) => (b.combined ?? -1) - (a.combined ?? -1) || (a.symbol < b.symbol ? -1 : 1)),
    closed: (ledger.closed || []).slice(-25).reverse().map(brief),
  };
}

const SHADOW_BANNER = Object.freeze({
  status: 'SHADOW',
  weight: 0,
  note: 'Persistent Staircase Relative Leadership — evidence scores only; probabilities are not trained or calibrated; never a buy signal; weight-0 in all production ranking.',
});

// ── ops ─────────────────────────────────────────────────────────────────────

async function runPsrlBoard(req, res) {
  try {
    cached(res, 300);
    const [latest, ledger] = await Promise.all([PS.readLatest(), PS.readLedger()]);
    if (!latest) {
      return res.status(200).json({ ok: true, available: false, shadow: SHADOW_BANNER, note: 'no snapshot yet — first psrltick pending' });
    }
    const top = (latest.cards || []).slice(0, 40).map(compactCard);
    return res.status(200).json({
      ok: true, available: true, shadow: SHADOW_BANNER,
      engineVersion: latest.engineVersion, asOf: latest.asOf,
      calibrationStatus: latest.calibrationStatus, counts: latest.counts,
      market: latest.market ?? null,
      sectorBreadth: latest.sectorBreadth ?? null,
      trendLifeFit: latest.trendLifeFit ?? null,
      cards: top, ledger: ledgerSummary(ledger),
    });
  } catch (e) {
    noStore(res);
    return res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
}

async function runPsrlDetail(req, res) {
  try {
    cached(res, 120);
    const ticker = String(req.query.ticker || '').toUpperCase().replace(/[^A-Z0-9.^-]/g, '');
    if (!ticker) { noStore(res); return res.status(400).json({ ok: false, error: 'ticker required' }); }
    const [latest, ledger] = await Promise.all([PS.readLatest(), PS.readLedger()]);
    const card = (latest?.cards || []).find((c) => c.ticker === ticker) || null;
    const episode = ledger?.episodes?.[ticker]
      || (ledger?.closed || []).filter((e) => e.symbol === ticker).slice(-1)[0] || null;
    return res.status(200).json({
      ok: true, shadow: SHADOW_BANNER, ticker,
      found: !!(card || episode), asOf: latest?.asOf ?? null,
      card, compact: card ? compactCard(card) : null, episode,
    });
  } catch (e) {
    noStore(res);
    return res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
}

async function runPsrlHealth(req, res) {
  try {
    cached(res, 120);
    const [health, ledger] = await Promise.all([PS.readHealth(), PS.readLedger()]);
    const eps = Object.values(ledger?.episodes || {});
    return res.status(200).json({
      ok: true, shadow: SHADOW_BANNER, health: health || { available: false },
      ledger: {
        asOf: ledger?.asOf ?? null, active: eps.length, closed: (ledger?.closed || []).length,
        byStatus: eps.reduce((m, e) => { m[e.status] = (m[e.status] || 0) + 1; return m; }, {}),
        rightCensored: eps.filter((e) => e.rightCensored).length,
      },
    });
  } catch (e) {
    noStore(res);
    return res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
}

/** Nightly writer. Idempotent per asOf (ledger refuses same-day re-apply; day
 *  docs overwrite themselves; latest rewrite is a no-op re-run). */
async function runPsrlTick(req, res) {
  noStore(res);
  const t0 = Date.now();
  try {
    if (!PS.hasStore()) return res.status(200).json({ ok: false, reason: 'no-blob-store — degraded, nothing persisted' });
    const { loadUniverseRows, loadBenchmarks } = require('./rlt-routes');
    const [{ rows, totalPool, capped }, bench] = await Promise.all([loadUniverseRows(), loadBenchmarks()]);
    const spy = bench.SPY;
    if (!spy || !spy.length) return res.status(200).json({ ok: false, reason: 'spy-history-unavailable' });
    const asOf = String(spy[spy.length - 1].date);

    const scanRows = rows.slice(0, CFG.SCAN_CAP).map((r) => ({
      ticker: r.ticker, sector: r.sector, candles: r.bars,
      sectorCandles: r.sectorEtf && bench[r.sectorEtf] ? bench[r.sectorEtf] : null,
    }));
    const prev = await PS.readLatest();
    const prevLedger = await PS.readLedger();
    // Trend-life is fitted on the PRIOR ledger only — today's outcomes cannot
    // influence today's projections (PIT). Abstains until ≥30 resolved episodes.
    const trendLifeFit = require('./psrl/survival').fitTrendLife(prevLedger);
    const snapshot = runPsrl({ rows: scanRows, spyCandles: spy, asOf, prev, trendLifeFit });
    const { ledger, transitions, idempotent } = EP.applyDay(prevLedger, snapshot);

    const coverage = {
      universePool: totalPool, scanned: scanRows.length, scanCap: CFG.SCAN_CAP,
      pooledCapped: capped || scanRows.length < totalPool,
      note: scanRows.length < totalPool ? `liquidity-ranked truncation: scanned top ${scanRows.length} of ${totalPool}` : null,
      sectorEtfs: Object.keys(bench).length,
    };
    await PS.writeLatest(snapshot);
    if (!idempotent) await PS.writeLedger(ledger);
    await PS.writeDay(asOf, {
      schema: 'PsrlDay', asOf, engineVersion: snapshot.engineVersion,
      counts: snapshot.counts, coverage,
      cards: (snapshot.cards || []).slice(0, 60).map(compactCard),
      transitions,
    });
    await PS.writeHealth({
      lastRunAsOf: asOf, elapsedMs: Date.now() - t0, counts: snapshot.counts,
      coverage, transitions: transitions.length, idempotent,
      engineVersion: snapshot.engineVersion,
    });
    return res.status(200).json({
      ok: true, asOf, idempotent, counts: snapshot.counts, coverage,
      transitions: transitions.length, elapsedMs: Date.now() - t0,
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e && e.message || e), elapsedMs: Date.now() - t0 });
  }
}

async function runPsrlResearch(req, res) {
  try {
    cached(res, 300);
    const { experimentStatus, ATTRIBUTION } = require('./psrl/research');
    const { fitTrendLife } = require('./psrl/survival');
    const ledger = await PS.readLedger();
    const fit = fitTrendLife(ledger);
    return res.status(200).json({
      ok: true, shadow: SHADOW_BANNER, ...experimentStatus({ ledger }),
      trendLife: {
        available: fit.available, resolved: fit.resolved, censored: fit.censored,
        reason: fit.reason ?? null, byCause: fit.byCause ?? null,
        note: 'life-table accrual; probabilities remain uncalibrated and are never displayed as percentages',
      },
      cflAttribution: ATTRIBUTION,
    });
  } catch (e) {
    noStore(res);
    return res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
}

module.exports = { runPsrlBoard, runPsrlDetail, runPsrlHealth, runPsrlTick, runPsrlResearch, compactCard, ledgerSummary };

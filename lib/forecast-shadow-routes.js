'use strict';
// CFR PROSPECTIVE SHADOW — route handlers (weight 0; prospective ledger + display only).
//
//   op=forecastshadow         public read  — frozen prespecification + ledger progress
//   op=forecastshadowtick     PRIVILEGED   — score the just-closed session with the live
//                                            forecast pipeline (fetchDailyHistory →
//                                            makePanel → runInference) and append a
//                                            write-once ledger day. TRADING DAYS ONLY.
//   op=forecastshadowresolve  PRIVILEGED   — resolve ONE matured ledger day: per-date
//                                            rank IC of both arm orderings against
//                                            realized FROZEN-BETA residual returns.
//
// The ledger integrity rules are the stbull template's, verbatim in spirit:
//   • FAIL-CLOSED INDEX READS (readIndexChecked; an unreadable index is never "empty")
//   • WRITE-ONCE DAY DOCS (existence probed; an orphaned doc is re-indexed, not rewritten)
//   • CARRIED-BOOK BASELINE FAILS CLOSED (an unreadable previous day doc is a 502 —
//     silently starting a fresh book would charge phantom turnover and break the band)
//   • ALL FOUR HORIZONS OR NOTHING (a partial-horizon day would corrupt the prespecified
//     FDR family; the tick refuses rather than minting one)
//   • RESOLVE NEVER FAIL-OPENS A DAY (fetch failures postpone, bounded; a day whose
//     window still cannot be observed past RESOLVE_MAX_AGE_DAYS closes out recorded)
//
// The board changes NO ranking, selection, sizing, alerts or governance. Promotion
// beyond a labeled read requires the frozen prospective gate — lib/forecast-shadow.js
// FROZEN and docs/forecast-shadow.md.

const S = require('./forecast-shadow');
const STORE = require('./store');
const { mapLimit } = require('./map-limit');
const { sessionInfoAt } = require('./market-session');
const { fetchDailyHistory } = require('./screener');
const { LARGE } = require('./universe');

const INDEX_KEY = 'forecastshadow/v1/prospective/index.json';
const dayKey = (date) => `forecastshadow/v1/prospective/${date}.json`;

const SECTOR_ETFS = ['XLK', 'XLC', 'XLY', 'XLP', 'XLV', 'XLF', 'XLI', 'XLE', 'XLU', 'XLRE', 'XLB'];
const FETCH_CONCURRENCY = 6;
const MIN_UNIVERSE_FETCHED = 450;         // below this the cross-section is not the declared one — refuse
const RESOLVE_AFTER_CALENDAR_DAYS = 16;   // >= 10 sessions past the decision date, with weekend slack
const RESOLVE_MAX_FETCH_ATTEMPTS = 3;
const RESOLVE_MAX_AGE_DAYS = 40;
const MAX_HORIZON = Math.max(...S.FROZEN.horizons);

const noStore = (res) => res.setHeader('Cache-Control', 'no-store');
const cached = (res, s = 600) => res.setHeader('Cache-Control', `s-maxage=${s}, stale-while-revalidate=600`);
const errText = (e) => String((e && e.message) || e);

// The exact geometry the benchmark ran (research/88 buildConfig): admitting a different
// fold/embargo geometry here would make the prospective lane confirm a config nobody
// measured. trainSessions/dateStride mirror op=forecastrank's serving defaults.
const CFG_OVERRIDES = Object.freeze({
  horizons: [...S.FROZEN.horizons],
  universe: { maxNames: 1500, minAvgDollarVolume: S.FROZEN.universe.minAvgDollarVolume, minHistorySessions: S.FROZEN.universe.minHistorySessions },
  walkforward: { embargoSessions: MAX_HORIZON + 2, minTrainSessions: 100, testSessions: 25, innerFolds: 3, holdoutFraction: 0.2, scheme: 'expanding' },
  metaRanker: { numRounds: 200, minDataInLeaf: 100 },
  calibration: { minSamples: 1000, minPositives: 50, minNegatives: 50 },
});

function lazyForecast() {
  // Lazy so importing this module never pulls the forecast system (or a Python probe)
  // into an unrelated request path — the same rule lib/forecast-routes.js follows.
  return require('./forecast');
}

const EMPTY_INDEX = () => ({
  version: 'forecast-shadow-ledger-v1',
  dates: [], resolved: [], attempts: {},
  aggregate: { perHorizon: Object.fromEntries(S.FROZEN.horizons.map((h) => [h, { resolvedDates: 0, sumPrimaryIC: 0, sumXsIC: 0 }])) },
});

// Fail-closed index read — blobExists distinguishes "genuinely absent" (first run)
// from "exists but unreadable" (refuse; treating it as empty would wipe the ledger).
async function readIndexChecked() {
  const exists = await STORE.blobExists(INDEX_KEY);
  if (!exists) return EMPTY_INDEX();
  const idx = await STORE.readJSON(INDEX_KEY, null);
  if (!idx) throw new Error('ledger index exists but is unreadable');
  return { ...EMPTY_INDEX(), ...idx };
}

async function fetchSeries(tickers, range, failures) {
  const out = new Map();
  await mapLimit(tickers, FETCH_CONCURRENCY, async (t) => {
    try {
      const d = await fetchDailyHistory(t, range);
      if (d && Array.isArray(d.candles) && d.candles.length) out.set(t, d.candles);
      else failures.push(t);
    } catch { failures.push(t); }
  });
  return out;
}

const dateIndexOf = (candles) => new Map(candles.map((b, i) => [b.date, i]));

// ── op=forecastshadow : public read ─────────────────────────────────────────
async function runForecastShadow(req, res) {
  if (!STORE.hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  let idx = null, idxError = null;
  try { idx = await readIndexChecked(); } catch (e) { idxError = errText(e); }
  const latestDate = idx && idx.dates.length ? idx.dates[idx.dates.length - 1] : null;
  const latest = latestDate ? await STORE.readJSON(dayKey(latestDate), null) : null;
  // Never CDN-cache the empty state (a pre-first-tick response cached at the edge would
  // render as "lane missing" for everyone behind that node).
  if (latest) cached(res); else noStore(res);
  const agg = (idx && idx.aggregate && idx.aggregate.perHorizon) || {};
  return res.status(200).json({
    ok: true,
    state: 'SHADOW',
    frozen: S.FROZEN,
    available: !!latest,
    ...(latest ? {
      asOf: latest.date,
      provenance: latest.provenance,
      horizons: Object.fromEntries(Object.entries(latest.horizons || {}).map(([h, v]) => [h, {
        cohortSize: v.cohortSize,
        top10: (v.rows || []).filter((r) => r.primaryRank != null && r.primaryRank <= 10).sort((a, b) => a.primaryRank - b.primaryRank).map((r) => r.ticker),
        book: v.book ? { size: (v.book.book || []).length, turnover: v.book.turnover, chargedCost: v.book.chargedCost } : null,
      }])),
    } : { reason: idxError ? undefined : 'no ledger day yet — op=forecastshadowtick has not run', ...(idxError ? { indexError: idxError } : {}) }),
    prospective: idx ? {
      ledgerDays: idx.dates.length,
      resolvedTotal: (idx.resolved || []).length,
      target: S.FROZEN.prospectiveGate.minResolvedDates,
      perHorizon: Object.fromEntries(S.FROZEN.horizons.map((h) => {
        const a = agg[h] || { resolvedDates: 0, sumPrimaryIC: 0, sumXsIC: 0 };
        return [h, {
          resolvedDates: a.resolvedDates,
          meanPrimaryICSoFar: a.resolvedDates ? +(a.sumPrimaryIC / a.resolvedDates).toFixed(5) : null,
          meanXsICSoFar: a.resolvedDates ? +(a.sumXsIC / a.resolvedDates).toFixed(5) : null,
        }];
      })),
      note: 'running means of per-date rank ICs; the gate is a formal date-clustered eval (NW + block bootstrap, FDR across horizons) at >= 80 resolved dates per family — these running means are explicitly NOT the gate',
    } : { unavailable: true, reason: idxError },
    disclosure: 'Shadow research ledger for the cross-sectional forecast ranker (PR #405). The primary arm confirms the benchmarked ridge point forecast; the ridge-xs arm is FIRST prospective evidence for an unbenchmarked serving path. Weight 0: affects no ranking, no selection, no sizing, no alerts. The benchmark found NO after-cost profitable strategy; this ledger measures whether the SIGNAL survives live, survivorship-free data.',
  });
}

// ── op=forecastshadowtick : score the closed session, append write-once day ─
async function runForecastShadowTick(req, res) {
  noStore(res);
  if (!STORE.hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  const si = sessionInfoAt(new Date());
  if (!si.isTradingDay) {
    return res.status(200).json({ ok: true, skipped: 'non-trading day — no ledger day minted' });
  }

  let idx;
  try { idx = await readIndexChecked(); }
  catch (e) { return res.status(502).json({ ok: false, error: `ledger index unreadable — nothing written: ${errText(e)}` }); }

  // Benchmark first: its settled axis defines the decision date. Fail closed on a miss.
  const failures = [];
  let spy;
  try { spy = await fetchDailyHistory('SPY', '3y'); } catch { spy = null; }
  if (!spy || !Array.isArray(spy.candles) || spy.candles.length < 700) {
    return res.status(502).json({ ok: false, error: 'SPY history unavailable or short — nothing written' });
  }
  const asOf = spy.candles[spy.candles.length - 1].date;
  if (idx.dates.includes(asOf)) {
    return res.status(200).json({ ok: true, date: asOf, ledger: 'already-written', ledgerDays: idx.dates.length });
  }
  if (asOf !== si.etDate) {
    // The 22:00 UTC tick runs after the close; a benchmark that has not settled today's
    // bar yet would mint yesterday's date twice tomorrow. Skip loudly instead.
    return res.status(200).json({ ok: true, skipped: `benchmark last settled ${asOf}, session is ${si.etDate} — provider not settled yet, nothing written` });
  }

  const sectorCandles = new Map();
  const etfFails = [];
  const fetchedEtfs = await fetchSeries(SECTOR_ETFS, '3y', etfFails);
  if (etfFails.length) {
    return res.status(502).json({ ok: false, error: `sector ETF series missing (${etfFails.join(',')}) — the residual target needs every sector leg; nothing written` });
  }
  for (const [t, c] of fetchedEtfs) sectorCandles.set(t, c);

  const fetched = await fetchSeries(LARGE, '3y', failures);
  if (fetched.size < MIN_UNIVERSE_FETCHED) {
    return res.status(502).json({ ok: false, error: `only ${fetched.size}/${LARGE.length} candidate series fetched (floor ${MIN_UNIVERSE_FETCHED}) — not the declared cross-section; nothing written`, fetchFailures: failures.length });
  }
  const dataset = new Map([...fetched].map(([t, candles]) => [t, { candles }]));

  const F = lazyForecast();
  const cfg = F.config.resolveConfig(CFG_OVERRIDES);
  const caps = F.capabilities.detectCapabilities(cfg);
  const panel = F.panel.makePanel({ dataset, benchCandles: spy.candles, sectorCandles });
  const out = F.infer.runInference({
    panel, cfg, caps, asOf,
    trainSessions: S.FROZEN.inference.trainSessions,
    dateStride: S.FROZEN.inference.dateStride,
  });
  if (!out.ok) return res.status(502).json({ ok: false, error: `inference refused: ${out.reason} — nothing written` });
  const bad = S.FROZEN.horizons.filter((h) => !(out.horizons[h] && out.horizons[h].ok));
  if (bad.length) {
    // All four horizons or nothing — a partial day would corrupt the FDR family.
    return res.status(502).json({ ok: false, error: `horizon(s) ${bad.join(',')} failed (${bad.map((h) => out.horizons[h] && out.horizons[h].reason).join('; ')}) — nothing written` });
  }

  // Decision-date beta rows: the scored row lacks betaSectorMarket, which the resolver's
  // frozen-beta residual needs. Same panel, same cfg, same modules — no second formula.
  const servePanel = F.dataset.buildPanelRows({ panel, dates: [asOf], cfg, requireLabel: false });
  const betaRows = new Map();
  for (const h of S.FROZEN.horizons) {
    for (const r of servePanel.rowsByHorizon.get(h) || []) {
      if (!betaRows.has(r.ticker)) betaRows.set(r.ticker, r);
    }
  }

  // Carried-book baseline fails closed: an unreadable previous day doc must not silently
  // reset the band and charge a phantom full rebuild.
  const prevDate = idx.dates.length ? idx.dates[idx.dates.length - 1] : null;
  let prevDoc = null;
  if (prevDate) {
    prevDoc = await STORE.readJSON(dayKey(prevDate), null);
    if (!prevDoc) return res.status(502).json({ ok: false, error: `previous ledger day ${prevDate} unreadable — carried book baseline would be wrong; nothing written` });
  }

  const horizons = {};
  for (const h of S.FROZEN.horizons) {
    const scored = out.horizons[h].rows;
    const shardRows = S.buildShardRows(scored, betaRows);
    const bySector = new Map(shardRows.map((r) => [r.ticker, r.sector]));
    const costOfMap = new Map(shardRows.map((r) => [r.ticker, r.estimatedCostFraction]));
    const ordered = S.primaryOrder(scored).map((r) => ({ ticker: r.ticker, sector: bySector.get(r.ticker) || null }));
    const prevBook = prevDoc && prevDoc.horizons && prevDoc.horizons[h] && prevDoc.horizons[h].book ? (prevDoc.horizons[h].book.book || []) : [];
    const sleeve = S.carrySleeve(ordered, prevBook);
    const charge = S.chargeFor(prevBook, sleeve.book, (t) => costOfMap.get(t));
    horizons[h] = {
      cohortSize: out.horizons[h].cohortSize,
      rankerBackend: out.horizons[h].rankerBackend,
      rows: shardRows,
      book: { book: sleeve.book, turnover: sleeve.turnover, chargedCost: charge.chargedCost, pricedFraction: charge.pricedFraction },
    };
  }

  const doc = {
    version: 'forecast-shadow-ledger-v1',
    experimentId: S.FROZEN.experimentId,
    date: asOf, prevDate,
    provenance: {
      tier: caps.tier, tierLabel: caps.tierLabel, metaBackend: caps.metaBackend,
      orderingField: 'expectedResidualReturn',
      xsOrderingField: 'rank (served rankerScore ordering)',
      provider: 'yahoo-live (lib/screener fetchDailyHistory; stooq fallback)',
      configHash: cfg.configHash, manifestHash: out.manifest && out.manifest.manifestHash,
      trainSessions: S.FROZEN.inference.trainSessions, dateStride: S.FROZEN.inference.dateStride,
      candidates: LARGE.length, fetched: fetched.size, fetchFailures: failures.slice(0, 40),
      benchmarkCutoffNote: 'confirming evidence (cfr-walkforward-2026-08) ends 2026-07-06 on the FMP research snapshot; this ledger begins on live Yahoo bars',
      // The book parameters ACTUALLY IN FORCE — without these the descriptive channel is
      // uninterpretable (the same signal at band 1 vs band 4 differs by a Sharpe point).
      // Pinned frozen values, deliberately NOT the benchmark's per-fold portfolioSelection
      // (those are per-training-window choices and move fold to fold).
      bookConfig: {
        topK: S.FROZEN.book.topK, noTradeBand: S.FROZEN.book.noTradeBand,
        weighting: S.FROZEN.book.weighting, switchCostTest: false,
        rebalance: 'every-trading-day (sessionsPerPeriod 1; the benchmark samples every 3 sessions — annualized numbers are not comparable without this)',
        parameterSource: 'lib/forecast-shadow FROZEN.book (fixed, declared pre-outcome)',
      },
    },
    horizons,
  };

  let dayExists;
  try { dayExists = await STORE.blobExists(dayKey(asOf)); }
  catch (e) { return res.status(502).json({ ok: false, error: `day-doc existence probe failed — nothing written: ${errText(e)}` }); }
  if (!dayExists) await STORE.writeJSON(dayKey(asOf), doc, 0);
  await STORE.writeJSON(INDEX_KEY, { ...idx, dates: [...idx.dates, asOf] }, 0);
  return res.status(200).json({
    ok: true, date: asOf, ledgerDays: idx.dates.length + 1,
    tier: caps.tier, metaBackend: caps.metaBackend,
    cohorts: Object.fromEntries(S.FROZEN.horizons.map((h) => [h, horizons[h].cohortSize])),
    fetchFailures: failures.length,
    ...(dayExists ? { recovered: 'day doc already existed — re-indexed, not overwritten' } : {}),
  });
}

// ── op=forecastshadowresolve : resolve one matured, unresolved ledger day ───
async function runForecastShadowResolve(req, res) {
  noStore(res);
  if (!STORE.hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  let idx;
  try { idx = await readIndexChecked(); }
  catch (e) { return res.status(502).json({ ok: false, error: `ledger index unreadable — nothing resolved: ${errText(e)}` }); }
  const resolvedSet = new Set(idx.resolved || []);
  const cutoff = new Date(Date.now() - RESOLVE_AFTER_CALENDAR_DAYS * 864e5).toISOString().slice(0, 10);
  const target = idx.dates.find((d) => !resolvedSet.has(d) && d <= cutoff);
  if (!target) return res.status(200).json({ ok: true, resolved: null, note: 'no matured unresolved ledger day', ledgerDays: idx.dates.length, resolvedTotal: resolvedSet.size });

  const doc = await STORE.readJSON(dayKey(target), null);
  if (!doc) return res.status(502).json({ ok: false, error: `ledger day ${target} listed in the index but unreadable — refusing to mark it resolved` });

  let spy;
  try { spy = await fetchDailyHistory('SPY', '6mo'); } catch { spy = null; }
  if (!spy || !Array.isArray(spy.candles) || !spy.candles.length) {
    return res.status(502).json({ ok: false, error: 'SPY history unavailable — resolution postponed, nothing marked' });
  }
  const spyIdxMap = dateIndexOf(spy.candles);
  const spyIdx = spyIdxMap.get(target);
  if (spyIdx == null) return res.status(502).json({ ok: false, error: `SPY series has no ${target} bar — cannot anchor the decision date; nothing marked` });

  const attempts = ((idx.attempts || {})[target] || 0) + 1;
  const ageDays = Math.floor((Date.now() - Date.parse(target + 'T00:00:00Z')) / 864e5);
  const postpone = async (note, countAttempt = true) => {
    if (countAttempt) await STORE.writeJSON(INDEX_KEY, { ...idx, attempts: { ...(idx.attempts || {}), [target]: attempts } }, 0);
    return res.status(200).json({ ok: true, resolved: null, note, attempt: countAttempt ? attempts : undefined, ledgerDays: idx.dates.length, resolvedTotal: resolvedSet.size });
  };

  // Maturity is the BENCHMARK's clock: every horizon window must be observable on SPY's
  // own axis before any name is scored (no partial-horizon resolves).
  if (spyIdx + 1 + MAX_HORIZON > spy.candles.length - 1) {
    return postpone(`day ${target}: the ${MAX_HORIZON}-session window has not fully elapsed on the benchmark axis — postponed`, false);
  }

  const anyH = S.FROZEN.horizons[0];
  const shardRowsAny = (doc.horizons && doc.horizons[anyH] && doc.horizons[anyH].rows) || [];
  if (!shardRowsAny.length) return res.status(502).json({ ok: false, error: `ledger day ${target} carries no rows — refusing to mark it resolved` });
  const tickers = [...new Set(shardRowsAny.map((r) => r.ticker))];
  const etfs = [...new Set(shardRowsAny.map((r) => r.sectorEtf).filter(Boolean))];

  const failures = [];
  const etfSeries = await fetchSeries(etfs, '6mo', failures);
  const nameSeries = await fetchSeries(tickers, '6mo', failures);
  if (failures.length > 0 && attempts < RESOLVE_MAX_FETCH_ATTEMPTS && ageDays <= RESOLVE_MAX_AGE_DAYS) {
    return postpone(`day ${target}: ${failures.length} fetch failure(s) — postponed (attempt ${attempts}/${RESOLVE_MAX_FETCH_ATTEMPTS})`);
  }

  const etfIdxMaps = new Map([...etfSeries].map(([t, c]) => [t, dateIndexOf(c)]));
  const nameIdxMaps = new Map([...nameSeries].map(([t, c]) => [t, dateIndexOf(c)]));

  const perHorizon = {};
  for (const h of S.FROZEN.horizons) {
    const hDoc = doc.horizons && doc.horizons[h];
    const shardRows = (hDoc && hDoc.rows) || [];
    const outcomes = new Map();
    for (const r of shardRows) {
      const candles = nameSeries.get(r.ticker);
      if (!candles) { outcomes.set(r.ticker, { residual: null, raw: null, reason: 'fetch-failed' }); continue; }
      const nIdx = nameIdxMaps.get(r.ticker).get(target);
      if (nIdx == null) { outcomes.set(r.ticker, { residual: null, raw: null, reason: 'no-decision-bar' }); continue; }
      const secCandles = r.sectorEtf ? etfSeries.get(r.sectorEtf) : null;
      const secIdx = secCandles ? etfIdxMaps.get(r.sectorEtf).get(target) : null;
      outcomes.set(r.ticker, S.residualOutcome({
        candles, idx: nIdx, h,
        bench: spy.candles, benchIdx: spyIdx,
        sector: secCandles || null, sectorIdx: secIdx != null ? secIdx : null,
        betas: { betaMarket: r.betaMarket, betaSector: r.betaSector, betaSectorMarket: r.betaSectorMarket },
      }));
    }
    perHorizon[h] = S.resolveHorizon(shardRows, outcomes, hDoc && hDoc.book);
  }

  await STORE.writeJSON(dayKey(target), {
    ...doc,
    resolved: { at: new Date().toISOString(), attempts, fetchFailures: failures.length, perHorizon },
  }, 0);

  const agg = { ...(idx.aggregate || {}), perHorizon: { ...((idx.aggregate || {}).perHorizon || {}) } };
  for (const h of S.FROZEN.horizons) {
    const prev = agg.perHorizon[h] || { resolvedDates: 0, sumPrimaryIC: 0, sumXsIC: 0 };
    const r = perHorizon[h];
    // The gate counter advances ONLY when the date produced a usable primary IC; empty
    // or unresolvable-only days close out but never dilute the frozen gate.
    agg.perHorizon[h] = r.primaryIC == null ? prev : {
      resolvedDates: prev.resolvedDates + 1,
      sumPrimaryIC: +(prev.sumPrimaryIC + r.primaryIC).toFixed(8),
      sumXsIC: +(prev.sumXsIC + (r.xsIC == null ? 0 : r.xsIC)).toFixed(8),
    };
  }
  const nextAttempts = { ...(idx.attempts || {}) };
  delete nextAttempts[target];
  await STORE.writeJSON(INDEX_KEY, { ...idx, resolved: [...(idx.resolved || []), target], attempts: nextAttempts, aggregate: agg }, 0);

  return res.status(200).json({
    ok: true, resolved: target,
    perHorizon: Object.fromEntries(S.FROZEN.horizons.map((h) => [h, {
      primaryIC: perHorizon[h].primaryIC, xsIC: perHorizon[h].xsIC,
      scored: perHorizon[h].scored, coverage: perHorizon[h].coverage,
    }])),
    fetchFailures: failures.length,
    resolvedTotal: resolvedSet.size + 1,
  });
}

module.exports = { runForecastShadow, runForecastShadowTick, runForecastShadowResolve, readIndexChecked, INDEX_KEY, dayKey, CFG_OVERRIDES };

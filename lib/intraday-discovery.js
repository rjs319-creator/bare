'use strict';
// BROAD INTRADAY DISCOVERY (Stage A) — a cheap full-liquid-universe anomaly scan that can
// surface a stock BEGINNING to accelerate during the session, including names absent from
// the premarket / daily shortlists, BEFORE the daily scans' +2% "building" floor.
//
// Pipeline per scan:
//   liquid universe (curated cap-band lists ∪ free expanded universe, liquidity-gated on
//   cached daily baselines) → ONE bulk-quote snapshot (lib/quote-provider, few requests)
//   → per-name interval return since the PREVIOUS scan, standardized by that name's own
//   per-minute volatility (EWMA) → one-sided CUSUM change detector → ranked anomalies.
//
// The CUSUM statistic accumulates standardized positive drift: S ← max(0, S + z − k), alarm
// at S ≥ h. A liquid name grinding up unusually fast on participation alarms in minutes —
// with NO minimum day-% floor, which is exactly how it beats the +2% Building threshold.
//
// STATE + CADENCE (honest): interval returns need a prior snapshot, so state persists in
// Blob between scans. There is NO intraday cron on this deployment — scans run when
// op=discover is invoked (the Day Trade page triggers it on its 60s refresh; the CDN
// coalesces concurrent viewers). With nobody on the page, discovery idles and says so;
// we do not pretend a background scanner exists.
//
// Everything found here is DISCOVERY ONLY: anomalies enter the shared lifecycle pool as
// WATCH/BUILDING candidates and must pass the SAME canonical Stage-2 live validation as
// every other candidate before any actionable state. No probability language.

const { readJSON, writeJSON, hasStore } = require('./store');
const { fetchBulkQuotes } = require('./quote-provider');
const CFG = require('./daytrade-config');

const STATE_KEY = 'lifecycle/daytrade/discovery-state.json';
const RESULT_KEY = 'lifecycle/daytrade/discovery-latest.json';
const logKey = date => `lifecycle/daytrade/discovery/${date}.json`;
const FEATURE_VERSION = 'discovery-v1';

// ── Universe + per-name daily baselines (prevClose / avgVol / avg$vol / ATR) ─────
// Built from the existing daily candle caches (one Blob read per scope) and kept as a
// compact per-day doc so repeated scans don't re-decode megabytes of candles.
const BASELINE_KEY = date => `lifecycle/daytrade/discovery-baseline-${date}.json`;

function baselineFromCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 20) return null;
  const last20 = candles.slice(-20);
  const avgVol = last20.reduce((s, c) => s + (c.volume || 0), 0) / last20.length;
  const lastBar = candles[candles.length - 1];
  const prevClose = lastBar.close;
  let atr = 0, cnt = 0;
  for (let i = Math.max(1, candles.length - 14); i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    atr += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)); cnt++;
  }
  atr = cnt ? atr / cnt : 0;
  return {
    prevClose: +prevClose.toFixed(4),
    avgVol: Math.round(avgVol),
    avgDollarVol: Math.round(avgVol * prevClose),
    atr: +atr.toFixed(4),
    barDate: lastBar.date,
  };
}

async function buildBaselines(date) {
  const { loadCandleCache, cacheGet } = require('./candle-cache');
  const { LARGE, SMALL_CAPS, MICRO_CAPS, SECTOR_OF } = require('./universe');
  const D = CFG.DISCOVERY;
  const scopes = ['large', 'small', 'micro', 'expanded'];
  const docs = await Promise.all(scopes.map(s => loadCandleCache(s).catch(() => null)));
  const byTicker = {};
  const capBand = [...new Set([...LARGE, ...SMALL_CAPS, ...MICRO_CAPS])];
  for (const doc of docs) {
    if (!doc || !doc.data) continue;
    for (const t of Object.keys(doc.data)) {
      if (byTicker[t]) continue;
      const entry = cacheGet(doc, t);
      const b = entry ? baselineFromCandles(entry.candles) : null;
      if (!b) continue;
      if (b.prevClose < D.MIN_PRICE || b.avgDollarVol < D.MIN_AVG_DOLLAR_VOL) continue;   // liquidity/data-quality gate
      byTicker[t] = { ...b, sector: SECTOR_OF[t] || null };
    }
  }
  // Keep curated names first if we must trim to the bulk-request bound.
  let tickers = Object.keys(byTicker);
  if (tickers.length > D.MAX_UNIVERSE) {
    const curated = new Set(capBand);
    tickers = [...tickers.filter(t => curated.has(t)), ...tickers.filter(t => !curated.has(t))].slice(0, D.MAX_UNIVERSE);
    const trimmed = {};
    for (const t of tickers) trimmed[t] = byTicker[t];
    return { date, byTicker: trimmed, universeTrimmed: true, n: tickers.length };
  }
  return { date, byTicker, universeTrimmed: false, n: tickers.length };
}

async function loadOrBuildBaselines(date) {
  if (hasStore()) {
    const cached = await readJSON(BASELINE_KEY(date), null).catch(() => null);
    if (cached && cached.byTicker && cached.n > 0) return cached;
  }
  const built = await buildBaselines(date);
  if (hasStore() && built.n > 0) {
    try { await writeJSON(BASELINE_KEY(date), built, 0); } catch { /* next scan rebuilds */ }
  }
  return built;
}

// ── CUSUM update (pure) ─────────────────────────────────────────────────────────
// prev = { lastPrice, lastTs, ewmaPmVol, cusum } (per-minute volatility in fractional
// return units). Returns the next state + the standardized interval statistic.
function cusumStep(prev, price, tsMs, { k, alpha } = {}) {
  const K = k ?? CFG.DISCOVERY.CUSUM_K;
  const A = alpha ?? CFG.DISCOVERY.EWMA_ALPHA;
  if (!prev || !(prev.lastPrice > 0) || !(tsMs > prev.lastTs)) {
    return { lastPrice: price, lastTs: tsMs, ewmaPmVol: prev ? prev.ewmaPmVol : null, cusum: prev ? prev.cusum : 0, z: null, intervalRet: null, elapsedMin: null };
  }
  const elapsedMin = Math.max(0.5, (tsMs - prev.lastTs) / 60000);
  const intervalRet = price / prev.lastPrice - 1;
  const perMinRet = intervalRet / elapsedMin;
  // Per-minute vol EWMA seeded on first observation; floor avoids z blowups on dead names.
  const seed = Math.abs(perMinRet) || 0.0004;
  const ewma = prev.ewmaPmVol == null ? Math.max(seed, 0.0004) : Math.max(0.0002, (1 - A) * prev.ewmaPmVol + A * Math.abs(perMinRet));
  const z = prev.ewmaPmVol != null ? perMinRet / prev.ewmaPmVol : 0;
  const cusum = Math.max(0, (prev.cusum || 0) + z - K);
  return { lastPrice: price, lastTs: tsMs, ewmaPmVol: ewma, cusum: +cusum.toFixed(3), z: +z.toFixed(2), intervalRet, elapsedMin: +elapsedMin.toFixed(1) };
}

// ── One discovery scan ──────────────────────────────────────────────────────────
async function runDiscoveryScan({ now = new Date() } = {}) {
  const { etDate } = require('./freshness');
  const { sessionOf, sessionBucketOf } = require('./lifecycle-eval');
  const D = CFG.DISCOVERY;
  const nowIso = now.toISOString();
  const date = etDate(now);
  const session = sessionOf(now);
  const sessionBucket = sessionBucketOf(now);
  const premarket = session === 'premarket';
  if (session !== 'regular' && !(premarket && D.PREMARKET.ENABLED)) {
    // `marketClosed: true` is a MACHINE-readable flag, not just a note string — the scan
    // runner's outcome classifier must distinguish "idle by design" from "scanned fine"
    // without parsing prose. This closes the false-success defect where an off-hours no-op
    // stamped lastSuccessAt and a scanner that only ever fired off-hours read healthy.
    return { ok: true, marketClosed: true, session, date, anomalies: [], scanned: 0, note: `Discovery scans run during regular hours${D.PREMARKET.ENABLED ? ' and premarket' : ''} only (session: ${session}).`, generatedAt: nowIso };
  }
  // Session-specific thresholds — premarket participation is NEVER normalized against
  // regular-hours distributions (thinner tape → stronger drift required, higher liquidity
  // floor, and the interval state resets on a session change below).
  const P = premarket
    ? { cusumH: D.PREMARKET.CUSUM_H, maxAnomalies: D.PREMARKET.MAX_ANOMALIES, minAvgDollarVol: D.PREMARKET.MIN_AVG_DOLLAR_VOL }
    : { cusumH: D.CUSUM_H, maxAnomalies: D.MAX_ANOMALIES, minAvgDollarVol: D.MIN_AVG_DOLLAR_VOL };

  const baselines = await loadOrBuildBaselines(date);
  const tickers = Object.keys(baselines.byTicker || {});
  if (!tickers.length) {
    // `noBaselines: true` — same reason as marketClosed above: the health classifier needs
    // a flag, not a string match, to tell "no baselines" apart from a generic failure.
    return { ok: false, noBaselines: true, session, date, anomalies: [], scanned: 0, note: 'No daily baselines available (candle caches empty or storage unconfigured) — discovery cannot scan honestly without them.', generatedAt: nowIso };
  }

  // Prior interval state (discarded when stale — a 3-hour-old snapshot would fabricate
  // huge "interval" returns). Also discarded on a SESSION CHANGE: a premarket CUSUM must
  // never seed the regular-hours detector (different volatility regime), and vice versa.
  let state = hasStore() ? await readJSON(STATE_KEY, null).catch(() => null) : null;
  const stateAgeMin = state && state.updatedAt ? (Date.parse(nowIso) - Date.parse(state.updatedAt)) / 60000 : Infinity;
  const stateFresh = isStateFresh(state, { date, session, nowIso });
  const prevBy = stateFresh ? (state.byTicker || {}) : {};

  const { rows, coverage } = await fetchBulkQuotes(['SPY', ...tickers]);
  const byRow = new Map(rows.map(r => [r.ticker, r]));
  const spyRow = byRow.get('SPY');
  const spyBase = spyRow && spyRow.prevClose > 0 ? spyRow.price / spyRow.prevClose - 1 : null;

  const nextState = {};
  const candidates = [];
  const universeRows = [];   // PIT cross-sectional dataset capture (every scanned ticker)
  for (const t of tickers) {
    const row = byRow.get(t);
    const base = baselines.byTicker[t];
    if (!row || !base || !(row.price > 0)) continue;
    if (premarket && base.avgDollarVol < P.minAvgDollarVol) continue;   // premarket liquidity floor
    const tsMs = row.asOf ? Date.parse(row.asOf) : Date.parse(nowIso);
    if (tsMs > Date.parse(nowIso) + CFG.FRESHNESS.MAX_FUTURE_SKEW_MS) continue;   // future-dated → drop
    const step = cusumStep(prevBy[t], row.price, tsMs);
    const alarmed = step.cusum >= P.cusumH;
    // First-alarm timestamp — the lead-time anchor. Carried while the alarm persists so a
    // later consumer can see HOW LONG AGO this name first tripped the change detector.
    const firstAlarmAt = alarmed ? ((prevBy[t] && prevBy[t].firstAlarmAt) || nowIso) : null;
    nextState[t] = { lastPrice: step.lastPrice, lastTs: step.lastTs, ewmaPmVol: step.ewmaPmVol, cusum: step.cusum, firstAlarmAt };
    const dayPct = base.prevClose > 0 ? (row.price / base.prevClose - 1) * 100 : null;
    const residualDayPct = dayPct != null && spyBase != null ? +(dayPct - spyBase * 100).toFixed(2) : null;
    const relVol = (row.dayVolume != null && base.avgVol > 0) ? +(row.dayVolume / base.avgVol).toFixed(2) : null;
    universeRows.push({
      ticker: t, last: row.price, prevClose: base.prevClose, atr: base.atr,
      dayPct: dayPct != null ? +dayPct.toFixed(2) : null, excessPct: residualDayPct, relVol,
      cusum: step.cusum, z: step.z, intervalRet: step.intervalRet != null ? +(step.intervalRet * 100).toFixed(2) : null,
      avgDollarVol: base.avgDollarVol, sector: base.sector, quoteAsOf: row.asOf || null,
    });
    if (alarmed && (dayPct == null || dayPct > -2)) {
      candidates.push({
        ticker: t, sector: base.sector,
        last: row.price, prevClose: base.prevClose, atr: base.atr,
        pctChange: dayPct != null ? +dayPct.toFixed(2) : null,
        excessPct: residualDayPct,
        relVol,
        cusum: step.cusum, z: step.z, intervalRet: step.intervalRet != null ? +(step.intervalRet * 100).toFixed(2) : null,
        elapsedMin: step.elapsedMin,
        quoteAsOf: row.asOf || null,
        discoveredAt: firstAlarmAt,
        discoveryAgeMin: firstAlarmAt ? +(((Date.parse(nowIso) - Date.parse(firstAlarmAt)) / 60000).toFixed(1)) : 0,
        sessionBucket,
        avgDollarVol: base.avgDollarVol,
        scan: 'discovery', source: 'discovery', tier: 'D',
        candidateDate: base.barDate, date,
        featureVersion: FEATURE_VERSION,
      });
    }
  }
  // ONE cross-sectional ranking: change-detector magnitude first, then residual day move.
  candidates.sort((a, b) => (b.cusum - a.cusum) || ((b.excessPct ?? -99) - (a.excessPct ?? -99)));
  const anomalies = candidates.slice(0, P.maxAnomalies);

  if (hasStore()) {
    try { await writeJSON(STATE_KEY, { date, session, updatedAt: nowIso, byTicker: nextState }, 0); } catch { /* next scan reseeds */ }
    try {
      await writeJSON(RESULT_KEY, { date, generatedAt: nowIso, session, anomalies, coverage, universe: baselines.n }, 0);
      // Append-only anomaly log for the day (grading + audit). Best effort.
      const log = await readJSON(logKey(date), { scans: [] }).catch(() => ({ scans: [] }));
      log.scans = [...(log.scans || []), { at: nowIso, anomalies: anomalies.map(a => ({ ticker: a.ticker, cusum: a.cusum, pctChange: a.pctChange, excessPct: a.excessPct, last: a.last })) }].slice(-120);
      await writeJSON(logKey(date), { date, scans: log.scans, updatedAt: nowIso }, 0);
    } catch { /* log is best-effort */ }
    // PIT cross-sectional dataset capture (full eligible universe, deterministic negative
    // sampling, positives-at-risk always kept). Write-once per 5-min bucket; labels attach
    // later from strictly-after bars (op=datasetgrade). Best effort — never blocks the scan.
    try {
      const ds = require('./intraday-dataset');
      const built = ds.buildScanRows(universeRows, { date, at: nowIso, sessionBucket });
      await ds.appendScanRows(date, built);
    } catch { /* dataset capture is best-effort */ }
  }

  return {
    ok: true, session, date, generatedAt: nowIso,
    scanned: tickers.length, universe: baselines.n, universeTrimmed: !!baselines.universeTrimmed,
    // `eligible` = names that actually cleared the per-scan gates (quote returned, baseline
    // present, liquidity floor). Distinct from `scanned` (attempted): a large scanned/eligible
    // gap is a coverage problem the health doc must be able to see per scan.
    eligible: universeRows.length,
    coverage,
    intervalStateFresh: stateFresh, intervalAgeMin: Number.isFinite(stateAgeMin) ? +stateAgeMin.toFixed(1) : null,
    anomalies,
    warming: !stateFresh,
    note: !stateFresh
      ? 'First scan of a fresh window — interval returns need a prior snapshot, so the change detector is warming up (anomalies appear from the next scan).'
      : null,
  };
}

// Read the latest persisted discovery result if it is recent enough to merge into the live
// Day Trade pool. Null when absent/stale — the pool then simply has no discovery lane.
async function loadRecentDiscovery({ now = new Date() } = {}) {
  if (!hasStore()) return null;
  const doc = await readJSON(RESULT_KEY, null).catch(() => null);
  if (!doc || !Array.isArray(doc.anomalies)) return null;
  const ageMin = (now.getTime() - Date.parse(doc.generatedAt || 0)) / 60000;
  if (!(ageMin <= CFG.DISCOVERY.RESULT_FRESH_MIN)) return null;
  const { etDate } = require('./freshness');
  if (doc.date !== etDate(now)) return null;
  return doc;
}

// Pure: is a persisted interval state usable for THIS scan? Same ET date, young enough, and
// the SAME SESSION — a premarket CUSUM must never seed the regular-hours detector.
function isStateFresh(state, { date, session, nowIso, staleMin = CFG.DISCOVERY.STATE_STALE_MIN } = {}) {
  if (!state || state.date !== date) return false;
  const ageMin = state.updatedAt ? (Date.parse(nowIso) - Date.parse(state.updatedAt)) / 60000 : Infinity;
  if (!(ageMin <= staleMin)) return false;
  return state.session == null || state.session === session;
}

// Pure MERGE of Stage-A anomalies into an existing candidate pool: a discovery observation
// on a ticker ALREADY in a daily scan annotates that pick (`p.discovery`) — the observation
// is never discarded. Returns the anomalies NOT already covered (the new-candidate lane).
// Mutates the picks in place (route-local objects, matching the route's idiom).
function mergeDiscoveryEvidence(picks, anomalies) {
  const byTicker = new Map((anomalies || []).map(a => [a.ticker, a]));
  for (const p of picks || []) {
    const a = p && byTicker.get(p.ticker);
    if (!a) continue;
    p.discovery = {
      cusum: a.cusum ?? null, z: a.z ?? null, intervalRet: a.intervalRet ?? null,
      quoteAsOf: a.quoteAsOf ?? null, discoveredAt: a.discoveredAt ?? null,
      discoveryAgeMin: a.discoveryAgeMin ?? null, sessionBucket: a.sessionBucket ?? null,
    };
  }
  const known = new Set((picks || []).map(p => p && p.ticker).filter(Boolean));
  return (anomalies || []).filter(a => !known.has(a.ticker));
}

// FRESHEST discovery for the CURRENT board cycle. The persisted doc (written by op=discover)
// is used when fresh; when it is absent/stale — the structural one-refresh delay — ONE scan
// runs INLINE, bounded by the caller's remaining time budget, so the board consumes the scan
// it just ran instead of waiting for the next refresh. `load`/`scan` injectable for tests.
async function loadOrRunDiscovery({ now = new Date(), t0 = Date.now(), deadline = 50000, minBudgetMs = CFG.DISCOVERY.INLINE_MIN_BUDGET_MS, load = loadRecentDiscovery, scan = runDiscoveryScan } = {}) {
  const doc = await load({ now }).catch(() => null);
  if (doc) return { doc, ranInline: false };
  const { sessionOf } = require('./lifecycle-eval');
  const session = sessionOf(now);
  const scannable = session === 'regular' || (session === 'premarket' && CFG.DISCOVERY.PREMARKET.ENABLED);
  if (!scannable) return { doc: null, ranInline: false, note: `session:${session}` };
  if (Date.now() - t0 > deadline - minBudgetMs) return { doc: null, ranInline: false, note: 'insufficient-time-budget' };
  const scanStartMs = Date.now();
  try {
    const out = await scan({ now });
    await recordPageScan(out, now, Date.now() - scanStartMs);
    return (out && out.ok && Array.isArray(out.anomalies))
      ? { doc: out, ranInline: true }
      : { doc: null, ranInline: true, note: (out && out.note) || 'inline-scan-failed' };
  } catch (e) {
    return { doc: null, ranInline: true, note: `inline-scan-error:${String((e && e.message) || e)}` };
  }
}

// Page-driven scans (op=discover, inline board scans) were INVISIBLE to scan health — the
// per-scan history only saw scheduler ticks, so "how much coverage did we really have?" was
// unanswerable in DEGRADED (request-driven) mode. Record them into the SAME per-scan history
// with source:'page'. History only: lastSuccessAt/lease belong to the scheduled path.
// AWAITED (not fire-and-forget) because a dangling promise dies at serverless freeze;
// best-effort via catch so a history hiccup never breaks the scan response.
async function recordPageScan(result, now, durationMs) {
  try {
    await require('./daytrade-scan-runner').recordScanObservation(result, { source: 'page', now, durationMs });
  } catch { /* history is diagnostics, never control flow */ }
}

// op=discover — run one scan (CDN-coalesced at ~45s so concurrent viewers share it).
async function runDiscover(req, res) {
  const now = new Date();
  const scanStartMs = Date.now();
  const out = await runDiscoveryScan({ now });
  await recordPageScan(out, now, Date.now() - scanStartMs);
  res.setHeader('Cache-Control', 's-maxage=45, stale-while-revalidate=45');
  return res.status(out.ok ? 200 : 503).json({
    ...out,
    honesty: 'Stage-A anomaly discovery only: CUSUM change detection on bulk quote snapshots (regular hours + premarket with session-specific thresholds; sessions never share a baseline). Anomalies are WATCH candidates that must pass the same canonical Stage-2 live validation as every other name before any actionable state. Cadence is request-driven (~60s while the Day Trade page is open; the once-daily cron cannot scan intraday) unless an external scheduler drives op=daytradescan — there is no background scanner otherwise, and coverage/provider capability is reported per scan, never assumed.',
  });
}

module.exports = {
  runDiscoveryScan, runDiscover, loadRecentDiscovery, loadOrRunDiscovery, cusumStep,
  isStateFresh, mergeDiscoveryEvidence,
  baselineFromCandles, buildBaselines, FEATURE_VERSION, STATE_KEY, RESULT_KEY,
};

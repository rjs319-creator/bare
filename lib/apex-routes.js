const { internalHeaders } = require('./auth');
// APEX/TRACK CORE ROUTE HANDLERS — the original heart of the app (track,
// scoreboard, apexlog, ghostlog, edge, vreversal, drift, recalibrate, research,
// exits, longshort, pead, backfill, model, narrative). Extracted from tracker.js.
const { fetchOptionsBaseline } = require('./options-baseline');
const { fetchQuarterlySeries } = require('./earnings');
const { COST_MODEL_VERSION, roundTripCostPct, tierForPick } = require('./costs');
const { PICKSCORE_VERSION, pointInTimeStrength, toPercentiles } = require('./pickscore');
const sectionscore = require('./sectionscore');
const { benchFor: sectorBenchFor } = require('./readthrough'); // GICS sector → SPDR sector ETF
const { CERN } = require('./cern');
const { LARGE: UNI_LARGE, SMALL_CAPS: UNI_SMALL, MICRO_CAPS: UNI_MICRO, SECTOR_OF } = require('./universe');
const { writeDay, readAllPicks, hasStore, writeApexDay, readAllApex, writeGhostDay, readAllGhost, readAllIgnition, readAllTone, readAllAttention, writeArchiveDay,
        readModel, writeModel, readNarrative, writeNarrative, readBackfill, writeBackfill,
        readResolved, writeResolved, readExits, writeExits, readLongShort, writeLongShort, readPead, writePead,
        readInsider, writeInsider, readFundamentals, writeFundShard, readCern, writeCern,
        writeEdgeDay, readAllEdge,
        readFade, writeFade, writeFadeDay, readAllFade, readAllFadeDays,
        readTrendEng, writeTrendEng, writeTrendDay, readAllTrendDays,
        readDaytradeEng, writeDaytradeEng, writeDaytradeDay, readAllDaytradeDays,
        readConfluenceEng, writeConfluenceEng, writeConfluenceDay, readAllConfluenceDays,
        writePredictDay, readAllPredictDays,
        writePredmktDay, readAllPredmktDays,
        readSharpEvents, writeSharpEvents,
        writeBriefDay, readAllBriefDays,
        readNotifyFeed, writeNotifyFeed,
        writeCStudyDay, readAllCStudyDays,
        readAllGapDays, readAllReadThroughDays, readAllAnomalyDays, readAllBiotechDays, readAllSecondWaveDays, readAllCrossAssetDays, readAllToneShiftDays,
        readAllDownDays, readAllGapDownDays, readAllCoilDays, readJSON, writeJSON, readDayCount } = require('./store');
const { computeAllocation } = require('./allocation');
const { fetchDailyHistory } = require('./screener');
const { buildMacroLookup } = require('./macro');
const { wilson, nowET } = require('./stats');
const { analyzeVReversal } = require('./vreversal');
const apex = require('./apex');
const ghost = require('./ghost');
const { recalibrate } = require('./recalibrate');
const { runBackfill } = require('./backfill');
const { runResearch } = require('./research');
const { runMoverStudy } = require('./moverstudy');
const { runExitStudy } = require('./exits');
const { runEmergingStudy } = require('./emerging');
const { runLongShort } = require('./longshort');
const { runPEAD, runReactionPEAD } = require('./pead');
const { resolveTrade, MAX_HOLD } = require('./outcome');

const BASE_VERSION = 'v2026.Q2';

const HOST = process.env.WARM_HOST || 'market-news-app-chi.vercel.app';

// ── op=track : log today's Screener + Momentum picks ───────────────────────
async function getJSON(path) {
  const r = await fetch('https://' + HOST + path, { headers: internalHeaders() });
  if (!r.ok) throw new Error(path + ' -> ' + r.status);
  return r.json();
}

// Pure decision for whether a daily-ledger overwrite is safe. A clean run (no
// data-source threw) always writes — even an honestly-empty quiet day. When a
// source failed, refuse to write an empty snapshot, and refuse to SHRINK an
// existing complete day. existingCount = -1 means "no/unknown existing file".
function ledgerWriteDecision(newCount, sourceErrors, existingCount) {
  if (!sourceErrors) return { write: true };
  if (newCount === 0) return { write: false, reason: 'degraded-empty' };
  if (existingCount > newCount) return { write: false, reason: 'degraded-shrink', existing: existingCount };
  return { write: true };
}

// Guard a daily-ledger overwrite against a DEGRADED run clobbering a complete day.
// Only reads the existing day (a Blob round-trip) when the run is both degraded and
// non-empty. Prefixes: 'picks/', 'apex/', 'ghost/'.
async function safeToWrite(prefix, date, newCount, sourceErrors) {
  if (!sourceErrors) return { write: true };
  if (newCount === 0) return ledgerWriteDecision(0, sourceErrors, -1);
  const existing = await readDayCount(prefix, date);
  return ledgerWriteDecision(newCount, sourceErrors, existing);
}


async function runTrack(req, res) {
  if (!hasStore()) {
    return res.status(200).json({ ok: false, error: 'Blob storage not configured (create a Vercel Blob store).', count: 0 });
  }
  const { date, isMarketClosed } = nowET();
  // Skip weekends/holidays so we don't log a stale-priced cohort for a closed session.
  if (isMarketClosed && req.query.force !== '1') {
    return res.status(200).json({ ok: true, skipped: 'market-closed', date, count: 0 });
  }

  const ts = Date.now();
  const picks = [];
  const seen = new Set();
  const add = rec => {
    const key = `${rec.section}:${rec.tier}:${rec.scope || ''}:${rec.ticker}`;
    if (seen.has(key)) return;
    seen.add(key);
    picks.push(rec);
  };

  let sourceErrors = 0;
  for (const scope of ['large', 'small', 'micro']) {
    try {
      const d = await getJSON('/api/screener?scope=' + scope + (scope === 'large' ? '&lookback=1M' : ''));
      (d.results || []).forEach(r => {
        if (!r.ticker || !r.status || r.price == null) return;
        add({ date, ts, ticker: r.ticker, company: r.company || null, section: 'screener', tier: r.status, scope, entry: r.price, signalVersion: 'screener-v1' });
      });
    } catch { sourceErrors++; /* scope failed — skip */ }
  }
  try {
    const d = await getJSON('/api/momentum');
    (d.strongBuys || []).forEach(c => c.price != null &&
      add({ date, ts, ticker: c.ticker, company: c.company || null, section: 'momentum', tier: 'StrongBuy', scope: null, entry: c.price, signalVersion: 'momentum-v1' }));
    (d.strongSells || []).forEach(c => c.price != null &&
      add({ date, ts, ticker: c.ticker, company: c.company || null, section: 'momentum', tier: 'StrongSell', scope: null, entry: c.price, signalVersion: 'momentum-v1' }));
  } catch { sourceErrors++; /* momentum failed — skip */ }

  // Lock in the S&P 500's level on the snapshot day — a permanent audit anchor for
  // the market benchmark (the excess calc reconstructs SPY point-in-time regardless).
  let sp500 = null;
  try {
    const spy = await fetchDailyHistory('SPY');
    const c = spy && spy.candles;
    if (c && c.length) sp500 = c[c.length - 1].close;
  } catch { /* benchmark level is best-effort */ }

  // Don't let a degraded run (a scope/momentum fetch threw) clobber a complete day.
  const guard = await safeToWrite('picks/', date, picks.length, sourceErrors);
  if (!guard.write) {
    return res.status(200).json({ ok: true, skipped: guard.reason, degraded: true, date, count: picks.length, existing: guard.existing, sourceErrors });
  }

  let url = null, err = null;
  try { const r = await writeDay(date, picks, sp500); url = r.url; } catch (e) { err = String(e && e.message || e); }
  return res.status(err ? 502 : 200).json({ ok: !err, date, count: picks.length, sp500, url, error: err, sourceErrors, at: new Date().toISOString() });
}

// ── op=scoreboard : realized forward returns per section / tier ─────────────
// label → trading days. The 1/5/10/20-day set is the primary "beats-the-market"
// window (Step 1); the 1m/3m horizons are kept for the longer-drift view.
const HORIZONS = [['1d', 1], ['5d', 5], ['10d', 10], ['20d', 20], ['1m', 21], ['3m', 63]];
const BIG_WIN_PCTS = [10, 20]; // favorable-excursion thresholds (%) for "big winner" rates

function forwardReturn(candles, pick, bars) {
  let idx = -1;
  for (let k = 0; k < candles.length; k++) { if (candles[k].date <= pick.date) idx = k; else break; }
  if (idx < 0) return null;
  const tgt = idx + bars;
  if (tgt >= candles.length) return null; // horizon hasn't elapsed yet
  const entry = pick.entry || candles[idx].close;
  if (!entry) return null;
  let ret = ((candles[tgt].close - entry) / entry) * 100;
  if (pick.tier === 'StrongSell' || pick.short) ret = -ret; // short: positive = profitable
  return ret;
}

// Like forwardReturn, but also walks the holding path to capture the Maximum
// Favorable Excursion (MFE) — the best unrealized run-up while the signal was
// open — direction-aware: a long's MFE is its highest high vs entry, a short's
// is its lowest low vs entry. Returns null until the full horizon elapses, so
// the big-winner stats share the exact same sample n as the close-to-close ones.
function forwardPath(candles, pick, bars) {
  let idx = -1;
  for (let k = 0; k < candles.length; k++) { if (candles[k].date <= pick.date) idx = k; else break; }
  if (idx < 0) return null;
  const tgt = idx + bars;
  if (tgt >= candles.length) return null; // horizon hasn't elapsed yet
  const entry = pick.entry || candles[idx].close;
  if (!entry) return null;
  const isShort = pick.tier === 'StrongSell' || pick.short;
  let ret = ((candles[tgt].close - entry) / entry) * 100;
  if (isShort) ret = -ret;
  // Walk the intra-hold path once for BOTH excursions: MFE = the best the trade ever
  // ran in your favor before the horizon; MAE = the worst it was ever underwater. Both
  // are reported as POSITIVE magnitudes and are direction-aware (a short's favorable
  // move is a fall, its adverse move is a rally). MAE is the honest "how much heat did
  // you take to earn this?" — the pain a flat average return hides.
  let mfe = 0, mae = 0;
  for (let k = idx + 1; k <= tgt; k++) {
    const c = candles[k];
    const hi = c.high != null ? c.high : c.close;
    const lo = c.low != null ? c.low : c.close;
    const fav = isShort ? ((entry - lo) / entry) * 100 : ((hi - entry) / entry) * 100;
    const adv = isShort ? ((hi - entry) / entry) * 100 : ((entry - lo) / entry) * 100;
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;
  }
  return { ret, mfe, mae };
}

// REALISTIC-ENTRY forward return (entry-v1). The close-based measures above enter at
// the SIGNAL DAY's close — but an EOD screen is COMPUTED from that close, so it can't
// actually be traded (same-bar look-ahead). The first achievable price is the NEXT
// session's OPEN. Entry = open[idx+1]; the exit is held at the SAME close[idx+bars] as
// the close-based measure, so (real − closeBased) is a clean entry-timing DRAG — the
// overnight gap you pay to get in. Only meaningful for picks WITHOUT a logged entry
// (those already reflect an intended tradeable price); the caller gates on !pick.entry.
const ENTRY_MODEL_VERSION = 'entry-v1';
function nextOpenReturn(candles, pick, bars) {
  let idx = -1;
  for (let k = 0; k < candles.length; k++) { if (candles[k].date <= pick.date) idx = k; else break; }
  if (idx < 0) return null;
  const entryBar = candles[idx + 1];
  const tgt = idx + bars;
  if (!entryBar || tgt >= candles.length) return null; // no next bar, or horizon not elapsed
  const entry = (entryBar.open != null && entryBar.open > 0) ? entryBar.open : entryBar.close;
  if (!entry) return null;
  let ret = ((candles[tgt].close - entry) / entry) * 100;
  if (pick.tier === 'StrongSell' || pick.short) ret = -ret; // short: positive = profitable
  return +ret.toFixed(2);
}

// The S&P 500's raw forward return over the SAME window a pick is measured on,
// anchored to the pick's trigger date. Subtracting this from a pick's own forward
// return gives the "excess" — did the signal actually beat the market? Point-in-
// time from SPY history, so no future data is stored; it fills in as days elapse.
function spyForwardReturn(spyCandles, pick, bars) {
  if (!Array.isArray(spyCandles) || !spyCandles.length) return null;
  let idx = -1;
  for (let k = 0; k < spyCandles.length; k++) { if (spyCandles[k].date <= pick.date) idx = k; else break; }
  if (idx < 0) return null;
  const tgt = idx + bars;
  if (tgt >= spyCandles.length) return null; // horizon hasn't elapsed yet
  const start = spyCandles[idx].close;
  if (!start) return null;
  return ((spyCandles[tgt].close - start) / start) * 100;
}

// Map a CERN engine state into Scoreboard picks — the counterfactual archive:
// EVERY logged forced-flow event (ledger + resolved archive), traded or not,
// deduped to its first appearance per event-type:symbol so a name that lingers
// in the ledger isn't over-counted. CERN direction -1 = buy-the-reversion (long);
// +1 = fade the forced buying (short, so its forward return is inverted).
function cernPicksFrom(cernState) {
  if (!cernState || typeof cernState !== 'object') return [];
  const entries = [
    ...(Array.isArray(cernState.ledger) ? cernState.ledger : []),
    ...(Array.isArray(cernState.archive) ? cernState.archive : []),
  ].filter(e => e && e.type && e.symbol && e.dateMs);
  entries.sort((a, b) => a.dateMs - b.dateMs); // earliest first → first-appearance dedup
  const seen = new Map();
  for (const ev of entries) {
    const key = `${ev.type}:${ev.symbol}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      section: 'CERN',
      tier: ev.type,
      ticker: ev.symbol,
      date: new Date(ev.dateMs).toISOString().slice(0, 10),
      entry: (ev.signal && ev.signal.entryPrice) || null, // null → forwardReturn uses close at event date
      short: ev.direction === 1,
    });
  }
  return [...seen.values()];
}

// Flatten the fade day-ledger ([{date, signals:[...]}]) into Scoreboard short rows.
// Only ACTIONABLE recommendations (SHORT / SHORT_LIGHT) are tracked — WATCH/SKIP
// setups were logged for analysis but were never a trade. tier = the action so the
// board splits by conviction; short:true so forwardReturn inverts (gain = name fell).
function fadeRowsFrom(fadeDays) {
  if (!Array.isArray(fadeDays)) return [];
  return fadeDays.flatMap(d => (Array.isArray(d && d.signals) ? d.signals : [])
    .filter(s => s && s.ticker && (s.action === 'SHORT' || s.action === 'SHORT_LIGHT'))
    .map(s => ({ date: s.date || d.date, ticker: s.ticker, entry: s.entry != null ? s.entry : null, tier: s.action, short: true })));
}

// arr = forwardPath results [{ ret, mfe }]. Beyond the existing expectancy/win
// figures it now reports "big winner" reach: avg MFE plus the share of signals
// whose best run-up crossed +10% / +20% before the horizon — measuring which
// models catch large moves vs. which only grind out small averages.
function summarizeReturns(arr) {
  if (!arr.length) return null;
  const n = arr.length;
  const sum = a => a.reduce((s, b) => s + b, 0);
  const rets = arr.map(x => x.ret);
  const mfes = arr.map(x => x.mfe);
  // Max ADVERSE excursion — the worst intra-hold drawdown per pick (positive magnitude).
  // Self-reports its own n so older path-less records simply fall out.
  const maes = arr.map(x => x.mae).filter(x => x != null && Number.isFinite(x));
  const avgMaeVal = maes.length ? sum(maes) / maes.length : null;
  const avgMfeVal = sum(mfes) / n;
  const wins = rets.filter(x => x > 0);
  const losses = rets.filter(x => x <= 0);
  const avgWin = wins.length ? sum(wins) / wins.length : 0;
  const avgLoss = losses.length ? sum(losses) / losses.length : 0;
  // Excess vs the S&P over the same window (may be absent on older records that
  // predate the benchmark wiring — count only the ones that have it).
  const excs = arr.map(x => x.exc).filter(x => x != null && Number.isFinite(x));
  const beat = excs.filter(x => x > 0).length;
  // NET-OF-COST track record (cost-v1): the same returns after a versioned
  // round-trip spread+slippage haircut. Additive — gross fields above are
  // untouched. Records predating the cost wiring simply have no net field and
  // are skipped, so the net sample self-reports its own n.
  const nets = arr.map(x => x.net).filter(x => x != null && Number.isFinite(x));
  const netExcs = arr.map(x => x.netExc).filter(x => x != null && Number.isFinite(x));
  const netBeat = netExcs.filter(x => x > 0).length;
  // Sector-relative excess vs the pick's sector ETF — isolates selection skill from
  // sector beta. Self-reports its own n (records with a resolvable sector ETF).
  const secExcs = arr.map(x => x.secExc).filter(x => x != null && Number.isFinite(x));
  const secBeat = secExcs.filter(x => x > 0).length;
  // Realistic next-open entry — the achievable-entry return + the entry-timing drag
  // vs the (un-tradeable) signal-day close. Only present on no-logged-entry records.
  const reals = arr.map(x => x.real).filter(x => x != null && Number.isFinite(x));
  const gaps = arr.map(x => x.gap).filter(x => x != null && Number.isFinite(x));
  // Distribution stats (#4): median resists the fat outlier tail that pumps a mean;
  // a 10% trimmed mean shows the return once the extremes are removed; a 90% CI on
  // the mean flags whether the average is distinguishable from zero at this sample.
  const sorted = rets.slice().sort((a, b) => a - b);
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const trim = Math.floor(n * 0.1);
  const trimmed = n >= 5 ? sorted.slice(trim, n - trim) : sorted;
  const trimmedAvg = trimmed.length ? sum(trimmed) / trimmed.length : median;
  // Robustness (#4 "results excluding the largest winners"): drop the top ~10% (min 1)
  // BIGGEST winners and recompute the mean. If the edge collapses toward/below zero, it
  // was a few lottery winners, not a repeatable process. Asymmetric — trims only the top.
  const dropTop = n >= 5 ? Math.max(1, Math.floor(n * 0.1)) : 0;
  const exWinners = dropTop ? sorted.slice(0, n - dropTop) : sorted; // ascending → removes the top winners
  const avgExTopWinners = exWinners.length ? sum(exWinners) / exWinners.length : median;
  const avg = sum(rets) / n;
  const sd = n > 1 ? Math.sqrt(rets.reduce((s, x) => s + (x - avg) ** 2, 0) / (n - 1)) : 0;
  const se = n > 1 ? sd / Math.sqrt(n) : 0;
  return {
    n,
    avg: +avg.toFixed(2),
    median: +median.toFixed(2),
    trimmedAvg: +trimmedAvg.toFixed(2),
    avgExTopWinners: +avgExTopWinners.toFixed(2),
    exTopN: dropTop,
    avgCI: n > 2 ? { lo: +(avg - 1.645 * se).toFixed(2), hi: +(avg + 1.645 * se).toFixed(2), level: 90 } : null,
    winRate: +((wins.length / n) * 100).toFixed(0),
    avgWin: +avgWin.toFixed(2),
    avgLoss: +avgLoss.toFixed(2),
    avgMfe: +avgMfeVal.toFixed(2),
    big10: +((mfes.filter(m => m >= BIG_WIN_PCTS[0]).length / n) * 100).toFixed(0),
    big20: +((mfes.filter(m => m >= BIG_WIN_PCTS[1]).length / n) * 100).toFixed(0),
    // Max adverse excursion (#4): the heat taken on the way to the result. avgMae is the
    // typical worst drawdown; excursionRatio = avg favorable reach ÷ avg adverse reach
    // (>1 = the path ran in your favor more than against before the horizon).
    maeN: maes.length,
    avgMae: avgMaeVal != null ? +avgMaeVal.toFixed(2) : null,
    excursionRatio: (avgMaeVal != null && avgMaeVal > 0) ? +(avgMfeVal / avgMaeVal).toFixed(2) : null,
    // Market-relative track record — the Step-1 headline: does this signal beat the S&P?
    excessN: excs.length,
    avgExcess: excs.length ? +(sum(excs) / excs.length).toFixed(2) : null,
    beatMktRate: excs.length ? +((beat / excs.length) * 100).toFixed(0) : null,
    // Cost-adjusted headline — does the edge survive real friction?
    netN: nets.length,
    avgNet: nets.length ? +(sum(nets) / nets.length).toFixed(2) : null,
    netWinRate: nets.length ? +((nets.filter(x => x > 0).length / nets.length) * 100).toFixed(0) : null,
    avgNetExcess: netExcs.length ? +(sum(netExcs) / netExcs.length).toFixed(2) : null,
    netBeatMktRate: netExcs.length ? +((netBeat / netExcs.length) * 100).toFixed(0) : null,
    costModel: COST_MODEL_VERSION,
    // Sector-relative headline — does it beat its SECTOR, not just the market?
    secExcN: secExcs.length,
    avgSecExcess: secExcs.length ? +(sum(secExcs) / secExcs.length).toFixed(2) : null,
    beatSecRate: secExcs.length ? +((secBeat / secExcs.length) * 100).toFixed(0) : null,
    // Realistic-entry headline — what you'd actually get entering the next open, and
    // how much the signal-day close flattered it (avgEntryDrag < 0 = close was optimistic).
    realN: reals.length,
    avgReal: reals.length ? +(sum(reals) / reals.length).toFixed(2) : null,
    realWinRate: reals.length ? +((reals.filter(x => x > 0).length / reals.length) * 100).toFixed(0) : null,
    avgEntryDrag: gaps.length ? +(sum(gaps) / gaps.length).toFixed(2) : null,
    entryModel: ENTRY_MODEL_VERSION,
  };
}

// STRATEGY EFFICACY (as opposed to signal efficacy). summarizeReturns answers "did the
// stock move?" (close-to-close / excess). This answers the different question "could the
// PUBLISHED trade plan actually capture it?" — resolving each pick at its OWN logged
// entry/stop/target via resolveTrade: did price reach the target BEFORE the stop, over
// the ledger's hold window. targetFirstRate is the plan's real win rate; profitFactor is
// gross target-R over gross stop-R at the levels shown on the card. A signal can look
// great (big avg return) yet be un-capturable if the stop gets hit first — this exposes it.
function summarizePlans(plans) {
  if (!plans || !plans.length) return null;
  const n = plans.length;
  const wins = plans.filter(p => p.outcome === 'WIN').length;
  const losses = plans.filter(p => p.outcome === 'LOSS').length;
  const expired = plans.filter(p => p.outcome === 'EXPIRED').length;
  const rs = plans.map(p => (Number.isFinite(p.r) ? p.r : 0));
  const grossWin = rs.filter(r => r > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(rs.filter(r => r < 0).reduce((a, b) => a + b, 0));
  return {
    n,
    targetFirstRate: +((wins / n) * 100).toFixed(0),
    stopFirstRate: +((losses / n) * 100).toFixed(0),
    expiredRate: +((expired / n) * 100).toFixed(0),
    avgRpct: +((rs.reduce((a, b) => a + b, 0) / n) * 100).toFixed(2),
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? null : 0),
  };
}

// The two macro regimes we split the track record by. A pick's regime is the
// macro state (lib/macro.js: VIX percentile + HYG/LQD credit stress) as-of its
// trigger DATE — reconstructed point-in-time, so no schema change / re-logging is
// needed (same retroactive approach as the big-winner MFE metrics). 'neutral'
// picks count only in the unsplit "All" view, not in either regime bucket.
const REGIME_BUCKETS = ['risk-on', 'risk-off'];
function regimeBucketOf(macroState) {
  if (!macroState) return null;
  if (macroState.riskOn) return 'risk-on';
  if (macroState.riskOff) return 'risk-off';
  return null; // neutral
}

async function runScoreboard(req, res) {
  const rawPicks = await readAllPicks();
  const rawGhost = await readAllGhost();   // GAI-tier outcomes (GHOST / STALKING)
  const rawTone = await readAllTone().catch(() => []); // earnings-call tone (Bullish/Neutral/Bearish)
  const rawAttn = await readAllAttention().catch(() => []); // fast-vs-sticky attention (Sticky / Fast)
  const rawFadeDays = await readAllFadeDays().catch(() => []); // inverted-V SHORT setups, by day
  const rawFade = fadeRowsFrom(rawFadeDays);
  const cernState = await readCern().catch(() => null); // forced-flow event archive
  const cernPicks = cernPicksFrom(cernState); // per-event-type Scoreboard rows
  const rawRT = (await readAllReadThroughDays().catch(() => [])).flatMap(dd => (dd.picks || []).map(p => ({ ...p, section: 'ReadThrough' }))); // second-order beneficiaries (Fresh/Moved)
  const rawAnom = (await readAllAnomalyDays().catch(() => [])).flatMap(dd => (dd.picks || []).map(p => ({ ...p, section: 'Anomaly' }))); // no-news movers (Accumulation/Explained/Noise)
  const rawBio = (await readAllBiotechDays().catch(() => [])).flatMap(dd => (dd.picks || []).map(p => ({ ...p, section: 'Biotech' }))); // early biotech runners scored /100 (Hot/Emerging/Watch), benchmarked vs XBI
  const rawSW = (await readAllSecondWaveDays().catch(() => [])).flatMap(dd => (dd.picks || []).map(p => ({ ...p, section: 'SecondWave' }))); // first-leg movers (Primed/Early/Faded)
  const rawCA = (await readAllCrossAssetDays().catch(() => [])).flatMap(dd => (dd.picks || []).map(p => ({ ...p, section: 'CrossAsset' }))); // cross-asset leads (Lead/Inline/Weak)
  const rawTS = (await readAllToneShiftDays().catch(() => [])).flatMap(dd => (dd.picks || []).map(p => ({ ...p, section: 'ToneShift' }))); // earnings tone deltas (Brightening/Stable/Darkening)
  const rawDownDay = (await readAllDownDays().catch(() => [])).flatMap(dd => (dd.picks || []).map(p => ({ ...p, section: 'DownDay' }))); // oversold-bounce LONGS logged on red tapes (WATCH/EMERGING/CONFIRMED)
  const rawGapDown = (await readAllGapDownDays().catch(() => [])).flatMap(dd => (dd.picks || []).map(p => ({ ...p, section: 'GapDown' }))); // gap-down continuation SHORTS (short:true → inverted; STRONG/MODERATE)
  // Day-Trade ledger → a "daytrade" section (A / B tiers), all longs. Reconstructed by its
  // OWN scorer (daytrade.rankScore) in the score-decile validation. Record already carries entry/tier.
  const rawDaytrade = (await readAllDaytradeDays().catch(() => [])).flatMap(dd => (dd.picks || []).map(p => ({ ...p, date: p.date || dd.date, section: 'daytrade', tier: p.tier || 'A' })));
  // Coil ledger → a "coil" section (calibrated squeeze band as the tier), all longs.
  // entryPrice→entry; reconstructed by its OWN scorer (coil.scoreCohort).
  const rawCoil = (await readAllCoilDays().catch(() => [])).flatMap(dd => (dd.picks || []).map(p => ({ ...p, date: p.date || dd.date, section: 'coil', tier: p.band || (p.decile != null ? `D${p.decile}` : 'coil'), entry: p.entry != null ? p.entry : p.entryPrice })));
  const rawIgnition = await readAllIgnition().catch(() => []);   // Momentum Ignition picks (IGNITION/WATCH), already carry section/tier/date/entry
  if (!rawPicks.length && !rawGhost.length && !rawFade.length && !cernPicks.length && !rawTone.length && !rawAttn.length && !rawRT.length && !rawAnom.length && !rawBio.length && !rawSW.length && !rawCA.length && !rawTS.length && !rawDownDay.length && !rawGapDown.length && !rawDaytrade.length && !rawCoil.length && !rawIgnition.length) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ configured: hasStore(), totalPicks: 0, loggedRows: 0, groups: [], generatedAt: new Date().toISOString() });
  }

  // First-appearance only: earliest record per section:tier:ticker so a name that
  // stays listed for days isn't over-weighted. Raw daily log is left untouched.
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const firstSeen = new Map();
  for (const p of [...rawPicks].sort(byDate)) {
    const key = `${p.section}:${p.tier}:${p.ticker}`;
    if (!firstSeen.has(key)) firstSeen.set(key, p);
  }
  // Ghost ledger → its own "Ghost" section (GHOST/STALKING tiers); records carry
  // date/entry/tier already, so they flow through the same grouping + resolution.
  for (const p of [...rawGhost].sort(byDate)) {
    const key = `Ghost:${p.tier}:${p.ticker}`;
    if (!firstSeen.has(key)) firstSeen.set(key, { ...p, section: 'Ghost' });
  }
  // Momentum Ignition ledger → an "Ignition" section (IGNITION/WATCH tiers). LONGS with
  // date/entry/tier already set → same first-appearance dedup + EOD forward resolution.
  // The falsifiable test: do IGNITION-tier (accelerating) names beat WATCH and the market?
  for (const p of [...rawIgnition].sort(byDate)) {
    const key = `Ignition:${p.tier}:${p.ticker}`;
    if (p.tier && !firstSeen.has(key)) firstSeen.set(key, { ...p, section: 'Ignition' });
  }
  // Down-Day Mode ledger → a "DownDay" section (WATCH/EMERGING/CONFIRMED). Oversold-bounce
  // LONGS logged only on red tapes; date/entry/tier already present → same resolution. The
  // falsifiable test: do these red-day bounces beat SPY, and do the earlier (WATCH/EMERGING)
  // turns outperform CONFIRMED as the backtest predicted?
  for (const p of [...rawDownDay].sort(byDate)) {
    const key = `DownDay:${p.tier}:${p.ticker}`;
    if (p.tier && !firstSeen.has(key)) firstSeen.set(key, p);
  }
  // Gap-Down Continuation ledger → a "GapDown" section (STRONG/MODERATE). These are SHORTS
  // (short:true set at log time), so forwardReturn inverts — a win means the name fell. The
  // falsifiable test: do bigger gap-downs (STRONG) continue lower more than MODERATE?
  for (const p of [...rawGapDown].sort(byDate)) {
    const key = `GapDown:${p.tier}:${p.ticker}`;
    if (p.tier && !firstSeen.has(key)) firstSeen.set(key, p);
  }
  // Fade ledger → a "Fade" section (tiers SHORT / SHORT_LIGHT). These are SHORTS,
  // so short:true inverts forwardReturn (positive = the name fell = the fade paid).
  for (const p of [...rawFade].sort(byDate)) {
    const key = `Fade:${p.tier}:${p.ticker}`;
    if (!firstSeen.has(key)) firstSeen.set(key, { ...p, section: 'Fade' });
  }
  // CERN forced-flow events → a "CERN" section, one tier per event type. cernPicks
  // is already first-appearance-deduped and direction-tagged (short flag).
  for (const p of cernPicks) {
    const key = `${p.section}:${p.tier}:${p.ticker}`;
    if (!firstSeen.has(key)) firstSeen.set(key, p);
  }
  // Earnings-tone ledger → a "Tone" section (Bullish/Neutral/Bearish). All tracked
  // as longs (short:false) so the board shows whether bullish-toned calls actually
  // outperform bearish-toned ones — a falsifiable test of the tone signal.
  for (const p of [...rawTone].sort(byDate)) {
    const key = `Tone:${p.tier}:${p.ticker}`;
    if (p.tier && !firstSeen.has(key)) firstSeen.set(key, { ...p, section: 'Tone' });
  }
  // Attention ledger → an "Attention" section (Sticky / Fast). Both tracked as longs
  // so the board falsifies the thesis: sticky attention should outperform fast hype
  // (and fast hype should be the weaker / negative bucket = the caution).
  for (const p of [...rawAttn].sort(byDate)) {
    const key = `Attention:${p.tier}:${p.ticker}`;
    if (p.tier && !firstSeen.has(key)) firstSeen.set(key, { ...p, section: 'Attention' });
  }
  // Read-Through ledger → a "ReadThrough" section (tiers Fresh / Moved / Unknown). All
  // longs — the falsifiable test is whether the un-moved (Fresh) beneficiaries outperform
  // the already-moved (Moved / priced-in) ones. Excess is vs SPY like every other section
  // (sector-relative excess is the intended refinement).
  for (const p of [...rawRT].sort(byDate)) {
    const key = `ReadThrough:${p.tier}:${p.ticker}`;
    if (p.tier && !firstSeen.has(key)) firstSeen.set(key, p);
  }
  // Anomaly ledger → an "Anomaly" section (Accumulation / Explained / Noise). All longs —
  // the falsifiable test is whether the un-explained (Accumulation) movers actually beat
  // their sector, and beat the Explained/Noise buckets. Benchmarked vs sector ETF (p.bench).
  for (const p of [...rawAnom].sort(byDate)) {
    const key = `Anomaly:${p.tier}:${p.ticker}`;
    if (p.tier && !firstSeen.has(key)) firstSeen.set(key, p);
  }
  // Biotech Radar ledger → a "Biotech" section (Hot / Emerging / Watch score-tiers). All longs,
  // benchmarked vs XBI (p.bench). Falsifiable test of the /100 model: do HOT names actually
  // beat WATCH names AND beat the biotech index?
  for (const p of [...rawBio].sort(byDate)) {
    const key = `Biotech:${p.tier}:${p.ticker}`;
    if (p.tier && !firstSeen.has(key)) firstSeen.set(key, p);
  }
  // Second Wave ledger → a "SecondWave" section (Primed / Early / Faded), all longs,
  // sector-benchmarked. Test: do PRIMED first-leg movers get the reflexive second leg
  // (beat their sector) vs the Faded ones?
  for (const p of [...rawSW].sort(byDate)) {
    const key = `SecondWave:${p.tier}:${p.ticker}`;
    if (p.tier && !firstSeen.has(key)) firstSeen.set(key, p);
  }
  // Cross-Asset ledger → a "CrossAsset" section (Lead / Inline / Weak), all longs. Test:
  // do the LEAD names (still lagging the cross-asset tell) actually catch up (outperform)?
  for (const p of [...rawCA].sort(byDate)) {
    const key = `CrossAsset:${p.tier}:${p.ticker}`;
    if (p.tier && !firstSeen.has(key)) firstSeen.set(key, p);
  }
  // Tone Shift ledger → a "ToneShift" section (Brightening / Stable / Darkening), all longs,
  // sector-benchmarked. Test: do BRIGHTENING tone deltas actually beat the Darkening ones?
  for (const p of [...rawTS].sort(byDate)) {
    const key = `ToneShift:${p.tier}:${p.ticker}`;
    if (p.tier && !firstSeen.has(key)) firstSeen.set(key, p);
  }
  // Day-Trade ledger → "daytrade" section (A/B tiers, all longs; reconstructed by its own
  // scorer in the score-decile validation).
  for (const p of [...rawDaytrade].sort(byDate)) {
    const key = `daytrade:${p.tier}:${p.ticker}`;
    if (p.tier && !firstSeen.has(key)) firstSeen.set(key, p);
  }
  // Coil ledger → "coil" section (calibrated squeeze band as the tier, all longs;
  // reconstructed by its own scorer in the score-decile validation).
  for (const p of [...rawCoil].sort(byDate)) {
    const key = `coil:${p.tier}:${p.ticker}`;
    if (p.tier && !firstSeen.has(key)) firstSeen.set(key, p);
  }
  const picks = [...firstSeen.values()];

  const tickers = [...new Set(picks.map(p => p.ticker))];
  const hist = new Map();
  let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++];
      try { const d = await fetchDailyHistory(t); if (d) hist.set(t, d.candles); } catch { /* skip */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, tickers.length) }, worker));

  // Point-in-time macro regime per pick — the project's one validated lever is
  // regime conditioning (~2× IC), so we split every track record by the macro
  // state that was live at the trigger. Built once; degrades to no split if the
  // macro feeds are unavailable. Min span covers the oldest pick.
  const macroLookup = await buildMacroLookup('2y').catch(() => null);

  // The market benchmark: SPY's own history, fetched once. Every pick's forward
  // return is measured against SPY over the identical window → excess = beat market.
  const spyD = await fetchDailyHistory('SPY').catch(() => null);
  const spyCandles = spyD ? spyD.candles : null;

  // Sector-relative benchmark. Two uses:
  //  • `exc` (the existing headline): the 6 SECTOR_BENCH sections are measured vs their
  //    logged sector ETF (p.bench) — a read-through/anomaly claim is "beat your PEERS";
  //    every other section stays vs SPY. Unchanged, for backward-comparable history.
  //  • `secExc` (NEW, uniform): EVERY pick also gets a sector-relative excess vs its
  //    sector ETF — p.bench if it logged one, else the SPDR sector ETF derived from the
  //    ticker's GICS sector. This gives the CORE sleeves (Breakout/Momentum/Ghost/CERN/…)
  //    the sector adjustment they lacked, so sector beta stops masquerading as alpha.
  const SECTOR_BENCH = new Set(['ReadThrough', 'Anomaly', 'Biotech', 'SecondWave', 'CrossAsset', 'ToneShift']);
  const sectorEtfFor = p => p.bench || sectorBenchFor(SECTOR_OF[p.ticker]) || null;
  const benchTickers = [...new Set(picks.map(sectorEtfFor).filter(Boolean))];
  const benchHist = new Map();
  await Promise.all(benchTickers.map(async bt => {
    try { const d = await fetchDailyHistory(bt); if (d) benchHist.set(bt, d.candles); } catch { /* SPY fallback */ }
  }));

  // Long-only edge sleeves -> friendly names for the cross-sleeve allocation view.
  const LONG_SLEEVE = { screener: 'Breakout', momentum: 'Momentum', Ghost: 'Ghost', DownDay: 'DownDay' };
  const sleeveRecs = {};   // { sleeveName: [{date, ret(fraction)}] }
  const scoreItems = [];   // { raw, ret(20d), regime, section } → uniform score-decile validation
  // Use the 1-WEEK (5-session) horizon: it resolves fast (so the book fills in as the
  // ledger matures instead of waiting a month per pick) AND matches the Gap & Go sleeve's
  // ~3-session return, keeping the blended sleeves on a comparable horizon.
  const ALLOC_HK = '5d';
  // Horizon the uniform/per-section score-decile validation resolves on. Kept SHORT
  // (1-week) so it fills in fast and suits the fast screeners (day-trade, coil) as well
  // as the slower ones — a consistent board-wide yardstick, not each screener's own hold.
  const SCORE_HK = '5d';

  const groups = {};
  for (const p of picks) {
    const gkey = `${p.section}:${p.tier}`;
    const g = groups[gkey] || (groups[gkey] = { section: p.section, tier: p.tier, picks: 0, regPicks: {}, h: {}, reg: {}, liq: {}, sec: {} });
    g.picks++;
    const bucket = macroLookup ? regimeBucketOf(macroLookup.at(p.date)) : null;
    if (bucket) g.regPicks[bucket] = (g.regPicks[bucket] || 0) + 1;
    const candles = hist.get(p.ticker);
    if (!candles) continue;
    let retH = null;   // forward return at SCORE_HK — the horizon the score-decile check validates on
    for (const [hk, bars] of HORIZONS) {
      const r = forwardPath(candles, p, bars);
      if (r == null) continue;
      if (hk === SCORE_HK && Number.isFinite(r.ret)) retH = r.ret;
      // Benchmark-relative: pick's (direction-adjusted) return minus its benchmark's over
      // the same window. Read-Through uses its beneficiary's SECTOR ETF (p.bench) to strip
      // the sector move (beat your peers, not just the market); everything else uses SPY.
      // null when benchmark data is missing or the horizon hasn't elapsed.
      const benchCandles = (SECTOR_BENCH.has(p.section) && p.bench && benchHist.get(p.bench)) || spyCandles;
      const benchRet = spyForwardReturn(benchCandles, p, bars);
      r.exc = (benchRet == null || !Number.isFinite(r.ret)) ? null : +(r.ret - benchRet).toFixed(2);
      // NET of a versioned round-trip cost (spread + slippage), tiered by the
      // pick's liquidity. The benchmark is treated as a costless index baseline,
      // so the same haircut applies to raw and excess. Gross r.ret / r.exc stay
      // intact — this is purely additive.
      const rtCost = roundTripCostPct(tierForPick(p));
      r.net = Number.isFinite(r.ret) ? +(r.ret - rtCost).toFixed(2) : null;
      r.netExc = (r.exc == null) ? null : +(r.exc - rtCost).toFixed(2);
      // Uniform sector-relative excess: return minus the pick's SECTOR ETF over the
      // same window (its logged bench, else its GICS sector's SPDR ETF). null when the
      // sector is unknown or the ETF history is missing → falls out of the sector stats.
      const secEtf = sectorEtfFor(p);
      const secRet = secEtf ? spyForwardReturn(benchHist.get(secEtf), p, bars) : null;
      r.secExc = (secRet == null || !Number.isFinite(r.ret)) ? null : +(r.ret - secRet).toFixed(2);
      // Realistic next-open entry (entry-v1) — only for picks that had NO logged entry
      // (those were using the un-tradeable signal-day close). r.gap = the entry-timing
      // drag vs that close baseline. Picks with a real logged entry are left as-is.
      if (!p.entry) {
        const realRet = nextOpenReturn(candles, p, bars);
        r.real = realRet;
        r.gap = (realRet == null || !Number.isFinite(r.ret)) ? null : +(realRet - r.ret).toFixed(2);
      }
      (g.h[hk] = g.h[hk] || []).push(r);                     // "All Markets"
      if (bucket) ((g.reg[bucket] = g.reg[bucket] || {})[hk] = g.reg[bucket][hk] || []).push(r);
      // Per-liquidity-tier split (#4 "performance by liquidity"): reuse the cost model's
      // liquidity bucket (large/small/micro/biotech) so the board shows whether an edge
      // lives in liquid names (tradeable) or only in the illiquid tail (cost-eaten).
      const lt = tierForPick(p);
      ((g.liq[lt] = g.liq[lt] || {})[hk] = g.liq[lt][hk] || []).push(r);
      // Per-SECTOR split (#4 "performance by sector"): does the edge come from one hot
      // sector, or hold across sectors? Bucketed by the ticker's GICS sector.
      const sct = SECTOR_OF[p.ticker] || 'Unknown';
      ((g.sec[sct] = g.sec[sct] || {})[hk] = g.sec[sct][hk] || []).push(r);
      // collect the 1-week realized return per long sleeve (forwardPath returns
      // {ret,mfe} as a percent; use r.ret as a fraction). Long sleeves only.
      if (hk === ALLOC_HK && LONG_SLEEVE[p.section] && !p.short && Number.isFinite(r.ret)) {
        const nm = LONG_SLEEVE[p.section];
        (sleeveRecs[nm] = sleeveRecs[nm] || []).push({ date: p.date, ret: r.ret / 100 });
      }
    }
    // UNIFORM PICK SCORE (uscore-v1): one comparable momentum-conviction number for this
    // pick, from the same point-in-time candles, paired with its 20-session forward return
    // so the board can validate — across ALL sections at once — whether higher-conviction
    // picks actually win. Needs a resolved 20d return + enough history to score fairly.
    const isShort = p.short === true || p.tier === 'StrongSell';
    const raw = pointInTimeStrength(candles, spyCandles, p.date, { isShort });
    if (raw != null && Number.isFinite(retH)) scoreItems.push({ pick: p, raw, ret: +retH.toFixed(2), regime: bucket, section: p.section });
    // STRATEGY EFFICACY — resolve the pick's OWN published plan once (over MAX_HOLD),
    // independent of the display horizons: did price reach the logged target BEFORE the
    // logged stop? Only picks that actually published entry+stop+target qualify (e.g.
    // Ghost); the rest simply have no plan record. Direction-aware for short sleeves.
    if (candles && p.entry > 0 && p.stop > 0 && p.target > 0) {
      const plan = resolveTrade(candles, p.date, p.entry, p.stop, p.target, MAX_HOLD, !!p.short);
      if (plan.outcome && plan.outcome !== 'OPEN') (g.plans = g.plans || []).push(plan);
    }
  }

  // Gap & Go event sleeve (its own ledger, pre-resolved forward return) — the validated
  // event edge and the lowest-vol sleeve, so risk parity leans weight toward it.
  try {
    const gapDays = await readAllGapDays();
    const gapRecs = [];
    (gapDays || []).forEach(dd => (dd.picks || []).forEach(pk => {
      if (pk.resolved && Number.isFinite(pk.fwdPct)) gapRecs.push({ date: pk.date, ret: pk.fwdPct / 100 });
    }));
    if (gapRecs.length) sleeveRecs['Gap & Go'] = gapRecs;
  } catch { /* gap ledger optional */ }
  // GOVERNANCE → ALLOCATION: read the persisted model-governance state (written by
  // op=maturity) and cap each sleeve's deployed capital by its model's status weight
  // (Production 100% → Retired 0%). Keyed by the sleeve's scoreboard SECTION so the
  // status flows to the right sleeve. Best-effort: absent/stale governance ⇒ full
  // clearance (no penalty), so the allocation view never breaks if it hasn't run yet.
  const SLEEVE_BY_SECTION = { ...LONG_SLEEVE, GapGo: 'Gap & Go' };
  const govWeights = {}, govStatus = {};
  try {
    const govDoc = await readJSON('governance/latest.json', null);
    for (const g of (govDoc && govDoc.strategies) || []) {
      const nm = SLEEVE_BY_SECTION[g.section];
      if (nm && Number.isFinite(g.weight)) { govWeights[nm] = g.weight; govStatus[nm] = g.status; }
    }
  } catch { /* governance state optional */ }
  const allocation = computeAllocation(sleeveRecs, { govWeights, govStatus });

  // BOARD-WIDE SCORE-DECILE VALIDATION (#4 "performance by score decile"): score every pick
  // with its OWN SECTION'S REAL scorer reconstructed point-in-time (screener→Apex 4-pillar,
  // Ghost→Ghost 6-pillar, via lib/sectionscore), falling back to the uniform momentum proxy
  // for sections with no candle-reconstructable model. Normalize each score WITHIN its
  // section (so an Apex-80 and a Ghost-80 compare as "top of their own model"), pool, and
  // run the ranking-quality battery: do picks their own model rated highly actually win?
  const { analyzeRankQuality } = require('./rankquality');
  const proxyPcts = toPercentiles(scoreItems.map(s => s.raw));   // uniform fallback score
  const spyByDate = {};
  if (Array.isArray(spyCandles)) spyCandles.forEach(c => { spyByDate[c.date] = c.close; });
  const conv = sectionscore.reconstruct(
    scoreItems.map(s => ({ ticker: s.pick.ticker, date: s.pick.date, section: s.section, regime: s.regime })),
    { candlesFor: t => hist.get(t), spyByDate, proxyScore: i => proxyPcts[i] });
  scoreItems.forEach((s, i) => { s.conv = conv[i]; });
  // Within-section percentile → cross-comparable conviction rank (methods differ in scale).
  const secIdx = {};
  scoreItems.forEach((s, i) => { (secIdx[s.section] = secIdx[s.section] || []).push(i); });
  const cscore = new Array(scoreItems.length).fill(50);
  for (const sec of Object.keys(secIdx)) {
    const idxs = secIdx[sec];
    const ranked = sectionscore.rankPct(idxs.map(i => scoreItems[i].conv && scoreItems[i].conv.score));
    idxs.forEach((gi, k) => { cscore[gi] = ranked[k]; });
  }
  scoreItems.forEach((s, i) => { s.cscore = cscore[i]; });
  const rqItems = scoreItems.map((s, i) => ({ score: cscore[i], outcome: s.ret, won: s.ret > 0 }));
  const scoreByRegime = {};
  if (macroLookup) for (const rk of REGIME_BUCKETS) {
    const seg = scoreItems.filter(s => s.regime === rk).map((s, j) => ({ score: s.cscore, outcome: s.ret, won: s.ret > 0 }));
    if (seg.length >= 15) scoreByRegime[rk] = analyzeRankQuality(seg, { minN: 15 });
  }
  const methodMix = scoreItems.reduce((m, s) => { const k = (s.conv && s.conv.method) || 'none'; m[k] = (m[k] || 0) + 1; return m; }, {});
  // PER-SECTION decile breakdown: run the SAME ranking-quality battery on each section's
  // own picks alone — does each section's own scorer separate its own winners from losers?
  // (The board-wide `overall` above pools every section; this isolates them.) Ranked by
  // within-section conviction; gated at ≥15 resolved so a thin section can't fake a verdict.
  const scoreBySection = {};
  for (const [sec, idxs] of Object.entries(secIdx)) {
    if (idxs.length < 15) continue;
    const seg = idxs.map(i => ({ score: scoreItems[i].cscore, outcome: scoreItems[i].ret, won: scoreItems[i].ret > 0 }));
    const method = idxs.map(i => scoreItems[i].conv && scoreItems[i].conv.method).find(Boolean) || 'proxy';
    scoreBySection[sec] = { ...analyzeRankQuality(seg, { minN: 15 }), method };
  }
  const scoreQuality = {
    model: sectionscore.SECTIONSCORE_VERSION, proxyModel: PICKSCORE_VERSION, horizon: SCORE_HK,
    scoredPicks: scoreItems.length, methodMix,
    overall: analyzeRankQuality(rqItems, { minN: 20 }), byRegime: scoreByRegime, bySection: scoreBySection,
  };

  const out = Object.values(groups).map(g => ({
    section: g.section,
    tier: g.tier,
    picks: g.picks,
    regimePicks: g.regPicks, // logged-pick count per regime bucket
    // Strategy efficacy at the pick's OWN published entry/stop/target (target-before-stop
    // over MAX_HOLD). null for sleeves that never logged levels. Distinct from `horizons`,
    // which measure signal efficacy (did the stock move) regardless of the trade plan.
    strategy: summarizePlans(g.plans),
    horizons: Object.fromEntries(HORIZONS.map(([hk]) => [hk, summarizeReturns(g.h[hk] || [])])),
    // Per-regime forward returns: { 'risk-on': {1w,1m,3m}, 'risk-off': {…} }.
    byRegime: Object.fromEntries(REGIME_BUCKETS.map(rb =>
      [rb, Object.fromEntries(HORIZONS.map(([hk]) => [hk, summarizeReturns((g.reg[rb] || {})[hk] || [])]))])),
    // Per-liquidity-tier forward returns (only buckets that actually have picks): does
    // the edge survive in liquid, tradeable names or only in the illiquid tail?
    byLiquidity: Object.fromEntries(Object.keys(g.liq).map(lt =>
      [lt, Object.fromEntries(HORIZONS.map(([hk]) => [hk, summarizeReturns(g.liq[lt][hk] || [])]))])),
    // Per-sector forward returns — only sectors with a meaningful sample (≥5 picks at some
    // horizon) so a lone pick can't fake a sector verdict.
    bySector: Object.fromEntries(Object.keys(g.sec)
      .filter(sc => HORIZONS.some(([hk]) => (g.sec[sc][hk] || []).length >= 5))
      .map(sc => [sc, Object.fromEntries(HORIZONS.map(([hk]) => [hk, summarizeReturns(g.sec[sc][hk] || [])]))])),
  })).sort((a, b) => a.section === b.section ? a.tier.localeCompare(b.tier) : a.section.localeCompare(b.section));

  // Persist a lightweight track-record summary (section:tier → horizons) so the
  // per-ticker WHY NOW lookup can join a signal's honest win/excess record without
  // recomputing the whole Scoreboard on every modal open. Fire-and-forget; the
  // lookup degrades gracefully when it's absent.
  const generatedAt = new Date().toISOString();
  if (hasStore()) {
    // Compact per-section decile verdict (does the section's own scorer rank its winners?)
    // so the per-ticker WHY NOW lookup can show each firing signal's model-quality read.
    const sectionDecile = {};
    for (const [sec, v] of Object.entries(scoreBySection)) {
      if (!v || !v.ready) continue;
      sectionDecile[sec] = {
        verdict: v.verdict, ic: v.ic && v.ic.ic, t: v.ic && v.ic.t, significant: !!(v.ic && v.ic.significant),
        n: v.n, method: v.method, spread: v.topBottomSpread, horizon: SCORE_HK,
        winRate: v.baseWinRate, avgReturn: v.baseAvgOutcome, // the section's realized track record at this horizon
      };
    }
    const summary = { generatedAt, groups: out.map(g => ({ section: g.section, tier: g.tier, picks: g.picks, horizons: g.horizons })), sectionDecile };
    writeJSON('scoreboard/summary.json', summary, 300).catch(() => {});
  }

  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  return res.json({ configured: true, totalPicks: picks.length, loggedRows: rawPicks.length + rawGhost.length + cernPicks.length + rawTone.length + rawAttn.length + rawRT.length + rawAnom.length + rawSW.length + rawCA.length + rawTS.length + rawDownDay.length + rawGapDown.length + rawDaytrade.length + rawCoil.length, regimeSplit: !!macroLookup, groups: out, allocation, scoreQuality, costModel: { version: COST_MODEL_VERSION, roundTripPct: { liquid: roundTripCostPct('liquid'), small: roundTripCostPct('small'), micro: roundTripCostPct('micro'), biotech: roundTripCostPct('biotech') } }, entryModel: { version: ENTRY_MODEL_VERSION, basis: 'next-session open for picks without a logged entry (vs signal-day close)' }, generatedAt });
}

// ── op=cerndecay : decay curve (excess vs S&P by day 1..20) per CERN event type
// Reads the CERN counterfactual archive, measures each event's market-relative
// return at every day 1..20, averages per type → the curve + a recommended holding
// window. Fills in as events age past 20 trading days; trust flag guards small n.
async function runCernDecay(req, res) {
  const cernState = await readCern().catch(() => null);
  const picks = cernPicksFrom(cernState);
  if (!picks.length) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ configured: hasStore(), types: {}, note: 'No CERN events logged yet — the engine runs daily with the warm cron.', generatedAt: new Date().toISOString() });
  }

  // Candles for every event ticker + the SPY benchmark, fetched once.
  const tickers = [...new Set(picks.map(p => p.ticker))];
  const histMap = new Map();
  let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++];
      try { const d = await fetchDailyHistory(t); if (d) histMap.set(t, d.candles); } catch { /* skip */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, tickers.length) }, worker));
  const spyD = await fetchDailyHistory('SPY').catch(() => null);
  const spy = spyD ? spyD.candles : null;

  const { computeDecayCurves } = require('./cern-decay');
  const decay = computeDecayCurves(picks, histMap, spy, { forwardReturn, spyForwardReturn });

  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  return res.json({ configured: true, events: picks.length, ...decay });
}

// ── op=apexlog : log today's Apex/Loaded signals to the ledger ─────────────
async function runApexLog(req, res) {
  if (!hasStore()) {
    return res.status(200).json({ ok: false, error: 'Blob storage not configured (create a Vercel Blob store).', count: 0 });
  }
  const { date, isMarketClosed } = nowET();
  if (isMarketClosed && req.query.force !== '1') {
    return res.status(200).json({ ok: true, skipped: 'market-closed', date, count: 0 });
  }

  const ts = Date.now();
  let regime = 'NEUTRAL';
  const byTicker = new Map();          // first/best record per ticker
  const RANK = { apex: 2, loaded: 1 };

  // Score with the active recalibrated weights if a Module 2 re-fit is live,
  // else the static Module 1 presets — so the ledger matches the live tab.
  const model = await readModel();
  const active = model.activeId ? model.versions.find(v => v.id === model.activeId) : null;
  const activeWeights = active && active.weights ? active.weights : null;
  // Tag every signal with this week's dominant market narrative (sentiment layer).
  const nar = await readNarrative();
  const narrativeTag = nar ? nar.tag : null;

  // The scoring version stamped on each record: the recalibrated model id when a
  // Module-2 re-fit is live, else the static formula version. Historical picks stay
  // attributable to the exact rules that produced them.
  const scoringVersion = model.activeId || apex.SCORING_VERSION;
  // Large first — it carries the market-regime read used to score every scope.
  let sourceErrors = 0;
  for (const scope of ['large', 'small', 'micro']) {
    let d;
    try { d = await getJSON('/api/screener?scope=' + scope + (scope === 'large' ? '&lookback=1M' : '')); } catch { sourceErrors++; continue; }
    if (scope === 'large') regime = apex.rawRegime(d.regime);
    const weights = (activeWeights && activeWeights[regime]) || apex.PRESETS[regime];
    (d.results || []).forEach(c => {
      if (!c.ticker || !c.status || c.price == null) return;
      const { pillars, score, tier } = apex.scoreCandidate(c, regime, weights);
      if (tier !== 'apex' && tier !== 'loaded') return;  // log only Apex / Loaded
      const lv = c.levels || {}, m = c.metrics || {};
      const rec = {
        date, ts, ticker: c.ticker, company: c.company || null, scope, tier, score, pillars, regime,
        narrativeTag, scoringVersion,
        entry: lv.entry != null ? lv.entry : c.price,
        pivot: m.pivot != null ? m.pivot : null,
        stop: lv.stop != null ? lv.stop : null,
        target: lv.target != null ? lv.target : (lv.resistance != null ? lv.resistance : null),
        status: c.status,
      };
      const prev = byTicker.get(c.ticker);
      if (!prev || RANK[tier] > RANK[prev.tier] || (RANK[tier] === RANK[prev.tier] && score > prev.score)) byTicker.set(c.ticker, rec);
    });
  }
  const signals = [...byTicker.values()];

  const guard = await safeToWrite('apex/', date, signals.length, sourceErrors);
  if (!guard.write) {
    return res.status(200).json({ ok: true, skipped: guard.reason, degraded: true, date, regime, count: signals.length, existing: guard.existing, sourceErrors });
  }
  let url = null, err = null;
  try { const r = await writeApexDay(date, signals); url = r.url; } catch (e) { err = String(e && e.message || e); }
  return res.status(err ? 502 : 200).json({ ok: !err, date, regime, count: signals.length, url, error: err, sourceErrors, at: new Date().toISOString() });
}

// ── op=ghostlog : log today's GHOST/STALKING signals to the ghost ledger ────
// The 6-pillar Ghost score is computed server-side in /api/screener (c.ghost),
// so this op just reads it back and persists first/best per ticker — the future
// adaptive engine resolves these. Logs Ghost + Stalking only (Watch is noise).
async function runGhostLog(req, res) {
  if (!hasStore()) {
    return res.status(200).json({ ok: false, error: 'Blob storage not configured (create a Vercel Blob store).', count: 0 });
  }
  const { date, isMarketClosed } = nowET();
  if (isMarketClosed && req.query.force !== '1') {
    return res.status(200).json({ ok: true, skipped: 'market-closed', date, count: 0 });
  }

  const ts = Date.now();
  let regime = 'neutral';
  const byTicker = new Map();
  const RANK = { GHOST: 2, STALKING: 1 };
  const scoringVersion = ghost.SCORING_VERSION;

  let sourceErrors = 0;
  for (const scope of ['large', 'small', 'micro']) {
    let d;
    try { d = await getJSON('/api/screener?scope=' + scope + (scope === 'large' ? '&lookback=1M' : '')); } catch { sourceErrors++; continue; }
    if (scope === 'large' && d.ghost && d.ghost.regime) regime = d.ghost.regime;
    (d.results || []).forEach(c => {
      const g = c.ghost;
      if (!g || !c.ticker || c.price == null) return;
      if (g.tier !== 'GHOST' && g.tier !== 'STALKING') return;   // log Ghost / Stalking only
      const lv = c.levels || {}, m = c.metrics || {};
      const ins = c.insider || null;
      const rec = {
        date, ts, ticker: c.ticker, company: c.company || null, scope, scoringVersion,
        tier: g.tier, score: g.score, pillars: g.pillars, strongPillars: g.strongPillars,
        regime: d.ghost ? d.ghost.regime : regime,
        insiderNet: ins && ins.net ? ins.net.value : null,
        entry: lv.entry != null ? lv.entry : c.price,
        pivot: m.pivot != null ? m.pivot : null,
        stop: lv.stop != null ? lv.stop : null,
        target: lv.target != null ? lv.target : (lv.resistance != null ? lv.resistance : null),
        status: c.status || null,
      };
      const prev = byTicker.get(c.ticker);
      if (!prev || RANK[g.tier] > RANK[prev.tier] || (RANK[g.tier] === RANK[prev.tier] && g.score > prev.score)) byTicker.set(c.ticker, rec);
    });
  }
  const signals = [...byTicker.values()];

  const guard = await safeToWrite('ghost/', date, signals.length, sourceErrors);
  if (!guard.write) {
    return res.status(200).json({ ok: true, skipped: guard.reason, degraded: true, date, regime, count: signals.length, existing: guard.existing, sourceErrors });
  }
  let url = null, err = null;
  try { const r = await writeGhostDay(date, signals); url = r.url; } catch (e) { err = String(e && e.message || e); }
  return res.status(err ? 502 : 200).json({ ok: !err, date, regime, count: signals.length, url, error: err, sourceErrors, at: new Date().toISOString() });
}

// ── Edge Book helpers — position-signed forward return + SPY benchmark ──────
// Position return: raw stock forward return over `bars`, signed by side (a short
// profits when the stock falls). SPY return over the same window is the market
// benchmark; excess = position − SPY is "did this pick beat the market".
function posReturn(candles, pick, bars) {
  let idx = -1; for (let k = 0; k < candles.length; k++) { if (candles[k].date <= pick.date) idx = k; else break; }
  if (idx < 0) return null; const tgt = idx + bars; if (tgt >= candles.length) return null;
  const entry = pick.entry || candles[idx].close; if (!entry) return null;
  let ret = ((candles[tgt].close - entry) / entry) * 100;
  if (pick.side === 'short') ret = -ret;
  return ret;
}
function spyReturnAt(spyCandles, date, bars) {
  let idx = -1; for (let k = 0; k < spyCandles.length; k++) { if (spyCandles[k].date <= date) idx = k; else break; }
  if (idx < 0) return null; const tgt = idx + bars; if (tgt >= spyCandles.length) return null;
  return ((spyCandles[tgt].close - spyCandles[idx].close) / spyCandles[idx].close) * 100;
}
function corr(a, b) {
  const n = a.length; if (n < 2) return null;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return (da && db) ? num / Math.sqrt(da * db) : 0;
}

// ── op=edgelog : snapshot today's two-sleeve Edge Book (paper) ──────────────
// Sleeve A = top-quintile CONVICTION longs (regime-gated), from the live screener.
// Sleeve B = CERN forced-flow TRADE/PROBE decisions. Logged daily to edge/<date>;
// op=edgebook later resolves each sleeve's beat-SPY rate + the cross-sleeve
// correlation — the empirical test of the orthogonal-overlay thesis.
async function runEdgeLog(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.', count: 0 });
  const { date, isMarketClosed } = nowET();
  if (isMarketClosed && req.query.force !== '1') return res.status(200).json({ ok: true, skipped: 'market-closed', date, count: 0 });

  const ts = Date.now();
  const byKey = new Map();
  let regime = 'neutral';

  // Sleeve A — conviction longs from the screener (large + small pools), regime-gated.
  for (const scope of ['large', 'small']) {
    let d;
    try { d = await getJSON('/api/screener?scope=' + scope + (scope === 'large' ? '&lookback=1M' : '')); } catch { continue; }
    if (scope === 'large' && d.conviction && d.conviction.regime) regime = d.conviction.regime;
    if (!(d.conviction && d.conviction.longOk)) continue;          // regime gate: no longs in risk-off
    (d.results || []).forEach(c => {
      const cv = c.conviction;
      if (!cv || !cv.sleeveA || !c.ticker || c.price == null) return;
      const lv = c.levels || {};
      const rec = { date, ts, sleeve: 'A', ticker: c.ticker, company: c.company || null, side: 'long',
        score: cv.score, pctile: cv.pctile, scope, regime: d.conviction.regime,
        entry: lv.entry != null ? lv.entry : c.price };
      const k = 'A:' + c.ticker, prev = byKey.get(k);
      if (!prev || cv.score > prev.score) byKey.set(k, rec);
    });
  }

  // Sleeve B — CERN forced-flow decisions (paper TRADE / PROBE).
  let cernCount = 0;
  try {
    const state = await readCern();
    if (state) {
      const cern = CERN.load(state);
      for (const e of cern.s.ledger) {
        if (e.status !== 'SIGNALED' || !e.signal) continue;
        if (e.signal.action !== 'TRADE' && e.signal.action !== 'PROBE') continue;
        const k = 'B:' + e.symbol; if (byKey.has(k)) continue;
        byKey.set(k, { date, ts, sleeve: 'B', ticker: e.symbol, side: e.signal.side, action: e.signal.action,
          type: e.type, score: e.signal.pProfit != null ? Math.round(e.signal.pProfit * 100) : null,
          predMu: e.signal.predMu, pProfit: e.signal.pProfit, regime: e.signal.regime, entry: e.signal.entryPrice });
        cernCount++;
      }
    }
  } catch {}

  const picks = [...byKey.values()];
  const aCount = picks.filter(p => p.sleeve === 'A').length;
  let url = null, err = null;
  try { const r = await writeEdgeDay(date, picks); url = r.url; } catch (e) { err = String(e && e.message || e); }
  return res.status(err ? 502 : 200).json({ ok: !err, date, regime, sleeveA: aCount, sleeveB: cernCount, count: picks.length, url, error: err, at: new Date().toISOString() });
}

// ── op=edgebook : resolve each sleeve's beat-SPY rate + cross-sleeve correlation
async function runEdgeBook(req, res) {
  const raw = await readAllEdge();
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  if (!raw.length) return res.json({ configured: hasStore(), picks: 0, sleeves: [], note: 'No Edge Book history yet — the warm cron logs it daily.', generatedAt: new Date().toISOString() });

  // First-appearance dedup per sleeve:ticker:side.
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const first = new Map();
  for (const p of [...raw].sort(byDate)) { const k = `${p.sleeve}:${p.ticker}:${p.side}`; if (!first.has(k)) first.set(k, p); }
  const picks = [...first.values()];

  const spyD = await fetchDailyHistory('SPY'); const spy = spyD ? spyD.candles : null;
  const tickers = [...new Set(picks.map(p => p.ticker))];
  const hist = new Map(); let i = 0;
  const worker = async () => { while (i < tickers.length) { const t = tickers[i++]; try { const d = await fetchDailyHistory(t); if (d) hist.set(t, d.candles); } catch {} } };
  await Promise.all(Array.from({ length: Math.min(8, tickers.length) }, worker));

  const H = 21;                                   // 1-month horizon for headline beat-rate + correlation
  for (const p of picks) {
    p.excess = null;
    const candles = hist.get(p.ticker); if (!candles || !spy) continue;
    const pr = posReturn(candles, p, H), sr = spyReturnAt(spy, p.date, H);
    if (pr != null && sr != null) p.excess = +(pr - sr).toFixed(2);
  }

  const summarize = sleeve => {
    const ps = picks.filter(p => p.sleeve === sleeve), resolved = ps.filter(p => p.excess != null);
    const wins = resolved.filter(p => p.excess > 0).length, ci = resolved.length ? wilson(wins, resolved.length) : { lo: 0, hi: 0 };
    return { sleeve, total: ps.length, resolved: resolved.length, pending: ps.length - resolved.length,
      beatSpyRate: resolved.length ? +(wins / resolved.length).toFixed(3) : null, wilsonLo: +ci.lo.toFixed(3),
      avgExcessVsSpy: resolved.length ? +(resolved.reduce((a, p) => a + p.excess, 0) / resolved.length).toFixed(2) : null };
  };

  // Cross-sleeve correlation of daily mean excess — the overlay thesis (wants ~0).
  const dailyMean = sleeve => { const m = new Map(); for (const p of picks) { if (p.sleeve !== sleeve || p.excess == null) continue; if (!m.has(p.date)) m.set(p.date, []); m.get(p.date).push(p.excess); } const o = {}; for (const [d, a] of m) o[d] = a.reduce((x, y) => x + y, 0) / a.length; return o; };
  const aM = dailyMean('A'), bM = dailyMean('B'), common = Object.keys(aM).filter(d => d in bM);
  const correlation = common.length >= 8 ? +corr(common.map(d => aM[d]), common.map(d => bM[d])).toFixed(3) : null;

  return res.json({ configured: true, picks: picks.length, horizonDays: H,
    sleeves: [summarize('A'), summarize('B')],
    crossSleeve: { pairedDates: common.length, correlation,
      note: common.length >= 8 ? 'Pearson corr of daily mean excess — the overlay thesis wants this ~0 (uncorrelated streams diversify).' : 'Need ≥8 dates where BOTH sleeves traded — still accruing.' },
    generatedAt: new Date().toISOString() });
}

// ── op=vreversal : live scan for V-shaped reversals (tiered + buy/sell levels) ─
// Scans the universe (default all scopes), runs the pure detector on each name's
// daily candles, returns tiered candidates (CONFIRMED/EMERGING/WATCH) with entry,
// stop, target and R:R. Time-boxed; cached behind the CDN like the screener.
async function runVReversal(req, res) {
  const scope = (req.query.scope || 'all').toLowerCase();
  const lists = scope === 'large' ? UNI_LARGE : scope === 'small' ? UNI_SMALL : scope === 'micro' ? UNI_MICRO
    : [...UNI_LARGE, ...UNI_SMALL, ...UNI_MICRO];
  const tickers = [...new Set(lists)];
  const t0 = Date.now(), deadline = 50000;
  const out = []; let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++]; if (Date.now() - t0 > deadline) return;
      try {
        const d = await fetchDailyHistory(t);
        if (d && d.candles.length >= 80) {
          const v = analyzeVReversal(d.candles);
          if (v) { v.ticker = t; v.price = +lastClose(d.candles).toFixed(2); out.push(v); }
        }
      } catch { /* skip */ }
    }
  };
  await Promise.all(Array.from({ length: 18 }, worker));
  const RANK = { CONFIRMED: 3, EMERGING: 2, WATCH: 1 };
  out.sort((a, b) => (RANK[b.tier] - RANK[a.tier]) || (b.score - a.score));
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');
  return res.json({
    ok: true, scope, scanned: tickers.length, found: out.length,
    tiers: { CONFIRMED: out.filter(x => x.tier === 'CONFIRMED').length, EMERGING: out.filter(x => x.tier === 'EMERGING').length, WATCH: out.filter(x => x.tier === 'WATCH').length },
    results: out.slice(0, 80), elapsedMs: Date.now() - t0, generatedAt: new Date().toISOString(),
  });
}
const lastClose = candles => candles[candles.length - 1].close;

// ── op=vreversaltest : does the V-reversal pattern actually have edge? ───────
// Replays the SAME detector over history; whenever a V fires, records the
// forward H-day return and the excess vs SPY, aggregated by tier. ≥10-bar dedup
// so one ongoing V isn't counted every day.
//
// The long side LOSES (falling-knife), so the live question is the FADE: short
// the snapback (market-neutral vs SPY). On a 2y window that fade shows alpha —
// but the whole edge-hunt has been burned 3× by risk-on-window artifacts, so
// this defaults to range=5y and SPLITS THE FADE BY MACRO REGIME. A fade that is
// real (not a bull-market beta accident) must keep alpha — beatsMkt Wilson LB
// > 50% — in NEUTRAL and RISK-OFF too, not only risk-on.
async function runVReversalTest(req, res) {
  const scope = (req.query.scope || 'large').toLowerCase();
  const limit = Math.max(0, parseInt(req.query.limit, 10) || 120);
  const H = Math.max(5, parseInt(req.query.h, 10) || 21);
  const range = /^(1y|2y|5y|10y|max)$/.test(req.query.range || '') ? req.query.range : '5y';
  // pattern: 'v' (bottom; long-side, fade=short), 'invertedv' (top; short IS the
  // primary trade — read the `fade` block), 'sweep' (bullish liquidity sweep; long
  // primary), 'sweepshort' (bearish liquidity sweep; the short = `fade` block).
  const p = (req.query.pattern || '').toLowerCase();
  const KNOWN = ['invertedv', 'sweep', 'sweepshort', 'donchian', 'rsi2', 'pullback'];
  const pattern = p === 'top' ? 'invertedv' : p === 'sweeptop' ? 'sweepshort' : KNOWN.includes(p) ? p : 'v';
  const { analyzeInvertedV, analyzeLiquiditySweep } = require('../lib/vreversal');
  const { donchianBreakout, rsi2Reversion, maPullback } = require('../lib/techstrats');
  const DETECTORS = {
    v: analyzeVReversal,
    invertedv: analyzeInvertedV,
    sweep: c => analyzeLiquiditySweep(c, { dir: 1 }),
    sweepshort: c => analyzeLiquiditySweep(c, { dir: -1 }),
    donchian: donchianBreakout,
    rsi2: rsi2Reversion,
    pullback: maPullback,
  };
  const detect = DETECTORS[pattern];
  const lists = scope === 'small' ? UNI_SMALL : scope === 'micro' ? UNI_MICRO : UNI_LARGE;
  let tickers = [...new Set(lists)]; if (limit > 0) tickers = tickers.slice(0, limit);

  const { buildMacroLookup } = require('../lib/macro');
  const [spyD, macro] = await Promise.all([
    fetchDailyHistory('SPY', range),
    buildMacroLookup(range).catch(() => null),
  ]);
  const spyClose = {};
  if (spyD) spyD.candles.forEach(c => { spyClose[c.date] = c.close; });
  const regimeAt = date => (macro ? (macro.at(date) || {}).regime || 'unknown' : 'unknown');

  const t0 = Date.now(), deadline = 50000;
  const blank = () => ({ CONFIRMED: [], EMERGING: [], WATCH: [] });
  const byTier = blank();
  const byRegime = { 'risk-on': blank(), neutral: blank(), 'risk-off': blank(), unknown: blank() };
  let i = 0, signals = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++]; if (Date.now() - t0 > deadline) return;
      let d; try { d = await fetchDailyHistory(t, range); } catch { continue; }
      if (!d || d.candles.length < 120) continue;
      const c = d.candles; let lastSig = -99;
      for (let k = 80; k < c.length - H; k++) {
        if (k - lastSig < 10) continue;                          // dedup overlapping signals
        const v = detect(c.slice(0, k + 1)); if (!v) continue;
        lastSig = k;
        const entry = c[k].close, fwd = ((c[k + H].close - entry) / entry) * 100;
        let exc = null;
        if (spyClose[c[k].date] != null && spyClose[c[k + H].date] != null) {
          const sret = ((spyClose[c[k + H].date] - spyClose[c[k].date]) / spyClose[c[k].date]) * 100;
          exc = fwd - sret;
        }
        if (!byTier[v.tier]) continue;
        const rec = { fwd, exc };
        byTier[v.tier].push(rec);
        byRegime[regimeAt(c[k].date)][v.tier].push(rec);
        signals++;
      }
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));

  const avg = a => (a.length ? a.reduce((s, b) => s + b, 0) / a.length : null);
  const summ = arr => {
    const n = arr.length; if (!n) return { n: 0 };
    const fwd = arr.map(x => x.fwd), exc = arr.filter(x => x.exc != null).map(x => x.exc);
    const win = fwd.filter(x => x > 0).length;
    const longBeat = exc.filter(x => x > 0).length, longCi = exc.length ? wilson(longBeat, exc.length) : { lo: 0 };
    // FADE = short the signal (vs long SPY). Wins when the stock UNDERperforms SPY.
    const fadeBeat = exc.filter(x => x < 0).length, fadeCi = exc.length ? wilson(fadeBeat, exc.length) : { lo: 0 };
    const nakedShortWin = fwd.filter(x => x < 0).length;
    return {
      n,
      long: {
        winRate: +((win / n) * 100).toFixed(0), avgFwd: +avg(fwd).toFixed(2),
        beatSpyRate: exc.length ? +((longBeat / exc.length) * 100).toFixed(0) : null, wilsonLo: +(longCi.lo * 100).toFixed(0),
        avgExcessVsSpy: exc.length ? +avg(exc).toFixed(2) : null,
      },
      fade: {
        beatsMktRate: exc.length ? +((fadeBeat / exc.length) * 100).toFixed(0) : null, wilsonLo: +(fadeCi.lo * 100).toFixed(0),
        alpha: exc.length ? +(-avg(exc)).toFixed(2) : null,           // market-neutral: short stock + long SPY
        nakedShortAvg: +(-avg(fwd)).toFixed(2), nakedShortWinRate: +((nakedShortWin / n) * 100).toFixed(0),
      },
    };
  };
  const tierSet = obj => ({ CONFIRMED: summ(obj.CONFIRMED), EMERGING: summ(obj.EMERGING), WATCH: summ(obj.WATCH) });

  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    ok: true, scope, range, pattern, horizonDays: H, namesScanned: tickers.length, totalSignals: signals,
    primaryTrade: (pattern === 'invertedv' || pattern === 'sweepshort')
      ? 'fade block = the primary SHORT (short stock vs long SPY)'
      : 'long block = the primary trade (buy); fade = short it',
    macroAvailable: !!macro,
    byTier: tierSet(byTier),
    byRegime: {
      'risk-on': tierSet(byRegime['risk-on']),
      neutral: tierSet(byRegime.neutral),
      'risk-off': tierSet(byRegime['risk-off']),
    },
    note: 'Per tier: LONG = buying the V (loses); FADE = shorting it vs long SPY. fade.beatsMktRate Wilson LB > 50% = real relative edge. byRegime splits the SAME signals by the as-of macro regime — a durable fade must keep fade.wilsonLo > 50% in NEUTRAL and RISK-OFF, not only risk-on (the artifact that killed exits/PEAD/conviction). fade.nakedShortAvg = naked short P&L (negative in bull tape even with alpha).',
    elapsedMs: Date.now() - t0, generatedAt: new Date().toISOString(),
  });
}

// ── op=fadeopt : can the inverted-V SHORT be made to actually work? ─────────
// Honest optimization of the fade: (A) does signal "stretch" (how extreme the top
// is) predict bigger fade wins, and (B) does PER-STOCK selection generalize OUT
// OF SAMPLE? Stock selection is tested with a PURGED train/test split + Bayesian
// shrinkage of each stock's train hit-rate toward the global prior (so we don't
// just chase in-sample winners). Regime-gated to risk-on/neutral throughout (the
// proven lever). beatMkt for a SHORT = the stock UNDERperforms SPY (exc < 0).
// 🧪 Screener-tracker handlers (fade/trend/daytrade/confluence) live in
// lib/screener-routes.js — imported at top, dispatched below.


// 🔮 Predict-suite handlers (predict/brief/crowd/sharp/tape/alerts) live in
// lib/predict-routes.js — imported at top, dispatched below.

// 📸 Data-capture handlers (archive/insider/fundamentals/CERN) live in lib/capture-routes.js.

// ── op=drift : resolve outcomes + live-vs-baseline health (Module 3) ───────
// Resolution runs against each signal's OWN logged stop/target (lib/outcome),
// so the ledger measures the strategy you'd actually trade — not a fixed barrier.
const resolveApex = (candles, sig) => resolveTrade(candles, sig.date, sig.entry, sig.stop, sig.target);

// Wilson score interval for a binomial proportion (z=1.645 → ~90%).

function aggApex(arr) {
  const n = arr.length;
  if (!n) return { n: 0, winRate: null, profitFactor: null, wins: 0, losses: 0, expired: 0, wonCount: 0 };
  const wins = arr.filter(s => s.won);
  const sumWin = arr.filter(s => s.r > 0).reduce((a, s) => a + s.r, 0);
  const sumLoss = Math.abs(arr.filter(s => s.r <= 0).reduce((a, s) => a + s.r, 0));
  const ci = wilson(wins.length, n);
  return {
    n,
    winRate: Math.round((wins.length / n) * 100),
    winRateCI: { lo: Math.round(ci.lo * 100), hi: Math.round(ci.hi * 100), level: 90 },
    wonCount: wins.length,
    profitFactor: sumLoss > 0 ? +(sumWin / sumLoss).toFixed(2) : (sumWin > 0 ? 99 : 0),
    wins: arr.filter(s => s.outcome === 'WIN').length,
    losses: arr.filter(s => s.outcome === 'LOSS').length,
    expired: arr.filter(s => s.outcome === 'EXPIRED').length,
  };
}

const btRegimeOf = regime => (regime === 'RISK_OFF' ? 'off' : 'on'); // backtest split is binary (SPY vs 200-DMA)
const winRateOf = arr => (arr.length ? Math.round((arr.filter(s => s.won).length / arr.length) * 100) : null);
const pfOf = arr => { let w = 0, l = 0; arr.forEach(s => { if (s.r > 0) w += s.r; else l += Math.abs(s.r); }); return l > 0 ? +(w / l).toFixed(2) : (w > 0 ? 99 : 0); };

// Baseline for drift. PREFERRED: the historical backfill seed, which resolves
// with the EXACT same lib/outcome rule against the same logged levels as the live
// ledger — so the comparison is apples-to-apples. Weighted by the live window's
// regime mix. Falls back to the ATR backtest only if no seed exists.
function baselineFor(window, seed, bt) {
  const seedSignals = seed && Array.isArray(seed.signals) ? seed.signals : null;
  if (seedSignals && seedSignals.length >= 50) {
    const byReg = { RISK_ON: [], NEUTRAL: [], RISK_OFF: [] };
    seedSignals.forEach(s => { if (byReg[s.regime]) byReg[s.regime].push(s); });
    const mix = { RISK_ON: 0, NEUTRAL: 0, RISK_OFF: 0 };
    window.forEach(s => { if (mix[s.regime] != null) mix[s.regime]++; });
    let wSum = 0, wr = 0, pf = 0;
    for (const R of ['RISK_ON', 'NEUTRAL', 'RISK_OFF']) {
      const seg = byReg[R]; if (!seg.length || !mix[R]) continue;
      const segWR = winRateOf(seg), segPF = pfOf(seg);
      if (segWR == null) continue;
      wr += segWR * mix[R]; pf += segPF * mix[R]; wSum += mix[R];
    }
    if (wSum) return { winRate: Math.round(wr / wSum), profitFactor: +(pf / wSum).toFixed(2), source: 'historical seed · by regime (same resolution as live)' };
    // No regime overlap → seed overall.
    const all = Object.values(byReg).flat();
    return { winRate: winRateOf(all), profitFactor: pfOf(all), source: 'historical seed · overall (same resolution as live)' };
  }
  // Fallback: ATR backtest (methodology differs — flagged in the UI).
  if (!bt || !bt.regimeSplit) return null;
  const counts = { on: 0, off: 0 };
  window.forEach(s => counts[btRegimeOf(s.regime)]++);
  let wSum = 0, wr = 0, pf = 0;
  for (const k of ['on', 'off']) {
    const seg = bt.regimeSplit[k];
    if (!seg || !seg.n || !counts[k]) continue;
    wr += seg.winRate * counts[k]; pf += seg.profitFactor * counts[k]; wSum += counts[k];
  }
  if (!wSum) { const o = bt.overall || {}; return { winRate: o.winRate ?? null, profitFactor: o.profitFactor ?? null, source: 'ATR backtest · overall (different methodology)' }; }
  return { winRate: Math.round(wr / wSum), profitFactor: +(pf / wSum).toFixed(2), source: 'ATR backtest · by regime (different methodology)' };
}

function regimeMix(arr) {
  const m = { RISK_ON: 0, NEUTRAL: 0, RISK_OFF: 0 };
  arr.forEach(s => { if (m[s.regime] != null) m[s.regime]++; });
  return m;
}

// Read the whole ledger, dedupe to first-appearance per ticker:tier, resolve
// each signal's outcome. A terminal outcome (WIN/LOSS/EXPIRED) never changes, so
// it's cached in apex/resolved.json — only OPEN/uncached signals trigger a price
// fetch, keeping drift + recalibrate cheap as the ledger grows. Shared by both.
const ledgerKey = s => `${s.ticker}|${s.tier}|${s.date}`;

async function resolveLedger() {
  const raw = await readAllApex();
  const firstSeen = new Map();
  for (const s of [...raw].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
    const key = `${s.ticker}:${s.tier}`;
    if (!firstSeen.has(key)) firstSeen.set(key, s);
  }
  const sigs = [...firstSeen.values()];

  const cache = await readResolved();
  // Only fetch history for tickers that still have an uncached signal.
  const need = [...new Set(sigs.filter(s => !cache[ledgerKey(s)]).map(s => s.ticker))];
  const hist = new Map();
  let i = 0;
  const worker = async () => { while (i < need.length) { const t = need[i++]; try { const d = await fetchDailyHistory(t); if (d) hist.set(t, d.candles); } catch { /* skip */ } } };
  await Promise.all(Array.from({ length: Math.min(8, need.length) }, worker));

  const resolved = [];
  let openCount = 0, cacheChanged = false;
  for (const s of sigs) {
    let r = cache[ledgerKey(s)];
    if (!r) {
      const candles = hist.get(s.ticker);
      if (!candles) { openCount++; continue; }
      const out = resolveApex(candles, s);
      if (out.outcome === 'OPEN') { openCount++; continue; }
      r = { outcome: out.outcome, r: out.r, hold: out.hold, exitDate: out.exitDate };
      cache[ledgerKey(s)] = r; cacheChanged = true; // cache terminal outcomes only
    }
    resolved.push({ ...s, ...r, won: r.outcome === 'WIN' || (r.outcome === 'EXPIRED' && r.r > 0) });
  }
  if (cacheChanged) { try { await writeResolved(cache); } catch { /* best-effort */ } }
  return { sigs, resolved, openCount };
}

// op=rankquality (#5) — does a higher Apex score actually produce a better outcome?
// Runs the ranking-quality battery (decile perf, rank-IC, top-K precision, lift,
// calibration/Brier, verdict) over the resolved Apex ledger, which logs a numeric
// `score` per pick + a resolved R-multiple outcome. Split by macro regime too, since
// the app's whole thesis is that edge is regime-dependent. (The unified decision-
// engine snapshots become a second source here once they resolve — they log `score`
// as of today; until then Apex is the one mature scored+resolved ledger.)
async function runRankQuality(req, res) {
  const { analyzeRankQuality } = require('./rankquality');
  if (!hasStore()) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: false, configured: false, note: 'Blob storage not configured.', generatedAt: new Date().toISOString() });
  }
  const { resolved, openCount } = await resolveLedger();
  const toItem = s => ({ score: s.score, outcome: Number.isFinite(s.r) ? +(s.r * 100).toFixed(2) : null, won: !!s.won, regime: s.regime });
  const items = resolved.filter(s => Number.isFinite(s.score) && Number.isFinite(s.r)).map(toItem);
  const overall = analyzeRankQuality(items);
  const byRegime = {};
  for (const rk of ['RISK_ON', 'NEUTRAL', 'RISK_OFF']) {
    const seg = items.filter(x => x.regime === rk);
    if (seg.length) byRegime[rk] = analyzeRankQuality(seg, { minN: 15 });
  }
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  return res.json({
    ok: true, source: 'apex-ledger', outcomeUnit: 'R×100 (realized R-multiple, %)',
    resolvedCount: items.length, openCount, overall, byRegime,
    note: 'Higher-score picks should show higher decile avgOutcome + win rate. Verdict "predictive" = positive significant rank-IC with a monotone decile ladder. Outcome = realized R-multiple at the logged stop/target.',
    generatedAt: new Date().toISOString(),
  });
}

async function runDrift(req, res) {
  if (!hasStore()) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ configured: false, status: 'PENDING', note: 'Blob storage not configured.', resolvedCount: 0, generatedAt: new Date().toISOString() });
  }
  const { sigs, resolved, openCount } = await resolveLedger();

  if (!sigs.length) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ configured: true, status: 'PENDING', minSignals: 15, totalSignals: 0, resolvedCount: 0, openCount: 0, note: 'No Apex signals logged yet — the ledger fills as the daily cron runs.', generatedAt: new Date().toISOString() });
  }

  // Trailing 60 calendar days of resolved signals; fall back to all resolved
  // while the ledger is still young so the panel isn't empty.
  const cutoff = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
  let window = resolved.filter(s => s.date >= cutoff);
  if (window.length < 15 && resolved.length > window.length) window = resolved;

  const live = aggApex(window);

  let baseline = null;
  try {
    const seed = await readBackfill();
    const bt = (seed && Array.isArray(seed.signals) && seed.signals.length >= 50) ? null : await getJSON('/api/backtest?scope=large&months=12');
    baseline = baselineFor(window, seed, bt);
  } catch { /* baseline unavailable */ }

  // Asymmetric, sample-aware status:
  //  • BROKEN (drastic — auto-recalibrates) needs the Wilson UPPER bound below
  //    baseline−15, so a small noisy sample can't trip a false alarm.
  //  • DEGRADING (soft "reduce size" heads-up) uses the point estimate below
  //    baseline−5, so it warns early without over-reacting.
  let status = 'PENDING';
  if (window.length >= 15 && baseline && baseline.winRate != null) {
    const base = baseline.winRate;
    status = live.winRateCI.hi < base - 15 ? 'BROKEN'
           : live.winRate < base - 5 ? 'DEGRADING'
           : 'HEALTHY';
  }

  // Failure forensics — group losses by their dominant (highest) pillar.
  const fails = window.filter(s => s.outcome === 'LOSS');
  const byProfile = {};
  for (const s of fails) {
    const pl = s.pillars || {};
    const dom = apex.KEYS.reduce((best, k) => ((pl[k] ?? 0) > (pl[best] ?? -1) ? k : best), 'p1');
    (byProfile[dom] = byProfile[dom] || { key: dom, label: apex.PILLAR_LABEL[dom], count: 0 }).count++;
  }
  const forensics = Object.values(byProfile)
    .map(p => ({ ...p, pct: fails.length ? Math.round((p.count / fails.length) * 100) : 0 }))
    .sort((a, b) => b.count - a.count);

  // Win rate by narrative tag (observational; "significant" once a tag has ≥30).
  const byTag = {};
  for (const s of window) {
    const tag = s.narrativeTag || 'UNTAGGED';
    const g = byTag[tag] || (byTag[tag] = { tag, n: 0, wins: 0 });
    g.n++; if (s.won) g.wins++;
  }
  const narrativeBreakdown = Object.values(byTag)
    .map(g => ({ tag: g.tag, n: g.n, winRate: Math.round((g.wins / g.n) * 100), significant: g.n >= 30 }))
    .sort((a, b) => b.n - a.n);

  // Active recalibrated model (if any) + standing ablation-review flags.
  const model = await readModel();
  const active = model.activeId ? model.versions.find(v => v.id === model.activeId) : null;
  const narrative = await readNarrative();

  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  return res.json({
    configured: true,
    status,
    minSignals: 15,
    totalSignals: sigs.length,
    resolvedCount: resolved.length,
    windowCount: window.length,
    windowMode: window.length === resolved.length ? 'all-resolved' : 'trailing-60d',
    openCount,
    live,
    baseline,
    regimeMix: regimeMix(window),
    forensics,
    failCount: fails.length,
    narrativeBreakdown,
    narrative,
    model: active ? { id: active.id, label: active.label, effectiveDate: active.effectiveDate } : null,
    ablationFlags: (active && active.ablationFlags) || [],
    recommendRecalibration: status === 'BROKEN',  // auto-recalibration hook (Module 2)
    generatedAt: new Date().toISOString(),
  });
}

// ── op=recalibrate : Module 2 walk-forward re-optimization ─────────────────
function quarterOf(d) { return `${d.getUTCFullYear()}.Q${Math.floor(d.getUTCMonth() / 3) + 1}`; }

// Flag a pillar whose marginal contribution stayed negative across the last two
// recalibrations (review, don't auto-zero).
function ablationFlagsFor(diag, prevVersion) {
  const flags = [];
  for (const R of ['RISK_ON', 'NEUTRAL', 'RISK_OFF']) {
    const cur = diag.regimes[R];
    if (!cur || !cur.ablation) continue;
    const prevAbl = prevVersion && prevVersion.regimes && prevVersion.regimes[R] && prevVersion.regimes[R].ablation;
    for (const a of cur.ablation) {
      if (a.marginal >= 0) continue;
      const p = prevAbl && prevAbl.find(x => x.key === a.key);
      if (p && p.marginal < 0) flags.push({ regime: R, pillar: a.key, label: a.label, note: 'negative marginal 2 recalibrations running — review' });
    }
  }
  return flags;
}

async function runRecalibrate(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  // Data source: live ledger (default), the historical backfill seed, or both.
  // The backfill's Pillar 3 is synthetic, so any source that includes it pins P3.
  const source = ['live', 'backfill', 'all'].includes(req.query.source) ? req.query.source : 'live';
  const pick = s => ({ regime: s.regime, pillars: s.pillars, status: s.status, date: s.date, won: s.won, r: s.r });
  let dataset = [], resolvedCount = 0;
  if (source !== 'backfill') { const { resolved } = await resolveLedger(); resolvedCount = resolved.length; dataset = dataset.concat(resolved.map(pick)); }
  if (source !== 'live') { const bf = await readBackfill(); if (bf && Array.isArray(bf.signals)) dataset = dataset.concat(bf.signals.map(pick)); }
  const usesBackfill = source !== 'live';
  const diag = recalibrate(dataset, usesBackfill ? { fixed: ['p3'] } : {});
  const resolved = dataset; // for the response counts below

  // Trim per-regime diagnostics for storage (keep weights, PFs, ablation).
  const regimes = {};
  for (const R of ['RISK_ON', 'NEUTRAL', 'RISK_OFF']) {
    const g = diag.regimes[R];
    regimes[R] = { fitted: g.fitted, reason: g.reason, n: g.n, weights: g.weights, full: g.full, validation: g.validation, ablation: g.ablation };
  }

  const model = await readModel();
  const prev = model.versions[model.versions.length - 1] || null;
  const now = new Date();
  let saved = false, version = null;

  const srcLabel = source === 'backfill' ? 'backfill-seed' : source === 'all' ? 'live+backfill seed' : 'live-ledger';
  if (diag.fittedAny) {
    const n = model.versions.length + 1;
    version = {
      id: `${BASE_VERSION}.${n}`,
      label: `Model ${BASE_VERSION} · recalibrated ${now.toISOString().slice(0, 10)}${usesBackfill ? ' (seed)' : ''}`,
      effectiveDate: now.toISOString().slice(0, 10),
      createdAt: now.toISOString(),
      quarter: quarterOf(now),
      source: srcLabel,
      fixed: usesBackfill ? ['p3'] : [],
      weights: diag.weights,
      regimes,
      fittedAny: true,
      ablationFlags: ablationFlagsFor(diag, prev),
    };
    model.versions.push(version);
    model.activeId = version.id;
  }
  model.lastRun = {
    at: now.toISOString(),
    source: srcLabel,
    samples: dataset.length,
    resolved: resolvedCount,
    fittedAny: diag.fittedAny,
    perRegime: Object.fromEntries(['RISK_ON', 'NEUTRAL', 'RISK_OFF'].map(R => [R, { fitted: regimes[R].fitted, reason: regimes[R].reason, n: regimes[R].n }])),
  };
  let err = null;
  try { await writeModel(model); saved = true; } catch (e) { err = String(e && e.message || e); }

  return res.status(err ? 502 : 200).json({
    ok: !err, saved, error: err,
    source: srcLabel,
    refit: diag.fittedAny,
    activeId: model.activeId,
    version,
    diagnostics: { fittedAny: diag.fittedAny, minSignals: diag.minSignals, regimes },
    totalSamples: dataset.length,
    totalResolved: resolvedCount,
    at: now.toISOString(),
  });
}

// ── op=research : factor-efficacy analysis (which factors predict outcomes) ──
async function runResearchOp(req, res) {
  const scope = ['large', 'small', 'micro'].includes(req.query.scope) ? req.query.scope : 'large';
  const step = Math.min(63, Math.max(5, parseInt(req.query.step, 10) || 10));
  const months = Math.min(18, Math.max(3, parseInt(req.query.months, 10) || 12));
  const limit = Math.max(0, parseInt(req.query.limit, 10) || 0);
  try {
    const out = await runResearch({ scope, step, months, limit, deadlineMs: 50000 });
    // Persist so op=baselines (and any reader) gets the factor cross-section cheaply
    // without re-running the ~50s scan on every page load.
    if (hasStore()) { try { await writeJSON(`research/factors-${scope}.json`, { scope, step, months, ...out }, 0); } catch { /* best-effort */ } }
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.json({ ok: true, scope, step, months, ...out });
  } catch (e) { return res.status(502).json({ ok: false, error: String(e && e.message || e) }); }
}

// ── op=moverstudy : reveal which strategies/signals catch the biggest movers ──
// Heavy reconstruction → cached to Blob. Default returns the cached study (fast);
// &run=1 recomputes (point-in-time replay over the universe) and re-caches.
const moverStudyKey = scope => `research/moverstudy-${scope}.json`;
async function runMoverStudyOp(req, res) {
  const scope = ['large', 'small', 'micro'].includes(req.query.scope) ? req.query.scope : 'large';
  if (req.query.run !== '1') {
    const cached = await readJSON(moverStudyKey(scope), null).catch(() => null);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, cached: !!cached, ...(cached || { empty: true }) });
  }
  const minMovePct = Math.min(100, Math.max(10, parseInt(req.query.minMove, 10) || 30));
  const months = Math.min(18, Math.max(3, parseInt(req.query.months, 10) || 18));
  const limit = Math.max(0, parseInt(req.query.limit, 10) || 0);
  try {
    const out = await runMoverStudy({ scope, step: 21, months, minMovePct, limit, deadlineMs: 50000 });
    if (hasStore()) { try { await writeJSON(moverStudyKey(scope), out, 0); } catch { /* best-effort */ } }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, cached: false, ...out });
  } catch (e) { return res.status(502).json({ ok: false, error: String(e && e.message || e) }); }
}

// ── op=emerging : emerging-leader ADMISSION study — should the screener admit
//    emergingLeader names that lack a base-pattern status? (5y, per-regime/year) ──
async function runEmergingOp(req, res) {
  const scope = ['large', 'small', 'micro'].includes(req.query.scope) ? req.query.scope : 'large';
  try {
    const out = await runEmergingStudy({ scope, step: 21, months: 54, range: '5y', deadlineMs: 50000 });
    const doc = { scope, ...out, generatedAt: new Date().toISOString() };
    if (hasStore()) { try { await writeJSON(`apex/emerging-${scope}.json`, doc, 0); } catch { /* best-effort cache */ } }
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.json({ ok: true, ...doc });
  } catch (e) { return res.status(502).json({ ok: false, error: String(e && e.message || e) }); }
}

// ── op=exits : exit-strategy study (which exit makes the edge profitable) ──
async function runExitsOp(req, res) {
  const scope = ['large', 'small', 'micro'].includes(req.query.scope) ? req.query.scope : 'large';
  try {
    // 5y / quarterly so the regime + out-of-sample breakdown spans a real bear market.
    const out = await runExitStudy({ scope, step: 21, months: 54, range: '5y', deadlineMs: 50000 });
    const doc = { scope, ...out, generatedAt: new Date().toISOString() };
    if (hasStore()) { try { await writeExits(doc); } catch { /* best-effort cache */ } }
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.json({ ok: true, ...doc });
  } catch (e) { return res.status(502).json({ ok: false, error: String(e && e.message || e) }); }
}

// ── op=longshort : market-neutral selection test (is there security-selection edge?) ──
async function runLongShortOp(req, res) {
  const scope = ['large', 'small', 'micro'].includes(req.query.scope) ? req.query.scope : 'large';
  try {
    const out = await runLongShort({ scope, step: 21, months: 54, range: '5y', fracs: [0.1, 0.2], deadlineMs: 50000 });
    const doc = { ...out, generatedAt: new Date().toISOString() };
    if (hasStore()) { try { await writeLongShort(doc); } catch { /* best-effort */ } }
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.json({ ok: true, ...doc });
  } catch (e) { return res.status(502).json({ ok: false, error: String(e && e.message || e) }); }
}

// ── op=pead : post-earnings-drift test (event-driven edge) ──
async function runPeadOp(req, res) {
  const scope = ['large', 'small', 'micro'].includes(req.query.scope) ? req.query.scope : 'large';
  const months = Math.min(60, Math.max(12, parseInt(req.query.months, 10) || 54));
  const limit = Math.max(0, parseInt(req.query.limit, 10) || 0);
  try {
    if (req.query.mode === 'reaction') {  // 5y validation via announcement-day reaction proxy
      const rx = await runReactionPEAD({ scope, limit: limit || 150, deadlineMs: 55000 });
      if (hasStore() && rx.horizons && rx.horizons['63']) {
        try { const pd = (await readPead()) || {}; pd.validation5y = { events: rx.events, coverage: rx.coverage, signed63: rx.horizons['63'].signedOverall, top63: rx.horizons['63'].topQuintile, byYear63: rx.horizons['63'].byYear, generatedAt: new Date().toISOString() }; await writePead(pd); } catch {}
      }
      return res.json({ ok: !rx.error, ...rx });
    }
    const out = await runPEAD({ scope, months, limit, perSymbol: req.query.persymbol === '1', datesOnly: req.query.datesonly === '1', deadlineMs: 55000 });
    if (hasStore() && out.horizons && !limit) { try { await writePead({ ...out, scope, generatedAt: new Date().toISOString() }); } catch { /* best-effort */ } }
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.json({ ok: !out.error, ...out });
  } catch (e) { return res.status(502).json({ ok: false, error: String(e && e.message || e) }); }
}

// ── Trade-alert ranker ops (raw posts come from an external collector) ───────
// 🐦 X-alerts handlers (alertsingest/alerts/alertsgrade) live in lib/alerts-routes.js.


// ── op=backfill : seed the ledger with historical technical-pillar signals ──
async function runBackfillOp(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  const scope = ['large', 'small', 'micro'].includes(req.query.scope) ? req.query.scope : 'large';
  const step = Math.min(63, Math.max(5, parseInt(req.query.step, 10) || 10));
  const months = Math.min(18, Math.max(3, parseInt(req.query.months, 10) || 12));
  const limit = Math.max(0, parseInt(req.query.limit, 10) || 0);
  let out, err = null;
  try {
    out = await runBackfill({ scope, step, months, limit, deadlineMs: 50000 });
    await writeBackfill({ signals: out.signals, stats: out.stats, scope, step, months, generatedAt: new Date().toISOString() });
  } catch (e) { err = String(e && e.message || e); }
  return res.status(err ? 502 : 200).json({ ok: !err, error: err, scope, step, months, stats: out && out.stats, at: new Date().toISOString() });
}

// ── op=model : active weights + version + narrative (consumed by the client) ─
async function runModel(req, res) {
  const model = await readModel();
  const narrative = await readNarrative();
  const bf = await readBackfill();
  const exits = await readExits();
  const ls = await readLongShort();
  const pead = await readPead();
  const active = model.activeId ? model.versions.find(v => v.id === model.activeId) : null;
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
  return res.json({
    configured: hasStore(),
    baseVersion: BASE_VERSION,
    active: active ? { id: active.id, label: active.label, effectiveDate: active.effectiveDate, source: active.source, ablationFlags: active.ablationFlags || [] } : null,
    weights: active ? active.weights : null,            // null → client uses static Module 1 presets
    regimes: active ? active.regimes : null,            // per-regime fit detail for the panel
    lastRun: model.lastRun || null,
    narrative,
    backfill: bf ? { signals: (bf.signals || []).length, generatedAt: bf.generatedAt, stats: bf.stats } : null,
    exits: exits ? {
      summary: exits.summary, selections: exits.selections, scope: exits.scope, range: exits.range, generatedAt: exits.generatedAt,
      byRegime: exits.byRegime || null,
      quartersProfitable: exits.byQuarter ? exits.byQuarter.filter(q => q.time63 && q.time63.pf >= 1).length : null,
      quartersTotal: exits.byQuarter ? exits.byQuarter.length : null,
    } : null,
    longshort: ls && ls.fractions && ls.fractions['0.1'] ? { decile: ls.fractions['0.1'], range: ls.range, generatedAt: ls.generatedAt } : null,
    pead: pead && pead.horizons ? { resolvedEvents: pead.resolvedEvents, coverage: pead.coverage, h63: pead.horizons['63'], h21: pead.horizons['21'], validation5y: pead.validation5y || null, generatedAt: pead.generatedAt } : null,
    versionsCount: model.versions.length,
  });
}

// ── op=narrative : weekly dominant-market-narrative tag (sentiment layer) ───
const NARRATIVE_TAGS = ['RATE_CUTS_HOPE', 'RATE_HIKE_FEAR', 'AI_CAPEX', 'EARNINGS_SEASON', 'RECESSION_FEAR', 'INFLATION_FOCUS', 'SOFT_LANDING', 'RISK_RALLY', 'GEOPOLITICS', 'CREDIT_STRESS', 'OTHER'];

function mondayOf(d) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = x.getUTCDay(); // 0=Sun
  x.setUTCDate(x.getUTCDate() - ((day + 6) % 7));
  return x.toISOString().slice(0, 10);
}

async function runNarrative(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  const weekOf = mondayOf(new Date());
  const existing = await readNarrative();
  if (existing && existing.weekOf === weekOf && req.query.force !== '1') {
    return res.status(200).json({ ok: true, cached: true, narrative: existing });
  }
  const newsKey = process.env.NEWS_API_KEY, anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!newsKey || !anthropicKey) return res.status(200).json({ ok: false, error: 'NEWS_API_KEY / ANTHROPIC_API_KEY not configured.' });

  let titles = [];
  try {
    const q = '"Federal Reserve" OR inflation OR "interest rates" OR recession OR "earnings season" OR "AI spending" OR jobs OR CPI OR "stock market" OR rally OR selloff';
    const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&language=en&sortBy=publishedAt&pageSize=40&apiKey=${newsKey}`;
    const r = await fetch(url); const d = await r.json();
    titles = (d.articles || []).map(a => a.title).filter(t => t && t !== '[Removed]').slice(0, 40);
  } catch { /* fall through */ }
  if (!titles.length) return res.status(200).json({ ok: false, error: 'no headlines available' });

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: anthropicKey });
  const TOOL = {
    name: 'tag_narrative',
    description: 'Identify the single dominant market narrative of the week.',
    input_schema: { type: 'object', properties: {
      tag: { type: 'string', enum: NARRATIVE_TAGS },
      label: { type: 'string', description: '3-5 word human label' },
      summary: { type: 'string', description: 'one-sentence summary' },
    }, required: ['tag', 'label', 'summary'] },
  };
  let input = null;
  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 400,
      tools: [TOOL], tool_choice: { type: 'tool', name: 'tag_narrative' },
      messages: [{ role: 'user', content: `From this week's market headlines, identify the SINGLE dominant market narrative and choose the best tag.\n\nHEADLINES:\n${titles.join('\n')}` }],
    });
    const t = msg.content.find(b => b.type === 'tool_use');
    if (t) input = t.input;
  } catch (e) { return res.status(200).json({ ok: false, error: String(e && e.message || e) }); }
  if (!input || !NARRATIVE_TAGS.includes(input.tag)) return res.status(200).json({ ok: false, error: 'no valid tag returned' });

  const narrative = { tag: input.tag, label: input.label, summary: input.summary, weekOf, updatedAt: new Date().toISOString() };
  let err = null;
  try { await writeNarrative(narrative); } catch (e) { err = String(e && e.message || e); }
  return res.status(err ? 502 : 200).json({ ok: !err, error: err, narrative });
}

module.exports = { runTrack, runScoreboard, runApexLog, runGhostLog, runEdgeLog, runEdgeBook, runVReversal, runVReversalTest, runDrift, runRecalibrate, runResearchOp, runExitsOp, runEmergingOp, runLongShortOp, runPeadOp, runBackfillOp, runModel, runNarrative, forwardReturn, forwardPath, nextOpenReturn, spyForwardReturn, summarizeReturns, summarizePlans, cernPicksFrom, fadeRowsFrom, regimeBucketOf, runMoverStudyOp, runCernDecay, ledgerWriteDecision, runRankQuality };

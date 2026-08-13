const { internalHeaders } = require('./auth');
// APEX/TRACK CORE ROUTE HANDLERS — the original heart of the app (track,
// scoreboard, apexlog, ghostlog, edge, vreversal, drift, recalibrate, research,
// exits, longshort, pead, backfill, model, narrative). Extracted from tracker.js.
const { fetchOptionsBaseline } = require('./options-baseline');
const { fetchQuarterlySeries } = require('./earnings');
const { COST_MODEL_VERSION, roundTripCostPct, tierForPick, borrowCost } = require('./costs');
const { createEpisodeMap, EPISODES_VERSION } = require('./scoreboard-episodes');
const { PICKSCORE_VERSION, pointInTimeStrength, toPercentiles } = require('./pickscore');
const sectionscore = require('./sectionscore');
const { benchFor: sectorBenchFor } = require('./readthrough'); // GICS sector → SPDR sector ETF
const { CERN } = require('./cern');
const { LARGE: UNI_LARGE, SMALL_CAPS: UNI_SMALL, MICRO_CAPS: UNI_MICRO, SECTOR_OF } = require('./universe');
const { writeDay, readAllPicks, hasStore, writeApexDay, readAllApex, writeGhostDay, readAllGhost, readAllEvidence, readAllIgnition, readAllOmega, readAllTone, readAllAttention, writeArchiveDay,
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
        readAllGapDays, readAllReadThroughDays, readAllGridlockDays, readAllAnomalyDays, readAllBiotechDays, readAllSecondWaveDays, readAllCrossAssetDays, readAllToneShiftDays,
        readAllDownDays, readAllGapDownDays, readAllCoilDays, readJSON, writeJSON, readDayCount,
        readAllPeerPropDays, readAllUnderreactionDays, readAllExpGapDays,
        writeGhostObsDay } = require('./store');
const { computeAllocation } = require('./allocation');
const { mapLimit } = require('./map-limit');
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
const { runPEAD, runReactionPEAD, runSurprisePEAD } = require('./pead');
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
    // Decision-time sector stamp: grading used to reconstruct the sector from
    // TODAY'S SECTOR_OF map even for years-old picks — a silent current-for-
    // historical substitution (a sector reassignment rewrote past attribution).
    // Stamped here, the pick's own record is point-in-time; sectorEtfFor prefers
    // p.bench and falls back to the live map only for legacy rows.
    if (rec.bench == null) {
      rec.sector = rec.sector ?? (SECTOR_OF[rec.ticker] || null);
      rec.bench = sectorBenchFor(rec.sector) || null;
    }
    picks.push(rec);
  };

  let sourceErrors = 0;
  for (const scope of ['large', 'small', 'micro']) {
    try {
      const d = await getJSON('/api/screener?scope=' + scope + (scope === 'large' ? '&lookback=1M' : ''));
      (d.results || []).forEach(r => {
        if (!r.ticker || r.price == null) return;
        if (r.status) {
          add({ date, ts, ticker: r.ticker, company: r.company || null, section: 'screener', tier: r.status, scope, entry: r.price, signalVersion: 'screener-v2' });
        } else if (r.emergingLeader) {
          // Defect #1: standalone Emerging Leaders (no base-pattern status) were
          // silently unlogged — no track record could ever accrue. Captured under
          // their OWN scoped evidence identity (shadow strategy; grading only —
          // the live board still cannot be originated or boosted by them).
          add({ date, ts, ticker: r.ticker, company: r.company || null, section: 'EmergingLeader', tier: 'EmergingLeader', scope, entry: r.price, signalVersion: 'emergingleader-v1' });
        }
      });
    } catch { sourceErrors++; /* scope failed — skip */ }
  }
  try {
    const d = await getJSON('/api/momentum');
    (d.strongBuys || []).forEach(c => c.price != null &&
      add({ date, ts, ticker: c.ticker, company: c.company || null, section: 'momentum', tier: 'StrongBuy', scope: null, entry: c.price, signalVersion: 'momentum-v2' }));
    (d.strongSells || []).forEach(c => c.price != null &&
      add({ date, ts, ticker: c.ticker, company: c.company || null, section: 'momentum', tier: 'StrongSell', scope: null, entry: c.price, signalVersion: 'momentum-v2' }));
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
// '3d' added (non-daytrade redesign 2026-08, Phase 7): the Down-Day sleeve's CONTRACT is a
// three-session red-tape bounce and its evidence (research/42-43) is measured at 3 sessions,
// but the Scoreboard had no 3-session bucket — so it was graded at 5d, an objective the
// strategy never claimed. Purely additive: every existing horizon key is untouched.
const HORIZONS = [['1d', 1], ['3d', 3], ['5d', 5], ['10d', 10], ['20d', 20], ['1m', 21], ['3m', 63]];
const BIG_WIN_PCTS = [10, 20]; // favorable-excursion thresholds (%) for "big winner" rates

// mtm-v1: the "open position" boundary — a pick younger than this many sessions is
// marked to the latest close in the Scoreboard's mtm lane instead of being dropped.
const MTM_BARS = 21;

// Common-date view over one group: resolved 1m nets + open positions marked at the
// latest close. The combined mean is the number resolved-only accounting hides —
// unmatured picks are in it from day one.
function mtmSummary(g) {
  const open = g.mtmOpen || [];
  const resolved = (g.h['1m'] || []).map(r => r.net).filter(Number.isFinite);
  if (!open.length && !resolved.length) return null;
  const openNets = open.map(o => o.net).filter(Number.isFinite);
  const avg = a => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null);
  return {
    version: 'mtm-v1', horizon: '1m',
    openN: open.length, resolvedN: resolved.length,
    openAvgNet: avg(openNets),
    resolvedAvgNet: avg(resolved),
    combinedAvgNet: avg([...resolved, ...openNets]),
    basis: 'per-pick mean; open positions marked at the latest close under the section entry basis, net of full round-trip cost; dividends and cash drag NOT modeled',
  };
}

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
// `opts.entryBasis === 'next-open'` (entry-v2, non-daytrade redesign): the entry is the
// NEXT session's open instead of the logged level / signal-day close — an EOD signal is
// computed FROM the close, so the close is not an executable primary entry (Phase-1
// rule 1). Only sections whose contract fillPolicy is next-session-open opt in; the
// default is byte-identical legacy behavior (Day Trade's section stays on it, frozen).
function forwardPath(candles, pick, bars, opts = {}) {
  let idx = -1;
  for (let k = 0; k < candles.length; k++) { if (candles[k].date <= pick.date) idx = k; else break; }
  if (idx < 0) return null;
  const tgt = idx + bars;
  if (tgt >= candles.length) return null; // horizon hasn't elapsed yet
  const isShort = pick.tier === 'StrongSell' || pick.short;
  let entry;
  let startIdx = idx + 1;   // first bar of the excursion walk (the fill bar for conditionals)
  let fillMeta = null;
  if (opts.entryBasis === 'next-open') {
    const eBar = candles[idx + 1];
    if (!eBar) return null; // no next session yet — unresolved, never a fabricated fill
    entry = (eBar.open != null && eBar.open > 0) ? eBar.open : eBar.close;
  } else if (opts.entryBasis === 'trigger-verified') {
    // entry-v2.1 (conditional contracts — Phase-1 rules 2-4): an intended trigger level
    // is not a fill. Walk the sessions after the signal date on daily bars: a gap past
    // the chase ceiling is a GAP-SKIP (terminal — the plan's price is gone, mirrors
    // lib/gapgo-verify); an open through the trigger fills at the WORSE open; a trigger
    // traded intra-bar fills at the trigger; a trigger never reached inside the horizon
    // is a NO-FILL. Statuses are returned (not null) so the summarizer can count honest
    // denominators instead of pretending every plan traded. A row with no verifiable
    // trigger level returns null — ungradeable, never approximated from a non-trigger
    // price. Fill-time within the bar is unknowable from daily data, so the fill-bar's
    // full range enters MFE/MAE — a documented daily-bar approximation, not a fill claim.
    const trigger = pick.trigger !== undefined ? pick.trigger : pick.entry;
    if (!(trigger > 0)) return null;
    const { CHASE_CEILING_PCT } = require('./gapgo-verify');
    const ceiling = isShort ? trigger * (1 - CHASE_CEILING_PCT / 100) : trigger * (1 + CHASE_CEILING_PCT / 100);
    let fillIdx = -1, fillPx = null, atOpen = false;
    for (let k = idx + 1; k <= tgt; k++) {
      const c = candles[k];
      const o = (c.open != null && c.open > 0) ? c.open : c.close;
      const hi = c.high != null ? c.high : c.close;
      const lo = c.low != null ? c.low : c.close;
      if (isShort ? o <= ceiling : o >= ceiling) return { fillStatus: 'gap-skip', ret: null, mfe: null, mae: null };
      if (isShort ? o <= trigger : o >= trigger) { fillIdx = k; fillPx = o; atOpen = true; break; }
      if (isShort ? lo <= trigger : hi >= trigger) { fillIdx = k; fillPx = trigger; break; }
    }
    if (fillIdx < 0) return { fillStatus: 'no-fill', ret: null, mfe: null, mae: null };
    entry = fillPx; startIdx = fillIdx;
    fillMeta = { fillStatus: 'filled', fillDate: candles[fillIdx].date, filledAtOpen: atOpen };
  } else {
    entry = pick.entry || candles[idx].close;
  }
  if (!entry) return null;
  let ret = ((candles[tgt].close - entry) / entry) * 100;
  if (isShort) ret = -ret;
  // Walk the intra-hold path once for BOTH excursions: MFE = the best the trade ever
  // ran in your favor before the horizon; MAE = the worst it was ever underwater. Both
  // are reported as POSITIVE magnitudes and are direction-aware (a short's favorable
  // move is a fall, its adverse move is a rally). MAE is the honest "how much heat did
  // you take to earn this?" — the pain a flat average return hides.
  let mfe = 0, mae = 0;
  for (let k = startIdx; k <= tgt; k++) {
    const c = candles[k];
    const hi = c.high != null ? c.high : c.close;
    const lo = c.low != null ? c.low : c.close;
    const fav = isShort ? ((entry - lo) / entry) * 100 : ((hi - entry) / entry) * 100;
    const adv = isShort ? ((hi - entry) / entry) * 100 : ((entry - lo) / entry) * 100;
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;
  }
  return fillMeta ? { ret, mfe, mae, ...fillMeta } : { ret, mfe, mae };
}

// REALISTIC-ENTRY forward return (entry-v1). The close-based measures above enter at
// the SIGNAL DAY's close — but an EOD screen is COMPUTED from that close, so it can't
// actually be traded (same-bar look-ahead). The first achievable price is the NEXT
// session's OPEN. Entry = open[idx+1]; the exit is held at the SAME close[idx+bars] as
// the close-based measure, so (real − closeBased) is a clean entry-timing DRAG — the
// overnight gap you pay to get in. Only meaningful for picks WITHOUT a logged entry
// (those already reflect an intended tradeable price); the caller gates on !pick.entry.
const ENTRY_MODEL_VERSION = 'entry-v1';   // versions the r.real (next-open diagnostic) lane — unchanged
const ENTRY_BASIS_VERSION = 'entry-v2.2'; // versions the PRIMARY grading basis policy below
// entry-v2 basis policy: read each section's OWN contract. Sections whose fillPolicy
// declares next-session-open are graded from the next open with a basis-consistent
// benchmark. entry-v2.1: conditional-trigger contracts (coil 'conditional on trigger',
// gapdown 'stop-through-trigger') are graded TRIGGER-VERIFIED on daily bars — no-fill
// when the trigger never trades inside the horizon, gap-skip past the chase ceiling,
// gap-through filled at the worse open — instead of assuming the intended level filled.
// entry-v2.2 (2026-08-11): the ~23 remaining sections — lead-only and legacy contracts —
// now DEFAULT to next-open instead of the signal-day close. An EOD signal is computed
// FROM that close, so the close was never an executable price; a lead-only sleeve is
// still a PROXY (fillVerified stays false, labels keep saying PROXY), but the proxy is
// priced at the first executable print. The Scoreboard recomputes from ledgers on every
// run, so the whole history re-grades under this basis — a deliberate, versioned change.
// The daytrade section is pinned to legacy (FROZEN — nothing here may alter Day Trade's
// displayed record).
function entryBasisForSection(section) {
  if (!section || section === 'daytrade') return null;
  const c = require('./strategy-contracts').contractForSection(section);
  if (c && typeof c.fillPolicy === 'string') {
    if (c.fillPolicy.startsWith('next-session-open')) return 'next-open';
    if (c.fillPolicy.startsWith('stop-through-trigger') || c.fillPolicy.startsWith('conditional on trigger')) return 'trigger-verified';
  }
  return 'next-open';
}
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
function spyForwardReturn(spyCandles, pick, bars, opts = {}) {
  if (!Array.isArray(spyCandles) || !spyCandles.length) return null;
  let idx = -1;
  for (let k = 0; k < spyCandles.length; k++) { if (spyCandles[k].date <= pick.date) idx = k; else break; }
  if (idx < 0) return null;
  const tgt = idx + bars;
  if (tgt >= spyCandles.length) return null; // horizon hasn't elapsed yet
  // Basis-consistent benchmark: when the pick enters at the next open, the benchmark
  // must be measured from ITS next open too, or the overnight gap pollutes the excess.
  let start;
  if (opts.entryBasis === 'next-open') {
    const eBar = spyCandles[idx + 1];
    if (!eBar) return null;
    start = (eBar.open != null && eBar.open > 0) ? eBar.open : eBar.close;
  } else if (opts.entryBasis === 'trigger-verified') {
    // Basis-consistent benchmark for a VERIFIED conditional fill: anchor the benchmark
    // at the FILL date — its open for a gap-through fill, its close for an intra-session
    // trigger touch (the closest daily-bar proxy for an unknowable intraday fill time;
    // documented approximation, same horizon-end close as the trade leg).
    if (!opts.anchorDate) return null;
    let aIdx = -1;
    for (let k = 0; k < spyCandles.length; k++) { if (spyCandles[k].date <= opts.anchorDate) aIdx = k; else break; }
    if (aIdx < 0) return null;
    const aBar = spyCandles[aIdx];
    start = (opts.anchorAtOpen && aBar.open != null && aBar.open > 0) ? aBar.open : aBar.close;
  } else {
    start = spyCandles[idx].close;
  }
  if (!start) return null;
  return ((spyCandles[tgt].close - start) / start) * 100;
}

// The series every pick is graded against unless its section names a sector ETF.
const MARKET_BENCH_SYMBOL = 'SPY';

// A pick cannot be graded against itself. When the traded INSTRUMENT is the
// benchmark series, "excess" stops measuring skill and becomes a restatement of
// the benchmark's own return:
//
//   long  →  exc = spyRet - spyRet         = 0 identically
//   short →  exc = (-spyRet) - (+spyRet)   = -2 x spyRet
//
// The short case is the dangerous one: the direction flip is applied to the pick
// leg but not the benchmark leg, so the channel moves, carries a sign, and reads
// like alpha while no forecast could ever change it. ExpGap logs one short-framed
// SPY row per RISK_REDUCE day (lib/expgap-routes.js), so every excess figure that
// section ever published was this artifact. Any section that logs the ETF it is
// benchmarked against hits the same degeneracy, hence the general test.
function isSelfBenchmarked(ticker, benchSymbol) {
  if (!ticker || !benchSymbol) return false;   // unknown ≠ identical — never suppress on ignorance
  return String(ticker).trim().toUpperCase() === String(benchSymbol).trim().toUpperCase();
}

// One benchmark-relative channel, fail-closed. Null when self-benchmarked, when
// the benchmark history is missing, or when the horizon hasn't resolved — the
// summaries filter nulls out, so a suppressed channel shrinks its denominator
// rather than fabricating a zero.
function excessOrNull(ret, benchRet, selfBenchmarked) {
  if (selfBenchmarked) return null;
  if (benchRet == null || !Number.isFinite(benchRet) || !Number.isFinite(ret)) return null;
  return +(ret - benchRet).toFixed(2);
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

// Evidence-identity tier for an ignition ledger row at Scoreboard READ time: rows the
// backfill job reconstructed from history (`backfill: true`) grade under HIST_* tiers —
// a separate identity the maturity grader excludes from the promoted policy. The ledger
// itself is immutable; only the read-time classification changed.
function ignitionLedgerTier(p) {
  return p && p.backfill === true ? `HIST_${p.tier}` : (p && p.tier);
}

// Evidence-identity tier for a momentum ledger row at Scoreboard READ time. The 2026-07
// momentum-v2 rebuild changed the universe and contract (position→intraday) and declared
// that v1 evidence does not transfer — but v1 and v2 rows share section/tier strings, so
// without reclassification the pooled record would mix eras (and the registry's old
// policyTiers ['momentum'] matched nothing, leaving governance permanently blind).
// Rows not stamped with the registry's current momentum scoringVersion grade under
// HIST_* — reportable research lanes the maturity grader excludes from the policy.
const MOMENTUM_LIVE_VERSION =
  (require('./strategy-registry').STRATEGY_REGISTRY.find(e => e.id === 'momentum') || {}).scoringVersion || 'momentum-v2';
function momentumLedgerTier(p) {
  if (!p || !p.tier) return p && p.tier;
  return p.signalVersion === MOMENTUM_LIVE_VERSION ? p.tier : `HIST_${p.tier}`;
}
// Full row remap for the fold: the forward-return resolvers invert shorts on the EXACT
// tier string 'StrongSell' (or pick.short), so a HIST_StrongSell row must carry
// short:true or the historical lane's whole short cohort grades sign-flipped as longs.
function momentumLedgerRow(p) {
  const tier = momentumLedgerTier(p);
  if (tier === p.tier) return p;
  return { ...p, tier, short: p.short === true || p.tier === 'StrongSell' };
}

// DATE-LEVEL portfolio statistics over the NET-excess channel (maturity-v2/v3).
// Groups rows by decision date, equal-weights each date's picks into one portfolio
// return, and summarizes ACROSS dates: n (independent dates), mean, sd, and a 95%
// CI on the mean. This is the honest independence unit — same-day picks share the
// market factor and must not be counted as separate observations.
//
// maturity-v3: consecutive decision dates with an overlapping h-bar label share most
// of the same return path, so an IID 1.96·sd/√n interval is too narrow at exactly the
// horizons the promotion gate leans on (5/21/63 sessions). The standard error is now
// Newey-West (Bartlett, lags ≈ horizonBars−1) over the CHRONOLOGICAL date series, and
// never narrower than the naive IID SE (small-sample HAC can under-estimate; the gate
// must only ever get wider, not tighter, from the correction).
// Returns null when fewer than 2 dates carry the net-excess channel.
//
// redesign Phase 5: the whole calculation now runs through lib/evidence-stats.js, so the
// average, the interval, the effective sample size and the block-stability read are all
// derived from ONE deduplicated date series. Additions over maturity-v3: an effective
// sample size (df for a Student-t critical value instead of a flat 1.96 — decisive at the
// small samples these gates actually see), a seeded moving-block bootstrap interval, and
// the reported ci95 is the WIDER of the two (a correction may only widen a gate).
function dateLevelNetExcess(arr, { horizonBars = null } = {}) {
  const ES = require('./evidence-stats');
  const ded = ES.dedupeToDateSeries(arr || [], { pickValue: (r) => (r.netMktExc != null && Number.isFinite(r.netMktExc)) ? r.netMktExc : r.netExc, pickDate: (r) => r.date });
  const summary = ES.summarizeDateSeries(ded.series, { horizonBars });
  if (!summary) return null;
  return {
    n: summary.n,
    avg: summary.avg,
    sd: summary.sd,
    // Dependence-aware STANDARD ERROR (HAC/Newey-West, widened). Forwarded because
    // lib/evidence-stats.pValueOf needs avg AND se to produce a p-value, and the
    // registry-wide Benjamini-Hochberg pass in lib/maturity keys off that p-value.
    // Omitting it made the FDR family silently EMPTY in production (`fdr.tested: 0`)
    // while every unit test passed, because the test fixtures supplied `se` by hand.
    // The ci95 bounds cannot substitute: they are the widest of Student-t and a
    // moving-block bootstrap, so back-solving an se from them would misstate it.
    se: summary.se,
    ci95: summary.ci95,
    // Dependence-aware additions (displayed alongside maturity per Phase 5 item 8).
    effectiveN: summary.effectiveN,
    tCritical: summary.tCritical,
    bootstrapCI: summary.bootstrapCI,
    blockStability: summary.blockStability,
    positiveBlocks: summary.positiveBlocks,
    observations: ded.observations,
    seBasis: summary.seBasis,
    ciBasis: summary.ciBasis,
    basis: 'equal-weight per-date portfolio of net excess vs SPY (one observation per decision date)',
  };
}

// arr = forwardPath results [{ ret, mfe }]. Beyond the existing expectancy/win
// figures it now reports "big winner" reach: avg MFE plus the share of signals
// whose best run-up crossed +10% / +20% before the horizon — measuring which
// models catch large moves vs. which only grind out small averages.
function summarizeReturns(arr, opts = {}) {
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
  // MARKET channel prefers `mktExc` (always vs SPY): for SECTOR_BENCH sections the
  // legacy `exc` is vs the sector ETF, which made "beats SPY" a sector claim. Legacy
  // rows without the channel fall back to `exc` and are COUNTED in mktLegacyN so a
  // mixed basis is visible, never silent.
  const excs = arr.map(x => (x.mktExc != null && Number.isFinite(x.mktExc)) ? x.mktExc : x.exc).filter(x => x != null && Number.isFinite(x));
  const mktLegacyN = arr.filter(x => (x.mktExc == null || !Number.isFinite(x.mktExc)) && x.exc != null && Number.isFinite(x.exc)).length;
  const beat = excs.filter(x => x > 0).length;
  // NET-OF-COST track record (cost-v1): the same returns after a versioned
  // round-trip spread+slippage haircut. Additive — gross fields above are
  // untouched. Records predating the cost wiring simply have no net field and
  // are skipped, so the net sample self-reports its own n.
  const nets = arr.map(x => x.net).filter(x => x != null && Number.isFinite(x));
  const netExcs = arr.map(x => (x.netMktExc != null && Number.isFinite(x.netMktExc)) ? x.netMktExc : x.netExc).filter(x => x != null && Number.isFinite(x));
  const netBeat = netExcs.filter(x => x > 0).length;
  // Sector-relative excess vs the pick's sector ETF — isolates selection skill from
  // sector beta. Self-reports its own n (records with a resolvable sector ETF).
  const secExcs = arr.map(x => x.secExc).filter(x => x != null && Number.isFinite(x));
  const secBeat = secExcs.filter(x => x > 0).length;
  // Cost-net sector channel (same haircut as the market channel — the two halves of
  // the "beats SPY AND sector" gate must carry identical cost treatment).
  const netSecExcs = arr.map(x => x.netSecExc).filter(x => x != null && Number.isFinite(x));
  const netSecBeat = netSecExcs.filter(x => x > 0).length;
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
  // DISPLAYED INTERVAL (alpha-research pass 3). The pick-level interval below treats
  // every pick as an independent observation. It is not: same-day picks share the market
  // factor, and overlapping multi-session horizons share days. So `sd/sqrt(n)` over picks
  // is too narrow — it was the interval shown to the user (via lib/decision.js `ci`) while
  // the dependence-aware one was computed 80 lines above and displayed nowhere.
  //
  // Prefer the date-clustered interval (HAC/Newey-West SE, Student-t at the effective
  // sample size, widened by a seeded moving-block bootstrap — widest wins). Fall back to
  // the pick-level interval only when no date-level statistic exists, and SAY SO in the
  // basis so a narrow legacy interval can never be mistaken for a clustered one.
  const dn = dateLevelNetExcess(arr, { horizonBars: opts.horizonBars ?? null });
  const clustered = dn && dn.ci95 && Number.isFinite(dn.ci95.lo) && Number.isFinite(dn.ci95.hi);
  const avgCI = clustered
    ? { lo: dn.ci95.lo, hi: dn.ci95.hi, level: 95, basis: 'date-clustered', n: dn.n, effectiveN: dn.effectiveN ?? null }
    : (n > 2
        ? { lo: +(avg - 1.645 * se).toFixed(2), hi: +(avg + 1.645 * se).toFixed(2), level: 90, basis: 'pick-level-iid', n, effectiveN: null }
        : null);
  return {
    n,
    avg: +avg.toFixed(2),
    median: +median.toFixed(2),
    trimmedAvg: +trimmedAvg.toFixed(2),
    avgExTopWinners: +avgExTopWinners.toFixed(2),
    exTopN: dropTop,
    avgCI,
    // The superseded pick-level interval, retained for diagnosis only. Never display it:
    // the gap between the two IS the dependence being corrected for.
    avgCIPickLevel: n > 2 ? { lo: +(avg - 1.645 * se).toFixed(2), hi: +(avg + 1.645 * se).toFixed(2), level: 90, basis: 'pick-level-iid' } : null,
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
    // Cost-adjusted headline — does the edge survive real friction? (Shorts are
    // additionally charged the tier-prior borrow over the holding window.)
    netN: nets.length,
    avgNet: nets.length ? +(sum(nets) / nets.length).toFixed(2) : null,
    netWinRate: nets.length ? +((nets.filter(x => x > 0).length / nets.length) * 100).toFixed(0) : null,
    netExcessN: netExcs.length,
    avgNetExcess: netExcs.length ? +(sum(netExcs) / netExcs.length).toFixed(2) : null,
    netBeatMktRate: netExcs.length ? +((netBeat / netExcs.length) * 100).toFixed(0) : null,
    costModel: COST_MODEL_VERSION,
    // Distinct decision dates in this bucket — the honest independence unit for the
    // maturity grader's Wilson bound (same-day picks share the market factor).
    dates: new Set(arr.map(x => x.date).filter(Boolean)).size || null,
    // DATE-LEVEL net-excess portfolio track (maturity-v2): equal-weight the picks made
    // on each decision date into ONE portfolio return per date, then summarize across
    // dates. This is the statistic a verdict must clear — a pick-level beat rate
    // projected onto a date count treats correlated same-day picks as independent
    // evidence. Absent when no rows carry the net-excess channel (older records).
    dateNet: dn,
    // Sector-relative headline — does it beat its SECTOR, not just the market?
    secExcN: secExcs.length,
    avgSecExcess: secExcs.length ? +(sum(secExcs) / secExcs.length).toFixed(2) : null,
    beatSecRate: secExcs.length ? +((secBeat / secExcs.length) * 100).toFixed(0) : null,
    netSecExcN: netSecExcs.length,
    avgNetSecExcess: netSecExcs.length ? +(sum(netSecExcs) / netSecExcs.length).toFixed(2) : null,
    netBeatSecRate: netSecExcs.length ? +((netSecBeat / netSecExcs.length) * 100).toFixed(0) : null,
    // Rows whose market channel is the legacy (possibly sector-based) `exc` fallback.
    mktLegacyN: mktLegacyN || 0,
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

// Flatten a by-day ledger ({date, picks:[…]}) into Scoreboard rows stamped with their section.
// Eight ledgers share this exact shape, so it lives here once rather than being re-spelled.
const sectionRows = (days, section) =>
  (days || []).flatMap(dd => (dd.picks || []).map(p => ({ ...p, section })));

// Every ledger read below is INDEPENDENT (its own Blob prefix, no cross-dependency). They used
// to run as ~19 sequential awaits, so a scoreboard cache MISS paid the SUM of 19 list+fetch
// waves — the dominant cost of the ~10-12s miss path. Running them concurrently collapses that
// toward the slowest single loader instead of the sum.
//
// Bounded rather than a flat Promise.all because each readAll* ALREADY fans out over its own
// daily files, so 19 unbounded loaders would multiply into thousands of simultaneous Blob
// fetches (socket exhaustion / rate limiting). 6 in flight keeps peak concurrency in the same
// order of magnitude as the old sequential path while cutting ~19 waves to ~4.
const LEDGER_LOAD_CONCURRENCY = 6;

async function runScoreboard(req, res) {
  // Order here MUST match the destructuring below.
  // LEDGER-LOAD FAILURES ARE NO LONGER SILENT (alpha-research pass 3).
  //
  // Each loader was `readAllX().catch(() => [])`: a Blob/CDN failure became an empty
  // array indistinguishable from "this strategy has no picks". The group then graded as
  // {grade:'experimental', reason:'Not yet tracked in the Scoreboard — accruing.'} — an
  // affirmatively FALSE statement — and that grade flows into scoreboard/summary.json,
  // whose evidenceHash gov-v2.1 requires a promotion artifact to match. So one transient
  // read failure could invalidate every promotion artifact and demote live strategies
  // into reduce-only/paper via governance.demote().
  //
  // Failures are now recorded BY NAME, surfaced on the response, and block the evidence
  // write (see ledgerErrors below) rather than silently rewriting the record.
  const ledgerErrors = [];
  // A reader can also succeed PARTIALLY: lib/store's per-day readers drop an unreadable
  // shard and return a shorter-but-valid history, which shrinks excessN and can push a
  // Validated strategy back under MIN_VALIDATED_EPISODES with nothing recording the loss.
  // They now attach non-enumerable `requested`/`unreadable` counts; a material loss is
  // treated the same as a hard failure for the purpose of rewriting the evidence record.
  // `undefined` means the reader took a no-read path (e.g. no store token) — unknown, not
  // zero — so it is not counted as loss.
  const MAX_DAY_LOSS_RATE = 0.02;   // >2% of a ledger's days missing ⇒ degraded
  const load = (name, fn, fallback) => () => fn().then((res) => {
    const lost = res && Number.isFinite(res.unreadable) ? res.unreadable : 0;
    const asked = res && Number.isFinite(res.requested) ? res.requested : 0;
    if (lost > 0) {
      const rate = asked > 0 ? lost / asked : 1;
      ledgerErrors.push({ ledger: name, partial: true, unreadable: lost, requested: asked,
        lossRate: +rate.toFixed(4), material: rate > MAX_DAY_LOSS_RATE });
    }
    return res;
  }).catch((e) => {
    ledgerErrors.push({ ledger: name, error: String((e && e.message) || e) });
    return fallback;
  });

  const [
    rawPicks, rawGhost, rawEvidence, rawTone, rawAttn, rawFadeDays, cernState,
    rtDays, anomDays, bioDays, swDays, caDays, tsDays, downDayDays, gapDownDays,
    daytradeDays, coilDays, rawIgnition, rawOmega, gridlockDays, peerPropDays, underreactionDays, expGapDays,
  ] = await mapLimit([
    () => readAllPicks(),
    () => readAllGhost(),                                  // GAI-tier outcomes (GHOST / STALKING)
    load('readAllEvidence', () => readAllEvidence(), []),               // thesis-change signals (STRONG/MODERATE/WEAK)
    load('readAllTone', () => readAllTone(), []),                   // earnings-call tone (Bullish/Neutral/Bearish)
    load('readAllAttention', () => readAllAttention(), []),              // fast-vs-sticky attention (Sticky / Fast)
    load('readAllFadeDays', () => readAllFadeDays(), []),               // inverted-V SHORT setups, by day
    load('readCern', () => readCern(), null),                    // forced-flow event archive
    load('readAllReadThroughDays', () => readAllReadThroughDays(), []),        // second-order beneficiaries (Fresh/Moved)
    load('readAllAnomalyDays', () => readAllAnomalyDays(), []),            // no-news movers (Accumulation/Explained/Noise)
    load('readAllBiotechDays', () => readAllBiotechDays(), []),            // early biotech runners /100, benchmarked vs XBI
    load('readAllSecondWaveDays', () => readAllSecondWaveDays(), []),         // first-leg movers (Primed/Early/Faded)
    load('readAllCrossAssetDays', () => readAllCrossAssetDays(), []),         // cross-asset leads (Lead/Inline/Weak)
    load('readAllToneShiftDays', () => readAllToneShiftDays(), []),          // earnings tone deltas (Brightening/Stable/Darkening)
    load('readAllDownDays', () => readAllDownDays(), []),               // oversold-bounce LONGS on red tapes
    load('readAllGapDownDays', () => readAllGapDownDays(), []),            // gap-down continuation SHORTS (short:true → inverted)
    load('readAllDaytradeDays', () => readAllDaytradeDays(), []),           // Day-Trade ledger (A / B tiers), all longs
    load('readAllCoilDays', () => readAllCoilDays(), []),               // Coil ledger (calibrated squeeze band as tier)
    load('readAllIgnition', () => readAllIgnition(), []),               // Momentum Ignition (IGNITION/WATCH)
    // PROSPECTIVE-ONLY: the displayed live track uses only prospective_live / paper_trade picks —
    // reconstructed history and pre-v2 mixed legacy days are excluded from the live record.
    load('readAllOmega', () => readAllOmega({ track: 'live' }), []), // OMEGA-SWING prospective picks
    load('readAllGridlockDays', () => readAllGridlockDays(), []),           // GRIDLOCK physical-constraint candidates (Actionable/Tracked)
    load('readAllPeerPropDays', () => readAllPeerPropDays(), []),           // Peer Propagation (EARLY/CONFIRMING stages)
    load('readAllUnderreactionDays', () => readAllUnderreactionDays(), []),      // News Underreaction (FRESH_* states; negatives short)
    load('readAllExpGapDays', () => readAllExpGapDays(), []),             // Expectation-Gap RISK_REDUCE days (SPY short-framed)
  ], LEDGER_LOAD_CONCURRENCY, load => load());

  // Pure post-load transforms (no I/O — order-independent, kept verbatim from the sequential form).
  const rawFade = fadeRowsFrom(rawFadeDays);
  const cernPicks = cernPicksFrom(cernState);             // per-event-type Scoreboard rows
  const rawRT = sectionRows(rtDays, 'ReadThrough');
  const rawGridlock = sectionRows(gridlockDays, 'Gridlock');
  const rawAnom = sectionRows(anomDays, 'Anomaly');
  const rawBio = sectionRows(bioDays, 'Biotech');
  const rawSW = sectionRows(swDays, 'SecondWave');
  const rawCA = sectionRows(caDays, 'CrossAsset');
  const rawTS = sectionRows(tsDays, 'ToneShift');
  const rawDownDay = sectionRows(downDayDays, 'DownDay');
  const rawGapDown = sectionRows(gapDownDays, 'GapDown');
  // Day-Trade rows: reconstructed by their OWN scorer (daytrade.rankScore) in the score-decile
  // validation. The record already carries entry/tier.
  const rawDaytrade = (daytradeDays || []).flatMap(dd => (dd.picks || []).map(p => ({ ...p, date: p.date || dd.date, section: 'daytrade', tier: p.tier || 'A' })));
  // Coil rows: entryPrice→entry; reconstructed by its OWN scorer (coil.scoreCohort).
  // `trigger` is the PLAN's conditional entry (breakout level) for the trigger-verified
  // basis — explicitly null when no plan was captured, so a decision price can never be
  // silently graded as if it were a trigger (those rows stay ungraded, not approximated).
  const rawCoil = (coilDays || []).flatMap(dd => (dd.picks || []).map(p => ({ ...p, date: p.date || dd.date, section: 'coil', tier: p.band || (p.decile != null ? `D${p.decile}` : 'coil'), entry: p.entry != null ? p.entry : p.entryPrice, trigger: (p.plan && p.plan.entry > 0) ? p.plan.entry : null })));
  const rawPeerProp = sectionRows(peerPropDays, 'PeerProp');
  const rawUnderreaction = sectionRows(underreactionDays, 'Underreaction');
  const rawExpGap = sectionRows(expGapDays, 'ExpGap');
  if (!rawPicks.length && !rawGhost.length && !rawEvidence.length && !rawFade.length && !cernPicks.length && !rawTone.length && !rawAttn.length && !rawRT.length && !rawGridlock.length && !rawAnom.length && !rawBio.length && !rawSW.length && !rawCA.length && !rawTS.length && !rawDownDay.length && !rawGapDown.length && !rawDaytrade.length && !rawCoil.length && !rawIgnition.length && !rawOmega.length && !rawPeerProp.length && !rawUnderreaction.length && !rawExpGap.length) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ configured: hasStore(), totalPicks: 0, loggedRows: 0, groups: [], generatedAt: new Date().toISOString() });
  }

  // EPISODE dedup (quant-redesign-3, replaces "first appearance forever"): one record
  // per section:tier:ticker EPISODE. Consecutive sightings within the strategy's
  // contract cooldown extend one episode; a reappearance after the cooldown is a NEW
  // episode that re-enters the board (lib/scoreboard-episodes.js). A name listed for
  // days is still counted once per episode, never once per day. ?dedup=first restores
  // the legacy forever-dedup for comparison. Raw daily log is left untouched.
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const firstSeen = createEpisodeMap({ legacy: req.query.dedup === 'first' });
  for (const p0 of [...rawPicks].sort(byDate)) {
    // Scoped evidence identity (defect #5): scope is part of the episode key, so a
    // large-cap and a micro-cap sighting of the same ticker are SEPARATE evidence.
    // Momentum rows carry an era identity too: pre-v2 rows reclassify to HIST_* here
    // (read time, ledger untouched) so the v2 record accrues prospectively.
    const p = p0.section === 'momentum' ? momentumLedgerRow(p0) : p0;
    const key = `${p.section}:${p.tier}:${p.scope || ''}:${p.ticker}`;
    firstSeen.add(key, p);
  }
  // Ghost ledger → its own "Ghost" section (GHOST/STALKING tiers); records carry
  // date/entry/tier already, so they flow through the same grouping + resolution.
  for (const p of [...rawGhost].sort(byDate)) {
    const key = `Ghost:${p.tier}:${p.ticker}`;
    firstSeen.add(key, { ...p, section: 'Ghost' });
  }
  // Evidence Consensus & Thesis Change → an "Evidence" section (STRONG/MODERATE/WEAK tiers).
  // Rows carry date/entry/tier/short already (weakening theses logged short:true so the
  // forward-return resolver inverts them) → same first-appearance dedup + horizon resolution.
  // The falsifiable test: do STRONG thesis changes actually move in the flagged direction?
  for (const p of [...rawEvidence].sort(byDate)) {
    const key = `Evidence:${p.tier}:${p.ticker}`;
    if (p.tier) firstSeen.add(key, { ...p, section: 'Evidence' });
  }
  // Momentum Ignition ledger → an "Ignition" section (IGNITION/WATCH tiers). LONGS with
  // date/entry/tier already set → same first-appearance dedup + EOD forward resolution.
  // The falsifiable test: do IGNITION-tier (accelerating) names beat WATCH and the market?
  // PROVENANCE SEPARATION: the backfill job wrote historically RECONSTRUCTED picks into
  // the same ledger under the same tiers (`backfill: true` was stamped but read by
  // nothing). The ledger stays immutable; reclassification happens HERE at read time —
  // backfilled rows grade under HIST_* tiers, a separate evidence identity that the
  // maturity grader excludes from the promoted policy (reconstructed history can inform
  // research but can never satisfy prospective confirmation). BROAD_* (independent
  // shadow discovery) already carries its own tiers and is likewise never pooled.
  for (const p of [...rawIgnition].sort(byDate)) {
    if (!p.tier) continue;
    const tier = ignitionLedgerTier(p);
    const key = `Ignition:${tier}:${p.ticker}`;
    firstSeen.add(key, { ...p, tier, section: 'Ignition' });
  }
  // OMEGA-SWING ledger → an "OMEGA" section (OMEGA_PRIME/QUALIFIED/WATCH). LONGS with
  // date/entry/tier set → same first-appearance dedup + EOD forward resolution. The
  // falsifiable test: do Prime names beat Qualified/Watch and the market over 1w/1m?
  for (const p of [...rawOmega].sort(byDate)) {
    const key = `OMEGA:${p.tier}:${p.ticker}`;
    if (p.tier) firstSeen.add(key, { ...p, section: 'OMEGA' });
  }
  // Down-Day Mode ledger → a "DownDay" section (WATCH/EMERGING/CONFIRMED). Oversold-bounce
  // LONGS logged only on red tapes; date/entry/tier already present → same resolution. The
  // falsifiable test: do these red-day bounces beat SPY, and do the earlier (WATCH/EMERGING)
  // turns outperform CONFIRMED as the backtest predicted?
  for (const p of [...rawDownDay].sort(byDate)) {
    const key = `DownDay:${p.tier}:${p.ticker}`;
    if (p.tier) firstSeen.add(key, p);
  }
  // Gap-Down Continuation ledger → a "GapDown" section (STRONG/MODERATE). These are SHORTS
  // (short:true set at log time), so forwardReturn inverts — a win means the name fell. The
  // falsifiable test: do bigger gap-downs (STRONG) continue lower more than MODERATE?
  for (const p of [...rawGapDown].sort(byDate)) {
    const key = `GapDown:${p.tier}:${p.ticker}`;
    if (p.tier) firstSeen.add(key, p);
  }
  // Peer Propagation ledger → a "PeerProp" section (EARLY/CONFIRMING stages as tiers).
  // LONGS with date/entry/tier already set. The falsifiable test: do EARLY names (peers
  // moved, own reaction quiet) beat CONFIRMING and their sector ETF going forward?
  for (const p of [...rawPeerProp].sort(byDate)) {
    const key = `PeerProp:${p.tier}:${p.ticker}`;
    if (p.tier) firstSeen.add(key, p);
  }
  // News Underreaction ledger → an "Underreaction" section (FRESH_POSITIVE/FRESH_NEGATIVE
  // states as tiers; negatives carry short:true so the resolver inverts). The falsifiable
  // test: do fresh underreactions drift in the flagged direction vs sector/SPY?
  for (const p of [...rawUnderreaction].sort(byDate)) {
    const key = `Underreaction:${p.tier}:${p.ticker}`;
    if (p.tier) firstSeen.add(key, p);
  }
  // Expectation-Gap ledger → an "ExpGap" section (tier RISK_REDUCE, SPY short-framed:
  // short:true so a falling tape after the call grades as a win). The falsifiable test:
  // is SPY's forward return after RISK_REDUCE days worse than unconditional?
  for (const p of [...rawExpGap].sort(byDate)) {
    const key = `ExpGap:${p.tier}:${p.ticker}`;
    if (p.tier) firstSeen.add(key, p);
  }
  // Fade ledger → a "Fade" section (tiers SHORT / SHORT_LIGHT). These are SHORTS,
  // so short:true inverts forwardReturn (positive = the name fell = the fade paid).
  for (const p of [...rawFade].sort(byDate)) {
    const key = `Fade:${p.tier}:${p.ticker}`;
    firstSeen.add(key, { ...p, section: 'Fade' });
  }
  // CERN forced-flow events → a "CERN" section, one tier per event type. cernPicks
  // is already first-appearance-deduped and direction-tagged (short flag).
  for (const p of cernPicks) {
    const key = `${p.section}:${p.tier}:${p.ticker}`;
    firstSeen.add(key, p);
  }
  // Earnings-tone ledger → a "Tone" section (Bullish/Neutral/Bearish). All tracked
  // as longs (short:false) so the board shows whether bullish-toned calls actually
  // outperform bearish-toned ones — a falsifiable test of the tone signal.
  for (const p of [...rawTone].sort(byDate)) {
    const key = `Tone:${p.tier}:${p.ticker}`;
    if (p.tier) firstSeen.add(key, { ...p, section: 'Tone' });
  }
  // Attention ledger → an "Attention" section (Sticky / Fast). Both tracked as longs
  // so the board falsifies the thesis: sticky attention should outperform fast hype
  // (and fast hype should be the weaker / negative bucket = the caution).
  for (const p of [...rawAttn].sort(byDate)) {
    const key = `Attention:${p.tier}:${p.ticker}`;
    if (p.tier) firstSeen.add(key, { ...p, section: 'Attention' });
  }
  // Read-Through ledger → a "ReadThrough" section (tiers Fresh / Moved / Unknown). All
  // longs — the falsifiable test is whether the un-moved (Fresh) beneficiaries outperform
  // the already-moved (Moved / priced-in) ones. Excess is vs SPY like every other section
  // (sector-relative excess is the intended refinement).
  for (const p of [...rawRT].sort(byDate)) {
    const key = `ReadThrough:${p.tier}:${p.ticker}`;
    if (p.tier) firstSeen.add(key, p);
  }
  // GRIDLOCK ledger → a "Gridlock" section (tiers Actionable / Tracked). All longs, weight-0
  // shadow — the falsifiable test: do gate-passing (Actionable) physical-constraint candidates
  // beat the gate-failing (Tracked) ones AND their sector bench over 1w/1m? Picks carry their
  // own sector-ETF `bench` (SECTOR_BENCH membership makes the headline excess sector-relative).
  for (const p of [...rawGridlock].sort(byDate)) {
    const key = `Gridlock:${p.tier}:${p.ticker}`;
    if (p.tier) firstSeen.add(key, p);
  }
  // Anomaly ledger → an "Anomaly" section (Accumulation / Explained / Noise). All longs —
  // the falsifiable test is whether the un-explained (Accumulation) movers actually beat
  // their sector, and beat the Explained/Noise buckets. Benchmarked vs sector ETF (p.bench).
  for (const p of [...rawAnom].sort(byDate)) {
    const key = `Anomaly:${p.tier}:${p.ticker}`;
    if (p.tier) firstSeen.add(key, p);
  }
  // Biotech Radar ledger → a "Biotech" section (Hot / Emerging / Watch score-tiers). All longs,
  // benchmarked vs XBI (p.bench). Falsifiable test of the /100 model: do HOT names actually
  // beat WATCH names AND beat the biotech index?
  for (const p of [...rawBio].sort(byDate)) {
    const key = `Biotech:${p.tier}:${p.ticker}`;
    if (p.tier) firstSeen.add(key, p);
  }
  // Second Wave ledger → a "SecondWave" section (Primed / Early / Faded), all longs,
  // sector-benchmarked. Test: do PRIMED first-leg movers get the reflexive second leg
  // (beat their sector) vs the Faded ones?
  for (const p of [...rawSW].sort(byDate)) {
    const key = `SecondWave:${p.tier}:${p.ticker}`;
    if (p.tier) firstSeen.add(key, p);
  }
  // Cross-Asset ledger → a "CrossAsset" section (Lead / Inline / Weak), all longs. Test:
  // do the LEAD names (still lagging the cross-asset tell) actually catch up (outperform)?
  for (const p of [...rawCA].sort(byDate)) {
    const key = `CrossAsset:${p.tier}:${p.ticker}`;
    if (p.tier) firstSeen.add(key, p);
  }
  // Tone Shift ledger → a "ToneShift" section (Brightening / Stable / Darkening), all longs,
  // sector-benchmarked. Test: do BRIGHTENING tone deltas actually beat the Darkening ones?
  for (const p of [...rawTS].sort(byDate)) {
    const key = `ToneShift:${p.tier}:${p.ticker}`;
    if (p.tier) firstSeen.add(key, p);
  }
  // Day-Trade ledger → "daytrade" section (A/B tiers, all longs; reconstructed by its own
  // scorer in the score-decile validation).
  for (const p of [...rawDaytrade].sort(byDate)) {
    const key = `daytrade:${p.tier}:${p.ticker}`;
    if (p.tier) firstSeen.add(key, p);
  }
  // Coil ledger → "coil" section (calibrated squeeze band as the tier, all longs;
  // reconstructed by its own scorer in the score-decile validation).
  for (const p of [...rawCoil].sort(byDate)) {
    const key = `coil:${p.tier}:${p.ticker}`;
    if (p.tier) firstSeen.add(key, p);
  }
  const picks = [...firstSeen.values()];

  // Resolving every first-appearance pick needs that ticker's candles, and this — not the
  // ledger load — is what dominates a scoreboard cache MISS: hundreds of latency-bound Yahoo
  // calls, previously 8 at a time, so the endpoint paid ~N/8 sequential round-trip waves.
  //
  // Raising the pool is SCHEDULING ONLY: identical calls, identical results, fewer waves.
  // 24 is still far below what this app already does against the same endpoint elsewhere
  // (api/screener.js's universe scan ran ~515 wide before it moved to a candle cache), and
  // fetchDailyHistory deliberately does not retry, so a wider pool cannot become a retry storm.
  const HIST_FETCH_CONCURRENCY = 24;
  const tickers = [...new Set(picks.map(p => p.ticker))];
  const hist = new Map();
  await mapLimit(tickers, HIST_FETCH_CONCURRENCY, async t => {
    try { const d = await fetchDailyHistory(t); if (d) hist.set(t, d.candles); } catch { /* skip — pick resolves without history */ }
  });

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
  const SECTOR_BENCH = new Set(['ReadThrough', 'Gridlock', 'Anomaly', 'Biotech', 'SecondWave', 'CrossAsset', 'ToneShift']);
  // p.bench = the sector ETF stamped at DECISION time (point-in-time correct).
  // The SECTOR_OF fallback serves only legacy rows logged before the stamp existed —
  // it reads the CURRENT map and is therefore approximate for old picks.
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
  // How many ungradeable tickers to name per group. A sample, not the full list — the
  // count is the statistic; the tickers are for diagnosis (is this one dead ADR or a
  // systematic ledger problem?).
  const NO_HISTORY_SAMPLE = 10;
  const SELF_BENCH_SAMPLE = 10;

  const groups = {};
  for (const p of picks) {
    // Scoped evidence identity (defect #5): large / small / micro / expanded records
    // aggregate into SEPARATE groups. Records logged before scoping (no `scope`)
    // land in a scope-'' legacy group — displayable context that a scoped lookup
    // (lib/decision.js expectancyFor) can never join. Pooling across scopes would
    // require a formally validated hierarchical model, which does not exist
    // (lib/evidence-identity.js MAY_POOL_SCOPES = false).
    const gkey = `${p.section}:${p.tier}:${p.scope || ''}`;
    const g = groups[gkey] || (groups[gkey] = { section: p.section, tier: p.tier, scope: p.scope || null, picks: 0, noHistory: 0, noHistoryTickers: [], benchFallback: 0, selfBenchmarked: 0, selfBenchmarkedTickers: [], regPicks: {}, h: {}, reg: {}, liq: {}, sec: {} });
    g.picks++;
    const bucket = macroLookup ? regimeBucketOf(macroLookup.at(p.date)) : null;
    if (bucket) g.regPicks[bucket] = (g.regPicks[bucket] || 0) + 1;
    const candles = hist.get(p.ticker);
    // SURVIVORSHIP INSIDE THE TRACK RECORD (alpha-research pass 3). `hist` is built from
    // fetchDailyHistory, which returns nothing for a delisted, acquired, bankrupt or
    // long-halted ticker. Those picks used to increment `picks` and then vanish from
    // every statistic — no return, no win rate, no excess, no net, no dateNet — with no
    // counter anywhere in the group output. The failures were therefore deleted from the
    // record while still inflating its denominator, and that record feeds expectancyTilt
    // (live rank ordering), maturity.gradeTrack and governance.
    //
    // Delisting is not missing-at-random: it correlates with the outcome being graded.
    // So the count is now retained and surfaced, and `noHistoryRate` fails a group's
    // promotion statistics closed past a declared threshold (see maturity.js).
    if (!candles) {
      g.noHistory++;
      if (g.noHistoryTickers.length < NO_HISTORY_SAMPLE) g.noHistoryTickers.push(p.ticker);
      continue;
    }
    // entry-v2: sections whose CONTRACT declares a next-session-open fill are graded
    // from the next open (a signal-day close is not an executable EOD entry) with a
    // basis-consistent benchmark. entry-v2.1: conditional-trigger contracts (coil,
    // gapdown) are graded TRIGGER-VERIFIED — unfilled and gap-skipped episodes are
    // counted, never averaged as trades. The daytrade section is pinned to legacy
    // behavior (FROZEN).
    // Self-benchmark check is a property of the PICK, not the horizon: which series
    // it would be graded against is fixed by its ticker, section and logged bench.
    // Counted once per pick (like benchFallback) so a section grading itself is
    // visible in the health block instead of quietly publishing a beta artifact.
    const excBenchSymbol = (SECTOR_BENCH.has(p.section) && p.bench && benchHist.get(p.bench)) ? p.bench : MARKET_BENCH_SYMBOL;
    const selfExc = isSelfBenchmarked(p.ticker, excBenchSymbol);
    const selfMkt = isSelfBenchmarked(p.ticker, MARKET_BENCH_SYMBOL);
    const selfSec = isSelfBenchmarked(p.ticker, sectorEtfFor(p));
    if (selfExc || selfMkt || selfSec) {
      g.selfBenchmarked = (g.selfBenchmarked || 0) + 1;
      // A bare count says a section grades something against itself but not WHAT,
      // which is the one fact needed to act on it. Sampled like noHistoryTickers.
      if (g.selfBenchmarkedTickers.length < SELF_BENCH_SAMPLE) g.selfBenchmarkedTickers.push(p.ticker);
    }

    const entryBasis = entryBasisForSection(p.section);
    const fpOpts = entryBasis ? { entryBasis } : undefined;
    let retH = null;   // forward return at SCORE_HK — the horizon the score-decile check validates on
    for (const [hk, bars] of HORIZONS) {
      const r = forwardPath(candles, p, bars, fpOpts);
      if (r == null) continue;
      // Trigger-verified fill accounting (per horizon — a trigger can fire inside 21
      // bars but not inside 1). Unfilled / gap-skipped episodes are COUNTED here and
      // then excluded from every return array: a plan that never traded has no return,
      // and averaging it as 0 would fabricate one (summarizeReturns does raw math on ret).
      if (r.fillStatus) {
        const fs = (g.fillsByH = g.fillsByH || {});
        const f = (fs[hk] = fs[hk] || { filled: 0, noFill: 0, gapSkip: 0 });
        if (r.fillStatus === 'filled') f.filled++;
        else { if (r.fillStatus === 'no-fill') f.noFill++; else f.gapSkip++; continue; }
      }
      if (hk === SCORE_HK && Number.isFinite(r.ret)) retH = r.ret;
      // Benchmark-relative: pick's (direction-adjusted) return minus its benchmark's over
      // the same window. Read-Through uses its beneficiary's SECTOR ETF (p.bench) to strip
      // the sector move (beat your peers, not just the market); everything else uses SPY.
      // null when benchmark data is missing or the horizon hasn't elapsed.
      // Trigger-verified rows anchor the benchmark at their verified FILL date.
      const benchOpts = r.fillStatus === 'filled'
        ? { entryBasis, anchorDate: r.fillDate, anchorAtOpen: r.filledAtOpen }
        : fpOpts;
      // For SECTOR_BENCH sections `exc` stays vs the logged sector ETF (backward-
      // comparable history), but the MARKET channel must be an INDEPENDENT series:
      // grading "beats SPY AND beats sector" on one series made the sector control
      // vacuous for those sections. `mktExc` is always vs SPY; a missing sector-ETF
      // history is COUNTED (benchFallback), never silently substituted.
      const sectorBenchCandles = (SECTOR_BENCH.has(p.section) && p.bench && benchHist.get(p.bench)) || null;
      if (SECTOR_BENCH.has(p.section) && p.bench && !sectorBenchCandles) g.benchFallback++;
      const spyRet = spyForwardReturn(spyCandles, p, bars, benchOpts);
      const benchRet = sectorBenchCandles ? spyForwardReturn(sectorBenchCandles, p, bars, benchOpts) : spyRet;
      r.exc = excessOrNull(r.ret, benchRet, selfExc);
      r.mktExc = excessOrNull(r.ret, spyRet, selfMkt);
      // NET of a versioned round-trip cost (spread + slippage), tiered by the
      // pick's liquidity — plus, for SHORTS, the tier-prior borrow charge over the
      // holding window (quant-redesign-3 H17: short buckets were graded gross of
      // borrow, the exact flattering assumption lib/costs.js warns about). The
      // benchmark is treated as a costless index baseline, so the same haircut
      // applies to raw and excess. Gross r.ret / r.exc stay intact — additive.
      const rtCost = roundTripCostPct(tierForPick(p));
      const isShortPick = p.short === true || p.tier === 'StrongSell';
      const shortBorrowPct = isShortPick ? borrowCost(tierForPick(p), bars, 'short').pct : 0;
      const allInCost = +(rtCost + shortBorrowPct).toFixed(3);
      r.net = Number.isFinite(r.ret) ? +(r.ret - allInCost).toFixed(2) : null;
      r.netExc = (r.exc == null) ? null : +(r.exc - allInCost).toFixed(2);
      r.netMktExc = (r.mktExc == null) ? null : +(r.mktExc - allInCost).toFixed(2);
      // Decision date + episode ordinal ride along so summaries can count INDEPENDENT
      // decision dates (Wilson on dates, not correlated same-day picks).
      r.date = p.date;
      // Uniform sector-relative excess: return minus the pick's SECTOR ETF over the
      // same window (its logged bench, else its GICS sector's SPDR ETF). null when the
      // sector is unknown or the ETF history is missing → falls out of the sector stats.
      const secEtf = sectorEtfFor(p);
      const secRet = secEtf ? spyForwardReturn(benchHist.get(secEtf), p, bars, benchOpts) : null;
      r.secExc = excessOrNull(r.ret, secRet, selfSec);
      // Cost-net sector excess: the sector half of the "beats SPY AND sector" gate was
      // one round-trip easier than the market half (graded gross). Same haircut applies.
      r.netSecExc = (r.secExc == null) ? null : +(r.secExc - allInCost).toFixed(2);
      // Realistic next-open entry (entry-v1) — now computed for EVERY pick
      // (quant-redesign-3 H6). A logged entry is an INTENDED level, not a fill: the
      // old `if (!p.entry)` gate excluded exactly the picks whose level may never
      // have traded. The first achievable price for an EOD signal is the next
      // session's open; r.gap = the entry-timing drag vs the primary measure.
      {
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
    // COMMON-DATE MARK-TO-MARKET (mtm-v1): a pick younger than the 1m horizon used to
    // fall out of EVERY statistic until it matured — survivorship-in-time (a position
    // that is open is not a position that doesn't exist). Mark it at the latest
    // available close under the SAME entry basis its section grades with, net of the
    // full round-trip cost (the exit will be paid), benchmark over the same window.
    // Pending conditional triggers stay pending (no fabricated fills). Dividends and
    // cash drag are NOT modeled — the lane's basis string says so.
    {
      let mIdx = -1;
      for (let k = 0; k < candles.length; k++) { if (candles[k].date <= p.date) mIdx = k; else break; }
      const barsAvail = mIdx >= 0 ? (candles.length - 1 - mIdx) : -1;
      if (barsAvail > 0 && barsAvail < MTM_BARS) {
        const m = forwardPath(candles, p, barsAvail, fpOpts);
        if (m && Number.isFinite(m.ret) && m.fillStatus !== 'no-fill' && m.fillStatus !== 'gap-skip') {
          const mBenchOpts = m.fillStatus === 'filled'
            ? { entryBasis, anchorDate: m.fillDate, anchorAtOpen: m.filledAtOpen }
            : fpOpts;
          const mBench = (SECTOR_BENCH.has(p.section) && p.bench && benchHist.get(p.bench)) || spyCandles;
          const mBenchRet = spyForwardReturn(mBench, p, barsAvail, mBenchOpts);
          const mTier = tierForPick(p);
          const mShort = p.short === true || p.tier === 'StrongSell';
          const mCost = +(roundTripCostPct(mTier) + (mShort ? borrowCost(mTier, barsAvail, 'short').pct : 0)).toFixed(3);
          (g.mtmOpen = g.mtmOpen || []).push({
            date: p.date, barsHeld: barsAvail,
            net: +(m.ret - mCost).toFixed(2),
            netExc: mBenchRet == null ? null : +(m.ret - mBenchRet - mCost).toFixed(2),
          });
        }
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

  // Gap & Go event sleeve (its own ledger, pre-resolved forward return).
  //
  // DAY-TRADE ISOLATION (alpha-research pass 3). This sleeve is an INTRADAY event
  // strategy (registry `gapgo`, horizon 'intraday') and it must not participate in
  // non-Day-Trade capital allocation. It used to be merged straight into `sleeveRecs`,
  // which fed computeAllocation, and that had two distinct effects — the first was even
  // noted approvingly in the comment this replaces ("the lowest-vol sleeve, so risk
  // parity leans weight toward it"):
  //
  //   1. WEIGHTS. lib/allocation.js normalises inverse-vol weights ACROSS all sleeves
  //      (`weights = inv / invSum`), so Gap & Go's realized vol mechanically moved the
  //      deployed weight of Breakout, Momentum, Ghost and DownDay. A Day-Trade result
  //      was setting swing capital.
  //   2. ESTIMATION WINDOW. lib/allocation.js takes the INTERSECTION of months across
  //      sleeves (a shared window is required for an inverse-vol blend), so the Gap & Go
  //      ledger's start date — and any gap month in it — silently truncated the sample
  //      every non-Day-Trade sleeve was estimated from.
  //
  // The sleeve is still computed and still reported; it is simply no longer an input to
  // the non-Day-Trade blend. Gap & Go's own behaviour, ledger and grading are untouched.
  const dtSleeveRecs = {};
  try {
    const gapDays = await readAllGapDays();
    const gapRecs = [];
    (gapDays || []).forEach(dd => (dd.picks || []).forEach(pk => {
      if (pk.resolved && Number.isFinite(pk.fwdPct)) gapRecs.push({ date: pk.date, ret: pk.fwdPct / 100 });
    }));
    if (gapRecs.length) dtSleeveRecs['Gap & Go'] = gapRecs;
  } catch { /* gap ledger optional */ }
  // GOVERNANCE → ALLOCATION: read the persisted model-governance state (written by
  // op=maturity) and cap each sleeve's deployed capital by its model's status weight
  // (Production 100% → Retired 0%). Keyed by the sleeve's scoreboard SECTION so the
  // status flows to the right sleeve. FAIL CLOSED (quant-redesign-3 H8): absent or
  // STALE (>7d) governance means NO clearance — computeAllocation's govDefault is 0,
  // so an ungoverned/unrefreshed sleeve holds cash instead of silently deploying 100%.
  // Non-Day-Trade sleeves only — see the Day-Trade isolation note above. GapGo is no
  // longer mapped here because it is no longer a sleeve in this allocation.
  const SLEEVE_BY_SECTION = { ...LONG_SLEEVE };
  const GOV_STALE_MS = 7 * 24 * 3600 * 1000;
  const govWeights = {}, govStatus = {};
  let govStale = null;
  try {
    const govDoc = await readJSON('governance/latest.json', null);
    const savedAtMs = govDoc && govDoc.savedAt ? Date.parse(govDoc.savedAt) : NaN;
    // BOTH timestamps must be fresh: the governance WRITE time and the underlying
    // Scoreboard EVIDENCE time — the daily maturity cron re-stamps savedAt even when
    // the scoreboard chain is broken, so savedAt alone cannot prove the evidence is
    // current (a newly written governance doc must not make an old Scoreboard look fresh).
    const evidAtRaw = govDoc && (govDoc.scoreboardGeneratedAt || govDoc.generatedAt) || null;
    const evidAtMs = evidAtRaw ? Date.parse(evidAtRaw) : NaN;
    govStale = !(Number.isFinite(savedAtMs) && (Date.now() - savedAtMs) <= GOV_STALE_MS
      && Number.isFinite(evidAtMs) && (Date.now() - evidAtMs) <= GOV_STALE_MS);
    if (!govStale) {
      for (const g of (govDoc && govDoc.strategies) || []) {
        const nm = SLEEVE_BY_SECTION[g.section];
        if (nm && Number.isFinite(g.weight)) { govWeights[nm] = g.weight; govStatus[nm] = g.status; }
      }
    }
  } catch { /* governance unreadable ⇒ fail closed (no weights) */ }
  // ROUTER RISK CAP (quant-redesign-3 Phase 4D): a second one-directional haircut from
  // the persisted router budgets — applied ONLY when the router declares its inputs
  // valid (bindingReady). Today calibration/rank-IC are unmeasured, so bindingReady is
  // false and this stays inert: the router provably cannot cap on placeholder data.
  let routerCaps = null;
  try {
    const routerDoc = await readJSON('router/latest.json', null);
    const budgets = routerDoc && routerDoc.budgets;
    if (budgets && budgets.bindingReady && Array.isArray(budgets.budgets)) {
      // gapgo intentionally absent: it is not a sleeve in the non-Day-Trade allocation.
      const SECTION_BY_ID = { screener: 'Breakout', momentum: 'Momentum', ghost: 'Ghost', downday: 'DownDay' };
      routerCaps = {};
      for (const b of budgets.budgets) {
        const nm = SECTION_BY_ID[b.id];
        // The budget is a 0..1 share of total emphasis; as a sleeve cap it is used as a
        // clearance multiplier relative to the sleeve's own base (cap-only via min()).
        if (nm && Number.isFinite(b.budget) && Number.isFinite(b.baseBudget) && b.baseBudget > 0) {
          routerCaps[nm] = Math.max(0, Math.min(1, b.budget / b.baseBudget));
        }
      }
      if (!Object.keys(routerCaps).length) routerCaps = null;
    }
  } catch { /* router state optional — absence simply means no extra cap */ }
  const allocation = computeAllocation(sleeveRecs, { govWeights, govStatus, routerCaps });
  // Report the excluded Day-Trade sleeve rather than hiding it: the number is still
  // useful context, it just carries no weight here. Disclosure, not participation.
  if (allocation && Object.keys(dtSleeveRecs).length) {
    allocation.excludedSleeves = {
      reason: 'day-trade-isolation',
      note: 'Intraday Day-Trade sleeves are excluded from non-Day-Trade capital allocation: '
          + 'cross-sleeve inverse-vol normalisation would let their realized vol set swing '
          + 'weights, and the shared-month intersection would truncate every swing sleeve\'s '
          + 'estimation window. Their own ledgers and grading are unaffected.',
      sleeves: Object.keys(dtSleeveRecs).map(n => ({ name: n, resolved: dtSleeveRecs[n].length })),
    };
  }
  if (allocation && allocation.governance && govStale) {
    allocation.governance.stale = true;
    allocation.governance.note = 'Governance state is missing or stale (>7 days) — FAIL CLOSED: sleeves hold no sizing clearance until op=maturity refreshes governance/latest.json (daily warm chain).';
  }

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
    // Carry the pick's logged point-in-time score so sections that persist their real score
    // (OMEGA) are graded on THAT, not a generic momentum proxy.
    scoreItems.map(s => ({ ticker: s.pick.ticker, date: s.pick.date, section: s.section, regime: s.regime, score: s.pick.score })),
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
  // `date` rides along so rankquality can run its DATE-CLUSTERED IC lane (QM-1):
  // per-decision-date cross-sectional ICs, HAC-averaged — the pooled battery stays
  // as a labeled descriptive.
  const rqItems = scoreItems.map((s, i) => ({ score: cscore[i], outcome: s.ret, won: s.ret > 0, date: (s.pick && s.pick.date) || null }));
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
  let summaryWriteError = null;
  const scoreQuality = {
    model: sectionscore.SECTIONSCORE_VERSION, proxyModel: PICKSCORE_VERSION, horizon: SCORE_HK,
    scoredPicks: scoreItems.length, methodMix,
    overall: analyzeRankQuality(rqItems, { minN: 20 }), byRegime: scoreByRegime, bySection: scoreBySection,
  };

  const out = Object.values(groups).map(g => ({
    section: g.section,
    tier: g.tier,
    scope: g.scope,          // evidence-identity scope (null = scope-less or legacy pre-scope records)
    picks: g.picks,
    // Picks that could not be graded because no price history exists for the ticker —
    // overwhelmingly delistings, acquisitions and bankruptcies. Retained because
    // delisting correlates with the outcome being graded, so dropping these silently is
    // survivorship INSIDE the reported record. `noHistoryRate` is the share of the
    // group's own denominator that is unaccounted for; maturity.js fails a group's
    // promotion statistics closed above NO_HISTORY_MAX_RATE.
    noHistory: g.noHistory,
    noHistoryRate: g.picks > 0 ? +(g.noHistory / g.picks).toFixed(4) : 0,
    noHistoryTickers: g.noHistoryTickers,
    // Sector-benched picks whose sector-ETF history failed to fetch, so the legacy
    // `exc` lane fell back to SPY — counted, never silently absorbed (F-04).
    benchFallback: g.benchFallback || 0,
    // Picks whose own instrument IS a series they'd be graded against, so their
    // benchmark-relative channels are suppressed rather than published as beta.
    selfBenchmarked: g.selfBenchmarked || 0,
    selfBenchmarkedTickers: g.selfBenchmarkedTickers || [],
    regimePicks: g.regPicks, // logged-pick count per regime bucket
    // Strategy efficacy at the pick's OWN published entry/stop/target (target-before-stop
    // over MAX_HOLD). null for sleeves that never logged levels. Distinct from `horizons`,
    // which measure signal efficacy (did the stock move) regardless of the trade plan.
    strategy: summarizePlans(g.plans),
    horizons: Object.fromEntries(HORIZONS.map(([hk, hb]) => [hk, summarizeReturns(g.h[hk] || [], { horizonBars: hb })])),
    // Common-date mark-to-market (mtm-v1): resolved 1m nets + OPEN positions marked at
    // the latest close — the anti-survivorship-in-time lane. null when nothing to mark.
    mtm: mtmSummary(g),
    // Trigger-verified fill accounting (entry-v2.1, conditional contracts only): how many
    // episodes actually FILLED per horizon vs never triggered (noFill) or gapped past the
    // chase ceiling (gapSkip). The return stats above contain ONLY the filled ones — this
    // is the honest denominator the assumed-fill basis used to hide. null elsewhere.
    fills: g.fillsByH || null,
    // Per-regime forward returns: { 'risk-on': {1w,1m,3m}, 'risk-off': {…} }.
    byRegime: Object.fromEntries(REGIME_BUCKETS.map(rb =>
      [rb, Object.fromEntries(HORIZONS.map(([hk, hb]) => [hk, summarizeReturns((g.reg[rb] || {})[hk] || [], { horizonBars: hb })]))])),
    // Per-liquidity-tier forward returns (only buckets that actually have picks): does
    // the edge survive in liquid, tradeable names or only in the illiquid tail?
    byLiquidity: Object.fromEntries(Object.keys(g.liq).map(lt =>
      [lt, Object.fromEntries(HORIZONS.map(([hk, hb]) => [hk, summarizeReturns(g.liq[lt][hk] || [], { horizonBars: hb })]))])),
    // Per-sector forward returns — only sectors with a meaningful sample (≥5 picks at some
    // horizon) so a lone pick can't fake a sector verdict.
    bySector: Object.fromEntries(Object.keys(g.sec)
      .filter(sc => HORIZONS.some(([hk]) => (g.sec[sc][hk] || []).length >= 5))
      .map(sc => [sc, Object.fromEntries(HORIZONS.map(([hk, hb]) => [hk, summarizeReturns(g.sec[sc][hk] || [], { horizonBars: hb })]))])),
  })).sort((a, b) => a.section === b.section
    ? (a.tier === b.tier ? String(a.scope || '').localeCompare(String(b.scope || '')) : a.tier.localeCompare(b.tier))
    : a.section.localeCompare(b.section));

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
    // Scoped evidence-key contract (defect #5): the version field is what tells
    // expectancyFor to enforce the scoped join. Execution/label contract versions
    // are summary-level (every record in one summary shares one contract).
    const EI = require('./evidence-identity');
    const summary = {
      generatedAt,
      evidenceKeyVersion: EI.EVIDENCE_KEY_VERSION,
      evidenceKeyFields: EI.EVIDENCE_KEY_FIELDS,
      mayPoolScopes: EI.MAY_POOL_SCOPES,
      executionPolicyVersion: ENTRY_MODEL_VERSION,
      labelVersion: 'scoreboard-forward-v1',
      // `noHistory` MUST survive this projection: lib/maturity derives the ungradeable-
      // pick (delisting-shaped missingness) ceiling from the PERSISTED groups; dropping
      // it here silently pinned the survivorship gate at UNMEASURED for every strategy
      // while the response-side counter looked healthy. benchFallback rides along so a
      // sector-labeled record with substituted benchmarks is visible downstream.
      groups: out.map(g => ({ section: g.section, tier: g.tier, scope: g.scope, picks: g.picks, noHistory: Number.isFinite(g.noHistory) ? g.noHistory : null, benchFallback: Number.isFinite(g.benchFallback) ? g.benchFallback : null, selfBenchmarked: Number.isFinite(g.selfBenchmarked) ? g.selfBenchmarked : null, horizons: g.horizons })),
      sectionDecile,
    };
    // Content hash of the evidence itself (same algo/serialization as the immutable
    // ledger): governance persists it, and a promotion artifact must match it — an
    // approval judged on other evidence cannot be resurrected by a fresh rewrite.
    try {
      const { stableStringify } = require('./immutable-ledger');
      summary.evidenceHash = require('node:crypto').createHash('sha256').update(stableStringify(summary.groups)).digest('hex');
    } catch { summary.evidenceHash = null; }
    // AWAITED (was fire-and-forget): a silently failing summary write froze every
    // downstream grade on stale evidence while each run reported success.
    // DEGRADED RUNS DO NOT REWRITE THE EVIDENCE RECORD. A run that could not read every
    // ledger produces a summary in which the unreadable strategies look untracked; writing
    // it would change evidenceHash, invalidate every version-matched promotion artifact,
    // and demote live strategies on the strength of a transient Blob failure. The previous
    // summary — written by a complete run — stays authoritative until a complete run
    // replaces it. Same principle as safeToWrite/ledgerWriteDecision for daily ledgers.
    // A hard failure always blocks. A PARTIAL read blocks only when the loss is material
    // (> MAX_DAY_LOSS_RATE): one flaky shard out of 250 days should not freeze the
    // evidence record, but a systematic outage must not silently shrink it either.
    const blocking = ledgerErrors.filter(e => !e.partial || e.material);
    if (blocking.length) {
      summaryWriteError = `skipped: ${blocking.length} ledger(s) unreadable or materially incomplete (${blocking.map(e => e.ledger).join(', ')}) — evidence not rewritten from a degraded run`;
    } else {
      try { await writeJSON('scoreboard/summary.json', summary, 300); }
      catch (e) { summaryWriteError = String((e && e.message) || e); }
    }
  }

  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  return res.json({ configured: true, ledgerErrors, degraded: ledgerErrors.length > 0, totalPicks: picks.length, loggedRows: rawPicks.length + rawGhost.length + cernPicks.length + rawTone.length + rawAttn.length + rawRT.length + rawAnom.length + rawSW.length + rawCA.length + rawTS.length + rawDownDay.length + rawGapDown.length + rawDaytrade.length + rawCoil.length + rawIgnition.length + rawOmega.length, regimeSplit: !!macroLookup, groups: out, allocation, scoreQuality: summaryWriteError ? { ...scoreQuality, summaryWriteError } : scoreQuality, costModel: { version: COST_MODEL_VERSION, roundTripPct: { liquid: roundTripCostPct('liquid'), small: roundTripCostPct('small'), micro: roundTripCostPct('micro'), biotech: roundTripCostPct('biotech') } }, entryModel: { version: ENTRY_MODEL_VERSION, basisVersion: ENTRY_BASIS_VERSION, basis: 'entry-v2.1: sections with a next-session-open contract fillPolicy are graded from the NEXT open (basis-consistent benchmark); conditional-trigger contracts (coil/gapdown) are graded TRIGGER-VERIFIED on daily bars — no-fill when the trigger never trades inside the horizon, gap-skip past the chase ceiling, gap-through at the worse open, benchmark anchored at the verified fill date, per-group fill counts in `fills` — the fill time within a bar is a daily-bar approximation, NOT an intraday-verified fill (that lane is op=gapgoverify); the frozen daytrade section keeps the legacy logged-level/close basis; the r.real lane (entry-v1) additionally reports next-open for every pick' }, generatedAt });
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
  // Central adaptive policy: 'disable' reverts to the shipped presets even when
  // a fitted version exists (the fit stays on record, just not in force).
  const model = await readModel();
  const apexPolicy = await require('./adaptive-layers').layerPolicy('apex-recalibrate');
  const activeId = apexPolicy === 'disable' ? null : model.activeId;
  const active = activeId ? model.versions.find(v => v.id === activeId) : null;
  const activeWeights = active && active.weights ? active.weights : null;
  // Tag every signal with this week's dominant market narrative (sentiment layer).
  const nar = await readNarrative();
  const narrativeTag = nar ? nar.tag : null;

  // The scoring version stamped on each record: the recalibrated model id when a
  // Module-2 re-fit is live, else the static formula version. Historical picks stay
  // attributable to the exact rules that produced them.
  const scoringVersion = activeId || apex.SCORING_VERSION;
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
//
// Pre-move redesign (Phase 1): the ledger now observes `ghostTop` — the Ghost
// scan over the FULL cross-section — not merely `results` (the breakout buffer).
// Previously a standalone quiet-accumulation name that never entered the buffer
// was invisible here, so the Ghost track record graded a breakout-filtered
// population. Scopes now include `expanded` when its candle cache is available.
// Alongside the legacy ledger (shape preserved for Scoreboard compatibility),
// the op writes an IMMUTABLE full-candidate observation record (ghostobs/) with
// selected + rejected + near-threshold rows via lib/premove-capture.js.
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
  const obsScopes = [];
  for (const scope of ['large', 'small', 'micro', 'expanded']) {
    let d;
    try { d = await getJSON('/api/screener?scope=' + scope + (scope === 'large' ? '&lookback=1M' : '')); } catch { sourceErrors++; continue; }
    if (scope === 'large' && d.ghost && d.ghost.regime) regime = d.ghost.regime;
    // The `expanded` scope serves only from its compiled candle cache; an empty
    // scan means the cache was unavailable — skip rather than record a hole.
    if (scope === 'expanded' && !(d.ghostTop || []).length && !(d.results || []).length) continue;

    // Full-candidate observation input (selected/rejected/near-threshold built
    // downstream by premove-capture — deterministic, scope provenance retained).
    obsScopes.push({
      scope,
      ghostTop: d.ghostTop || [],
      resultsTickers: (d.results || []).map(c => c && c.ticker).filter(Boolean),
      scannedCount: d.scannedCount ?? null,
      dataCutoff: (d.ghostTop || []).find(r => r && r.dataCutoff) ? (d.ghostTop || []).find(r => r && r.dataCutoff).dataCutoff : null,
      generatedAt: d.generatedAt || null,
    });

    // Legacy ledger fold — now over the UNION of ghostTop and results so the
    // graded population is the full accumulation scan, not the breakout buffer.
    // ghostTop rows carry `ghost` + optional `featureSnapshot`; results rows
    // carry `ghost` + `metrics`. Record shape is unchanged (additive fields only).
    const fold = (c, fromGhostTop) => {
      const g = c.ghost;
      if (!g || !c.ticker || c.price == null) return;
      if (g.tier !== 'GHOST' && g.tier !== 'STALKING') return;   // log Ghost / Stalking only
      const lv = c.levels || {};
      const m = c.metrics || (c.featureSnapshot && c.featureSnapshot.metrics) || {};
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
        // Additive provenance (legacy consumers ignore unknown keys):
        standalone: fromGhostTop && !c.inBreakoutResults ? true : false,
        dollarVol: Number.isFinite(c.dollarVol) ? c.dollarVol : ((c.factors && Number.isFinite(c.factors.dollarVol)) ? c.factors.dollarVol : null),
      };
      const prev = byTicker.get(c.ticker);
      if (!prev || RANK[g.tier] > RANK[prev.tier] || (RANK[g.tier] === RANK[prev.tier] && g.score > prev.score)) byTicker.set(c.ticker, rec);
    };
    (d.ghostTop || []).forEach(c => fold(c, true));
    (d.results || []).forEach(c => fold(c, false));
  }
  const signals = [...byTicker.values()];

  const guard = await safeToWrite('ghost/', date, signals.length, sourceErrors);
  if (!guard.write) {
    return res.status(200).json({ ok: true, skipped: guard.reason, degraded: true, date, regime, count: signals.length, existing: guard.existing, sourceErrors });
  }
  let url = null, err = null;
  try { const r = await writeGhostDay(date, signals); url = r.url; } catch (e) { err = String(e && e.message || e); }

  // Immutable full-candidate observation record (shadow; never read by live ranks).
  // Failure here degrades the response but never blocks the legacy ledger write.
  let obs = null, obsErr = null;
  try {
    const PC = require('./premove-capture');
    const LB = require('./research/live-bridge');
    const { isMarketHoliday } = require('./stats');
    const axis = LB.forwardSessionAxis(date, { isHoliday: isMarketHoliday });
    const record = PC.buildGhostObservation({
      date,
      eligibleEntryDate: LB.nextSessionAfter(date, axis),
      scopes: obsScopes,
    });
    await writeGhostObsDay(date, record);
    obs = record.counts;
  } catch (e) { obsErr = String(e && e.message || e); }

  return res.status(err ? 502 : 200).json({ ok: !err, date, regime, count: signals.length, url, error: err, observation: obs, observationError: obsErr, sourceErrors, at: new Date().toISOString() });
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

// ── Censoring-aware drift machinery (2026-08-04 audit) ──────────────────────
// A signal's age in TRADING sessions, approximated from calendar days (×252/365). Exact
// session counting would need a market calendar; a ±2-session error is immaterial against
// the 63-session hold window this feeds.
function signalAgeSessions(date, nowMs = Date.now()) {
  const ms = nowMs - Date.parse(`${date}T21:00:00Z`);   // from the signal date's close
  return Math.max(0, Math.round((ms / 864e5) * (252 / 365)));
}

// AGE-MATCHED baseline: the seed's expected RESOLVED-SO-FAR win rate under the live
// cohort's exact age distribution. For each live signal (resolved AND open — both shape the
// censoring process) the seed pool answers "of signals like this, what fraction had resolved
// by this age, and how many of those were wins?" — regime-matched per signal when the seed
// has ≥30 signals in that regime, whole-seed otherwise. Seed EXPIRED outcomes carry
// hold === MAX_HOLD, so at any age below the hold window they correctly count as
// still-unresolved. Returns null (fail closed) when the seed lacks per-signal hold data
// (pre-2026-08 backfills) — rerun op=backfill to upgrade the artifact.
function censoredSeedBaseline(seedSignals, liveSigs, nowMs = Date.now()) {
  const withHold = (seedSignals || []).filter(s => Number.isFinite(s.hold) && s.hold >= 1);
  if (withHold.length < 50 || !(liveSigs || []).length) return null;
  const byRegime = {};
  for (const s of withHold) (byRegime[s.regime] = byRegime[s.regime] || []).push(s);
  let expResolved = 0, expWins = 0, used = 0;
  for (const lv of liveSigs) {
    const age = signalAgeSessions(lv.date, nowMs);
    if (age < 1) continue;
    const pool = (byRegime[lv.regime] && byRegime[lv.regime].length >= 30) ? byRegime[lv.regime] : withHold;
    const resolved = pool.filter(s => s.hold <= age);
    expResolved += resolved.length / pool.length;
    expWins += resolved.filter(s => s.won).length / pool.length;
    used++;
  }
  if (!used || !(expResolved > 0)) return null;
  return {
    winRate: Math.round((expWins / expResolved) * 100),
    expectedResolvedFrac: +(expResolved / used).toFixed(2),
    liveSignalsUsed: used,
    source: 'historical seed · CENSORED at the live cohort\'s age distribution (resolved-so-far vs resolved-so-far — apples to apples)',
  };
}

// Status decision, pure. Precedence: sample floor → age-matched comparison → (no matched
// baseline possible) young-cohort fail-closed PENDING → mature-cohort uncensored comparison.
// The BROKEN/DEGRADING thresholds are unchanged from the original asymmetric design.
function driftVerdict({ liveWinRateCIHi, liveWinRate, windowN, matched, uncensored, medianAgeSessions, maxHold = MAX_HOLD }) {
  const compare = base => (liveWinRateCIHi != null && liveWinRateCIHi < base - 15) ? 'BROKEN'
    : (liveWinRate != null && liveWinRate < base - 5) ? 'DEGRADING' : 'HEALTHY';
  if (!(windowN >= 15)) return { status: 'PENDING', basis: 'insufficient-sample', baselineWinRate: null };
  if (matched && matched.winRate != null) {
    return { status: compare(matched.winRate), basis: 'age-matched-censored-baseline', baselineWinRate: matched.winRate };
  }
  if (medianAgeSessions < maxHold) {
    return {
      status: 'PENDING', basis: 'ledger-too-young-for-uncensored-comparison', baselineWinRate: null,
      note: `Median signal age ${medianAgeSessions} sessions < the ${maxHold}-session hold window: the resolved-so-far win rate is mechanically loss-dominated (wins resolve slower than stops) and cannot be compared against a fully-resolved baseline. Rerun op=backfill to regenerate the seed with per-signal hold data and enable the age-matched comparison.`,
    };
  }
  if (uncensored && uncensored.winRate != null) {
    return { status: compare(uncensored.winRate), basis: 'uncensored-baseline-mature-cohort', baselineWinRate: uncensored.winRate };
  }
  return { status: 'PENDING', basis: 'no-baseline', baselineWinRate: null };
}

// Read the whole ledger, dedupe to first-appearance per ticker:tier, resolve
// each signal's outcome. A terminal outcome (WIN/LOSS/EXPIRED) never changes, so
// it's cached in apex/resolved.json — only OPEN/uncached signals trigger a price
// fetch, keeping drift + recalibrate cheap as the ledger grows. Shared by both.
const ledgerKey = s => `${s.ticker}|${s.tier}|${s.date}`;

// First-appearance dedup per ticker:tier, ascending by date. Pure + exported because a
// refactor once replaced `if (!has) set` with `Map.add` (not a function → every caller
// 500'd from 2026-07-27 until this fix), and the tempting one-char repair (`.set`) would
// have been a SECOND bug: with the ascending sort, unconditional set keeps the LAST
// appearance and silently inverts the documented first-appearance semantics the drift/
// rank-quality statistics depend on. The regression test pins both properties.
function firstAppearanceDedup(raw) {
  const firstSeen = new Map();
  for (const s of [...raw].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
    const key = `${s.ticker}:${s.tier}`;
    if (!firstSeen.has(key)) firstSeen.set(key, s);
  }
  return [...firstSeen.values()];
}

async function resolveLedger() {
  const raw = await readAllApex();
  const sigs = firstAppearanceDedup(raw);

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
  const { sigs, resolved, openCount } = await resolveLedger();
  const toItem = s => ({ score: s.score, outcome: Number.isFinite(s.r) ? +(s.r * 100).toFixed(2) : null, won: !!s.won, regime: s.regime });
  const items = resolved.filter(s => Number.isFinite(s.score) && Number.isFinite(s.r)).map(toItem);
  const overall = analyzeRankQuality(items);
  const byRegime = {};
  for (const rk of ['RISK_ON', 'NEUTRAL', 'RISK_OFF']) {
    const seg = items.filter(x => x.regime === rk);
    if (seg.length) byRegime[rk] = analyzeRankQuality(seg, { minN: 15 });
  }
  // Censoring disclosure (2026-08-04 audit): every decile here measures RESOLVED-SO-FAR
  // outcomes of a young cohort — wins resolve far slower than stop-outs, so early in the
  // ledger's life win rates read near zero in EVERY decile regardless of ranking skill.
  const nowMsRq = Date.now();
  const agesRq = sigs.map(s => signalAgeSessions(s.date, nowMsRq)).sort((a, b) => a - b);
  const medianAgeRq = agesRq.length ? agesRq[Math.floor(agesRq.length / 2)] : 0;
  const ledgerYoung = medianAgeRq < MAX_HOLD;
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  return res.json({
    ok: true, source: 'apex-ledger', outcomeUnit: 'R×100 (realized R-multiple, %)',
    resolvedCount: items.length, openCount, overall, byRegime,
    censoring: {
      ledgerYoung, medianAgeSessions: medianAgeRq, holdWindowSessions: MAX_HOLD,
      note: ledgerYoung
        ? `CENSORED SAMPLE: median signal age ${medianAgeRq} sessions < the ${MAX_HOLD}-session hold window. Resolved-so-far outcomes are mechanically loss-dominated (stops resolve in days, targets in weeks-months), so decile win rates are biased low ACROSS THE BOARD and the verdict must not be read as ranking skill until the cohort matures.`
        : null,
    },
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

  let baseline = null, seed = null;
  try {
    seed = await readBackfill();
    const bt = (seed && Array.isArray(seed.signals) && seed.signals.length >= 50) ? null : await getJSON('/api/backtest?scope=large&months=12');
    baseline = baselineFor(window, seed, bt);
  } catch { /* baseline unavailable */ }

  // CENSORING-AWARE STATUS (2026-08-04 audit). `live` is the RESOLVED-SO-FAR win rate of a
  // young cohort: stop-outs resolve in days while target hits take weeks-months, so early in
  // the ledger's life the resolved pool is mechanically loss-dominated (replication with this
  // exact resolution rule: final winRate 39% reads 7-19% when censored at age 10-40
  // sessions). Comparing that against a FULLY-RESOLVED seed baseline made every young ledger
  // read BROKEN by construction. The verdict therefore uses an AGE-MATCHED baseline (the
  // seed's own resolved-so-far rate censored at the live cohort's exact age distribution)
  // and, when the seed lacks per-signal hold data, fails closed to PENDING until the cohort
  // matures. The uncensored baseline stays in the payload for display/provenance.
  const nowMs = Date.now();
  const matched = censoredSeedBaseline(seed && seed.signals, sigs, nowMs);
  const cohortAges = sigs.map(s => signalAgeSessions(s.date, nowMs)).sort((a, b) => a - b);
  const medianAgeSessions = cohortAges.length ? cohortAges[Math.floor(cohortAges.length / 2)] : 0;
  const verdict = driftVerdict({
    liveWinRateCIHi: live.winRateCI ? live.winRateCI.hi : null,
    liveWinRate: live.winRate,
    windowN: window.length,
    matched,
    uncensored: baseline,
    medianAgeSessions,
  });
  const status = verdict.status;

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

  // Active recalibrated model (if any) + standing ablation-review flags. The
  // display keeps showing a fitted model under policy 'disable' — hidden state
  // is how invisibility bugs start — but stamps whether it is actually in force.
  const model = await readModel();
  const active = model.activeId ? model.versions.find(v => v.id === model.activeId) : null;
  const apexPolicy = await require('./adaptive-layers').layerPolicy('apex-recalibrate');
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
    // Censoring disclosure (2026-08-04 audit): which baseline actually decided the status,
    // the age-matched baseline when computable, and the cohort's maturity. `live.winRate` is
    // a RESOLVED-SO-FAR number — it may only be compared against `matchedBaseline`, never
    // against the fully-resolved `baseline`, until the cohort passes the hold window.
    statusBasis: verdict.basis,
    statusBaselineWinRate: verdict.baselineWinRate,
    statusNote: verdict.note || null,
    matchedBaseline: matched,
    cohort: { signals: sigs.length, medianAgeSessions, holdWindowSessions: MAX_HOLD, mature: medianAgeSessions >= MAX_HOLD },
    regimeMix: regimeMix(window),
    forensics,
    failCount: fails.length,
    narrativeBreakdown,
    narrative,
    model: active ? { id: active.id, label: active.label, effectiveDate: active.effectiveDate, inForce: apexPolicy !== 'disable', adaptivePolicy: apexPolicy } : null,
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
  // Central adaptive policy: 'freeze'/'disable' block ADOPTION of a new fit —
  // the diagnostics still run and are reported, but nothing new goes in force.
  const adoptPolicy = await require('./adaptive-layers').layerPolicy('apex-recalibrate');
  let policyBlockedAdoption = false;
  if (diag.fittedAny && adoptPolicy !== 'allow') {
    policyBlockedAdoption = true;
  } else if (diag.fittedAny) {
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
    policyBlockedAdoption,
    perRegime: Object.fromEntries(['RISK_ON', 'NEUTRAL', 'RISK_OFF'].map(R => [R, { fitted: regimes[R].fitted, reason: regimes[R].reason, n: regimes[R].n }])),
  };
  let err = null;
  try { await writeModel(model); saved = true; } catch (e) { err = String(e && e.message || e); }

  return res.status(err ? 502 : 200).json({
    ok: !err, saved, error: err,
    source: srcLabel,
    refit: diag.fittedAny,
    policyBlockedAdoption,
    adaptivePolicy: adoptPolicy,
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
    if (req.query.mode === 'surprise') {  // TRUE multi-year SUE test (FMP Premium paired estimates)
      const sx = await runSurprisePEAD({ scope, months, limit: limit || 150, deadlineMs: 55000 });
      if (hasStore() && sx.horizons && sx.horizons['63']) {
        try {
          const pd = (await readPead()) || {};
          const h = sx.horizons['63'];
          pd.surprise = {
            verdict: sx.verdict, reason: sx.reason, scope, method: sx.method,
            eventsTotal: sx.eventsTotal, resolvedEvents: sx.resolvedEvents, coverage: sx.coverage,
            top63: h.topQuintile, bottom63: h.bottomQuintile, longShort63: h.longShort, signed63: h.signedOverall,
            byYear63: h.byYear, byRegime63: h.byRegime, generatedAt: new Date().toISOString(),
          };
          await writePead(pd);
        } catch {}
      }
      return res.json({ ok: !sx.error, ...sx });
    }
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

// ── op=congress / op=revisions : shadow alt-signal drift probes ─────────────
// Both test a newly-unlocked FMP Premium data source for durable market-excess
// drift, using the same PIT discipline as the SUE-PEAD engine. Diagnostic only —
// weight-0, never touches live ranking; results cached for the Custom Model panel.
async function runCongressOp(req, res) {
  const scope = ['large', 'small', 'micro'].includes(req.query.scope) ? req.query.scope : 'large';
  const limit = Math.max(0, parseInt(req.query.limit, 10) || 150);
  try {
    const { runCongress } = require('./congress');
    const out = await runCongress({ scope, limit, deadlineMs: 55000 });
    if (hasStore() && out.verdict) { try { await writeJSON('apex/congress.json', { ...out, generatedAt: new Date().toISOString() }); } catch { /* best-effort */ } }
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.json({ ok: !out.error, ...out });
  } catch (e) { return res.status(502).json({ ok: false, error: String(e && e.message || e) }); }
}
async function runRevisionsOp(req, res) {
  const scope = ['large', 'small', 'micro'].includes(req.query.scope) ? req.query.scope : 'large';
  const limit = Math.max(0, parseInt(req.query.limit, 10) || 150);
  const lookback = Math.min(6, Math.max(1, parseInt(req.query.lookback, 10) || 2));
  try {
    const { runRevisions } = require('./revisions');
    const out = await runRevisions({ scope, limit, lookback, deadlineMs: 55000 });
    if (hasStore() && out.verdict) { try { await writeJSON('apex/revisions.json', { ...out, generatedAt: new Date().toISOString() }); } catch { /* best-effort */ } }
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
  const congress = await readJSON('apex/congress.json', null);
  const revisions = await readJSON('apex/revisions.json', null);
  const compactProbe = p => (p && p.verdict) ? { verdict: p.verdict, reason: p.reason, resolvedEvents: p.resolvedEvents, coverage: p.coverage, signed63: p.horizons && p.horizons['63'] ? p.horizons['63'].signedOverall : null, longShort63: p.horizons && p.horizons['63'] ? p.horizons['63'].longShort : null, byYear63: p.horizons && p.horizons['63'] ? p.horizons['63'].byYear : null, byRegime63: p.horizons && p.horizons['63'] ? p.horizons['63'].byRegime : null, generatedAt: p.generatedAt } : null;
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
    pead: pead && (pead.horizons || pead.surprise) ? { resolvedEvents: pead.resolvedEvents, coverage: pead.coverage, h63: pead.horizons ? pead.horizons['63'] : null, h21: pead.horizons ? pead.horizons['21'] : null, validation5y: pead.validation5y || null, surprise: pead.surprise || null, generatedAt: pead.generatedAt } : null,
    altProbes: { congress: compactProbe(congress), revisions: compactProbe(revisions) },
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

module.exports = { MARKET_BENCH_SYMBOL, isSelfBenchmarked, excessOrNull, ignitionLedgerTier, momentumLedgerTier, momentumLedgerRow, runTrack, runScoreboard, runApexLog, runGhostLog, runEdgeLog, runEdgeBook, runVReversal, runVReversalTest, runDrift, runRecalibrate, runResearchOp, runExitsOp, runEmergingOp, runLongShortOp, runPeadOp, runBackfillOp, runModel, runNarrative, forwardReturn, forwardPath, nextOpenReturn, spyForwardReturn, summarizeReturns, dateLevelNetExcess, summarizePlans, cernPicksFrom, fadeRowsFrom, regimeBucketOf, runMoverStudyOp, runCernDecay, ledgerWriteDecision, runRankQuality, runCongressOp, runRevisionsOp, firstAppearanceDedup, signalAgeSessions, censoredSeedBaseline, driftVerdict, entryBasisForSection, mtmSummary, MTM_BARS };

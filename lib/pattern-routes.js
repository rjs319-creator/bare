// PATTERN INTELLIGENCE ROUTES — folded into api/tracker.js (no new serverless function).
//
//   op=patternsearch  public cached read — full multi-timeframe analysis for ONE ticker
//                     (powers the search-bar "Technical Structure & Pattern Intelligence").
//   op=patterns       public cached read — the Pattern Radar, served from the last logged
//                     snapshot (a live request must NOT brute-force the universe).
//   op=patternlog     privileged cron writer — scan a bounded pool, detect strong matches,
//                     write the immutable first-detection record + radar snapshot.
//   op=patterngrade   privileged cron writer — resolve matured matches using ONLY bars
//                     strictly after detection (no lookahead), append to a resolved doc.
//
// Everything is SHADOW: nothing here changes a live screener ranking. It fails closed when
// data is stale or unavailable.

const { analyzeTicker } = require('./patterns');
const { fetchDailyHistory } = require('./screener');
const store = require('./store');
const { etDate } = require('./freshness');

let signal = null;
try { signal = require('./signal'); } catch { /* intraday optional */ }
let macro = null;
try { macro = require('./macro'); } catch { /* regime optional */ }

const DAY_PREFIX = 'pattern/day/';
const RESOLVED_PREFIX = 'pattern/resolved/';
const STRONG_STREAM = 'pattern-strong';          // immutable hash-chained ledger stream
const STRONG_COMBINED = 0.75;                    // descriptive strong-match floor
const MAX_SCAN = 40;                             // bounded universe per run
const DEFAULT_UNIVERSE = ['AAPL', 'MSFT', 'NVDA', 'AMD', 'TSLA', 'META', 'AMZN', 'GOOGL', 'AVGO', 'NFLX', 'CRM', 'COST', 'JPM', 'XOM', 'UNH', 'LLY'];

const isNum = v => typeof v === 'number' && isFinite(v);
const sanitize = t => String(t || '').toUpperCase().replace(/[^A-Z.\-]/g, '').slice(0, 8);

// fetchDailyHistory returns { candles, ... } (or, defensively, a bare array). Normalize.
function candlesOf(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.candles)) return result.candles;
  return [];
}
async function fetchDaily(sym, range = '1y') {
  try { return candlesOf(await fetchDailyHistory(sym, range)); } catch { return []; }
}

async function currentRegime() {
  if (!macro) return 'NEUTRAL';
  try {
    const m = await macro.fetchMacro();
    if (m && m.regime) return m.regime === 'riskOff' ? 'RISK_OFF' : m.regime === 'riskOn' ? 'RISK_ON' : 'NEUTRAL';
  } catch { /* degrade */ }
  return 'NEUTRAL';
}

// Fetch the inputs and run the full analysis for one ticker.
async function analyzeOne(ticker, { withIntraday = false, marketRegime = 'NEUTRAL', spyDaily = null, corpus = [] } = {}) {
  const sym = sanitize(ticker);
  if (!sym) return { ticker, ok: false, reason: 'bad-ticker' };
  const daily = await fetchDaily(sym, '1y');
  if (!Array.isArray(daily) || daily.length < 30) return { ticker: sym, ok: false, reason: 'insufficient-history' };

  let intradayBars = null;
  if (withIntraday && signal && signal.fetchYahooIntraday) {
    try { intradayBars = await signal.fetchYahooIntraday(sym); } catch { intradayBars = null; }
  }
  const now = new Date().toISOString();
  return analyzeTicker({ ticker: sym, daily, intradayBars, spyDaily, marketRegime, corpus, now });
}

// ---- op=patternsearch ---------------------------------------------------------

async function runPatternSearch(req, res) {
  const ticker = sanitize(req.query.ticker);
  if (!ticker) return res.status(400).json({ ok: false, error: 'ticker required' });
  const marketRegime = await currentRegime();
  const spyDaily = await fetchDaily('SPY', '1y');
  const report = await analyzeOne(ticker, { withIntraday: true, marketRegime, spyDaily });
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
  return res.status(200).json({ ok: report.ok !== false, report, shadow: true, generatedAt: new Date().toISOString() });
}

// ---- op=patterns (radar, read snapshot) --------------------------------------

async function runPatterns(req, res) {
  const view = String(req.query.view || 'all');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400');
  if (!store.hasStore()) return res.status(200).json({ ok: true, ready: false, reason: 'no-store', shadow: true, radar: emptyRadar() });
  const snap = await readLatestDay();
  if (!snap) return res.status(200).json({ ok: true, ready: false, reason: 'not-built-yet', shadow: true, radar: emptyRadar() });
  const matches = filterRadar(snap.matches || [], view);
  return res.status(200).json({ ok: true, ready: true, date: snap.date, shadow: true, count: matches.length, radar: bucketRadar(matches), matches });
}

function emptyRadar() { return { actionableNow: [], nearTrigger: [], forming: [], retesting: [], tooExtended: [], failedToday: [], strongMatches: [], researchOnly: [] }; }

function bucketRadar(matches) {
  const r = emptyRadar();
  for (const m of matches) {
    const a = m.plan && m.plan.action;
    if (a === 'ACTIONABLE_NOW') r.actionableNow.push(m);
    else if (a === 'WAIT_FOR_TRIGGER' && m.phase === 'NEAR_TRIGGER') r.nearTrigger.push(m);
    else if (a === 'WAIT_FOR_TRIGGER' && m.phase === 'RETESTING') r.retesting.push(m);
    else if (a === 'FORMING') r.forming.push(m);
    else if (a === 'DO_NOT_CHASE') r.tooExtended.push(m);
    else if (a === 'FAILED' || a === 'EXIT_INVALIDATED') r.failedToday.push(m);
    else if (a === 'RESEARCH_ONLY') r.researchOnly.push(m);
    if (m.similarity && m.similarity.matchTier === 'STRONG') r.strongMatches.push(m);
  }
  // Default rank: proven edge & actionability & freshness first, similarity last.
  const rank = (x) => (x.plan && x.plan.action === 'ACTIONABLE_NOW' ? 3 : 0) + (x.proven ? 2 : 0) + (x.currentSessionFresh ? 1 : 0) + (x.similarity ? x.similarity.combined : 0);
  r.strongMatches.sort((a, b) => rank(b) - rank(a));
  return r;
}

function filterRadar(matches, view) {
  if (view === 'bullish') return matches.filter(m => m.direction === 'LONG');
  if (view === 'bearish') return matches.filter(m => m.direction === 'SHORT');
  if (view === 'actionable') return matches.filter(m => m.plan && m.plan.action === 'ACTIONABLE_NOW');
  return matches;
}

// ---- op=patternlog (privileged writer) ---------------------------------------

async function runPatternLog(req, res) {
  if (!store.hasStore()) return res.status(200).json({ ok: false, reason: 'no-store' });
  const date = etDate();
  const tickers = (req.query.tickers ? String(req.query.tickers).split(',') : DEFAULT_UNIVERSE).map(sanitize).filter(Boolean).slice(0, MAX_SCAN);
  const marketRegime = await currentRegime();
  const spyDaily = await fetchDaily('SPY', '1y');

  const t0 = Date.now();
  const deadline = 45000;
  const matches = [];
  let scanned = 0;
  let appended = 0;
  for (const t of tickers) {
    if (Date.now() - t0 > deadline) break;
    scanned++;
    const report = await analyzeOne(t, { marketRegime, spyDaily });
    if (!report || report.ok === false || !report.detections) continue;
    for (const d of report.detections) {
      if (!d.similarity || !isNum(d.similarity.combined) || d.similarity.combined < STRONG_COMBINED) continue;
      matches.push(slimMatch(d, report));
      // Immutable first-detection record (hash-chained, write-once) for the strongest matches.
      try {
        const led = require('./immutable-ledger');
        if (led.hasStore && led.hasStore()) { await led.append(STRONG_STREAM, firstDetection(d, report, date)); appended++; }
      } catch { /* ledger optional; the write-once snapshot below is the durable record either way */ }
    }
  }

  // Write-ONCE day snapshot: preserve the first-detection radar for the day (never rewrite).
  const path = `${DAY_PREFIX}${date}.json`;
  const existing = await store.readJSON(path, null);
  if (!existing) await store.writeJSON(path, { date, matches, scanned, generatedAt: new Date().toISOString(), version: 'pattern-v1' }, 0);
  return res.status(200).json({ ok: true, date, scanned, matched: matches.length, ledgerAppended: appended, alreadyLogged: !!existing });
}

function slimMatch(d, report) {
  return {
    ticker: d.ticker, patternFamily: d.patternFamily, patternLabel: d.patternLabel, direction: d.direction,
    timeframe: d.timeframe, horizon: d.horizon, phase: d.phase, similarity: d.similarity, plan: d.plan,
    prediction: d.prediction, proven: d.proven, currentSessionFresh: d.currentSessionFresh, lifecycleState: d.lifecycleState,
    reasonCodes: d.reasonCodes, noviceExplanation: d.noviceExplanation, context: report.context,
    modelVersion: d.modelVersion, featureVersion: d.featureVersion,
  };
}

// The immutable payload — everything needed to grade later, nothing that can be revised.
function firstDetection(d, report, date) {
  return {
    date, ticker: d.ticker, patternFamily: d.patternFamily, direction: d.direction, timeframe: d.timeframe,
    phase: d.phase, detectedPrice: d.detectedPrice, patternStart: d.patternStart, patternAsOf: d.patternAsOf,
    similarity: d.similarity, plan: d.plan, prediction: d.prediction, context: report.context,
    modelVersion: d.modelVersion, featureVersion: d.featureVersion, analogIndexVersion: d.analogIndexVersion,
    affectedProductionDecision: false, displayRank: null,
  };
}

// ---- op=patterngrade (privileged writer) -------------------------------------
// Resolve matured first-detections using ONLY post-detection daily bars.

async function runPatternGrade(req, res) {
  if (!store.hasStore()) return res.status(200).json({ ok: false, reason: 'no-store' });
  let led;
  try { led = require('./immutable-ledger'); } catch { return res.status(200).json({ ok: false, reason: 'no-ledger' }); }
  const chain = (await led.readChain(STRONG_STREAM)) || [];
  const resolvedDoc = await store.readJSON(`${RESOLVED_PREFIX}index.json`, { resolved: {} });
  const already = resolvedDoc.resolved || {};
  const horizonDays = Math.max(5, Math.min(63, parseInt(req.query.horizon, 10) || 21));
  const t0 = Date.now();
  let graded = 0;

  for (const entry of chain) {
    if (Date.now() - t0 > 40000) break;
    const p = entry.payload;
    const key = `${p.ticker}:${p.patternFamily}:${p.date}`;
    if (already[key]) continue;
    if (!p.plan || !isNum(p.plan.trigger) || !isNum(p.plan.stop) || !isNum(p.plan.target)) continue;
    const daily = await fetchDaily(p.ticker, '1y');
    if (!daily.length) continue;
    const idx = daily.findIndex(c => String(c.date) > String(p.patternAsOf));   // strictly AFTER detection
    if (idx < 0) continue;
    const forward = daily.slice(idx, idx + horizonDays);
    if (forward.length < Math.min(5, horizonDays)) continue;                     // not matured yet
    const outcome = resolvePlan(p.plan, p.direction, forward);
    if (outcome.pending) continue;
    already[key] = { ...outcome, ticker: p.ticker, patternFamily: p.patternFamily, date: p.date, resolvedAt: new Date().toISOString(), horizonDays };
    graded++;
  }
  await store.writeJSON(`${RESOLVED_PREFIX}index.json`, { resolved: already, updatedAt: new Date().toISOString() }, 0);
  return res.status(200).json({ ok: true, graded, totalResolved: Object.keys(already).length });
}

// Triple-barrier resolution against the plan, using post-detection bars only.
function resolvePlan(plan, direction, forward) {
  const long = direction !== 'SHORT';
  const entry = plan.trigger;
  const first = forward[0];
  // Require a fill: price must reach the trigger.
  let filled = false;
  for (const c of forward) {
    if (long ? c.high >= entry : c.low <= entry) { filled = true; break; }
  }
  if (!filled) return { targetFirst: false, outcome: 'no-fill', netReturnPct: 0 };
  for (const c of forward) {
    const hitTarget = long ? c.high >= plan.target : c.low <= plan.target;
    const hitStop = long ? c.low <= plan.stop : c.high >= plan.stop;
    if (hitTarget && hitStop) return { targetFirst: false, outcome: 'ambiguous-stop-first', netReturnPct: pctMove(entry, plan.stop, long) }; // intrabar straddle → assume stop (conservative)
    if (hitTarget) return { targetFirst: true, outcome: 'target', netReturnPct: pctMove(entry, plan.target, long) };
    if (hitStop) return { targetFirst: false, outcome: 'stop', netReturnPct: pctMove(entry, plan.stop, long) };
  }
  const lastC = forward[forward.length - 1].close;
  return { targetFirst: false, outcome: 'timeout', netReturnPct: pctMove(entry, lastC, long) };
}

function pctMove(entry, exit, long) {
  if (!isNum(entry) || entry === 0) return 0;
  const raw = (exit - entry) / entry * 100;
  return Math.round((long ? raw : -raw) * 100) / 100;
}

async function readLatestDay() {
  try {
    const { list } = require('@vercel/blob');
    const { blobs } = await list({ prefix: DAY_PREFIX });
    if (!blobs || !blobs.length) return null;
    const latest = blobs.map(b => b.pathname).sort().reverse()[0];
    const date = latest.replace(DAY_PREFIX, '').replace('.json', '');
    return await store.readJSON(`${DAY_PREFIX}${date}.json`, null);
  } catch { return null; }
}

module.exports = {
  runPatternSearch, runPatterns, runPatternLog, runPatternGrade,
  analyzeOne, resolvePlan, bucketRadar, slimMatch,
  DAY_PREFIX, RESOLVED_PREFIX, STRONG_STREAM,
};

// DATA-CAPTURE ROUTE HANDLERS (archive / insider / fundamentals / CERN) —
// extracted from api/tracker.js. Self-contained: no apex-core helpers used.
const { fetchOptionsBaseline } = require('./options-baseline');
const { LIQUID_OPTIONS } = require('./optionsflow');
const { fetchQuarterlySeries } = require('./earnings');
const { CERN } = require('./cern');
const { LARGE: UNI_LARGE } = require('./universe');
const { fetchDailyHistory } = require('./screener');
const { nowET } = require('./stats');
const { hasStore, readCern, writeCern, readInsider, writeInsider,
        readFundamentals, writeFundShard, writeArchiveDay, readAllArchive } = require('./store');
const { extractSessionBars, fetchFiveMin } = require('./intraday-capture');
const { requireMethod, ingestAuthorized } = require('./auth');

// ── op=archive : snapshot today's per-ticker mention counts + options ───────
// THE unrecoverable data capture. Social-mention counts (StockTwits trending)
// and option-chain snapshots can't be reconstructed historically, so we persist
// one panel per day. Universe = today's socially-trending names (the natural
// join key for a mentions × options study). One Blob write per run.
async function fetchTrendingStockTwits() {
  try {
    const r = await fetch('https://api.stocktwits.com/api/2/trending/symbols/equities.json?limit=30',
      { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return [];
    return (await r.json()).symbols || [];
  } catch { return []; }
}

// Recent Coil / Day-Trade / Gap candidate tickers (the names the screeners actually
// surface) from their ledgers → the natural universe for an options/IV × outcome
// study. The archive runs BEFORE the daily tick ops in the warm cron, so we read the
// most-recent few days (the candidate set is stable day-to-day) rather than today's
// not-yet-written file. Returns ticker → Set(source tags), so we can prioritize coil
// names (the IV/RV coil-ranker is the primary forward test this feeds).
async function recentCandidateTickers(maxDays = 3) {
  const { readAllCoilDays, readAllDaytradeDays, readAllGapDays } = require('./store');
  const src = new Map();
  const add = (t, s) => { t = String(t || '').toUpperCase(); if (!t) return; if (!src.has(t)) src.set(t, new Set()); src.get(t).add(s); };
  const pull = async (readAll, tag) => { try { const days = await readAll(); (days || []).slice(-maxDays).forEach(d => (d.picks || []).forEach(p => add(p && p.ticker, tag))); } catch {} };
  await Promise.all([pull(readAllCoilDays, 'coil'), pull(readAllDaytradeDays, 'daytrade'), pull(readAllGapDays, 'gap')]);
  return src;
}

const ARCHIVE_MAX = 140;                        // cap the universe so the widened archive can't blow the cron
const ARCHIVE_OPTIONS_DEADLINE_MS = 28_000;     // stop fetching options past this; unfetched keep options=null

async function runArchive(req, res) {
  if (!hasStore()) {
    return res.status(200).json({ ok: false, error: 'Blob storage not configured (create a Vercel Blob store).', count: 0 });
  }
  const { date, isMarketClosed } = nowET();
  // Skip weekends/holidays so a closed session's stale mentions + option chains
  // don't inflate the per-ticker baseline as if it were a distinct observation.
  if (isMarketClosed && req.query.force !== '1') {
    return res.status(200).json({ ok: true, skipped: 'market-closed', date, count: 0 });
  }
  const ts = Date.now();

  // Universe = today's socially-trending names (mention-count proxy) UNIONED with the
  // app's own recent screener candidates (coil/day-trade/gap). Widening from ~30
  // trending names to the candidate list makes the unrecoverable options/IV data
  // accrue for the names the screeners flag — enabling the IV/RV coil-ranker and
  // crowding-fade forward tests. Every un-archived day is lost forever.
  const [trending, candSrc] = await Promise.all([fetchTrendingStockTwits(), recentCandidateTickers(3).catch(() => new Map())]);
  const trendByTicker = new Map();
  trending.forEach((s, i) => { const t = String(s.symbol || '').toUpperCase(); if (t && !trendByTicker.has(t)) trendByTicker.set(t, { company: s.title || null, mentions: s.watchlist_count || 0, trendRank: i + 1 }); });

  // Priority order (so the highest-value names are captured first if the budget runs
  // short): coil candidates → trending → the rest. Dedupe, cap at ARCHIVE_MAX.
  // The fixed liquid-options universe the optionsflow signal scans (NVDA/TSLA/…).
  // Always capture it so those names build a CONSISTENT daily per-ticker baseline —
  // otherwise they're only archived on days they happen to trend, and "unusual vs
  // normal" can never be computed for them.
  const liquidSet = new Set(LIQUID_OPTIONS.map(t => String(t).toUpperCase()));
  const seen = new Set(); const ordered = [];
  const push = t => { t = String(t || '').toUpperCase(); if (t && !seen.has(t)) { seen.add(t); ordered.push(t); } };
  for (const [t, tags] of candSrc) if (tags.has('coil')) push(t);
  for (const t of liquidSet) push(t);           // options-signal universe — high priority, captured every day
  for (const t of trendByTicker.keys()) push(t);
  for (const t of candSrc.keys()) push(t);
  const base = ordered.slice(0, ARCHIVE_MAX).map(t => {
    const tr = trendByTicker.get(t), tags = candSrc.get(t);
    return {
      ticker: t,
      company: tr ? tr.company : null,
      mentions: tr ? tr.mentions : null,        // StockTwits watchers — null (NOT 0) when a name isn't in
                                                //   the trending feed: "not measured" ≠ "zero attention", so
                                                //   the baseline reader skips it instead of seeing a false crash
      trendRank: tr ? tr.trendRank : null,
      sources: [...(tr ? ['trending'] : []), ...(liquidSet.has(t) ? ['liquid-opts'] : []), ...(tags ? [...tags] : [])],
    };
  });

  // Attach a numeric options baseline per name (Yahoo chain, nearest expiry), bounded
  // by a wall-clock deadline so a wider universe never overruns the warm cron budget.
  let i = 0;
  async function worker() {
    while (i < base.length) {
      const idx = i++;
      if (Date.now() - ts > ARCHIVE_OPTIONS_DEADLINE_MS) { base[idx].options = null; continue; }
      try { base[idx].options = await fetchOptionsBaseline(base[idx].ticker); }
      catch { base[idx].options = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, base.length) }, worker));

  const withOpts = base.filter(r => r.options).length;
  let url = null, err = null;
  try {
    const r = await writeArchiveDay(date, base, { ts, source: 'stocktwits+candidates+yahoo-options', count: base.length, withOptions: withOpts, trending: trendByTicker.size, candidates: candSrc.size });
    url = r.url;
  } catch (e) { err = String(e && e.message || e); }
  return res.status(err ? 502 : 200).json({ ok: !err, date, count: base.length, withOptions: withOpts, trending: trendByTicker.size, candidates: candSrc.size, url, error: err, at: new Date().toISOString() });
}

// ── op=baseline : read the archive → per-ticker "what's normal" + today's unusual ─
// The consumer the daily archive was always missing. Turns the accumulated options/
// attention snapshots into per-ticker baselines and returns the names whose latest
// reading is a statistical outlier vs their own history (|z| ≥ threshold).
async function runBaseline(req, res) {
  if (!hasStore()) {
    return res.status(200).json({ ok: false, error: 'Blob storage not configured (create a Vercel Blob store).' });
  }
  const { computeBaselines } = require('./baseline');
  const minObs = Math.max(2, parseInt(req.query.minObs, 10) || 8);
  const z = Math.max(1, parseFloat(req.query.z) || 2);
  const days = await readAllArchive();
  const result = computeBaselines(days, { minObs, z });
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400');
  return res.status(200).json({
    ok: true, asOf: result.asOf, days: result.days, minObs: result.minObs, zThreshold: result.zThreshold,
    tickersTracked: Object.keys(result.tickers).length,
    unusualCount: result.unusual.length,
    unusual: result.unusual,
    // Full per-ticker baselines only when explicitly requested (keeps the default payload small).
    tickers: req.query.full === '1' ? result.tickers : undefined,
    at: new Date().toISOString(),
  });
}

// ── op=insideringest : receive EDGAR Form 4 history from the external builder ─
// The full-universe EDGAR pull is too slow for a Vercel function, so an external
// box (lib/edgar via scripts/build-insider.js) builds it and POSTs per-ticker
// transaction lists here. Merges per ticker into apex/insider.json.
async function runInsiderIngest(req, res) {
  if (!requireMethod(req, res, ['POST'])) return;
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  if (!ingestAuthorized(req, 'INSIDER_INGEST_TOKEN')) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const doc = (await readInsider()) || { tickers: {} };
  if (!doc.tickers) doc.tickers = {};
  if (req.query.reset === '1') { doc.tickers = {}; }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  // Accept { tickers: { T: [txs] } } (bulk) or { ticker, txs } (single).
  const bulk = body && body.tickers && typeof body.tickers === 'object' ? body.tickers
    : (body && body.ticker && Array.isArray(body.txs)) ? { [String(body.ticker).toUpperCase()]: body.txs } : null;
  if (!bulk) return res.status(400).json({ ok: false, error: 'expected JSON { tickers:{T:[txs]} } or { ticker, txs:[] }' });

  let merged = 0, txCount = 0;
  for (const t in bulk) {
    if (!Array.isArray(bulk[t])) continue;
    doc.tickers[t.toUpperCase()] = bulk[t];   // replace that ticker's history wholesale
    merged++; txCount += bulk[t].length;
  }
  doc.updatedAt = new Date().toISOString();
  let err = null;
  try { await writeInsider(doc); } catch (e) { err = String(e && e.message || e); }
  return res.status(err ? 502 : 200).json({ ok: !err, mergedTickers: merged, txReceived: txCount, totalTickers: Object.keys(doc.tickers).length, error: err });
}

// ── op=insider : coverage snapshot of the stored EDGAR insider history ───────
async function runInsider(req, res) {
  const doc = (await readInsider()) || { tickers: {} };
  const tickers = doc.tickers || {};
  const names = Object.keys(tickers);
  const withTx = names.filter(t => Array.isArray(tickers[t]) && tickers[t].length);
  const totalTx = names.reduce((s, t) => s + (Array.isArray(tickers[t]) ? tickers[t].length : 0), 0);
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    ok: true, updatedAt: doc.updatedAt || null,
    tickers: names.length, withTransactions: withTx.length, totalTransactions: totalTx,
    sample: withTx.slice(0, 8).map(t => ({ ticker: t, txs: tickers[t].length })),
  });
}

// ── op=fundbuild : resumable server-side build of point-in-time fundamentals ─
// Finnhub key is server-side only, so (unlike EDGAR) this runs ON Vercel. Free
// Finnhub is ~60 req/min, so we throttle and TIME-BOX each call, checkpointing to
// Blob and returning a cursor; re-invoke with ?start=<nextStart> until done.
//   GET /api/tracker?op=fundbuild&scope=large&limit=80[&start=0&reset=1]
async function runFundBuild(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  if (!process.env.FINNHUB_API_KEY) return res.status(200).json({ ok: false, error: 'FINNHUB_API_KEY missing' });
  const scope = (req.query.scope || 'large').toLowerCase();
  const list = scope === 'small' ? UNI_SMALL : scope === 'micro' ? UNI_MICRO : UNI_LARGE;
  const limit = Math.max(0, parseInt(req.query.limit, 10) || 0);
  const universe = [...new Set(list)].slice(0, limit || list.length);
  const start = Math.max(0, parseInt(req.query.start, 10) || 0);
  const throttle = Math.max(0, parseInt(req.query.throttle, 10) || 1100);  // ~60/min default
  const deadline = 45000, t0 = Date.now();

  // Each call builds an INDEPENDENT shard (no shared-doc read-modify-write → no
  // lost-update race). The shard key is pinned to `start`, so re-running a batch
  // just overwrites its own shard idempotently.
  const batch = {};
  let i = start, fetched = 0, withSeries = 0;
  for (; i < universe.length; i++) {
    if (Date.now() - t0 > deadline) break;
    const t = universe[i];
    try {
      const series = await fetchQuarterlySeries(t);
      batch[t] = series || [];
      fetched++; if (series && series.length) withSeries++;
    } catch { batch[t] = []; }
    if (throttle && i < universe.length - 1) await new Promise(r => setTimeout(r, throttle));
  }
  let err = null;
  try { await writeFundShard(`${scope}-${String(start).padStart(5, '0')}`, batch); } catch (e) { err = String(e && e.message || e); }
  const done = i >= universe.length;
  return res.status(err ? 502 : 200).json({
    ok: !err, scope, universe: universe.length, shard: `${scope}-${String(start).padStart(5, '0')}`,
    processedThisCall: fetched, withSeries, nextStart: done ? null : i, done, error: err,
  });
}

// ── op=fundamentals : coverage snapshot of stored quarterly series ──────────
async function runFundamentals(req, res) {
  const doc = (await readFundamentals()) || { tickers: {} };
  const t = doc.tickers || {};
  const names = Object.keys(t);
  const withSeries = names.filter(k => Array.isArray(t[k]) && t[k].length);
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    ok: true, updatedAt: doc.updatedAt || null, tickers: names.length, withSeries: withSeries.length,
    sample: withSeries.slice(0, 8).map(k => ({ ticker: k, quarters: t[k].length, latest: t[k][t[k].length - 1].period })),
  });
}

// ── op=cerntick : run one CERN daily cycle (detect + tick) and persist ──────
// Loads engine state, scans the universe for forced-flow events, advances the
// ledger, resolves matured signals (the Bayesian learning), and saves. Triggered
// by the warm cron. The archive is the moat — persisted, never pruned.
async function runCernTickOp(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  try {
    const state = await readCern();
    const cern = state ? CERN.load(state) : new CERN();
    const { runCernTick } = require('../lib/cern-run');
    const summary = await runCernTick(cern, { nowMs: Date.now() });
    let err = null;
    try { await writeCern(cern.s); } catch (e) { err = String(e && e.message || e); }
    return res.status(err ? 502 : 200).json({ ok: !err, ...summary, error: err, at: new Date().toISOString() });
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'CERN tick failed: ' + (e && e.message || e) });
  }
}

// ── op=cern : engine state for the ⚡ Events tab ────────────────────────────
async function runCern(req, res) {
  const state = await readCern();
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
  if (!state) return res.json({ ok: true, configured: false, note: 'CERN has not run yet — the warm cron will populate it.' });
  const cern = CERN.load(state);
  const open = cern.s.ledger.filter(e => e.status === 'SIGNALED' && e.signal).map(e => ({
    id: e.id, symbol: e.symbol, type: e.type, action: e.signal.action, side: e.signal.side,
    entry: +(e.signal.entryPrice || 0).toFixed(2), stop: e.signal.stop != null ? +e.signal.stop.toFixed(2) : null,
    target: e.signal.target != null ? +e.signal.target.toFixed(2) : null,
    predMu: +e.signal.predMu.toFixed(3), pProfit: +e.signal.pProfit.toFixed(2),
    size: +(e.signal.size || 0).toFixed(4), horizon: e.signal.horizon, regime: e.signal.regime, dateMs: e.signal.dateMs,
  }));
  return res.json({
    ok: true, configured: true,
    posteriors: cern._posteriorSummary(),
    open, pendingCount: cern.s.ledger.filter(e => e.status === 'PENDING').length,
    archiveCount: cern.s.archive.length,
    candidates: cern.s.candidates.slice(-10),
    drift: cern.s.changeLog.filter(c => c.type === 'DRIFT').slice(-10),
    explorationBudget: cern.s.explorationBudget,
  });
}

// ── op=cernfsprobe : read-only health check for the FIRE_SALE feed ─────────
// Confirms the FMP etf-holder source works on this key (the one piece that can't
// be tested without server-side creds) and shows current outflow status per ETF.
// Does NOT touch CERN state. ?etf=ARKK to probe a specific fund's holdings.
async function runCernFsProbe(req, res) {
  const { FIRESALE_ETFS, fetchEtfHoldings, detectEtfOutflow } = require('../lib/firesale');
  res.setHeader('Cache-Control', 'no-store');
  const probeEtf = (req.query.etf || 'ARKK').toUpperCase();
  // ?sim=1 dry-runs the full 3d pipeline with loosened thresholds against live
  // ETF bars (read-only — never writes CERN state) to prove the integrated chain:
  // outflow → holdings → aggregated forced names. Calm tape won't trip real gates,
  // so this is the only way to exercise the end-to-end path without a real dump.
  if (req.query.sim === '1') {
    const stressed = [];
    await Promise.all(FIRESALE_ETFS.map(async e => {
      try {
        const d = await fetchDailyHistory(e, '1y'); if (!d) return;
        const bars = d.candles.map(b => ({ ...b, dateMs: Date.parse(b.date + 'T00:00:00Z') }));
        const o = detectEtfOutflow(bars, { dropMin: 0.0, volRatioMin: 1.0 }); // loosened
        if (o) stressed.push({ etf: e, ...o });
      } catch {}
    }));
    const forced = new Map();
    for (const s of stressed) {
      const hs = await fetchEtfHoldings(s.etf);
      for (const h of hs) { if (h.weight < 0.02) continue; const cur = forced.get(h.ticker) || { dollars: 0, etfs: [] }; cur.dollars += h.weight * s.redeemedDollars; cur.etfs.push(s.etf); forced.set(h.ticker, cur); }
    }
    const ranked = [...forced.entries()].sort((a, b) => b[1].dollars - a[1].dollars).slice(0, 15);
    return res.json({ ok: true, sim: true, note: 'loosened thresholds, read-only — proves the chain, NOT real signals',
      stressedEtfs: stressed.map(s => ({ etf: s.etf, dumpPct: s.dumpPct, volRatio: s.volRatio })),
      forcedNames: ranked.map(([t, f]) => ({ t, forcedDollarsM: +(f.dollars / 1e6).toFixed(1), etfs: f.etfs })) });
  }
  let holdings = [];
  try { holdings = await fetchEtfHoldings(probeEtf); } catch (e) {}
  const outflow = {};
  await Promise.all(FIRESALE_ETFS.map(async e => {
    try { const d = await fetchDailyHistory(e, '1y'); if (d) { const o = detectEtfOutflow(d.candles.map((b, i, a) => ({ ...b, dateMs: Date.parse(b.date + 'T00:00:00Z') }))); outflow[e] = o ? { dumpPct: o.dumpPct, volRatio: o.volRatio } : null; } } catch { outflow[e] = 'fetch-failed'; }
  }));
  return res.json({
    ok: true,
    holdingsSource: { etf: probeEtf, source: 'yahoo-topHoldings', count: holdings.length, top: holdings.sort((a, b) => b.weight - a.weight).slice(0, 10).map(h => ({ t: h.ticker, w: +(h.weight * 100).toFixed(2) })) },
    outflow,
  });
}

// ── op=cernlockprobe : read-only health check for the LOCKUP_EXPIRY feed ───
// Joins the IPO-lockup calendar with each name's trailing avg daily dollar
// volume so the liquidity floor (lib/cern-run MIN_LOCKUP_DOLLAR_VOL) can be
// tuned against real data. Does NOT touch CERN state. ?floor=<usd> to test a cut.
async function runCernLockProbe(req, res) {
  const { fetchLockupExpiries } = require('../lib/ipo');
  res.setHeader('Cache-Control', 'no-store');
  const floor = Number(req.query.floor) || 3_000_000;
  let locks = [];
  try { locks = await fetchLockupExpiries({ nowMs: Date.now() }); } catch (e) {}
  const rows = [];
  let i = 0;
  const worker = async () => {
    while (i < locks.length) {
      const l = locks[i++];
      try {
        const d = await fetchDailyHistory(l.ticker, '1y');
        if (!d || d.candles.length < 30) { rows.push({ t: l.ticker, lockupDate: l.lockupDate, advUsdM: null, bars: false }); continue; }
        const w = d.candles.slice(-40);
        const adv = w.reduce((s, b) => s + (b.close || 0) * (b.volume || 0), 0) / w.length;
        rows.push({ t: l.ticker, lockupDate: l.lockupDate, advUsdM: +(adv / 1e6).toFixed(2), bars: true });
      } catch { rows.push({ t: l.ticker, lockupDate: l.lockupDate, advUsdM: null, bars: false }); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(12, locks.length) }, worker));
  rows.sort((a, b) => (b.advUsdM || 0) - (a.advUsdM || 0));
  const withBars = rows.filter(r => r.bars);
  const countsByFloor = {};
  for (const f of [1, 3, 5, 10]) countsByFloor['ge_' + f + 'M'] = withBars.filter(r => r.advUsdM >= f).length;
  return res.json({
    ok: true, found: locks.length, withBars: withBars.length,
    floorUsd: floor, passFloor: withBars.filter(r => r.advUsdM * 1e6 >= floor).length,
    countsByFloor, rows,
  });
}

// ── op=intracapture : accrue one completed session's 5-min bars for the day-trade
// picks, regime-tagged — feeds the regime-conditional opening-range-gate re-validation
// (research/41 was runner-heavy 2024–25 only). Rides the pre-market warm cron (no new
// cron): each morning the most-recent COMPLETED session is available, and the picks
// tradeable that session were signalled the session BEFORE it (the daytrade ledger is
// keyed by signal day). Idempotent per session date (skips if already captured).
const INTRADAY_MAX = 60;              // cap names/session (the tracked ledger is ~≤30)
const INTRADAY_DEADLINE_MS = 40000;   // wall-clock budget inside the op (own 60s function)

async function runIntraCapture(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured (create a Vercel Blob store).', count: 0 });
  const { readAllDaytradeDays, writeIntradayDay, readJSON } = require('./store');
  const ts = Date.now();

  // Most-recent COMPLETED session S = the last SPY daily bar (pre-market: yesterday).
  let S = null;
  try { const spy = await fetchDailyHistory('SPY'); const c = spy?.candles; S = c && c.length ? c[c.length - 1].date : null; } catch {}
  if (!S) return res.status(502).json({ ok: false, error: 'No SPY session date' });

  // Idempotent: don't re-capture a session already stored (unless ?force=1).
  if (req.query.force !== '1') {
    const existing = await readJSON(`intraday/${S}.json`, null);
    if (existing) return res.status(200).json({ ok: true, date: S, skipped: 'already-captured', count: (existing.events || []).length });
  }

  // Picks tradeable during session S were signalled the session BEFORE S → the daytrade
  // ledger entry with the greatest date strictly < S.
  const days = await readAllDaytradeDays();
  const L = days.filter(d => d.date < S).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  if (!L || !(L.picks || []).length) return res.status(200).json({ ok: true, date: S, count: 0, note: 'no prior-session day-trade picks to capture' });

  // Accurate session-S macro regime for fader/risk-off filtering; fall back to the
  // pick-time regime stored in the ledger if the macro lookup is unavailable.
  let regime = L.regime || 'neutral';
  try { const { buildMacroLookup } = require('./macro'); const mk = await buildMacroLookup(); const r = mk && mk.at ? mk.at(S) : null; if (r && r.regime) regime = r.regime; } catch {}

  const picks = [...new Map(L.picks.map(p => [p.ticker, p])).values()].slice(0, INTRADAY_MAX);
  const events = new Array(picks.length).fill(null);
  let i = 0;
  const worker = async () => {
    while (i < picks.length) {
      const idx = i++;
      if (Date.now() - ts > INTRADAY_DEADLINE_MS) return;   // bounded — never overrun the function budget
      const p = picks[idx];
      try {
        const result = await fetchFiveMin(p.ticker);
        const bars = result ? extractSessionBars(result, S) : [];
        if (bars.length >= 6) events[idx] = { ticker: p.ticker, scan: p.scan || null, sector: p.sector || null, signalClose: p.entry ?? null, bars };
      } catch { /* skip this name */ }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  const captured = events.filter(Boolean);

  let url = null, err = null;
  try { const r = await writeIntradayDay(S, { regime, signalDate: L.date, source: 'yahoo-5m', count: captured.length, events: captured }); url = r && r.url ? r.url : null; }
  catch (e) { err = String(e && e.message || e); }
  return res.status(err ? 502 : 200).json({ ok: !err, date: S, regime, signalDate: L.date, requested: picks.length, captured: captured.length, url, error: err, at: new Date().toISOString() });
}

// ── op=intraday : coverage summary of the accrued capture (is it building?) ──
async function runIntraday(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  const { readAllIntradayDays } = require('./store');
  const days = await readAllIntradayDays();
  const cnt = d => (d.count != null ? d.count : (d.events || []).length);
  const byRegime = {}; let events = 0;
  for (const d of days) { const n = cnt(d); events += n; byRegime[d.regime || 'unknown'] = (byRegime[d.regime || 'unknown'] || 0) + n; }
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    ok: true, sessions: days.length, events, byRegime,
    dateRange: days.length ? { from: days[0].date, to: days[days.length - 1].date } : null,
    days: days.map(d => ({ date: d.date, signalDate: d.signalDate || null, regime: d.regime || null, count: cnt(d) })),
  });
}

module.exports = { runArchive, runBaseline, runInsiderIngest, runInsider, runFundBuild, runFundamentals,
  runCernTickOp, runCern, runCernFsProbe, runCernLockProbe, runIntraCapture, runIntraday };

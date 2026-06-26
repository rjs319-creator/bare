'use strict';
// CORE MOMENTUM route handlers — the survivorship-safe small/mid sector-neutral 12-1
// sleeve (research/ steps 14-21) wired into the app's ledger + drift machinery, mirroring
// the Apex ops. All four ops live behind /api/tracker (12-function Hobby cap):
//   op=corebuild  — chunked, resumable refresh of the universe + per-name feature cache
//   op=core       — compute & serve today's book (ranked, filtered, equal-weighted)
//   op=corelog    — on quarterly rebalance, log the book's signals to the ledger
//   op=coredrift  — resolve outcomes + report live health vs the research baseline (kill-switch)

const core = require('./stablecore');
const { fetchDailyHistory } = require('./screener');
const { resolveTrade, MAX_HOLD } = require('./outcome');
const { wilson, nowET } = require('./stats');
const {
  hasStore, readCoreFeatures, writeCoreFeatures, readCoreState, writeCoreState,
  readCoreResolved, writeCoreResolved, readCoreBook, writeCoreBook,
  writeCoreDay, readAllCore,
} = require('./store');

// Research-derived drift reference for the validated STABLE-CORE book (quarterly EW).
// Used ONLY as a health yardstick, not a target. See research/data/*.log + PICK-TRACKING.
const BASELINE = { winRate: 0.62, pf: 1.4, meanReturnQ: 0.03 };
const MIN_RESOLVED = 15;          // don't judge health on fewer
const BUILD_CHUNK = 250, BUILD_CONC = 6, DRIFT_FETCH_CAP = 140;

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

// small concurrency pool
async function pool(items, conc, fn) {
  const out = []; let i = 0;
  async function worker() { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, worker));
  return out;
}

// most-recent logged book's tickers — the "held" set for the rank buffer
async function heldSet() {
  const all = await readAllCore();
  if (!all.length) return new Set();
  let latest = ''; for (const s of all) if (s.date && s.date > latest) latest = s.date;
  return new Set(all.filter(s => s.date === latest).map(s => s.ticker));
}

// ── op=corebuild : resumable universe + feature cache refresh ───────────────
async function runCoreBuild(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  if (!process.env.FMP_API_KEY) return res.status(200).json({ ok: false, error: 'FMP_API_KEY not configured.' });
  const today = new Date().toISOString().slice(0, 10);
  let state = await readCoreState();
  let refreshedUniverse = false;
  // (re)build the universe list daily-ish (stale > 7d) or on demand
  const stale = !state || !state.universeAsOf || (Date.now() - Date.parse(state.universeAsOf)) > 7 * 86400e3;
  if (stale || req.query.universe === '1') {
    try {
      const uni = await core.fetchUniverse();
      const meta = {}; for (const u of uni) meta[u.symbol] = { sector: u.sector, marketCap: u.marketCap, price: u.price, company: u.company };
      state = { universeAsOf: today, symbols: uni.map(u => u.symbol), meta, cursor: 0 };
      refreshedUniverse = true;
    } catch (e) { return res.status(502).json({ ok: false, error: 'universe fetch: ' + String(e && e.message || e) }); }
  }
  const symbols = state.symbols || [];
  if (!symbols.length) return res.status(200).json({ ok: false, error: 'empty universe' });

  const features = (await readCoreFeatures()) || { updatedAt: null, names: {} };
  const start = state.cursor || 0;
  const slice = symbols.slice(start, start + BUILD_CHUNK);
  let ok = 0, fail = 0;
  await pool(slice, BUILD_CONC, async sym => {
    try {
      const closes = await core.fetchCloses(sym);
      const f = core.featuresFromCloses(closes);
      const m = (state.meta && state.meta[sym]) || {};
      if (f) { features.names[sym] = { sector: m.sector, marketCap: m.marketCap, company: m.company, price: m.price ?? f.lastClose, m121: f.m121, vol63: f.vol63, adv20: f.adv20, asOf: today }; ok++; }
      else fail++;
    } catch { fail++; }
  });
  features.updatedAt = new Date().toISOString();
  state.cursor = (start + BUILD_CHUNK >= symbols.length) ? 0 : start + BUILD_CHUNK;   // wrap → continuous refresh

  try { await writeCoreFeatures(features); await writeCoreState(state); }
  catch (e) { return res.status(502).json({ ok: false, error: 'write: ' + String(e && e.message || e) }); }

  const covered = Object.keys(features.names).length;
  return res.status(200).json({ ok: true, refreshedUniverse, universeSize: symbols.length, processed: slice.length, ok, fail, cursor: state.cursor, covered, coveragePct: Math.round(100 * covered / symbols.length), wrapped: state.cursor === 0 });
}

// shared: compute the current book from the feature cache
async function computeBook() {
  const features = await readCoreFeatures();
  if (!features || !features.names) return { error: 'feature cache not built yet — run op=corebuild (daily cron seeds it over a few runs).' };
  const arr = Object.entries(features.names).map(([symbol, f]) => ({ symbol, ...f }));
  const held = await heldSet();
  const built = core.buildBook(arr, held);
  const regimeMom = mean(arr.filter(f => f.m121 != null).map(f => f.m121));
  return {
    asOf: features.updatedAt, universeCovered: arr.length,
    regime: regimeMom == null ? null : (regimeMom >= 0 ? 'risk-on' : 'risk-off'),
    ...built,
  };
}

// ── op=core : serve the live book ──────────────────────────────────────────
async function runCore(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  const b = await computeBook();
  if (b.error) return res.status(200).json({ ok: true, building: true, ...b, book: [] });
  res.setHeader('Cache-Control', 's-maxage=300');
  return res.status(200).json({ ok: true, rebalanceWindow: core.isRebalanceWindow(), quarter: core.quarterKey(), ...b });
}

// ── op=corelog : log the book once per quarter (rebalance) ─────────────────
async function runCoreLog(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.', count: 0 });
  const { date, isWeekend } = nowET();
  const force = req.query.force === '1';
  if (isWeekend && !force) return res.status(200).json({ ok: true, skipped: 'weekend', date, count: 0 });
  if (!core.isRebalanceWindow() && !force) return res.status(200).json({ ok: true, skipped: 'not-rebalance-window', date, quarter: core.quarterKey(), count: 0 });

  // already logged this quarter?
  const all = await readAllCore();
  const q = core.quarterKey();
  if (!force && all.some(s => s.quarter === q)) return res.status(200).json({ ok: true, skipped: 'already-logged-this-quarter', quarter: q, count: 0 });

  const b = await computeBook();
  if (b.error || !b.book || !b.book.length) return res.status(200).json({ ok: false, error: b.error || 'empty book', count: 0 });
  const ts = Date.now();
  const signals = b.book.map(x => ({
    date, ts, quarter: q, ticker: x.ticker, company: x.company, sector: x.sector,
    score: x.score, mom12_1: x.mom12_1, vol: x.vol, marketCap: x.marketCap, weight: x.weight,
    entry: x.levels.entry, stop: x.levels.stop, target: x.levels.target,
  }));
  let url = null, err = null;
  try { const r = await writeCoreDay(date, signals, { quarter: q, pool: b.pool, regime: b.regime }); url = r.url; await writeCoreBook({ ...b, loggedAt: new Date().toISOString() }); }
  catch (e) { err = String(e && e.message || e); }
  return res.status(err ? 502 : 200).json({ ok: !err, date, quarter: q, count: signals.length, url, error: err });
}

// ── op=coredrift : resolve outcomes + report health (Module-3 analogue) ─────
async function runCoreDrift(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  const signals = await readAllCore();
  if (!signals.length) return res.status(200).json({ ok: true, status: 'PENDING', note: 'No Core signals logged yet (logs quarterly on rebalance).', resolved: 0 });

  const resolved = (await readCoreResolved()) || {};
  // resolve OPEN / uncached signals (capped per call to stay within the function budget)
  const todo = signals.filter(s => { const k = `${s.ticker}|${s.date}`; return !resolved[k] || resolved[k].outcome === 'OPEN'; }).slice(0, DRIFT_FETCH_CAP);
  await pool(todo, 6, async s => {
    try {
      const d = await fetchDailyHistory(s.ticker, '1y');
      if (!d || !d.candles || !d.candles.length) return;
      const r = resolveTrade(d.candles, s.date, s.entry, s.stop, s.target, MAX_HOLD);
      resolved[`${s.ticker}|${s.date}`] = { outcome: r.outcome, r: r.r ?? null, hold: r.hold ?? null, exitDate: r.exitDate ?? null, resolvedAt: new Date().toISOString() };
    } catch { /* leave for next run */ }
  });
  try { await writeCoreResolved(resolved); } catch { /* non-fatal */ }

  // aggregate the closed outcomes
  const closed = signals.map(s => resolved[`${s.ticker}|${s.date}`]).filter(o => o && o.outcome && o.outcome !== 'OPEN');
  const wins = closed.filter(o => o.outcome === 'WIN' || (o.outcome === 'EXPIRED' && o.r > 0));
  const losses = closed.filter(o => o.outcome === 'LOSS' || (o.outcome === 'EXPIRED' && o.r <= 0));
  const grossWin = wins.reduce((s, o) => s + Math.max(0, o.r || 0), 0);
  const grossLoss = losses.reduce((s, o) => s + Math.abs(Math.min(0, o.r || 0)), 0);
  const winRate = closed.length ? wins.length / closed.length : null;
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null);
  const meanR = mean(closed.map(o => o.r || 0));
  const wil = closed.length ? wilson(wins.length, closed.length) : null;

  // health vs research baseline (asymmetric + sample-aware, mirroring apex drift)
  let status = 'PENDING', recommendation = null, killSwitch = false;
  if (closed.length >= MIN_RESOLVED && wil) {
    if (wil.high < BASELINE.winRate - 0.15) { status = 'BROKEN'; recommendation = 'Live win rate is materially below the research baseline — treat as informational only / consider reverting to passive small-mid exposure.'; killSwitch = true; }
    else if (winRate < BASELINE.winRate - 0.05 || (meanR != null && meanR < 0)) { status = 'DEGRADING'; recommendation = 'Soft warning — reduce size; monitor the next rebalance.'; }
    else status = 'HEALTHY';
    if (meanR != null && meanR < 0 && closed.length >= MIN_RESOLVED) killSwitch = true;  // kill-switch: negative realized expectancy
  }

  return res.status(200).json({
    ok: true, status, recommendation, killSwitch,
    total: signals.length, resolved: closed.length, open: signals.length - closed.length,
    winRate, wilson: wil, profitFactor: pf === Infinity ? null : pf, meanReturn: meanR,
    breakdown: { win: closed.filter(o => o.outcome === 'WIN').length, loss: closed.filter(o => o.outcome === 'LOSS').length, expired: closed.filter(o => o.outcome === 'EXPIRED').length },
    baseline: BASELINE, note: status === 'PENDING' ? `Need ≥${MIN_RESOLVED} resolved signals before judging health (quarterly cadence — matures slowly by design).` : null,
  });
}

// ── op=coreperf : quarterly performance of the logged cohorts vs IWM ───────
async function runCorePerf(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  const signals = await readAllCore();
  if (!signals.length) return res.status(200).json({ ok: true, empty: true, note: 'No Core cohorts logged yet — performance appears after the first quarterly rebalance.', quarters: [] });
  const resolved = (await readCoreResolved()) || {};
  // IWM (Russell 2000) benchmark — the honest small-cap yardstick (per the research charter).
  let bench = null;
  try { const d = await fetchDailyHistory('IWM', '2y'); if (d && d.candles) bench = d.candles; } catch { /* benchmark optional */ }
  const perf = core.aggregatePerformance(signals, resolved, bench, MAX_HOLD);
  res.setHeader('Cache-Control', 's-maxage=600');
  return res.status(200).json({ ok: true, benchmark: 'IWM', holdSessions: MAX_HOLD, ...perf });
}

module.exports = { runCoreBuild, runCore, runCoreLog, runCoreDrift, runCorePerf };

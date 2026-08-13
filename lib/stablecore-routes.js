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

// NO VALIDATED BASELINE (graduation-league F-06). The former hardcoded reference
// (win 62% / PF 1.4 / +3%/qtr) came from research this repo has since RETRACTED —
// research/MOMENTUM-SURVIVORSHIP-FREE-2026-07.md re-measured momentum rank-IC at ≈0
// on the survivorship-free panel. A retracted figure may not drive a health verdict
// or a kill-switch. Health is now judged only on the book's OWN live record; the
// kill-switch keeps its self-referential trigger (negative realized expectancy).
const BASELINE_BASIS = Object.freeze({
  basis: 'none-validated',
  note: 'The former research baseline (win 62%/PF 1.4) was retracted by the survivorship-free re-test (momentum rank-IC ≈ 0). Health is judged on the live record only.',
});
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

// most-recent logged cohort → held set (for the rank buffer) + prior ranks (for the
// daily rank-change indicator). Ranks are by score descending within that cohort.
async function lastCohort() {
  const all = await readAllCore();
  if (!all.length) return { date: null, held: new Set(), ranks: new Map() };
  let latest = ''; for (const s of all) if (s.date && s.date > latest) latest = s.date;
  const rows = all.filter(s => s.date === latest).sort((a, b) => (b.score || 0) - (a.score || 0));
  const ranks = new Map(); rows.forEach((s, i) => ranks.set(s.ticker, i + 1));
  return { date: latest, held: new Set(rows.map(s => s.ticker)), ranks };
}

// Pure: decide the post-refresh universe state. `result` is {ok:true, uni} or
// {ok:false, error}. A failed refresh with a usable PRIOR universe must NOT abort the
// build: the old `return res.status(502)` on any fetch error made a single cron-time FMP
// failure permanent — the stale check stayed true forever, so corebuild 502'd on EVERY
// nightly run from 2026-08-07 onward and the chunked feature refresh behind it never ran.
// Fatal only when there is nothing to fall back to.
function applyUniverseRefresh(prevState, result, today) {
  if (result && result.ok && Array.isArray(result.uni) && result.uni.length) {
    const meta = {}; for (const u of result.uni) meta[u.symbol] = { sector: u.sector, marketCap: u.marketCap, price: u.price, company: u.company };
    return { state: { universeAsOf: today, symbols: result.uni.map(u => u.symbol), meta, cursor: 0 }, refreshedUniverse: true, refreshError: null, fatal: false };
  }
  const refreshError = 'universe fetch: ' + String((result && result.error) || 'empty screener response');
  const canFallBack = !!(prevState && Array.isArray(prevState.symbols) && prevState.symbols.length);
  return { state: canFallBack ? prevState : null, refreshedUniverse: false, refreshError, fatal: !canFallBack };
}

// ── op=corebuild : resumable universe + feature cache refresh ───────────────
async function runCoreBuild(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  if (!process.env.FMP_API_KEY) return res.status(200).json({ ok: false, error: 'FMP_API_KEY not configured.' });
  const today = new Date().toISOString().slice(0, 10);
  let state = await readCoreState();
  let refreshedUniverse = false;
  let refreshError = null;
  // (re)build the universe list daily-ish (stale > 7d) or on demand
  const stale = !state || !state.universeAsOf || (Date.now() - Date.parse(state.universeAsOf)) > 7 * 86400e3;
  if (stale || req.query.universe === '1') {
    let result;
    try { result = { ok: true, uni: await core.fetchUniverse() }; }
    catch (e) { result = { ok: false, error: String(e && e.message || e) }; }
    const applied = applyUniverseRefresh(state, result, today);
    if (applied.fatal) return res.status(502).json({ ok: false, error: applied.refreshError });
    state = applied.state;
    refreshedUniverse = applied.refreshedUniverse;
    refreshError = applied.refreshError;   // non-fatal: keep building on the stale universe
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
  return res.status(200).json({ ok: true, refreshedUniverse, refreshError, universeAsOf: state.universeAsOf, universeSize: symbols.length, processed: slice.length, ok, fail, cursor: state.cursor, covered, coveragePct: Math.round(100 * covered / symbols.length), wrapped: state.cursor === 0 });
}

// shared: compute the current book from the feature cache
async function computeBook() {
  const features = await readCoreFeatures();
  if (!features || !features.names) return { error: 'feature cache not built yet — run op=corebuild (daily cron seeds it over a few runs).' };
  const arr = Object.entries(features.names).map(([symbol, f]) => ({ symbol, ...f }));
  const lc = await lastCohort();
  const built = core.buildBook(arr, lc.held);
  // daily rank-change vs the last logged rebalance (positive = moved up; null = new since then)
  for (const row of built.book) { const prev = lc.ranks.get(row.ticker); row.prevRank = prev || null; row.rankChange = prev ? prev - row.rank : null; }
  const regimeMom = mean(arr.filter(f => f.m121 != null).map(f => f.m121));
  return {
    asOf: features.updatedAt, universeCovered: arr.length, lastRebalance: lc.date,
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
  const { date, isMarketClosed } = nowET();
  const force = req.query.force === '1';
  if (isMarketClosed && !force) return res.status(200).json({ ok: true, skipped: 'market-closed', date, count: 0 });
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
      if (!d || !d.candles || !d.candles.length) {
        // EA-4: a name with NO fetchable history (delisted/acquired/halted) must not
        // silently stay OPEN forever — that is survivorship inside the record. Marked
        // and counted; still OPEN (not a resolved outcome), retried on later runs.
        const k = `${s.ticker}|${s.date}`;
        resolved[k] = { ...(resolved[k] || {}), outcome: 'OPEN', noHistory: true, noHistoryAt: new Date().toISOString() };
        return;
      }
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

  // Health from the book's OWN record only (no retracted baseline, F-06). The
  // kill-switch keeps its self-referential trigger: negative realized expectancy.
  let status = 'PENDING', recommendation = null, killSwitch = false;
  if (closed.length >= MIN_RESOLVED && wil) {
    if (meanR != null && meanR < 0) {
      status = 'NEGATIVE'; killSwitch = true;
      recommendation = 'Realized expectancy is negative over the resolved record — treat as informational only / consider reverting to passive small-mid exposure.';
    } else if (wil.high < 0.5) {
      status = 'DEGRADING';
      recommendation = 'The Wilson upper bound on the live win rate sits below 50% — soft warning; monitor the next rebalance.';
    } else status = 'OBSERVING';
  }
  // Delisting-shaped missingness (EA-4): names whose history no longer fetches would
  // otherwise stay OPEN forever — survivorship inside the shop-window record.
  const noHistoryKeys = Object.keys(resolved).filter(k => resolved[k] && resolved[k].noHistory);

  return res.status(200).json({
    ok: true, status, recommendation, killSwitch,
    total: signals.length, resolved: closed.length, open: signals.length - closed.length,
    noHistory: noHistoryKeys.length,
    noHistoryRate: signals.length ? +(noHistoryKeys.length / signals.length).toFixed(4) : 0,
    winRate, wilson: wil, profitFactor: pf === Infinity ? null : pf, meanReturn: meanR,
    breakdown: { win: closed.filter(o => o.outcome === 'WIN').length, loss: closed.filter(o => o.outcome === 'LOSS').length, expired: closed.filter(o => o.outcome === 'EXPIRED').length },
    baseline: BASELINE_BASIS, note: status === 'PENDING' ? `Need ≥${MIN_RESOLVED} resolved signals before judging health (quarterly cadence — matures slowly by design).` : null,
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
  // MARK-TO-MARKET lane (EA-1): fetch a latest close for OPEN signals so the record
  // includes positions still at risk, capped to stay inside the function budget.
  const openSigs = signals.filter(s => { const o = resolved[`${s.ticker}|${s.date}`]; return !o || !o.outcome || o.outcome === 'OPEN'; }).slice(0, DRIFT_FETCH_CAP);
  const marks = new Map();
  await pool(openSigs, 6, async s => {
    try {
      const d = await fetchDailyHistory(s.ticker, '3mo');
      const last = d && d.candles && d.candles.length ? d.candles[d.candles.length - 1].close : null;
      if (Number.isFinite(last)) marks.set(`${s.ticker}|${s.date}`, last);
    } catch { /* unmarked opens are counted, not dropped */ }
  });
  // NET lane (EA-2): the book's charter universe is small/mid cap — one small-tier
  // round trip per trade (cost-v3), same haircut on open marks.
  const { roundTripCostPct } = require('./costs');
  const perf = core.aggregatePerformance(signals, resolved, bench, MAX_HOLD, { costPct: roundTripCostPct('small'), marks });
  res.setHeader('Cache-Control', 's-maxage=600');
  return res.status(200).json({
    ok: true, benchmark: 'IWM', holdSessions: MAX_HOLD,
    // EA-3 honesty stamp: logged entries come from the nightly feature cache (a
    // wrapping 250-name cursor), so an entry price can be up to ~6 sessions stale at
    // log time and is NOT an executable next-open fill. Basis is disclosed until the
    // logging path is re-versioned to a planFill NEXT_OPEN entry.
    entryBasis: 'logged feature-cache close (may be stale at log time; not an executable next-open fill)',
    costModel: 'cost-v3 small-tier round trip per trade',
    ...perf,
  });
}

module.exports = { runCoreBuild, runCore, runCoreLog, runCoreDrift, runCorePerf, applyUniverseRefresh };

// Post-Earnings-Announcement Drift (PEAD) test. The most promising place to look
// for DURABLE, information-based edge that isn't just disguised market beta:
// stocks that beat earnings expectations tend to keep drifting up for weeks after
// the announcement (and misses drift down). We measure the drift AFTER the
// announcement-day reaction (enter the next close), as SPY-EXCESS return (beta
// removed), bucketed by the size of the earnings surprise.
//
// Data: historical earnings surprises from Finnhub's calendar (all-symbol chunks,
// cheap) crossed with Yahoo price history. Self-diagnosing — returns event counts
// so we can confirm the free-tier data is actually there.
const { fetchDailyHistory, smaAt } = require('./screener');
const { LARGE, SMALL_CAPS, MICRO_CAPS } = require('./universe');
const KEY = process.env.FINNHUB_API_KEY;
const FMP = process.env.FMP_API_KEY;

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
function stats(arr) {
  const n = arr.length; if (!n) return { n: 0 };
  const m = mean(arr), sd = Math.sqrt(mean(arr.map(x => (x - m) ** 2))) || 1e-9;
  return { n, meanPct: +(m * 100).toFixed(2), hitRate: Math.round((arr.filter(x => x > 0).length / n) * 100), tStat: +(m / (sd / Math.sqrt(n))).toFixed(2) };
}

function chunkRanges(months, days) {
  const today = new Date(), start = new Date(Date.now() - months * 30 * 864e5), out = [];
  for (let d = new Date(start); d < today; d = new Date(d.getTime() + days * 864e5)) {
    out.push([d.toISOString().slice(0, 10), new Date(Math.min(today.getTime(), d.getTime() + days * 864e5)).toISOString().slice(0, 10)]);
  }
  return out;
}
const surprise = (actual, est) => Math.max(-200, Math.min(200, ((actual - est) / Math.max(0.02, Math.abs(est))) * 100));

// All earnings events (date + EPS surprise) over the window. Tries both providers
// and keeps whichever has the depth; reports per-source counts for diagnosis.
// opts.perSymbol → use FMP's per-symbol earnings endpoint (often deeper history
// than the date-range calendar) over opts.universe.
async function fetchEarnings(months, opts = {}) {
  const events = [], srcCounts = { finnhub: 0, fmp: 0 };
  const cutoff = new Date(Date.now() - months * 30 * 864e5).toISOString().slice(0, 10);

  if (FMP && opts.perSymbol && Array.isArray(opts.universe)) {
    const syms = opts.universe; let i = 0;
    const worker = async () => {
      while (i < syms.length) {
        const sym = syms[i++];
        try {
          const r = await fetch(`https://financialmodelingprep.com/stable/earnings?symbol=${sym}&apikey=${FMP}&limit=40`);
          if (!r.ok) continue; const rows = await r.json(); if (!Array.isArray(rows)) continue;
          for (const e of rows) {
            const est = e.epsEstimated ?? e.epsEstimate, act = e.epsActual ?? e.eps;
            if (!e.date) continue;
            // datesOnly: keep the announcement date even without an estimate (price-reaction proxy).
            if (!opts.datesOnly && (act == null || est == null)) continue;
            if (opts.datesOnly && act == null) continue;
            const d = String(e.date).slice(0, 10); if (d < cutoff) continue;
            events.push({ date: d, symbol: sym.toUpperCase(), surprisePct: (act != null && est != null) ? surprise(act, est) : null, actEps: act != null ? +act : null }); srcCounts.fmp++;
          }
        } catch {}
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    const seen = new Set(), out = []; for (const e of events) { const k = e.symbol + '|' + e.date; if (!seen.has(k)) { seen.add(k); out.push(e); } }
    out._srcCounts = srcCounts; return out;
  }

  if (KEY) {
    for (const [from, to] of chunkRanges(months, 80)) {
      try {
        const r = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${KEY}`);
        if (!r.ok) continue;
        for (const e of (await r.json()).earningsCalendar || []) {
          if (e.epsActual == null || e.epsEstimate == null || !e.symbol || !e.date) continue;
          events.push({ date: e.date, symbol: e.symbol.toUpperCase(), surprisePct: surprise(e.epsActual, e.epsEstimate) }); srcCounts.finnhub++;
        }
      } catch {}
    }
  }
  if (FMP) {
    for (const [from, to] of chunkRanges(months, 30)) {  // smaller windows in case the calendar caps rows per call
      try {
        const r = await fetch(`https://financialmodelingprep.com/stable/earnings-calendar?from=${from}&to=${to}&apikey=${FMP}`);
        if (!r.ok) continue;
        const rows = await r.json();
        if (!Array.isArray(rows)) continue;
        for (const e of rows) {
          const est = e.epsEstimated ?? e.epsEstimate, act = e.epsActual ?? e.eps;
          if (act == null || est == null || !e.symbol || !e.date) continue;
          events.push({ date: String(e.date).slice(0, 10), symbol: e.symbol.toUpperCase(), surprisePct: surprise(act, est) }); srcCounts.fmp++;
        }
      } catch {}
    }
  }
  // Dedupe by symbol+date (a provider may repeat).
  const seen = new Set(), out = [];
  for (const e of events) { const k = e.symbol + '|' + e.date; if (!seen.has(k)) { seen.add(k); out.push(e); } }
  out._srcCounts = srcCounts;
  return out;
}

async function runPEAD({ scope = 'large', months = 54, holds = [21, 63], limit = 0, perSymbol = false, datesOnly = false, deadlineMs = 50000 } = {}) {
  const t0 = Date.now();
  const list = scope === 'micro' ? MICRO_CAPS : scope === 'small' ? SMALL_CAPS : LARGE;
  let universe = [...new Set(list)]; if (limit > 0) universe = universe.slice(0, limit);
  const uniSet = new Set(universe);

  const allEvents = await fetchEarnings(months, { perSymbol, universe, datesOnly });
  const events = allEvents.filter(e => uniSet.has(e.symbol));
  // Coverage diagnostic — is the data full-history or recent-only / capped?
  const byYear = {}; events.forEach(e => { const y = e.date.slice(0, 4); byYear[y] = (byYear[y] || 0) + 1; });
  const ds = events.map(e => e.date).sort();
  const diag = { earningsRowsTotal: allEvents.length, sources: allEvents._srcCounts || null, eventsInUniverse: events.length, coverage: { earliest: ds[0] || null, latest: ds[ds.length - 1] || null, byYear } };
  if (events.length < 200) return { ...diag, note: 'Insufficient earnings-surprise history on the available data plans (Finnhub free caps the calendar; FMP earnings-calendar needs a paid plan). PEAD needs thousands of events — this engine is ready and will produce a real result the moment a paid earnings feed is connected.', elapsedMs: Date.now() - t0 };

  // SPY for beta removal + regime.
  const spy = await fetchDailyHistory('SPY', '5y');
  const sc = spy ? spy.candles : []; const scl = sc.map(x => x.close);
  const spyClose = {}; sc.forEach(x => { spyClose[x.date] = x.close; });
  const spyAbove200 = {}; sc.forEach((x, i) => { const s = smaAt(scl, 200, i); spyAbove200[x.date] = s != null ? x.close > s : null; });
  const spyDates = sc.map(x => x.date);
  const spyAt = d => { // SPY close on/before date d
    let lo = 0, hi = spyDates.length - 1, ans = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (spyDates[m] <= d) { ans = spyClose[spyDates[m]]; lo = m + 1; } else hi = m - 1; } return ans;
  };
  const regimeOn = d => { let lo = 0, hi = spyDates.length - 1, ans = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (spyDates[m] <= d) { ans = spyAbove200[spyDates[m]]; lo = m + 1; } else hi = m - 1; } return ans; };

  // Fetch price history for symbols that actually have events.
  const symbols = [...new Set(events.map(e => e.symbol))];
  const hist = new Map(); let fi = 0;
  const fw = async () => { while (fi < symbols.length) { const s = symbols[fi++]; if (Date.now() - t0 > deadlineMs) return; try { const d = await fetchDailyHistory(s, '5y'); if (d) hist.set(s, d.candles); } catch {} } };
  await Promise.all(Array.from({ length: 16 }, fw));

  // For each event: enter the CLOSE AFTER the announcement (skip the reaction day),
  // hold H sessions, record SPY-excess return + surprise + regime.
  const recs = []; // { surprisePct, regimeOn, ex: { 21:.., 63:.. } }
  for (const e of events) {
    const c = hist.get(e.symbol); if (!c) continue;
    let idx = -1; for (let k = 0; k < c.length; k++) { if (c[k].date >= e.date) { idx = k; break; } }
    if (idx < 1 || idx + 1 >= c.length) continue;
    const entryI = idx + 1, entry = c[entryI].close;            // day after announcement
    if (!(entry > 0)) continue;
    const spyEntry = spyAt(c[entryI].date); if (!(spyEntry > 0)) continue;
    const ex = {}; let ok = true;
    for (const H of holds) {
      const xi = entryI + H; if (xi >= c.length) { ok = false; break; }
      const spyExit = spyAt(c[xi].date); if (!(spyExit > 0)) { ok = false; break; }
      ex[H] = (c[xi].close - entry) / entry - (spyExit - spyEntry) / spyEntry; // SPY-excess (alpha)
    }
    if (!ok) continue;
    recs.push({ surprisePct: e.surprisePct, on: regimeOn(c[entryI].date), ex });
  }
  diag.resolvedEvents = recs.length;
  if (recs.length < 100) return { ...diag, note: 'too few resolvable events (price history / horizon room)', elapsedMs: Date.now() - t0 };

  // Quintiles by surprise; long-short = top quintile (big beats) − bottom (big misses).
  const out = { ...diag, scope, months, elapsedMs: Date.now() - t0, horizons: {} };
  for (const H of holds) {
    const withH = recs.filter(r => r.ex[H] != null).sort((a, b) => a.surprisePct - b.surprisePct);
    const q = 5, k = Math.floor(withH.length / q);
    const bottom = withH.slice(0, k), top = withH.slice(-k);
    const spread = top.map(r => r.ex[H]); const lows = bottom.map(r => r.ex[H]);
    const lsArr = []; const m = Math.min(top.length, bottom.length);
    for (let i = 0; i < m; i++) lsArr.push(top[i].ex[H] - bottom[i].ex[H]); // paired long-short
    const beats = withH.filter(r => r.surprisePct > 0).map(r => r.ex[H]);
    const misses = withH.filter(r => r.surprisePct <= 0).map(r => r.ex[H]);
    out.horizons[H] = {
      topQuintileExcess: stats(spread),       // big beats — should drift UP (alpha > 0)
      bottomQuintileExcess: stats(lows),       // big misses — should drift DOWN (alpha < 0)
      longShort: stats(lsArr),                 // beats − misses
      beatVsMiss: { beat: stats(beats), miss: stats(misses) },
      byRegime: {
        RISK_ON: stats(withH.filter(r => r.on === true).map(r => (r.surprisePct > 0 ? 1 : -1) * r.ex[H])),  // signed by surprise
        RISK_OFF: stats(withH.filter(r => r.on === false).map(r => (r.surprisePct > 0 ? 1 : -1) * r.ex[H])),
      },
    };
  }
  return out;
}

// ── 5-year reaction-PEAD validation ────────────────────────────────────────
// Uses FMP announcement DATES (available 5y, unlike estimates) + the 2-day
// announcement price reaction as the surprise proxy. Tests whether that initial
// earnings move predicts the next 1-3 months of market-excess drift — across
// regimes and years, including the 2022 bear. All from data already on hand.
function bucketAnalyze(recs, holds) {
  const out = {};
  for (const H of holds) {
    const withH = recs.filter(r => r.ex[H] != null).sort((a, b) => a.reaction - b.reaction);
    if (withH.length < 50) { out[H] = { n: withH.length }; continue; }
    const k = Math.floor(withH.length / 5);
    const bottom = withH.slice(0, k), top = withH.slice(-k);
    const ls = []; const m = Math.min(top.length, bottom.length);
    for (let i = 0; i < m; i++) ls.push(top[i].ex[H] - bottom[i].ex[H]);
    const byReg = {}, byYear = {};
    for (const R of ['RISK_ON', 'RISK_OFF']) {
      const sub = withH.filter(r => r.on === (R === 'RISK_ON'));
      // signed drift: align each event's drift with its reaction direction
      byReg[R] = stats(sub.map(r => Math.sign(r.reaction) * r.ex[H]));
    }
    for (const r of withH) { (byYear[r.year] = byYear[r.year] || []).push(Math.sign(r.reaction) * r.ex[H]); }
    out[H] = {
      n: withH.length,
      topQuintile: stats(top.map(r => r.ex[H])),       // biggest positive reactions — drift up?
      bottomQuintile: stats(bottom.map(r => r.ex[H])),  // biggest negative reactions — drift down?
      longShort: stats(ls),
      signedOverall: stats(withH.map(r => Math.sign(r.reaction) * r.ex[H])), // does reaction direction predict drift?
      byRegime: byReg,
      byYear: Object.fromEntries(Object.entries(byYear).filter(([, a]) => a.length >= 20).map(([y, a]) => [y, stats(a)])),
    };
  }
  return out;
}

async function runReactionPEAD({ scope = 'large', months = 60, holds = [21, 63], limit = 150, deadlineMs = 52000 } = {}) {
  if (!FMP) return { error: 'FMP_API_KEY required' };
  const t0 = Date.now();
  const list = scope === 'micro' ? MICRO_CAPS : scope === 'small' ? SMALL_CAPS : LARGE;
  let universe = [...new Set(list)]; if (limit > 0) universe = universe.slice(0, limit);
  const cutoff = new Date(Date.now() - months * 30 * 864e5).toISOString().slice(0, 10);

  // 1. FMP announcement dates (throttled ~270/min to respect the Starter limit).
  const dates = new Map(); let fetched = 0;
  for (const sym of universe) {
    if (Date.now() - t0 > deadlineMs * 0.62) break;  // reserve time for prices + compute
    try {
      const r = await fetch(`https://financialmodelingprep.com/stable/earnings?symbol=${sym}&apikey=${FMP}&limit=30`);
      if (r.ok) { const rows = await r.json(); if (Array.isArray(rows)) { const ds = rows.filter(e => e.date && (e.epsActual ?? e.eps) != null && String(e.date).slice(0, 10) >= cutoff).map(e => String(e.date).slice(0, 10)); if (ds.length) { dates.set(sym, ds); fetched++; } } }
    } catch {}
    await new Promise(r => setTimeout(r, 220));
  }

  // 2. SPY + per-symbol prices (5y).
  const spy = await fetchDailyHistory('SPY', '5y'); const sc = spy ? spy.candles : []; const scl = sc.map(x => x.close);
  const sd = sc.map(x => x.date); const sClose = {}; sc.forEach(x => { sClose[x.date] = x.close; });
  const sAbove = {}; sc.forEach((x, i) => { const s = smaAt(scl, 200, i); sAbove[x.date] = s != null ? x.close > s : null; });
  const onOrBefore = (arr, d) => { let lo = 0, hi = sd.length - 1, ans = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (sd[m] <= d) { ans = arr[sd[m]]; lo = m + 1; } else hi = m - 1; } return ans; };
  const spyAt = d => onOrBefore(sClose, d), regimeOn = d => onOrBefore(sAbove, d);

  const syms = [...dates.keys()]; const hist = new Map(); let fi = 0;
  const fw = async () => { while (fi < syms.length) { const t = syms[fi++]; try { const d = await fetchDailyHistory(t, '5y'); if (d) hist.set(t, d.candles); } catch {} } };
  await Promise.all(Array.from({ length: 16 }, fw));

  // 3. Reaction (2-day announcement excess move) + forward drift per event.
  const recs = [];
  for (const [sym, ds] of dates) {
    const c = hist.get(sym); if (!c) continue;
    for (const date of ds) {
      let idx = -1; for (let k = 0; k < c.length; k++) { if (c[k].date >= date) { idx = k; break; } }
      if (idx < 2 || idx + 1 >= c.length) continue;
      const entryI = idx + 1; if (entryI + Math.max(...holds) >= c.length) continue;
      const sBefore = spyAt(c[idx - 1].date), sEntry = spyAt(c[entryI].date);
      if (!(c[idx - 1].close > 0) || !(sBefore > 0) || !(sEntry > 0)) continue;
      const reaction = (c[entryI].close - c[idx - 1].close) / c[idx - 1].close - (sEntry - sBefore) / sBefore;
      const ex = {}; let ok = true;
      for (const H of holds) { const xi = entryI + H; if (xi >= c.length) { ok = false; break; } const sx = spyAt(c[xi].date); if (!(sx > 0)) { ok = false; break; } ex[H] = (c[xi].close - c[entryI].close) / c[entryI].close - (sx - sEntry) / sEntry; }
      if (!ok) continue;
      recs.push({ reaction, on: regimeOn(c[entryI].date) === true, year: date.slice(0, 4), ex });
    }
  }
  const ys = recs.map(r => r.year).sort();
  return { scope, months, symbolsFetched: fetched, symbolsWithPrices: syms.length, events: recs.length, coverage: { earliest: ys[0] || null, latest: ys[ys.length - 1] || null }, elapsedMs: Date.now() - t0, horizons: bucketAnalyze(recs, holds), method: 'announcement-day reaction proxy · SPY-excess drift' };
}

module.exports = { runPEAD, runReactionPEAD };

// #1 — Historical ledger backfill (technical-pillar seed for Module 2 / drift).
//
// Replays the SAME screener engine (`screenTicker`) on historical candle slices,
// so the reconstructed pillars are byte-for-byte the live definition — no factor
// re-implementation, no train/serve skew. Pillars 1/2/4 (momentum, structure,
// supply) come straight from price/volume and are faithful. Pillar 3 (fundamental)
// CANNOT be reconstructed historically (it's a live LLM narrative + current
// fundamentals), so it's pinned at the neutral default and every seeded signal is
// flagged `p3synthetic: true` — recalibration that consumes the seed fixes P3 and
// only re-fits the technical pillars.
const { fetchDailyHistory, screenTicker, smaAt } = require('./screener');
const { LARGE, SMALL_CAPS, MICRO_CAPS } = require('./universe');
const { resolveTrade, MAX_HOLD } = require('./outcome');
const { fetchRemovedConstituents } = require('./constituents');
const apex = require('./apex');

const MIN_HISTORY = 150;   // bars needed before a date for valid 126-day factors
const MIN_COHORT = 20;     // skip a date with too thin a cross-section to rank

// Cross-sectional percentile ranker (0-100) over a set of values.
function ranker(values) {
  const vals = values.filter(v => v != null && !isNaN(v)).sort((a, b) => a - b);
  return x => {
    if (x == null || isNaN(x) || !vals.length) return 0;
    let lo = 0, hi = vals.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (vals[m] <= x) lo = m + 1; else hi = m; }
    return Math.round((lo / vals.length) * 100);
  };
}

async function runBackfill({ scope = 'large', step = 21, months = 12, limit = 0, deadlineMs = 50000 } = {}) {
  const t0 = Date.now();
  const list = scope === 'micro' ? MICRO_CAPS : scope === 'small' ? SMALL_CAPS : LARGE;
  let tickers = [...new Set(list)];
  if (limit > 0) tickers = tickers.slice(0, limit);

  // Survivorship correction (large scope only): also scan names removed from the
  // index during the window. removalMap[ticker] = date they left → a removed name
  // only contributes signals for dates BEFORE it was removed (point-in-time).
  const removalMap = new Map();
  if (scope === 'large') {
    const removed = await fetchRemovedConstituents(3);
    for (const { ticker, removedDate } of removed) {
      if (!tickers.includes(ticker)) tickers.push(ticker);
      removalMap.set(ticker, removedDate);
    }
  }

  // SPY drives the regime read at each historical date. 2y history so there's
  // lookback + window + forward room for a 12-month backfill.
  const spy = await fetchDailyHistory('SPY', '2y');
  const spyCandles = spy ? spy.candles : [];
  const spyCloses = spyCandles.map(x => x.close);
  const spyByDate = {}; spyCandles.forEach(x => { spyByDate[x.date] = x.close; });
  const spyIdxOf = {}; spyCandles.forEach((x, i) => { spyIdxOf[x.date] = i; });

  // Fetch every name's daily history once.
  const hist = new Map();
  let fi = 0;
  const fworker = async () => { while (fi < tickers.length) { const t = tickers[fi++]; try { const d = await fetchDailyHistory(t, '2y'); if (d) hist.set(t, { candles: d.candles, meta: { ...d.meta, symbol: t } }); } catch { /* skip */ } } };
  await Promise.all(Array.from({ length: 16 }, fworker));

  // Date axis from SPY: every `step` trading days over the trailing window, leaving
  // ≥MAX_HOLD sessions of forward room so outcomes can resolve. Oldest → newest.
  const span = Math.min(spyCandles.length - 1, months * 21);
  const dates = [];
  for (let k = span; k >= MAX_HOLD; k -= step) dates.push(spyCandles[spyCandles.length - 1 - k].date);

  const signals = [];
  const stats = { datesPlanned: dates.length, datesUsed: 0, screenCalls: 0, byRegime: {}, byOutcome: { WIN: 0, LOSS: 0, EXPIRED: 0 }, byTier: { apex: 0, loaded: 0 } };

  for (const date of dates) {
    if (Date.now() - t0 > deadlineMs) { stats.stoppedEarly = true; break; }

    // As-of-`date` screen for every name with enough history + forward room.
    const rows = [];
    for (const [t, { candles, meta }] of hist) {
      // Point-in-time membership: skip a removed name on/after its removal date.
      const rd = removalMap.get(t);
      if (rd && date >= rd) continue;
      let idx = -1;
      for (let k = candles.length - 1; k >= 0; k--) { if (candles[k].date <= date) { idx = k; break; } }
      if (idx < MIN_HISTORY || candles.length - 1 - idx < MAX_HOLD) continue;
      const r = screenTicker(candles.slice(0, idx + 1), meta, { spyByDate });
      stats.screenCalls++;
      if (!r || !r.factors) continue;
      rows.push({ t, idx, candles, f: r.factors, m: r.metrics, status: r.status, above50: r.above50, levels: r.levels });
    }
    if (rows.length < MIN_COHORT) continue;
    stats.datesUsed++;

    // Cross-sectional percentile ranks across this date's cohort.
    const rk = {
      mom63: ranker(rows.map(x => x.f.mom63)), mom126: ranker(rows.map(x => x.f.mom126)),
      trend: ranker(rows.map(x => x.f.trendTemplate)), volAdj: ranker(rows.map(x => x.f.volAdjMom)),
      vol: ranker(rows.map(x => x.f.volSurge)), base: ranker(rows.map(x => x.f.baseQuality)),
      prox: ranker(rows.map(x => x.f.proximity)),
      accum: ranker(rows.map(x => x.m.accumRatio)), ud: ranker(rows.map(x => x.m.udVol)),
    };

    // Regime as-of the date (SPY vs its 200-DMA + cohort breadth).
    const si = spyIdxOf[date];
    let indexAbove200 = null;
    if (si != null) { const s200 = smaAt(spyCloses, 200, si); indexAbove200 = s200 != null ? spyCloses[si] > s200 : null; }
    const breadthPct = Math.round((rows.filter(x => x.above50).length / rows.length) * 100);
    const regime = apex.rawRegime({ bearish: indexAbove200 === false || breadthPct < 40, riskOn: indexAbove200 === true && breadthPct >= 45 });

    for (const row of rows) {
      const f = row.f, mt = row.m;
      const pct = {
        rs: rk.mom126(f.mom126),
        mom: Math.round((rk.mom63(f.mom63) + rk.mom126(f.mom126)) / 2),
        trend: rk.trend(f.trendTemplate), volAdj: rk.volAdj(f.volAdjMom),
        base: rk.base(f.baseQuality), vol: rk.vol(f.volSurge), prox: rk.prox(f.proximity),
        accum: rk.accum(mt.accumRatio), ud: rk.ud(mt.udVol),
      };
      // narrativeStrength null → Pillar 3 = neutral default (synthetic).
      const { pillars, score, tier } = apex.scoreCandidate({ pct, narrativeStrength: null, status: row.status }, regime);
      if (tier !== 'apex' && tier !== 'loaded') continue;
      const lv = row.levels || {};
      const entry = lv.entry != null ? lv.entry : row.candles[row.idx].close;
      const stop = lv.stop != null ? lv.stop : null;
      const target = lv.target != null ? lv.target : (lv.resistance != null ? lv.resistance : null);
      // Resolve against this signal's OWN stop/target (same lib/outcome rule as live).
      const out = resolveTrade(row.candles, date, entry, stop, target, MAX_HOLD);
      if (out.outcome === 'OPEN') continue;
      signals.push({
        date, ticker: row.t, scope, tier, score, pillars, regime, narrativeTag: null,
        entry: +entry.toFixed(2), stop, target, status: row.status, source: 'backfill', p3synthetic: true,
        outcome: out.outcome, r: out.r, won: out.outcome === 'WIN' || (out.outcome === 'EXPIRED' && out.r > 0),
      });
      stats.byOutcome[out.outcome]++; stats.byTier[tier]++;
      stats.byRegime[regime] = (stats.byRegime[regime] || 0) + 1;
    }
  }

  stats.elapsedMs = Date.now() - t0;
  stats.signals = signals.length;
  // Survivorship: removed constituents are included point-in-time. Residual bias
  // remains for names that delisted entirely (no price history) — small over 1-2y.
  stats.removedConstituents = removalMap.size;
  stats.removedSignals = signals.filter(s => removalMap.has(s.ticker)).length;
  stats.survivorshipBias = removalMap.size ? 'partially-corrected' : true;
  stats.universe = removalMap.size ? 'current + removed (point-in-time)' : 'current-constituents';
  return { signals, stats };
}

module.exports = { runBackfill };

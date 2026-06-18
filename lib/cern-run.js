// CERN orchestration — assembles the inputs the engine needs from the app's
// existing data, then runs a daily detect + tick. CERN's dataFor() is called
// SYNCHRONOUSLY inside dailyTick, so everything it returns must be pre-fetched
// and cached here first.
const { fetchDailyHistory } = require('./screener');
const { SECTOR_OF, LARGE, SMALL_CAPS, MICRO_CAPS } = require('./universe');
const { fetchMacro } = require('./macro');
const { fetchFundamentals } = require('./fundamentals');
const { fetchRecentIndexChanges } = require('./constituents');
const { fetchLockupExpiries } = require('./ipo');
const { FIRESALE_ETFS, fetchEtfHoldings, detectEtfOutflow } = require('./firesale');
const { fetchRecentDowngrades } = require('./downgrades');

const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const last = a => a[a.length - 1];
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Liquidity floor for LOCKUP_EXPIRY symbols. FMP's IPO calendar is full of
// SPACs / micro-caps / thin foreign listings whose forced lockup flow isn't
// tradeable; a real reversion needs real liquidity. Names trading under this in
// trailing average daily DOLLAR volume are skipped (override per-tick if needed).
const MIN_LOCKUP_DOLLAR_VOL = 3_000_000;

// Trailing average daily dollar volume (close × volume) over the last n sessions.
function avgDollarVol(bars, n = 40) {
  const w = bars.slice(-n);
  if (!w.length) return 0;
  return mean(w.map(b => (b.close || 0) * (b.volume || 0)));
}

// SECTOR_OF sector name → sector ETF (peer benchmark for dislocation).
const SECTOR_ETF = {
  'Technology': 'XLK', 'Communication Services': 'XLC', 'Consumer Discretionary': 'XLY',
  'Consumer Staples': 'XLP', 'Health Care': 'XLV', 'Financials': 'XLF', 'Industrials': 'XLI',
  'Energy': 'XLE', 'Utilities': 'XLU', 'Real Estate': 'XLRE', 'Materials': 'XLB',
};

const withMs = candles => candles.map(b => ({ ...b, dateMs: Date.parse(b.date + 'T00:00:00Z') }));

async function mapLimit(items, limit, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) { const idx = i++; await fn(items[idx]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Beta vs SPY from aligned daily returns (last ~150 overlapping days).
function computeBeta(bars, spyByDate) {
  const X = [], Y = [];
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].date, dp = bars[i - 1].date;
    if (spyByDate[d] == null || spyByDate[dp] == null) continue;
    Y.push(bars[i].close / bars[i - 1].close - 1);
    X.push(spyByDate[d] / spyByDate[dp] - 1);
  }
  const n = Math.min(X.length, 150);
  if (n < 30) return 1;
  const xs = X.slice(-n), ys = Y.slice(-n), mx = mean(xs), my = mean(ys);
  let cov = 0, varx = 0;
  for (let i = 0; i < n; i++) { cov += (xs[i] - mx) * (ys[i] - my); varx += (xs[i] - mx) ** 2; }
  return varx > 0 ? +(cov / varx).toFixed(2) : 1;
}

// Social-attention lookup: StockTwits trending equities → ticker → attentionZ.
// CERN lowers U (uninformedness) when the crowd is watching a name — we don't
// want to fade a dislocation the market is informed about. We key this off
// trending MEMBERSHIP + rank rather than volume: StockTwits ranks by surging
// message velocity, so being in the list is genuine crowd interest that is
// ORTHOGONAL to volume. (The old volume-z proxy was circular — a forced-flow
// event inflates volume itself, which wrongly inflated attention and suppressed
// exactly the trades CERN should take.) Non-trending names → attentionZ 0.
async function fetchSocialAttention() {
  const map = new Map();
  try {
    const r = await fetch('https://api.stocktwits.com/api/2/trending/symbols/equities.json?limit=30',
      { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return map;
    const syms = ((await r.json()) || {}).symbols || [];
    const n = syms.length || 1;
    syms.forEach((s, i) => {
      const t = String(s.symbol || '').toUpperCase().replace(/\./g, '-');
      if (!t) return;
      // rank 0 (hottest) → ~3, last → ~0.5; the U haircut starts above 0.5.
      map.set(t, +clamp(0.5 + 2.5 * (1 - i / n), 0.5, 3).toFixed(2));
    });
  } catch {}
  return map;
}

// Run one daily CERN cycle against `cern` (mutated in place). universe defaults
// to the S&P large list. Returns a render-friendly summary.
async function runCernTick(cern, { nowMs = Date.now(), universe = LARGE, concurrency = 18, deadlineMs = 50000, lockupMinDollarVol = MIN_LOCKUP_DOLLAR_VOL } = {}) {
  const t0 = Date.now();
  const uni = [...new Set(universe)];

  // 1) SPY (beta + regime context) and sector ETFs (peer benchmarks).
  const spy = await fetchDailyHistory('SPY', '1y');
  const spyByDate = {}; if (spy) spy.candles.forEach(c => { spyByDate[c.date] = c.close; });
  const etfs = [...new Set(Object.values(SECTOR_ETF))];
  const sectorBarsByEtf = {};
  await Promise.all(etfs.map(async e => { try { const d = await fetchDailyHistory(e, '1y'); if (d) sectorBarsByEtf[e] = withMs(d.candles); } catch {} }));
  // Concentrated/thematic ETFs we watch for redemption-driven fire-sales (step 3d).
  const firesaleEtfBars = {};
  await Promise.all(FIRESALE_ETFS.map(async e => { try { const d = await fetchDailyHistory(e, '1y'); if (d && d.candles.length >= 30) firesaleEtfBars[e] = withMs(d.candles); } catch {} }));

  // 2) Universe bars (one fetch each, cached for both detect and dataFor).
  const barsCache = new Map();
  await mapLimit(uni, concurrency, async (t) => {
    if (Date.now() - t0 > deadlineMs) return;
    try { const d = await fetchDailyHistory(t, '1y'); if (d && d.candles.length >= 30) barsCache.set(t, withMs(d.candles)); } catch {}
  });

  // 3) Auto-detect events (TAX_LOSS + MARGIN_SPIRAL) from bars + beta.
  for (const [t, bars] of barsCache) {
    cern.detectEvents(t, bars, { beta: computeBeta(bars, spyByDate), nowMs });
  }

  // 3b) Calendar feed — recent S&P index changes (INDEX_DELETE / INDEX_ADD_FADE).
  // Removed/added names may be outside the LARGE universe, so fetch their bars
  // too; estFlowShares ≈ a few days of ADV (passive funds rebalance over a window).
  try {
    const chg = await fetchRecentIndexChanges(70);
    const idxSyms = [...new Set([...chg.removes, ...chg.adds].map(x => x.ticker))].filter(t => !barsCache.has(t));
    await mapLimit(idxSyms, concurrency, async (t) => {
      try { const d = await fetchDailyHistory(t, '1y'); if (d && d.candles.length >= 30) barsCache.set(t, withMs(d.candles)); } catch {}
    });
    const estFlow = (t, mult) => { const b = barsCache.get(t); return b ? mult * mean(b.slice(-40).map(x => x.volume)) : 0; };
    for (const r of chg.removes)
      cern.addEvent({ type: 'INDEX_DELETE', symbol: r.ticker, dateMs: Date.parse(r.date + 'T00:00:00Z'), estFlowShares: estFlow(r.ticker, 4), direction: -1, meta: { source: 'sp-change', date: r.date, sector: SECTOR_OF[r.ticker] || '?' } });
    for (const a of chg.adds)
      cern.addEvent({ type: 'INDEX_ADD_FADE', symbol: a.ticker, dateMs: Date.parse(a.date + 'T00:00:00Z'), estFlowShares: estFlow(a.ticker, 4), direction: 1, meta: { source: 'sp-change', date: a.date, sector: SECTOR_OF[a.ticker] || '?' } });
  } catch {}

  // 3c) Lockup-expiry feed — recent IPOs hitting their 180d lockup (forced supply).
  // These are mostly small/mid-caps outside LARGE, so fetch their bars too. A
  // dollar-volume floor drops the calendar's untradeable SPAC/micro-cap noise
  // before any event is created (the rest of the gating happens in CERN).
  const lockups = { found: 0, withBars: 0, liquid: 0, events: 0, floorUsd: lockupMinDollarVol };
  try {
    const locks = await fetchLockupExpiries({ nowMs });
    lockups.found = locks.length;
    const lockSyms = [...new Set(locks.map(l => l.ticker))].filter(t => !barsCache.has(t));
    await mapLimit(lockSyms, concurrency, async (t) => {
      try { const d = await fetchDailyHistory(t, '1y'); if (d && d.candles.length >= 30) barsCache.set(t, withMs(d.candles)); } catch {}
    });
    const estFlow = (t, mult) => { const b = barsCache.get(t); return b ? mult * mean(b.slice(-40).map(x => x.volume)) : 0; };
    for (const l of locks) {
      const b = barsCache.get(l.ticker);
      if (!b) continue;                               // no bars (delisted/too new/illiquid)
      lockups.withBars++;
      const adv = avgDollarVol(b);
      if (adv < lockupMinDollarVol) continue;         // liquidity floor — skip untradeable names
      lockups.liquid++;
      if (cern.addEvent({ type: 'LOCKUP_EXPIRY', symbol: l.ticker, dateMs: l.lockupMs, estFlowShares: estFlow(l.ticker, 5), direction: -1, meta: { source: 'lockup', ipoDate: l.ipoDate, lockupDate: l.lockupDate, sector: SECTOR_OF[l.ticker] || '?', advUsd: Math.round(adv) } }))
        lockups.events++;
    }
  } catch {}

  // 3d) Fire-sale feed — concentrated ETFs under redemption-style stress force-sell
  // their holdings (FIRE_SALE). Detect a dump on each watched ETF's tape, then for
  // each stressed fund pull holdings and route its redeemed dollars to the top
  // names by weight. A name held by several dumping funds accrues their combined
  // forced flow (aggregated below before a single event is created per ticker).
  const firesale = { etfsScanned: 0, etfsStressed: 0, holdingsFetched: 0, forcedNames: 0, events: 0 };
  try {
    const stressed = [];
    for (const e of FIRESALE_ETFS) {
      const bars = firesaleEtfBars[e];
      if (!bars) continue;
      firesale.etfsScanned++;
      const o = detectEtfOutflow(bars, { nowMs });
      if (o) stressed.push({ etf: e, ...o });
    }
    firesale.etfsStressed = stressed.length;
    // Aggregate forced-sell dollars per holding across all stressed funds.
    const forced = new Map(); // ticker → { dollars, dateMs, etfs[] }
    for (const s of stressed) {
      const holdings = await fetchEtfHoldings(s.etf);
      if (holdings.length) firesale.holdingsFetched += holdings.length;
      for (const h of holdings) {
        if (h.weight < 0.02) continue;               // only names a dump moves meaningfully
        const dollars = h.weight * s.redeemedDollars;
        const cur = forced.get(h.ticker) || { dollars: 0, dateMs: s.dumpStartMs, etfs: [] };
        cur.dollars += dollars;
        cur.dateMs = Math.min(cur.dateMs, s.dumpStartMs);
        cur.etfs.push(s.etf);
        forced.set(h.ticker, cur);
      }
    }
    // Cap to the most-pressured names so a broad thematic unwind can't flood the ledger.
    const ranked = [...forced.entries()].sort((a, b) => b[1].dollars - a[1].dollars).slice(0, 60);
    firesale.forcedNames = ranked.length;
    const fsSyms = ranked.map(([t]) => t).filter(t => !barsCache.has(t));
    await mapLimit(fsSyms, concurrency, async (t) => {
      try { const d = await fetchDailyHistory(t, '1y'); if (d && d.candles.length >= 30) barsCache.set(t, withMs(d.candles)); } catch {}
    });
    for (const [ticker, f] of ranked) {
      const b = barsCache.get(ticker);
      if (!b) continue;
      const estFlowShares = f.dollars / (last(b).close || 1);
      if (cern.addEvent({ type: 'FIRE_SALE', symbol: ticker, dateMs: f.dateMs, estFlowShares, direction: -1, meta: { source: 'firesale', etfs: f.etfs, sector: SECTOR_OF[ticker] || '?' } }))
        firesale.events++;
    }
  } catch {}

  // 3e) Forced-downgrade feed — recent sell-side downgrades on names we track
  // trigger mechanical de-risking (FORCED_DOWNGRADE, dir -1 long reversion).
  const downgrades = { found: 0, events: 0 };
  try {
    const allow = new Set([...LARGE, ...SMALL_CAPS, ...MICRO_CAPS]);
    const dgs = await fetchRecentDowngrades({ nowMs, allow });
    downgrades.found = dgs.length;
    const dgSyms = dgs.map(d => d.ticker).filter(t => !barsCache.has(t));
    await mapLimit(dgSyms, concurrency, async (t) => {
      try { const d = await fetchDailyHistory(t, '1y'); if (d && d.candles.length >= 30) barsCache.set(t, withMs(d.candles)); } catch {}
    });
    const estFlow = (t, mult) => { const b = barsCache.get(t); return b ? mult * mean(b.slice(-40).map(x => x.volume)) : 0; };
    for (const dg of dgs) {
      if (!barsCache.has(dg.ticker)) continue;
      if (cern.addEvent({ type: 'FORCED_DOWNGRADE', symbol: dg.ticker, dateMs: dg.dateMs, estFlowShares: estFlow(dg.ticker, 3), direction: -1, meta: { source: 'downgrade', from: dg.from, to: dg.to, firm: dg.firm, sector: SECTOR_OF[dg.ticker] || '?' } }))
        downgrades.events++;
    }
  } catch {}

  // 4) Earnings proximity only for symbols actually on the ledger (small set).
  const ledgerSyms = [...new Set(cern.s.ledger.filter(e => e.status === 'PENDING' || e.status === 'SIGNALED').map(e => e.symbol))];
  const earningsCache = new Map();
  if (process.env.FINNHUB_API_KEY) {
    await mapLimit(ledgerSyms, 4, async (t) => {
      try { const f = await fetchFundamentals(t); earningsCache.set(t, f && f.earningsInDays != null ? f.earningsInDays : null); } catch { earningsCache.set(t, null); }
    });
  }

  // 4b) Social attention (StockTwits trending) — real crowd-interest signal for U.
  const attnLookup = await fetchSocialAttention();

  // 5) Synchronous dataFor from the caches.
  const dataFor = (sym) => {
    const bars = barsCache.get(sym);
    if (!bars) return null;
    const etf = SECTOR_ETF[SECTOR_OF[sym]];
    return {
      bars,
      sectorBars: etf ? (sectorBarsByEtf[etf] || null) : null,
      attentionZ: attnLookup.get(sym) ?? 0,
      daysToEarnings: earningsCache.has(sym) ? earningsCache.get(sym) : null,
      estimateRevisions: null,  // no feed yet — U just doesn't get this haircut
    };
  };

  // 6) Regime from the macro layer (VIX + credit), built in step 4.
  let regime = 'neutral';
  try { const macro = await fetchMacro(); if (macro) regime = macro.regime; } catch {}

  // 7) The tick — detection already populated the ledger above.
  const result = cern.dailyTick(dataFor, { regime, costBps: 30 }, nowMs);
  // Surface which ledger names are currently crowd-hot (their U is haircut now).
  const ledgerHot = [...new Set(cern.s.ledger.filter(e => e.status === 'PENDING' || e.status === 'SIGNALED').map(e => e.symbol))]
    .filter(s => attnLookup.has(s)).map(s => ({ symbol: s, attentionZ: attnLookup.get(s) }));
  return {
    regime, scanned: barsCache.size, ledger: cern.s.ledger.length, archive: cern.s.archive.length,
    decisions: result.decisions, resolved: result.resolved, alerts: result.alerts,
    posteriors: result.posteriors, lockups, firesale, downgrades,
    social: { trending: attnLookup.size, ledgerHot }, elapsedMs: Date.now() - t0,
  };
}

module.exports = { runCernTick, SECTOR_ETF };

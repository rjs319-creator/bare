const SECTOR_ETFS = [
  { symbol: 'SPY',  name: 'S&P 500'      },
  { symbol: 'QQQ',  name: 'Nasdaq'        },
  { symbol: 'XLK',  name: 'Technology'    },
  { symbol: 'XLF',  name: 'Financials'    },
  { symbol: 'XLV',  name: 'Healthcare'    },
  { symbol: 'XLE',  name: 'Energy'        },
  { symbol: 'XLI',  name: 'Industrials'   },
  { symbol: 'XLY',  name: 'Cons Discret'  },
  { symbol: 'XLP',  name: 'Cons Staples'  },
  { symbol: 'XLB',  name: 'Materials'     },
  { symbol: 'XLRE', name: 'Real Estate'   },
  { symbol: 'XLU',  name: 'Utilities'     },
  { symbol: 'XLC',  name: 'Comm Services'  },
];

// Primary source: Yahoo Finance (Stooq now serves an anti-bot challenge).
async function fetchYahoo(symbol) {
  const path = `/v8/finance/chart/${symbol}?range=1d&interval=1d`;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const res = await fetch(`https://${host}${path}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'application/json' },
      });
      if (!res.ok) continue;
      const j = await res.json();
      const m = j?.chart?.result?.[0]?.meta;
      if (!m || m.regularMarketPrice == null) continue;
      const price = m.regularMarketPrice;
      const prev  = m.chartPreviousClose ?? m.previousClose ?? price;
      const changePct = prev ? ((price - prev) / prev * 100) : 0;
      return { price, changePct: parseFloat(changePct.toFixed(2)) };
    } catch { /* try next host */ }
  }
  return null;
}

// Fallback: Stooq CSV (works when its bot-check is not active).
async function fetchStooq(symbol) {
  try {
    const url = `https://stooq.com/q/l/?s=${symbol}.US&f=sd2t2ohlcvn&h&e=csv`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const text = await res.text();
    if (text.trimStart().startsWith('<')) return null; // HTML challenge, not CSV
    const lines = text.trim().split('\n');
    if (lines.length < 2) return null;
    const parts = lines[1].split(',');
    const open  = parseFloat(parts[3]);
    const close = parseFloat(parts[6]);
    if (!open || !close || isNaN(open) || isNaN(close)) return null;
    return { price: close, changePct: parseFloat(((close - open) / open * 100).toFixed(2)) };
  } catch { return null; }
}

// ── Daily & weekly sector ROTATION trends ──────────────────────────────────
// Relative strength vs SPY over time: for each sector ETF, the cumulative excess
// return (sector daily/weekly return − SPY's) — a rising line = money rotating IN.
// Daily panel = last ~15 sessions; weekly panel = last ~10 weeks. Built from daily
// candles (Yahoo via lib/screener) so it's point-in-time and consistent app-wide.
async function rotationHandler(req, res) {
  const { fetchDailyHistory } = require('../lib/screener');
  const SECTORS = SECTOR_ETFS.filter(e => e.symbol.startsWith('XL'));   // 11 GICS sectors
  const D = 15, WK = 10;                                                // daily sessions / weeks

  const spy = await fetchDailyHistory('SPY', '6mo');
  if (!spy || spy.candles.length < 60) return res.status(502).json({ error: 'No benchmark data', rotation: null });
  const spyAt = {}; spy.candles.forEach(c => { spyAt[c.date] = c.close; });

  const built = await Promise.all(SECTORS.map(async e => {
    const d = await fetchDailyHistory(e.symbol, '6mo').catch(() => null);
    if (!d || d.candles.length < 60) return null;
    const c = d.candles.filter(x => spyAt[x.date] != null);            // align to SPY trading days
    if (c.length < 60) return null;

    // Daily excess returns over the last D sessions → cumulative line.
    const dailyEx = [];
    for (let i = Math.max(1, c.length - D); i < c.length; i++) {
      const er = (c[i].close / c[i - 1].close - 1) - (spyAt[c[i].date] / spyAt[c[i - 1].date] - 1);
      dailyEx.push(er * 100);
    }
    let cum = 0; const dailyCum = dailyEx.map(v => +(cum += v).toFixed(2));

    // Weekly (5-session block) excess returns over the last WK weeks → cumulative line.
    const weeklyEx = [];
    for (let end = c.length - 1; end - 5 >= 0 && weeklyEx.length < WK; end -= 5) {
      const er = (c[end].close / c[end - 5].close - 1) - (spyAt[c[end].date] / spyAt[c[end - 5].date] - 1);
      weeklyEx.unshift(er * 100);
    }
    let wcum = 0; const weeklyCum = weeklyEx.map(v => +(wcum += v).toFixed(2));

    return {
      symbol: e.symbol, name: e.name,
      dailyCum, daily1d: +(dailyEx[dailyEx.length - 1] || 0).toFixed(2), dailyTotal: +cum.toFixed(2),
      weeklyCum, weekly1w: +(weeklyEx[weeklyEx.length - 1] || 0).toFixed(2), weeklyTotal: +wcum.toFixed(2),
    };
  }));

  const rotation = built.filter(Boolean);
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');
  return res.json({ rotation, sessions: D, weeks: WK, asOf: spy.candles[spy.candles.length - 1].date, generatedAt: new Date().toISOString() });
}

module.exports = async function handler(req, res) {
  if (req.query.mode === 'rotation') return rotationHandler(req, res);
  try {
    const results = await Promise.all(SECTOR_ETFS.map(async etf => {
      const q = (await fetchYahoo(etf.symbol)) || (await fetchStooq(etf.symbol));
      if (!q) return null;
      return {
        symbol:    etf.symbol,
        name:      etf.name,
        price:     q.price.toFixed(2),
        changePct: q.changePct,
      };
    }));

    const sectors = results.filter(Boolean).sort((a, b) => b.changePct - a.changePct);
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
    return res.json({ sectors });
  } catch (e) {
    return res.status(502).json({ error: 'Failed to fetch sector data', sectors: [] });
  }
};

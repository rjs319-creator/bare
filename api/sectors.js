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

module.exports = async function handler(req, res) {
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

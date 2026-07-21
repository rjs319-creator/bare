'use strict';
// 📡 MARKET PULSE — point-in-time market-data enrichment + real-citation extraction.
//
// TWO honest jobs:
//   1. Turn cached daily candles into the context that tells "already-completed move" from
//      "not yet reacted": day/3-session return, ATR extension above the 20d mean, relative
//      volume, gap. Computed at SCHEDULED GENERATION (the refine invocation), never by the
//      browser fanning out to providers per card.
//   2. Extract the URLs the web_search tool ACTUALLY returned, so per-item source claims can
//      be validated against reality and hallucinated links dropped (see pulse-schema).
//
// computeEnrichment is PURE (candles in → context out) and fully unit-tested. The network
// fetch is a thin, bounded, failure-tolerant wrapper injected for tests.

const round = (n, d = 2) => (n == null || !Number.isFinite(n) ? null : +n.toFixed(d));
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

/**
 * Point-in-time context from aligned daily OHLCV arrays (oldest→newest). Pure.
 * Any field that lacks enough data is null — never guessed.
 * @param {{closes:number[], highs?:number[], lows?:number[], volumes?:number[], opens?:number[]}} c
 */
function computeEnrichment(c) {
  const closes = (c && c.closes || []).filter(Number.isFinite);
  if (closes.length < 5) return null;
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const dayReturn = prev ? ((last - prev) / prev) * 100 : null;
  const ret3 = closes.length >= 4 ? ((last - closes[closes.length - 4]) / closes[closes.length - 4]) * 100 : null;
  const win = closes.slice(-20);
  const mean20 = avg(win);

  // Average True Range over the last ~14 sessions (needs highs/lows; else null).
  const highs = (c.highs || []).filter(Number.isFinite);
  const lows = (c.lows || []).filter(Number.isFinite);
  let atr = null;
  if (highs.length === closes.length && lows.length === closes.length && closes.length >= 15) {
    const trs = [];
    for (let i = closes.length - 14; i < closes.length; i++) {
      const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
      trs.push(tr);
    }
    atr = avg(trs);
  }
  const atrExt = atr && mean20 != null ? (last - mean20) / atr : null;

  // Relative volume: today vs the trailing 20-session mean.
  const vols = (c.volumes || []).filter(Number.isFinite);
  let relVol = null;
  if (vols.length >= 6) {
    const baseline = avg(vols.slice(-21, -1));
    if (baseline) relVol = vols[vols.length - 1] / baseline;
  }
  // Gap: today's open vs prior close.
  const opens = (c.opens || []).filter(Number.isFinite);
  const gapPct = (opens.length === closes.length && prev) ? ((opens[opens.length - 1] - prev) / prev) * 100 : null;

  return {
    asOfClose: round(last),
    dayReturn: round(dayReturn),
    ret3: round(ret3),
    atrExt: round(atrExt),
    relVol: round(relVol),
    gapPct: round(gapPct),
    mean20: round(mean20),
    atr: round(atr),
  };
}

/** Pull daily OHLCV arrays for one ticker from Yahoo (~2 months). Failure-tolerant → null. */
async function fetchDailyBars(ticker, fetchImpl) {
  const doFetch = fetchImpl || require('./http').fetchWithTimeout;
  const sym = String(ticker).toUpperCase();
  const path = `/v8/finance/chart/${encodeURIComponent(sym)}?range=2mo&interval=1d`;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const r = await doFetch(`https://${host}${path}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'application/json' },
      });
      if (!r.ok) continue;
      const q = (await r.json())?.chart?.result?.[0]?.indicators?.quote?.[0];
      if (!q) continue;
      const closes = (q.close || []).map(v => (v == null ? NaN : +v));
      if (closes.filter(Number.isFinite).length < 5) continue;
      return {
        closes, highs: (q.high || []).map(v => (v == null ? NaN : +v)),
        lows: (q.low || []).map(v => (v == null ? NaN : +v)),
        volumes: (q.volume || []).map(v => (v == null ? NaN : +v)),
        opens: (q.open || []).map(v => (v == null ? NaN : +v)),
      };
    } catch { /* try next host */ }
  }
  return null;
}

/**
 * Enrich a set of tickers with PIT context, bounded + failure-tolerant.
 * Returns a plain map { TICKER: enrichment }. Missing tickers are simply absent.
 */
async function enrichTickers(tickers, { fetchBars = fetchDailyBars, max = 24 } = {}) {
  const uniq = [...new Set((tickers || []).map(t => String(t).toUpperCase()).filter(Boolean))].slice(0, max);
  const out = {};
  await Promise.all(uniq.map(async t => {
    try {
      const bars = await fetchBars(t);
      const e = bars && computeEnrichment(bars);
      if (e) out[t] = e;
    } catch { /* leave this ticker un-enriched */ }
  }));
  return out;
}

/**
 * Collect the URLs/titles the web_search tool ACTUALLY returned from an Anthropic message.
 * These are the ONLY links Pulse may present as real. Pure (reads the message object).
 * @returns {{urls:Set<string>, sources:Array}}
 */
function extractCitations(msg) {
  const urls = new Set();
  const sources = [];
  const push = (url, title, page_age) => {
    if (!url || urls.has(url)) return;
    urls.add(url);
    const dm = String(url).match(/^https?:\/\/([^/?#]+)/i);
    sources.push({
      url, title: title || null,
      domain: dm ? dm[1].toLowerCase().replace(/^www\./, '') : null,
      publishedAt: /^\d{4}-\d{2}-\d{2}/.test(String(page_age || '')) ? String(page_age).slice(0, 10) : null,
    });
  };
  for (const block of (msg && msg.content) || []) {
    if (block && block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) {
        if (r && r.type === 'web_search_result') push(r.url, r.title, r.page_age);
      }
    }
    // Inline text citations (Anthropic attaches url/title on citation objects).
    if (block && block.type === 'text' && Array.isArray(block.citations)) {
      for (const c of block.citations) if (c && c.url) push(c.url, c.title, c.cited_text ? null : null);
    }
  }
  return { urls, sources };
}

module.exports = { computeEnrichment, fetchDailyBars, enrichTickers, extractCitations };

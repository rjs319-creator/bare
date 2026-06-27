// op=optionsflow : scan the liquid-options universe for unusual flow, serve it
//   ranked, persist today's snapshot + roll a forward-tracking ledger.
// op=optionsperf : resolve the ledger's forward returns into a track record.
//
// Forward-tracking (the snippet's "forward-tracked performance"): each day we log
// the first-appearance flow signals (ticker + bullish/bearish lean + entry price);
// op=optionsperf later checks whether the underlying moved the flagged way over
// 1w/1m — an honest, falsifiable read on whether the flow had any edge.

const { fetchChainResult } = require('./options-baseline');
const { fetchDailyHistory } = require('./screener');
const { readJSON, writeJSON, hasStore } = require('./store');
const of = require('./optionsflow');

const DAILY_PREFIX = 'optionsflow/';
const LEDGER_KEY = 'optionsflow/ledger.json';
const LEDGER_MAX = 400;
const HORIZONS = [['1w', 5], ['1m', 21]];

async function runOptionsFlow(req, res) {
  const date = new Date().toISOString().slice(0, 10);
  const force = req.query.refresh === '1';

  const cached = await readJSON(`${DAILY_PREFIX}${date}.json`, null).catch(() => null);
  if (cached && !force) {
    res.setHeader('Cache-Control', 's-maxage=600');
    return res.json({ ...cached, cached: true });
  }

  const universe = of.LIQUID_OPTIONS;
  let signals;
  try {
    signals = await of.scanOptionsFlow(universe, fetchChainResult, { concurrency: 6, cap: 120 });
  } catch (e) {
    return res.status(200).json({ ok: false, error: 'Scan failed: ' + (e && e.message ? e.message : String(e)) });
  }

  const out = {
    ok: true, date, generatedAt: new Date().toISOString(),
    universe: universe.length, count: signals.length, signals,
    summary: of.flowSummary(signals),
    byTicker: of.rollupByTicker(signals),
    note: 'Derived from delayed Yahoo option chains (volume vs open interest + premium estimate) — not live tick tape. sweep/block/large are heuristic classes; bullish/bearish are directional leans from the call/put side.',
  };

  if (hasStore() && signals.length) {
    await writeJSON(`${DAILY_PREFIX}${date}.json`, out, 0).catch(() => {});
    // Roll the ledger: one first-appearance entry per ticker:sentiment per day.
    const led = await readJSON(LEDGER_KEY, { entries: [] }).catch(() => ({ entries: [] }));
    const seen = new Set((led.entries || []).map(e => `${e.date}:${e.ticker}:${e.sentiment}`));
    for (const s of signals) {
      const k = `${date}:${s.ticker}:${s.sentiment}`;
      if (seen.has(k) || s.underlying == null) continue;
      seen.add(k);
      led.entries.push({ date, ticker: s.ticker, sentiment: s.sentiment, kind: s.kind, entry: s.underlying, premium: s.premium });
    }
    led.entries = (led.entries || []).slice(-LEDGER_MAX);
    await writeJSON(LEDGER_KEY, led, 0).catch(() => {});
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.json(out);
}

// Close at the first candle on/after `date`, and `bars` sessions later.
function resolveAt(candles, date, bars, sentiment) {
  if (!candles || !candles.length) return null;
  let i = candles.findIndex(c => c.date >= date);
  if (i < 0) return null;
  const j = i + bars;
  if (j >= candles.length) return null;   // horizon not elapsed yet
  return of.flowOutcome(candles[i].close, candles[j].close, sentiment);
}

function summarize(rets) {
  if (!rets.length) return { n: 0 };
  const wins = rets.filter(r => r > 0).length;
  const avg = rets.reduce((s, r) => s + r, 0) / rets.length;
  return { n: rets.length, winRate: Math.round((wins / rets.length) * 100), avgReturnPct: +(avg * 100).toFixed(2) };
}

async function runOptionsPerf(req, res) {
  const led = await readJSON(LEDGER_KEY, { entries: [] }).catch(() => ({ entries: [] }));
  const entries = led.entries || [];
  if (!entries.length) {
    res.setHeader('Cache-Control', 's-maxage=300');
    return res.json({ ok: true, logged: 0, resolved: 0, horizons: {}, bySentiment: {}, byKind: {}, note: 'No options-flow signals logged yet — accrues as op=optionsflow runs daily.' });
  }

  const tickers = [...new Set(entries.map(e => e.ticker))];
  const hist = new Map();
  let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++];
      try { const d = await fetchDailyHistory(t); if (d) hist.set(t, d.candles); } catch { /* skip */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, tickers.length) }, worker));

  const buckets = { horizons: {}, bySentiment: {}, byKind: {} };
  let resolved = 0;
  for (const [hk, bars] of HORIZONS) {
    const hor = [], bySent = { bullish: [], bearish: [] }, byKind = {};
    for (const e of entries) {
      const r = resolveAt(hist.get(e.ticker), e.date, bars, e.sentiment);
      if (r == null) continue;
      hor.push(r);
      (bySent[e.sentiment] = bySent[e.sentiment] || []).push(r);
      (byKind[e.kind] = byKind[e.kind] || []).push(r);
    }
    if (hk === '1m') resolved = hor.length;
    buckets.horizons[hk] = summarize(hor);
    buckets.bySentiment[hk] = { bullish: summarize(bySent.bullish), bearish: summarize(bySent.bearish) };
    buckets.byKind[hk] = Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, summarize(v)]));
  }

  res.setHeader('Cache-Control', 's-maxage=600');
  return res.json({
    ok: true, logged: entries.length, resolved, ...buckets,
    note: 'Win = the underlying moved the flagged way (bullish→up, bearish→down). Forward returns are on the UNDERLYING, not the option. Needs weeks of logging before the read is meaningful — by design it does not flatter a thin sample.',
  });
}

module.exports = { runOptionsFlow, runOptionsPerf, resolveAt, summarize };

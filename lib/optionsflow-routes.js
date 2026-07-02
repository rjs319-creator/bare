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
const { fetchEarningsInfo } = require('./fundamentals');
const { readJSON, writeJSON, hasStore, readAllArchive } = require('./store');
const { computeBaselines } = require('./baseline');
const of = require('./optionsflow');

// Earnings-before-expiry enrichment — the single most actionable options warning:
// an option held through earnings is an event bet (binary + IV crush), a different
// animal from a trend bet. We fetch the next earnings date for each FLAGGED ticker
// (a small set) and flag any whose report lands on/before the contract's expiry.
async function enrichEarnings(out) {
  const tickers = (out.byTicker || []).filter(r => !r.isIndex).map(r => r.ticker);
  const maxDteByTicker = {};
  for (const s of out.signals) maxDteByTicker[s.ticker] = Math.max(maxDteByTicker[s.ticker] || 0, s.dte || 0);
  const info = new Map();
  let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++];
      try { const e = await fetchEarningsInfo(t); if (e) info.set(t, e); } catch { /* skip */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, tickers.length) }, worker));
  if (!info.size) return;
  for (const r of out.byTicker) {
    const e = info.get(r.ticker); if (!e) continue;
    r.earningsDate = e.earningsDate; r.earningsInDays = e.earningsInDays;
    r.earningsBeforeExpiry = e.earningsInDays != null && e.earningsInDays >= 0 && e.earningsInDays <= (maxDteByTicker[r.ticker] || 0);
  }
  for (const s of out.signals) {
    const e = info.get(s.ticker); if (!e) continue;
    s.earningsInDays = e.earningsInDays;
    s.earningsBeforeExpiry = e.earningsInDays != null && e.earningsInDays >= 0 && e.earningsInDays <= (s.dte || 0);
  }
}

// Baseline overlay — the point of the whole archive: the static scanner flags flow
// on absolute thresholds ($50k premium, vol>OI), which can't tell "big for this name"
// from "big, period". We join each flagged ticker to its own daily-archive history
// (nearest-expiry total option volume) and mark the ones whose option volume is a
// statistical outlier vs THEIR OWN norm — "unusual relative to normal", finally.
async function attachBaselines(out, { minObs = 8, z = 2 } = {}) {
  let days;
  try { days = await readAllArchive(); } catch { return; }
  if (!days || !days.length) return;
  const bl = computeBaselines(days, { minObs, z });
  out.baselineAsOf = bl.asOf;
  const confirmed = [];
  let covered = 0;
  for (const r of (out.byTicker || [])) {
    const t = bl.tickers[r.ticker];
    if (!t) continue;
    const b = {};
    if (t.optVol) b.optVol = t.optVol;   // { latest, mean, sd, n, z, pctile, scored }
    if (t.atmIV) b.atmIV = t.atmIV;
    if (t.pcVol) b.pcVol = t.pcVol;
    if (Object.keys(b).length) { r.baseline = b; covered++; }
    const ov = t.optVol;
    if (ov && ov.scored && ov.z >= z) {
      r.abnormalVsNormal = true;
      r.baselineNote = `option volume +${ov.z}σ vs its ${ov.n}-day norm (pctile ${ov.pctile})`;
      confirmed.push(r.ticker);
    } else {
      r.abnormalVsNormal = false;
    }
  }
  out.baselineCoverage = covered;
  out.confirmedUnusual = confirmed;   // statically flagged AND abnormal vs their own history
  out.baselineNote = `${confirmed.length} name(s) show option volume ≥${z}σ above their own ${minObs}+ day norm` +
    ` (baseline as of ${bl.asOf || 'n/a'}, ${covered}/${(out.byTicker || []).length} tickers with enough history).`;
}

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

  try { await enrichEarnings(out); } catch { /* earnings best-effort */ }
  try { await attachBaselines(out); } catch { /* baseline overlay best-effort */ }

  if (hasStore() && signals.length) {
    await writeJSON(`${DAILY_PREFIX}${date}.json`, out, 0).catch(() => {});
    // Roll the ledger: one first-appearance entry per ticker:sentiment per day.
    // Tag each with the ticker's baseline abnormality so op=optionsperf can later
    // test whether "abnormal vs own norm" flow actually forward-performs better.
    const abn = new Map((out.byTicker || []).map(r => [r.ticker, !!r.abnormalVsNormal]));
    const led = await readJSON(LEDGER_KEY, { entries: [] }).catch(() => ({ entries: [] }));
    const seen = new Set((led.entries || []).map(e => `${e.date}:${e.ticker}:${e.sentiment}`));
    for (const s of signals) {
      const k = `${date}:${s.ticker}:${s.sentiment}`;
      if (seen.has(k) || s.underlying == null) continue;
      seen.add(k);
      led.entries.push({ date, ticker: s.ticker, sentiment: s.sentiment, kind: s.kind, entry: s.underlying, premium: s.premium, abnormalVsNormal: abn.get(s.ticker) || false });
    }
    led.entries = (led.entries || []).slice(-LEDGER_MAX);
    await writeJSON(LEDGER_KEY, led, 0).catch(() => {});
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.json(out);
}

const BIG_WIN_FRACS = [0.10, 0.20]; // favorable-excursion thresholds for "big mover" rates

// Close at the first candle on/after `date`, and `bars` sessions later. Returns
// { ret, mfe } (both fractions) — ret = directional close-to-close outcome,
// mfe = best favorable excursion along the path (bullish flow favors the high,
// bearish the low), so we can measure how often the flow preceded a big move.
function resolveAt(candles, date, bars, sentiment) {
  if (!candles || !candles.length) return null;
  let i = candles.findIndex(c => c.date >= date);
  if (i < 0) return null;
  const j = i + bars;
  if (j >= candles.length) return null;   // horizon not elapsed yet
  const ret = of.flowOutcome(candles[i].close, candles[j].close, sentiment);
  if (ret == null) return null;
  const entry = candles[i].close;
  const bullish = sentiment !== 'bearish';
  let mfe = 0;
  for (let k = i + 1; k <= j; k++) {
    const c = candles[k];
    const hi = c.high != null ? c.high : c.close;
    const lo = c.low != null ? c.low : c.close;
    const fav = bullish ? (hi - entry) / entry : (entry - lo) / entry;
    if (fav > mfe) mfe = fav;
  }
  return { ret, mfe };
}

// rets = resolveAt results [{ ret, mfe }]. Adds the realized "big mover" base
// rate — the share of flow signals whose underlying actually ran +10% / +20%
// in their favored direction — grounded in the ledger, not a fabricated stat.
function summarize(rets) {
  if (!rets.length) return { n: 0 };
  const n = rets.length;
  const wins = rets.filter(r => r.ret > 0).length;
  const avg = rets.reduce((s, r) => s + r.ret, 0) / n;
  const avgMfe = rets.reduce((s, r) => s + r.mfe, 0) / n;
  const big = f => Math.round((rets.filter(r => r.mfe >= f).length / n) * 100);
  return {
    n,
    winRate: Math.round((wins / n) * 100),
    avgReturnPct: +(avg * 100).toFixed(2),
    avgMfePct: +(avgMfe * 100).toFixed(2),
    big10Rate: big(BIG_WIN_FRACS[0]),
    big20Rate: big(BIG_WIN_FRACS[1]),
  };
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

  const buckets = { horizons: {}, bySentiment: {}, byKind: {}, byAbnormal: {} };
  let resolved = 0;
  for (const [hk, bars] of HORIZONS) {
    const hor = [], bySent = { bullish: [], bearish: [] }, byKind = {}, byAbn = { abnormal: [], normal: [] };
    for (const e of entries) {
      const r = resolveAt(hist.get(e.ticker), e.date, bars, e.sentiment);
      if (r == null) continue;
      hor.push(r);
      (bySent[e.sentiment] = bySent[e.sentiment] || []).push(r);
      (byKind[e.kind] = byKind[e.kind] || []).push(r);
      // Only entries logged after the baseline overlay shipped carry the flag.
      if (e.abnormalVsNormal === true) byAbn.abnormal.push(r);
      else if (e.abnormalVsNormal === false) byAbn.normal.push(r);
    }
    if (hk === '1m') resolved = hor.length;
    buckets.horizons[hk] = summarize(hor);
    buckets.bySentiment[hk] = { bullish: summarize(bySent.bullish), bearish: summarize(bySent.bearish) };
    buckets.byKind[hk] = Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, summarize(v)]));
    buckets.byAbnormal[hk] = { abnormal: summarize(byAbn.abnormal), normal: summarize(byAbn.normal) };
  }

  res.setHeader('Cache-Control', 's-maxage=600');
  return res.json({
    ok: true, logged: entries.length, resolved, ...buckets,
    note: 'Win = the underlying moved the flagged way (bullish→up, bearish→down). Forward returns are on the UNDERLYING, not the option. byAbnormal splits flow that was abnormal vs the name\'s own option-volume baseline against the rest — the falsifiable test of whether the baseline overlay adds edge (only entries logged after it shipped are tagged). Needs weeks of logging before the read is meaningful.',
  });
}

module.exports = { runOptionsFlow, runOptionsPerf, resolveAt, summarize };

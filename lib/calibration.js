// Feedback loop (Layer 1 + 2) for the 5 novel "predict" screeners
// (Read-Through / Stealth / Second Wave / Cross-Asset / Tone Shift).
//
// Each screener already logs a COUNTERFACTUAL ledger — every investigated name, all
// classes (not just the "good" one), tagged with its sector ETF benchmark. This reads
// those ledgers, resolves each pick's 1-week forward EXCESS return vs its own sector
// ETF, and grades every CLASS with a sample-aware, Wilson-bounded verdict:
//
//   PROVEN      — beats its sector with statistical confidence  → featured
//   DUD         — reliably fails to beat its sector             → dimmed + ranked last
//   CALIBRATING — not enough resolved picks yet to judge        → tracked, never gated
//
// The predict cards read the cached result to stamp each class's live track record and
// to auto-demote proven duds. Nothing is judged below MIN_RESOLVED — consistent with the
// rest of the app, the loop never promotes or demotes on noise. Because these screeners
// regenerate picks daily from fresh candidates (no persistent weights), "learning" here
// means adapting the SELECTION policy — which classes to trust — to realized performance.
const { readJSON, writeJSON, hasStore,
  readAllReadThroughDays, readAllAnomalyDays, readAllSecondWaveDays,
  readAllCrossAssetDays, readAllToneShiftDays } = require('./store');
const { fetchDailyHistory } = require('./screener');
const { forwardPath, spyForwardReturn } = require('./apex-routes');
const { wilson } = require('./stats');

const CACHE_KEY = 'predict/calibration.json';
const MIN_RESOLVED = 15;   // floor before a class is graded — matches the Apex drift detector
const HORIZON_BARS = 5;    // 1 trading week — resolves fastest, so the loop activates soonest

const SECTIONS = [
  { key: 'ReadThrough', read: readAllReadThroughDays },
  { key: 'Anomaly',     read: readAllAnomalyDays },
  { key: 'SecondWave',  read: readAllSecondWaveDays },
  { key: 'CrossAsset',  read: readAllCrossAssetDays },
  { key: 'ToneShift',   read: readAllToneShiftDays },
];

// A class is only judged once it has ≥ MIN_RESOLVED resolved picks. Then the 90% Wilson
// interval on P(beat sector) — a coin-flip null of 0.5 — decides: lower bound above 0.5
// ⇒ PROVEN, upper bound below 0.5 ⇒ DUD. Asymmetric and sample-aware exactly like the
// Apex drift detector, so a lucky small streak never flips a class either way.
function verdictFor(beat, n) {
  if (n < MIN_RESOLVED) return 'CALIBRATING';
  const { lo, hi } = wilson(beat, n);
  if (lo > 0.5) return 'PROVEN';
  if (hi < 0.5) return 'DUD';
  return 'CALIBRATING';
}

// excs = array of forward excess-vs-sector returns (%) for one class of one screener.
function summarizeClass(excs) {
  const n = excs.length;
  const beat = excs.filter(x => x > 0).length;
  const avg = excs.reduce((s, x) => s + x, 0) / n;
  const { lo, hi } = wilson(beat, n);
  return {
    n, beat, min: MIN_RESOLVED,
    beatRate: Math.round((beat / n) * 100),
    avgExcess: +avg.toFixed(2),
    lo: Math.round(lo * 100),
    hi: Math.round(hi * 100),
    verdict: verdictFor(beat, n),
  };
}

// First-appearance only (earliest per tier:ticker) so a name that stays listed for days
// isn't overweighted — the same dedup the Scoreboard uses.
function firstAppearance(picks) {
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const seen = new Map();
  for (const p of [...picks].sort(byDate)) {
    const key = `${p.tier}:${p.ticker}`;
    if (p.tier && p.date && !seen.has(key)) seen.set(key, p);
  }
  return [...seen.values()];
}

// Resolve every ledger → per-section, per-class stats. fetchHistory and the section
// readers are injectable so the pipeline can be driven offline in tests.
async function computeCalibration(fetchHistory = fetchDailyHistory, sections = SECTIONS) {
  const perSection = [];
  for (const s of sections) {
    const days = await s.read().catch(() => []);
    const picks = firstAppearance((days || []).flatMap(d => (d.picks || [])));
    perSection.push({ key: s.key, picks });
  }

  const allPicks = perSection.flatMap(s => s.picks);
  const tickers = [...new Set([
    ...allPicks.map(p => p.ticker),
    ...allPicks.map(p => p.bench).filter(Boolean),
    'SPY', // fallback benchmark when a pick has no sector ETF
  ])];
  const hist = new Map();
  let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++];
      try { const d = await fetchHistory(t); if (d) hist.set(t, d.candles); } catch { /* skip — no history */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, tickers.length) }, worker));

  const out = {};
  let resolvedTotal = 0;
  for (const s of perSection) {
    const byClass = {};
    for (const p of s.picks) {
      const candles = hist.get(p.ticker);
      if (!candles) continue;
      const r = forwardPath(candles, p, HORIZON_BARS);
      if (!r || !Number.isFinite(r.ret)) continue;         // horizon not elapsed → still open
      const benchCandles = (p.bench && hist.get(p.bench)) || hist.get('SPY');
      const benchRet = spyForwardReturn(benchCandles, p, HORIZON_BARS);
      if (benchRet == null || !Number.isFinite(benchRet)) continue;
      (byClass[p.tier] = byClass[p.tier] || []).push(r.ret - benchRet);
    }
    const cls = {};
    for (const [tier, excs] of Object.entries(byClass)) {
      cls[tier] = summarizeClass(excs);
      resolvedTotal += excs.length;
    }
    out[s.key] = cls;
  }

  return {
    ok: true,
    horizonBars: HORIZON_BARS,
    minResolved: MIN_RESOLVED,
    resolvedTotal,
    sections: out,
    generatedAt: new Date().toISOString(),
  };
}

// op=calibration — serve the cached grades. The viewer path is CHEAP by design: it only
// reads the cache and never computes synchronously, so a card never waits on the resolve.
// ?force=1 / ?refresh=1 (the daily warm cron) does the heavy compute + re-cache, so the
// grades refresh as picks resolve. Uncached-and-not-forced returns empty (dormant) fast.
async function runCalibration(req, res) {
  const force = req.query.force === '1' || req.query.refresh === '1';
  try {
    if (!force) {
      const cached = hasStore() ? await readJSON(CACHE_KEY, null).catch(() => null) : null;
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
      if (cached) return res.json({ ...cached, cached: true });
      return res.json({ ok: true, pending: true, sections: {}, minResolved: MIN_RESOLVED }); // warm hasn't built it yet
    }
    const data = await computeCalibration();
    if (hasStore()) await writeJSON(CACHE_KEY, data, 0).catch(() => {});
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ...data, cached: false });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: false, error: String((e && e.message) || e), sections: {} });
  }
}

module.exports = {
  runCalibration, computeCalibration, summarizeClass, verdictFor, firstAppearance,
  CACHE_KEY, MIN_RESOLVED, HORIZON_BARS,
};

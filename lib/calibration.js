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
  readAllReadThroughDays, readAllAnomalyDays, readAllBiotechDays, readAllSecondWaveDays,
  readAllCrossAssetDays, readAllToneShiftDays } = require('./store');
const { fetchDailyHistory } = require('./screener');
const { forwardPath, spyForwardReturn } = require('./apex-routes');
const { wilson, spearman } = require('./stats');

const CACHE_KEY = 'predict/calibration.json';
const MIN_RESOLVED = 15;   // floor before a class is graded — matches the Apex drift detector
const HORIZON_BARS = 5;    // 1 trading week — resolves fastest, so the loop activates soonest

// ── Layer 3: is the AI's own conviction calibrated? ─────────────────────────────────────
// Each screener emits a 1–5 conviction score (and Read-Through a link-type category). Layer 3
// asks whether those attributes actually order realized excess — rank-IC of conviction vs the
// same 1-week sector-excess Layer 2 resolves, plus per-value breakdowns. It needs more samples
// than a proportion to be trustworthy, and |IC| ≥ 0.10 is the app's bar for a meaningful signal
// (its edge research found ~0.10 is the floor where a factor carries real information).
const ATTR_MIN_IC = 20;
const ATTR_IC_EDGE = 0.10;
const ATTR_SPEC = {
  ReadThrough: { conviction: { key: 'directness', label: 'directness' }, categories: [{ key: 'linkType', label: 'link type' }] },
  Anomaly:     { conviction: { key: 'confidence', label: 'confidence' }, categories: [] },
  Biotech:     { conviction: { key: 'confidence', label: 'confidence' }, categories: [{ key: 'classification', label: 'catalyst type' }] },
  SecondWave:  { conviction: { key: 'virality',   label: 'virality' },   categories: [] },
  CrossAsset:  { conviction: { key: 'confidence', label: 'confidence' }, categories: [] },
  ToneShift:   { conviction: { key: 'confidence', label: 'confidence' }, categories: [] },
};

// CALIBRATED = higher conviction really did earn more excess; INVERTED = it earned LESS (a red
// flag — the dots are backwards); NOISE = no relationship (the dots are decorative, don't rank on
// them); CALIBRATING = not enough resolved picks yet. Never judged below ATTR_MIN_IC.
function convictionVerdict(ic, n) {
  if (n < ATTR_MIN_IC || ic == null) return 'CALIBRATING';
  if (ic >= ATTR_IC_EDGE) return 'CALIBRATED';
  if (ic <= -ATTR_IC_EDGE) return 'INVERTED';
  return 'NOISE';
}

function groupStat(value, excs) {
  const n = excs.length;
  const beat = excs.filter(x => x > 0).length;
  return { value, n, beatRate: Math.round((beat / n) * 100), avgExcess: +(excs.reduce((s, x) => s + x, 0) / n).toFixed(2) };
}

// records = [{ pick, exc }] resolved for one screener → attribute analytics for that screener.
function attributeStats(section, records) {
  const spec = ATTR_SPEC[section];
  if (!spec) return null;
  const out = {};

  const cv = spec.conviction;
  const withConv = records.filter(r => Number.isFinite(r.pick[cv.key]));
  if (withConv.length) {
    const ic = spearman(withConv.map(r => r.pick[cv.key]), withConv.map(r => r.exc), ATTR_MIN_IC);
    const byLevel = {};
    for (const r of withConv) { const l = r.pick[cv.key]; (byLevel[l] = byLevel[l] || []).push(r.exc); }
    out.conviction = {
      key: cv.key, label: cv.label, n: withConv.length, minN: ATTR_MIN_IC,
      rankIC: ic == null ? null : +ic.toFixed(3),
      verdict: convictionVerdict(ic, withConv.length),
      buckets: Object.keys(byLevel).map(Number).sort((a, b) => a - b).map(l => groupStat(l, byLevel[l])),
    };
  }

  for (const cat of spec.categories) {
    const groups = {};
    for (const r of records) { const v = r.pick[cat.key]; if (v == null) continue; (groups[v] = groups[v] || []).push(r.exc); }
    const values = Object.entries(groups).map(([v, excs]) => groupStat(v, excs)).sort((a, b) => b.avgExcess - a.avgExcess);
    if (values.length) (out.categories = out.categories || {})[cat.key] = { label: cat.label, values };
  }

  return Object.keys(out).length ? out : null;
}

const SECTIONS = [
  { key: 'ReadThrough', read: readAllReadThroughDays },
  { key: 'Anomaly',     read: readAllAnomalyDays },
  { key: 'Biotech',     read: readAllBiotechDays },
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
    // Resolve each pick once → {pick, exc}. Both Layer 2 (group by class) and Layer 3
    // (attribute rank-IC) read the same resolved records, so history is fetched only once.
    const records = [];
    for (const p of s.picks) {
      const candles = hist.get(p.ticker);
      if (!candles) continue;
      const r = forwardPath(candles, p, HORIZON_BARS);
      if (!r || !Number.isFinite(r.ret)) continue;         // horizon not elapsed → still open
      const benchCandles = (p.bench && hist.get(p.bench)) || hist.get('SPY');
      const benchRet = spyForwardReturn(benchCandles, p, HORIZON_BARS);
      if (benchRet == null || !Number.isFinite(benchRet)) continue;
      records.push({ pick: p, exc: r.ret - benchRet });
    }
    // Layer 2 — per-class Wilson-graded track record.
    const byClass = {};
    for (const rec of records) (byClass[rec.pick.tier] = byClass[rec.pick.tier] || []).push(rec.exc);
    const classes = {};
    for (const [tier, excs] of Object.entries(byClass)) classes[tier] = summarizeClass(excs);
    resolvedTotal += records.length;
    // Layer 3 — does the AI's own conviction (and link type) order the excess?
    out[s.key] = { classes, attributes: attributeStats(s.key, records) };
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
  attributeStats, convictionVerdict,
  CACHE_KEY, MIN_RESOLVED, HORIZON_BARS, ATTR_MIN_IC,
};

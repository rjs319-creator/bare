// BIG-MOVER STRATEGY REVEAL — "which of our strategies actually catch the biggest
// movers?" Reconstructs each signal POINT-IN-TIME (replays screenTicker + the
// multi-day run scan on historical slices, exactly like lib/research.js), labels
// each name-date by whether it went on to be a BIG MOVER (forward max-favorable
// excursion ≥ threshold), then reports per-signal:
//   • recall    = of the big movers, what % had this signal firing beforehand
//   • precision = of this signal's firings, what % became big movers
//   • lift      = precision ÷ base-rate (>1 = the signal genuinely concentrates
//                 big movers; ≈1 = no better than picking at random)
//
// HONEST DESIGN: recall alone is the classic "all winners had RSI>50" trap — a
// signal can flag every mover and also fire on everything (no edge). We always
// pair it with precision + lift so a high-recall-but-no-lift signal is exposed.
// Still in-sample on a static (survivorship-biased) universe → directional, not
// a deployable weight. Big move = the RUN-UP (MFE), so a name that ran +40% then
// gave it back still counts as "caught-able."
const { fetchDailyHistory, screenTicker, smaAt } = require('./screener');
const { dayMetrics, passesRunScan } = require('./daytrade');
const { LARGE, SMALL_CAPS, MICRO_CAPS } = require('./universe');

const MIN_HISTORY = 200;   // need a real base before a name can be scored
const HOLD = 42;           // forward window (~2 months) over which a "big move" can play out

// Each signal: [key, label, predicate(record)] where record = { r (screenTicker
// result), run (passesRunScan bool), momHigh (top-quartile mom63 in cohort) }.
const SIGNALS = [
  ['emergingLeader', '🌱 Emerging Leader',        x => !!x.r.emergingLeader],
  ['momentumRun',    '🌊 Momentum Run (multi-day)', x => !!x.run],
  ['breakout',       '🚀 Breakout status',         x => x.r.status === 'Breakout'],
  ['anyPick',        'Any screener pick (relaxed gate)', x => x.r.status != null],
  ['rsLeader',       'RS vs SPY > 0',              x => !!(x.r.filters && x.r.filters.rsVsSpy)],
  ['aboveSmas',      'Above 50- & 200-DMA',        x => !!(x.r.filters && x.r.filters.aboveSmas)],
  ['momHigh',        'Top-quartile 3-mo momentum', x => !!x.momHigh],
  ['accumHigh',      'Accumulation ratio ≥ 1.3',   x => (x.r.metrics && x.r.metrics.accumRatio) >= 1.3],
  ['udHigh',         'Up/down volume ≥ 1.3×',      x => (x.r.metrics && x.r.metrics.udVol) >= 1.3],
  ['pocketPivot',    'Pocket pivot',               x => !!(x.r.metrics && x.r.metrics.pocketPivot)],
  ['vcp',            'VCP (≥2 contractions)',      x => (x.r.metrics && x.r.metrics.vcpContractions) >= 2],
  ['longBase',       'Long base (≥7wk)',           x => !!(x.r.metrics && x.r.metrics.longBase)],
  ['volSurge',       'Volume surge ≥ 1.5× (control — research says dead)', x => (x.r.metrics && x.r.metrics.volSurge) >= 1.5],
];

// Forward maximum-favorable-excursion (the biggest up-move reached) over HOLD bars.
function forwardMfe(candles, idx, bars) {
  const entry = candles[idx].close;
  if (!(entry > 0)) return null;
  let hi = entry;
  for (let k = idx + 1; k <= idx + bars && k < candles.length; k++) {
    const h = candles[k].high != null ? candles[k].high : candles[k].close;
    if (h > hi) hi = h;
  }
  return (hi - entry) / entry * 100;
}

async function runMoverStudy({ scope = 'large', step = 21, months = 18, minMovePct = 30, limit = 0, deadlineMs = 50000 } = {}) {
  const t0 = Date.now();
  const list = scope === 'micro' ? MICRO_CAPS : scope === 'small' ? SMALL_CAPS : LARGE;
  let tickers = [...new Set(list)];
  if (limit > 0) tickers = tickers.slice(0, limit);

  const spy = await fetchDailyHistory('SPY', '2y');
  const spyCandles = spy ? spy.candles : [];
  const spyByDate = {}; spyCandles.forEach(x => { spyByDate[x.date] = x.close; });

  const hist = new Map();
  let fi = 0;
  const fworker = async () => { while (fi < tickers.length) { const t = tickers[fi++]; try { const d = await fetchDailyHistory(t, '2y'); if (d) hist.set(t, { candles: d.candles, meta: { ...d.meta, symbol: t } }); } catch {} } };
  await Promise.all(Array.from({ length: 16 }, fworker));

  const span = Math.min(spyCandles.length - 1, months * 21);
  const dates = [];
  for (let k = span; k >= HOLD; k -= step) dates.push(spyCandles[spyCandles.length - 1 - k].date);

  // Per-signal tallies + global totals.
  const tally = Object.fromEntries(SIGNALS.map(s => [s[0], { fired: 0, firedBig: 0 }]));
  let totalN = 0, totalBig = 0, screenCalls = 0, stoppedEarly = false;
  const examples = []; // a few big movers + which signals caught them, for the UI
  const momCutoffs = []; // per-cohort 75th-percentile 3-mo momentum (the "top-quartile" bar)

  for (const date of dates) {
    if (Date.now() - t0 > deadlineMs) { stoppedEarly = true; break; }
    const cohort = [];
    for (const [t, { candles, meta }] of hist) {
      let idx = -1;
      for (let k = candles.length - 1; k >= 0; k--) { if (candles[k].date <= date) { idx = k; break; } }
      if (idx < MIN_HISTORY || candles.length - 1 - idx < HOLD) continue;
      const slice = candles.slice(0, idx + 1);
      const r = screenTicker(slice, meta, { spyByDate });
      screenCalls++;
      if (!r || !r.metrics) continue;
      const dm = dayMetrics(slice, spyByDate);
      const run = !!(dm && passesRunScan(dm));
      const mfe = forwardMfe(candles, idx, HOLD);
      if (mfe == null) continue;
      cohort.push({ t, idx, r, run, mom63: (r.factors && r.factors.mom63) ?? null, mfe });
    }
    if (cohort.length < 20) continue;

    // Top-quartile 3-mo momentum within this cohort (cross-sectional flag).
    const moms = cohort.map(c => c.mom63).filter(v => v != null).sort((a, b) => a - b);
    const q75 = moms.length ? moms[Math.floor(moms.length * 0.75)] : Infinity;
    if (moms.length) momCutoffs.push(q75); // record this cohort's top-quartile bar (mom63 is in %)

    cohort.forEach(c => {
      const rec = { r: c.r, run: c.run, momHigh: c.mom63 != null && c.mom63 >= q75 };
      const big = c.mfe >= minMovePct;
      totalN++; if (big) totalBig++;
      const caught = [];
      for (const [key, , pred] of SIGNALS) {
        if (pred(rec)) { tally[key].fired++; if (big) { tally[key].firedBig++; caught.push(key); } }
      }
      if (big && examples.length < 40) examples.push({ ticker: c.t, date, mfePct: +c.mfe.toFixed(0), caughtBy: caught });
    });
  }

  const baseRate = totalN ? totalBig / totalN : 0;
  // Average "top-quartile 3-mo momentum" cutoff across cohorts — the actual 3-month
  // return (%) a name had to clear, on average, to count as top-quartile. (Relative
  // per cohort, so this is the typical level; the range shows regime variation.)
  const momCutoff = momCutoffs.length ? {
    avgPct: +(momCutoffs.reduce((a, b) => a + b, 0) / momCutoffs.length).toFixed(1),
    minPct: +Math.min(...momCutoffs).toFixed(1),
    maxPct: +Math.max(...momCutoffs).toFixed(1),
    cohorts: momCutoffs.length,
  } : null;
  const signals = SIGNALS.map(([key, label]) => {
    const { fired, firedBig } = tally[key];
    const precision = fired ? firedBig / fired : 0;
    return {
      key, label, fired,
      recallPct: totalBig ? +(100 * firedBig / totalBig).toFixed(1) : 0,
      precisionPct: +(100 * precision).toFixed(1),
      lift: baseRate ? +(precision / baseRate).toFixed(2) : 0,
    };
  }).sort((a, b) => b.lift - a.lift);

  return {
    scope, holdSessions: HOLD, minMovePct, cohorts: dates.length,
    totalRecords: totalN, bigMovers: totalBig, baseRatePct: +(100 * baseRate).toFixed(1),
    momCutoff, // avg/min/max 3-mo-return % bar for "top-quartile momentum"
    screenCalls, stoppedEarly, elapsedMs: Date.now() - t0,
    note: `big mover = forward ${HOLD}-session max run-up ≥ ${minMovePct}%. lift = precision ÷ base rate; >1.3 means the signal genuinely concentrates big movers. recall without lift = fires on everything (no edge).`,
    signals,
    examples: examples.sort((a, b) => b.mfePct - a.mfePct).slice(0, 12),
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { runMoverStudy, forwardMfe, SIGNALS };

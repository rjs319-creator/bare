// Emerging-Leader ADMISSION study. The screener's include gate is `!!status`
// (Breakout/Setup/Early), all built from pattern factors — so an `emergingLeader`
// (fresh RS leadership + accumulation, not extended; built ONLY on validated
// factors) that lacks a base pattern is silently dropped. Item 5 of the Fable
// review proposes admitting those names — but ONLY if they carry forward edge.
//
// This harness answers the decision question point-in-time, multi-year: do the
// INCREMENTAL names (emergingLeader && !status — the ones admission would ADD)
// beat their cohort and SPY out-of-sample, and is it regime-robust (not just a
// risk-on artifact)? It replays screenTicker on candle slices (same reconstruction
// the research/exits/ghost harnesses use), tags each name with emergingLeader +
// admitted (status!=null) + the macro-unified regime, and measures 63-session
// cross-sectional excess + beat-SPY rates with Wilson lower bounds.
const { fetchDailyHistory, screenTicker, smaAt } = require('./screener');
const { LARGE, SMALL_CAPS, MICRO_CAPS, SECTOR_OF } = require('./universe');
const { MAX_HOLD } = require('./outcome');
const { buildMacroLookup } = require('./macro');
const apex = require('./apex');
const { wilson } = require('./stats');

const MIN_HISTORY = 150, MIN_COHORT = 20;

// Aggregate a set of records → beat-cohort / beat-SPY rates with Wilson LB (90%),
// mean cross-sectional excess return, mean excess-vs-SPY.
function agg(recs) {
  const n = recs.length;
  if (!n) return { n: 0 };
  const beatCohort = recs.filter(r => r.r > 0).length;
  const spyRecs = recs.filter(r => r.rSpy != null);
  const beatSpy = spyRecs.filter(r => r.rSpy > 0).length;
  const ciC = wilson(beatCohort, n);
  const ciS = spyRecs.length ? wilson(beatSpy, spyRecs.length) : { lo: 0, hi: 0 };
  return {
    n,
    meanExcessPct: +((recs.reduce((a, r) => a + r.r, 0) / n) * 100).toFixed(2),
    beatCohortRate: +(beatCohort / n).toFixed(3),
    beatCohortWilsonLo: +ciC.lo.toFixed(3),
    nSpy: spyRecs.length,
    meanVsSpyPct: spyRecs.length ? +((spyRecs.reduce((a, r) => a + r.rSpy, 0) / spyRecs.length) * 100).toFixed(2) : null,
    beatSpyRate: spyRecs.length ? +(beatSpy / spyRecs.length).toFixed(3) : null,
    beatSpyWilsonLo: spyRecs.length ? +ciS.lo.toFixed(3) : null,
  };
}

async function runEmergingStudy({ scope = 'large', step = 10, months = 54, limit = 0, range = '5y', deadlineMs = 120000 } = {}) {
  const t0 = Date.now();
  const macroLookup = await buildMacroLookup(range).catch(() => null);
  const list = scope === 'micro' ? MICRO_CAPS : scope === 'small' ? SMALL_CAPS : LARGE;
  let tickers = [...new Set(list)];
  if (limit > 0) tickers = tickers.slice(0, limit);

  const spy = await fetchDailyHistory('SPY', range);
  const sc = spy ? spy.candles : [];
  const scl = sc.map(x => x.close);
  const sbd = {}; sc.forEach(x => { sbd[x.date] = x.close; });
  const sIdx = {}; sc.forEach((x, i) => { sIdx[x.date] = i; });

  const hist = new Map(); let fi = 0;
  const fw = async () => { while (fi < tickers.length) { const t = tickers[fi++]; try { const d = await fetchDailyHistory(t, range); if (d) hist.set(t, { candles: d.candles, meta: { ...d.meta, symbol: t } }); } catch {} } };
  await Promise.all(Array.from({ length: 16 }, fw));

  const span = Math.min(sc.length - 1, months * 21);
  const dates = [];
  for (let k = span; k >= MAX_HOLD; k -= step) dates.push(sc[sc.length - 1 - k].date);

  const records = [];   // { date, year, regime, el, admitted, r, rSpy }
  let screenCalls = 0, stoppedEarly = false;
  for (const date of dates) {
    if (Date.now() - t0 > deadlineMs) { stoppedEarly = true; break; }
    const cohort = [];
    for (const [t, { candles, meta }] of hist) {
      let idx = -1; for (let k = candles.length - 1; k >= 0; k--) { if (candles[k].date <= date) { idx = k; break; } }
      if (idx < MIN_HISTORY || candles.length - 1 - idx < MAX_HOLD) continue;
      const r = screenTicker(candles.slice(0, idx + 1), meta, { spyByDate: sbd });
      screenCalls++;
      if (!r || !r.factors) continue;
      cohort.push({ t, idx, candles, el: !!r.emergingLeader, admitted: !!r.status });
    }
    if (cohort.length < MIN_COHORT) continue;

    const si = sIdx[date]; let a200 = null; if (si != null) { const s200 = smaAt(scl, 200, si); a200 = s200 != null ? scl[si] > s200 : null; }
    const breadth = Math.round((cohort.filter(x => x.admitted).length / cohort.length) * 100); // rough breadth proxy
    const mac = macroLookup ? macroLookup.at(date) : null;
    const regime = apex.rawRegime({
      bearish: a200 === false || !!(mac && mac.riskOff),
      riskOn: a200 === true && (!mac || mac.riskOn),
    });

    const fwd = cohort.map(c => (c.candles[c.idx + MAX_HOLD].close - c.candles[c.idx].close) / c.candles[c.idx].close);
    const mean = fwd.reduce((a, b) => a + b, 0) / fwd.length;
    let spyFwd = null;
    if (si != null && si + MAX_HOLD < scl.length) spyFwd = scl[si + MAX_HOLD] / scl[si] - 1;

    cohort.forEach((c, i) => {
      records.push({ date, year: date.slice(0, 4), regime, el: c.el, admitted: c.admitted,
        r: fwd[i] - mean, rSpy: spyFwd != null ? fwd[i] - spyFwd : null });
    });
  }

  const el = records.filter(r => r.el);
  const incremental = records.filter(r => r.el && !r.admitted);   // what admission would ADD
  const admitted = records.filter(r => r.admitted);               // current baseline
  const excluded = records.filter(r => !r.el && !r.admitted);     // stay excluded

  const byRegime = ['RISK_ON', 'NEUTRAL', 'RISK_OFF'].map(R => ({ regime: R, ...agg(incremental.filter(r => r.regime === R)) })).filter(x => x.n >= 15);
  const years = [...new Set(records.map(r => r.year))].sort();
  const byYear = years.map(y => ({ year: y, ...agg(incremental.filter(r => r.year === y)) })).filter(x => x.n >= 15);

  const inc = agg(incremental);
  // Ship criterion (matches the project's discipline): the incremental names must
  // beat SPY with a Wilson lower bound > 0.5 AND be positive in the majority of
  // years AND not negative in the non-risk-off regimes (regime-robust, not a
  // risk-on artifact). Anything less → do NOT open the admission path (or gate it).
  const posYears = byYear.filter(y => y.beatSpyRate != null && y.beatSpyRate > 0.5).length;
  const nonRiskOffOk = byRegime.filter(x => x.regime !== 'RISK_OFF').every(x => x.meanExcessPct > 0);
  const shipUngated = inc.n >= 50 && inc.beatSpyWilsonLo != null && inc.beatSpyWilsonLo > 0.5
    && byYear.length > 0 && posYears > byYear.length / 2 && nonRiskOffOk;
  const shipGated = !shipUngated && nonRiskOffOk && inc.meanExcessPct > 0 && inc.n >= 50;

  return {
    scope, months, step, range, macroEnabled: !!macroLookup,
    horizonSessions: MAX_HOLD, returnDef: 'cross-sectional excess (cohort-demeaned) 63-session forward return',
    n: records.length, screenCalls, stoppedEarly, elapsedMs: Date.now() - t0,
    groups: { emergingLeaderAll: agg(el), incremental: inc, admittedBaseline: agg(admitted), stayExcluded: agg(excluded) },
    incrementalByRegime: byRegime,
    incrementalByYear: byYear,
    verdict: {
      shipUngated, shipGated,
      recommendation: shipUngated
        ? 'ADMIT emergingLeader unconditionally — incremental names beat SPY with a Wilson LB > 50%, positive across most years and non-risk-off regimes.'
        : shipGated
          ? 'ADMIT emergingLeader ONLY in non-risk-off regimes — positive incremental edge but not a confident standalone >50% beat; gate it like the conviction sleeve.'
          : 'DO NOT open the admission path — the incremental names do not show regime-robust forward edge (would just dilute the funnel).',
    },
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { runEmergingStudy, agg };

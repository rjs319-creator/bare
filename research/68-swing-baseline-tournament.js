'use strict';
// EXPERIMENT C — UNIFIED SWING BASELINE TOURNAMENT (redesign Phase 11).
//
// THE QUESTION. On the IDENTICAL point-in-time candidate universe and the identical
// decision dates, does the production swing score beat the simplest baselines — or is it
// an expensive way to buy the same names a rank-by-momentum would have picked?
//
// THE ENTRANTS (frozen before the run; the multiple-testing denominator is their count):
//   production      the shipped swing/quant composite (lib/screener.screenTicker → quant.score)
//   marketRelative  raw market-relative strength (126-session return minus SPY's)
//   sectorRelative  the same, minus the same-date sector cohort mean
//   simpleMomentum  126-session total return
//   breakout        the production status ladder (Breakout > Setup > Early)
//   ghostOverlay    breakout score + the accumulation read (the overlay, on identical dates)
//   coilTriggered   the subset whose volatility is compressed (the Coil condition), ranked by momentum
//   equalWeight     every eligible name (the buy-anything baseline: excess ≈ 0 by construction)
//   seededRandom    a deterministic random selection (the same top-k discipline, no information)
//   placebo         the production score paired with a within-date SHUFFLED label (the
//                   leakage detector — its rank IC must be ~0; anything else means the
//                   harness is broken, not that alpha exists). A merely SHIFTED label is
//                   not a placebo: overlapping windows stay correlated, so it would show
//                   signal even in a correct harness.
//
// MEASURED (per entrant, on the same dates): rank IC, top-k excess, turnover, drawdown, hit
// rate, base/doubled/stressed cost-net results, by-regime and by-block performance, and the
// INCREMENTAL value over the simplest baseline that beats it.
//
// HONESTY. Survivorship-reduced universe; no promotion can follow from this run. The
// comparison is what matters: every entrant sees the same dates, the same eligibility, the
// same costs and the same execution (next-open entry).
//
// Usage: node research/68-swing-baseline-tournament.js [--step 5] [--maxNames 1500] [--topK 10]

const path = require('node:path');
const K = require('./lib/experiment-kit');
const { screenTicker } = require('../lib/screener');
const ENGINE = require('../lib/swing-screener-engine');
const GHOST = require('../lib/ghost');
const { SECTOR_OF } = require('../lib/universe');

const STUDY_ID = 'C-swing-baseline-tournament-2026-08';
const STUDY_VERSION = 'swing-baseline-tournament-v1';
const OUT_DIR = path.join(K.DATA_DIR, 'swing-baseline-tournament');

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]] : null)).filter(Boolean));
const STEP = Math.max(1, parseInt(args.step, 10) || 5);
const MAX_NAMES = Math.max(100, parseInt(args.maxNames, 10) || 1500);
const TOP_K = Math.max(3, parseInt(args.topK, 10) || 10);
const H = 21;                     // the swing horizon the replay and the app both use
const MIN_HISTORY = 280;
const MIN_ADV = 5e6;
const SEED = 20260805;
const PLACEBO_SHIFT = 5;          // decision dates shifted forward for the label — leakage check
const STATUS_RANK = { Breakout: 3, Setup: 2, Early: 1 };

const zscore = (arr) => {
  const ok = arr.filter(Number.isFinite);
  const m = K.mean(ok) ?? 0;
  const sd = Math.sqrt(K.mean(ok.map(v => (v - m) ** 2)) || 0) || 1;
  return arr.map(v => (Number.isFinite(v) ? (v - m) / sd : 0));
};

async function main() {
  const t0 = Date.now();
  console.log(`[${STUDY_ID}] loading universe…`);
  const { dataset, spy, spyIdx, attrition: uAttr } = K.loadUniverse({ minBars: MIN_HISTORY, minAdv: MIN_ADV, maxNames: MAX_NAMES });
  console.log(`  ${dataset.size} names (${JSON.stringify(uAttr)})`);

  const decisions = [];
  for (let i = 262; i <= spy.length - 1 - H - PLACEBO_SHIFT; i += STEP) decisions.push(spy[i].date);
  console.log(`  decision sessions ${decisions.length} (${decisions[0]} → ${decisions[decisions.length - 1]}, step ${STEP})`);

  const attr = K.newAttrition();
  attr.noScore = 0;
  const perDate = [];      // { date, rows:[{ticker, scores{}, excess, netExc*, ...}] }
  let done = 0;

  for (const D of decisions) {
    const spyF = K.benchmarkForward(spy, spyIdx, D, H);
    const spyPlacebo = K.benchmarkForward(spy, spyIdx, D, H + PLACEBO_SHIFT);
    if (spyF == null) { attr.noBenchmark++; continue; }
    const spySlice = K.sliceAsOf(spy, D);
    const spyByDate = {}; spySlice.forEach(x => { spyByDate[x.date] = x.close; });
    const spyMom = (() => {
      const i = spyIdx.get(D);
      return (i != null && i >= 126 && spy[i - 126].close > 0) ? spy[i].close / spy[i - 126].close - 1 : null;
    })();

    // Build the contemporaneous cohort through the SHARED PRODUCTION ENGINE, so the
    // production entrant is the real shipped score (same-date cohort percentiles + quant
    // composite) rather than a re-implementation — and so the Ghost overlay can be scored
    // from the same percentile block the live engine feeds it.
    const screened = [];
    for (const [t, v] of dataset) {
      const pit = K.sliceAsOf(v.candles, D);
      if (pit.length < 220) { attr.truncatedHistory++; continue; }
      if (pit[pit.length - 1].date !== D) continue;
      const r = screenTicker(pit, { symbol: t }, { gate: 'relaxed', spyByDate });
      if (!r || !r.factors) { attr.noScore++; continue; }
      if (!r.ticker) r.ticker = t;
      r.sector = SECTOR_OF[t] || 'Other';
      // The engine's cohort freshness gate adjudicates ONE decision session from these —
      // without it every row is excluded as stale and the cohort comes back empty.
      r.lastBarDate = pit[pit.length - 1].date;
      screened.push(r);
    }
    if (screened.length < 20) { done++; continue; }
    const sel = ENGINE.selectCandidates({ rows: screened, scope: 'large', spyCandles: spySlice, now: new Date(D + 'T23:59:00Z'), macroRiskOff: false });
    const regimeForGhost = sel.regime || null;

    const rows = [];
    for (const c of sel.cohort || []) {
      const v = dataset.get(c.ticker);
      if (!v) continue;
      const fwd = K.forwardFromNextOpen(v, D, H, attr);
      if (fwd == null) continue;
      const fwdPlacebo = K.forwardFromNextOpen(v, D, H + PLACEBO_SHIFT, null);
      const f = c.factors || {};
      // ELIGIBILITY — identical for every entrant (this is the point of the tournament).
      if (!(Number.isFinite(f.dollarVol) && f.dollarVol >= MIN_ADV)) { attr.ineligible++; continue; }
      const cost = K.costFractions(f.dollarVol);
      let ghostScore = null;
      try { ghostScore = GHOST.scoreGhost(c, regimeForGhost).score; } catch { ghostScore = null; }
      rows.push({
        ticker: c.ticker, sector: c.sector || SECTOR_OF[c.ticker] || 'Other',
        quant: (c.quant && Number.isFinite(c.quant.score)) ? c.quant.score : null,
        status: c.status || null,
        mom126: f.mom126 ?? null,
        vol63: f.vol ?? null,
        volAdjMom: f.volAdjMom ?? null,
        ghost: Number.isFinite(ghostScore) ? ghostScore : null,
        dollarVol: f.dollarVol,
        excess: fwd - spyF,
        netExcBase: fwd - cost.base - spyF,
        netExcDoubled: fwd - cost.doubled - spyF,
        netExcStressed: fwd - cost.stressed - spyF,
        placeboExcess: null, placeboNetBase: null, placeboNetDoubled: null, placeboNetStressed: null,
        labelShiftExcess: (fwdPlacebo != null && spyPlacebo != null) ? fwdPlacebo - spyPlacebo : null,
      });
    }
    if (rows.length < 20) { done++; continue; }
    const scoredRows = rows.filter(r => Number.isFinite(r.quant));
    if (scoredRows.length < 20) { attr.noScore += rows.length; done++; continue; }

    // Same-date sector cohort means (the sector-relative entrant's only input).
    const bySector = new Map();
    for (const r of rows) { if (!bySector.has(r.sector)) bySector.set(r.sector, []); bySector.get(r.sector).push(r.mom126 ?? 0); }
    const secMean = new Map([...bySector].map(([s, a]) => [s, K.mean(a) ?? 0]));
    const volZ = zscore(rows.map(r => r.vol63 ?? 0));

    const rnd = K.lcg(SEED + decisions.indexOf(D));
    // Within-date label permutation for the placebo entrant (seeded ⇒ reproducible).
    const shuffleRnd = K.lcg(SEED * 7 + decisions.indexOf(D));
    const shuffled = rows.map(r => r.excess);
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(shuffleRnd() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const shuffledNetBase = rows.map(r => r.netExcBase);
    for (let i = shuffledNetBase.length - 1; i > 0; i--) {
      const j = Math.floor(shuffleRnd() * (i + 1));
      [shuffledNetBase[i], shuffledNetBase[j]] = [shuffledNetBase[j], shuffledNetBase[i]];
    }
    rows.forEach((r, i) => { r.placeboExcess = shuffled[i]; r.placeboNetBase = shuffledNetBase[i]; r.placeboNetDoubled = shuffledNetBase[i]; r.placeboNetStressed = shuffledNetBase[i]; });
    rows.forEach((r, i) => {
      r.scores = {
        production: r.quant ?? 0,
        marketRelative: (r.mom126 ?? 0) - (spyMom ?? 0),
        sectorRelative: (r.mom126 ?? 0) - (secMean.get(r.sector) ?? 0),
        simpleMomentum: r.mom126 ?? 0,
        breakout: STATUS_RANK[r.status] || 0,
        ghostOverlay: (STATUS_RANK[r.status] || 0) * 100 + (r.ghost ?? 0),
        // The Coil CONDITION (compressed volatility) as a filter, ranked by momentum inside it.
        coilTriggered: volZ[i] < -0.5 ? (r.mom126 ?? 0) : -Infinity,
        equalWeight: 0,
        seededRandom: rnd(),
        placebo: r.quant ?? 0,
      };
    });
    perDate.push({ date: D, rows });
    if (++done % 25 === 0) console.log(`  …${done}/${decisions.length} dates`);
  }

  console.log(`  usable decision dates ${perDate.length}; attrition ${JSON.stringify(attr)}`);
  if (perDate.length < 8) { console.log('  INSUFFICIENT DATA'); return; }

  // ── Evaluate every entrant on the identical dates ──────────────────────────
  const ENTRANTS = ['production', 'marketRelative', 'sectorRelative', 'simpleMomentum', 'breakout',
    'ghostOverlay', 'coilTriggered', 'equalWeight', 'seededRandom', 'placebo'];
  const evalOne = (name) => {
    const dateRows = [];
    const ics = [];
    let prevSet = null;
    let turnoverSum = 0, turnoverN = 0;
    for (const d of perDate) {
      const usable = d.rows.filter(r => Number.isFinite(r.scores[name]) && r.scores[name] > -Infinity);
      if (usable.length < TOP_K) continue;
      const label = name === 'placebo' ? 'placeboExcess' : 'excess';
      const paired = usable.filter(r => Number.isFinite(r[label]) && (name !== 'placebo' || Number.isFinite(r.placeboNetBase)));
      if (paired.length < TOP_K) continue;
      const ic = K.rankIC(paired.map(r => r.scores[name]), paired.map(r => r[label]));
      if (ic != null) ics.push(ic);
      const ranked = paired.slice().sort((a, b) => b.scores[name] - a.scores[name]);
      const top = name === 'equalWeight' ? paired : ranked.slice(0, TOP_K);
      const set = new Set(top.map(r => r.ticker));
      if (prevSet) {
        const kept = [...set].filter(t => prevSet.has(t)).length;
        turnoverSum += 1 - kept / Math.max(1, set.size); turnoverN++;
      }
      prevSet = set;
      dateRows.push({
        date: d.date,
        gross: K.mean(top.map(r => r[label])) * 100,
        base: K.mean(top.map(r => (name === 'placebo' ? r.placeboNetBase : r.netExcBase))) * 100,
        doubled: K.mean(top.map(r => (name === 'placebo' ? r.placeboNetDoubled : r.netExcDoubled))) * 100,
        stressed: K.mean(top.map(r => (name === 'placebo' ? r.placeboNetStressed : r.netExcStressed))) * 100,
        hit: top.filter(r => (r[label] ?? 0) > 0).length / top.length,
      });
    }
    const S = (key) => K.summarizeByDate(dateRows.map(r => ({ date: r.date, value: r[key] })), { horizonBars: H });
    const base = S('base');
    // Max drawdown of the compounded per-date top-k series (a set-level risk read).
    let eq = 1, peak = 1, dd = 0;
    for (const r of dateRows) { eq *= (1 + (r.base || 0) / 100); peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1); }
    return {
      entrant: name,
      dates: dateRows.length,
      rankIC: ics.length ? +K.mean(ics).toFixed(5) : null,
      rankICDates: ics.length,
      topKGross: S('gross'), topKNetBase: base, topKNetDoubled: S('doubled'), topKNetStressed: S('stressed'),
      hitRate: dateRows.length ? +(K.mean(dateRows.map(r => r.hit)) * 100).toFixed(1) : null,
      turnover: turnoverN ? +(turnoverSum / turnoverN).toFixed(3) : null,
      // OVERLAPPING-WINDOW pseudo-drawdown: 21-session returns compounded every `step`
      // sessions. It is a dispersion read, NOT a tradeable equity curve.
      maxDrawdownPct: +(dd * 100).toFixed(2),
      maxDrawdownBasis: 'overlapping-window pseudo-drawdown (not an equity curve)',
      pValue: base ? K.pValue(base) : null,
      series: dateRows.map(r => ({ date: r.date, base: +r.base.toFixed(4) })),
    };
  };

  const results = ENTRANTS.map(evalOne);
  const byName = Object.fromEntries(results.map(r => [r.entrant, r]));

  // FDR across the FULL registered entrant family (the honest denominator).
  const corrected = K.fdr(results.filter(r => Number.isFinite(r.pValue)).map(r => ({ id: r.entrant, p: r.pValue })));
  const qOf = (n) => (corrected.find(c => c.id === n) || {}).q ?? null;

  // INCREMENTAL value: production vs the best SIMPLE baseline, paired by date (the only
  // comparison that answers "is the complicated thing worth it?").
  const simple = ['marketRelative', 'sectorRelative', 'simpleMomentum', 'breakout'];
  const bestSimple = simple
    .map(n => ({ n, avg: byName[n].topKNetBase ? byName[n].topKNetBase.avg : -Infinity }))
    .sort((a, b) => b.avg - a.avg)[0];
  const pairedLift = (() => {
    const a = new Map(byName.production.series.map(r => [r.date, r.base]));
    const b = new Map(byName[bestSimple.n].series.map(r => [r.date, r.base]));
    const rows = [...a.keys()].filter(d => b.has(d)).map(d => ({ date: d, value: a.get(d) - b.get(d) }));
    return K.summarizeByDate(rows, { horizonBars: H });
  })();

  const placeboClean = !byName.placebo.topKNetBase || Math.abs(byName.placebo.rankIC ?? 0) < 0.03;
  const productionBeatsRandom = (byName.production.topKNetBase?.avg ?? 0) > (byName.seededRandom.topKNetBase?.avg ?? 0);
  const productionSurvivesFdr = Number.isFinite(qOf('production')) && qOf('production') <= 0.05;
  const verdict = !placeboClean ? 'HARNESS SUSPECT — the placebo shows signal; no result may be believed'
    : (productionSurvivesFdr && pairedLift && pairedLift.ci95.lo > 0 && (byName.production.topKNetDoubled?.ci95.lo ?? -1) > 0)
      ? 'PRODUCTION ADDS VALUE over the best simple baseline (survivorship-reduced data ⇒ still not promotable)'
      : 'NO ENTRANT DEMONSTRATES DURABLE COST-NET EDGE';

  const manifest = {
    studyId: STUDY_ID, version: STUDY_VERSION, kit: K.KIT_VERSION,
    frozenConfig: { horizonSessions: H, topK: TOP_K, entry: 'next-session open', step: STEP, maxNames: MAX_NAMES, minAdvUsd: MIN_ADV, seed: SEED, placeboShiftSessions: PLACEBO_SHIFT, entrants: ENTRANTS, variationsAttempted: ENTRANTS.length },
    dataSnapshot: { cacheDir: K.CACHE_DIR, decisionDates: perDate.length, firstDate: perDate[0].date, lastDate: perDate[perDate.length - 1].date },
    universeAttrition: uAttr, episodeAttrition: attr,
    survivorshipProvenSafe: false, pitProven: false,
    limitations: [
      'Survivorship-REDUCED universe (delisted names present but their series end) — no promotion can follow.',
      'Sector control is a same-date equal-weight sector cohort, not a PIT sector ETF.',
      'The macro risk-off overlay has no PIT series and is not applied.',
      'One frozen specification per entrant — no parameter search was run, so these numbers are not the best of many.',
    ],
    results: results.map(r => ({ ...r, series: undefined })),
    fdr: corrected,
    incrementalOverBestSimple: { baseline: bestSimple.n, baselineAvg: bestSimple.avg, lift: pairedLift },
    placeboCheck: { rankIC: byName.placebo.rankIC, clean: placeboClean },
    productionBeatsRandom,
    verdict,
    runtimeMs: Date.now() - t0, generatedAt: new Date().toISOString(),
  };
  const art = K.writeArtifact(OUT_DIR, 'result.json', manifest);
  K.recordExperiment({
    id: STUDY_ID,
    hypothesis: 'On identical PIT dates and eligibility, the production swing score beats simple market/sector-relative, momentum, breakout, overlay, coil-filtered, equal-weight and random baselines on cost-net top-k excess.',
    frozenConfig: manifest.frozenConfig, dataSnapshot: manifest.dataSnapshot, codeVersion: STUDY_VERSION,
    testDates: { first: perDate[0].date, last: perDate[perDate.length - 1].date, n: perDate.length },
    variationsAttempted: ENTRANTS.length,
    result: { production: byName.production.topKNetBase, bestSimple: bestSimple.n, lift: pairedLift, placeboRankIC: byName.placebo.rankIC },
    correctedSignificance: { method: 'Benjamini-Hochberg across all registered entrants', q: qOf('production') },
    costStress: { base: byName.production.topKNetBase?.avg ?? null, doubled: byName.production.topKNetDoubled?.avg ?? null, stressed: byName.production.topKNetStressed?.avg ?? null },
    decision: 'NOT PROMOTED',
    reason: `${verdict}. Survivorship-unsafe data is a hard promotion blocker regardless of the statistics.`,
    artifact: art,
  });

  console.log(`\n[${STUDY_ID}] ${verdict}`);
  for (const r of results) {
    console.log(`  ${r.entrant.padEnd(15)} IC ${String(r.rankIC).padStart(8)} | net@base ${String(r.topKNetBase ? r.topKNetBase.avg : 'n/a').padStart(7)}% CI[${r.topKNetBase ? r.topKNetBase.ci95.lo : '?'}, ${r.topKNetBase ? r.topKNetBase.ci95.hi : '?'}] | 2x ${r.topKNetDoubled ? r.topKNetDoubled.avg : 'n/a'}% | 3x ${r.topKNetStressed ? r.topKNetStressed.avg : 'n/a'}% | hit ${r.hitRate}% | turn ${r.turnover} | maxDD ${r.maxDrawdownPct}% | q ${qOf(r.entrant)}`);
  }
  console.log(`  incremental over best simple (${bestSimple.n}): ${pairedLift ? `${pairedLift.avg}% CI [${pairedLift.ci95.lo}, ${pairedLift.ci95.hi}] over ${pairedLift.n} dates` : 'insufficient'}`);
  console.log(`  artifact: ${art.file}`);
  return manifest;
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { STUDY_ID, STUDY_VERSION, main };

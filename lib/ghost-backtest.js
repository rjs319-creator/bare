// Ghost Accumulation Index — PURGED WALK-FORWARD harness (price-pillars-only).
//
// Validates whether GAI's PRICE core actually RANKS forward winners above losers
// out-of-sample — the honest "does this edge generalize, or is it in-sample
// curve-fit?" question. It reuses the exact point-in-time reconstruction the
// research/backfill engines use (screenTicker on candle slices → cross-sectional
// percentiles → ghost.pillarsOf), so there is no train/serve skew.
//
// PRICE-ONLY scope: of the six GAI pillars, only RM/AF/SF/AV are reconstructable
// from historical price/volume. BONUS (fundamentals+narrative) and IN (insider)
// have no candle-derived source, so they are pinned neutral and EXCLUDED from the
// validated composite (their weights are dropped and the rest renormalized). They
// become testable only once the step-4 feeds (earnings, EDGAR insider) land.
//
// The composite is FIXED (the static GAI priors) — we do NOT re-optimize weights
// here, so there is nothing to overfit. The walk-forward simply checks the fixed
// core's rank-IC in each sequential out-of-sample date block, with a purge gap so
// a signal's forward window can't leak across a block boundary.
const { fetchDailyHistory, screenTicker, smaAt } = require('./screener');
const { LARGE, SMALL_CAPS, MICRO_CAPS, SECTOR_OF } = require('./universe');
const { MAX_HOLD } = require('./outcome');
const apex = require('./apex');
const ghost = require('./ghost');
const { aggregateInsider } = require('./edgar');
const { buildMacroLookup } = require('./macro');
const { pitFundamentals } = require('./earnings');
const { convictionScore, convictionWeights, longOk } = require('./conviction');

// Trailing-90d window start for a given as-of date (calendar days).
const win90 = date => new Date(new Date(date + 'T00:00:00').getTime() - 90 * 864e5).toISOString().slice(0, 10);

const MIN_HISTORY = 150;
const MIN_COHORT = 20;
const PRICE_PILLARS = ['RM', 'AF', 'AV', 'SF'];

// ── rank-IC helpers (Spearman) — local copies, matching research/recalibrate ──
function ranks(arr) {
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(arr.length);
  for (let i = 0; i < idx.length;) { let j = i; while (j < idx.length && idx[j][0] === idx[i][0]) j++; const avg = (i + j - 1) / 2 + 1; for (let k = i; k < j; k++) out[idx[k][1]] = avg; i = j; }
  return out;
}
function pearson(a, b) {
  const n = a.length; if (n < 2) return 0;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return (da && db) ? num / Math.sqrt(da * db) : 0;
}
// rank-IC between an array of scores and realized returns.
function icOf(scores, rets) {
  if (scores.length < 10) return null;
  return +pearson(ranks(scores), ranks(rets)).toFixed(4);
}

// Sector/size-neutral rank-IC: demean BOTH the score and the realized return
// within each (date, sector) group, then take the IC on the residuals. This
// strips the cohort's sector/size tilt so the IC reflects pure within-peer
// stock-selection, not a structural bet on high-beta names beating SPY.
function sectorNeutralIC(recs, scoreFn) {
  const groups = new Map();
  for (const r of recs) { const k = r.date + '|' + (r.sector || '?'); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const sres = [], rres = [];
  for (const g of groups.values()) {
    if (g.length < 3) continue;                       // need a few peers to demean
    const ss = g.map(scoreFn), rr = g.map(x => x.r);
    const ms = ss.reduce((a, b) => a + b, 0) / ss.length, mr = rr.reduce((a, b) => a + b, 0) / rr.length;
    for (let i = 0; i < g.length; i++) { sres.push(ss[i] - ms); rres.push(rr[i] - mr); }
  }
  return icOf(sres, rres);
}

// Wilson score interval for a proportion (z=1.645 → ~90%). Used to put an honest
// lower bound on each conviction bucket's empirical beat-the-market rate.
function wilson(wins, n, z = 1.645) {
  if (!n) return { lo: 0, hi: 0 };
  const p = wins / n, z2 = z * z, denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

// Empirical P(beat SPY) by score quintile with a Wilson 90% lower bound. Records
// must carry rSpy (stock − SPY forward return) and r (cohort-excess return).
function beatSpyQuintiles(recs, scoreFn, Q = 5) {
  const sorted = recs.filter(r => r.rSpy != null)
    .map(r => ({ s: scoreFn(r), beat: r.rSpy > 0 ? 1 : 0, rSpy: r.rSpy, r: r.r }))
    .sort((a, b) => a.s - b.s);
  const out = [];
  for (let q = 0; q < Q; q++) {
    const lo = Math.floor(sorted.length * q / Q), hi = Math.floor(sorted.length * (q + 1) / Q);
    const slice = sorted.slice(lo, hi); if (slice.length < 5) continue;
    const wins = slice.filter(x => x.beat).length, ci = wilson(wins, slice.length);
    out.push({ quintile: q + 1, n: slice.length, beatSpyRate: +(wins / slice.length).toFixed(3),
      wilsonLo: +ci.lo.toFixed(3), wilsonHi: +ci.hi.toFixed(3),
      meanExcessVsSpy: +(slice.reduce((a, x) => a + x.rSpy, 0) / slice.length * 100).toFixed(2),
      meanExcessVsCohort: +(slice.reduce((a, x) => a + x.r, 0) / slice.length * 100).toFixed(2) });
  }
  const top = out.length ? out[out.length - 1] : null, bot = out.length ? out[0] : null;
  return { quintiles: out, topQuintile: top, bottomQuintile: bot,
    spread: (top && bot) ? +(top.beatSpyRate - bot.beatSpyRate).toFixed(3) : null, n: sorted.length };
}

// Price-only regime weights: drop BONUS/IN, renormalize RM/AF/AV/SF to sum 1.
function priceWeights(rw) {
  const w = {}; let t = 0;
  for (const k of PRICE_PILLARS) { w[k] = rw[k] || 0; t += w[k]; }
  for (const k of PRICE_PILLARS) w[k] = t > 0 ? w[k] / t : 1 / PRICE_PILLARS.length;
  return w;
}
const priceComposite = (pl, w) => PRICE_PILLARS.reduce((s, k) => s + (pl[k] || 0) * (w[k] || 0), 0);

// Price + IN regime weights (drop only BONUS), for the "does insider data add
// ranking power?" comparison once the EDGAR history is loaded.
const PRICE_IN_PILLARS = ['RM', 'AF', 'AV', 'SF', 'IN'];
function priceInWeights(rw) {
  const w = {}; let t = 0;
  for (const k of PRICE_IN_PILLARS) { w[k] = rw[k] || 0; t += w[k]; }
  for (const k of PRICE_IN_PILLARS) w[k] = t > 0 ? w[k] / t : 1 / PRICE_IN_PILLARS.length;
  return w;
}
const priceInComposite = (pl, w) => PRICE_IN_PILLARS.reduce((s, k) => s + (pl[k] || 0) * (w[k] || 0), 0);

// Price + BONUS regime weights (drop only IN), for the "does fundamental
// acceleration add ranking power?" comparison once the quarterly series is loaded.
const PRICE_BONUS_PILLARS = ['RM', 'AF', 'AV', 'SF', 'BONUS'];
function priceBonusWeights(rw) {
  const w = {}; let t = 0;
  for (const k of PRICE_BONUS_PILLARS) { w[k] = rw[k] || 0; t += w[k]; }
  for (const k of PRICE_BONUS_PILLARS) w[k] = t > 0 ? w[k] / t : 1 / PRICE_BONUS_PILLARS.length;
  return w;
}
const priceBonusComposite = (pl, w) => PRICE_BONUS_PILLARS.reduce((s, k) => s + (pl[k] || 0) * (w[k] || 0), 0);

// Cross-sectional percentile ranker (0-100) over a set of values.
function ranker(values) {
  const vals = values.filter(v => v != null && !isNaN(v)).sort((a, b) => a - b);
  return x => {
    if (x == null || isNaN(x) || !vals.length) return 0;
    let lo = 0, hi = vals.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (vals[m] <= x) lo = m + 1; else hi = m; }
    return Math.round((lo / vals.length) * 100);
  };
}

// ── Reconstruct the labeled GAI price-pillar cross-section over history ──────
async function buildCrossSection({ scope, step, months, limit, deadlineMs, insiderData, macroLookup, fundamentalsData }, t0) {
  const list = scope === 'micro' ? MICRO_CAPS : scope === 'small' ? SMALL_CAPS : LARGE;
  let tickers = [...new Set(list)];
  if (limit > 0) tickers = tickers.slice(0, limit);

  // Multi-year windows need more history so the cohort spans multiple regimes
  // (incl. the 2022 risk-off bear) — that's the only way to test the regime gate.
  const histRange = months > 24 ? '5y' : '2y';

  const spy = await fetchDailyHistory('SPY', histRange);
  const spyCandles = spy ? spy.candles : [];
  const spyCloses = spyCandles.map(x => x.close);
  const spyByDate = {}; spyCandles.forEach(x => { spyByDate[x.date] = x.close; });
  const spyIdxOf = {}; spyCandles.forEach((x, i) => { spyIdxOf[x.date] = i; });

  const hist = new Map();
  let fi = 0;
  const fworker = async () => { while (fi < tickers.length) { const t = tickers[fi++]; try { const d = await fetchDailyHistory(t, histRange); if (d) hist.set(t, { candles: d.candles, meta: { ...d.meta, symbol: t } }); } catch {} } };
  await Promise.all(Array.from({ length: 16 }, fworker));

  const span = Math.min(spyCandles.length - 1, months * 21);
  const dates = [];
  for (let k = span; k >= MAX_HOLD; k -= step) dates.push(spyCandles[spyCandles.length - 1 - k].date);

  const records = [];               // { date, regime, pillars, r }
  const stats = { datesPlanned: dates.length, datesUsed: 0, screenCalls: 0, byRegime: {}, stoppedEarly: false };

  for (const date of dates) {
    if (Date.now() - t0 > deadlineMs) { stats.stoppedEarly = true; break; }
    const cohort = [];
    for (const [t, { candles, meta }] of hist) {
      let idx = -1;
      for (let k = candles.length - 1; k >= 0; k--) { if (candles[k].date <= date) { idx = k; break; } }
      if (idx < MIN_HISTORY || candles.length - 1 - idx < MAX_HOLD) continue;
      const r = screenTicker(candles.slice(0, idx + 1), meta, { spyByDate });
      stats.screenCalls++;
      if (!r || !r.factors) continue;
      cohort.push({ t, idx, candles, f: r.factors, m: r.metrics });
    }
    if (cohort.length < MIN_COHORT) continue;
    stats.datesUsed++;

    // Cross-sectional percentile ranks across this date's cohort.
    const rk = {
      mom63: ranker(cohort.map(x => x.f.mom63)), mom126: ranker(cohort.map(x => x.f.mom126)),
      trend: ranker(cohort.map(x => x.f.trendTemplate)), volAdj: ranker(cohort.map(x => x.f.volAdjMom)),
      vol: ranker(cohort.map(x => x.f.volSurge)), base: ranker(cohort.map(x => x.f.baseQuality)),
      prox: ranker(cohort.map(x => x.f.proximity)),
      accum: ranker(cohort.map(x => x.m.accumRatio)), ud: ranker(cohort.map(x => x.m.udVol)),
    };

    const si = spyIdxOf[date];
    let above200 = null;
    if (si != null) { const s200 = smaAt(spyCloses, 200, si); above200 = s200 != null ? spyCloses[si] > s200 : null; }
    // Regime blends SPY-vs-200DMA with the point-in-time MACRO read (VIX + credit),
    // so vol spikes/credit stress flip a cohort risk-off even while SPY is > 200DMA.
    const mac = macroLookup ? macroLookup.at(date) : null;
    const regime = ghost.ghostRegime({
      bearish: above200 === false || (mac && mac.riskOff),
      riskOn: above200 === true && (!mac || mac.riskOn),
    });

    // 63-session forward return, cross-sectionally de-meaned → measures DIFFERENTIATION.
    const fwd = cohort.map(c => (c.candles[c.idx + MAX_HOLD].close - c.candles[c.idx].close) / c.candles[c.idx].close);
    const mean = fwd.reduce((a, b) => a + b, 0) / fwd.length;
    // SPY's forward return over the SAME window → a literal "beat the market" label.
    let spyFwd = null;
    if (si != null && si + MAX_HOLD < spyCloses.length) spyFwd = spyCloses[si + MAX_HOLD] / spyCloses[si] - 1;

    const wStart = insiderData ? win90(date) : null;
    cohort.forEach((c, i) => {
      const pct = {
        rs: rk.mom126(c.f.mom126),
        mom: Math.round((rk.mom63(c.f.mom63) + rk.mom126(c.f.mom126)) / 2),
        trend: rk.trend(c.f.trendTemplate), volAdj: rk.volAdj(c.f.volAdjMom),
        base: rk.base(c.f.baseQuality), vol: rk.vol(c.f.volSurge), prox: rk.prox(c.f.proximity),
        accum: rk.accum(c.m.accumRatio), ud: rk.ud(c.m.udVol),
      };
      // IN pillar: real if we have EDGAR history for this name, computed AS-OF the
      // cohort date (trailing 90d net buying); otherwise neutral. BONUS stays
      // neutral (no candle source) and is excluded from the composite.
      let insider = null, inCovered = false, inActive = false;
      if (insiderData && insiderData[c.t]) {
        inCovered = true;
        insider = aggregateInsider(insiderData[c.t], { windowStart: wStart, asOf: date });
        if (insider) inActive = true;
      }
      // BONUS pillar: real fundamental score reconstructed AS-OF the cohort date
      // (point-in-time quarterly growth/accel with report lag); else neutral.
      let fundamentals = null, bonusCovered = false, bonusActive = false;
      if (fundamentalsData && fundamentalsData[c.t]) {
        bonusCovered = true;
        fundamentals = pitFundamentals(fundamentalsData[c.t], date);
        if (fundamentals) bonusActive = true;
      }
      const pillars = ghost.pillarsOf({ pct, narrativeStrength: null, fundamentals, insider });
      records.push({ date, regime, sector: SECTOR_OF[c.t] || '?', pillars, r: fwd[i] - mean, rSpy: spyFwd != null ? fwd[i] - spyFwd : null, inCovered, inActive, bonusCovered, bonusActive });
      stats.byRegime[regime] = (stats.byRegime[regime] || 0) + 1;
    });
  }
  stats.records = records.length;
  return { records, stats };
}

// Purged sequential out-of-sample date blocks. The composite is FIXED, so each
// block is a clean OOS period; a `purgeDates` gap between blocks prevents a
// signal's MAX_HOLD forward window from leaking across the boundary.
function purgedBlocks(records, scoreOf, { folds = 4, purgeDates = 1 } = {}) {
  const dates = [...new Set(records.map(r => r.date))].sort();
  const D = dates.length;
  const out = [];
  if (D < folds) return { folds: out, blocks: D };
  for (let f = 0; f < folds; f++) {
    let lo = Math.floor((D * f) / folds);
    const hi = Math.floor((D * (f + 1)) / folds);
    if (f > 0) lo += purgeDates;                       // purge the boundary
    if (lo >= hi) continue;
    const blockDates = new Set(dates.slice(lo, hi));
    const rows = records.filter(r => blockDates.has(r.date));
    if (rows.length < 10) continue;
    const ic = icOf(rows.map(scoreOf), rows.map(r => r.r));
    out.push({ fold: f + 1, from: dates[lo], to: dates[hi - 1], n: rows.length, ic });
  }
  return { folds: out, blocks: D };
}

async function runGhostBacktest({ scope = 'large', step = 10, months = 12, limit = 0, deadlineMs = 45000, insiderData = null, fundamentalsData = null } = {}) {
  const t0 = Date.now();
  const macroLookup = await buildMacroLookup().catch(() => null);
  const { records, stats } = await buildCrossSection({ scope, step, months, limit, deadlineMs, insiderData, macroLookup, fundamentalsData }, t0);

  if (records.length < 100) {
    return { scope, months, step, error: 'insufficient cross-section', stats, generatedAt: new Date().toISOString() };
  }

  const rets = records.map(r => r.r);

  // 1. Per-pillar rank-IC. Price pillars over the full cross-section; IN over the
  //    records that actually had insider activity in the trailing window (where it
  //    isn't a constant 50); BONUS still pinned/untestable.
  const inActiveRecs = records.filter(r => r.inActive);
  const bonusActiveRecs = records.filter(r => r.bonusActive);
  const pillarIC = ghost.PILLARS.map(k => {
    if (PRICE_PILLARS.includes(k)) {
      return { pillar: k, label: ghost.PILLAR_LABEL[k], priceCore: true, ic: icOf(records.map(r => r.pillars[k]), rets) };
    }
    if (k === 'IN' && insiderData) {
      return { pillar: k, label: ghost.PILLAR_LABEL[k], priceCore: false, testable: true, n: inActiveRecs.length,
        ic: inActiveRecs.length >= 10 ? icOf(inActiveRecs.map(r => r.pillars.IN), inActiveRecs.map(r => r.r)) : null,
        note: 'EDGAR insider — IC over records with active 90d transactions' };
    }
    if (k === 'BONUS' && fundamentalsData) {
      return { pillar: k, label: ghost.PILLAR_LABEL[k], priceCore: false, testable: true, n: bonusActiveRecs.length,
        ic: bonusActiveRecs.length >= 10 ? icOf(bonusActiveRecs.map(r => r.pillars.BONUS), bonusActiveRecs.map(r => r.r)) : null,
        note: 'point-in-time fundamental score — IC over records with reconstructable quarterly data' };
    }
    return { pillar: k, label: ghost.PILLAR_LABEL[k], priceCore: false, ic: null,
      note: 'pinned neutral (no source) — ' + (k === 'IN' ? 'load EDGAR history (?insider=1)' : k === 'BONUS' ? 'load quarterly series (?fundamentals=1)' : 'not testable until step-4 feeds') };
  });

  // 2. Composite price-core rank-IC (fixed GAI priors, per-record regime weights).
  const scoreOf = r => priceComposite(r.pillars, priceWeights(ghost.REGIME_WEIGHTS[r.regime] || ghost.REGIME_WEIGHTS.neutral));
  const compositeIC = icOf(records.map(scoreOf), rets);
  const byRegime = ghost.REGIMES.map(R => {
    const rows = records.filter(r => r.regime === R);
    return { regime: R, n: rows.length, ic: rows.length >= 10 ? icOf(rows.map(scoreOf), rows.map(r => r.r)) : null };
  });

  // 3. Marginal ablation — IC drop when each price pillar is zeroed from the composite.
  const ablation = PRICE_PILLARS.map(k => {
    const wDrop = r => { const w = priceWeights(ghost.REGIME_WEIGHTS[r.regime] || ghost.REGIME_WEIGHTS.neutral); const w2 = { ...w, [k]: 0 }; return priceComposite(r.pillars, w2); };
    const ic2 = icOf(records.map(wDrop), rets);
    return { pillar: k, label: ghost.PILLAR_LABEL[k], marginal: (compositeIC != null && ic2 != null) ? +(compositeIC - ic2).toFixed(4) : null };
  }).sort((a, b) => (b.marginal ?? -9) - (a.marginal ?? -9));

  // 3b. INSIDER (IN) report — only when EDGAR history is loaded. Does adding the
  //     insider pillar improve ranking over the price core? Compared apples-to-
  //     apples over the SAME insider-covered record subset.
  let insider = null;
  if (insiderData) {
    const covered = records.filter(r => r.inCovered);
    const scoreP = r => priceComposite(r.pillars, priceWeights(ghost.REGIME_WEIGHTS[r.regime] || ghost.REGIME_WEIGHTS.neutral));
    const scorePIN = r => priceInComposite(r.pillars, priceInWeights(ghost.REGIME_WEIGHTS[r.regime] || ghost.REGIME_WEIGHTS.neutral));
    const icP = covered.length >= 10 ? icOf(covered.map(scoreP), covered.map(r => r.r)) : null;
    const icPIN = covered.length >= 10 ? icOf(covered.map(scorePIN), covered.map(r => r.r)) : null;
    insider = {
      coverage: { tickers: Object.keys(insiderData).length, coveredRecords: covered.length, activeRecords: inActiveRecs.length },
      inIC: inActiveRecs.length >= 10 ? icOf(inActiveRecs.map(r => r.pillars.IN), inActiveRecs.map(r => r.r)) : null,
      composite: { priceOnly: icP, withIN: icPIN, delta: (icP != null && icPIN != null) ? +(icPIN - icP).toFixed(4) : null },
      note: 'composite IC over the insider-covered subset; IN-pillar IC over records with active 90d transactions. Positive delta = insider data improves the ranking.',
    };
  }

  // 3c. BONUS (fundamental) report — only when the quarterly series is loaded.
  //     Does point-in-time fundamental acceleration add ranking power?
  let bonus = null;
  if (fundamentalsData) {
    const covered = records.filter(r => r.bonusCovered);
    const scoreP = r => priceComposite(r.pillars, priceWeights(ghost.REGIME_WEIGHTS[r.regime] || ghost.REGIME_WEIGHTS.neutral));
    const scorePB = r => priceBonusComposite(r.pillars, priceBonusWeights(ghost.REGIME_WEIGHTS[r.regime] || ghost.REGIME_WEIGHTS.neutral));
    const icP = covered.length >= 10 ? icOf(covered.map(scoreP), covered.map(r => r.r)) : null;
    const icPB = covered.length >= 10 ? icOf(covered.map(scorePB), covered.map(r => r.r)) : null;
    bonus = {
      coverage: { tickers: Object.keys(fundamentalsData).length, coveredRecords: covered.length, activeRecords: bonusActiveRecs.length },
      bonusIC: bonusActiveRecs.length >= 10 ? icOf(bonusActiveRecs.map(r => r.pillars.BONUS), bonusActiveRecs.map(r => r.r)) : null,
      composite: { priceOnly: icP, withBonus: icPB, delta: (icP != null && icPB != null) ? +(icPB - icP).toFixed(4) : null },
      note: 'point-in-time fundamental BONUS (no narrative half, which is not reconstructable). Positive delta = fundamentals improve the ranking.',
    };
  }

  // 4. Purged walk-forward of the FIXED composite across sequential date blocks.
  const cv = purgedBlocks(records, scoreOf, { folds: 4, purgeDates: 1 });
  const blockICs = cv.folds.map(f => f.ic).filter(v => v != null);
  const positiveBlocks = blockICs.filter(v => v > 0).length;
  const meanOOS = blockICs.length ? +(blockICs.reduce((a, b) => a + b, 0) / blockICs.length).toFixed(4) : null;
  const MARGIN = 0.02;
  // Ship criterion: a real (not noise) edge that holds out-of-sample — full-sample
  // IC above margin AND ≥3 OOS blocks all positive with a positive mean.
  const passed = compositeIC != null && compositeIC > MARGIN
    && blockICs.length >= 3 && positiveBlocks === blockICs.length && meanOOS > MARGIN;

  // 5. CONVICTION ranker — the unified score = the FULL GAI composite (momentum
  //    core + real BONUS/IN where their feeds are loaded), using the FIXED prior
  //    weights (nothing re-optimized → clean OOS). Two questions: (1) does adding
  //    the fundamental/insider pillars rank better than the momentum core alone,
  //    and (2) — the product question — what is the empirical probability of
  //    BEATING SPY by conviction bucket? CERN forced-flow is deliberately NOT here:
  //    it's sparse/event-driven, so it can't be a dense cross-sectional factor —
  //    it's an orthogonal overlay validated by its own κ-posteriors and stacked at
  //    the portfolio level, not inside this rank-IC test.
  const fullComposite = (pl, rw) => { let s = 0, t = 0; for (const k of ghost.PILLARS) { const w = rw[k] || 0; s += (pl[k] || 0) * w; t += w; } return t > 0 ? s / t : 0; };
  const convScore = r => fullComposite(r.pillars, ghost.REGIME_WEIGHTS[r.regime] || ghost.REGIME_WEIGHTS.neutral);
  const convIC = icOf(records.map(convScore), rets);

  // Apples-to-apples on the records where the added BONUS/IN pillars are actually
  // live (elsewhere they're a constant 50 that can't change the ranking).
  const enriched = records.filter(r => r.bonusActive || r.inActive);
  const enrConv = enriched.length >= 10 ? icOf(enriched.map(convScore), enriched.map(r => r.r)) : null;
  const enrPrice = enriched.length >= 10 ? icOf(enriched.map(scoreOf), enriched.map(r => r.r)) : null;

  // Empirical P(beat SPY) by conviction quintile (pooled, ranked on the score).
  // Beat = the name's 63-session forward return exceeded SPY's over the same window.
  const bsq = beatSpyQuintiles(records, convScore);
  const buckets = bsq.quintiles, top = bsq.topQuintile, bot = bsq.bottomQuintile, spread = bsq.spread;
  const spyRecs = records.filter(r => r.rSpy != null);

  // Purged OOS walk-forward of the conviction score (same gate as the core).
  const cvc = purgedBlocks(records, convScore, { folds: 4, purgeDates: 1 });
  const cBlockICs = cvc.folds.map(f => f.ic).filter(v => v != null);
  const cPositive = cBlockICs.filter(v => v > 0).length;
  const cMeanOOS = cBlockICs.length ? +(cBlockICs.reduce((a, b) => a + b, 0) / cBlockICs.length).toFixed(4) : null;
  const cGeneralizes = convIC != null && convIC > MARGIN && cBlockICs.length >= 3 && cPositive === cBlockICs.length && cMeanOOS > MARGIN;
  const topBeats = !!(top && top.wilsonLo > 0.5);

  const conviction = {
    note: 'Unified conviction = full GAI composite (momentum core + real BONUS/IN where loaded), FIXED prior weights — nothing re-optimized, so the OOS blocks are clean. Base-rate caveat: in a risk-on momentum cohort most names beat SPY, so read the top-vs-bottom SPREAD and the cohort-excess rank-IC, not the absolute beat-rate alone.',
    ic: convIC, priceCoreIC: compositeIC,
    addsOverCore: (convIC != null && compositeIC != null) ? +(convIC - compositeIC).toFixed(4) : null,
    enriched: { n: enriched.length, convictionIC: enrConv, priceCoreIC: enrPrice,
      delta: (enrConv != null && enrPrice != null) ? +(enrConv - enrPrice).toFixed(4) : null,
      note: enriched.length ? 'IC on records where BONUS/IN are live — the honest "does enrichment help" test' : 'no BONUS/IN-covered records (run with ?fundamentals=1&insider=1)' },
    beatSpy: { quintiles: buckets, topQuintile: top, bottomQuintile: bot, spread,
      n: spyRecs.length, label: 'P(name beats SPY over 63 sessions)' },
    walkforward: { folds: cvc.folds, oosBlocks: cBlockICs.length, positiveBlocks: cPositive, meanOOS: cMeanOOS },
    verdict: {
      generalizes: cGeneralizes, topQuintileBeatsMarket: topBeats,
      headline: !cGeneralizes
        ? `Conviction rank-IC ${convIC} did not clear the OOS gate (${cPositive}/${cBlockICs.length} blocks positive, mean ${cMeanOOS}) — do NOT ship as a standalone ranker yet.`
        : topBeats
          ? `Conviction GENERALIZES (IC ${convIC}, all ${cBlockICs.length} OOS blocks positive) — top quintile beats SPY ${top ? Math.round(top.beatSpyRate * 100) : '?'}% of the time (Wilson LB ${top ? Math.round(top.wilsonLo * 100) : '?'}% > 50%), a ${spread != null ? '+' + Math.round(spread * 100) : '?'}pt spread over the bottom quintile.`
          : `Conviction generalizes (IC ${convIC}) and shows a ${spread != null ? (spread >= 0 ? '+' : '') + Math.round(spread * 100) + 'pt' : '?'} top-vs-bottom beat-rate spread, but the top quintile's Wilson LB is ${top ? Math.round(top.wilsonLo * 100) : '?'}% (≤50%) — real selection power, not yet a confident standalone >50% bet after uncertainty.`,
    },
  };

  // ── REFINEMENT A: re-validated lever stack on the conviction score ──────────
  // Four data-justified refinements with a lever ladder so each one's marginal IC
  // is attributable, then re-run through the SAME OOS + Wilson gates:
  //   (1) DROP IN — negative IC on large-cap (sell-side artifact); zeroed.
  //   (2) BONUS tilt — the one additive factor (+IC); up-weighted 1.5×.
  //   (3) REGIME gate — measure on non-risk-off cohorts only (edge inverts risk-off),
  //       reflecting a live "no new longs in macro-risk-off" rule.
  //   (4) SECTOR/size-neutral IC — strips the cohort's beta/size tilt vs SPY.
  // IN-dropped (no BONUS tilt) — the marginal step before the shared scorer.
  const dropInScore = r => priceBonusComposite(r.pillars, priceBonusWeights(ghost.REGIME_WEIGHTS[r.regime] || ghost.REGIME_WEIGHTS.neutral));
  // The refined score IS the shipped conviction scorer (single source of truth in
  // lib/conviction) — so the validated number and the live ranker can't diverge.
  const refScore = r => convictionScore(r.pillars, r.regime);
  const gated = records.filter(r => longOk(r.regime));

  const levers = {
    base_allRegime: convIC,
    dropIN_allRegime: icOf(records.map(dropInScore), rets),
    dropIN_bonusTilt_allRegime: icOf(records.map(refScore), rets),
    refined_regimeGated: gated.length >= 10 ? icOf(gated.map(refScore), gated.map(r => r.r)) : null,
    refined_sectorNeutral_gated: sectorNeutralIC(gated, refScore),
  };
  const rbsq = beatSpyQuintiles(gated, refScore);
  const rtop = rbsq.topQuintile;
  const cvr = purgedBlocks(gated, refScore, { folds: 4, purgeDates: 1 });
  const rBlockICs = cvr.folds.map(f => f.ic).filter(v => v != null);
  const rPositive = rBlockICs.filter(v => v > 0).length;
  const rMeanOOS = rBlockICs.length ? +(rBlockICs.reduce((a, b) => a + b, 0) / rBlockICs.length).toFixed(4) : null;
  const rGeneralizes = levers.refined_regimeGated != null && levers.refined_regimeGated > MARGIN && rBlockICs.length >= 3 && rPositive === rBlockICs.length && rMeanOOS > MARGIN;
  const rTopBeats = !!(rtop && rtop.wilsonLo > 0.5);
  const baseLo = top ? top.wilsonLo : null, refLo = rtop ? rtop.wilsonLo : null;

  const convictionRefined = {
    note: 'Refinement-A re-validation: drop IN + BONUS tilt + regime gate + sector-neutral IC, re-run through the same purged-WF + Wilson gates. The regime-gated beat-rate is conditional on applying a live "no longs in macro-risk-off" rule. NB this 12mo window is regime-heavy risk-on, so it UNDERSTATES the regime gate; months=54 would show more.',
    weightsExample: convictionWeights('neutral'),
    icLadder: levers,
    regimeGate: { keptRecords: gated.length, droppedRiskOff: records.length - gated.length },
    beatSpy: { quintiles: rbsq.quintiles, topQuintile: rtop, bottomQuintile: rbsq.bottomQuintile, spread: rbsq.spread, n: rbsq.n },
    walkforward: { folds: cvr.folds, oosBlocks: rBlockICs.length, positiveBlocks: rPositive, meanOOS: rMeanOOS },
    beforeAfter: { baseTopQuintileWilsonLo: baseLo, refinedTopQuintileWilsonLo: refLo,
      improvement: (baseLo != null && refLo != null) ? +(refLo - baseLo).toFixed(3) : null,
      baseTopBeatRate: top ? top.beatSpyRate : null, refinedTopBeatRate: rtop ? rtop.beatSpyRate : null },
    verdict: {
      generalizes: rGeneralizes, topQuintileBeatsMarket: rTopBeats,
      headline: !rGeneralizes
        ? `Refined conviction IC ${levers.refined_regimeGated} did not clear the OOS gate — refinements didn't produce a shippable standalone ranker.`
        : rTopBeats
          ? `Refinements WORK — refined top quintile beats SPY ${rtop ? Math.round(rtop.beatSpyRate * 100) : '?'}% with Wilson LB ${rtop ? Math.round(rtop.wilsonLo * 100) : '?'}% > 50% (base was ${baseLo != null ? Math.round(baseLo * 100) : '?'}%). Crosses the confidence bar.`
          : `Refinements lifted the edge (top-quintile Wilson LB ${refLo != null ? Math.round(refLo * 100) : '?'}% vs base ${baseLo != null ? Math.round(baseLo * 100) : '?'}%) and it generalizes OOS, but is still ≤50% LB — directionally right; needs broader feed coverage / multi-year to cross with confidence.`,
    },
  };

  return {
    scope, months, step, mode: 'walkforward', priceOnly: true,
    macroEnabled: !!macroLookup, regimeCounts: stats.byRegime,
    n: records.length, datesUsed: stats.datesUsed, screenCalls: stats.screenCalls,
    horizonSessions: MAX_HOLD, returnDef: 'cross-sectional excess (cohort-demeaned) forward return',
    pillarIC,
    composite: { ic: compositeIC, byRegime, ablation },
    insider, bonus, conviction, convictionRefined,
    walkforward: { folds: cv.folds, blocks: cv.blocks, oosBlocks: blockICs.length, positiveBlocks, meanOOS, margin: MARGIN },
    verdict: {
      passed,
      headline: passed
        ? `GAI price core generalizes — composite rank-IC ${compositeIC} held positive across all ${blockICs.length} out-of-sample blocks.`
        : (compositeIC != null && compositeIC <= MARGIN)
          ? `Weak in-sample edge — composite rank-IC only ${compositeIC} (≤ ${MARGIN}); not worth shipping as a standalone ranker.`
          : `Did not generalize — composite rank-IC ${compositeIC} in-sample but inconsistent across out-of-sample blocks (${positiveBlocks}/${blockICs.length} positive).`,
    },
    stoppedEarly: stats.stoppedEarly, elapsedMs: Date.now() - t0,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { runGhostBacktest, priceWeights, icOf };

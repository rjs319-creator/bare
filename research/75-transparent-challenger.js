'use strict';
// TRANSPARENT CHALLENGER — first identical-date ablation study (transparent-v1).
//
// THE QUESTION. Does the fixed-sign, equal-weight rank composite
//   rank(sector-residual momentum 126→21) + rank(tightness20) − rank(ATR extension)
//   − rank(idio vol 63) − rank(expected round-trip cost)
// carry any cost-net cross-sectional information the simplest arms don't — and does the
// harness correctly show its frozen INVERSE as the mirror image (a harness that scores
// a model and its inverse alike is measuring exposure, not selection)?
//
// THE ARMS (frozen in lib/transparent-challenger.js ARMS before this run; the
// multiple-testing denominator counts all of them):
//   full · residualMomentumOnly · tightnessExtension · lowVolOnly · frozenInverse
//   · frozenExisting (the shipped quant composite on the same rows)
//   · placebo (full score vs within-date SHUFFLED outcomes — leakage detector)
//
// HONESTY. Survivorship-reduced cache universe; residualization here is MARKET-basis
// (SPY), labeled — the live sector-ETF basis is a separate, stricter variant. No
// promotion can follow from this run; it is a harness-validation + first-read study.
//
// Usage: node research/75-transparent-challenger.js [--step 10] [--maxNames 800] [--topK 10]

const path = require('node:path');
const K = require('./lib/experiment-kit');
const TC = require('../lib/transparent-challenger');
const { screenTicker } = require('../lib/screener');

const STUDY_ID = 'transparent-challenger-ablation-2026-08';
const STUDY_VERSION = 'transparent-ablation-v1';
const OUT_DIR = path.join(K.DATA_DIR, 'transparent-challenger');

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]] : null)).filter(Boolean));
const STEP = Math.max(1, parseInt(args.step, 10) || 10);
const MAX_NAMES = Math.max(100, parseInt(args.maxNames, 10) || 800);
const TOP_K = Math.max(3, parseInt(args.topK, 10) || 10);
const H = 21;
const MIN_HISTORY = 280;
const MIN_ADV = 5e6;
const SEED = 20260811;

// Deterministic per-date shuffle for the placebo (mulberry32; no Math.random).
function shuffled(xs, seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) { h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = (h ^ SEED) >>> 0;
  const rand = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1));[out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

async function main() {
  const t0 = Date.now();
  console.log(`[${STUDY_ID}] loading universe…`);
  const { dataset, spy, spyIdx, attrition: uAttr } = K.loadUniverse({ minBars: MIN_HISTORY, minAdv: MIN_ADV, maxNames: MAX_NAMES });
  console.log(`  ${dataset.size} names (${JSON.stringify(uAttr)})`);

  const decisions = [];
  for (let i = 262; i <= spy.length - 1 - H; i += STEP) decisions.push(spy[i].date);
  console.log(`  decision sessions ${decisions.length} (${decisions[0]} → ${decisions[decisions.length - 1]}, step ${STEP})`);

  const attr = K.newAttrition();
  const perDate = [];

  for (const D of decisions) {
    const spyF = K.benchmarkForward(spy, spyIdx, D, H);
    if (spyF == null) { attr.noBenchmark++; continue; }
    const spySlice = K.sliceAsOf(spy, D);
    const spyCloses = spySlice.map(x => x.close);
    const spyByDate = {}; spySlice.forEach(x => { spyByDate[x.date] = x.close; });

    // Contemporaneous cohort. The shipped quant composite rides along as the
    // frozenExisting arm — same rows, same date, no re-implementation.
    const cohort = [];
    const fwdByTicker = new Map();
    for (const [t, v] of dataset) {
      const pit = K.sliceAsOf(v.candles, D);
      if (pit.length < 220) { attr.truncatedHistory++; continue; }
      if (pit[pit.length - 1].date !== D) continue;
      const fwd = K.forwardFromNextOpen(v, D, H, attr);
      if (fwd == null) continue;
      let existing = null;
      try { const r = screenTicker(pit, { symbol: t }, { gate: 'relaxed', spyByDate }); existing = r && r.quant && Number.isFinite(r.quant.score) ? r.quant.score : null; } catch { /* descriptor only */ }
      const dv = (() => { let s = 0, n = 0; for (let i = Math.max(0, pit.length - 20); i < pit.length; i++) { s += (pit[i].close || 0) * (pit[i].volume || 0); n++; } return n ? s / n : null; })();
      cohort.push({ ticker: t, candles: pit, dollarVol: dv, benchCloses: spyCloses, residualBasis: 'market', existingScore: existing });
      fwdByTicker.set(t, fwd);
    }
    if (cohort.length < 30) continue;

    const scored = TC.scoreCohort(cohort, { asOf: D });
    const eligible = scored.cohort.filter(r => r.eligible);
    if (eligible.length < 20) continue;

    const outcomes = eligible.map(r => {
      const fwd = fwdByTicker.get(r.ticker);
      const cost = K.costFractions(cohort.find(c => c.ticker === r.ticker)?.dollarVol ?? null);
      return { netExc: fwd - spyF - cost.base, netExcDoubled: fwd - spyF - cost.doubled };
    });
    const placeboOutcomes = shuffled(outcomes.map(o => o.netExc), D);

    const row = { date: D, n: eligible.length, cohortSize: scored.cohortSize, rejected: scored.rejectedCount, arms: {} };
    for (const arm of scored.arms) {
      const scores = eligible.map(r => r.scores[arm]);
      if (!scores.some(Number.isFinite)) continue;
      const paired = scores.map((s, i) => ({ s, o: outcomes[i] })).filter(x => Number.isFinite(x.s));
      const topIdx = paired.map((x, i) => [x.s, i]).sort((a, b) => b[0] - a[0]).slice(0, TOP_K).map(([, i]) => i);
      row.arms[arm] = {
        ic: K.rankIC(paired.map(x => x.s), paired.map(x => x.o.netExc)),
        topNet: K.mean(topIdx.map(i => paired[i].o.netExc)),
        topNetDoubled: K.mean(topIdx.map(i => paired[i].o.netExcDoubled)),
      };
    }
    row.arms.placebo = { ic: K.rankIC(eligible.map(r => r.scores.full), placeboOutcomes), topNet: null, topNetDoubled: null };
    perDate.push(row);
    if (perDate.length % 20 === 0) console.log(`  … ${perDate.length} dates scored`);
  }

  // Aggregate: per-arm mean IC with a date-clustered t (dates are the independent unit).
  const armNames = [...new Set(perDate.flatMap(r => Object.keys(r.arms)))];
  const summary = {};
  for (const arm of armNames) {
    const ics = perDate.map(r => r.arms[arm]?.ic).filter(Number.isFinite);
    const nets = perDate.map(r => r.arms[arm]?.topNet).filter(Number.isFinite);
    const netsDoubled = perDate.map(r => r.arms[arm]?.topNetDoubled).filter(Number.isFinite);
    const m = K.mean(ics), sd = Math.sqrt(K.mean(ics.map(x => (x - m) ** 2)) || 0);
    summary[arm] = {
      dates: ics.length,
      meanIC: +(m ?? 0).toFixed(5),
      tIC: ics.length > 3 && sd > 0 ? +((m / (sd / Math.sqrt(ics.length)))).toFixed(2) : null,
      meanTopNetPct: nets.length ? +(K.mean(nets) * 100).toFixed(3) : null,
      meanTopNetDoubledPct: netsDoubled.length ? +(K.mean(netsDoubled) * 100).toFixed(3) : null,
    };
  }

  const inverseMirror = summary.full && summary.frozenInverse
    ? +(summary.full.meanIC + summary.frozenInverse.meanIC).toFixed(6) : null;
  const placeboClean = summary.placebo ? Math.abs(summary.placebo.meanIC) < 0.02 : null;

  const result = {
    studyId: STUDY_ID, version: STUDY_VERSION, generatedAt: new Date().toISOString(),
    config: { STEP, MAX_NAMES, TOP_K, H, MIN_HISTORY, MIN_ADV, SEED, residualBasis: 'market (SPY) — labeled; sector-ETF basis is a separate variant' },
    dates: perDate.length, attrition: attr, summary,
    checks: {
      inverseMirror, // must be ≈ 0: full and its inverse are exact mirrors on rank IC
      placeboClean,  // |placebo IC| < 0.02 or the harness is suspect
    },
    honesty: 'survivorship-reduced cache; market-basis residualization; NO promotion may follow from this run',
  };

  const artifact = K.writeArtifact(OUT_DIR, `${STUDY_ID}.json`, { ...result, perDate });
  console.log(JSON.stringify({ ...result, artifact: artifact.file }, null, 2));

  K.recordExperiment({
    id: STUDY_ID,
    hypothesis: 'transparent-challenger-v1: fixed-sign equal-weight rank composite (residual momentum + tightness − extension − idio vol − cost) carries cost-net cross-sectional information; ablation arms isolate each family; the frozen inverse and a shuffled placebo validate the harness',
    family: 'swing-ranking',
    frozenConfig: result.config,
    dataSnapshot: { dir: K.CACHE_DIR, names: dataset.size, dates: perDate.length },
    codeVersion: STUDY_VERSION,
    testDates: perDate.length ? [perDate[0].date, perDate[perDate.length - 1].date] : [],
    variationsAttempted: armNames.length,
    result: summary,
    correctedSignificance: 'BH within swing-ranking family at read time via hypothesis-registry familyTrials',
    costStress: { base: summary.full?.meanTopNetPct ?? null, doubled: summary.full?.meanTopNetDoubledPct ?? null },
    decision: 'shadow-only; registered zero-weight; prospective confirmation required regardless of this result',
    reason: 'first identical-date ablation + harness validation (inverse mirror, placebo)',
    artifact: { sha256: artifact.sha256, file: path.relative(process.cwd(), artifact.file) },
  });
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch(e => { console.error(e); process.exit(1); });

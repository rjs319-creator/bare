'use strict';
// SWING SCREENER VALIDATION v3 — production-parity replay study (2026-08).
//
// Runs the EXACT shared production selection engine (lib/swing-screener-engine,
// the same code api/screener.js serves) date-first over the local research price
// cache, then evaluates the FROZEN challenger set:
//   A. control            — the exact current production screener selection
//   B. sector-neutral 21s — sector-relative momentum, volatility penalty,
//                           setup flag, liquidity quality (frozen weights below)
//   C. 63s position       — risk-adjusted momentum (vol-scaled), separate
//                           'position' horizon and outcome contract
//   D. event revisions    — BLOCKED: no point-in-time estimate/revision history
//                           with verified publish timestamps exists in this repo
//                           (estimates-adapter is PIT_UNPROVEN); running it would
//                           require imputing timestamps, which is forbidden.
//
// FROZEN BEFORE RUNNING (multiple-testing denominator = 4 registered trials:
// A, B, C, D — nothing else was inspected):
//   B score = 1.0·z(sectorRelMom126) − 0.5·z(vol63) + 0.3·z(log10 dollarVol) + 0.2·hasStatus
//   C score = volAdjMom (mom63 / annualized vol) — the repo's existing frozen definition
// Population for B/C: the PRODUCTION-ELIGIBLE cohort only (freshness-current,
// liquidity-floored names passing the live relaxed gate: RS-vs-SPY + 50/200 trend).
//
// HONESTY LIMITS (stated, not papered over):
//   • Universe = every locally cached symbol with sufficient history + liquidity.
//     It contains many delisted names (their bars end; the freshness gate then
//     excludes them per date — a partial, NOT proven-safe, survivorship guard).
//     survivorshipProvenSafe = false ⇒ NO strategy can pass promotion here.
//   • The live macro (VIX/credit) overlay has no PIT series here ⇒ replay runs
//     macroRiskOff:false. The SPY-200DMA/breadth regime IS replayed exactly.
//   • Name-dates with |1-day| move > 50% are excluded from outcome stats
//     (suspected unadjusted corporate action), counted in the manifest.
//
// Usage: node research/65-swing-replay-validation.js [--step 5] [--maxNames 2000]
// Artifacts (immutable, hash-stamped): research/data/swing-replay-v3/

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ENGINE = require('../lib/swing-screener-engine');
const { screenTicker } = require('../lib/screener');
const { sliceAsOf } = require('../lib/swing-replay-v3');
const { candidateId, candidateSetHash } = require('../lib/swing-candidate-schema');
const STATS = require('../lib/research/stats-v3');
const { roundTripCostPct } = require('../lib/costs');
const { SECTOR_OF } = require('../lib/universe');

const STUDY_VERSION = 'swing-replay-validation-v3-2026-08';
const DATA_DIR = process.env.RESEARCH_DATA_DIR || path.join(__dirname, 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const OUT_DIR = path.join(DATA_DIR, 'swing-replay-v3');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1]] : null).filter(Boolean));
const STEP = Math.max(1, parseInt(args.step, 10) || 5);
const MAX_NAMES = Math.max(100, parseInt(args.maxNames, 10) || 2000);
const MIN_BARS = 280;
const MIN_ADV = 10_000_000;       // last-60-bar average dollar volume floor for study membership
const H21 = 21, H63 = 63;
const TRIALS_REGISTERED = 4;      // A, B, C, D — the full frozen denominator
const SEED = 20260803;
const EXTREME_1D = 0.50;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const mean = (a) => a.length ? a.reduce((x, v) => x + v, 0) / a.length : null;

function loadSeries(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = (d.price || []).slice().reverse();   // stored newest-first → ascending
    if (rows.length < 60) return null;
    return rows.map(r => ({ date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
  } catch { return null; }
}

function advOf(candles) {
  const n = candles.length;
  let s = 0, c = 0;
  for (let i = Math.max(0, n - 60); i < n; i++) { s += (candles[i].close || 0) * (candles[i].volume || 0); c++; }
  return c ? s / c : 0;
}

// Spearman-style rank IC between score[] and outcome[] (paired arrays).
function rankIC(scores, outcomes) {
  const n = scores.length;
  if (n < 3) return null;
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const out = new Array(n);
    idx.forEach(([, i], r) => { out[i] = r; });
    return out;
  };
  const rs = rank(scores), ro = rank(outcomes);
  const mr = (n - 1) / 2;
  let num = 0, ds = 0, dso = 0;
  for (let i = 0; i < n; i++) { const a = rs[i] - mr, b = ro[i] - mr; num += a * b; ds += a * a; dso += b * b; }
  return (ds > 0 && dso > 0) ? num / Math.sqrt(ds * dso) : null;
}

const zscore = (arr) => {
  const m = mean(arr.filter(Number.isFinite));
  const sd = Math.sqrt(mean(arr.filter(Number.isFinite).map(v => (v - m) ** 2)) || 0) || 1;
  return arr.map(v => Number.isFinite(v) ? (v - m) / sd : 0);
};

async function main() {
  const t0 = Date.now();
  console.log(`[${STUDY_VERSION}] loading dataset…`);
  const spyRaw = loadSeries(path.join(CACHE_DIR, 'SPY.json'));
  if (!spyRaw) throw new Error('SPY missing from research cache');
  const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json') && f !== 'SPY.json');
  const dataset = new Map();
  let skippedBars = 0, skippedAdv = 0;
  for (const f of files) {
    if (dataset.size >= MAX_NAMES) break;
    const t = f.replace(/\.json$/, '');
    const candles = loadSeries(path.join(CACHE_DIR, f));
    if (!candles || candles.length < MIN_BARS) { skippedBars++; continue; }
    if (advOf(candles) < MIN_ADV) { skippedAdv++; continue; }
    dataset.set(t, { candles });
  }
  console.log(`  members ${dataset.size} (skipped: bars<${MIN_BARS} ${skippedBars}, adv<$${MIN_ADV / 1e6}M ${skippedAdv})`);

  // Decision axis: every STEP-th SPY session, leaving 63 forward sessions.
  const spyDates = spyRaw.map(b => b.date);
  const spyIdx = new Map(spyDates.map((d, i) => [d, i]));
  const decisions = [];
  for (let i = 262; i <= spyRaw.length - 1 - H63; i += STEP) decisions.push(spyDates[i]);
  console.log(`  decision sessions ${decisions.length} (${decisions[0]} → ${decisions[decisions.length - 1]}, step ${STEP})`);

  // Per-ticker date index for O(1) outcome lookups.
  const tIdx = new Map();
  for (const [t, v] of dataset) tIdx.set(t, new Map(v.candles.map((b, i) => [b.date, i])));

  // Next-open → close(d+H) return; null when unobservable or extreme (suspected
  // unadjusted corporate action).
  let extremeDropped = 0;
  function fwd(t, decisionDate, H) {
    const v = dataset.get(t);
    const im = tIdx.get(t);
    const i = im ? im.get(decisionDate) : null;
    if (i == null || i + H > v.candles.length - 1) return null;
    const e = v.candles[i + 1], x = v.candles[i + H];
    if (!e || !(e.open > 0) || !(x.close > 0)) return null;
    for (let k = i; k < i + H && k < v.candles.length - 1; k++) {
      const a = v.candles[k], b = v.candles[k + 1];
      if (a.close > 0 && Math.abs(b.close / a.close - 1) > EXTREME_1D) { extremeDropped++; return null; }
    }
    return x.close / e.open - 1;
  }
  function spyFwd(decisionDate, H) {
    const i = spyIdx.get(decisionDate);
    if (i == null || i + H > spyRaw.length - 1) return null;
    const e = spyRaw[i + 1], x = spyRaw[i + H];
    return (e && x && e.open > 0) ? x.close / e.open - 1 : null;
  }

  const rand = STATS.lcg ? STATS.lcg(SEED) : (() => { let s = SEED >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); })();

  // ── Date-first replay + challenger scoring ─────────────────────────────────
  const perDate = [];
  let done = 0;
  for (const D of decisions) {
    const spySlice = sliceAsOf(spyRaw, D);
    const spyByDate = {}; spySlice.forEach(x => { spyByDate[x.date] = x.close; });
    const rows = [];
    for (const [t, v] of dataset) {
      const pit = sliceAsOf(v.candles, D);
      if (pit.length < 200) continue;
      const r = screenTicker(pit, { symbol: t }, { gate: 'relaxed', spyByDate });
      if (!r) continue;
      if (!r.ticker) r.ticker = t;
      r.sector = SECTOR_OF[t] || 'Other';
      r.lastBarDate = pit[pit.length - 1].date;
      rows.push(r);
    }
    const now = new Date(D + 'T23:59:00Z');
    const sel = ENGINE.selectCandidates({ rows, scope: 'large', spyCandles: spySlice, now, macroRiskOff: false });

    // Production-eligible population (the live relaxed gate) with observable outcomes.
    const spy21 = spyFwd(D, H21), spy63 = spyFwd(D, H63);
    const elig = [];
    for (const c of sel.cohort) {
      const f = c.filters || {};
      if (!(f.aboveSmas && f.rsVsSpy)) continue;
      const r21 = fwd(c.ticker, D, H21), r63 = fwd(c.ticker, D, H63);
      if (r21 == null || spy21 == null) continue;
      elig.push({
        t: c.ticker, sector: c.sector, status: c.status,
        quant: c.quant.score,
        mom126: c.factors.mom126, vol: c.factors.vol, volAdjMom: c.factors.volAdjMom,
        dollarVol: c.factors.dollarVol,
        x21: r21 - spy21, x63: (r63 != null && spy63 != null) ? r63 - spy63 : null,
      });
    }
    if (elig.length < 8) { done++; continue; }

    // B: frozen sector-neutral, volatility-aware score.
    const bySector = new Map();
    elig.forEach(e => { (bySector.get(e.sector) || bySector.set(e.sector, []).get(e.sector)).push(e.mom126); });
    const secMean = new Map([...bySector].map(([s, a]) => [s, mean(a.filter(Number.isFinite)) ?? 0]));
    const relMom = zscore(elig.map(e => (e.mom126 ?? 0) - (secMean.get(e.sector) ?? 0)));
    const volZ = zscore(elig.map(e => e.vol ?? 0));
    const liqZ = zscore(elig.map(e => Math.log10(Math.max(1, e.dollarVol || 1))));
    const bScore = elig.map((e, i) => 1.0 * relMom[i] - 0.5 * volZ[i] + 0.3 * liqZ[i] + 0.2 * (e.status ? 1 : 0));

    // Per-date metrics.
    const x21 = elig.map(e => e.x21);
    const selected = new Set(sel.candidates.slice(0, sel.cap).map(c => c.ticker));
    const selX = elig.filter(e => selected.has(e.t)).map(e => e.x21);
    const e63 = elig.filter(e => e.x63 != null);
    const shuffled = [...x21];
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    perDate.push({
      date: D, eligible: elig.length, cohort: sel.cohort.length,
      selectedCount: selX.length,
      candidateSetHash: candidateSetHash(sel.candidates.slice(0, sel.cap).map(c =>
        candidateId({ strategyId: 'screener', scoringVersion: 'screener-v1', universeScope: 'large', ticker: c.ticker, decisionCutoff: D }))),
      rejectionCounts: sel.rejections.reduce((m, r) => { m[r.reason] = (m[r.reason] || 0) + 1; return m; }, {}),
      regime: sel.regime ? (sel.regime.bearish ? 'risk-off' : sel.regime.riskOn ? 'risk-on' : 'neutral') : null,
      A_selMeanX21: mean(selX),
      A_icQuant21: rankIC(elig.map(e => e.quant), x21),
      B_ic21: rankIC(bScore, x21),
      C_ic63: e63.length >= 8 ? rankIC(e63.map(e => e.volAdjMom ?? 0), e63.map(e => e.x63)) : null,
      C_top10MeanX63: e63.length >= 10 ? mean(e63.slice().sort((a, b) => (b.volAdjMom ?? 0) - (a.volAdjMom ?? 0)).slice(0, 10).map(e => e.x63)) : null,
      base_icMom21: rankIC(elig.map(e => e.mom126 ?? 0), x21),
      base_eqwX21: mean(x21),
      placebo_ic21: rankIC(bScore, shuffled),
      random_ic21: rankIC(elig.map(() => rand()), x21),
    });
    done++;
    if (done % 25 === 0) console.log(`  …${done}/${decisions.length} sessions (${Date.now() - t0}ms)`);
  }

  // ── Inference: HAC t on per-date series, ESS, MBB CI, chronological blocks ──
  const series = (k) => perDate.map(d => d[k]).filter(v => v != null && Number.isFinite(v));
  const lags = Math.ceil(H21 / STEP);
  function summarize(k, { horizonLags = lags } = {}) {
    const s = series(k);
    if (s.length < 8) return { n: s.length, insufficient: true };
    const nw = STATS.neweyWest(s, { lags: horizonLags });
    const ess = STATS.effectiveSampleSize(s);
    const mbb = STATS.movingBlockBootstrap(s, { B: 500, seed: SEED });
    const third = Math.floor(s.length / 3);
    const blocks = [s.slice(0, third), s.slice(third, 2 * third), s.slice(2 * third)].map(b => +(mean(b) ?? 0).toFixed(5));
    const p = STATS.pFromT(nw.tstat);
    return {
      n: s.length, mean: +(mean(s)).toFixed(5),
      hacT: nw.tstat != null ? +nw.tstat.toFixed(3) : null,
      naiveT: nw.naiveTstat != null ? +nw.naiveTstat.toFixed(3) : null,
      p: p != null ? +p.toFixed(4) : null,
      ess: ess.ess, mbbCi90: mbb.ci90 || null,
      chronBlocks: blocks, positiveBlocks: blocks.filter(v => v > 0).length,
    };
  }

  const A_sel = summarize('A_selMeanX21');
  const A_ic = summarize('A_icQuant21');
  const B_ic = summarize('B_ic21');
  const C_ic = summarize('C_ic63', { horizonLags: Math.ceil(H63 / STEP) });
  const C_top = summarize('C_top10MeanX63', { horizonLags: Math.ceil(H63 / STEP) });
  const baseMom = summarize('base_icMom21');
  const baseEqw = summarize('base_eqwX21');
  const placebo = summarize('placebo_ic21');
  const randomB = summarize('random_ic21');

  // BH/FDR across the registered trials (denominator = TRIALS_REGISTERED, D
  // counts even though blocked — it was a registered inspection).
  const trials = [
    { id: 'A-control-production-21s', p: A_ic.p ?? 1 },
    { id: 'B-sector-neutral-vol-21s', p: B_ic.p ?? 1 },
    { id: 'C-riskadj-momentum-63s', p: C_ic.p ?? 1 },
    { id: 'D-event-revisions', p: 1, blocked: true },
  ].sort((a, b) => a.p - b.p);
  trials.forEach((t, i) => { t.q = +Math.min(1, t.p * TRIALS_REGISTERED / (i + 1)).toFixed(4); });
  for (let i = trials.length - 2; i >= 0; i--) trials[i].q = Math.min(trials[i].q, trials[i + 1].q);

  // Cost stress on the economically relevant selections (A cap-20; C top-10).
  const rt = roundTripCostPct('liquid') / 100;
  const cost = (m) => m == null ? null : ({
    gross: +m.toFixed(5),
    netBase: +(m - rt).toFixed(5),
    netDoubled: +(m - 2 * rt).toFixed(5),
    netStressed: +(m - (roundTripCostPct('small') / 100) * 1.5).toFixed(5),
  });

  const gateFor = (icSum, costRow, q) => {
    const checks = {
      productionReplayParity: true,                       // same engine, hashes recorded per date
      pointInTimeFeatures: true,                          // sliceAsOf features; outcomes forward-only
      survivorshipProvenSafe: false,                      // partial guard only — HARD BLOCK
      fullyObservedCohortsOnly: true,                     // unobservable outcomes excluded per name-date
      purgedChronologicalInference: true,                 // HAC lags ≥ overlap; chronological blocks
      pairedDateInference: true,
      hacUncertainty: true,
      fdrControlled: q != null ? q <= 0.10 : false,
      effectiveSampleGte30: (icSum.ess ?? 0) >= 30,
      threePositiveChronBlocks: (icSum.positiveBlocks ?? 0) >= 3,
      positiveAbsoluteOosIC: (icSum.mean ?? 0) > 0 && (icSum.hacT ?? 0) > 0,
      costNetPositiveAllStress: !!(costRow && costRow.netBase > 0 && costRow.netDoubled > 0 && costRow.netStressed > 0),
      prospectiveEvidence: false,                         // none accrued yet for these variants
      humanRegistryApproval: false,                       // never grantable by a script
    };
    return { checks, promotionEligible: Object.values(checks).every(Boolean) };
  };

  const A_cost = cost(A_sel.mean);
  const C_cost = cost(C_top.mean);
  const verdicts = {
    A_control: {
      hypothesis: 'the exact current production screener selection carries a 21-session cost-net edge',
      ic: A_ic, selectionExcess: A_sel, cost: A_cost, q: trials.find(t => t.id.startsWith('A')).q,
      gate: gateFor(A_ic, A_cost, trials.find(t => t.id.startsWith('A')).q),
    },
    B_sectorNeutralVol21: {
      hypothesis: 'frozen sector-relative, vol-penalized 21s score ranks the production-eligible population',
      ic: B_ic, q: trials.find(t => t.id.startsWith('B')).q,
      beatsSimpleMomentum: (B_ic.mean ?? -1) > (baseMom.mean ?? 0),
      gate: gateFor(B_ic, null, trials.find(t => t.id.startsWith('B')).q),
      status: 'SHADOW — not proven; stays weight-0 regardless of this run',
    },
    C_position63: {
      hypothesis: 'risk-adjusted momentum carries a 63-session position-horizon edge',
      ic: C_ic, top10Excess: C_top, cost: C_cost, q: trials.find(t => t.id.startsWith('C')).q,
      gate: gateFor(C_ic, C_cost, trials.find(t => t.id.startsWith('C')).q),
      status: 'SHADOW — separate position-horizon contract; needs ≥30 effective + prospective evidence',
    },
    D_eventRevisions: {
      status: 'BLOCKED',
      reason: 'No point-in-time estimate/revision history with verified publish timestamps exists in this repo (lib/research/estimates-adapter is PIT_UNPROVEN). Imputing timestamps is forbidden — the experiment is marked blocked, not run.',
    },
    baselines: { simpleMomentumIC: baseMom, equalWeightEligibleExcess: baseEqw, placeboIC: placebo, randomIC: randomB },
  };

  // ── Immutable artifacts ────────────────────────────────────────────────────
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const datasetHash = sha([...dataset.keys()].sort().join(',') + '|' + spyDates[0] + '|' + spyDates[spyDates.length - 1]);
  const manifest = {
    version: STUDY_VERSION,
    generatedAt: new Date().toISOString(),
    engineVersion: ENGINE.ENGINE_VERSION,
    trialsRegistered: TRIALS_REGISTERED,
    frozen: {
      B: 'score = 1.0·z(sectorRelMom126) − 0.5·z(vol63) + 0.3·z(log10 dollarVol) + 0.2·hasStatus',
      C: 'score = volAdjMom (mom63/annualized vol), horizon 63 sessions, position contract',
    },
    dataset: {
      members: dataset.size, datasetHash,
      barsWindow: [spyDates[0], spyDates[spyDates.length - 1]],
      minBars: MIN_BARS, minAdv: MIN_ADV, maxNames: MAX_NAMES,
      skippedBars, skippedAdv, extremeMoveNameDatesDropped: extremeDropped,
      survivorship: 'PARTIAL: cache includes delisted names whose bars end (per-date freshness gate excludes them after death); NOT proven-safe — promotion structurally blocked',
      macro: 'macroRiskOff fixed false (no PIT VIX/credit series) — regime gate (SPY 200DMA + breadth) replayed exactly',
      priceBasis: 'FMP historical close (split-adjusted per vendor); |1d|>50% name-dates excluded as suspected unadjusted corporate actions',
    },
    axis: { decisions: decisions.length, step: STEP, first: decisions[0], last: decisions[decisions.length - 1] },
    inference: { hacLags21: lags, hacLags63: Math.ceil(H63 / STEP), mbbB: 500, seed: SEED, blocks: 3 },
    costModel: { basis: 'lib/costs round-trip pct', liquidRoundTripPct: roundTripCostPct('liquid'), stressed: 'small-tier ×1.5' },
    elapsedMs: Date.now() - t0,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'per-date-metrics.json'), JSON.stringify({ version: STUDY_VERSION, datasetHash, perDate }, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'verdicts.json'), JSON.stringify({ version: STUDY_VERSION, datasetHash, trials, verdicts }, null, 2));
  console.log(JSON.stringify({ manifest: { members: dataset.size, decisions: decisions.length, elapsedMs: manifest.elapsedMs }, trials, verdicts }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });

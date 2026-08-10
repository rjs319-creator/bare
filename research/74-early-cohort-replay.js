'use strict';
// EARLY-COHORT REPLAY STUDY (2026-08) — does the screener's Early tier carry the
// section's edge, as the live Scoreboard record suggests?
//
// MOTIVATION (live resolved record as of 2026-08-09, section 'screener', 5d
// cost-net excess vs SPY): Early:large +0.62% (n=24 / 16 dates, 3/4 positive
// chronological blocks) while Breakout:large −2.66% (n=67) and Setup:large
// −0.20% (n=89); the pooled record graded the whole section 'disabled'. That
// live sample spans ~28 decision dates in one regime — exactly the window size
// that produced the exits/PEAD false positives. This study asks the same
// question over the full multi-year local cache with the EXACT production
// selection engine before any policy-cohort change is made.
//
// FROZEN BEFORE RUNNING (multiple-testing denominator = 4 registered contrasts;
// nothing else will be read as a verdict):
//   R1. Early mean 5d cost-net excess vs SPY > 0
//   R2. Early − Setup, 5d cost-net excess difference > 0
//   R3. Early − Breakout, 5d cost-net excess difference > 0
//   R4. Early mean 21d cost-net excess vs SPY > 0 (persistence)
// Population: production-parity cohort (lib/swing-screener-engine
// selectCandidates, scope 'large') — admitted, freshness-gated, statused rows
// with observable outcomes. Entry next-session open; exit close at +H sessions.
// Cost: 'liquid' round-trip (lib/costs, 0.16%) subtracted once per name-date.
// Inference: equal-weight PER-DATE portfolio per tier; HAC (Newey-West) t with
// lags ceil(H/STEP); effective sample size; moving-block bootstrap CI;
// 4 chronological blocks; replayed-regime split.
//
// HONESTY LIMITS (same as research/65): partial survivorship guard only (cache
// holds delisted names whose bars end; NOT proven-safe), no PIT macro overlay
// (macroRiskOff:false), |1d|>50% name-dates excluded as suspected unadjusted
// corporate actions. This study can INFORM a policy-cohort narrowing; it cannot
// by itself promote anything.
//
// Usage: node research/74-early-cohort-replay.js [--step 5] [--maxNames 2000]
// Artifacts: research/data/early-cohort-replay/

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ENGINE = require('../lib/swing-screener-engine');
const { screenTicker } = require('../lib/screener');
const { sliceAsOf } = require('../lib/swing-replay-v3');
const STATS = require('../lib/research/stats-v3');
const { roundTripCostPct } = require('../lib/costs');
const { SECTOR_OF } = require('../lib/universe');

const STUDY_VERSION = 'early-cohort-replay-v1-2026-08';
const DATA_DIR = process.env.RESEARCH_DATA_DIR || path.join(__dirname, 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const OUT_DIR = path.join(DATA_DIR, 'early-cohort-replay');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1]] : null).filter(Boolean));
const STEP = Math.max(1, parseInt(args.step, 10) || 5);
const MAX_NAMES = Math.max(100, parseInt(args.maxNames, 10) || 2000);
const MIN_BARS = 280;
const MIN_ADV = 10_000_000;
const H5 = 5, H21 = 21;
const TRIALS_REGISTERED = 4;
const EXTREME_1D = 0.50;
const COST_PCT = roundTripCostPct('liquid'); // 0.16 — large-scope study population
const TIERS = ['Breakout', 'Setup', 'Early'];

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const mean = (a) => a.length ? a.reduce((x, v) => x + v, 0) / a.length : null;

function loadSeries(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = (d.price || []).slice().reverse();
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

  const spyDates = spyRaw.map(b => b.date);
  const spyIdx = new Map(spyDates.map((d, i) => [d, i]));
  const decisions = [];
  for (let i = 262; i <= spyRaw.length - 1 - H21; i += STEP) decisions.push(spyDates[i]);
  console.log(`  decision sessions ${decisions.length} (${decisions[0]} → ${decisions[decisions.length - 1]}, step ${STEP})`);

  const tIdx = new Map();
  for (const [t, v] of dataset) tIdx.set(t, new Map(v.candles.map((b, i) => [b.date, i])));

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

  // ── Date-first replay: per-tier equal-weight portfolio series ──────────────
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
    const spy5 = spyFwd(D, H5), spy21 = spyFwd(D, H21);
    if (spy5 == null) { done++; continue; }

    // Statused, production-admitted rows only (parity with what the live board
    // ranks and what op=track ledgers under a tier).
    const byTier = { Breakout: [], Setup: [], Early: [] };
    for (const c of sel.cohort) {
      if (!c.status || !byTier[c.status]) continue;
      const f = c.filters || {};
      if (!(f.aboveSmas && f.rsVsSpy)) continue; // the live relaxed gate
      const r5 = fwd(c.ticker, D, H5);
      if (r5 == null) continue;
      const r21 = fwd(c.ticker, D, H21);
      byTier[c.status].push({
        t: c.ticker,
        x5: (r5 - spy5) * 100 - COST_PCT,
        x21: (r21 != null && spy21 != null) ? (r21 - spy21) * 100 - COST_PCT : null,
      });
    }
    const row = {
      date: D,
      regime: sel.regime ? (sel.regime.bearish ? 'risk-off' : sel.regime.riskOn ? 'risk-on' : 'neutral') : null,
    };
    for (const tier of TIERS) {
      const g = byTier[tier];
      row[`n_${tier}`] = g.length;
      row[`x5_${tier}`] = g.length ? mean(g.map(e => e.x5)) : null;
      const g21 = g.filter(e => e.x21 != null);
      row[`x21_${tier}`] = g21.length ? mean(g21.map(e => e.x21)) : null;
    }
    row.d5_EarlyMinusSetup = (row.x5_Early != null && row.x5_Setup != null) ? row.x5_Early - row.x5_Setup : null;
    row.d5_EarlyMinusBreakout = (row.x5_Early != null && row.x5_Breakout != null) ? row.x5_Early - row.x5_Breakout : null;
    perDate.push(row);
    done++;
    if (done % 25 === 0) console.log(`  …${done}/${decisions.length} sessions (${Math.round((Date.now() - t0) / 1000)}s)`);
  }

  // ── Inference ──────────────────────────────────────────────────────────────
  const series = (k, filter = null) => perDate
    .filter(d => !filter || filter(d))
    .map(d => d[k])
    .filter(v => v != null && Number.isFinite(v));
  function summarize(k, H, filter = null) {
    const s = series(k, filter);
    if (s.length < 8) return { n: s.length, insufficient: true };
    const lags = Math.ceil(H / STEP);
    const nw = STATS.neweyWest(s, { lags });
    const ess = STATS.effectiveSampleSize(s);
    const bb = STATS.movingBlockBootstrap(s, { seed: 20260809 });
    const nb = 4, bs = Math.floor(s.length / nb);
    const blocks = [];
    for (let b = 0; b < nb; b++) blocks.push(+((mean(s.slice(b * bs, b === nb - 1 ? s.length : (b + 1) * bs)) ?? 0)).toFixed(3));
    return {
      n: s.length, mean: +(mean(s)).toFixed(3),
      tHAC: nw.tstat != null ? +nw.tstat.toFixed(2) : null, lags,
      ess: ess.ess, bootCI90: bb.ci90 ? [+(bb.ci90[0]).toFixed(3), +(bb.ci90[1]).toFixed(3)] : null,
      blocks, positiveBlocks: blocks.filter(v => v > 0).length,
    };
  }

  const results = {};
  for (const tier of TIERS) {
    results[tier] = {
      countPerDate: +(mean(perDate.map(d => d[`n_${tier}`])) ?? 0).toFixed(2),
      datesWithNames: perDate.filter(d => d[`n_${tier}`] > 0).length,
      x5: summarize(`x5_${tier}`, H5),
      x21: summarize(`x21_${tier}`, H21),
      x5_byRegime: {
        'risk-on': summarize(`x5_${tier}`, H5, d => d.regime === 'risk-on'),
        neutral: summarize(`x5_${tier}`, H5, d => d.regime === 'neutral'),
        'risk-off': summarize(`x5_${tier}`, H5, d => d.regime === 'risk-off'),
      },
    };
  }
  const registered = {
    R1_early5d: summarize('x5_Early', H5),
    R2_earlyMinusSetup5d: summarize('d5_EarlyMinusSetup', H5),
    R3_earlyMinusBreakout5d: summarize('d5_EarlyMinusBreakout', H5),
    R4_early21d: summarize('x21_Early', H21),
  };
  // Registered PASS = mean > 0 AND |tHAC| ≥ 2 with the sign agreeing; the
  // 4-trial denominator means a lone marginal t≈2 is reported, not celebrated.
  const verdictOf = (r) => r.insufficient ? 'INSUFFICIENT' : (r.mean > 0 && r.tHAC != null && r.tHAC >= 2) ? 'PASS' : (r.mean > 0 ? 'POSITIVE_NOT_SIGNIFICANT' : 'NEGATIVE');
  const verdicts = Object.fromEntries(Object.entries(registered).map(([k, r]) => [k, verdictOf(r)]));

  const manifest = {
    studyVersion: STUDY_VERSION, generatedAt: new Date().toISOString(),
    trialsRegistered: TRIALS_REGISTERED, step: STEP, maxNames: MAX_NAMES,
    members: dataset.size, decisionSessions: perDate.length,
    window: perDate.length ? [perDate[0].date, perDate[perDate.length - 1].date] : null,
    costPctPerTrade: COST_PCT, extremeDropped,
    engineVersion: ENGINE.ENGINE_VERSION || null,
    survivorship: 'PARTIAL: cache includes delisted names whose bars end; NOT proven-safe — this study cannot promote, only inform a policy-cohort scoping',
    macro: 'no PIT macro overlay (macroRiskOff:false); SPY-200DMA/breadth regime replayed exactly',
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const perDateJson = JSON.stringify(perDate);
  fs.writeFileSync(path.join(OUT_DIR, 'per-date.json'), perDateJson);
  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify({ manifest: { ...manifest, perDateSha: sha(perDateJson) }, results, registered, verdicts }, null, 2));
  console.log('\n=== REGISTERED CONTRASTS ===');
  for (const [k, r] of Object.entries(registered)) console.log(k, verdicts[k], JSON.stringify(r));
  console.log('\n=== PER-TIER ===');
  for (const tier of TIERS) console.log(tier, JSON.stringify(results[tier]));
  console.log(`\nartifacts → ${OUT_DIR} (${Math.round((Date.now() - t0) / 1000)}s)`);
}

main().catch(e => { console.error(e); process.exit(1); });

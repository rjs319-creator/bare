'use strict';

// Improve the useful core discovered in experiments 79/80: rank an event-driven
// shortlist by stock-specific momentum. Eight fixed, interpretable variants are
// selected on 2022-2025 and read once on the later 2026 block. No weight fitting.

const fs = require('node:fs');
const path = require('node:path');
const K = require('./lib/experiment-kit');
const HF = require('../lib/research/hedge-fund-swing-formula');
const CHART = require('../lib/research/daily-chart-patterns');
const { pbo } = require('../lib/research/pbo');

const ID = 'residual-momentum-predictive-power-2026-08';
const VERSION = 'residual-momentum-predictive-v2';
const H = 21;
const TOP_K = 10;
const MIN_ADV = 10e6;
const MIN_GAP = 3;
const MAX_GAP = 20;

const VARIANTS = Object.freeze({
  baseline126x21: r => r.m126,
  residual252x21: r => r.m252,
  residual84x10: r => r.m84,
  horizonBlend: r => .50 * r.m126 + .30 * r.m252 + .20 * r.m84,
  persistent126: r => .80 * r.m126 + .20 * r.persistence,
  confirmed126: r => .80 * r.m126 + .20 * r.mediumTerm,
  gapConfirmed126: r => .85 * r.m126 + .15 * r.gapConfirmation,
  downsideAdjusted126: r => .85 * r.m126 + .15 * r.lowDownside,
});

function ranks(rows, rawKey, outputKey) {
  const ranked = HF.averageTieRanks(rows.map(r => r[rawKey]));
  rows.forEach((r, i) => { r[outputKey] = ranked[i] == null ? .5 : ranked[i]; });
}

function buildPanels() {
  const { dataset, spy, spyIdx, attrition } = K.loadUniverse({ minBars: 300, minAdv: 1e6, maxNames: 12000 });
  const byDate = new Map();
  let scannedNameDays = 0, detectedGaps = 0, earningsExcluded = 0, illiquid = 0;
  for (const [ticker, d] of dataset) {
    const earnings = new Set();
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(K.DATA_DIR, 'earnings', `${ticker}.json`), 'utf8'));
      for (const e of raw) if (e && e.date) earnings.add(e.date);
    } catch { /* no earnings calendar: retain the event and disclose coverage */ }
    const nearEarnings = date => {
      const ms = Date.parse(`${date}T00:00:00Z`);
      for (let k = -2; k <= 2; k++) if (earnings.has(new Date(ms + k * 86400000).toISOString().slice(0, 10))) return true;
      return false;
    };
    for (let i = 300; i < d.candles.length - H; i++) {
      scannedNameDays++;
      const cur = d.candles[i], prev = d.candles[i - 1];
      if (!(cur.open > 0) || !(prev.close > 0) || !spyIdx.has(cur.date)) continue;
      const gap = (cur.open / prev.close - 1) * 100;
      if (!(gap >= MIN_GAP && gap <= MAX_GAP)) continue;
      detectedGaps++;
      const adv = K.advOf(d.candles.slice(0, i + 1), 20);
      if (!(adv >= MIN_ADV)) { illiquid++; continue; }
      if (nearEarnings(cur.date)) { earningsExcluded++; continue; }
      if (!byDate.has(cur.date)) byDate.set(cur.date, []);
      byDate.get(cur.date).push({ ticker, gap, adv, index: i });
    }
  }
  const panels = [];
  let examined = 0, missing = 0, unobservable = 0, extreme = 0;
  for (const [date, events] of [...byDate].sort((a, b) => a[0].localeCompare(b[0]))) {
    const spyForward = K.benchmarkForward(spy, spyIdx, date, H);
    const spyI = spyIdx.get(date);
    if (spyForward == null || spyI == null || !spy[spyI + H]) continue;
    const rows = [];
    for (const e of events) {
      examined++;
      const d = dataset.get(e.ticker);
      if (!d) { missing++; continue; }
      const i = e.index;
      if (i == null || i < 300) { missing++; continue; }
      const beforeExtreme = { extremeMove: 0 };
      const forward = K.forwardFromNextOpen(d, date, H, beforeExtreme);
      if (forward == null) { if (beforeExtreme.extremeMove) extreme++; else unobservable++; continue; }
      const m126 = HF.betaResidualMomentumWindow(d.candles, spy, date, { lookback: 126, skip: 21 });
      const m252 = HF.betaResidualMomentumWindow(d.candles, spy, date, { lookback: 252, skip: 21 });
      const m84 = HF.betaResidualMomentumWindow(d.candles, spy, date, { lookback: 84, skip: 10 });
      if (!m126 || !m252 || !m84) { missing++; continue; }
      const path = HF.residualPathPersistence(d.candles, spy, date, m126.beta, { blocks: 5, blockSize: 21, skip: 21 });
      const downside = HF.downsideRisk(d.candles, spy, date, m126.beta);
      const entry = HF.entryFeatures(d.candles, date);
      const chart = CHART.dailyChartPatterns({ stock: d.candles, benchmark: spy, decisionDate: date });
      if (!path || !Number.isFinite(downside) || !entry || !chart) { missing++; continue; }
      const costs = K.costFractions(e.adv);
      // Confirmation does not claim the untradeable overnight gap: it only asks
      // whether the gap held into the decision close, information known at EOD.
      const bar = d.candles[i], prev = d.candles[i - 1];
      const gapCloseHold = prev && prev.close > 0 ? bar.close / prev.close - 1 : null;
      rows.push({
        ticker: e.ticker,
        gapPct: e.gap,
        m126Raw: m126.residualMomentum,
        m252Raw: m252.residualMomentum,
        m84Raw: m84.residualMomentum,
        persistenceRaw: path.consistency,
        mediumTermRaw: m84.residualMomentum,
        gapConfirmationRaw: gapCloseHold,
        downsideRaw: downside,
        netBase: forward - spyForward - costs.base,
        netDoubled: forward - spyForward - costs.doubled,
        chart,
      });
    }
    if (rows.length < TOP_K) continue;
    ranks(rows, 'm126Raw', 'm126');
    ranks(rows, 'm252Raw', 'm252');
    ranks(rows, 'm84Raw', 'm84');
    ranks(rows, 'persistenceRaw', 'persistence');
    ranks(rows, 'mediumTermRaw', 'mediumTerm');
    ranks(rows, 'gapConfirmationRaw', 'gapConfirmation');
    ranks(rows, 'downsideRaw', 'downsideRank');
    rows.forEach(r => { r.lowDownside = 1 - r.downsideRank; });
    panels.push({ date, labelEndDate: spy[spyI + H].date, rows });
  }
  return { panels, attrition: { universe: attrition, scannedNameDays, detectedGaps,
    earningsExcluded, examined, missing, illiquid, unobservable, extreme } };
}

function topReturn(panel, variant, outcome = 'netBase') {
  const fn = VARIANTS[variant];
  const top = panel.rows.slice().sort((a, b) => fn(b) - fn(a) || a.ticker.localeCompare(b.ticker)).slice(0, TOP_K);
  return top.length === TOP_K ? HF.mean(top.map(r => r[outcome])) * 100 : null;
}

function ic(panel, variant, outcome = 'netBase') {
  const fn = VARIANTS[variant], s = panel.rows.map(fn), y = panel.rows.map(r => r[outcome]);
  const rs = HF.averageTieRanks(s), ry = HF.averageTieRanks(y), ms = HF.mean(rs), my = HF.mean(ry);
  let n = 0, ds = 0, dy = 0;
  for (let i = 0; i < s.length; i++) { const a = rs[i] - ms, b = ry[i] - my; n += a * b; ds += a * a; dy += b * b; }
  return ds > 0 && dy > 0 ? n / Math.sqrt(ds * dy) : null;
}

function evaluate(panels, variant, outcome = 'netBase') {
  const values = panels.map(p => ({ date: p.date, value: topReturn(p, variant, outcome) })).filter(x => Number.isFinite(x.value));
  const summary = K.summarizeByDate(values, { horizonBars: H });
  const ics = panels.map(p => ic(p, variant, outcome)).filter(Number.isFinite);
  return { ...summary, rankIC: ics.length ? +HF.mean(ics).toFixed(5) : null, rankICDates: ics.length };
}

function lift(panels, challenger, control = 'baseline126x21', outcome = 'netBase') {
  return K.summarizeByDate(panels.map(p => ({ date: p.date,
    value: topReturn(p, challenger, outcome) - topReturn(p, control, outcome) })), { horizonBars: H });
}

function purgedTrain(development, testStart) {
  return development.filter(p => p.date < testStart && p.labelEndDate < testStart);
}

function selectVariant(train) {
  const candidates = Object.keys(VARIANTS).filter(v => v !== 'baseline126x21');
  const rows = candidates.map(v => ({ variant: v, result: evaluate(train, v), lift: lift(train, v) }));
  // Train objective rewards paired top-k improvement and cross-sectional breadth.
  rows.forEach(r => { r.utility = (r.lift.avg || 0) + 5 * (r.result.rankIC || 0); });
  rows.sort((a, b) => b.utility - a.utility || a.variant.localeCompare(b.variant));
  return { selected: rows[0], candidates: rows };
}

async function main() {
  const t0 = Date.now();
  const built = buildPanels(), panels = built.panels;
  const development = panels.filter(p => p.date >= '2022-01-01' && p.date <= '2025-12-31');
  const holdout = panels.filter(p => p.date >= '2026-01-01');
  const yearStarts = ['2023-01-01', '2024-01-01', '2025-01-01'];
  const yearEnds = ['2023-12-31', '2024-12-31', '2025-12-31'];
  const folds = [], oos = [], baseOos = [];
  for (let f = 0; f < yearStarts.length; f++) {
    const test = development.filter(p => p.date >= yearStarts[f] && p.date <= yearEnds[f]);
    const train = purgedTrain(development.filter(p => p.date < yearStarts[f]), yearStarts[f]);
    if (train.length < 20 || test.length < 10) continue;
    const selected = selectVariant(train);
    const r = evaluate(test, selected.selected.variant), l = lift(test, selected.selected.variant);
    folds.push({ fold: f + 1, trainRange: [train[0].date, train.at(-1).date], testRange: [test[0].date, test.at(-1).date],
      trainDates: train.length, testDates: test.length, selected: selected.selected.variant,
      training: selected.selected, test: r, testLift: l });
    for (const p of test) { oos.push({ date: p.date, value: topReturn(p, selected.selected.variant) }); baseOos.push({ date: p.date, value: topReturn(p, 'baseline126x21') }); }
  }
  const developmentSelection = selectVariant(purgedTrain(development, holdout[0].date));
  const locked = developmentSelection.selected.variant;
  const holdoutResult = evaluate(holdout, locked);
  const holdoutBaseline = evaluate(holdout, 'baseline126x21');
  const holdoutLift = lift(holdout, locked);
  const holdoutDoubled = evaluate(holdout, locked, 'netDoubled');
  const oosMap = new Map(oos.map(x => [x.date, x.value]));
  const walkForward = {
    optimized: K.summarizeByDate(oos, { horizonBars: H }),
    baseline: K.summarizeByDate(baseOos, { horizonBars: H }),
    lift: K.summarizeByDate(baseOos.map(x => ({ date: x.date, value: oosMap.get(x.date) - x.value })), { horizonBars: H }),
  };
  const names = Object.keys(VARIANTS);
  const pboMatrix = development.map(p => names.map(v => topReturn(p, v)));
  const pboResult = pbo(pboMatrix);
  const allVariantDevelopment = Object.fromEntries(names.map(v => [v, { result: evaluate(development, v), lift: lift(development, v) }]));
  const verdict = holdoutLift && holdoutLift.ci95.lo > 0 && holdoutLift.positiveBlocks >= 3
    ? 'PREDICTIVE_POWER_INCREASED_ON_LATER_BLOCK_DIAGNOSTIC_ONLY' : 'NO_CONFIRMED_PREDICTIVE_IMPROVEMENT';
  const result = {
    studyId: ID, version: VERSION,
    contract: { variants: names, horizonSessions: H, topK: TOP_K, minAdvUsd: MIN_ADV,
      eventUniverse: `all historically reconstructable non-earnings overnight gaps ${MIN_GAP}% to ${MAX_GAP}%, ADV ≥ $${MIN_ADV}; no future-breakout conditioning`,
      selection: 'best fixed variant on exact-label-end-purged prior dates; no weight fitting',
      development: '2022-2025 with calendar-year expanding folds', internalHoldout: 'all 2026 dates, read once after development selection',
      outcome: 'next-session-open to decision+21 close, app base/doubled costs, excess versus SPY' },
    data: { first: panels[0] && panels[0].date, last: panels.at(-1) && panels.at(-1).date, dates: panels.length,
      candidates: panels.reduce((s, p) => s + p.rows.length, 0), developmentDates: development.length, holdoutDates: holdout.length, attrition: built.attrition },
    folds, walkForward, allVariantDevelopment,
    lockedVariant: locked,
    lockedTraining: developmentSelection.selected,
    holdout: { optimized: holdoutResult, doubledCost: holdoutDoubled, baseline: holdoutBaseline, lift: holdoutLift },
    pbo: pboResult, verdict, promotable: false,
    limitations: ['Historical earnings-date files are current vendor snapshots; events lacking an earnings file cannot be screened for earnings adjacency.',
      '2026 is later than selection data but not untouched by the broader research program.',
      'The cache is survivorship-reduced, not survivorship-proven-safe.',
      'Overlapping 21-session outcomes reduce effective sample size; dependence-aware intervals are reported.',
      'Absolute averages are conditional event-cohort outcomes, not monthly portfolio returns.'],
    generatedAt: new Date().toISOString(), runtimeMs: Date.now() - t0,
  };
  const artifact = K.writeArtifact(path.join(K.DATA_DIR, 'residual-momentum-predictive-power'), 'result.json', result);
  K.recordExperiment({ id: ID, hypothesis: 'A fixed alternative construction of residual momentum improves top-10 cost-net excess and cross-sectional rank IC over 126→21 beta residual momentum on later gap-event dates.',
    family: 'swing-ranking', frozenConfig: result.contract, dataSnapshot: result.data, codeVersion: VERSION,
    testDates: { first: holdout[0] && holdout[0].date, last: holdout.at(-1) && holdout.at(-1).date, n: holdout.length },
    variationsAttempted: names.length, result: { lockedVariant: locked, walkForward, holdout: result.holdout, pbo: pboResult, verdict },
    correctedSignificance: 'exact-label-end purge; date-level paired lift; HAC/effective-N/21-session moving-block CI; CSCV PBO across eight fixed variants',
    costStress: { base: holdoutResult.avg, doubled: holdoutDoubled.avg }, decision: 'NOT PROMOTED — later internal diagnostic, not fresh prospective confirmation',
    reason: `${verdict}; prospective unseen events still required.`, artifact });
  console.log(JSON.stringify({ ...result, artifact: artifact.file }, null, 2));
  return result;
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { main, buildPanels, evaluate, lift, purgedTrain, selectVariant, VARIANTS };

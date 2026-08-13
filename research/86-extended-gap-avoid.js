'use strict';
// Frozen diagnostic: is "big gap in an already-extended uptrend" a real AVOID signal?
// Follow-up to research/83, which showed >=10% gaps with a passing trend template win
// 37% vs 49% — but never tested the CONTRAST directly. Here: within-date paired
// contrasts, an extension-driven alternative definition, a specificity control on the
// 5-10% tier, and the portfolio-level effect of actually wiring the filter.
//   node research/86-extended-gap-avoid.js
const fs = require('node:fs');
const path = require('node:path');
const K = require('./lib/experiment-kit');
const { minerviniTemplate } = require('../lib/research/trend-template-vcp');
const { roundTripCostPct } = require('../lib/costs');

const ID = 'extended-gap-avoid-2026-08';
const VERSION = 'extended-gap-avoid-v1';
const HOLD_BARS = 3, ORB_ATR_MULT = 2.5, COST_TIER = 'small';
const BIG_GAP = 10, MODERATE_GAP = 5;
const EXT_THRESHOLD = 20;              // prior close >20% above its SMA50 = extended

function costInR(atrPct) {
  const riskPct = ORB_ATR_MULT * atrPct;
  return riskPct > 0 ? roundTripCostPct(COST_TIER) / riskPct : null;
}

// Per-date paired contrast: mean(flagged) - mean(unflagged) on dates holding both.
function pairedContrast(events, flag) {
  const byDate = new Map();
  for (const e of events) {
    if (!Number.isFinite(e.netR)) continue;
    if (!byDate.has(e.date)) byDate.set(e.date, { yes: [], no: [] });
    byDate.get(e.date)[flag(e) ? 'yes' : 'no'].push(e.netR);
  }
  const rows = [];
  for (const [date, g] of byDate) {
    if (g.yes.length && g.no.length) rows.push({ date, value: K.mean(g.yes) - K.mean(g.no) });
  }
  const s = K.summarizeByDate(rows, { horizonBars: HOLD_BARS });
  if (!s) return null;
  const { perDateCounts, ...rest } = s;
  return { ...rest, pairedDates: rows.length };
}

function clusteredMean(events) {
  const byDate = new Map();
  for (const e of events) {
    if (!Number.isFinite(e.netR)) continue;
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e.netR);
  }
  const rows = [...byDate.entries()].map(([date, rs]) => ({ date, value: K.mean(rs) }));
  const s = K.summarizeByDate(rows, { horizonBars: HOLD_BARS });
  if (!s) return null;
  const { perDateCounts, ...rest } = s;
  return { ...rest, events: events.filter(e => Number.isFinite(e.netR)).length };
}

function main() {
  const t0 = Date.now();
  const raw = JSON.parse(fs.readFileSync(path.join(K.DATA_DIR, 'gap-events.json'), 'utf8'));

  const bySym = new Map();
  for (const e of raw) { if (!bySym.has(e.sym)) bySym.set(e.sym, []); bySym.get(e.sym).push(e); }
  for (const [sym, evs] of bySym) {
    const series = K.loadSeries(path.join(K.CACHE_DIR, `${sym}.json`));
    const idx = series ? new Map(series.map((b, i) => [b.date, i])) : null;
    for (const e of evs) {
      const i = idx ? idx.get(e.date) : null;
      const t = (i != null && i >= 1) ? minerviniTemplate(series, i - 1) : null;
      e.template = t ? t.pass : null;
      const c = costInR(e.atrPct);
      e.netR = c != null ? e.R - c : null;
      e.extended = Number.isFinite(e.ext) ? e.ext > EXT_THRESHOLD : null;
    }
  }
  const events = raw.filter(e => Number.isFinite(e.netR));
  const big = events.filter(e => e.gap >= BIG_GAP);
  const moderate = events.filter(e => e.gap >= MODERATE_GAP && e.gap < BIG_GAP);

  const contrasts = {
    // Primary: the two candidate avoid definitions, on big gaps.
    bigGapTemplateVsRest: pairedContrast(big.filter(e => e.template != null), e => e.template === true),
    bigGapExtendedVsRest: pairedContrast(big.filter(e => e.extended != null), e => e.extended === true),
    // Specificity control: the same contrasts should be ~0 on moderate gaps.
    moderateGapTemplateVsRest: pairedContrast(moderate.filter(e => e.template != null), e => e.template === true),
    moderateGapExtendedVsRest: pairedContrast(moderate.filter(e => e.extended != null), e => e.extended === true),
  };

  // Extension as a continuous signal among big gaps: pooled Spearman vs net R.
  const pooled = big.filter(e => Number.isFinite(e.ext));
  const pooledIC = K.rankIC(pooled.map(e => e.ext), pooled.map(e => e.netR));

  // Portfolio-level: does removing avoid-flagged events improve the >=5% tradable set?
  const avoidFlag = e => e.gap >= BIG_GAP && (e.template === true || e.extended === true);
  const tradable = events.filter(e => e.gap >= MODERATE_GAP);
  const kept = tradable.filter(e => !avoidFlag(e));
  const flagged = tradable.filter(avoidFlag);
  const portfolio = {
    unfiltered: clusteredMean(tradable),
    filtered: clusteredMean(kept),
    flaggedOnly: clusteredMean(flagged),
    filterImprovement: pairedContrast(tradable, e => !avoidFlag(e)),
    flaggedShareOfEvents: tradable.length ? +(flagged.length / tradable.length).toFixed(4) : null,
    winRates: {
      unfiltered: tradable.length ? +(tradable.filter(e => e.win).length / tradable.length).toFixed(3) : null,
      flaggedOnly: flagged.length ? +(flagged.filter(e => e.win).length / flagged.length).toFixed(3) : null,
    },
  };

  const attempted = Object.entries(contrasts).filter(([, v]) => v)
    .map(([id, v]) => ({ id, p: K.pValue(v) }));
  const corrected = K.fdr(attempted);
  const significantHarm = new Set(
    (corrected || []).filter(f => f && f.survives).map(f => f.id)
      .filter(id => id.startsWith('bigGap') && contrasts[id] && contrasts[id].ci95.hi < 0));

  const byYear = {};
  for (const e of big.filter(avoidFlag)) {
    byYear[e.year] = byYear[e.year] || { n: 0, sumR: 0, wins: 0 };
    byYear[e.year].n++; byYear[e.year].sumR += e.netR; byYear[e.year].wins += e.win ? 1 : 0;
  }
  for (const y of Object.keys(byYear)) {
    byYear[y] = { n: byYear[y].n, avgNetR: +(byYear[y].sumR / byYear[y].n).toFixed(3), winRate: +(byYear[y].wins / byYear[y].n).toFixed(3) };
  }

  const verdict = significantHarm.size
    ? 'AVOID_SIGNAL_CONFIRMED'
    : (contrasts.bigGapTemplateVsRest && contrasts.bigGapTemplateVsRest.ci95.hi < 0)
      || (contrasts.bigGapExtendedVsRest && contrasts.bigGapExtendedVsRest.ci95.hi < 0)
      ? 'AVOID_SIGNAL_UNCORRECTED_ONLY' : 'AVOID_SIGNAL_NOT_CONFIRMED';

  const artifact = {
    studyId: ID, version: VERSION, kit: K.KIT_VERSION,
    frozenConfig: {
      bigGapPct: BIG_GAP, moderateGapPct: MODERATE_GAP, extThresholdPct: EXT_THRESHOLD,
      avoidDefinition: `gap >= ${BIG_GAP}% AND (strict trend template passes OR prior close > ${EXT_THRESHOLD}% above SMA50)`,
      outcomes: '36-gap-events ORB proxy, small-tier round-trip cost charged in R',
      inference: 'within-date paired contrasts, date-clustered evidence-stats-v1, FDR across the 4 contrasts',
    },
    dataSnapshot: { events: events.length, bigGapEvents: big.length, moderateGapEvents: moderate.length },
    contrasts, pooledExtRankICBigGaps: pooledIC, portfolio, avoidFlaggedByYear: byYear,
    fdr: corrected, significantAfterFdr: [...significantHarm], verdict,
    survivorshipProvenSafe: false,
    limitations: [
      'Survivorship-reduced cache; daily-bar ORB proxy, not intraday fills.',
      'Two frozen avoid definitions tested; no threshold sweep was run.',
      'Within-date pairing keeps only dates holding both classes — the usable date count is reported.',
    ],
    runtimeMs: Date.now() - t0, generatedAt: new Date().toISOString(),
  };
  const written = K.writeArtifact(path.join(K.DATA_DIR, 'extended-gap-avoid'), 'result.json', artifact);
  K.recordExperiment({
    id: ID,
    hypothesis: 'Large gap-ups (>= 10%) occurring in already-extended uptrends carry NEGATIVE expectancy relative to other large gap-ups, and excluding them improves the tradable >= 5% gap cohort.',
    family: 'gap-continuation',
    frozenConfig: artifact.frozenConfig,
    dataSnapshot: artifact.dataSnapshot,
    codeVersion: VERSION,
    variationsAttempted: attempted.length,
    result: { verdict, contrasts, pooledExtRankICBigGaps: pooledIC,
      portfolio: { filterImprovement: portfolio.filterImprovement, flaggedShareOfEvents: portfolio.flaggedShareOfEvents, winRates: portfolio.winRates } },
  });
  console.log(JSON.stringify({ verdict, significantAfterFdr: [...significantHarm], artifact: written.file }, null, 2));
  return artifact;
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e); process.exit(1); }
}
module.exports = { main, ID, VERSION };

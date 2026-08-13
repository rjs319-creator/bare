'use strict';
// Frozen diagnostic: does the "episodic pivot" spec (gap >= 10% with volume >= 1.5x
// the 20-day average) or a strict Minervini-style trend template improve the measured
// gap-and-go edge? Slices the committed 19,326-event set (research/36-gap-events.js:
// liquid, non-earnings, ORB-proxy trades in R units) by gap tier x relative volume x
// point-in-time template pass, with date-clustered inference and cost-in-R stress.
//   node research/83-episodic-pivot-trend-template.js
const fs = require('node:fs');
const path = require('node:path');
const K = require('./lib/experiment-kit');
const { minerviniTemplate } = require('../lib/research/trend-template-vcp');
const { roundTripCostPct } = require('../lib/costs');

const ID = 'episodic-pivot-trend-template-2026-08';
const VERSION = 'episodic-pivot-v1';
const HOLD_BARS = 3;                    // the event set's maximum holding period
const ORB_ATR_MULT = 2.5;               // risk per trade in the event set, in ATR units
const RV_CONFIRM = 1.5;
const GAP_TIERS = [[3, 5, '3-5%'], [5, 10, '5-10%'], [10, Infinity, '>=10%']];
// The event set enforces ADV >= $10M but does not store per-event ADV, so every event
// is charged the SMALL-cap tier — the most expensive tier its floor permits.
const COST_TIER = 'small';

function costInR(atrPct) {
  const riskPct = ORB_ATR_MULT * atrPct;  // risk per share as % of price
  return riskPct > 0 ? roundTripCostPct(COST_TIER) / riskPct : null;
}

function clusteredCell(events, pickR) {
  const byDate = new Map();
  for (const e of events) {
    const r = pickR(e);
    if (!Number.isFinite(r)) continue;
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(r);
  }
  const rows = [...byDate.entries()].map(([date, rs]) => ({ date, value: K.mean(rs) }));
  const s = K.summarizeByDate(rows, { horizonBars: HOLD_BARS });
  if (!s) return null;
  const { perDateCounts, ...rest } = s;
  return { ...rest, events: events.length };
}

function main() {
  const t0 = Date.now();
  const events = JSON.parse(fs.readFileSync(path.join(K.DATA_DIR, 'gap-events.json'), 'utf8'));

  // Point-in-time template as of the session BEFORE each gap (only prior data can
  // gate a decision taken at the gap open).
  const bySym = new Map();
  for (const e of events) { if (!bySym.has(e.sym)) bySym.set(e.sym, []); bySym.get(e.sym).push(e); }
  const attrition = { symbols: bySym.size, noSeries: 0, noPriorBar: 0, shortHistory: 0, templated: 0 };
  for (const [sym, evs] of bySym) {
    const series = K.loadSeries(path.join(K.CACHE_DIR, `${sym}.json`));
    if (!series) { attrition.noSeries += evs.length; evs.forEach(e => { e.template = null; }); continue; }
    const idx = new Map(series.map((b, i) => [b.date, i]));
    for (const e of evs) {
      const i = idx.get(e.date);
      if (i == null || i < 1) { attrition.noPriorBar++; e.template = null; continue; }
      const t = minerviniTemplate(series, i - 1);
      if (!t) { attrition.shortHistory++; e.template = null; continue; }
      attrition.templated++;
      e.template = t.pass;
    }
  }

  const withNet = events.map(e => {
    const c = costInR(e.atrPct);
    return { ...e, netR: c != null ? e.R - c : null };
  });

  const cells = {};
  for (const [lo, hi, tierLabel] of GAP_TIERS) {
    const tier = withNet.filter(e => e.gap >= lo && e.gap < hi);
    for (const [rvLabel, rvFilter] of [
      ['allRv', () => true],
      ['rvBelow1.5', e => Number.isFinite(e.rv) && e.rv < RV_CONFIRM],
      ['rvAtLeast1.5', e => Number.isFinite(e.rv) && e.rv >= RV_CONFIRM],
    ]) {
      for (const [tmplLabel, tmplFilter] of [
        ['allTemplate', () => true],
        ['templatePass', e => e.template === true],
        ['templateFail', e => e.template === false],
      ]) {
        const sub = tier.filter(e => rvFilter(e) && tmplFilter(e));
        const key = `${tierLabel}|${rvLabel}|${tmplLabel}`;
        cells[key] = {
          grossR: clusteredCell(sub, e => e.R),
          netR: clusteredCell(sub, e => e.netR),
          winRate: sub.length ? +(sub.filter(e => e.win).length / sub.length).toFixed(3) : null,
        };
      }
    }
  }

  // The two headline contrasts, FDR-adjusted across everything attempted here.
  const attempted = Object.entries(cells)
    .filter(([, v]) => v.netR)
    .map(([key, v]) => ({ id: key, p: K.pValue(v.netR) }));
  const corrected = K.fdr(attempted);

  const spec = cells['>=10%|rvAtLeast1.5|allTemplate'];
  const baseline = cells['5-10%|allRv|allTemplate'];
  const specBeatsBaseline = !!(spec && spec.netR && baseline && baseline.netR
    && spec.netR.ci95.lo > baseline.netR.ci95.hi);
  const verdict = spec && spec.netR && spec.netR.ci95.lo > 0
    ? (specBeatsBaseline ? 'SPEC_IMPROVES_EDGE' : 'SPEC_POSITIVE_BUT_NOT_BETTER')
    : 'SPEC_NOT_CONFIRMED';

  const artifact = {
    studyId: ID, version: VERSION, kit: K.KIT_VERSION,
    frozenConfig: {
      eventSet: 'research/data/gap-events.json (research/36-gap-events.js: >=3% gap, ADV>=$10M, non-earnings, ORB-proxy 2R target, 3-bar hold)',
      gapTiers: GAP_TIERS.map(t => t[2]), rvConfirm: RV_CONFIRM,
      template: 'minervini-strict-v1 as of the PRIOR session close (lib/research/trend-template-vcp.js)',
      costs: `round-trip ${COST_TIER}-tier charged in R against ${ORB_ATR_MULT}xATR risk`,
      inference: 'per-date mean R, date-clustered evidence-stats-v1, FDR across all cells',
    },
    dataSnapshot: { events: events.length, first: events[0] && events[0].date, last: events[events.length - 1] && events[events.length - 1].date },
    templateAttrition: attrition,
    variationsAttempted: attempted.length,
    cells, fdr: corrected, verdict,
    survivorshipProvenSafe: false,
    limitations: [
      'Survivorship-reduced cache: delisted names end mid-series; freshness cannot fully repair the event set.',
      'Outcomes are the 36-gap-events ORB proxy on daily bars, not intraday fills.',
      'Opening (first-30-minute) volume is unobservable on daily bars; full-day rv is the closest measurable proxy for the 1.5x confirmation.',
    ],
    runtimeMs: Date.now() - t0, generatedAt: new Date().toISOString(),
  };
  const written = K.writeArtifact(path.join(K.DATA_DIR, 'episodic-pivot-trend-template'), 'result.json', artifact);
  K.recordExperiment({
    id: ID,
    hypothesis: 'A stricter episodic-pivot spec (gap >= 10%, volume >= 1.5x average) and/or a strict trend template improves the cost-net R of the measured gap-and-go edge over the validated >= 5% tier.',
    family: 'gap-continuation',
    frozenConfig: artifact.frozenConfig,
    dataSnapshot: artifact.dataSnapshot,
    codeVersion: VERSION,
    variationsAttempted: attempted.length,
    result: {
      verdict,
      spec: spec && spec.netR, baseline: baseline && baseline.netR,
      headlineCells: Object.fromEntries(Object.entries(cells)
        .filter(([k]) => k.includes('allTemplate') || k.includes('templatePass'))
        .map(([k, v]) => [k, v.netR && { avg: v.netR.avg, lo: v.netR.ci95.lo, hi: v.netR.ci95.hi, events: v.netR.events, winRate: v.winRate }])),
    },
  });
  console.log(JSON.stringify({ verdict, artifact: written.file, runtimeMs: artifact.runtimeMs }, null, 2));
  return artifact;
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e); process.exit(1); }
}
module.exports = { main, ID, VERSION };

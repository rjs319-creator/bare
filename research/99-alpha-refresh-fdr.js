'use strict';
// Step 99 — ALPHA REFRESH: re-read the live Scoreboard evidence with one FDR family.
//   node research/99-alpha-refresh-fdr.js [path/to/scoreboard.json] [path/to/today.json]
//   (no args → fetches the persisted op=scoreboard / op=today from production, read-only)
//
// Repeats the 2026-09-09 alpha-swarm pass (docs/alpha/ALPHA-SWARM-2026-09-09.md) on the
// CURRENT ledger so the verdict can be re-earned, never remembered:
//   • every section:tier:scope lane × 7 horizons, plus its regime / liquidity / sector
//     sub-cells, is one cell; a cell needs ≥ MIN_DATES decision dates;
//   • p-values come from lib/evidence-stats.pValueOf (HAC SE, Student-t at the effective
//     sample size) — the SAME statistic the maturity gates use;
//   • Benjamini-Hochberg across ALL cells at q ≤ FDR_Q; survivors are split by sign;
//   • lib/negative-lanes is re-run on the payload and diffed against what the payload
//     ships, and op=today's rows are checked against those lanes.
// Diagnostic only: writes an artifact under research/data/evidence/alpha-refresh/, never
// touches the registry, never changes a rank. A clean "zero positives" is a valid result.
const fs = require('node:fs');
const path = require('node:path');
const ES = require('../lib/evidence-stats');
const NL = require('../lib/negative-lanes');
const SC = require('../lib/strategy-contracts');

const PROD = 'https://market-news-app-chi.vercel.app/api/tracker';
const MIN_DATES = 8;          // same floor the 09-09 pass used
const FDR_Q = 0.10;
const HORIZONS = NL.HORIZON_ORDER;
const DATA = process.env.RESEARCH_DATA_DIR || path.join(__dirname, 'data');
const OUT_DIR = path.join(DATA, 'evidence', 'alpha-refresh');

const r2 = (x) => (Number.isFinite(x) ? +x.toFixed(2) : null);
const lane = (g) => NL.laneKey(g.section, g.tier, g.scope);

async function load(file, op) {
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const res = await fetch(`${PROD}?op=${op}`, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`op=${op} → HTTP ${res.status}`);
  return res.json();
}

// One cell per (lane, split, horizon) that carries a usable date-level series.
function collectCells(groups) {
  const cells = [];
  const push = (g, split, h, block) => {
    const d = block && block.dateNet;
    if (!d || !Number.isFinite(d.n) || d.n < MIN_DATES) return;
    const p = ES.pValueOf(d);
    if (!Number.isFinite(p)) return;
    cells.push({
      id: `${lane(g)}|${split}|${h}`, lane: lane(g), section: g.section, tier: g.tier, scope: g.scope || '',
      split, horizon: h, p, avg: d.avgExact ?? d.avg, ci95: d.ci95, n: d.n, effectiveN: d.effectiveN,
      positiveBlocks: d.positiveBlocks, blockMeans: d.blockStability && d.blockStability.means,
      avgNetExcess: block.avgNetExcess, avgNetSecExcess: block.avgNetSecExcess ?? null, picks: block.netExcessN ?? block.n,
    });
  };
  for (const g of groups) {
    if (!g || !g.section || !g.horizons) continue;
    for (const h of HORIZONS) push(g, 'all', h, g.horizons[h]);
    for (const [name, table] of [['regime', g.byRegime], ['liquidity', g.byLiquidity], ['sector', g.bySector]]) {
      if (!table) continue;
      for (const k of Object.keys(table)) for (const h of HORIZONS) push(g, `${name}:${k}`, h, table[k] && table[k][h]);
    }
  }
  return cells;
}

function fdrPass(cells) {
  const adj = new Map(ES.fdrAdjust(cells.map(c => ({ id: c.id, p: c.p })), { alpha: FDR_Q }).map(r => [r.id, r]));
  const rows = cells.map(c => ({ ...c, q: adj.get(c.id) ? adj.get(c.id).q : null, survives: !!(adj.get(c.id) && adj.get(c.id).survives) }));
  const survivors = rows.filter(r => r.survives).sort((a, b) => a.q - b.q);
  return {
    tested: rows.length, nominal: rows.filter(r => r.p < 0.05).length,
    survivors, positive: survivors.filter(r => r.avg > 0), negative: survivors.filter(r => r.avg < 0), rows,
  };
}

// Lane-level read at each lane's OWN contract horizon (never the best of 7).
function contractReads(groups, rows) {
  const byId = new Map(rows.map(r => [r.id, r]));
  return groups.filter(g => g && g.section && g.horizons).map(g => {
    const { metric, basis } = SC.metricFor(SC.SECTION_TO_ID[g.section], '5d');
    const c = byId.get(`${lane(g)}|all|${metric}`) || null;
    const d = g.horizons[metric] && g.horizons[metric].dateNet;
    const dates = d && Array.isArray(d.dates) ? d.dates.slice().sort() : [];
    const last = dates[dates.length - 1] || null;
    const recent = (days) => (last ? dates.filter(x => (Date.parse(last) - Date.parse(x)) / 864e5 < days).length : 0);
    const perWeek = recent(28) / 4;
    const needDates = Math.max(0, 20 - dates.length);   // MIN_VALIDATED_DATES in lib/maturity
    // ETA counted from TODAY at the trailing 4-week accrual rate. Resolved dates lag decision
    // dates by the horizon, so a lane keeps accruing after its last resolved date.
    const eta = needDates === 0 ? 'reached'
      : perWeek > 0 ? new Date(Date.now() + (needDates / perWeek) * 7 * 864e5).toISOString().slice(0, 10) : null;
    return {
      lane: lane(g), metric, basis, picks: g.picks, dates: dates.length, firstDate: dates[0] || null, lastDate: last,
      datesLast14d: recent(14), datesPerWeek: r2(perWeek), datesTo20: needDates, etaTo20Dates: eta,
      avg: c ? r2(c.avg) : null, ci95: c ? c.ci95 : null, effectiveN: c ? c.effectiveN : null, positiveBlocks: c ? c.positiveBlocks : null,
      p: c ? +c.p.toFixed(4) : null, q: c && c.q != null ? +c.q.toFixed(3) : null,
      ciClearPositive: !!(c && c.ci95 && c.ci95.lo > 0), ciClearNegative: !!(c && c.ci95 && c.ci95.hi < 0),
    };
  }).sort((a, b) => (b.dates - a.dates));
}

function regimeReads(rows) {
  const byLaneH = new Map();
  for (const r of rows) {
    if (!r.split.startsWith('regime:')) continue;
    const k = `${r.lane}|${r.horizon}`;
    const e = byLaneH.get(k) || { lane: r.lane, horizon: r.horizon };
    e[r.split.slice(7)] = { avg: r2(r.avg), ci95: r.ci95, n: r.n, q: r.q != null ? +r.q.toFixed(3) : null, survives: r.survives };
    byLaneH.set(k, e);
  }
  return [...byLaneH.values()].filter(e => e['risk-on'] && e['risk-off'] && e['risk-on'].n >= MIN_DATES && e['risk-off'].n >= MIN_DATES);
}

function todayCheck(today, negLanes) {
  const rows = [];
  for (const table of ['actionableByHorizon', 'qualifiedLeadsByHorizon', 'researchByHorizon', 'topByHorizon']) {
    const t = today && today[table];
    if (!t) continue;
    for (const h of Object.keys(t)) for (const r of (t[h] || [])) rows.push({ table, h, r });
  }
  const neg = new Set((negLanes || []).map(l => l.key));
  const hits = rows.filter(({ r }) => neg.has(NL.laneKey(r.section, r.tier, r.universeScope || r.scope)))
    .map(({ table, h, r }) => ({ table, horizon: h, ticker: r.ticker, lane: NL.laneKey(r.section, r.tier, r.universeScope || r.scope), actionable: r.actionable, expectancyTilt: r.expectancyTilt, expectancyTiltNegative: r.expectancyTiltNegative, retainedLabel: r.retainedLabel || null, rank: r.rank }));
  return { rows: rows.length, negativeLaneRows: hits, actionable: rows.filter(({ r }) => r.actionable).length };
}

async function main() {
  const [sbFile, todayFile] = process.argv.slice(2);
  const sb = await load(sbFile, 'scoreboard');
  const today = await load(todayFile, 'today');
  const groups = sb.groups || [];
  const cells = collectCells(groups);
  const fdr = fdrPass(cells);
  const contract = contractReads(groups, fdr.rows);
  const regimes = regimeReads(fdr.rows);

  const recomputed = NL.negativeLanes({ groups });
  const shipped = sb.negativeLanes || [];
  const laneDiff = {
    shipped: shipped.map(l => l.key), recomputed: recomputed.map(l => l.key),
    onlyShipped: shipped.map(l => l.key).filter(k => !recomputed.some(r => r.key === k)),
    onlyRecomputed: recomputed.map(l => l.key).filter(k => !shipped.some(s => s.key === k)),
  };
  const todayRead = todayCheck(today, shipped);

  const fmt = (r) => `${r.id}  avg ${r2(r.avg)}% CI [${r.ci95.lo}, ${r.ci95.hi}] dates ${r.n} (eff ${r.effectiveN}) blocks+ ${r.positiveBlocks} p ${r.p.toFixed(4)} q ${r.q.toFixed(3)}`;
  const out = {
    generatedAt: new Date().toISOString(), scoreboardAt: sb.generatedAt, evidenceKeyVersion: sb.evidenceKeyVersion,
    totalPicks: sb.totalPicks, loggedRows: sb.loggedRows, groups: groups.length,
    family: { minDates: MIN_DATES, q: FDR_Q, tested: fdr.tested, nominalP05: fdr.nominal, survivors: fdr.survivors.length, positive: fdr.positive.length, negative: fdr.negative.length },
    positiveSurvivors: fdr.positive.map(r => ({ ...r, blockMeans: undefined })),
    negativeSurvivors: fdr.negative.map(r => ({ ...r, blockMeans: undefined })),
    nearMisses: fdr.rows.filter(r => !r.survives && r.avg > 0 && r.p < 0.05).sort((a, b) => a.p - b.p).slice(0, 15).map(r => ({ id: r.id, avg: r2(r.avg), ci95: r.ci95, n: r.n, effectiveN: r.effectiveN, positiveBlocks: r.positiveBlocks, p: +r.p.toFixed(4), q: +r.q.toFixed(3) })),
    contractReads: contract, regimeReads: regimes, negativeLanes: laneDiff, today: todayRead,
    prior: { date: '2026-09-09', tested: 1512, survivors: 25, positive: 0, negative: 25, negativeLanes: ['screener:Breakout:large', 'screener:Early:small'] },
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `${out.generatedAt.slice(0, 10)}.json`);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));

  console.log(`Scoreboard ${sb.generatedAt} · ${sb.totalPicks} picks / ${sb.loggedRows} rows / ${groups.length} lanes`);
  console.log(`FDR family: ${fdr.tested} cells (≥${MIN_DATES} dates), ${fdr.nominal} nominal p<0.05, ${fdr.survivors.length} survive BH q≤${FDR_Q}: ${fdr.positive.length} positive / ${fdr.negative.length} negative`);
  console.log(`\nPOSITIVE survivors (${fdr.positive.length}):`); fdr.positive.forEach(r => console.log('  ' + fmt(r)));
  console.log(`\nNEGATIVE survivors (${fdr.negative.length}):`); fdr.negative.forEach(r => console.log('  ' + fmt(r)));
  console.log(`\nNearest positive misses (nominal p<0.05, failed FDR):`); out.nearMisses.forEach(r => console.log(`  ${r.id}  avg ${r.avg}% CI [${r.ci95.lo}, ${r.ci95.hi}] dates ${r.n} (eff ${r.effectiveN}) blocks+ ${r.positiveBlocks} p ${r.p} q ${r.q}`));
  console.log(`\nnegativeLanes shipped ${JSON.stringify(laneDiff.shipped)} recomputed ${JSON.stringify(laneDiff.recomputed)} onlyShipped ${JSON.stringify(laneDiff.onlyShipped)} onlyRecomputed ${JSON.stringify(laneDiff.onlyRecomputed)}`);
  console.log(`op=today: ${todayRead.rows} rows, ${todayRead.actionable} actionable, ${todayRead.negativeLaneRows.length} rows from evidence-negative lanes`);
  todayRead.negativeLaneRows.forEach(r => console.log('  ' + JSON.stringify(r)));
  console.log(`\nContract-horizon reads (top by dates):`);
  contract.slice(0, 40).forEach(c => console.log(`  ${c.lane.padEnd(34)} ${c.metric.padEnd(3)} dates ${String(c.dates).padStart(3)} (+${c.datesLast14d} in 14d, ${c.datesPerWeek}/wk, 20 by ${c.etaTo20Dates}) avg ${c.avg} CI ${c.ci95 ? `[${c.ci95.lo}, ${c.ci95.hi}]` : '—'} q ${c.q}`));
  console.log(`\nRegime split (both regimes ≥${MIN_DATES} dates): ${regimes.length}`);
  regimes.forEach(e => console.log(`  ${e.lane} ${e.horizon}: on ${e['risk-on'].avg}% [${e['risk-on'].ci95.lo}, ${e['risk-on'].ci95.hi}] n${e['risk-on'].n} q${e['risk-on'].q} | off ${e['risk-off'].avg}% [${e['risk-off'].ci95.lo}, ${e['risk-off'].ci95.hi}] n${e['risk-off'].n} q${e['risk-off'].q}`));
  console.log(`\nartifact → ${outFile}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { collectCells, fdrPass, contractReads, regimeReads, todayCheck, MIN_DATES, FDR_Q };

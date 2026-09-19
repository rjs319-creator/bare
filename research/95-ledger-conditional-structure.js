'use strict';
// ALPHA-INTERNAL 2026-09-19 — preregistered conditional-structure pass over the app's OWN
// Scoreboard ledger (docs/alpha/ALPHA-INTERNAL-2026-09-19.md). Read-only: consumes the public
// persisted `op=scoreboard` payload (date-level cost-net excess series per section:tier:scope
// group) and never touches a privileged op or a live ranking.
//
// Families, fixed BEFORE any number was computed (one BH correction per family):
//   A  inverse economics — each group's date series flipped to a SHORT book, charged the
//      round trip twice-over (the long leg's cost is embedded in the net series, the short
//      leg pays its own) plus the tier borrow prior from lib/costs; sensitivity at a
//      conservative hard-to-borrow prior.
//   C1 day-of-week of entry — lane-demeaned, pooled to one observation per calendar date.
//   C2 lane persistence — pooled OLS of a lane's date value on its prior-10-date mean / hit
//      rate, date-clustered SE.
// Feature splits (gap/ATR/score/dollar-volume) and daytrade exit structure need per-pick rows
// that no public read op exposes; they are recorded as infeasible in the doc, not as nulls.
//
//   node research/95-ledger-conditional-structure.js --file scoreboard.json [--out dir]
//   node research/95-ledger-conditional-structure.js            (fetches prod op=scoreboard)

const fs = require('fs');
const path = require('path');
const { contractForSection } = require('../lib/strategy-contracts');
const COSTS = require('../lib/costs');
const ES = require('../lib/evidence-stats');
const { benjaminiHochberg } = require('../lib/research/hypothesis-registry');

const PROD = 'https://market-news-app-chi.vercel.app/api/tracker?op=scoreboard';
const MIN_DATES_A = 15;
const MIN_DATES_C2 = 25;
const LOOKBACK_C2 = 10;
const PERMUTATIONS = 400;
const FDR_Q = 0.10;
// Conservative hard-to-borrow sensitivity (annual bps). Stated in the preregistration.
const CONSERVATIVE_BORROW_APR_BPS = { liquid: 50, small: 600, micro: 2500, biotech: 1500 };
const HORIZON_SESSIONS = { '1d': 1, '3d': 3, '5d': 5, '10d': 10, '20d': 20, '1m': 21, '3m': 63 };
const CALENDAR_PER_SESSION = 365 / 252;

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

async function loadScoreboard() {
  const file = arg('file', null);
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const res = await fetch(PROD);
  if (!res.ok) throw new Error(`op=scoreboard http ${res.status}`);
  return res.json();
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const round = (x, d = 2) => (Number.isFinite(x) ? +x.toFixed(d) : null);

function tierOf(group) {
  const scope = group.scope ? String(group.scope).toLowerCase() : null;
  if (scope === 'large' || scope === 'expanded') return 'liquid';
  if (scope === 'small' || scope === 'micro') return scope;
  if (group.section === 'Biotech') return 'biotech';
  return COSTS.SECTION_TIER_DEFAULT[group.section] || 'small';
}

function contractMetric(group) {
  const c = contractForSection(group.section);
  return { metric: (c && c.metric) || '5d', side: (c && c.side) || 'long', fromContract: !!c };
}

// One date series per group at its contract horizon: [{date, value}] sorted by date.
function laneSeries(group) {
  const { metric, side, fromContract } = contractMetric(group);
  const h = group.horizons && group.horizons[metric];
  const dn = h && h.dateNet;
  if (!dn || !Array.isArray(dn.values) || !Array.isArray(dn.dates)) return null;
  const pts = dn.dates.map((d, i) => ({ date: d, value: dn.values[i] }))
    .filter((p) => Number.isFinite(p.value) && /^\d{4}-\d{2}-\d{2}$/.test(p.date))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return { key: `${group.section}:${group.tier}:${group.scope || ''}`, section: group.section, tier: group.tier,
    scope: group.scope || null, metric, side, fromContract, tierCost: tierOf(group), pts };
}

// ── A. inverse economics ────────────────────────────────────────────────────────────────
function borrowPct(aprBps, sessions) {
  return (aprBps / 100) * (sessions * CALENDAR_PER_SESSION) / 365;
}

function inverseEconomics(lanes) {
  const rows = [];
  for (const lane of lanes) {
    if (lane.pts.length < MIN_DATES_A) continue;
    const sessions = HORIZON_SESSIONS[lane.metric] || 5;
    const rt = COSTS.roundTripCostPct(lane.tierCost);
    const borrowPrior = COSTS.borrowCost(lane.tierCost, sessions, 'short').pct;
    const borrowCons = borrowPct(CONSERVATIVE_BORROW_APR_BPS[lane.tierCost] || 600, sessions);
    // net_t is the LONG cost-net series: gross_t ≈ net_t + rt. Short book: −gross − rt − borrow.
    const shortPrior = lane.pts.map((p) => -(p.value + rt) - rt - borrowPrior);
    const shortCons = lane.pts.map((p) => -(p.value + rt) - rt - borrowCons);
    const sPrior = ES.summarizeDateSeries(shortPrior, { horizonBars: sessions });
    const sCons = ES.summarizeDateSeries(shortCons, { horizonBars: sessions });
    if (!sPrior) continue;
    rows.push({
      id: lane.key, section: lane.section, tier: lane.tier, scope: lane.scope, metric: lane.metric,
      contractSide: lane.side, tierCost: lane.tierCost, dates: lane.pts.length,
      longNetAvg: round(mean(lane.pts.map((p) => p.value))),
      roundTripPct: rt, borrowPriorPct: round(borrowPrior, 3), borrowConservativePct: round(borrowCons, 3),
      shortNetAvg: sPrior.avg, ci95: sPrior.ci95, effectiveN: sPrior.effectiveN,
      t: round(sPrior.avgExact / sPrior.seExact), p: ES.pValueOf(sPrior),
      positiveBlocks: sPrior.positiveBlocks, blocks: sPrior.blockStability.blocks,
      conservative: { shortNetAvg: sCons.avg, ci95: sCons.ci95, t: round(sCons.avgExact / sCons.seExact) },
      note: lane.side === 'short' ? 'contract is already short — this cell is the LONG inverse of a fade' : null,
    });
  }
  const bh = benjaminiHochberg(rows.map((r) => ({ id: r.id, p: r.p })));
  const qById = new Map(bh.map((b) => [b.id, b.q]));
  for (const r of rows) {
    r.q = round(qById.get(r.id), 4);
    r.survivesFdr = Number.isFinite(r.q) && r.q <= FDR_Q;
    r.promotable = r.survivesFdr && r.shortNetAvg > 0 && r.dates >= 20 && r.positiveBlocks >= 3
      && r.conservative.ci95.lo > 0 && r.contractSide !== 'short';
  }
  rows.sort((a, b) => (a.p ?? 1) - (b.p ?? 1));
  return rows;
}

// ── C1. day-of-week ─────────────────────────────────────────────────────────────────────
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function weekdayOf(date) { return WEEKDAY[new Date(`${date}T12:00:00Z`).getUTCDay()]; }

function dayOfWeek(lanes) {
  const byDate = new Map();
  for (const lane of lanes) {
    if (lane.pts.length < MIN_DATES_A) continue;
    const m = mean(lane.pts.map((p) => p.value));
    for (const p of lane.pts) {
      if (!byDate.has(p.date)) byDate.set(p.date, []);
      byDate.get(p.date).push(p.value - m);
    }
  }
  const dates = [...byDate.keys()].sort();
  const obs = dates.map((d) => ({ date: d, wd: weekdayOf(d), v: mean(byDate.get(d)), lanes: byDate.get(d).length }));
  const cells = [];
  for (const wd of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']) {
    const vals = obs.filter((o) => o.wd === wd).map((o) => o.v);
    const s = ES.summarizeDateSeries(vals, { horizonBars: 1 });
    if (!s) { cells.push({ id: wd, n: vals.length, avg: null, p: null }); continue; }
    cells.push({ id: wd, n: vals.length, avg: s.avg, ci95: s.ci95, t: round(s.avgExact / s.seExact), p: ES.pValueOf(s), positiveBlocks: s.positiveBlocks });
  }
  const bh = benjaminiHochberg(cells.map((c) => ({ id: c.id, p: c.p })));
  const qById = new Map(bh.map((b) => [b.id, b.q]));
  for (const c of cells) { c.q = round(qById.get(c.id), 4); c.survivesFdr = Number.isFinite(c.q) && c.q <= FDR_Q; }
  const avgs = cells.filter((c) => Number.isFinite(c.avg)).map((c) => c.avg);
  return { observations: obs.length, lanesPooled: lanes.filter((l) => l.pts.length >= MIN_DATES_A).length,
    spreadMaxMin: avgs.length ? round(Math.max(...avgs) - Math.min(...avgs)) : null, cells };
}

// ── C2. lane persistence ────────────────────────────────────────────────────────────────
function clusteredSlope(pairs) {
  // pairs: [{date, x, y}] — OLS slope with one-way cluster-robust SE by date.
  const xm = mean(pairs.map((p) => p.x)), ym = mean(pairs.map((p) => p.y));
  const sxx = pairs.reduce((s, p) => s + (p.x - xm) ** 2, 0);
  if (!(sxx > 0)) return null;
  const slope = pairs.reduce((s, p) => s + (p.x - xm) * (p.y - ym), 0) / sxx;
  const byDate = new Map();
  for (const p of pairs) {
    const u = p.y - ym - slope * (p.x - xm);
    byDate.set(p.date, (byDate.get(p.date) || 0) + (p.x - xm) * u);
  }
  const G = byDate.size;
  const meat = [...byDate.values()].reduce((s, g) => s + g * g, 0);
  const se = Math.sqrt(meat) / sxx * Math.sqrt(G / Math.max(1, G - 1));
  const t = se > 0 ? slope / se : null;
  const S3 = require('../lib/research/stats-v3');
  return { slope: round(slope, 4), se: round(se, 4), t: round(t), clusters: G, n: pairs.length,
    p: t == null ? null : S3.pFromT(t, Math.max(1, G - 1)) };
}

function lanePersistence(lanes) {
  const pairsMean = [], pairsHit = [];
  let lanesUsed = 0;
  const blocksSign = { mean: [], hit: [] };
  for (const lane of lanes) {
    if (lane.pts.length < MIN_DATES_C2) continue;
    lanesUsed++;
    const vals = lane.pts.map((p) => p.value);
    const m = mean(vals);
    for (let i = LOOKBACK_C2; i < vals.length; i++) {
      const prior = vals.slice(i - LOOKBACK_C2, i);
      pairsMean.push({ date: lane.pts[i].date, lane: lane.key, x: mean(prior) - m, y: vals[i] - m });
      pairsHit.push({ date: lane.pts[i].date, lane: lane.key, x: prior.filter((v) => v > 0).length / LOOKBACK_C2, y: vals[i] - m });
    }
  }
  const blockRead = (pairs) => {
    const sorted = [...pairs].sort((a, b) => (a.date < b.date ? -1 : 1));
    const size = Math.ceil(sorted.length / 4);
    const out = [];
    for (let b = 0; b < 4; b++) {
      const chunk = sorted.slice(b * size, (b + 1) * size);
      const s = chunk.length >= 20 ? clusteredSlope(chunk) : null;
      out.push(s ? s.slope : null);
    }
    return out;
  };
  const cells = [
    { id: 'prior10-mean', ...(clusteredSlope(pairsMean) || {}), blockSlopes: blockRead(pairsMean) },
    { id: 'prior10-hitrate', ...(clusteredSlope(pairsHit) || {}), blockSlopes: blockRead(pairsHit) },
  ];
  const bh = benjaminiHochberg(cells.map((c) => ({ id: c.id, p: c.p })));
  const qById = new Map(bh.map((b) => [b.id, b.q]));
  for (const c of cells) { c.q = round(qById.get(c.id), 4); c.survivesFdr = Number.isFinite(c.q) && c.q <= FDR_Q; }
  // NULL CALIBRATION (method, not a new hypothesis): demeaning each lane by its FULL-sample mean
  // biases a lagged-regressor slope negative by ≈ −LOOKBACK/T (Nickell). The honest null is the
  // same statistic on within-lane iid permutations, which carry the identical bias and none of
  // the time structure. Overlapping forward windows would push the null POSITIVE, so an iid
  // shuffle is conservative for a negative finding.
  const eligible = lanes.filter((l) => l.pts.length >= MIN_DATES_C2);
  const permSlopes = [];
  let seed = 20260919;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let k = 0; k < PERMUTATIONS; k++) {
    const pairs = [];
    for (const lane of eligible) {
      const vals = lane.pts.map((p) => p.value);
      for (let i = vals.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [vals[i], vals[j]] = [vals[j], vals[i]]; }
      const m = mean(vals);
      for (let i = LOOKBACK_C2; i < vals.length; i++) pairs.push({ date: lane.pts[i].date, x: mean(vals.slice(i - LOOKBACK_C2, i)) - m, y: vals[i] - m });
    }
    const s = clusteredSlope(pairs);
    if (s) permSlopes.push(s.slope);
  }
  permSlopes.sort((a, b) => a - b);
  const observed = cells[0].slope;
  const permLess = permSlopes.filter((x) => x <= observed).length;
  cells[0].permutationNull = {
    permutations: permSlopes.length, nullMean: round(mean(permSlopes), 4),
    null05: round(permSlopes[Math.floor(0.05 * permSlopes.length)], 4), null95: round(permSlopes[Math.floor(0.95 * permSlopes.length)], 4),
    pOneSided: round((permLess + 1) / (permSlopes.length + 1), 4),
    biasAdjustedSlope: round(observed - mean(permSlopes), 4),
  };
  // FOLLOW-UP RULE (exploratory, triggered by the preregistered |t|≥2.5 & 4/4-block condition):
  // no demeaning, no fitted parameter — take a lane's date only when its prior-10 mean net excess
  // is below the lane's EXPANDING prior mean (data before t only). Compare selected vs unselected
  // dates on the raw net-excess scale, one observation per calendar date per arm.
  const sel = new Map(), unsel = new Map();
  for (const lane of eligible) {
    const vals = lane.pts.map((p) => p.value);
    for (let i = LOOKBACK_C2 + 5; i < vals.length; i++) {
      const prior = mean(vals.slice(0, i));
      const recent = mean(vals.slice(i - LOOKBACK_C2, i));
      const bucket = recent < prior ? sel : unsel;
      const d = lane.pts[i].date;
      if (!bucket.has(d)) bucket.set(d, []);
      bucket.get(d).push(vals[i]);
    }
  }
  const arm = (m) => { const vals = [...m.keys()].sort().map((d) => mean(m.get(d))); const s = ES.summarizeDateSeries(vals, { horizonBars: 5 }); return s ? { dates: vals.length, avg: s.avg, ci95: s.ci95, t: round(s.avgExact / s.seExact), positiveBlocks: s.positiveBlocks, laneDates: [...m.values()].reduce((a, b) => a + b.length, 0) } : null; };
  const selected = arm(sel), unselected = arm(unsel);
  const diffDates = [...sel.keys()].filter((d) => unsel.has(d)).sort();
  const diffVals = diffDates.map((d) => mean(sel.get(d)) - mean(unsel.get(d)));
  const dS = ES.summarizeDateSeries(diffVals, { horizonBars: 5 });
  const followUp = { rule: 'long a lane date only when prior-10 mean net excess < the lane expanding prior mean', selected, unselected,
    pairedDiff: dS ? { dates: diffVals.length, avg: dS.avg, ci95: dS.ci95, t: round(dS.avgExact / dS.seExact), p: ES.pValueOf(dS), positiveBlocks: dS.positiveBlocks } : null };
  return { lanesUsed, cells, followUp };
}

async function main() {
  const sb = await loadScoreboard();
  const groups = Array.isArray(sb.groups) ? sb.groups : [];
  const lanes = groups.map(laneSeries).filter(Boolean);
  const out = {
    experiment: 'ledger-conditional-structure-2026-09',
    generatedAt: new Date().toISOString(),
    scoreboardAt: sb.generatedAt || null,
    costModel: sb.costModel || null,
    groups: groups.length, lanesWithSeries: lanes.length,
    families: {
      A_inverseEconomics: inverseEconomics(lanes),
      C1_dayOfWeek: dayOfWeek(lanes),
      C2_lanePersistence: lanePersistence(lanes),
    },
  };
  const A = out.families.A_inverseEconomics;
  out.summary = {
    A: { tested: A.length, fdrSurvivors: A.filter((r) => r.survivesFdr).length,
      positiveShortSurvivors: A.filter((r) => r.survivesFdr && r.shortNetAvg > 0).length,
      promotable: A.filter((r) => r.promotable).map((r) => r.id),
      nominalPositive: A.filter((r) => r.shortNetAvg > 0 && r.p != null && r.p < 0.05).map((r) => ({ id: r.id, avg: r.shortNetAvg, t: r.t, q: r.q, dates: r.dates, cons: r.conservative.shortNetAvg })) },
    C1: out.families.C1_dayOfWeek.cells.map((c) => ({ wd: c.id, n: c.n, avg: c.avg, t: c.t, q: c.q })),
    C2: out.families.C2_lanePersistence.cells.map((c) => ({ id: c.id, slope: c.slope, t: c.t, q: c.q, clusters: c.clusters, blocks: c.blockSlopes, permutationNull: c.permutationNull || null })),
    C2_followUp: out.families.C2_lanePersistence.followUp,
  };
  const outDir = arg('out', null);
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'ledger-conditional-structure.json'), JSON.stringify(out, null, 2));
  }
  console.log(JSON.stringify(out.summary, null, 2));
  console.log('\nA — top 12 by p (short book, tier borrow prior):');
  for (const r of A.slice(0, 12)) {
    console.log(`${r.id.padEnd(40)} ${r.metric.padEnd(3)} dates ${String(r.dates).padStart(3)} long ${String(r.longNetAvg).padStart(6)} short ${String(r.shortNetAvg).padStart(6)} [${r.ci95.lo}, ${r.ci95.hi}] t ${r.t} q ${r.q} blocks ${r.positiveBlocks}/${r.blocks} cons ${r.conservative.shortNetAvg}${r.note ? ' *' + r.note : ''}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

// ORBIT-ML marginal ensemble contribution (orbit-ml-ensemble-v1).
//
// ORBIT-ML does NOT earn live influence from standalone performance — it must add
// INCREMENTAL out-of-sample information beyond the existing algorithms after a
// redundancy adjustment. Two complementary measurements:
//
//   1. Redundancy credit (lib/redundancy.js): does ORBIT-ML's excess-return stream
//      co-move with / duplicate each existing algorithm's? Low credit + no
//      confirmation lift ⇒ redundant.
//   2. Leave-one-out rank-IC ablation: does adding ORBIT-ML to an equal-rank
//      ensemble RAISE the daily rank-IC vs the ensemble without it?
//
// Both are honest about sign: given ORBIT's established ~0 standalone OOS edge, the
// expected marginal contribution is ~0 — and this module reports that plainly rather
// than manufacturing a positive number.

const { buildRedundancyModel } = require('./redundancy');
const RQ = require('./rankquality');
const M = require('./orbit-math');

const ENSEMBLE_VERSION = 'orbit-ml-ensemble-v1';
const ORBIT_ML = 'idiosyncraticPersistence';

// Redundancy credit of ORBIT-ML vs each peer algorithm.
//   rows: combined [{date, ticker, algorithm, excess}] for ORBIT-ML + peers.
function redundancyContribution(rows, opts = {}) {
  const model = buildRedundancyModel(rows, { priorCredit: opts.priorCredit != null ? opts.priorCredit : 0.3 });
  const pairs = (model.pairs || []).filter(p => p.a === ORBIT_ML || p.b === ORBIT_ML).map(p => {
    const peer = p.a === ORBIT_ML ? p.b : p.a;
    return { peer, overlapRate: p.overlapRate, returnCorr: p.returnCorr, redundancy: p.redundancy, confirmationLift: p.confirmation ? p.confirmation.lift : null, credit: p.credit };
  });
  const avgCredit = pairs.length ? M.mean(pairs.map(p => p.credit)) : null;
  const maxCorr = pairs.length ? Math.max(...pairs.map(p => Math.abs(p.returnCorr || 0))) : null;
  return {
    version: ENSEMBLE_VERSION,
    peers: pairs,
    avgCreditVsPeers: avgCredit == null ? null : +avgCredit.toFixed(3),
    maxAbsReturnCorr: maxCorr == null ? null : +maxCorr.toFixed(3),
    verdict: avgCredit == null ? 'insufficient-data' : (avgCredit >= 0.6 ? 'largely-independent' : avgCredit >= 0.35 ? 'partly-redundant' : 'redundant'),
  };
}

// Leave-one-out rank-IC ablation over a joint cross-section.
//   predictions: [{ date, ticker, outcome, scores: { algoId: score, ... } }]
// Ensemble score = mean of within-date percentile ranks across the included algos.
// Returns per-date-averaged IC with vs without ORBIT-ML.
function leaveOneOutIC(predictions, opts = {}) {
  const targetAlgo = opts.algo || ORBIT_ML;
  const byDate = new Map();
  for (const p of predictions) { if (!byDate.has(p.date)) byDate.set(p.date, []); byDate.get(p.date).push(p); }

  const withICs = [], withoutICs = [];
  let datesUsed = 0;
  for (const [, group] of byDate) {
    if (group.length < 3) continue;
    const algos = new Set(); group.forEach(g => Object.keys(g.scores || {}).forEach(a => algos.add(a)));
    if (!algos.has(targetAlgo)) continue;
    const withScore = ensembleRanks(group, [...algos]);
    const withoutScore = ensembleRanks(group, [...algos].filter(a => a !== targetAlgo));
    if (!withScore || !withoutScore) continue;
    const icW = RQ.informationCoefficient(group.map((g, i) => ({ score: withScore[i], outcome: g.outcome })));
    const icWo = RQ.informationCoefficient(group.map((g, i) => ({ score: withoutScore[i], outcome: g.outcome })));
    if (icW && icW.ic != null) withICs.push(icW.ic);
    if (icWo && icWo.ic != null) withoutICs.push(icWo.ic);
    datesUsed++;
  }
  if (!withICs.length || !withoutICs.length) return { version: ENSEMBLE_VERSION, ready: false, reason: 'insufficient joint cross-section', datesUsed };
  const withIC = M.mean(withICs), withoutIC = M.mean(withoutICs);
  const marginalDelta = +(withIC - withoutIC).toFixed(4);
  return {
    version: ENSEMBLE_VERSION, ready: true, datesUsed,
    withIC: +withIC.toFixed(4), withoutIC: +withoutIC.toFixed(4), marginalDelta,
    verdict: marginalDelta > 0.005 ? 'adds-incremental-info' : marginalDelta < -0.005 ? 'hurts-ensemble' : 'no-incremental-info',
  };
}

// Per-name mean of within-group percentile ranks across `algos` (missing → skipped).
function ensembleRanks(group, algos) {
  if (!algos.length) return null;
  const percentiles = {};
  for (const a of algos) {
    const vals = group.map((g, i) => ({ i, v: g.scores ? g.scores[a] : null })).filter(x => x.v != null && Number.isFinite(x.v));
    if (vals.length < 2) continue;
    vals.sort((x, y) => x.v - y.v);
    vals.forEach((x, rank) => { percentiles[a] = percentiles[a] || {}; percentiles[a][x.i] = rank / (vals.length - 1); });
  }
  const usable = Object.keys(percentiles);
  if (!usable.length) return null;
  return group.map((_, i) => { const ps = usable.map(a => percentiles[a][i]).filter(v => v != null); return ps.length ? M.mean(ps) : 0.5; });
}

module.exports = { ENSEMBLE_VERSION, ORBIT_ML, redundancyContribution, leaveOneOutIC, ensembleRanks };

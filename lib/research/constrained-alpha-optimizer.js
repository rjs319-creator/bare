'use strict';

// Pure constrained optimiser helpers. The runner supplies already point-in-time
// cross-sections and remains responsible for execution/cost outcome construction.

const { averageTieRanks, mean } = require('./hedge-fund-swing-formula');

const FIELDS = Object.freeze(['momentum', 'entry', 'fundamental', 'lowDownside', 'lowExtension', 'lowCost']);

function normalizeWeights(weights, { momentumFloor = .50 } = {}) {
  const raw = FIELDS.map(k => Math.max(0, Number(weights && weights[k]) || 0));
  let total = raw.reduce((s, x) => s + x, 0);
  if (!(total > 0)) return null;
  const out = Object.fromEntries(FIELDS.map((k, i) => [k, raw[i] / total]));
  if (out.momentum < momentumFloor) {
    const other = 1 - out.momentum;
    const scale = other > 0 ? (1 - momentumFloor) / other : 0;
    for (const k of FIELDS.slice(1)) out[k] *= scale;
    out.momentum = momentumFloor;
  }
  total = FIELDS.reduce((s, k) => s + out[k], 0);
  for (const k of FIELDS) out[k] /= total;
  return out;
}

function score(row, weights) {
  return FIELDS.reduce((s, k) => s + (weights[k] || 0) * (row.optFeatures[k] ?? .5), 0);
}

function topKReturn(panel, weights, { topK = 10, outcome = 'netBase' } = {}) {
  const top = panel.rows.slice().sort((a, b) => score(b, weights) - score(a, weights)
    || a.ticker.localeCompare(b.ticker)).slice(0, topK);
  return top.length >= topK ? mean(top.map(r => r[outcome])) * 100 : null;
}

function rankIC(panel, weights, outcome = 'netBase') {
  const xs = panel.rows.map(r => score(r, weights));
  const ys = panel.rows.map(r => r[outcome]);
  if (xs.length < 3 || xs.every(x => x === xs[0])) return null;
  const rx = averageTieRanks(xs), ry = averageTieRanks(ys);
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const a = rx[i] - mx, b = ry[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
}

function objective(panels, weights, baselineWeights, opts = {}) {
  const returns = [], lifts = [], ics = [];
  for (const p of panels) {
    const r = topKReturn(p, weights, opts);
    const b = baselineWeights ? topKReturn(p, baselineWeights, opts) : null;
    if (Number.isFinite(r)) returns.push(r);
    if (Number.isFinite(r) && Number.isFinite(b)) lifts.push(r - b);
    const ic = rankIC(p, weights, opts.outcome || 'netBase');
    if (Number.isFinite(ic)) ics.push(ic);
  }
  const avgReturn = mean(returns), avgLift = mean(lifts), avgIC = mean(ics);
  const sd = returns.length > 1
    ? Math.sqrt(returns.reduce((s, x) => s + (x - avgReturn) ** 2, 0) / (returns.length - 1)) : null;
  // Training-only utility: emphasize paired improvement while mildly rewarding
  // breadth (rank IC) and penalizing unstable/high-variance candidates.
  const utility = (avgLift ?? -Infinity) + 5 * (avgIC ?? 0) - .05 * (sd ?? 0);
  return { utility, avgReturn, avgLift, avgIC, sd, dates: returns.length };
}

function fitRandomSearch(panels, { variants = 64, seed = 20260812, momentumFloor = .50,
  baselineWeights, topK = 10 } = {}) {
  let state = seed >>> 0;
  const rnd = () => { state = (1664525 * state + 1013904223) >>> 0; return state / 4294967296; };
  const specs = [baselineWeights];
  while (specs.length < variants) {
    const raw = Object.fromEntries(FIELDS.map(k => [k, k === 'momentum' ? .5 + rnd() : rnd()]));
    const weights = normalizeWeights(raw, { momentumFloor });
    specs.push(weights);
  }
  let best = null;
  for (let i = 0; i < specs.length; i++) {
    const metrics = objective(panels, specs[i], baselineWeights, { topK });
    const candidate = { variant: i, weights: specs[i], metrics };
    if (!best || metrics.utility > best.metrics.utility) best = candidate;
  }
  return { best, variants: specs };
}

module.exports = { FIELDS, mean, normalizeWeights, score, topKReturn, rankIC, objective, fitRandomSearch };

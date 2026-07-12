// op=baselines — the baseline-validation scorecard. Reads the cached factor research
// (research/factors-<scope>.json, written by op=research) + the Scoreboard summary,
// grades the strategies, and assembles each app strategy against the naive baselines
// (SPY / sector / equal-weight / random / simple momentum / 52-week-high / rel-vol).
// Pure assembly lives in lib/baselines; this is a thin, cheap read. No new function.

const { hasStore, readJSON } = require('./store');
const { classifyStrategies } = require('./maturity');
const { STRATEGY_REGISTRY } = require('./strategy-registry');
const { assembleBaselines, BASELINE_DEFS } = require('./baselines');

async function runBaselines(req, res) {
  const scope = ['large', 'small', 'micro'].includes(req.query.scope) ? req.query.scope : 'large';
  const [research, summary] = hasStore()
    ? await Promise.all([
        readJSON(`research/factors-${scope}.json`, null).catch(() => null),
        readJSON('scoreboard/summary.json', null).catch(() => null),
      ])
    : [null, null];
  const maturity = classifyStrategies(summary || { groups: [] }, STRATEGY_REGISTRY);
  const scorecard = assembleBaselines({ research, maturity });
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  return res.json({
    ok: true,
    configured: hasStore(),
    scope,
    researchAsOf: (research && research.generatedAt) || null,
    scoreboardAsOf: (summary && summary.generatedAt) || null,
    ...scorecard,
    note: 'Factor bars come from a point-in-time cross-section (rank-IC + top-quintile excess). SPY/sector are the benchmarks the grades already control for. Recompute the factor scan with op=research (heavy ~50s, rate-limited).',
    definitions: BASELINE_DEFS.map(d => ({ key: d.key, name: d.name, kind: d.kind })),
    generatedAt: new Date().toISOString(),
  });
}

module.exports = { runBaselines };

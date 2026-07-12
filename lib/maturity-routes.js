// op=maturity — the evidence-maturity board. Reads the persisted Scoreboard track
// record (scoreboard/summary.json, written by runScoreboard) and grades every strategy
// in the registry: Validated / Promising / Experimental / Informational / Disabled,
// plus the Research-Lab membership list (non-core signals that haven't earned Validated).
// Pure grading lives in lib/maturity; this is a thin HTTP wrapper. No new function
// (folded into api/tracker.js dispatch).

const { hasStore, readJSON } = require('./store');
const { classifyStrategies, GRADE_META, MATURITY_VERSION } = require('./maturity');
const { STRATEGY_REGISTRY } = require('./strategy-registry');

async function runMaturity(req, res) {
  const summary = hasStore() ? await readJSON('scoreboard/summary.json', null).catch(() => null) : null;
  const result = classifyStrategies(summary || { groups: [] }, STRATEGY_REGISTRY);
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  return res.json({
    ok: true,
    configured: hasStore(),
    version: MATURITY_VERSION,
    gradeMeta: GRADE_META,
    scoreboardAt: (summary && summary.generatedAt) || null,
    ...result,
    note: 'Grades are earned from each class’s own resolved Scoreboard record (excess vs benchmark, Wilson-bounded, sample-aware). Non-core signals below Validated live in the Research Lab until the data promotes them.',
    generatedAt: new Date().toISOString(),
  });
}

module.exports = { runMaturity };

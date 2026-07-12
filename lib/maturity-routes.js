// op=maturity — the evidence-maturity board. Reads the persisted Scoreboard track
// record (scoreboard/summary.json, written by runScoreboard) and grades every strategy
// in the registry: Validated / Promising / Experimental / Informational / Disabled,
// plus the Research-Lab membership list (non-core signals that haven't earned Validated).
// Pure grading lives in lib/maturity; this is a thin HTTP wrapper. No new function
// (folded into api/tracker.js dispatch).

const { hasStore, readJSON, writeJSON } = require('./store');
const { classifyStrategies, GRADE_META, MATURITY_VERSION } = require('./maturity');
const { governRegistry, STATUS_META, GOVERNANCE_VERSION } = require('./governance');
const { STRATEGY_REGISTRY } = require('./strategy-registry');

const GOV_STATE = 'governance/latest.json';

async function runMaturity(req, res) {
  const summary = hasStore() ? await readJSON('scoreboard/summary.json', null).catch(() => null) : null;
  const result = classifyStrategies(summary || { groups: [] }, STRATEGY_REGISTRY);

  // Governance: map each earned grade → an actionable status (Production / Reduced /
  // Probation / Paper-only / Disabled / Retired) using the PRIOR run's state for the
  // version guard + weakening-trend detection. Persist the new state (best-effort) so
  // next run can see version changes and edges slipping. Never blocks the response.
  const prevGov = hasStore() ? await readJSON(GOV_STATE, null).catch(() => null) : null;
  const prevMap = new Map(((prevGov && prevGov.strategies) || []).map(s => [s.id, s]));
  const governance = governRegistry(result, prevMap);
  if (hasStore()) {
    writeJSON(GOV_STATE, { ...governance, savedAt: new Date().toISOString() }).catch(() => {});
  }

  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  return res.json({
    ok: true,
    configured: hasStore(),
    version: MATURITY_VERSION,
    gradeMeta: GRADE_META,
    governanceVersion: GOVERNANCE_VERSION,
    statusMeta: STATUS_META,
    governance,
    scoreboardAt: (summary && summary.generatedAt) || null,
    ...result,
    note: 'Grades are earned from each class’s own resolved Scoreboard record (excess vs benchmark, Wilson-bounded, sample-aware). Non-core signals below Validated live in the Research Lab until the data promotes them. Governance maps each grade to an actionable status that controls sizing weight — never merging track records across scoring versions.',
    generatedAt: new Date().toISOString(),
  });
}

module.exports = { runMaturity };

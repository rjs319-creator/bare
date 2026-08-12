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
  // gov-v2: reviewable promotion artifacts — an earned Validated grade converts to
  // Production clearance only through an explicit, version-matched approval record.
  // Absent doc ⇒ empty map ⇒ every validated strategy holds at paper (fail closed).
  const promoArtifacts = hasStore() ? await readJSON('governance/promotion-artifacts.json', null).catch(() => null) : null;
  // gov-v2.1: artifacts are additionally judged against the CURRENT Scoreboard evidence
  // hash — a fresh governance rewrite cannot resurrect an approval judged on other data.
  const governance = governRegistry(result, prevMap, promoArtifacts, {
    nowMs: Date.now(),
    evidenceHash: (summary && summary.evidenceHash) || null,
  });
  // Read-only disclosure of the self-adapting layers governance does NOT gate —
  // an auto-promotion inside a production strategy must at least be visible here.
  const adaptiveLayers = hasStore()
    ? await require('./adaptive-layers').readAdaptiveLayers().catch(() => null)
    : null;
  // CAPITAL-CONTROL WRITE — AWAITED. The fire-and-forget `.catch(() => {})` version
  // meant a persistently failing write still reported ok:true while every consumer
  // kept reading a silently frozen doc. A failed write is now visible and the
  // response refuses to claim successful clearance.
  const persisted = { attempted: hasStore(), ok: false, error: null };
  // Append-only transition record BEFORE the state overwrite clobbers the prior doc —
  // old→new status, version, weight, reason, approval linkage, hash-chained
  // (lib/governance-transitions). A failed append is reported, never fatal.
  const transitions = hasStore()
    ? await require('./governance-transitions').recordGovernanceTransitions(prevGov, governance, {
        evidenceHash: (summary && summary.evidenceHash) || null,
        scoreboardGeneratedAt: (summary && summary.generatedAt) || null,
      })
    : { count: 0, logged: false, error: 'no store' };
  if (hasStore()) {
    try {
      await writeJSON(GOV_STATE, {
        ...governance, adaptiveLayers,
        savedAt: new Date().toISOString(),
        // Evidence provenance ride-alongs: consumers must key freshness off the
        // EVIDENCE timestamp, not the governance write time — a newly written
        // governance doc must not make an old Scoreboard appear fresh.
        scoreboardGeneratedAt: (summary && summary.generatedAt) || null,
        evidenceHash: (summary && summary.evidenceHash) || null,
        maturityVersion: MATURITY_VERSION,
      }, 0);
      persisted.ok = true;
    } catch (e) { persisted.error = String((e && e.message) || e); }
  }

  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  return res.json({
    ok: !persisted.attempted || persisted.ok,
    governancePersisted: persisted,
    governanceTransitions: transitions,
    configured: hasStore(),
    version: MATURITY_VERSION,
    gradeMeta: GRADE_META,
    governanceVersion: GOVERNANCE_VERSION,
    statusMeta: STATUS_META,
    governance,
    adaptiveLayers,
    scoreboardAt: (summary && summary.generatedAt) || null,
    ...result,
    note: 'Grades are earned from each class’s own resolved Scoreboard record (excess vs benchmark, Wilson-bounded, sample-aware). Non-core signals below Validated live in the Research Lab until the data promotes them. Governance maps each grade to an actionable status that controls sizing weight — never merging track records across scoring versions.',
    generatedAt: new Date().toISOString(),
  });
}

// ── op=adaptivepolicy : the central control for the self-adapting layers ─────
// GET: current policy + live layer disclosure. ?set=<layer>:<policy> (trusted
// only) updates one layer with an audit trail. The doc lives apart from
// governance/latest.json so the daily governance rewrite can never clobber a
// human decision.
async function runAdaptivePolicy(req, res) {
  const AL = require('./adaptive-layers');
  res.setHeader('Cache-Control', 'no-store');
  if (!hasStore()) return res.json({ ok: false, error: 'Blob storage not configured.' });

  const set = typeof req.query.set === 'string' ? req.query.set.trim() : null;
  let changed = null, error = null;
  if (set) {
    const { isTrusted } = require('./auth');
    if (!isTrusted(req)) return res.status(401).json({ ok: false, error: 'set requires a trusted caller' });
    const m = set.match(/^([a-z-]+):([a-z]+)$/);
    const layer = m && m[1], policy = m && m[2];
    if (!m || !AL.LAYERS.includes(layer)) error = `unknown layer — expected one of ${AL.LAYERS.join(', ')}`;
    else if (!AL.POLICIES.includes(policy)) error = `unknown policy — expected one of ${AL.POLICIES.join(', ')}`;
    else {
      const prev = (await readJSON(AL.POLICY_DOC, null).catch(() => null)) || { layers: {}, history: [] };
      const doc = {
        version: AL.ADAPTIVE_LAYERS_VERSION,
        layers: { ...(prev.layers || {}), [layer]: policy },
        history: [...(prev.history || []), { at: new Date().toISOString(), layer, policy, prev: (prev.layers || {})[layer] || 'allow' }].slice(-50),
        updatedAt: new Date().toISOString(),
      };
      await writeJSON(AL.POLICY_DOC, doc, 0);
      changed = { layer, policy };
    }
  }

  const [policyDoc, disclosure] = await Promise.all([
    readJSON(AL.POLICY_DOC, null).catch(() => null),
    AL.readAdaptiveLayers().catch(() => null),
  ]);
  return res.status(error ? 400 : 200).json({
    ok: !error, error, changed,
    policyDoc: policyDoc || { layers: {}, note: 'no policy set — every layer defaults to FREEZE (fail-closed, v3): persisted adapted state stays in force, nothing new is adopted without an explicit allow' },
    layers: disclosure ? disclosure.layers : null,
    usage: 'GET ?set=<layer>:<allow|freeze|disable> (trusted only). freeze = keep current adapted state, adopt nothing new; disable = revert to shipped behavior.',
  });
}

module.exports = { runMaturity, runAdaptivePolicy };

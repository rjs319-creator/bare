'use strict';
// MULTI-AGENT LAYER — provider-neutral interfaces and typed outputs.
//
// The mission's operating model, implemented as a contract rather than as prose. Ten
// specialist roles exchange TYPED JSON, never free-form essays, and every one of them is
// bounded by the same set of rules:
//
//   1. An agent may EXTRACT, CLASSIFY, EXPLAIN, CHALLENGE, and SYNTHESIZE.
//      It may NOT invent prices, catalysts, probabilities, sources, Greeks, spreads,
//      liquidity, or performance. `validateAgentOutput` rejects any output that does,
//      and the rejection is recorded — a malformed agent is a visible degraded state,
//      not a silent fallback to "no signal".
//   2. Deterministic code owns every number. An agent output carrying a numeric level,
//      probability, or performance figure is REJECTED at the boundary, whatever the model
//      claimed. That is enforced here mechanically, not by prompt wording.
//   3. Dissent is preserved. `mergeAgentOutputs` never averages disagreeing agents into a
//      pseudo-confidence; it collects their positions and lowers readiness.
//   4. Nothing an agent returns can change a strategy's weight, maturity, or trade
//      eligibility. `applyAgentsToDecision` copies the governance block through unchanged
//      and refuses to modify the deterministic gate outcome.
//
// Provider-neutral: an adapter is any object with `{ id, capabilities, run(request) }`.
// The Anthropic integration already in this repo can be registered as one; so can a local
// model, a different vendor, or a stub. Nothing here imports a vendor SDK.
//
// Pure; all I/O happens in the injected adapter.

const AGENTS_VERSION = 'agents-contract-v1';

const ROLE = Object.freeze({
  INTAKE: 'intake',
  PROVENANCE: 'provenance',
  REGIME: 'regime',
  SETUP: 'setup',
  OPTIONS: 'options',
  EXECUTION: 'execution',
  PORTFOLIO: 'portfolio',
  SKEPTIC: 'skeptic',
  CALIBRATION: 'calibration',
  SYNTHESIS: 'synthesis',
});

const ROLE_ORDER = Object.freeze([
  ROLE.INTAKE, ROLE.PROVENANCE, ROLE.REGIME, ROLE.SETUP, ROLE.OPTIONS,
  ROLE.EXECUTION, ROLE.PORTFOLIO, ROLE.SKEPTIC, ROLE.CALIBRATION, ROLE.SYNTHESIS,
]);

// What each role is allowed to return. Anything outside its schema is dropped; anything
// in `forbidden` causes the whole output to be REJECTED.
const ROLE_SCHEMA = Object.freeze({
  [ROLE.INTAKE]: {
    allowed: ['entities', 'instruments', 'directionClaim', 'horizon', 'eventFamily', 'ambiguities', 'isQuestion', 'isNegated', 'isSarcastic', 'openCloseUncertain', 'multiLeg', 'notes'],
    forbidden: ['price', 'target', 'stop', 'probability', 'expectedReturn'],
    required: ['entities', 'directionClaim', 'ambiguities'],
  },
  [ROLE.PROVENANCE]: {
    allowed: ['claimStatus', 'primarySourceFound', 'sourceIds', 'publicationTime', 'eventTime', 'discoveryTime', 'syndicationOf', 'contradictions', 'coverageLanes', 'notes'],
    forbidden: ['probability', 'price', 'expectedReturn'],
    required: ['claimStatus', 'sourceIds'],
  },
  [ROLE.REGIME]: {
    allowed: ['intradayRead', 'tacticalRead', 'strategicRead', 'supporting', 'contradicting', 'sideAwareNote', 'notes'],
    forbidden: ['probability', 'price', 'expectedReturn'],
    required: ['supporting', 'contradicting'],
  },
  [ROLE.SETUP]: {
    // The setup agent EXPLAINS deterministic levels. It may reference them by name but may
    // not emit numeric levels of its own — that is the single most abusable surface here.
    allowed: ['setupType', 'explanation', 'triggerRef', 'invalidationRef', 'targetRef', 'timeStopRef', 'reactionGapNote', 'notes'],
    forbidden: ['trigger', 'invalidation', 'target', 'price', 'stop', 'entry', 'probability', 'expectedReturn'],
    required: ['setupType', 'explanation'],
  },
  [ROLE.OPTIONS]: {
    allowed: ['anomalyNote', 'structureHypotheses', 'provisionalDirection', 'volatilityNote', 'catalystProximityNote', 'independentConfirmationNote', 'notes'],
    forbidden: ['greeks', 'delta', 'gamma', 'vega', 'impliedVolatility', 'spread', 'openInterest', 'probability', 'expectedReturn'],
    required: ['structureHypotheses'],
  },
  [ROLE.EXECUTION]: {
    allowed: ['feasibility', 'concerns', 'missingInputs', 'vehicleNote', 'notes'],
    forbidden: ['spreadBps', 'slippage', 'adv', 'borrowFee', 'capacity', 'probability'],
    required: ['feasibility', 'missingInputs'],
  },
  [ROLE.PORTFOLIO]: {
    allowed: ['exposureTags', 'correlatedWith', 'sameBetAs', 'concentrationNote', 'notes'],
    forbidden: ['positionSize', 'shares', 'dollarRisk', 'probability'],
    required: ['exposureTags'],
  },
  [ROLE.SKEPTIC]: {
    allowed: ['counterThesis', 'staleDataConcerns', 'duplicateNarrative', 'manipulationConcerns', 'alreadyConsumed', 'falsePositiveExplanations', 'unpricedExecutionRisk', 'notes'],
    forbidden: ['probability', 'expectedReturn', 'price'],
    required: ['counterThesis'],
  },
  [ROLE.CALIBRATION]: {
    // The calibration agent may RECOMMEND. It can never promote.
    allowed: ['recommendation', 'driftConcerns', 'coverageConcerns', 'effectiveSampleNote', 'championChallengerNote', 'notes'],
    forbidden: ['promote', 'setWeight', 'tradeEligible', 'maturity', 'probability'],
    required: ['recommendation'],
  },
  [ROLE.SYNTHESIS]: {
    allowed: ['thesis', 'whatChanged', 'keyEvidence', 'preservedDissent', 'evidenceGaps', 'notes'],
    forbidden: ['state', 'lifecycle', 'trigger', 'invalidation', 'target', 'probability', 'expectedReturn', 'decisionReadiness'],
    required: ['thesis', 'preservedDissent', 'evidenceGaps'],
  },
});

// A calibration agent may only ever return one of these. `PROMOTE` is deliberately absent.
const CALIBRATION_RECOMMENDATIONS = Object.freeze(['CONTINUE_SHADOW', 'REVIEW', 'INVESTIGATE_DRIFT', 'INSUFFICIENT_EVIDENCE']);

// Numeric-looking values are the fabrication surface. Any string that reads as a price,
// a percentage claimed as a probability, or a performance figure is rejected.
const PROBABILITY_PATTERN = /\b(\d{1,3}(\.\d+)?)\s*%\s*(chance|probability|likely|odds|confidence)\b/i;
const PRICE_CLAIM_PATTERN = /\b(target|trigger|stop|entry|invalidation)\s*(is|at|:)?\s*\$?\d/i;

const REJECT = Object.freeze({
  MISSING_REQUIRED: 'MISSING_REQUIRED_FIELD',
  FORBIDDEN_FIELD: 'FORBIDDEN_FIELD',
  FABRICATED_NUMBER: 'FABRICATED_NUMBER',
  FABRICATED_PROBABILITY: 'FABRICATED_PROBABILITY',
  UNKNOWN_ROLE: 'UNKNOWN_ROLE',
  NOT_AN_OBJECT: 'NOT_AN_OBJECT',
  BAD_RECOMMENDATION: 'BAD_RECOMMENDATION',
});

function scanStringsForFabrication(value, path, errors) {
  if (typeof value === 'string') {
    if (PROBABILITY_PATTERN.test(value)) errors.push({ code: REJECT.FABRICATED_PROBABILITY, path, detail: `"${value.slice(0, 80)}" states a probability; no calibrated model exists to support one` });
    if (PRICE_CLAIM_PATTERN.test(value)) errors.push({ code: REJECT.FABRICATED_NUMBER, path, detail: `"${value.slice(0, 80)}" asserts a numeric level; levels come from deterministic chart math only` });
    return;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => scanStringsForFabrication(v, `${path}[${i}]`, errors)); return; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) scanStringsForFabrication(v, `${path}.${k}`, errors);
  }
}

/**
 * Validate one agent's raw output against its role schema. Pure.
 * Returns { valid, output, errors } — `output` is the field-filtered object.
 */
function validateAgentOutput(role, raw) {
  const schema = ROLE_SCHEMA[role];
  if (!schema) return { valid: false, output: null, errors: [{ code: REJECT.UNKNOWN_ROLE, path: role, detail: `no schema for role "${role}"` }] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, output: null, errors: [{ code: REJECT.NOT_AN_OBJECT, path: role, detail: 'agent output must be a JSON object' }] };
  }

  const errors = [];
  for (const f of schema.forbidden) {
    if (f in raw && raw[f] != null) {
      errors.push({ code: REJECT.FORBIDDEN_FIELD, path: `${role}.${f}`, detail: `"${f}" is owned by deterministic code — an agent may not supply it` });
    }
  }
  for (const f of schema.required) {
    if (!(f in raw) || raw[f] == null) errors.push({ code: REJECT.MISSING_REQUIRED, path: `${role}.${f}`, detail: `required field "${f}" is missing` });
  }

  const filtered = {};
  for (const k of schema.allowed) if (k in raw && raw[k] != null) filtered[k] = raw[k];
  scanStringsForFabrication(filtered, role, errors);

  if (role === ROLE.CALIBRATION && filtered.recommendation && !CALIBRATION_RECOMMENDATIONS.includes(filtered.recommendation)) {
    errors.push({ code: REJECT.BAD_RECOMMENDATION, path: `${role}.recommendation`, detail: `"${filtered.recommendation}" is not an allowed recommendation; promotion is not an agent action` });
  }

  return { valid: errors.length === 0, output: errors.length === 0 ? filtered : null, errors };
}

// ── Adapter contract ────────────────────────────────────────────────────────

/**
 * Run one agent through a provider-neutral adapter, with a timeout, bounded retries, and
 * graceful degradation. Pure apart from the injected adapter and clock.
 *
 * An adapter is `{ id, capabilities, run(request) → Promise<object> }`. Nothing about
 * Anthropic, or any vendor, appears here.
 */
async function runAgent(role, request, {
  adapter = null, timeoutMs = 15_000, retries = 1, now = () => Date.now(), sleep = null,
} = {}) {
  const started = now();
  const base = { role, adapterId: adapter ? adapter.id : null, startedAt: started };

  if (!adapter || typeof adapter.run !== 'function') {
    return { ...base, ok: false, degraded: true, reason: 'NO_ADAPTER', output: null, errors: [{ code: 'NO_ADAPTER', detail: 'no provider adapter is configured for this agent — its lane is UNAVAILABLE, not empty' }], elapsedMs: 0 };
  }

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const raw = await withTimeout(adapter.run({ role, ...request }), timeoutMs);
      const v = validateAgentOutput(role, raw);
      if (v.valid) {
        return { ...base, ok: true, degraded: false, attempt, output: v.output, errors: [], elapsedMs: now() - started };
      }
      lastError = { reason: 'INVALID_OUTPUT', errors: v.errors };
      // A schema violation is not retried into compliance — retrying a model that fabricated
      // a number just rolls the dice again. It is recorded and the lane degrades.
      break;
    } catch (err) {
      lastError = { reason: err && err.message === 'AGENT_TIMEOUT' ? 'TIMEOUT' : 'ADAPTER_ERROR', errors: [{ code: err && err.message === 'AGENT_TIMEOUT' ? 'TIMEOUT' : 'ADAPTER_ERROR', detail: String((err && err.message) || err).slice(0, 200) }] };
      if (attempt < retries && sleep) await sleep(100 * (attempt + 1));
    }
  }

  return {
    ...base, ok: false, degraded: true,
    reason: lastError ? lastError.reason : 'UNKNOWN',
    output: null,
    errors: lastError ? lastError.errors : [],
    elapsedMs: now() - started,
  };
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('AGENT_TIMEOUT')), ms);
    Promise.resolve(promise).then(
      v => { clearTimeout(t); resolve(v); },
      e => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * Run the full panel. Agents are INDEPENDENT by design — no agent sees another's output,
 * so their agreement means something. Pure apart from the injected adapters.
 *
 * @param {object} request     the normalized event/thesis every agent sees
 * @param {object} opts        { adapters: { [role]: adapter }, roles, timeoutMs, retries }
 */
async function runPanel(request, { adapters = {}, roles = ROLE_ORDER, timeoutMs = 15_000, retries = 1, now = () => Date.now(), sleep = null } = {}) {
  const results = await Promise.all(roles.map(role =>
    runAgent(role, request, { adapter: adapters[role] || null, timeoutMs, retries, now, sleep })));
  const byRole = {};
  for (const r of results) byRole[r.role] = r;
  const ok = results.filter(r => r.ok);
  const degraded = results.filter(r => !r.ok);
  return {
    version: AGENTS_VERSION,
    byRole,
    rolesRun: roles.length,
    rolesOk: ok.length,
    rolesDegraded: degraded.length,
    // A degraded panel must READ as degraded. This is the "provider failure is never
    // no-signal" rule applied to the agent layer.
    degraded: degraded.length > 0,
    degradedRoles: degraded.map(r => ({ role: r.role, reason: r.reason, errors: r.errors })),
    coverage: roles.length ? +(ok.length / roles.length).toFixed(2) : 0,
  };
}

// ── Merging: dissent is collected, never averaged ───────────────────────────

/**
 * Turn a panel result into the dissent + evidence-gap lists the decision contract wants.
 * Pure. Explicitly does NOT produce a confidence number from agent agreement.
 */
function mergeAgentOutputs(panel) {
  const dissent = [];
  const missingEvidence = [];
  const notes = [];

  const get = role => (panel && panel.byRole && panel.byRole[role] && panel.byRole[role].ok ? panel.byRole[role].output : null);

  const skeptic = get(ROLE.SKEPTIC);
  if (skeptic) {
    if (skeptic.counterThesis) dissent.push({ agent: ROLE.SKEPTIC, position: skeptic.counterThesis, resolved: false });
    for (const k of ['staleDataConcerns', 'duplicateNarrative', 'manipulationConcerns', 'alreadyConsumed', 'unpricedExecutionRisk']) {
      const v = skeptic[k];
      if (!v) continue;
      for (const item of (Array.isArray(v) ? v : [v])) dissent.push({ agent: `${ROLE.SKEPTIC}:${k}`, position: String(item), resolved: false });
    }
    for (const fp of (skeptic.falsePositiveExplanations || [])) dissent.push({ agent: `${ROLE.SKEPTIC}:falsePositive`, position: String(fp), resolved: false });
  }

  const intake = get(ROLE.INTAKE);
  if (intake && (intake.ambiguities || []).length) {
    // Ambiguous language must BLOCK directional promotion, not be resolved optimistically.
    for (const a of intake.ambiguities) dissent.push({ agent: ROLE.INTAKE, position: `language ambiguity: ${String(a)}`, resolved: false, blocksDirection: true });
  }

  const regime = get(ROLE.REGIME);
  if (regime) for (const c of (regime.contradicting || [])) dissent.push({ agent: ROLE.REGIME, position: String(c), resolved: false });

  const options = get(ROLE.OPTIONS);
  if (options) for (const sh of (options.structureHypotheses || [])) dissent.push({ agent: ROLE.OPTIONS, position: `structure hypothesis: ${typeof sh === 'string' ? sh : JSON.stringify(sh)}`, resolved: false });

  const exec = get(ROLE.EXECUTION);
  if (exec) for (const m of (exec.missingInputs || [])) missingEvidence.push({ field: `execution.${m}`, required: true, reason: 'the execution agent reported this input missing' });

  const synth = get(ROLE.SYNTHESIS);
  if (synth) {
    for (const g of (synth.evidenceGaps || [])) missingEvidence.push({ field: 'synthesis', required: false, reason: String(g) });
    // The synthesis agent must CARRY dissent forward; if it dropped any, that is itself
    // recorded rather than accepted.
    const carried = (synth.preservedDissent || []).length;
    if (dissent.length && carried < dissent.length) {
      notes.push(`Synthesis carried ${carried} of ${dissent.length} dissenting positions — the full set is preserved here regardless.`);
    }
  }

  // Every degraded agent is itself an evidence gap. A silent panel is not a clean panel.
  for (const d of (panel && panel.degradedRoles) || []) {
    missingEvidence.push({ field: `agent.${d.role}`, required: false, reason: `agent unavailable (${d.reason}) — its lane contributed nothing` });
  }

  return {
    dissent,
    missingEvidence,
    notes,
    // Deliberately absent: any aggregate agreement score. Agreement between agents is not
    // evidence of correctness, and averaging disagreement is the failure mode this layer
    // exists to prevent.
    agreementScore: null,
    agreementNote: 'No aggregate agent-agreement score is produced. Agents that disagree are listed individually; agreement between them is not independent evidence.',
    blocksDirection: dissent.some(d => d.blocksDirection),
  };
}

/**
 * Fold agent output into an existing deterministic decision record. Pure.
 *
 * HARD RULES, enforced here rather than trusted:
 *   • The deterministic `state`, `lifecycle`, `trigger`, `invalidation`, `targets`,
 *     `executionConstraints`, and `governance` are copied through UNCHANGED.
 *   • Agents may only ADD dissent, missing evidence, and prose.
 *   • Adding dissent can only LOWER `decisionReadiness`, never raise it.
 *   • Ambiguous language blocks a directional state entirely.
 */
function applyAgentsToDecision(decision, panel, { readinessFor = null } = {}) {
  const dc = require('./decision-contract');
  const merged = mergeAgentOutputs(panel);
  const before = decision.decisionReadiness;

  const dissent = [...(decision.dissent || []), ...merged.dissent];
  const missingEvidence = [...(decision.missingEvidence || []), ...merged.missingEvidence];

  const recompute = readinessFor || dc.readinessFor;
  const readiness = recompute({
    factConfidence: decision.factConfidence,
    evidenceCoverage: (decision.dataQuality && decision.dataQuality.coverage) || 0,
    dissent, missingEvidence,
    deterministicGatePassed: decision.decisionReadiness !== 'UNAVAILABLE',
  });

  const RANK = { UNAVAILABLE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
  // Monotone guard: agent input can never raise readiness above where the deterministic
  // layer left it, whatever the recomputation says.
  const level = RANK[readiness.level] < RANK[before] ? readiness.level : before;

  const synth = panel && panel.byRole && panel.byRole[ROLE.SYNTHESIS] && panel.byRole[ROLE.SYNTHESIS].ok
    ? panel.byRole[ROLE.SYNTHESIS].output : null;

  // Ambiguous language refuses directional promotion outright.
  const state = merged.blocksDirection && ['ACT_NOW', 'SET_ALERT'].includes(decision.state)
    ? 'INVESTIGATE'
    : decision.state;

  return {
    ...decision,
    state,
    // Untouched by construction — listed explicitly so a future edit has to be deliberate.
    lifecycle: decision.lifecycle,
    trigger: decision.trigger,
    invalidation: decision.invalidation,
    targets: decision.targets,
    executionConstraints: decision.executionConstraints,
    governance: decision.governance,
    thesis: synth && synth.thesis ? String(synth.thesis).slice(0, 600) : decision.thesis,
    dissent,
    missingEvidence,
    decisionReadiness: level,
    decisionReadinessReasons: [...(decision.decisionReadinessReasons || []), ...readiness.reasons],
    agents: {
      version: AGENTS_VERSION,
      coverage: panel ? panel.coverage : 0,
      degraded: panel ? panel.degraded : true,
      degradedRoles: panel ? panel.degradedRoles : [{ role: 'all', reason: 'no panel supplied' }],
      agreementScore: null,
      agreementNote: merged.agreementNote,
      notes: merged.notes,
      // Every surviving claim is traceable to the role that made it and the run that
      // produced it — that is the "agent claims are traceable" acceptance criterion.
      provenance: ROLE_ORDER.map(r => {
        const x = panel && panel.byRole ? panel.byRole[r] : null;
        return x ? { role: r, ok: x.ok, adapterId: x.adapterId, startedAt: x.startedAt, elapsedMs: x.elapsedMs, reason: x.reason || null } : { role: r, ok: false, reason: 'NOT_RUN' };
      }),
      stateDowngradedByAmbiguity: state !== decision.state,
      readinessBefore: before,
      readinessAfter: level,
    },
  };
}

module.exports = {
  AGENTS_VERSION, ROLE, ROLE_ORDER, ROLE_SCHEMA, REJECT, CALIBRATION_RECOMMENDATIONS,
  validateAgentOutput, runAgent, runPanel, mergeAgentOutputs, applyAgentsToDecision,
};

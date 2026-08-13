'use strict';
// MULTI-AGENT LAYER — typed outputs, deterministic validation, dissent preservation,
// timeouts/retries/degradation, and the governance guarantees.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ag = require('../lib/agents-contract');
const ad = require('../lib/agents-adapters');
const dc = require('../lib/decision-contract');

const ok = out => ({ run: async () => out });
const fail = err => ({ id: 'boom', run: async () => { throw new Error(err); } });
const hang = () => ({ id: 'hang', run: () => new Promise(() => {}) });
const adapter = (id, out) => ({ id, capabilities: {}, ...ok(out) });

// ── Typed outputs and the fabrication boundary ──────────────────────────────

test('AGENTS: all ten required roles exist with schemas', () => {
  assert.equal(ag.ROLE_ORDER.length, 10);
  for (const r of ag.ROLE_ORDER) {
    assert.ok(ag.ROLE_SCHEMA[r], `${r} needs a schema`);
    assert.ok(ag.ROLE_SCHEMA[r].required.length, `${r} needs required fields`);
  }
});

test('AGENTS: an agent cannot supply a deterministic level — the setup agent is rejected', () => {
  const v = ag.validateAgentOutput(ag.ROLE.SETUP, { setupType: 'breakout', explanation: 'x', trigger: 106 });
  assert.equal(v.valid, false);
  assert.equal(v.errors[0].code, ag.REJECT.FORBIDDEN_FIELD);
  assert.match(v.errors[0].detail, /owned by deterministic code/i);
});

test('AGENTS: the options agent cannot supply Greeks, spreads, or open interest', () => {
  for (const f of ['greeks', 'delta', 'gamma', 'vega', 'impliedVolatility', 'spread', 'openInterest']) {
    const v = ag.validateAgentOutput(ag.ROLE.OPTIONS, { structureHypotheses: ['hedge'], [f]: 1 });
    assert.equal(v.valid, false, `${f} must be rejected`);
  }
});

test('AGENTS: the execution agent cannot invent a spread, ADV, borrow fee, or slippage', () => {
  for (const f of ['spreadBps', 'slippage', 'adv', 'borrowFee', 'capacity']) {
    const v = ag.validateAgentOutput(ag.ROLE.EXECUTION, { feasibility: 'UNKNOWN', missingInputs: [], [f]: 1 });
    assert.equal(v.valid, false, `${f} must be rejected`);
  }
});

test('AGENTS: a stated probability anywhere in the output REJECTS it', () => {
  const v = ag.validateAgentOutput(ag.ROLE.SKEPTIC, { counterThesis: 'there is a 70% chance this fails' });
  assert.equal(v.valid, false);
  assert.equal(v.errors[0].code, ag.REJECT.FABRICATED_PROBABILITY);
});

test('AGENTS: an asserted numeric level in PROSE is rejected too, not just as a field', () => {
  const v = ag.validateAgentOutput(ag.ROLE.SYNTHESIS, { thesis: 'buy it, target is $145', preservedDissent: [], evidenceGaps: [] });
  assert.equal(v.valid, false);
  assert.equal(v.errors[0].code, ag.REJECT.FABRICATED_NUMBER);
});

test('AGENTS: fabrication is caught inside NESTED structures, not only top-level strings', () => {
  const v = ag.validateAgentOutput(ag.ROLE.REGIME, { supporting: [{ note: 'a 90% probability of continuation' }], contradicting: [] });
  assert.equal(v.valid, false);
  assert.equal(v.errors[0].code, ag.REJECT.FABRICATED_PROBABILITY);
});

test('AGENTS: fields outside the schema are DROPPED, not passed through', () => {
  const v = ag.validateAgentOutput(ag.ROLE.INTAKE, { entities: ['AAA'], directionClaim: 'long', ambiguities: [], sneakyExtra: 'ignore me' });
  assert.equal(v.valid, true);
  assert.equal(v.output.sneakyExtra, undefined);
  assert.deepEqual(v.output.entities, ['AAA']);
});

test('AGENTS: a missing required field is rejected with a reason', () => {
  const v = ag.validateAgentOutput(ag.ROLE.INTAKE, { entities: ['AAA'] });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some(e => e.code === ag.REJECT.MISSING_REQUIRED));
});

test('AGENTS: non-objects and unknown roles are rejected, never thrown on', () => {
  assert.equal(ag.validateAgentOutput(ag.ROLE.INTAKE, null).errors[0].code, ag.REJECT.NOT_AN_OBJECT);
  assert.equal(ag.validateAgentOutput(ag.ROLE.INTAKE, [1, 2]).errors[0].code, ag.REJECT.NOT_AN_OBJECT);
  assert.equal(ag.validateAgentOutput('nonsense', {}).errors[0].code, ag.REJECT.UNKNOWN_ROLE);
});

// ── Calibration cannot promote ──────────────────────────────────────────────

test('GOVERNANCE: the calibration agent has no PROMOTE recommendation available', () => {
  assert.ok(!ag.CALIBRATION_RECOMMENDATIONS.includes('PROMOTE'));
  const v = ag.validateAgentOutput(ag.ROLE.CALIBRATION, { recommendation: 'PROMOTE' });
  assert.equal(v.valid, false);
  assert.equal(v.errors[0].code, ag.REJECT.BAD_RECOMMENDATION);
  assert.match(v.errors[0].detail, /promotion is not an agent action/i);
});

test('GOVERNANCE: the calibration agent cannot set weight, maturity, or eligibility', () => {
  for (const f of ['promote', 'setWeight', 'tradeEligible', 'maturity']) {
    const v = ag.validateAgentOutput(ag.ROLE.CALIBRATION, { recommendation: 'REVIEW', [f]: true });
    assert.equal(v.valid, false, `${f} must be rejected`);
  }
});

test('GOVERNANCE: the synthesis agent cannot set state, lifecycle, or readiness', () => {
  for (const f of ['state', 'lifecycle', 'decisionReadiness', 'trigger', 'target']) {
    const v = ag.validateAgentOutput(ag.ROLE.SYNTHESIS, { thesis: 'x', preservedDissent: [], evidenceGaps: [], [f]: 'ACT_NOW' });
    assert.equal(v.valid, false, `${f} must be rejected`);
  }
});

// ── Runtime: timeouts, retries, degradation ─────────────────────────────────

test('RUNTIME: no adapter yields an explicit NO_ADAPTER degrade, never an empty pass', async () => {
  const r = await ag.runAgent(ag.ROLE.INTAKE, {}, { adapter: null });
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
  assert.equal(r.reason, 'NO_ADAPTER');
  assert.match(r.errors[0].detail, /UNAVAILABLE, not empty/i);
});

test('RUNTIME: a hanging adapter times out and degrades', async () => {
  const r = await ag.runAgent(ag.ROLE.INTAKE, {}, { adapter: { id: 'h', ...hang() }, timeoutMs: 25, retries: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'TIMEOUT');
});

test('RUNTIME: a throwing adapter is retried, then degrades with the reason', async () => {
  let calls = 0;
  const flaky = { id: 'f', run: async () => { calls++; if (calls < 2) throw new Error('transient'); return { entities: ['A'], directionClaim: 'long', ambiguities: [] }; } };
  const r = await ag.runAgent(ag.ROLE.INTAKE, {}, { adapter: flaky, retries: 1, sleep: async () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.attempt, 1);

  const dead = await ag.runAgent(ag.ROLE.INTAKE, {}, { adapter: fail('down'), retries: 1, sleep: async () => {} });
  assert.equal(dead.ok, false);
  assert.equal(dead.reason, 'ADAPTER_ERROR');
});

test('RUNTIME: a schema violation is NOT retried into compliance', async () => {
  let calls = 0;
  const bad = { id: 'b', run: async () => { calls++; return { setupType: 'x', explanation: 'y', trigger: 100 }; } };
  const r = await ag.runAgent(ag.ROLE.SETUP, {}, { adapter: bad, retries: 3, sleep: async () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'INVALID_OUTPUT');
  assert.equal(calls, 1, 'retrying a fabricating model just rolls the dice again');
});

test('RUNTIME: a partly-degraded panel READS as degraded with the failing roles named', async () => {
  const p = await ag.runPanel({}, {
    roles: [ag.ROLE.INTAKE, ag.ROLE.SKEPTIC],
    adapters: {
      [ag.ROLE.INTAKE]: adapter('a', { entities: ['A'], directionClaim: 'long', ambiguities: [] }),
      [ag.ROLE.SKEPTIC]: { id: 'x', ...fail('nope') },
    },
    retries: 0,
  });
  assert.equal(p.degraded, true);
  assert.equal(p.rolesOk, 1);
  assert.equal(p.coverage, 0.5);
  assert.equal(p.degradedRoles[0].role, ag.ROLE.SKEPTIC);
});

test('RUNTIME: a totally unconfigured panel is degraded across every role', async () => {
  const p = await ag.runPanel({}, { adapters: {} });
  assert.equal(p.rolesOk, 0);
  assert.equal(p.coverage, 0);
  assert.equal(p.degradedRoles.length, ag.ROLE_ORDER.length);
});

// ── Dissent preservation ────────────────────────────────────────────────────

const fullPanel = async () => ag.runPanel({}, {
  roles: [ag.ROLE.INTAKE, ag.ROLE.SKEPTIC, ag.ROLE.REGIME, ag.ROLE.OPTIONS, ag.ROLE.EXECUTION, ag.ROLE.SYNTHESIS],
  adapters: {
    [ag.ROLE.INTAKE]: adapter('a', { entities: ['AAA'], directionClaim: 'long', ambiguities: ['"might be time to look at" is not a directional claim'] }),
    [ag.ROLE.SKEPTIC]: adapter('a', { counterThesis: 'the move is already consumed', alreadyConsumed: ['ran 14% before the post'], unpricedExecutionRisk: ['no borrow evidence'] }),
    [ag.ROLE.REGIME]: adapter('a', { supporting: ['breadth improving'], contradicting: ['credit deteriorating', 'dollar strengthening'] }),
    [ag.ROLE.OPTIONS]: adapter('a', { structureHypotheses: ['possible hedge', 'possible roll'] }),
    [ag.ROLE.EXECUTION]: adapter('a', { feasibility: 'UNKNOWN', missingInputs: ['spread', 'borrow'] }),
    [ag.ROLE.SYNTHESIS]: adapter('a', { thesis: 'contested long', preservedDissent: ['already consumed'], evidenceGaps: ['no primary source'] }),
  },
});

test('DISSENT: every disagreeing agent is listed individually, never averaged', async () => {
  const merged = ag.mergeAgentOutputs(await fullPanel());
  const agents = merged.dissent.map(d => d.agent);
  assert.ok(agents.includes(ag.ROLE.SKEPTIC));
  assert.ok(agents.includes(ag.ROLE.REGIME));
  assert.ok(agents.includes(ag.ROLE.OPTIONS));
  assert.ok(agents.some(a => a.startsWith('skeptic:')));
  assert.ok(merged.dissent.every(d => !d.resolved), 'nothing is resolved on the caller\'s behalf');
});

test('DISSENT: there is NO aggregate agreement score', async () => {
  const merged = ag.mergeAgentOutputs(await fullPanel());
  assert.equal(merged.agreementScore, null);
  assert.match(merged.agreementNote, /not independent evidence/i);
});

test('DISSENT: a synthesis agent that drops dissent is recorded, not trusted', async () => {
  const merged = ag.mergeAgentOutputs(await fullPanel());
  assert.match(merged.notes.join(' '), /preserved here regardless/i);
});

test('DISSENT: execution missing-inputs become REQUIRED missing evidence', async () => {
  const merged = ag.mergeAgentOutputs(await fullPanel());
  const fields = merged.missingEvidence.map(m => m.field);
  assert.ok(fields.includes('execution.spread'));
  assert.ok(fields.includes('execution.borrow'));
  assert.ok(merged.missingEvidence.filter(m => m.field.startsWith('execution.')).every(m => m.required));
});

test('DISSENT: a degraded agent lane is itself an evidence gap', async () => {
  const p = await ag.runPanel({}, { roles: [ag.ROLE.SKEPTIC], adapters: {} });
  const merged = ag.mergeAgentOutputs(p);
  assert.ok(merged.missingEvidence.some(m => m.field === 'agent.skeptic'));
  assert.match(merged.missingEvidence[0].reason, /contributed nothing/i);
});

// ── Applying agents to a decision cannot break the deterministic layer ──────

const baseDecision = (o = {}) => dc.makeDecision({
  decisionId: 'd1', entity: 'AAA', state: 'SET_ALERT', lifecycle: 'ARMED',
  factConfidence: 'HIGH', evidenceCoverage: 0.9,
  trigger: dc.measured(106, { source: 'chart-math' }),
  invalidation: dc.measured(94, { source: 'chart-math' }),
  targets: [{ level: 118, basis: 'chart-math' }],
  governance: { strategyId: 'xalerts', maturity: 'shadow', tradeEligible: false, weight: 0 },
  ...o,
});

test('APPLY: deterministic levels and governance pass through UNCHANGED', async () => {
  const d = baseDecision();
  const out = ag.applyAgentsToDecision(d, await fullPanel());
  assert.deepEqual(out.trigger, d.trigger);
  assert.deepEqual(out.invalidation, d.invalidation);
  assert.deepEqual(out.targets, d.targets);
  assert.deepEqual(out.governance, d.governance);
  assert.equal(out.governance.tradeEligible, false);
  assert.equal(out.governance.weight, 0);
});

test('APPLY: agent input can only LOWER readiness, never raise it', async () => {
  const d = baseDecision({ factConfidence: 'LOW', evidenceCoverage: 0.2 });
  const before = d.decisionReadiness;
  // A panel with nothing but praise still cannot raise readiness.
  const flattering = await ag.runPanel({}, {
    roles: [ag.ROLE.SYNTHESIS],
    adapters: { [ag.ROLE.SYNTHESIS]: adapter('a', { thesis: 'excellent setup', preservedDissent: [], evidenceGaps: [] }) },
  });
  const out = ag.applyAgentsToDecision(d, flattering);
  const RANK = { UNAVAILABLE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };
  assert.ok(RANK[out.decisionReadiness] <= RANK[before]);
  assert.equal(out.agents.readinessBefore, before);
});

test('APPLY: added dissent downgrades readiness', async () => {
  const d = baseDecision();
  const out = ag.applyAgentsToDecision(d, await fullPanel());
  assert.equal(d.decisionReadiness, 'HIGH');
  assert.notEqual(out.decisionReadiness, 'HIGH');
  assert.ok(out.dissent.length > 0);
});

test('APPLY: ambiguous language REFUSES directional promotion', async () => {
  const d = baseDecision({ state: 'SET_ALERT' });
  const out = ag.applyAgentsToDecision(d, await fullPanel());
  assert.equal(out.state, 'INVESTIGATE');
  assert.equal(out.agents.stateDowngradedByAmbiguity, true);
});

test('APPLY: with clean language the deterministic state survives', async () => {
  const p = await ag.runPanel({}, {
    roles: [ag.ROLE.INTAKE],
    adapters: { [ag.ROLE.INTAKE]: adapter('a', { entities: ['AAA'], directionClaim: 'long', ambiguities: [] }) },
  });
  const d = baseDecision({ state: 'SET_ALERT' });
  assert.equal(ag.applyAgentsToDecision(d, p).state, 'SET_ALERT');
});

test('APPLY: every claim is traceable to a role, adapter, and run', async () => {
  const out = ag.applyAgentsToDecision(baseDecision(), await fullPanel());
  assert.equal(out.agents.provenance.length, ag.ROLE_ORDER.length);
  for (const p of out.agents.provenance) {
    assert.ok(p.role);
    assert.ok('ok' in p);
    if (p.ok) { assert.ok(p.adapterId); assert.ok(p.startedAt); assert.ok(typeof p.elapsedMs === 'number'); }
  }
});

test('APPLY: a decision still validates against the shared contract afterwards', async () => {
  const out = ag.applyAgentsToDecision(baseDecision(), await fullPanel());
  assert.deepEqual(dc.validateDecision(out).errors, []);
});

// ── Adapters / flags / champion-challenger ─────────────────────────────────

test('FLAG: the agent layer is OFF by default and fails closed on garbage', () => {
  assert.equal(ad.resolveAgentsMode(undefined), 'off');
  assert.equal(ad.resolveAgentsMode('nonsense'), 'off');
  assert.equal(ad.agentsEnabled('off'), false);
  assert.equal(ad.agentsEnabled('shadow'), true);
});

test('FLAG: with the layer off, no adapters resolve and the reason says so', () => {
  const r = ad.resolveAdapters({ mode: 'off' });
  assert.deepEqual(r.adapters, {});
  assert.match(r.reason, /NO_ADAPTER/);
});

test('FLAG: with the layer on but no credentials, it degrades rather than fabricating', () => {
  const r = ad.resolveAdapters({ mode: 'shadow', adapterFactory: () => null });
  assert.deepEqual(r.adapters, {});
  assert.match(r.reason, /rather than fabricating/i);
});

test('PROMPT: every role prompt states the no-fabrication rules and its forbidden fields', () => {
  for (const role of ag.ROLE_ORDER) {
    const p = ad.buildAgentPrompt(role, { evidence: 1 });
    assert.match(p, /may NOT invent prices, catalysts, probabilities/i);
    assert.match(p, /Never state a percentage as a chance/i);
    assert.match(p, /FORBIDDEN FIELDS/);
    assert.match(p, new RegExp(`ROLE: ${role}`));
  }
});

test('PROMPT: the calibration brief says plainly it may never promote', () => {
  assert.match(ad.buildAgentPrompt(ag.ROLE.CALIBRATION, {}), /may NEVER promote a strategy/i);
});

test('PROMPT: the options brief says calls are not bullish and puts are not bearish', () => {
  assert.match(ad.buildAgentPrompt(ag.ROLE.OPTIONS, {}), /Calls are not bullish and puts are not bearish/i);
});

test('ADAPTER: JSON is recovered even when the model wraps it in prose', () => {
  assert.deepEqual(ad.parseJsonObject('Here you go:\n{"a":1}\nhope that helps'), { a: 1 });
  assert.equal(ad.parseJsonObject('no json here'), null);
  assert.equal(ad.parseJsonObject('[1,2,3]'), null, 'an array is not an agent output');
});

test('CHAMPION/CHALLENGER: both run in shadow but only the champion is applied', async () => {
  const champ = { [ag.ROLE.INTAKE]: adapter('champ', { entities: ['A'], directionClaim: 'long', ambiguities: [] }) };
  const chal = { [ag.ROLE.INTAKE]: adapter('chal', { entities: ['A'], directionClaim: 'short', ambiguities: ['contested'] }) };
  const r = await ad.runChampionChallenger({}, { championAdapters: champ, challengerAdapters: chal, roles: [ag.ROLE.INTAKE] });
  assert.equal(r.applied.byRole.intake.adapterId, 'champ');
  assert.equal(r.challenger.byRole.intake.adapterId, 'chal');
  assert.equal(r.challengerApplied, false);
  assert.match(r.challengerNote, /cannot reach a decision record/i);
  assert.ok(r.comparison);
});

test('CHAMPION/CHALLENGER: with no challenger configured the run still succeeds', async () => {
  const champ = { [ag.ROLE.INTAKE]: adapter('champ', { entities: ['A'], directionClaim: 'long', ambiguities: [] }) };
  const r = await ad.runChampionChallenger({}, { championAdapters: champ, challengerAdapters: {}, roles: [ag.ROLE.INTAKE] });
  assert.equal(r.challenger, null);
  assert.equal(r.comparison, null);
  assert.equal(r.applied.rolesOk, 1);
});

// ── Degradation-under-stress fixtures the mission asks for ──────────────────

test('STRESS: corrupted adapter output degrades the lane and names the defect', async () => {
  for (const bad of [null, 'not json', 42, [], { }]) {
    const r = await ag.runAgent(ag.ROLE.INTAKE, {}, { adapter: { id: 'c', run: async () => bad }, retries: 0 });
    assert.equal(r.ok, false, `${JSON.stringify(bad)} must not pass`);
    assert.ok(r.errors.length);
  }
});

test('STRESS: conflicting agents produce MORE dissent, not a smoothed middle', async () => {
  const p = await ag.runPanel({}, {
    roles: [ag.ROLE.REGIME, ag.ROLE.SKEPTIC],
    adapters: {
      [ag.ROLE.REGIME]: adapter('a', { supporting: ['tape is strong'], contradicting: ['credit says otherwise'] }),
      [ag.ROLE.SKEPTIC]: adapter('a', { counterThesis: 'the tape strength is two names wide' }),
    },
  });
  const merged = ag.mergeAgentOutputs(p);
  assert.equal(merged.dissent.length, 2);
  assert.equal(merged.agreementScore, null);
});

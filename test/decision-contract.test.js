'use strict';
// SHARED DECISION CONTRACT + DECISION QUEUE — the guarantees the three surfaces rely on.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const dc = require('../lib/decision-contract');
const dq = require('../lib/decision-queue');
const da = require('../lib/decision-adapters');
const flags = require('../lib/decision-queue-flags');

const NOW = Date.parse('2026-08-13T18:00:00Z');
const iso = msFromNow => new Date(NOW + msFromNow).toISOString();

// ── Separated confidence dimensions ─────────────────────────────────────────

test('CONTRACT: modelReliability cannot be LOW/MEDIUM/HIGH without a matching calibration', () => {
  const none = dc.reliabilityFor(null, { eventFamily: 'earnings', regime: 'risk-on', horizon: 'swing' });
  assert.equal(none.level, 'UNPROVEN');
  assert.equal(none.effectiveSample, 0);
  assert.match(none.reason, /No calibration record/i);
});

test('CONTRACT: a calibration for a DIFFERENT cohort does not transfer', () => {
  const wrongCohort = dc.reliabilityFor(
    { cohort: 'fda|risk-off|intraday', frozen: true, outOfSample: true, effectiveN: 400, version: 'v1' },
    { eventFamily: 'earnings', regime: 'risk-on', horizon: 'swing' },
  );
  assert.equal(wrongCohort.level, 'UNPROVEN');
  assert.match(wrongCohort.reason, /does not transfer/i);
});

test('CONTRACT: an in-sample or unfrozen calibration cannot support a level', () => {
  const cohort = { eventFamily: 'earnings', regime: 'risk-on', horizon: 'swing' };
  const key = 'earnings|risk-on|swing';
  assert.equal(dc.reliabilityFor({ cohort: key, frozen: false, outOfSample: true, effectiveN: 400 }, cohort).level, 'UNPROVEN');
  assert.equal(dc.reliabilityFor({ cohort: key, frozen: true, outOfSample: false, effectiveN: 400 }, cohort).level, 'UNPROVEN');
});

test('CONTRACT: a valid calibration yields a level scaled to the EFFECTIVE sample', () => {
  const cohort = { eventFamily: 'earnings', regime: 'risk-on', horizon: 'swing' };
  const key = 'earnings|risk-on|swing';
  const mk = n => dc.reliabilityFor({ cohort: key, frozen: true, outOfSample: true, effectiveN: n, version: 'v1' }, cohort);
  assert.equal(mk(5).level, 'UNPROVEN');
  assert.equal(mk(30).level, 'LOW');
  assert.equal(mk(80).level, 'MEDIUM');
  assert.equal(mk(200).level, 'HIGH');
});

test('CONTRACT: decisionReadiness is the MINIMUM, never an average of the dimensions', () => {
  const r = dc.readinessFor({ factConfidence: 'HIGH', evidenceCoverage: 0.1 });
  assert.equal(r.level, 'LOW', 'high facts with thin coverage must not average up to MEDIUM');
});

test('CONTRACT: unresolved dissent DOWNGRADES readiness rather than being hidden', () => {
  const clean = dc.readinessFor({ factConfidence: 'HIGH', evidenceCoverage: 0.9 });
  const contested = dc.readinessFor({ factConfidence: 'HIGH', evidenceCoverage: 0.9, dissent: [{ agent: 'skeptic', position: 'already consumed', resolved: false }] });
  assert.equal(clean.level, 'HIGH');
  assert.equal(contested.level, 'MEDIUM');
  assert.match(contested.reasons.join(' '), /not averaged away/i);
});

test('CONTRACT: resolved dissent does not penalise', () => {
  const r = dc.readinessFor({ factConfidence: 'HIGH', evidenceCoverage: 0.9, dissent: [{ agent: 'skeptic', position: 'x', resolved: true }] });
  assert.equal(r.level, 'HIGH');
});

test('CONTRACT: a deterministic gate cannot be overridden by any confidence', () => {
  const r = dc.readinessFor({ factConfidence: 'HIGH', evidenceCoverage: 1, deterministicGatePassed: false });
  assert.equal(r.level, 'UNAVAILABLE');
  assert.match(r.reasons[0], /no agent output can raise it/i);
});

test('CONTRACT: missing REQUIRED evidence downgrades readiness', () => {
  const r = dc.readinessFor({ factConfidence: 'HIGH', evidenceCoverage: 0.9, missingEvidence: [{ field: 'execution.spread', required: true }] });
  assert.equal(r.level, 'MEDIUM');
});

// ── Record construction and validation ──────────────────────────────────────

test('CONTRACT: omitted blocks become explicit UNAVAILABLE with reasons, never absent', () => {
  const d = dc.makeDecision({ decisionId: 'x1', entity: 'AAA' });
  for (const k of ['expectationDelta', 'regimeFit', 'crossAssetConfirmation', 'priceReaction', 'positioning', 'portfolioRelevance', 'trigger', 'invalidation', 'timeStop', 'executionConstraints', 'riskPlan']) {
    assert.equal(d[k].available, false, `${k} must be an explicit unavailable block`);
    assert.ok(d[k].reason && d[k].reason.length > 5, `${k} must say WHY it is unavailable`);
  }
});

test('CONTRACT: validation rejects an asserted reliability level with no cohort or sample', () => {
  const bad = { ...dc.makeDecision({ decisionId: 'x', entity: 'A' }), modelReliability: { level: 'HIGH' } };
  const v = dc.validateDecision(bad);
  assert.equal(v.valid, false);
  assert.match(v.errors.join(' '), /calibration cohort/);
  assert.match(v.errors.join(' '), /effective sample/);
});

test('CONTRACT: ACT_NOW is impossible while readiness is UNAVAILABLE', () => {
  const d = dc.makeDecision({ decisionId: 'x', entity: 'A', state: 'ACT_NOW', deterministicGatePassed: false });
  assert.equal(d.decisionReadiness, 'UNAVAILABLE');
  assert.equal(dc.validateDecision(d).valid, false);
});

test('CONTRACT: a well-formed record validates', () => {
  const d = dc.makeDecision({ decisionId: 'x', entity: 'AAA', state: 'SET_ALERT', lifecycle: 'ARMED', factConfidence: 'MEDIUM', evidenceCoverage: 0.7 });
  assert.deepEqual(dc.validateDecision(d).errors, []);
});

// ── Lifecycle ───────────────────────────────────────────────────────────────

test('LIFECYCLE: the full WATCH→ARMED→TRIGGERED→MANAGE path is legal', () => {
  assert.ok(dc.canTransition('WATCH', 'ARMED'));
  assert.ok(dc.canTransition('ARMED', 'TRIGGERED'));
  assert.ok(dc.canTransition('TRIGGERED', 'MANAGE'));
  assert.ok(dc.canTransition('MANAGE', 'INVALIDATED'));
  assert.ok(dc.canTransition('ARMED', 'EXPIRED'));
});

test('LIFECYCLE: terminal states are terminal — an expired decision cannot be resurrected', () => {
  assert.equal(dc.canTransition('EXPIRED', 'ARMED'), false);
  assert.equal(dc.canTransition('INVALIDATED', 'WATCH'), false);
  assert.equal(dc.canTransition('TRIGGERED', 'ARMED'), false, 'a triggered setup cannot un-trigger');
});

test('LIFECYCLE: transition() refuses illegal moves and records legal ones immutably', () => {
  const d = dc.makeDecision({ decisionId: 'x', entity: 'A', lifecycle: 'EXPIRED' });
  const bad = dc.transition(d, 'ARMED');
  assert.equal(bad.changed, false);
  assert.match(bad.reason, /illegal lifecycle transition/);
  assert.equal(bad.decision.lifecycle, 'EXPIRED');

  const w = dc.makeDecision({ decisionId: 'y', entity: 'A', lifecycle: 'WATCH' });
  const ok = dc.transition(w, 'ARMED', { reason: 'trigger approached' });
  assert.equal(ok.changed, true);
  assert.equal(ok.decision.lifecycle, 'ARMED');
  assert.equal(w.lifecycle, 'WATCH', 'the input record must not be mutated');
  assert.equal(ok.decision.whatChanged.at(-1).kind, 'lifecycle');
});

// ── Decision utility ────────────────────────────────────────────────────────

test('UTILITY: the score is never presented as a probability or expected return', () => {
  const u = dq.scoreUtility({ materiality: 0.9 });
  assert.equal(u.isExpectedReturn, false);
  assert.equal(u.isProbability, false);
  assert.match(u.note, /not calibrated/i);
  assert.match(u.note, /not an expected return/i);
  assert.equal(u.version, dq.UTILITY_VERSION);
});

test('UTILITY: every component is exposed, with measured/unmeasured marked', () => {
  const u = dq.scoreUtility({ materiality: 0.8, liquidity: 0.5, crowding: 0.2 });
  for (const k of [...dq.MULTIPLICATIVE, ...dq.PENALTIES]) assert.ok(u.components[k], `${k} must be exposed`);
  assert.equal(u.components.materiality.measured, true);
  assert.equal(u.components.novelty.measured, false);
  assert.match(u.components.novelty.reason, /not at neutral/i);
});

test('UTILITY: a MISSING multiplicative component scores BELOW a measured neutral one', () => {
  const missing = dq.scoreUtility({ materiality: 0.8 });
  const present = dq.scoreUtility({ materiality: 0.8, novelty: 0.5, evidenceQuality: 0.5, regimeFit: 0.5, reactionGap: 0.5, portfolioRelevance: 0.5, liquidity: 0.5 });
  assert.ok(present.score > missing.score, 'unmeasured evidence must not score like measured neutral evidence');
});

test('UTILITY: an UNMEASURED penalty is charged, not assumed absent', () => {
  const unchecked = dq.scoreUtility({ materiality: 0.8, novelty: 0.8, evidenceQuality: 0.8, regimeFit: 0.8, reactionGap: 0.8, portfolioRelevance: 0.8, liquidity: 0.8 });
  const checkedClean = dq.scoreUtility({ materiality: 0.8, novelty: 0.8, evidenceQuality: 0.8, regimeFit: 0.8, reactionGap: 0.8, portfolioRelevance: 0.8, liquidity: 0.8, crowding: 0, eventRisk: 0, executionCost: 0 });
  assert.ok(checkedClean.score > unchecked.score);
  assert.match(unchecked.components.crowding.reason, /assumed absent/i);
});

test('UTILITY: one zero component zeroes the score — no strength compensates for it', () => {
  const u = dq.scoreUtility({ materiality: 1, novelty: 1, evidenceQuality: 0, regimeFit: 1, reactionGap: 1, portfolioRelevance: 1, liquidity: 1, crowding: 0, eventRisk: 0, executionCost: 0 });
  assert.equal(u.score, 0);
});

test('UTILITY: the score still discriminates — it does not collapse to zero for everyone', () => {
  const strong = dq.scoreUtility({ materiality: 0.9, novelty: 0.9, evidenceQuality: 0.9, regimeFit: 1, reactionGap: 0.9, portfolioRelevance: 0.8, liquidity: 0.9, crowding: 0.1, eventRisk: 0.1, executionCost: 0.1 });
  const weak = dq.scoreUtility({ materiality: 0.9, novelty: 0.9, evidenceQuality: 0.05, regimeFit: 1, reactionGap: 0.9, portfolioRelevance: 0.8, liquidity: 0.9, crowding: 0.1, eventRisk: 0.1, executionCost: 0.1 });
  assert.ok(strong.score > 0.5 && strong.score <= 1);
  assert.ok(weak.score > 0 && weak.score < strong.score);
});

// ── Queue ranking ───────────────────────────────────────────────────────────

const mkD = (id, o = {}) => dc.makeDecision({ decisionId: id, entity: id, ...o });

test('QUEUE: state band dominates utility — a strong AVOID never outranks a weak ACT_NOW', () => {
  const act = { ...mkD('a', { state: 'ACT_NOW', factConfidence: 'HIGH', evidenceCoverage: 0.9 }), utility: dq.scoreUtility({ materiality: 0.1 }) };
  const avoid = { ...mkD('b', { state: 'AVOID' }), utility: dq.scoreUtility({ materiality: 1, novelty: 1, evidenceQuality: 1, regimeFit: 1, reactionGap: 1, portfolioRelevance: 1, liquidity: 1, crowding: 0, eventRisk: 0, executionCost: 0 }) };
  const q = dq.buildQueue([avoid, act], { now: NOW });
  assert.equal(q.queue[0].decisionId, 'a');
});

test('QUEUE: a record past its own expiresAt is demoted out of the actionable bands', () => {
  const stale = mkD('s', { state: 'ACT_NOW', lifecycle: 'ARMED', expiresAt: iso(-3600_000), factConfidence: 'HIGH', evidenceCoverage: 0.9 });
  const q = dq.buildQueue([stale], { now: NOW });
  assert.equal(q.queue[0].state, 'AVOID');
  assert.equal(q.queue[0].lifecycle, 'EXPIRED');
  assert.equal(q.queue[0].expiredByClock, true);
  assert.match(q.queue[0].queueReasons[0], /Past its own expiresAt/);
});

test('QUEUE: ordering is deterministic across rebuilds', () => {
  const items = ['a', 'b', 'c'].map(id => ({ ...mkD(id, { state: 'INVESTIGATE' }), utility: dq.scoreUtility({}) }));
  const ids = () => dq.buildQueue(items, { now: NOW }).queue.map(d => d.decisionId);
  assert.deepEqual(ids(), ids());
  assert.deepEqual(ids(), ['a', 'b', 'c']);
});

test('QUEUE: coverage is summarised so thin-evidence queues are visible', () => {
  const q = dq.buildQueue([mkD('a'), mkD('b')], { now: NOW });
  assert.equal(q.coverageSummary.recordsWithMissingComponents, 2);
  assert.ok(q.coverageSummary.meanComponentCoverage < 0.5);
});

// ── Bet clustering ──────────────────────────────────────────────────────────

test('CLUSTER: decisions expressing the same underlying bet collapse into one cluster', () => {
  const a = mkD('a', { entity: 'NVDA', factState: { side: 'long', betKey: 'ai-capex' } });
  const b = mkD('b', { entity: 'AVGO', factState: { side: 'long', betKey: 'ai-capex' } });
  const c = mkD('c', { entity: 'XOM', factState: { side: 'long', betKey: 'energy' } });
  const q = dq.buildQueue([a, b, c], { now: NOW });
  const aiCluster = q.clusters.find(x => x.betKey === 'ai-capex');
  assert.equal(aiCluster.size, 2);
  assert.deepEqual(aiCluster.entities.sort(), ['AVGO', 'NVDA']);
  assert.match(aiCluster.concentrationWarning, /same underlying bet/i);
  assert.equal(q.clusters.find(x => x.betKey === 'energy').concentrationWarning, null);
});

test('CLUSTER: opposite sides of the same theme are NOT the same bet', () => {
  const a = mkD('a', { entity: 'NVDA', factState: { side: 'long', betKey: 'ai-capex' } });
  const b = mkD('b', { entity: 'AVGO', factState: { side: 'short', betKey: 'ai-capex' } });
  const q = dq.buildQueue([a, b], { now: NOW });
  assert.equal(q.clusters.length, 2);
});

// ── Transition-only alerting ────────────────────────────────────────────────

test('ALERTS: re-observing the SAME state emits nothing', () => {
  const d = mkD('a', { state: 'ACT_NOW', lifecycle: 'TRIGGERED', factConfidence: 'HIGH', evidenceCoverage: 0.9 });
  const q = dq.buildQueue([d], { now: NOW });
  const first = dq.transitionAlerts(null, q.queue, { now: NOW });
  assert.equal(first.alerts.length, 1, 'arriving already-actionable is a transition');
  const second = dq.transitionAlerts(first.nextState, q.queue, { now: NOW + 10_000_000 });
  assert.equal(second.alerts.length, 0, 'the same state observed again must NOT re-alert');
});

test('ALERTS: a genuine state change fires once and is deduped by transition id', () => {
  const watch = mkD('a', { state: 'SET_ALERT', lifecycle: 'ARMED' });
  const fired = mkD('a', { state: 'ACT_NOW', lifecycle: 'TRIGGERED', factConfidence: 'HIGH', evidenceCoverage: 0.9 });
  const s0 = dq.transitionAlerts(null, dq.buildQueue([watch], { now: NOW }).queue, { now: NOW });
  assert.equal(s0.alerts.length, 0, 'a new SET_ALERT is not news');
  const s1 = dq.transitionAlerts(s0.nextState, dq.buildQueue([fired], { now: NOW }).queue, { now: NOW + 10_000_000 });
  assert.equal(s1.alerts.length, 1);
  assert.equal(s1.alerts[0].from.lifecycle, 'ARMED');
  assert.equal(s1.alerts[0].to.lifecycle, 'TRIGGERED');
  assert.ok(s1.alerts[0].transitionId.includes('ARMED'));
});

test('ALERTS: the cooldown suppresses a rapid re-fire but still records the state', () => {
  const a = mkD('a', { state: 'SET_ALERT', lifecycle: 'ARMED' });
  const b = mkD('a', { state: 'ACT_NOW', lifecycle: 'TRIGGERED', factConfidence: 'HIGH', evidenceCoverage: 0.9 });
  const c = mkD('a', { state: 'MANAGE', lifecycle: 'MANAGE' });
  const s0 = dq.transitionAlerts(null, dq.buildQueue([a], { now: NOW }).queue, { now: NOW });
  const s1 = dq.transitionAlerts(s0.nextState, dq.buildQueue([b], { now: NOW }).queue, { now: NOW + 10_000_000 });
  const s2 = dq.transitionAlerts(s1.nextState, dq.buildQueue([c], { now: NOW }).queue, { now: NOW + 10_060_000 });
  assert.equal(s1.alerts.length, 1);
  assert.equal(s2.alerts.length, 0, 'inside the cooldown');
  assert.equal(s2.nextState.a.lifecycle, 'MANAGE', 'but the state is still tracked');
});

// ── Adapters ────────────────────────────────────────────────────────────────

const alertRow = (o = {}) => ({
  episodeId: 'e1', ticker: 'AAA', side: 'long', action: 'REVIEW', setupState: 'FORMING',
  catalystStatus: 'VERIFIED_SECONDARY', reasons: ['independent long setup'], trigger: 106, invalidation: 94, target: 118, rr: 2,
  freshness: { state: 'FRESH', horizonBucket: 'swing', expiresAt: iso(864e5), ttlHours: { stale: 168 }, version: 'f1' },
  execution: { state: 'OK', coverage: 1, creditFraction: 0.8, missingRequired: [], components: {}, version: 'x1' },
  regimeFit: { alignment: 'TAILWIND', creditFraction: 1, coverage: 1, vetoes: [], version: 'r1', market: { tape: 'supportive' } },
  priceAtAlert: { state: 'CAPTURED', price: 100, version: 'p1' },
  moveSinceAlert: { available: true, consumedPct: 2, movePct: 2, verified: true },
  ...o,
});

test('ADAPTER: an alerts decision maps to a valid shared record', () => {
  const d = da.fromAlertDecision(alertRow());
  assert.deepEqual(dc.validateDecision(d).errors, []);
  assert.equal(d.source, 'alerts');
  assert.equal(d.entity, 'AAA');
});

test('ADAPTER: the SHADOW alerts layer can never reach ACT_NOW', () => {
  for (const action of ['REVIEW', 'WAIT', 'AVOID', 'EXIT/REASSESS']) {
    const d = da.fromAlertDecision(alertRow({ action }));
    assert.notEqual(d.state, 'ACT_NOW', `action ${action} must not become ACT_NOW`);
  }
});

test('ADAPTER: a missing alert price becomes REQUIRED missing evidence, not a silent gap', () => {
  const d = da.fromAlertDecision(alertRow({
    priceAtAlert: { state: 'LEGACY_NOT_CAPTURED', price: null, reason: 'predates capture' },
    moveSinceAlert: { available: false, reason: 'no alert price' },
  }));
  const m = d.missingEvidence.find(x => x.field === 'priceAtAlert');
  assert.ok(m && m.required);
  assert.equal(d.priceReaction.available, false);
});

test('ADAPTER: missing execution evidence appears per-field in missingEvidence', () => {
  const d = da.fromAlertDecision(alertRow({
    execution: { state: 'UNKNOWN', coverage: 0, creditFraction: 0, missingRequired: ['liquidity', 'spread'], components: { liquidity: { reason: 'no ADV' }, spread: { reason: 'no quote' } }, version: 'x1' },
  }));
  const fields = d.missingEvidence.map(m => m.field);
  assert.ok(fields.includes('execution.liquidity'));
  assert.ok(fields.includes('execution.spread'));
});

test('ADAPTER: a regime veto is preserved as DISSENT, not folded into the score', () => {
  const d = da.fromAlertDecision(alertRow({
    regimeFit: { alignment: 'HEADWIND', creditFraction: 0.15, coverage: 1, version: 'r1', market: { tape: 'risk-off' }, vetoes: [{ source: 'market', reason: 'risk-off tape is a headwind for a long' }] },
  }));
  assert.ok(d.dissent.some(x => x.agent === 'regime:market'));
  assert.ok(d.dissent.every(x => !x.resolved));
});

test('ADAPTER: a coordinated promotion is recorded as dissent', () => {
  const d = da.fromAlertDecision(alertRow({ coordinated: true }));
  assert.ok(d.dissent.some(x => x.agent === 'coordination'));
});

test('ADAPTER: social sources are labelled as leads, never as verified facts', () => {
  const d = da.fromAlertDecision(alertRow({ handle: 'someone' }));
  assert.equal(d.sources[0].kind, 'social');
  assert.match(d.sources[0].note, /not a verified fact/i);
});

test('ADAPTER: an unconfirmed Pulse narrative can only ever be INVESTIGATE', () => {
  const d = da.fromPulseEvent({ eventId: 'p1', entity: 'SPY', claimStatus: 'VERIFIED', priceConfirmed: false, headline: 'x', sourceCount: 5 });
  assert.equal(d.state, 'INVESTIGATE');
  assert.equal(d.priceReaction.available, false);
  assert.match(d.priceReaction.reason, /attention is not a trade signal/i);
  assert.ok(d.missingEvidence.some(m => m.field === 'priceReaction' && m.required));
});

test('ADAPTER: a syndicated copy scores near-zero NOVELTY — freshness alone is not rank', () => {
  const fresh = da.fromPulseEvent({ eventId: 'p1', entity: 'A', claimStatus: 'VERIFIED', freshnessReason: 'NEW_PUBLICATION', priceConfirmed: true, sourceCount: 3 });
  const copy = da.fromPulseEvent({ eventId: 'p2', entity: 'A', claimStatus: 'VERIFIED', freshnessReason: 'SYNDICATED_COPY', priceConfirmed: true, sourceCount: 3 });
  assert.ok(fresh.utility.score > copy.utility.score);
  assert.equal(copy.utility.components.novelty.value, 0.1);
});

test('ADAPTER: options false-positive hypotheses become preserved dissent', () => {
  const d = da.fromOptionsEvent({
    eventId: 'o1', ticker: 'AAA', tradeStatus: 'WATCH_FOR_PRICE_TRIGGER', anomalyScore: 80, dataQuality: 0.9,
    falsePositiveHypotheses: { hypotheses: [
      { id: 'hedge', statement: 'index put hedge', verdict: 'UNRESOLVED', evidence: [] },
      { id: 'roll', statement: 'a roll of an existing position', verdict: 'REFUTED', evidence: [] },
    ] },
  });
  const ids = d.dissent.map(x => x.agent);
  assert.ok(ids.includes('false-positive:hedge'), 'an unrefuted benign explanation must contest the read');
  assert.ok(!ids.includes('false-positive:roll'), 'a refuted hypothesis is not dissent');
});

test('ADAPTER: options without price confirmation carries no trade gate', () => {
  const d = da.fromOptionsEvent({ eventId: 'o1', ticker: 'A', tradeStatus: 'ACTIVITY_ONLY', anomalyScore: 95, dataQuality: 1 });
  assert.equal(d.priceReaction.available, false);
  assert.match(d.priceReaction.reason, /options activity alone is not actionable/i);
  assert.notEqual(d.state, 'ACT_NOW');
});

test('ADAPTER: a missing contract-liquidity check is REQUIRED missing evidence', () => {
  const d = da.fromOptionsEvent({ eventId: 'o1', ticker: 'A', tradeStatus: 'READY', anomalyScore: 80, dataQuality: 1 });
  assert.ok(d.missingEvidence.some(m => m.field === 'contractLiquidity' && m.required));
  assert.equal(d.executionConstraints.available, false);
});

test('ADAPTER: no adapter ever asserts a calibrated model reliability', () => {
  const records = [
    da.fromAlertDecision(alertRow()),
    da.fromPulseEvent({ eventId: 'p', entity: 'A', claimStatus: 'VERIFIED', priceConfirmed: true, sourceCount: 3 }),
    da.fromOptionsEvent({ eventId: 'o', ticker: 'A', tradeStatus: 'READY', anomalyScore: 80, dataQuality: 1 }),
  ];
  for (const d of records) assert.equal(d.modelReliability.level, 'UNPROVEN', `${d.source} must not claim calibration`);
});

// ── Flag / rollback ─────────────────────────────────────────────────────────

test('FLAG: the Decision Queue is OFF by default — the change is opt-in and reversible', () => {
  assert.equal(flags.resolveDecisionQueueMode(undefined), 'off');
  assert.equal(flags.decisionQueueEnabled('off'), false);
  assert.equal(flags.decisionQueueEnabled('shadow'), true);
  assert.equal(flags.decisionQueueIsShadow('shadow'), true);
  assert.equal(flags.decisionQueueIsShadow('on'), false);
  assert.equal(flags.resolveDecisionQueueMode('garbage'), 'off', 'an unknown value fails closed');
});

test('GOVERNANCE: the queue declares itself weight-0 and non-trade-eligible', () => {
  const { queueGovernance } = require('../lib/decision-queue-routes');
  const g = queueGovernance('on');
  assert.equal(g.tradeEligible, false);
  assert.equal(g.weight, 0);
  assert.match(g.note, /cannot change any strategy/i);
});

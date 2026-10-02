'use strict';
// lib/llm-judge — vendored autoevals templates, grade→score mapping, deterministic sampling,
// and the shadow second read's never-throw / never-block contract (fake client, no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const J = require('../lib/llm-judge');
const U = require('../lib/llm-usage');

const ITEMS = [
  { title: 'Acme beats Q3 EPS estimates by $0.12, raises FY guidance 8%', text: '', url: 'https://a/1', publisher: 'Reuters' },
  { title: 'Acme shares jump after results', text: '', url: 'https://a/2', publisher: 'CNBC' },
  { title: 'Three stocks to watch this week', text: '', url: 'https://a/3', publisher: 'Blog' },
];
const EVENT = { eventType: 'earnings', claim: 'Beat Q3 EPS by $0.12 and raised FY guidance 8%', quantitativeMagnitude: 0.12, sourceIndexes: [0, 1] };

const gradeMsg = (choice, rationale = 'because') => ({
  model: 'claude-haiku-4-5-20251001', stop_reason: 'tool_use', usage: { input_tokens: 400, output_tokens: 40 },
  content: [{ type: 'tool_use', name: 'submit_grade', input: { choice, rationale } }],
});
const fakeClient = (msgOrFn) => ({ messages: { create: async (req) => (typeof msgOrFn === 'function' ? msgOrFn(req) : msgOrFn) } });

test.beforeEach(() => { J._resetForTests(); U._resetForTests(); });

test('vendored templates keep autoevals placeholders and choice scores verbatim', () => {
  assert.match(J.FACTUALITY_TEMPLATE, /\{\{input\}\}[\s\S]*\{\{expected\}\}[\s\S]*\{\{output\}\}/);
  assert.match(J.FACTUALITY_TEMPLATE, /\(E\) The answers differ/);
  assert.deepEqual(J.FACTUALITY_CHOICE_SCORES, { A: 0.4, B: 0.6, C: 1, D: 0, E: 1 });
  assert.match(J.CLOSED_QA_TEMPLATE, /\{\{criteria\}\}/);
  assert.deepEqual(J.CLOSED_QA_CHOICE_SCORES, { Y: 1, N: 0 });
  assert.match(J.AUTOEVALS_SOURCE, /braintrustdata\/autoevals/);
});

test('renderTemplate substitutes every {{var}} and blanks unknowns', () => {
  assert.equal(J.renderTemplate('a {{x}} b {{ y }} c {{z}}', { x: 1, y: 'two' }), 'a 1 b two c ');
});

test('scoreChoice maps letters case-insensitively and rejects unknown choices', () => {
  assert.equal(J.scoreChoice('c', J.FACTUALITY_CHOICE_SCORES), 1);
  assert.equal(J.scoreChoice(' D ', J.FACTUALITY_CHOICE_SCORES), 0);
  assert.equal(J.scoreChoice('A', J.FACTUALITY_CHOICE_SCORES), 0.4);
  assert.equal(J.scoreChoice('Z', J.FACTUALITY_CHOICE_SCORES), null);
  assert.equal(J.scoreChoice(null, J.CLOSED_QA_CHOICE_SCORES), null);
  assert.equal(J.scoreChoice('n', J.CLOSED_QA_CHOICE_SCORES), 0);
});

test('buildJudgeRequest: Haiku, forced strict-shaped submit_grade tool whose enum is exactly the choice set', () => {
  const req = J.buildJudgeRequest({ template: J.CLOSED_QA_TEMPLATE, vars: { input: 'i', output: 'o', criteria: 'c' }, choiceScores: J.CLOSED_QA_CHOICE_SCORES });
  assert.equal(req.model, J.JUDGE_MODEL);
  assert.deepEqual(req.tool_choice, { type: 'tool', name: 'submit_grade' });
  assert.deepEqual(req.tools[0].input_schema.properties.choice.enum, ['Y', 'N']);
  assert.deepEqual(req.tools[0].input_schema.required, ['choice', 'rationale']);
  assert.match(req.messages[0].content, /\[Criterion\]: c/);
  assert.equal(req.max_tokens, 400);
  const fact = J.buildJudgeRequest({ template: J.FACTUALITY_TEMPLATE, vars: {}, choiceScores: J.FACTUALITY_CHOICE_SCORES });
  assert.deepEqual(fact.tools[0].input_schema.properties.choice.enum, ['A', 'B', 'C', 'D', 'E']);
});

test('parseGrade: ok / refused / failed are distinct outcomes', () => {
  assert.deepEqual(J.parseGrade(gradeMsg('Y', 'fine'), J.CLOSED_QA_CHOICE_SCORES), { choice: 'Y', score: 1, rationale: 'fine', outcome: 'ok', model: 'claude-haiku-4-5-20251001' });
  assert.equal(J.parseGrade({ stop_reason: 'refusal', stop_details: { category: 'x' }, content: [] }, J.CLOSED_QA_CHOICE_SCORES).outcome, 'refused');
  assert.equal(J.parseGrade({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Y' }] }, J.CLOSED_QA_CHOICE_SCORES).outcome, 'failed', 'prose is not a grade');
  assert.equal(J.parseGrade(gradeMsg('Q'), J.CLOSED_QA_CHOICE_SCORES).outcome, 'failed', 'off-enum choice is a failure, not a score');
});

test('judgeFraction: env default 0, clamps to [0,1], junk → 0', () => {
  assert.equal(J.judgeFraction({}), 0);
  assert.equal(J.judgeFraction({ LLM_JUDGE_FRACTION: '0.1' }), 0.1);
  assert.equal(J.judgeFraction({ LLM_JUDGE_FRACTION: '7' }), 1);
  assert.equal(J.judgeFraction({ LLM_JUDGE_FRACTION: 'lots' }), 0);
  assert.equal(J.judgeFraction({ LLM_JUDGE_FRACTION: '-1' }), 0);
});

test('shouldSample is deterministic and lands near the requested fraction', () => {
  assert.equal(J.shouldSample('k', 0), false);
  assert.equal(J.shouldSample('k', 1), true);
  const keys = Array.from({ length: 4000 }, (_, i) => `T${i}:fp${i}`);
  const hits = keys.filter(k => J.shouldSample(k, 0.1)).length;
  assert.ok(hits > 300 && hits < 500, `10% of 4000 should be ~400, got ${hits}`);
  assert.deepEqual(keys.map(k => J.shouldSample(k, 0.1)), keys.map(k => J.shouldSample(k, 0.1)), 'same key → same decision');
});

test('eventSupportVars cites ONLY the valid indexes the extractor named, and carries the figure', () => {
  const v = J.eventSupportVars('ACME', { ...EVENT, sourceIndexes: [0, 1, 1, 9, -1, 'x'] }, ITEMS);
  assert.match(v.input, /\[0\] Acme beats/);
  assert.match(v.input, /\[1\] Acme shares jump/);
  assert.doesNotMatch(v.input, /Three stocks/);
  assert.equal((v.input.match(/\n\[/g) || []).length, 2, 'dedup + bounds-check');
  assert.match(v.output, /quantitativeMagnitude=0\.12/);
  assert.equal(v.criteria, J.SUPPORT_CRITERION);
});

test('judgeEventSupport: an event citing nothing is graded N mechanically (no API call)', async () => {
  let calls = 0;
  const r = await J.judgeEventSupport({ ticker: 'ACME', event: { ...EVENT, sourceIndexes: [] }, items: ITEMS, client: fakeClient(() => { calls++; return gradeMsg('Y'); }) });
  assert.equal(calls, 0);
  assert.equal(r.score, 0);
  assert.equal(r.model, 'mechanical');
});

test('runJudge never throws and records usage under the llm-judge call site', async () => {
  const ok = await J.runJudge({ template: J.CLOSED_QA_TEMPLATE, vars: {}, choiceScores: J.CLOSED_QA_CHOICE_SCORES, client: fakeClient(gradeMsg('N', 'invented 8%')) });
  assert.equal(ok.outcome, 'ok');
  assert.equal(ok.score, 0);
  assert.equal(U.peekBuffer().days[Object.keys(U.peekBuffer().days)[0]].byCallSite['llm-judge'].calls, 1);
  const boom = await J.runJudge({ template: J.CLOSED_QA_TEMPLATE, vars: {}, choiceScores: J.CLOSED_QA_CHOICE_SCORES, client: fakeClient(() => { throw new Error('timeout'); }) });
  assert.equal(boom.outcome, 'failed');
  assert.match(boom.error, /timeout/);
  const noKey = await J.runJudge({ template: J.CLOSED_QA_TEMPLATE, vars: {}, choiceScores: J.CLOSED_QA_CHOICE_SCORES, client: null });
  if (!process.env.ANTHROPIC_API_KEY) assert.equal(noKey.error, 'no-api-key');
});

test('sampleAndJudgeExtraction: fraction 0 → not sampled, zero calls (the test/default posture)', async () => {
  let calls = 0;
  const r = await J.sampleAndJudgeExtraction({ ticker: 'ACME', items: ITEMS, events: [EVENT], fingerprint: 'fp', promptVersion: 'extract-v1', fraction: 0, client: fakeClient(() => { calls++; return gradeMsg('Y'); }) });
  assert.deepEqual(r, { sampled: false, reason: 'fraction-0' });
  assert.equal(calls, 0);
});

test('sampleAndJudgeExtraction: fraction 1 grades every event, persists one cumulative shard, summarizes agreement', async () => {
  const writes = [];
  const store = { hasStore: () => true, writeJSON: async (path, doc) => { writes.push({ path, doc }); } };
  const client = fakeClient(req => (/\[Submission\]: Beat/.test(req.messages[0].content) ? gradeMsg('Y') : gradeMsg('N', 'number not in headline')));
  const events = [EVENT, { eventType: 'guidance', claim: 'Raised FY guidance 12%', sourceIndexes: [0] }, { eventType: 'macro', claim: 'x', sourceIndexes: [] }];
  const r = await J.sampleAndJudgeExtraction({ ticker: 'ACME', items: ITEMS, events, fingerprint: 'fp1', promptVersion: 'extract-v1', fraction: 1, client, store, now: Date.parse('2026-10-02T12:00:00Z') });
  assert.equal(r.sampled, true);
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.rows.map(x => x.supported), [true, false, false]);
  assert.equal(r.rows[0].key, '2026-10-02:ACME:fp1:0');
  assert.equal(r.summary.graded, 3);
  assert.equal(r.summary.agreementRate, 0.3333);
  assert.equal(r.summary.byEventType.earnings.supported, 1);
  assert.equal(r.persisted, true);
  assert.equal(writes.length, 1);
  assert.match(writes[0].path, /^judge\/v1\/2026-10-02\/[a-z0-9-]+\.json$/);
  assert.equal(writes[0].doc.rows.length, 3);

  // A second sample the same day appends: the shard is cumulative for this process.
  await J.sampleAndJudgeExtraction({ ticker: 'BETA', items: ITEMS, events: [EVENT], fingerprint: 'fp2', promptVersion: 'extract-v1', fraction: 1, client, store, now: Date.parse('2026-10-02T13:00:00Z') });
  assert.equal(writes[1].doc.rows.length, 4);
});

test('sampleAndJudgeExtraction never throws: a client that explodes yields failed rows, a broken store yields persisted:false', async () => {
  const client = fakeClient(() => { throw new Error('boom'); });
  const store = { hasStore: () => true, writeJSON: async () => { throw new Error('blob down'); } };
  const r = await J.sampleAndJudgeExtraction({ ticker: 'ACME', items: ITEMS, events: [EVENT], fingerprint: 'fp', promptVersion: 'v', fraction: 1, client, store });
  assert.equal(r.sampled, true);
  assert.equal(r.rows[0].outcome, 'failed');
  assert.equal(r.summary.failed, 1);
  assert.equal(r.summary.agreementRate, null, 'no graded rows → no rate, never a fake 0%');
  assert.equal(r.persisted, false);
});

test('readJudgeDay folds shards and dedups rows by key', async () => {
  const row = (key, score) => ({ key, outcome: 'ok', score, eventType: 'earnings', promptVersion: 'extract-v1' });
  const store = {
    hasStore: () => true,
    readAllByPrefix: async () => [{ rows: [row('a', 1), row('b', 0)] }, { rows: [row('b', 0), row('c', 1)] }, null],
  };
  const d = await J.readJudgeDay('2026-10-02', { store });
  assert.equal(d.shards, 2);
  assert.equal(d.rows.length, 3);
  assert.equal(d.summary.agreementRate, 0.6667);
});

test('summarizeJudgeRows groups by event type and prompt version', () => {
  const rows = [
    { outcome: 'ok', score: 1, eventType: 'earnings', promptVersion: 'v1' },
    { outcome: 'ok', score: 0, eventType: 'earnings', promptVersion: 'v2' },
    { outcome: 'refused' }, { outcome: 'failed' },
  ];
  const s = J.summarizeJudgeRows(rows);
  assert.equal(s.n, 4); assert.equal(s.graded, 2); assert.equal(s.refused, 1); assert.equal(s.failed, 1);
  assert.deepEqual(s.byPromptVersion, { v1: { n: 1, supported: 1 }, v2: { n: 1, supported: 0 } });
});

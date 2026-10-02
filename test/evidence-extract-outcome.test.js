'use strict';
// lib/evidence-extract — the refusal / empty / failed split (proposal #8 fix) and the request
// shape the eval harness builds through. Fake client only; the judge is disabled (judge:false)
// or run at fraction 0 so no second read ever fires here.
const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../lib/evidence-extract');
const U = require('../lib/llm-usage');

const NEWS = [
  { title: 'Acme beats Q3 EPS estimates by $0.12, raises FY guidance 8%', url: 'https://r/1', publisher: 'Reuters', datetime: '2026-09-30T12:00:00Z' },
  { title: 'Acme shares jump 9% after results', url: 'https://c/2', publisher: 'CNBC', datetime: '2026-09-30T14:00:00Z' },
  { title: 'Three stocks to watch this week', url: 'https://b/3', publisher: 'Blog', datetime: '2026-09-29T09:00:00Z' },
];
const RAW_EVENT = {
  eventType: 'earnings', claim: 'Beat Q3 EPS by $0.12 and raised FY guidance 8%', direction: 'positive',
  affectedHorizon: 'swing', noveltyScore: 0.8, materialityScore: 0.7, quantitativeMagnitude: 0.12, sourceIndexes: [0, 1, 7],
};
const toolMsg = (input) => ({ model: X.MODEL, stop_reason: 'tool_use', usage: { input_tokens: 900, output_tokens: 120 }, content: [{ type: 'tool_use', name: 'submit_events', input }] });
const fakeClient = (fn) => ({ messages: { create: async (req, opts) => fn(req, opts) } });

test.beforeEach(() => U._resetForTests());

test('buildExtractRequest: Haiku, forced submit_events, numbered headlines in one user turn', () => {
  const req = X.buildExtractRequest('ACME', 'Acme Corp', NEWS);
  assert.equal(req.model, X.MODEL);
  assert.equal(req.max_tokens, X.MAX_TOKENS);
  assert.deepEqual(req.tool_choice, { type: 'tool', name: 'submit_events' });
  assert.equal(req.tools[0], X.EXTRACT_TOOL);
  assert.equal(req.messages.length, 1);
  assert.match(req.messages[0].content, /\[0\] \(2026-09-30 — Reuters\) Acme beats/);
  assert.match(req.messages[0].content, /\[2\] /);
  assert.match(req.messages[0].content, /Acme Corp \(ACME\)/);
});

test('ok: events are normalized, sources attached from the cited indexes only, outcome ok', async () => {
  const client = fakeClient(() => toolMsg({ events: [RAW_EVENT] }));
  const r = await X.extractEvents('ACME', { company: 'Acme', news: NEWS, detectedAt: '2026-10-01', client, judge: false });
  assert.equal(r.outcome, 'ok');
  assert.equal(r.called, true);
  assert.equal(r.error, null);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].sources.length, 2, 'index 7 is out of range and dropped');
  assert.equal(r.events[0].extractor.promptVersion, X.PROMPT_VERSION);
  assert.equal(r.promptVersion, 'extract-v1');
});

test('empty: the model honestly returning zero events is outcome empty, not a failure', async () => {
  const r = await X.extractEvents('ACME', { news: NEWS, client: fakeClient(() => toolMsg({ events: [] })), judge: false });
  assert.equal(r.outcome, 'empty');
  assert.equal(r.called, true);
  assert.deepEqual(r.events, []);
  assert.equal(r.error, null);
});

test('refused: stop_reason refusal is surfaced as outcome refused with the category', async () => {
  const client = fakeClient(() => ({ model: X.MODEL, stop_reason: 'refusal', stop_details: { category: 'frontier_llm' }, content: [], usage: { input_tokens: 10, output_tokens: 0 } }));
  const r = await X.extractEvents('ACME', { news: NEWS, client, judge: false });
  assert.equal(r.outcome, 'refused');
  assert.equal(r.called, true);
  assert.equal(r.error, 'frontier_llm');
  assert.deepEqual(r.events, []);
});

test('failed: a thrown transport error, a prose answer, and a malformed tool input are all outcome failed', async () => {
  const thrown = await X.extractEvents('ACME', { news: NEWS, client: fakeClient(() => { throw new Error('ETIMEDOUT'); }), judge: false });
  assert.equal(thrown.outcome, 'failed');
  assert.match(thrown.error, /ETIMEDOUT/);
  const prose = await X.extractEvents('ACME', { news: NEWS, client: fakeClient(() => ({ model: X.MODEL, stop_reason: 'end_turn', content: [{ type: 'text', text: 'nothing' }] })), judge: false });
  assert.equal(prose.outcome, 'failed');
  assert.equal(prose.error, 'malformed_tool_input');
  const malformed = await X.extractEvents('ACME', { news: NEWS, client: fakeClient(() => toolMsg({ events: 'yes' })), judge: false });
  assert.equal(malformed.outcome, 'failed');
});

test('no headlines: not called, outcome empty (nothing to extract is not a data gap)', async () => {
  const r = await X.extractEvents('ACME', { news: [], judge: false });
  assert.equal(r.called, false);
  assert.equal(r.outcome, 'empty');
});

test('OUTCOMES is the closed set consumers may switch on', () => {
  assert.deepEqual(X.OUTCOMES, ['ok', 'empty', 'refused', 'failed']);
});

test('every call records usage under the evidence-extract call site, refusals included', async () => {
  await X.extractEvents('ACME', { news: NEWS, client: fakeClient(() => toolMsg({ events: [RAW_EVENT] })), judge: false });
  await X.extractEvents('ACME', { news: NEWS, client: fakeClient(() => ({ model: X.MODEL, stop_reason: 'refusal', content: [], usage: { input_tokens: 10, output_tokens: 0 } })), judge: false });
  const days = U.peekBuffer().days;
  const site = days[Object.keys(days)[0]].byCallSite[X.CALL_SITE];
  assert.equal(site.calls, 2);
  assert.equal(site.tokens.input, 910);
});

test('judge hook: default fraction 0 fires no second read; a judge object with fraction 1 does, without blocking the result', async () => {
  const seen = [];
  const client = fakeClient(req => {
    seen.push(req.tools[0].name);
    if (req.tools[0].name === 'submit_grade') return { model: 'claude-haiku-4-5-20251001', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'submit_grade', input: { choice: 'Y', rationale: 'ok' } }], usage: { input_tokens: 1, output_tokens: 1 } };
    return toolMsg({ events: [RAW_EVENT] });
  });
  const quiet = await X.extractEvents('ACME', { news: NEWS, client, judge: { fraction: 0, client } });
  assert.equal(quiet.outcome, 'ok');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(seen, ['submit_events'], 'fraction 0 → no grade call');

  const store = { hasStore: () => false };
  const judged = await X.extractEvents('ACME', { news: NEWS, client, judge: { fraction: 1, client, store } });
  assert.equal(judged.outcome, 'ok', 'primary result is unchanged by the judge');
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(seen, ['submit_events', 'submit_events', 'submit_grade']);
});

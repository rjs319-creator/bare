'use strict';
// lib/fable-call → lib/llm-usage: every Fable call records its usage under its label, at the
// price of the model that actually ANSWERED (a server-side fallback bills as the fallback).
const test = require('node:test');
const assert = require('node:assert/strict');
const FC = require('../lib/fable-call');
const U = require('../lib/llm-usage');

const TOOL = { name: 'submit_x', description: 'x', input_schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } };
const betaClient = (msg) => ({ beta: { messages: { create: async () => msg } } });
const todayDoc = () => { const d = U.peekBuffer().days; return d[Object.keys(d)[0]]; };

test.beforeEach(() => U._resetForTests());

test('callFableTool records usage under the label at the responding model\'s price', async () => {
  const msg = { model: 'claude-opus-4-8', stop_reason: 'tool_use', usage: { input_tokens: 1_000_000, output_tokens: 0 }, content: [{ type: 'tool_use', name: 'submit_x', input: { a: '1' } }] };
  const r = await FC.callFableTool({ tool: TOOL, messages: [{ role: 'user', content: 'x' }], maxTokens: 50, client: betaClient(msg), label: 'unit-label' });
  assert.deepEqual(r.input, { a: '1' });
  const site = todayDoc().byCallSite['unit-label'];
  assert.equal(site.calls, 1);
  assert.equal(site.usd, 5, 'Opus 4.8 fallback input price, not Fable\'s $10');
  assert.ok(site.byModel['claude-opus-4-8']);
});

test('callFableTool falls back to the tool name as call site, and a refusal is still billed', async () => {
  const msg = { model: 'claude-fable-5-1', stop_reason: 'refusal', stop_details: { category: 'x' }, usage: { input_tokens: 2000, output_tokens: 0 }, content: [] };
  const r = await FC.callFableTool({ tool: TOOL, messages: [{ role: 'user', content: 'x' }], maxTokens: 50, client: betaClient(msg) });
  assert.equal(r.refused, true);
  assert.equal(todayDoc().byCallSite.submit_x.usd, 0.02);
});

test('callFableText records under its label; a thrown call records nothing and still throws as before', async () => {
  const msg = { model: 'claude-fable-5-1', stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 1000 }, content: [{ type: 'text', text: 'hi' }] };
  const t = await FC.callFableText({ prompt: 'p', maxTokens: 10, client: betaClient(msg), label: 'agents' });
  assert.equal(t, 'hi');
  assert.equal(todayDoc().byCallSite.agents.usd, 0.051);
  await assert.rejects(FC.callFableText({ prompt: 'p', maxTokens: 10, client: { beta: { messages: { create: async () => { throw new Error('down'); } } } } }));
  assert.equal(todayDoc().calls, 1);
});

test('buildForcedToolRequest: forced tool shape for Haiku/Sonnet sites, refuses Fable 5.1', () => {
  const req = FC.buildForcedToolRequest({ tool: TOOL, messages: [{ role: 'user', content: 'x' }], maxTokens: 10, model: 'claude-haiku-4-5-20251001', system: 's' });
  assert.deepEqual(req.tool_choice, { type: 'tool', name: 'submit_x' });
  assert.equal(req.system, 's');
  assert.equal('betas' in req, false);
  assert.equal('output_config' in req, false, 'Haiku 4.5 rejects effort');
  assert.throws(() => FC.buildForcedToolRequest({ tool: TOOL, messages: [{ role: 'user', content: 'x' }], maxTokens: 10, model: 'claude-fable-5-1' }), /rejects forced/);
  assert.throws(() => FC.buildForcedToolRequest({ tool: TOOL, messages: [], maxTokens: 10, model: 'm' }), /messages/);
});

test('recordResponseUsage swallows junk', () => {
  assert.equal(FC.recordResponseUsage('x', null), undefined);
  assert.equal(FC.recordResponseUsage('x', { usage: 'nope' }), undefined);
  assert.equal(U.peekBuffer().dirty.length, 0);
});

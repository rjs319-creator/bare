'use strict';
// lib/fable-call — the shared claude-fable-5-1 helper. Fable 5.1 REJECTS forced tool_choice
// (400), so every request must be `auto` + strict tool + instruction, with refusal handled
// before content is read. These tests pin the request shape and the extraction contract
// against a fake client (no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const FC = require('../lib/fable-call');

const TOOL = {
  name: 'submit_thing',
  description: 'submit',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ticker: { type: 'string' },
            bias: { type: 'string', enum: ['up', 'down'] },
            caution: { type: 'string' },
          },
          required: ['ticker', 'bias'],
        },
      },
      notes: { type: 'string' },
    },
    required: ['items'],
  },
};

test('buildFableRequest: Fable 5.1 id, auto tool_choice, strict tool, fallback beta, effort', () => {
  const req = FC.buildFableRequest({ tool: TOOL, messages: [{ role: 'user', content: 'x' }], maxTokens: 500 });
  assert.equal(req.model, 'claude-fable-5-1');
  assert.deepEqual(req.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
  assert.equal(req.tools.length, 1);
  assert.equal(req.tools[0].strict, true);
  assert.deepEqual(req.betas, ['server-side-fallback-2026-06-01']);
  assert.deepEqual(req.fallbacks, [{ model: 'claude-opus-4-8' }]);
  assert.deepEqual(req.output_config, { effort: 'medium' });
  assert.equal(req.max_tokens, 500);
  assert.equal('thinking' in req, false, 'thinking must be omitted (always on; any config but adaptive 400s)');
  assert.match(req.system, /submit_thing/);
});

test('buildFableRequest: never emits a forced tool_choice, even if asked implicitly by a tool name', () => {
  const req = FC.buildFableRequest({ tool: TOOL, messages: [{ role: 'user', content: 'x' }], maxTokens: 10 });
  assert.notEqual(req.tool_choice.type, 'tool');
  assert.notEqual(req.tool_choice.type, 'any');
});

test('buildFableRequest: appends the tool instruction to a string system prompt and to a block array', () => {
  const s = FC.buildFableRequest({ tool: TOOL, system: 'Be careful.', messages: [{ role: 'user', content: 'x' }], maxTokens: 10 });
  assert.match(s.system, /^Be careful\.\n/);
  assert.match(s.system, /submit_thing/);
  const b = FC.buildFableRequest({ tool: TOOL, system: [{ type: 'text', text: 'Be careful.' }], messages: [{ role: 'user', content: 'x' }], maxTokens: 10 });
  assert.equal(b.system.length, 2);
  assert.match(b.system[1].text, /submit_thing/);
});

test('buildFableRequest: does not mutate the caller tool; unknown effort falls back to the default', () => {
  const before = JSON.stringify(TOOL);
  const req = FC.buildFableRequest({ tool: TOOL, messages: [{ role: 'user', content: 'x' }], maxTokens: 10, effort: 'bogus' });
  assert.equal(JSON.stringify(TOOL), before);
  assert.equal(req.output_config.effort, FC.DEFAULT_EFFORT);
});

test('strictSchema: additionalProperties:false everywhere, every property required, optionals nullable', () => {
  const s = FC.strictSchema(TOOL.input_schema);
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required, ['items', 'notes']);
  assert.deepEqual(s.properties.notes.type, ['string', 'null']);
  assert.deepEqual(s.properties.items.type, 'array');
  const item = s.properties.items.items;
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(item.required, ['ticker', 'bias', 'caution']);
  assert.equal(item.properties.ticker.type, 'string', 'required props keep their type');
  assert.deepEqual(item.properties.caution.type, ['string', 'null']);
  assert.deepEqual(item.properties.bias.enum, ['up', 'down'], 'required enum unchanged');
});

test('strictSchema: an optional enum gains null in both type and enum', () => {
  const s = FC.strictSchema({ type: 'object', properties: { lvl: { type: 'string', enum: ['a', 'b'] } }, required: [] });
  assert.deepEqual(s.properties.lvl.type, ['string', 'null']);
  assert.deepEqual(s.properties.lvl.enum, ['a', 'b', null]);
});

test('extractToolInput: returns the tool input for a matching tool_use block', () => {
  const msg = { stop_reason: 'tool_use', model: 'claude-fable-5-1', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: 'submit_thing', input: { items: [] } }] };
  const r = FC.extractToolInput(msg, 'submit_thing');
  assert.deepEqual(r, { input: { items: [] }, refused: false, stopReason: 'tool_use', model: 'claude-fable-5-1', category: null });
});

test('extractToolInput: refusal is detected BEFORE content is read → refused:true, input null', () => {
  const msg = { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, content: [{ type: 'tool_use', name: 'submit_thing', input: { items: [1] } }] };
  const r = FC.extractToolInput(msg, 'submit_thing');
  assert.equal(r.refused, true);
  assert.equal(r.input, null);
  assert.equal(r.category, 'cyber');
});

test('extractToolInput: no tool call (plain text) → input null, refused false', () => {
  const r = FC.extractToolInput({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'prose' }] }, 'submit_thing');
  assert.equal(r.input, null);
  assert.equal(r.refused, false);
  assert.equal(r.stopReason, 'end_turn');
});

test('extractToolInput: wrong tool name, malformed JSON string input, or garbage message are all safe nulls', () => {
  assert.equal(FC.extractToolInput({ content: [{ type: 'tool_use', name: 'other', input: {} }] }, 'submit_thing').input, null);
  assert.equal(FC.extractToolInput({ content: [{ type: 'tool_use', name: 'submit_thing', input: '{not json' }] }, 'submit_thing').input, null);
  assert.deepEqual(FC.extractToolInput({ content: [{ type: 'tool_use', name: 'submit_thing', input: '{"a":1}' }] }, 'submit_thing').input, { a: 1 });
  assert.equal(FC.extractToolInput(null, 'submit_thing').input, null);
  assert.equal(FC.extractToolInput({ content: [{ type: 'tool_use', name: 'submit_thing', input: [1, 2] }] }, 'submit_thing').input, null);
});

function fakeClient(impl) {
  const calls = [];
  return { calls, beta: { messages: { create: async (params, opts) => { calls.push({ params, opts }); return impl(params, opts); } } } };
}

test('callFableTool: sends via client.beta.messages.create with the timeout, returns the parsed input', async () => {
  const client = fakeClient(() => ({ stop_reason: 'tool_use', model: 'claude-fable-5-1', content: [{ type: 'tool_use', name: 'submit_thing', input: { items: [{ ticker: 'A', bias: 'up' }] } }] }));
  const r = await FC.callFableTool({ client, tool: TOOL, maxTokens: 100, timeoutMs: 1234, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].opts.timeout, 1234);
  assert.equal(client.calls[0].params.model, 'claude-fable-5-1');
  assert.equal(client.calls[0].params.tool_choice.type, 'auto');
  assert.deepEqual(r.input, { items: [{ ticker: 'A', bias: 'up' }] });
  assert.equal(r.error, null);
});

test('callFableTool: a thrown SDK error never propagates — it becomes { input:null, error }', async () => {
  const client = fakeClient(() => { throw new Error('400 tool_choice not supported'); });
  const r = await FC.callFableTool({ client, tool: TOOL, maxTokens: 100, timeoutMs: 10, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.input, null);
  assert.match(r.error, /400/);
});

test('callFableTool: a refusal surfaces as refused:true with null input', async () => {
  const client = fakeClient(() => ({ stop_reason: 'refusal', stop_details: { category: 'bio' }, content: [] }));
  const r = await FC.callFableTool({ client, tool: TOOL, maxTokens: 100, timeoutMs: 10, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.refused, true);
  assert.equal(r.input, null);
  assert.equal(r.category, 'bio');
});

test('callFableTool: no client and no API key → null (caller keeps its mechanical path)', async () => {
  const r = await FC.callFableTool({ apiKey: '', tool: TOOL, maxTokens: 100, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r, null);
});

test('callFableText: plain-text call on Fable 5.1 with fallbacks; refusal → empty string', async () => {
  const client = fakeClient(() => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"a":1}' }] }));
  const text = await FC.callFableText({ client, prompt: 'p', maxTokens: 50 });
  assert.equal(text, '{"a":1}');
  assert.equal(client.calls[0].params.model, 'claude-fable-5-1');
  assert.deepEqual(client.calls[0].params.fallbacks, [{ model: 'claude-opus-4-8' }]);
  const refusing = fakeClient(() => ({ stop_reason: 'refusal', content: [{ type: 'text', text: 'nope' }] }));
  assert.equal(await FC.callFableText({ client: refusing, prompt: 'p', maxTokens: 50 }), '');
});

test('every migrated module exposes the 5.1 id and no forced tool_choice remains in them', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const files = ['alerts-fable.js', 'alerts-semantic.js', 'optionsflow-fable.js', 'dualread-fable.js', 'universe-fable.js', 'pulse-routes.js', 'pulse2-ticks.js', 'agents-adapters.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8');
    assert.ok(!/claude-fable-5['"]/.test(src), `${f} still names claude-fable-5`);
    assert.ok(src.includes("require('./fable-call')"), `${f} must route through lib/fable-call`);
  }
  assert.equal(require('../lib/alerts-fable').MODEL, 'claude-fable-5-1');
  assert.equal(require('../lib/alerts-semantic').MODEL, 'claude-fable-5-1');
});

test('real tool schemas in the migrated modules survive strict derivation', () => {
  const tools = [
    require('../lib/alerts-semantic').SEMANTIC_TOOL,
    require('../lib/alerts-fable').ALERTS_FABLE_TOOL,
    require('../lib/optionsflow-fable').OPTIONS_FABLE_TOOL,
  ].filter(Boolean);
  assert.ok(tools.length >= 2);
  for (const t of tools) {
    const s = FC.strictTool(t);
    assert.equal(s.strict, true);
    assert.equal(s.input_schema.additionalProperties, false);
    const walk = node => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'object' && node.properties) {
        assert.equal(node.additionalProperties, false);
        assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
        Object.values(node.properties).forEach(walk);
      }
      if (node.items) walk(node.items);
    };
    walk(s.input_schema);
  }
});

test('callFableTool: request validation failures are values, not throws (callers dropped their try/catch)', async () => {
  const F = require('../lib/fable-call');
  const client = { beta: { messages: { create: async () => { throw new Error('should not be reached'); } } } };
  const r = await F.callFableTool({ tool: { name: 't', input_schema: { type: 'object', properties: {} } }, messages: [{ role: 'user', content: 'x' }], maxTokens: 'nope', client, label: 'validation' });
  assert.equal(r.input, null);
  assert.match(r.error, /maxTokens/);
});

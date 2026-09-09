'use strict';
// SHARED FABLE 5.1 CALL HELPER — the one place the app talks to `claude-fable-5-1`.
//
// WHY. Every Fable call site in this repo was written for `claude-fable-5` with a FORCED
// tool call (`tool_choice: { type: 'tool', name }`). Claude Fable 5.1 rejects forced tool
// use with a 400, so each site needs the same three changes: `tool_choice: auto` + an
// explicit instruction naming the tool, `strict: true` on the tool (keeps the
// schema-valid-arguments guarantee forcing used to give), and refusal handling
// (`stop_reason === 'refusal'` must be checked BEFORE reading content). Server-side
// fallbacks are opted in by default so a classifier decline re-runs on Opus 4.8 inside
// the same request instead of silently returning nothing.
//
// DESIGN. Pure builders (request shape, strict-schema derivation, response extraction) are
// exported and unit-tested without the network. `callFableTool` never throws: a timeout,
// a refusal with no fallback, or a response with no tool call all come back as a value
// the caller can inspect (`{ input: null, refused, stopReason, error }`), so every caller
// keeps its "graceful null → mechanical fallback" contract. maxRetries stays 0: the SDK's
// retry-on-timeout would blow the function wall (see lib/readthrough.js).

const FABLE_MODEL = 'claude-fable-5-1';
const FALLBACK_MODELS = Object.freeze(['claude-opus-4-8']);
const FALLBACK_BETA = 'server-side-fallback-2026-06-01';
const DEFAULT_EFFORT = 'medium';   // bounded extraction/judgment calls; 'low' for the pulse editorial passes
const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

// ── Strict schema derivation (pure) ─────────────────────────────────────────
// Strict tool use requires `additionalProperties: false` on every object and every property
// listed in `required`; a property the author left optional must therefore be NULLABLE.
// The derived schema never mutates the source tool — the exported tool constants keep their
// documented (non-strict) shape for prompts, tests and parsers.

function nullableType(node) {
  if (Array.isArray(node.type)) return node.type.includes('null') ? node.type : [...node.type, 'null'];
  if (typeof node.type === 'string') return node.type === 'null' ? node.type : [node.type, 'null'];
  return node.type;
}

function makeNullable(node) {
  const withType = node.type == null ? node : { ...node, type: nullableType(node) };
  if (!Array.isArray(withType.enum) || withType.enum.includes(null)) return withType;
  return { ...withType, enum: [...withType.enum, null] };
}

function strictSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (schema.type === 'array' && schema.items) return { ...schema, items: strictSchema(schema.items) };
  if (schema.type !== 'object' || !schema.properties) return schema;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const properties = Object.fromEntries(Object.entries(schema.properties).map(([key, prop]) => {
    const strictProp = strictSchema(prop);
    return [key, required.has(key) ? strictProp : makeNullable(strictProp)];
  }));
  return { ...schema, properties, required: Object.keys(schema.properties), additionalProperties: false };
}

function strictTool(tool) {
  return { ...tool, strict: true, input_schema: strictSchema(tool.input_schema) };
}

// ── Request builder (pure) ──────────────────────────────────────────────────

function toolInstruction(tool) {
  return `Respond ONLY by calling the ${tool.name} tool with a complete, schema-valid input. Do not answer in plain text.`;
}

function joinSystem(system, tool) {
  const instruction = toolInstruction(tool);
  if (!system) return instruction;
  if (typeof system === 'string') return `${system}\n${instruction}`;
  return [...system, { type: 'text', text: instruction }];
}

/**
 * Build the Fable 5.1 request for one bounded tool-returning call. Pure.
 * `tool` is the caller's (non-strict) tool definition; `messages` the conversation.
 */
function buildFableRequest({ tool, messages, system = null, maxTokens, effort = DEFAULT_EFFORT, model = FABLE_MODEL, fallbacks = FALLBACK_MODELS } = {}) {
  if (!tool || !tool.name || !tool.input_schema) throw new Error('buildFableRequest: tool with name + input_schema required');
  if (!Array.isArray(messages) || !messages.length) throw new Error('buildFableRequest: messages required');
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new Error('buildFableRequest: positive integer maxTokens required');
  const effortLevel = EFFORTS.includes(effort) ? effort : DEFAULT_EFFORT;
  return {
    model,
    max_tokens: maxTokens,
    betas: [FALLBACK_BETA],
    fallbacks: fallbacks.map(m => ({ model: m })),
    output_config: { effort: effortLevel },
    tools: [strictTool(tool)],
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    system: joinSystem(system, tool),
    messages,
  };
}

// ── Response extraction (pure) ──────────────────────────────────────────────

function parseToolInput(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read one tool call out of a Messages API response. Returns
 * `{ input, refused, stopReason, model, category }`; `input` is null when the model refused
 * (checked BEFORE content is read), answered without calling the tool, or produced an
 * unparseable input. Never throws.
 */
function extractToolInput(msg, toolName) {
  const stopReason = msg && msg.stop_reason ? msg.stop_reason : null;
  const model = msg && msg.model ? msg.model : null;
  if (stopReason === 'refusal') {
    const category = msg.stop_details && msg.stop_details.category ? msg.stop_details.category : null;
    return { input: null, refused: true, stopReason, model, category };
  }
  const content = msg && Array.isArray(msg.content) ? msg.content : [];
  const block = content.find(b => b && b.type === 'tool_use' && b.name === toolName);
  if (!block) return { input: null, refused: false, stopReason, model, category: null };
  return { input: parseToolInput(block.input), refused: false, stopReason, model, category: null };
}

// ── Transport ───────────────────────────────────────────────────────────────

function defaultClient(apiKey) {
  // Required lazily so modules load (and tests run) without the SDK present.
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey, maxRetries: 0 });
}

function errorMessage(err) {
  return err && err.message ? String(err.message).slice(0, 300) : String(err);
}

/**
 * One bounded Fable 5.1 tool call. Returns `{ input, refused, stopReason, model, category, error }`
 * or null when there is no API key. Never throws — every failure is a value.
 */
async function callFableTool({ tool, messages, system = null, maxTokens, timeoutMs, effort, client = null, apiKey = process.env.ANTHROPIC_API_KEY, label = null } = {}) {
  if (!client && !apiKey) return null;
  try {
    // Request validation and client construction sit INSIDE the try: callers deleted
    // their own try/catch on the strength of "never throws", so a bad maxTokens must
    // become a value, not a 500.
    const request = buildFableRequest({ tool, messages, system, maxTokens, effort });
    const api = client || defaultClient(apiKey);
    const msg = await api.beta.messages.create(request, { timeout: timeoutMs });
    const result = extractToolInput(msg, tool.name);
    if (result.refused) console.warn(`[fable-call] ${label || tool.name}: refused (${result.category || 'uncategorized'}) — no fallback served`);
    return { ...result, error: null };
  } catch (err) {
    // Server-side: log the reason (a 400 here means the request shape, not the data, is wrong).
    console.warn(`[fable-call] ${label || (tool && tool.name) || 'tool'}: ${errorMessage(err)}`);
    return { input: null, refused: false, stopReason: null, model: null, category: null, error: errorMessage(err) };
  }
}

/**
 * One bounded Fable 5.1 plain-text call (no tool). Returns the text ('' when refused or
 * empty). Used by the multi-agent adapter, whose contract parses JSON from prose.
 */
async function callFableText({ prompt, maxTokens, timeoutMs, effort = DEFAULT_EFFORT, client = null, apiKey = process.env.ANTHROPIC_API_KEY, model = FABLE_MODEL } = {}) {
  if (!client && !apiKey) return '';
  const api = client || defaultClient(apiKey);
  const msg = await api.beta.messages.create({
    model,
    max_tokens: maxTokens,
    betas: [FALLBACK_BETA],
    fallbacks: FALLBACK_MODELS.map(m => ({ model: m })),
    output_config: { effort: EFFORTS.includes(effort) ? effort : DEFAULT_EFFORT },
    messages: [{ role: 'user', content: prompt }],
  }, timeoutMs ? { timeout: timeoutMs } : undefined);
  if (!msg || msg.stop_reason === 'refusal') return '';
  const block = (msg.content || []).find(b => b && b.type === 'text');
  return block ? block.text : '';
}

module.exports = {
  FABLE_MODEL, FALLBACK_MODELS, FALLBACK_BETA, DEFAULT_EFFORT,
  strictSchema, strictTool, toolInstruction, buildFableRequest, parseToolInput, extractToolInput,
  callFableTool, callFableText,
};

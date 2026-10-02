'use strict';
// Prompt-family adapters: each one builds its request through the SAME pure builder the
// production module uses (buildExtractRequest / buildToneRequest / buildBearRequest /
// buildGameplanRequest / buildFableRequest+buildRefineMessages), so the exact request shape
// — model, tool, tool_choice, system, user turn — is what the eval exercises. Assertions are
// pure and shared with the promptfoo shim.

const A = require('./assertions');
const FC = require('../../lib/fable-call');
const X = require('../../lib/evidence-extract');
const T = require('../../lib/earnings-tone');
const B = require('../../lib/bearcase');
const G = require('../../lib/gameplan');
const P = require('../../lib/pulse2-ticks');

const MAX_LIST_ITEMS = 3;           // gameplan lean/avoid/watch cap (from the prompt text)
const MAX_REASON_CHARS = 400;
const MAX_BEAR_CHARS = 700;
const NEUTRAL_TONE_BAND = 2;

const named = (name, r) => ({ name, ...r });
const text = (...parts) => parts.filter(p => p != null).join('\n');

function toolOf(request) {
  return request.tools.find(t => t.name && t.input_schema);
}

function requireArray(v, label, min = 1) {
  return Array.isArray(v) && v.length >= min ? [] : [`${label}: array of ≥${min} required`];
}

// ── evidence-extract (Haiku, forced submit_events) ──────────────────────────

function citedText(news, event) {
  const idx = Array.isArray(event.sourceIndexes) ? event.sourceIndexes : [];
  return idx.filter(i => Number.isInteger(i) && news[i]).map(i => `${news[i].title} ${news[i].text || ''}`).join('\n');
}

const evidenceExtract = {
  name: 'evidence-extract',
  module: 'lib/evidence-extract.js',
  promptVersion: X.PROMPT_VERSION,
  model: X.MODEL,
  transport: 'forced',
  tool: X.EXTRACT_TOOL,
  rubric: 'Each event is a distinct material development actually described by the headlines it cites; no event invents a figure, outcome or party absent from those headlines; routine price recaps and listicles are omitted; duplicate write-ups of one development are merged into one event.',
  validateInput: (input) => [
    ...(typeof input.ticker === 'string' && input.ticker ? [] : ['ticker required']),
    ...requireArray(input.news, 'news'),
    ...(Array.isArray(input.news) ? input.news.filter(n => !n || !n.title).map((_, i) => `news[${i}].title required`) : []),
  ],
  buildRequest: (input) => X.buildExtractRequest(input.ticker, input.company, input.news),
  assert(input, output) {
    const out = [named('schema', A.schemaValid(X.EXTRACT_TOOL.input_schema, output))];
    const events = Array.isArray(output && output.events) ? output.events : [];
    out.push(named('maxEvents', A.maxItems(events, X.MAX_EVENTS, 'events')));
    events.forEach((ev, i) => {
      const cited = citedText(input.news, ev || {});
      out.push(named(`event[${i}].sourceIndexes⊆inputs`, A.indexesSubset(ev.sourceIndexes, input.news.length)));
      out.push(named(`event[${i}].citesSomething`, A.nonEmptyIndexes(ev.sourceIndexes)));
      out.push(named(`event[${i}].claimNumbersVerbatim`, A.numbersVerbatim(ev.claim, cited)));
      out.push(named(`event[${i}].quantitativeMagnitudeGrounded`, A.numberFieldGrounded(ev.quantitativeMagnitude, cited)));
      out.push(named(`event[${i}].surpriseMagnitudeGrounded`, A.numberFieldGrounded(ev.surpriseMagnitude, cited)));
    });
    const ex = input.expect || {};
    if (ex.minEvents != null || ex.maxEvents != null) {
      const lo = ex.minEvents == null ? 0 : ex.minEvents, hi = ex.maxEvents == null ? X.MAX_EVENTS : ex.maxEvents;
      out.push(named('expect.eventCount', A.intInRange(events.length, lo, hi, 'events')));
    }
    if (ex.mustIncludeType) {
      const ok = events.some(e => e && e.eventType === ex.mustIncludeType);
      out.push(named('expect.mustIncludeType', { ok, detail: ok ? `has ${ex.mustIncludeType}` : `no ${ex.mustIncludeType} event` }));
    }
    return out;
  },
};

// ── earnings tone (Haiku, forced submit_tone, transcript path) ──────────────

const toneSign = tone => (tone > NEUTRAL_TONE_BAND ? 'positive' : tone < -NEUTRAL_TONE_BAND ? 'negative' : 'neutral');

const earningsTone = {
  name: 'earnings-tone',
  module: 'lib/earnings-tone.js',
  promptVersion: null,
  model: T.MODEL,
  transport: 'forced',
  tool: T.TONE_TOOL,
  rubric: 'The reason cites specific wording or behaviour from the transcript (how management answered, what they committed to or dodged) rather than restating headline numbers, and the sign of the score matches that evidence.',
  validateInput: (input) => [
    ...(typeof input.symbol === 'string' && input.symbol ? [] : ['symbol required']),
    ...(typeof input.transcript === 'string' && input.transcript.length > 40 ? [] : ['transcript (≥40 chars) required']),
  ],
  buildRequest: (input) => T.buildToneRequest(input.symbol, input.transcript),
  assert(input, output) {
    const out = [named('schema', A.schemaValid(T.TONE_TOOL.input_schema, output))];
    out.push(named('toneRange', A.intInRange(output && output.tone, -10, 10, 'tone')));
    out.push(named('reason', A.nonEmptyString(output && output.reason, 'reason', MAX_REASON_CHARS)));
    const ex = input.expect || {};
    if (ex.toneSign) {
      const got = Number.isFinite(output && output.tone) ? toneSign(output.tone) : 'invalid';
      out.push(named('expect.toneSign', { ok: got === ex.toneSign, detail: `expected ${ex.toneSign}, got ${got} (${output && output.tone})` }));
    }
    return out;
  },
};

// ── pulse narrative refine (Fable 5.1 via buildFableRequest, strict + auto) ─

const pulseNarrative = {
  name: 'pulse-narrative',
  module: 'lib/pulse2-ticks.js (runPulse2Refine)',
  promptVersion: null,
  model: FC.FABLE_MODEL,
  transport: 'fable',
  tool: P.REFINE_TOOL,
  rubric: 'Every contrarian line is a judgment about crowding or pricing of the item it annotates; it introduces no new facts, numbers, sources or tickers; duplicateOf is set only for items describing the same underlying development.',
  validateInput: (input) => [
    ...requireArray(input.items, 'items'),
    ...(Array.isArray(input.items) ? input.items.filter(it => !it || !it.headline).map((_, i) => `items[${i}].headline required`) : []),
  ],
  buildRequest: (input) => FC.buildFableRequest({ tool: P.REFINE_TOOL, messages: P.buildRefineMessages(input.items), maxTokens: P.REFINE_MAX_TOKENS, effort: P.REFINE_EFFORT }),
  assert(input, output) {
    const out = [named('schema', A.schemaValid(P.REFINE_TOOL.input_schema, output))];
    const reads = Array.isArray(output && output.reads) ? output.reads : [];
    const n = input.items.length;
    reads.forEach((r, i) => {
      out.push(named(`read[${i}].index⊆items`, A.indexesSubset([r.index], n)));
      const dup = r.duplicateOf;
      const dupOk = dup == null || dup === -1 || (Number.isInteger(dup) && dup >= 0 && dup < n && dup !== r.index);
      out.push(named(`read[${i}].duplicateOf`, { ok: dupOk, detail: dupOk ? `duplicateOf=${dup == null ? -1 : dup}` : `duplicateOf=${dup} invalid (n=${n}, self=${r.index})` }));
      const item = input.items[r.index] || {};
      out.push(named(`read[${i}].contrarianNoNewNumbers`, A.numbersVerbatim(r.contrarian, text(item.headline, item.evidence))));
    });
    const ex = input.expect || {};
    for (const [a, b] of ex.duplicates || []) {
      const read = reads.find(r => r.index === a);
      const ok = !!read && read.duplicateOf === b;
      out.push(named(`expect.duplicate ${a}→${b}`, { ok, detail: ok ? 'marked' : `read ${a} duplicateOf=${read ? read.duplicateOf : 'missing'}` }));
    }
    return out;
  },
};

// ── bear case (Haiku, forced submit_bear_cases) ─────────────────────────────

const bearCase = {
  name: 'bear-case',
  module: 'lib/bearcase.js',
  promptVersion: null,
  model: B.MODEL,
  transport: 'forced',
  tool: B.BEAR_TOOL,
  rubric: 'Each bear case argues only from the setup fields shown (setup type, state, levels, sector, evidence families, catalyst), commits to one objection without hedging, and names one concrete observation that would prove it wrong.',
  validateInput: (input) => [
    ...requireArray(input.signals, 'signals'),
    ...(Array.isArray(input.signals) ? input.signals.filter(s => !s || !s.ticker).map((_, i) => `signals[${i}].ticker required`) : []),
  ],
  buildRequest: (input) => B.buildBearRequest(input.signals, input.regimeLabel),
  assert(input, output) {
    const out = [named('schema', A.schemaValid(B.BEAR_TOOL.input_schema, output))];
    const cases = Array.isArray(output && output.cases) ? output.cases : [];
    const tickers = input.signals.map(s => s.ticker);
    out.push(named('tickers⊆inputs', A.subsetOf(cases.map(c => c && c.ticker), tickers, 'tickers')));
    out.push(named('maxCases', A.maxItems(cases, B.MAX_CASES, 'cases')));
    cases.forEach((c, i) => {
      const sig = input.signals.find(s => s.ticker === c.ticker);
      const shown = text(sig ? B.sigLine(sig) : '', input.regimeLabel);
      out.push(named(`case[${i}].bearCase`, A.nonEmptyString(c.bearCase, 'bearCase', MAX_BEAR_CHARS)));
      out.push(named(`case[${i}].noHedging`, A.noHedging(c.bearCase)));
      out.push(named(`case[${i}].numbersVerbatim`, A.numbersVerbatim(text(c.bearCase, c.invalidation), shown)));
    });
    const ex = input.expect || {};
    if (ex.coverAll) {
      const missing = tickers.filter(t => !cases.some(c => c && c.ticker === t));
      out.push(named('expect.coverAll', { ok: !missing.length, detail: missing.length ? `no case for ${missing.join(', ')}` : 'all setups argued' }));
    }
    return out;
  },
};

// ── gameplan + reflection (Sonnet, forced submit_game_plan) ─────────────────

const gameplanReflection = {
  name: 'gameplan-reflection',
  module: 'lib/gameplan.js',
  promptVersion: null,
  model: G.MODEL,
  transport: 'forced',
  tool: G.GAMEPLAN_TOOL,
  rubric: 'Every driver, lean, avoid and prediction is grounded in the headlines, macro line, signals or measured record provided; no price level, event or ticker is invented; when a measured record lists open predictions, narrativeUpdate resolves each one.',
  validateInput: (input) => [
    ...(input.state && typeof input.state === 'object' ? [] : ['state object required']),
    ...(input.state && typeof input.state.date === 'string' ? [] : ['state.date required']),
  ],
  buildRequest: (input) => G.buildGameplanRequest(input.state),
  assert(input, output, request) {
    const shown = request && request.messages && request.messages[0] ? request.messages[0].content : '';
    const out = [named('schema', A.schemaValid(G.GAMEPLAN_TOOL.input_schema, output))];
    const o = output || {};
    out.push(named('maxDrivers', A.maxItems(o.drivers, G.MAX_DRIVERS, 'drivers')));
    out.push(named('maxPredictions', A.maxItems(o.predictions, G.MAX_PREDICTIONS, 'predictions')));
    for (const k of ['lean', 'avoid', 'watch']) out.push(named(`gamePlan.${k}≤${MAX_LIST_ITEMS}`, A.maxItems(o.gamePlan && o.gamePlan[k], MAX_LIST_ITEMS, k)));
    (o.drivers || []).forEach((d, i) => out.push(named(`driver[${i}].numbersVerbatim`, A.numbersVerbatim(text(d && d.story, d && d.soWhat), shown))));
    (o.predictions || []).forEach((p, i) => out.push(named(`prediction[${i}].numbersVerbatim`, A.numbersVerbatim(p && p.call, shown))));
    out.push(named('narrativeUpdate', A.nonEmptyString(o.narrativeUpdate, 'narrativeUpdate')));
    const ex = input.expect || {};
    if (ex.mustResolveOpen) {
      const ok = /confirmed|invalidated|open/i.test(String(o.narrativeUpdate || ''));
      out.push(named('expect.resolvesOpenPredictions', { ok, detail: ok ? 'accounts for prior calls' : 'narrativeUpdate ignores the open predictions' }));
    }
    return out;
  },
};

const FAMILIES = Object.freeze({
  'evidence-extract': evidenceExtract,
  'earnings-tone': earningsTone,
  'pulse-narrative': pulseNarrative,
  'bear-case': bearCase,
  'gameplan-reflection': gameplanReflection,
});
const FAMILY_NAMES = Object.freeze(Object.keys(FAMILIES));

/** Request-shape invariants per transport. Returns violations (empty = ok). */
function checkRequestShape(adapter, request) {
  const v = [];
  if (!request || typeof request !== 'object') return ['request missing'];
  if (request.model !== adapter.model) v.push(`model ${request.model} ≠ ${adapter.model}`);
  if (!Number.isInteger(request.max_tokens) || request.max_tokens <= 0) v.push('max_tokens must be a positive integer');
  const tool = toolOf(request);
  if (!tool || tool.name !== adapter.tool.name) v.push(`tool ${tool && tool.name} ≠ ${adapter.tool.name}`);
  const m0 = Array.isArray(request.messages) && request.messages[0];
  if (!m0 || m0.role !== 'user' || typeof m0.content !== 'string' || !m0.content.trim()) v.push('messages[0] must be a non-empty user turn');
  if (adapter.transport === 'forced') {
    if (!request.tool_choice || request.tool_choice.type !== 'tool' || request.tool_choice.name !== adapter.tool.name) v.push('forced transport needs tool_choice {type:tool,name}');
    if (request.betas || request.output_config) v.push('Haiku/Sonnet sites must not send betas/output_config');
  } else {
    if (!request.tool_choice || request.tool_choice.type !== 'auto') v.push('Fable transport needs tool_choice auto');
    if (!tool || tool.strict !== true) v.push('Fable tool must be strict');
    if (!Array.isArray(request.betas) || !request.betas.includes(FC.FALLBACK_BETA)) v.push('Fable request needs the fallback beta');
    if (!request.output_config || !request.output_config.effort) v.push('Fable request needs output_config.effort');
    if ('thinking' in request) v.push('Fable request must omit thinking');
  }
  return v;
}

module.exports = { FAMILIES, FAMILY_NAMES, checkRequestShape, toolOf };

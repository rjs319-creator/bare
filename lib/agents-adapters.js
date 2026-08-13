'use strict';
// PROVIDER-NEUTRAL AGENT ADAPTERS.
//
// The registry is the ONLY place a vendor is named. `lib/agents-contract.js` never imports
// an SDK; it takes `{ id, capabilities, run }` objects from here (or from a test). Adding a
// different provider means adding one entry, not touching the contract.
//
// SHADOW BY DEFAULT: `AGENTS_MODE` defaults to `off`. With no adapter configured, every
// agent lane reports NO_ADAPTER and the panel reads DEGRADED — which is the honest state,
// and is exactly what the decision contract renders. Turning the layer on runs it in
// SHADOW: outputs are recorded, dissent is preserved, and nothing can change a strategy's
// weight, maturity, or trade eligibility. That guarantee lives in agents-contract's
// `applyAgentsToDecision` and is test-locked.
//
// CHAMPION / CHALLENGER: two prompt/model variants can run over the same request. The
// challenger's output is stored for comparison and is NEVER the one applied to a decision.

const { ROLE, ROLE_SCHEMA } = require('./agents-contract');

const ADAPTERS_VERSION = 'agents-adapters-v1';

const MODES = Object.freeze(['off', 'shadow']);
const DEFAULT_MODE = 'off';

function resolveAgentsMode(raw) {
  const m = String(raw ?? process.env.AGENTS_MODE ?? '').toLowerCase();
  return MODES.includes(m) ? m : DEFAULT_MODE;
}
const agentsEnabled = raw => resolveAgentsMode(raw) === 'shadow';

// ── Prompt construction (provider-neutral text) ─────────────────────────────

const ROLE_BRIEF = Object.freeze({
  [ROLE.INTAKE]: 'Normalize entities, instruments, direction claims, horizons, timestamps, and event families. Detect ambiguity, negation, questions, sarcasm, open/close uncertainty, and multi-leg language. When the language stays ambiguous, SAY SO — do not resolve it in favour of a direction.',
  [ROLE.PROVENANCE]: 'Assess the claim against the sources supplied. Track publication time, event time, discovery time, syndication lineage, contradictions, and which source lanes covered it. A social post may DISCOVER a catalyst but may never VERIFY it.',
  [ROLE.REGIME]: 'Read the supplied deterministic market-state and cross-asset features. List supporting and contradicting observations separately. Be side-aware: a risk-off regime does not veto a valid short.',
  [ROLE.SETUP]: 'EXPLAIN the supplied deterministic setup. You may reference the trigger, invalidation, target, and time stop that were given to you. You may NOT produce any numeric level of your own.',
  [ROLE.OPTIONS]: 'Separate anomaly, structure hypotheses, provisional direction, volatility context, catalyst proximity, and independent price confirmation. Treat hedge, roll, spread, overwrite, closing activity, and event-volatility as HYPOTHESES unless the supplied data can establish them. Calls are not bullish and puts are not bearish.',
  [ROLE.EXECUTION]: 'Judge executability from the supplied evidence only. Where an input is missing, name it in missingInputs and return feasibility UNKNOWN. Do not estimate a spread, an ADV, a borrow fee, or a slippage figure.',
  [ROLE.PORTFOLIO]: 'Map the idea to sector, factor, country, duration, commodity, volatility, and event exposure tags. Identify other supplied ideas that are the SAME underlying bet. Do not compute a position size.',
  [ROLE.SKEPTIC]: 'Build the strongest counter-thesis. Hunt for stale data, duplicate narratives, manipulation, an already-consumed move, false-positive options explanations, and unpriced execution risk. Your job is to be right about what is wrong, not to be balanced.',
  [ROLE.CALIBRATION]: 'Review prospective performance, drift, data coverage, matched controls, and effective independent dates. You may recommend CONTINUE_SHADOW, REVIEW, INVESTIGATE_DRIFT, or INSUFFICIENT_EVIDENCE. You may NEVER promote a strategy.',
  [ROLE.SYNTHESIS]: 'Produce one bounded thesis, what changed, the key evidence, the dissent you must carry forward UNRESOLVED, and the evidence gaps. You may not set a decision state, a lifecycle, a level, or a readiness — deterministic code owns all of those.',
});

const GLOBAL_RULES = [
  'Return ONE JSON object and nothing else.',
  'You may extract, classify, explain, challenge, and synthesize.',
  'You may NOT invent prices, catalysts, probabilities, sources, Greeks, spreads, liquidity, or performance figures.',
  'Never state a percentage as a chance, probability, likelihood, or confidence — no calibrated model exists to support one.',
  'Never assert a numeric trigger, target, stop, entry, or invalidation. Those come from deterministic chart math.',
  'If the supplied evidence does not support a field, omit it rather than guessing.',
  'Preserve disagreement. Do not smooth conflicting evidence into a single comfortable read.',
].join('\n- ');

/** Build the provider-neutral prompt for one role. Pure. */
function buildAgentPrompt(role, request, { variant = 'champion' } = {}) {
  const schema = ROLE_SCHEMA[role] || { allowed: [], forbidden: [], required: [] };
  const emphasis = variant === 'challenger'
    ? '\nCHALLENGER VARIANT: state the case AGAINST the most obvious reading first, then the reading itself.'
    : '';
  return [
    `ROLE: ${role}`,
    ROLE_BRIEF[role] || '',
    emphasis,
    '',
    'RULES:',
    `- ${GLOBAL_RULES}`,
    '',
    `ALLOWED FIELDS (anything else is discarded): ${schema.allowed.join(', ')}`,
    `REQUIRED FIELDS: ${schema.required.join(', ')}`,
    `FORBIDDEN FIELDS (their presence REJECTS your whole output): ${schema.forbidden.join(', ')}`,
    '',
    'EVIDENCE:',
    JSON.stringify(request || {}, null, 1).slice(0, 12_000),
  ].join('\n');
}

// ── The Anthropic adapter (the only vendor reference in the codepath) ───────

/**
 * Build an adapter backed by the repo's existing Anthropic integration. Returns null when
 * the key is absent, so the panel degrades to NO_ADAPTER rather than throwing.
 *
 * `callImpl` is injectable so tests never touch the network.
 */
function anthropicAdapter({ model = 'claude-fable-5', variant = 'champion', callImpl = null, apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
  if (!callImpl && !apiKey) return null;
  const call = callImpl || defaultAnthropicCall(model, apiKey);
  return {
    id: `anthropic:${model}:${variant}`,
    variant,
    capabilities: { provider: 'anthropic', model, structuredOutput: true },
    async run(request) {
      const { role, ...rest } = request;
      const text = await call(buildAgentPrompt(role, rest, { variant }));
      return parseJsonObject(text);
    },
  };
}

function defaultAnthropicCall(model, apiKey) {
  return async prompt => {
    // Required lazily so the module loads (and tests run) without the SDK present.
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const r = await client.messages.create({
      model,
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = (r && r.content || []).find(b => b && b.type === 'text');
    return block ? block.text : '';
  };
}

/** Tolerant JSON extraction — a model that wraps its object in prose still parses. */
function parseJsonObject(text) {
  if (!text) return null;
  const s = String(text);
  const direct = tryParse(s);
  if (direct) return direct;
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start >= 0 && end > start) return tryParse(s.slice(start, end + 1));
  return null;
}
function tryParse(s) { try { const v = JSON.parse(s); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } }

// ── Registry ────────────────────────────────────────────────────────────────

/**
 * Resolve the adapter set for a panel run. Pure apart from env reads.
 * With the mode off, or with no provider configured, this returns {} — every lane then
 * reports NO_ADAPTER and the panel is DEGRADED, which is the honest state.
 */
function resolveAdapters({ mode = resolveAgentsMode(), roles = null, adapterFactory = anthropicAdapter, variant = 'champion', callImpl = null } = {}) {
  if (mode !== 'shadow') return { adapters: {}, reason: `AGENTS_MODE=${mode} — the multi-agent layer is off; every lane reports NO_ADAPTER` };
  const a = adapterFactory({ variant, callImpl });
  if (!a) return { adapters: {}, reason: 'no provider credentials configured — the multi-agent layer degrades to NO_ADAPTER rather than fabricating output' };
  const out = {};
  for (const r of (roles || Object.values(ROLE))) out[r] = a;
  return { adapters: out, reason: null, adapterId: a.id };
}

/**
 * Champion/challenger in shadow. BOTH run; only the CHAMPION result is ever returned as
 * `applied`. The challenger is recorded for walk-forward comparison and can never reach a
 * decision record — promotion stays a deliberate human act.
 */
async function runChampionChallenger(request, { runPanelImpl, championAdapters = {}, challengerAdapters = {}, roles = null, timeoutMs = 15_000 } = {}) {
  const runPanel = runPanelImpl || require('./agents-contract').runPanel;
  const opts = { roles: roles || undefined, timeoutMs };
  const [champion, challenger] = await Promise.all([
    runPanel(request, { ...opts, adapters: championAdapters }),
    Object.keys(challengerAdapters).length
      ? runPanel(request, { ...opts, adapters: challengerAdapters })
      : Promise.resolve(null),
  ]);
  return {
    version: ADAPTERS_VERSION,
    applied: champion,
    // Recorded, compared, never applied.
    challenger,
    challengerApplied: false,
    challengerNote: 'The challenger panel is scored in shadow for walk-forward comparison only. It cannot reach a decision record, change a ranking, or alter governance. A champion swap is a deliberate human config bump.',
    comparison: challenger ? {
      championCoverage: champion.coverage,
      challengerCoverage: challenger.coverage,
      championDegradedRoles: champion.degradedRoles.map(d => d.role),
      challengerDegradedRoles: challenger.degradedRoles.map(d => d.role),
    } : null,
  };
}

module.exports = {
  ADAPTERS_VERSION, MODES, DEFAULT_MODE, ROLE_BRIEF, GLOBAL_RULES,
  resolveAgentsMode, agentsEnabled, buildAgentPrompt,
  anthropicAdapter, parseJsonObject, resolveAdapters, runChampionChallenger,
};

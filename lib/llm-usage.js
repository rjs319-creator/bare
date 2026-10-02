'use strict';
// 💸 LLM TOKEN + COST LEDGER (GitHub-scan proposal #6).
//
// Every Messages API response carries `usage.{input_tokens, output_tokens,
// cache_read_input_tokens, cache_creation_input_tokens}`; until this module nothing in the
// app read it, so the preregistered EDGAR AVOID pilot's "> $200/month" stop rule was
// unmeasurable and a fan-out bug (the 2,800-fetch swingsearchgrade incident) had no cheap
// detector. `recordUsage` accumulates per-call-site counters in process, estimates USD from a
// static price table, and flushes at most once per FLUSH_INTERVAL_MS to a per-process daily
// Blob shard (lib/llm-ledger-shards.js — no read-modify-write, counters only grow). op=health
// folds the day's shards into `llm: { today, yesterday, flags }`.
//
// Prices are list prices per million tokens (claude-api skill, cached 2026-06-24). Bump the
// table when a model changes; an unknown model id is counted as `unpricedCalls`, never guessed.

const shards = require('./llm-ledger-shards');

const USAGE_PREFIX = 'llm/usage/';
const FLUSH_INTERVAL_MS = 30000;
const MONTHLY_STOP_USD = 200;            // EDGAR pilot preregistered stop rule (docs/alpha/agent-feasibility/system-design.md)
const DAYS_PER_MONTH = 30;
const DAILY_PACE_USD = MONTHLY_STOP_USD / DAYS_PER_MONTH;
const DAY_OVER_DAY_JUMP = 2;             // today > 2x yesterday → fan-out suspect
const JUMP_FLOOR_USD = 1;                // ignore "jumps" below this absolute spend (noise)
const USD_DECIMALS = 6;
const TOKENS_PER_PRICE_UNIT = 1e6;

// USD per MTok: input, output, cacheRead, cacheWrite (5-minute TTL = 1.25x input).
// Keys are id PREFIXES — the response `model` may carry a date suffix (claude-haiku-4-5-20251001).
const PRICES = Object.freeze({
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
});

// ── Pure: prices + counters ─────────────────────────────────────────────────

/** Longest-prefix price lookup. Returns null for an unknown model (never guesses). */
function priceFor(model) {
  if (typeof model !== 'string' || !model) return null;
  const key = Object.keys(PRICES)
    .filter(k => model === k || model.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? PRICES[key] : null;
}

const nonNegInt = v => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** Normalize a Messages API usage object to four non-negative integers. */
function normalizeUsage(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  return {
    input: nonNegInt(u.input_tokens),
    output: nonNegInt(u.output_tokens),
    cacheRead: nonNegInt(u.cache_read_input_tokens),
    cacheCreation: nonNegInt(u.cache_creation_input_tokens),
  };
}

const roundUsd = n => +n.toFixed(USD_DECIMALS);

/** Estimated USD for one response, or null when the model is unpriced. */
function estimateUsd(model, usage) {
  const p = priceFor(model);
  if (!p) return null;
  const t = normalizeUsage(usage);
  const usd = (t.input * p.input + t.output * p.output + t.cacheRead * p.cacheRead + t.cacheCreation * p.cacheWrite) / TOKENS_PER_PRICE_UNIT;
  return roundUsd(usd);
}

const zeroTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
const addTokens = (a, b) => ({
  input: a.input + b.input, output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead, cacheCreation: a.cacheCreation + b.cacheCreation,
});
const totalTokens = t => t.input + t.output + t.cacheRead + t.cacheCreation;

function emptyCounters() {
  return { calls: 0, tokens: zeroTokens(), usd: 0, unpricedCalls: 0 };
}

/** Add one response to a counters object — returns a NEW object. */
function addCall(counters, { model, usage }) {
  const base = counters || emptyCounters();
  const usd = estimateUsd(model, usage);
  return {
    calls: base.calls + 1,
    tokens: addTokens(base.tokens, normalizeUsage(usage)),
    usd: roundUsd(base.usd + (usd == null ? 0 : usd)),
    unpricedCalls: base.unpricedCalls + (usd == null ? 1 : 0),
  };
}

/** Merge two counters objects (sum). Pure. */
function mergeCounters(a, b) {
  const x = a || emptyCounters(), y = b || emptyCounters();
  return {
    calls: x.calls + y.calls,
    tokens: addTokens(x.tokens || zeroTokens(), y.tokens || zeroTokens()),
    usd: roundUsd((x.usd || 0) + (y.usd || 0)),
    unpricedCalls: (x.unpricedCalls || 0) + (y.unpricedCalls || 0),
  };
}

// ── Shard doc (one process, one day) ─────────────────────────────────────────

function emptyDayDoc(date, instanceId, at) {
  return {
    date, instanceId, startedAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(),
    ...emptyCounters(), byCallSite: {},
  };
}

/** Fold one response into a day doc. Pure — returns a new doc. */
function addToDayDoc(doc, { callSite, model, usage, at }) {
  const site = doc.byCallSite[callSite] || { ...emptyCounters(), byModel: {} };
  const modelKey = typeof model === 'string' && model ? model : 'unknown';
  const nextSite = {
    ...addCall(site, { model, usage }),
    byModel: { ...site.byModel, [modelKey]: addCall(site.byModel[modelKey], { model, usage }) },
  };
  return {
    ...doc,
    ...addCall(doc, { model, usage }),
    updatedAt: new Date(at).toISOString(),
    byCallSite: { ...doc.byCallSite, [callSite]: nextSite },
  };
}

/** Fold a day's shard docs into one summary. Pure. */
function foldShards(docs, date) {
  const list = (docs || []).filter(d => d && typeof d === 'object');
  const byCallSite = {};
  let total = emptyCounters();
  for (const d of list) {
    total = mergeCounters(total, d);
    for (const [site, c] of Object.entries(d.byCallSite || {})) {
      byCallSite[site] = mergeCounters(byCallSite[site], c);
    }
  }
  const sites = Object.fromEntries(Object.entries(byCallSite)
    .sort(([, a], [, b]) => b.usd - a.usd)
    .map(([k, c]) => [k, { calls: c.calls, usd: c.usd, tokens: totalTokens(c.tokens), unpricedCalls: c.unpricedCalls }]));
  return {
    date, shards: list.length, calls: total.calls, usd: total.usd,
    tokens: { ...total.tokens, total: totalTokens(total.tokens) },
    unpricedCalls: total.unpricedCalls, byCallSite: sites,
  };
}

// ── Flags (pure) ─────────────────────────────────────────────────────────────

function dayOverDayFlag(today, yesterday) {
  const t = today && Number.isFinite(today.usd) ? today.usd : 0;
  const y = yesterday && Number.isFinite(yesterday.usd) ? yesterday.usd : 0;
  const ratio = y > 0 ? +(t / y).toFixed(2) : null;
  const flagged = y > 0 && t >= JUMP_FLOOR_USD && t > DAY_OVER_DAY_JUMP * y;
  return { flagged, ratio, threshold: DAY_OVER_DAY_JUMP, floorUsd: JUMP_FLOOR_USD };
}

function budgetFlag(today) {
  const t = today && Number.isFinite(today.usd) ? today.usd : 0;
  return {
    monthlyStopUsd: MONTHLY_STOP_USD,
    dailyPaceUsd: +DAILY_PACE_USD.toFixed(2),
    todayOverPace: t > DAILY_PACE_USD,
    projectedMonthUsd: +(t * DAYS_PER_MONTH).toFixed(2),
  };
}

/** The op=health block. Pure given the two folded days. */
function buildLlmHealth(today, yesterday) {
  return { today, yesterday, flags: { dayOverDayJump: dayOverDayFlag(today, yesterday), budget: budgetFlag(today) } };
}

// ── In-process buffer + flush ───────────────────────────────────────────────

const initialState = () => ({ days: {}, dirty: new Set(), timer: null, lastFlushAt: 0, lastFlushError: null, flushes: 0 });
let state = initialState();

function hasStore() {
  try { return require('./store').hasStore(); } catch { return false; }
}

function scheduleFlush(now) {
  if (!hasStore() || state.timer) return;
  const due = state.lastFlushAt + FLUSH_INTERVAL_MS;
  if (now >= due) { flushUsage().catch(() => {}); return; }
  const timer = setTimeout(() => { state = { ...state, timer: null }; flushUsage().catch(() => {}); }, due - now);
  if (timer.unref) timer.unref();
  state = { ...state, timer };
}

/**
 * Record one response's usage under a call site. Never throws. Returns the normalized
 * entry (or null when the input is unusable) so callers/tests can inspect it.
 */
function recordUsage({ callSite, model, usage, at = Date.now() } = {}) {
  if (!usage || typeof usage !== 'object') return null;
  const site = typeof callSite === 'string' && callSite ? callSite : 'unknown';
  const date = shards.utcDate(at);
  const doc = state.days[date] || emptyDayDoc(date, shards.INSTANCE_ID, at);
  const next = addToDayDoc(doc, { callSite: site, model, usage, at });
  state = { ...state, days: { ...state.days, [date]: next }, dirty: new Set([...state.dirty, date]) };
  scheduleFlush(at);
  return { callSite: site, model: model || null, tokens: normalizeUsage(usage), usd: estimateUsd(model, usage) };
}

/** Convenience for direct `client.messages.create` call sites: record from the response. */
function recordMessageUsage(callSite, msg) {
  if (!msg || typeof msg !== 'object') return null;
  return recordUsage({ callSite, model: msg.model, usage: msg.usage });
}

/** Write every dirty day shard. Never throws; returns `{ flushed, errors }`. */
async function flushUsage({ store = null } = {}) {
  const dates = [...state.dirty];
  state = { ...state, dirty: new Set(), lastFlushAt: Date.now() };
  const errors = [];
  for (const date of dates) {
    const r = await shards.writeShard(USAGE_PREFIX, date, state.days[date], { store });
    if (!r.written) errors.push(`${date}: ${r.error}`);
  }
  // A failed write leaves the day dirty so the next flush retries it (the doc is cumulative).
  const retry = dates.filter(d => errors.some(e => e.startsWith(d)));
  state = { ...state, dirty: new Set([...state.dirty, ...retry]), flushes: state.flushes + 1, lastFlushError: errors[0] || null };
  return { flushed: dates.length - retry.length, errors };
}

async function readUsageDay(date, { store = null } = {}) {
  return foldShards(await shards.readDayShards(USAGE_PREFIX, date, { store }), date);
}

/** op=health block: today + yesterday (UTC) folded from Blob, plus the unflushed buffer for today. */
async function llmHealth({ now = Date.now(), store = null } = {}) {
  const today = shards.utcDate(now);
  const yesterday = shards.utcDate(now - 86400000);
  const [todayShards, y] = await Promise.all([shards.readDayShards(USAGE_PREFIX, today, { store }), readUsageDay(yesterday, { store })]);
  // This process's in-memory doc is always ≥ its own Blob shard (cumulative, possibly
  // unflushed) — substitute it so today is complete without double counting or a write.
  const mine = state.days[today];
  const others = mine ? todayShards.filter(s => s.instanceId !== shards.INSTANCE_ID) : todayShards;
  return buildLlmHealth(foldShards(mine ? [...others, mine] : others, today), y);
}

function peekBuffer() { return { days: state.days, dirty: [...state.dirty], lastFlushAt: state.lastFlushAt, lastFlushError: state.lastFlushError, flushes: state.flushes }; }
function _resetForTests() { if (state.timer) clearTimeout(state.timer); state = initialState(); }

module.exports = {
  PRICES, USAGE_PREFIX, FLUSH_INTERVAL_MS, MONTHLY_STOP_USD, DAILY_PACE_USD, DAY_OVER_DAY_JUMP, JUMP_FLOOR_USD,
  priceFor, normalizeUsage, estimateUsd, emptyCounters, addCall, mergeCounters, addToDayDoc, emptyDayDoc,
  foldShards, dayOverDayFlag, budgetFlag, buildLlmHealth,
  recordUsage, recordMessageUsage, flushUsage, readUsageDay, llmHealth, peekBuffer, _resetForTests,
};

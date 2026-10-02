'use strict';
// 🧑‍⚖️ LLM JUDGE — shadow second reader for evidence extraction (GitHub-scan proposal #8).
//
// A cheap Haiku grader re-reads a SAMPLE of evidence-extract outputs and answers one closed
// question per event: "is this event supported verbatim by the headlines it cites?" Results
// go to the `judge/v1/<date>/` ledger (per-process shards, lib/llm-ledger-shards.js) and feed
// the preregistered EDGAR AVOID pilot's "≥90% extraction agreement" gate. The judge NEVER
// blocks or alters the primary output: it is fire-and-forget, gated by LLM_JUDGE_FRACTION
// (default 0 → no call, no cost), and every failure is a value.
//
// Grading prompts are vendored from braintrustdata/autoevals (MIT) — templates/factuality.yaml
// and templates/closed_q_a.yaml at commit 38228ee — with their choice→score maps, so scores
// are comparable to the published scorers. The grade is returned through a strict
// `submit_grade` tool (choice enum + rationale) rather than parsed from prose.

const crypto = require('crypto');
const { buildForcedToolRequest, extractToolInput, recordResponseUsage } = require('./fable-call');
const shards = require('./llm-ledger-shards');

// ── Vendored autoevals templates (MIT) ──────────────────────────────────────
// MIT License
//
// Copyright (c) 2023 BrainTrust Data
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this
// software and associated documentation files (the "Software"), to deal in the Software
// without restriction, including without limitation the rights to use, copy, modify, merge,
// publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
// to whom the Software is furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
// PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
// FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.
const AUTOEVALS_SOURCE = 'https://github.com/braintrustdata/autoevals/tree/38228ee43be9fd666080d03a2fddc7ffc925aeba/templates';

// templates/factuality.yaml
const FACTUALITY_TEMPLATE = `You are comparing a submitted answer to an expert answer on a given question. Here is the data:
[BEGIN DATA]
************
[Question]: {{input}}
************
[Expert]: {{expected}}
************
[Submission]: {{output}}
************
[END DATA]

Compare the factual content of the submitted answer with the expert answer. Ignore any differences in style, grammar, or punctuation.
The submitted answer may either be a subset or superset of the expert answer, or it may conflict with it. Determine which case applies. Answer the question by selecting one of the following options:
(A) The submitted answer is a subset of the expert answer and is fully consistent with it.
(B) The submitted answer is a superset of the expert answer and is fully consistent with it.
(C) The submitted answer contains all the same details as the expert answer.
(D) There is a disagreement between the submitted answer and the expert answer.
(E) The answers differ, but these differences don't matter from the perspective of factuality.`;
const FACTUALITY_CHOICE_SCORES = Object.freeze({ A: 0.4, B: 0.6, C: 1, D: 0, E: 1 });

// templates/closed_q_a.yaml
const CLOSED_QA_TEMPLATE = `You are assessing a submitted answer on a given task based on a criterion. Here is the data:
[BEGIN DATA]
***
[Task]: {{input}}
***
[Submission]: {{output}}
***
[Criterion]: {{criteria}}
***
[END DATA]
Does the submission meet the criterion?`;
const CLOSED_QA_CHOICE_SCORES = Object.freeze({ Y: 1, N: 0 });

// ── Constants ───────────────────────────────────────────────────────────────

const JUDGE_MODEL = 'claude-haiku-4-5-20251001';
const JUDGE_VERSION = 'judge-v1';
const JUDGE_PREFIX = 'judge/v1/';
const JUDGE_CALL_SITE = 'llm-judge';
const FRACTION_ENV = 'LLM_JUDGE_FRACTION';
const DEFAULT_FRACTION = 0;             // tests + unconfigured deploys: no second read, no cost
const MAX_TOKENS = 400;
const CALL_TIMEOUT_MS = 20000;
const MAX_EVENTS_JUDGED = 6;            // mirrors evidence-extract MAX_EVENTS
const SAMPLE_SPACE = 10000;             // sampling resolution (0.01%)
const HEADLINE_CHARS = 240;
const SUPPORTED_SCORE = 1;

const SUPPORT_CRITERION = 'Every factual assertion in the submission — including every number, percentage, dollar figure, date and named party — is stated verbatim or near-verbatim in the cited headlines. Nothing is added, inferred, or combined from outside knowledge. A submission that only paraphrases what the headlines say meets the criterion; one that introduces any figure, entity or outcome the headlines do not state does not.';

// ── Pure helpers ────────────────────────────────────────────────────────────

/** Minimal {{var}} substitution (the templates use no other mustache features). */
function renderTemplate(template, vars = {}) {
  return String(template).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => (vars[key] == null ? '' : String(vars[key])));
}

function gradeTool(choices) {
  return {
    name: 'submit_grade',
    description: 'Submit your grade: exactly one of the allowed choices plus a one- or two-sentence rationale.',
    input_schema: {
      type: 'object',
      properties: {
        choice: { type: 'string', enum: [...choices], description: 'the single letter of the option that applies' },
        rationale: { type: 'string', description: 'why — cite the specific words that decided it' },
      },
      required: ['choice', 'rationale'],
    },
  };
}

/** Map a choice letter to its autoevals score; null for an unknown/missing choice. */
function scoreChoice(choice, choiceScores) {
  if (typeof choice !== 'string') return null;
  const key = choice.trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(choiceScores, key) ? choiceScores[key] : null;
}

/** Build the Haiku grading request. Pure. */
function buildJudgeRequest({ template, vars, choiceScores, model = JUDGE_MODEL } = {}) {
  if (!template || !choiceScores) throw new Error('buildJudgeRequest: template + choiceScores required');
  return buildForcedToolRequest({
    tool: gradeTool(Object.keys(choiceScores)),
    messages: [{ role: 'user', content: renderTemplate(template, vars) }],
    maxTokens: MAX_TOKENS,
    model,
  });
}

/** Read a grade off a Messages API response. Never throws. */
function parseGrade(msg, choiceScores) {
  const r = extractToolInput(msg, 'submit_grade');
  if (r.refused) return { choice: null, score: null, rationale: null, outcome: 'refused', model: r.model };
  const choice = r.input && typeof r.input.choice === 'string' ? r.input.choice.trim().toUpperCase() : null;
  const score = scoreChoice(choice, choiceScores);
  if (score == null) return { choice, score: null, rationale: null, outcome: 'failed', model: r.model };
  return { choice, score, rationale: r.input.rationale ? String(r.input.rationale).slice(0, 500) : null, outcome: 'ok', model: r.model };
}

/** LLM_JUDGE_FRACTION → 0..1 (default 0; junk → 0). */
function judgeFraction(env = process.env) {
  const raw = env && env[FRACTION_ENV];
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return DEFAULT_FRACTION;
  return Math.max(0, Math.min(1, n));
}

/** Deterministic sampling: the same key always lands on the same side of the fraction. */
function shouldSample(key, fraction) {
  if (!(fraction > 0)) return false;
  if (fraction >= 1) return true;
  const h = crypto.createHash('sha256').update(String(key)).digest();
  const bucket = h.readUInt32BE(0) % SAMPLE_SPACE;
  return bucket < Math.round(fraction * SAMPLE_SPACE);
}

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

/** The cited headlines, numbered, as the judge's [Task]; empty array when nothing valid is cited. */
function citedHeadlines(event, items) {
  const idxs = Array.isArray(event && event.sourceIndexes) ? event.sourceIndexes : [];
  return [...new Set(idxs.filter(i => Number.isInteger(i) && i >= 0 && i < items.length))]
    .map(i => `[${i}] ${clip(items[i].title, HEADLINE_CHARS)}${items[i].text ? ` — ${clip(items[i].text, HEADLINE_CHARS)}` : ''}`);
}

/** The submission text: the extractor's claim plus any figure it attached. */
function eventSubmission(event) {
  const parts = [clip(event.claim, 600)];
  if (event.quantitativeMagnitude != null) parts.push(`quantitativeMagnitude=${event.quantitativeMagnitude}`);
  if (event.surpriseMagnitude != null) parts.push(`surpriseMagnitude=${event.surpriseMagnitude}`);
  if (event.catalystDate) parts.push(`catalystDate=${clip(event.catalystDate, 10)}`);
  return parts.join('\n');
}

function eventSupportVars(ticker, event, items) {
  return {
    input: `Headlines about ${ticker} cited by an extractor as the ONLY sources for the event below:\n${citedHeadlines(event, items).join('\n')}`,
    output: eventSubmission(event),
    criteria: SUPPORT_CRITERION,
  };
}

/** Summarize judge rows (pure): agreement = share of graded events scored fully supported. */
function summarizeJudgeRows(rows) {
  const list = (rows || []).filter(Boolean);
  const graded = list.filter(r => r.outcome === 'ok');
  const supported = graded.filter(r => r.score === SUPPORTED_SCORE).length;
  const group = (sel) => graded.reduce((acc, r) => {
    const k = sel(r) || 'unknown';
    const cur = acc[k] || { n: 0, supported: 0 };
    return { ...acc, [k]: { n: cur.n + 1, supported: cur.supported + (r.score === SUPPORTED_SCORE ? 1 : 0) } };
  }, {});
  return {
    n: list.length, graded: graded.length, supported,
    agreementRate: graded.length ? +(supported / graded.length).toFixed(4) : null,
    refused: list.filter(r => r.outcome === 'refused').length,
    failed: list.filter(r => r.outcome === 'failed').length,
    byEventType: group(r => r.eventType),
    byPromptVersion: group(r => r.promptVersion),
  };
}

// ── Transport ───────────────────────────────────────────────────────────────

function defaultClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
}

/** One bounded grading call. Never throws — `{ choice, score, rationale, outcome, model, error }`. */
async function runJudge({ template, vars, choiceScores, client = null, model = JUDGE_MODEL, timeoutMs = CALL_TIMEOUT_MS } = {}) {
  const api = client || defaultClient();
  if (!api) return { choice: null, score: null, rationale: null, outcome: 'failed', model: null, error: 'no-api-key' };
  try {
    const request = buildJudgeRequest({ template, vars, choiceScores, model });
    const msg = await api.messages.create(request, { timeout: timeoutMs });
    recordResponseUsage(JUDGE_CALL_SITE, msg, model);
    return { ...parseGrade(msg, choiceScores), error: null };
  } catch (err) {
    const error = err && err.message ? String(err.message).slice(0, 200) : String(err);
    return { choice: null, score: null, rationale: null, outcome: 'failed', model: null, error };
  }
}

/** Grade one extracted event against the headlines it cites. Mechanical N when it cites nothing. */
async function judgeEventSupport({ ticker, event, items, client = null, model = JUDGE_MODEL } = {}) {
  if (!citedHeadlines(event, items || []).length) {
    return { choice: 'N', score: 0, rationale: 'event cites no valid headline index', outcome: 'ok', model: 'mechanical', error: null };
  }
  return runJudge({ template: CLOSED_QA_TEMPLATE, vars: eventSupportVars(ticker, event, items), choiceScores: CLOSED_QA_CHOICE_SCORES, client, model });
}

// ── Ledger (per-process cumulative day doc of rows) ─────────────────────────

let ledger = { days: {} };

function appendRows(date, rows) {
  const day = ledger.days[date] || { date, instanceId: shards.INSTANCE_ID, version: JUDGE_VERSION, rows: [] };
  const next = { ...day, updatedAt: new Date().toISOString(), rows: [...day.rows, ...rows] };
  ledger = { days: { ...ledger.days, [date]: next } };
  return next;
}

async function persistRows(date, rows, { store = null } = {}) {
  const doc = appendRows(date, rows);
  return shards.writeShard(JUDGE_PREFIX, date, doc, { store });
}

/** Fold a day's shards: rows deduped by key, plus the summary. Never throws. */
async function readJudgeDay(date, { store = null } = {}) {
  const docs = await shards.readDayShards(JUDGE_PREFIX, date, { store });
  const byKey = new Map();
  for (const d of docs) for (const r of (Array.isArray(d.rows) ? d.rows : [])) if (r && r.key) byKey.set(r.key, r);
  const rows = [...byKey.values()];
  return { date, shards: docs.length, rows, summary: summarizeJudgeRows(rows) };
}

// ── Entry point for evidence-extract ────────────────────────────────────────

function judgeRow({ date, ticker, fingerprint, promptVersion, index, event, grade, at }) {
  return {
    key: `${date}:${ticker}:${fingerprint}:${index}`, date, ticker, fingerprint, promptVersion,
    eventIndex: index, eventType: event.eventType || null, claim: clip(event.claim, 300),
    citedCount: Array.isArray(event.sourceIndexes) ? event.sourceIndexes.length : 0,
    choice: grade.choice, score: grade.score, supported: grade.score === SUPPORTED_SCORE,
    rationale: grade.rationale, outcome: grade.outcome, error: grade.error || null,
    judgeModel: grade.model, judgeVersion: JUDGE_VERSION, at: new Date(at).toISOString(),
  };
}

/**
 * Shadow second read of one extraction. Deterministically samples `fraction` of
 * (ticker, fingerprint) keys; grades each raw event sequentially; persists rows. Never throws.
 * Returns `{ sampled, reason?, rows?, summary? }`.
 */
async function sampleAndJudgeExtraction({ ticker, items, events, fingerprint, promptVersion, client = null, fraction = judgeFraction(), now = Date.now(), store = null } = {}) {
  try {
    if (!(fraction > 0)) return { sampled: false, reason: 'fraction-0' };
    const list = Array.isArray(events) ? events.filter(e => e && typeof e === 'object') : [];
    if (!list.length) return { sampled: false, reason: 'no-events' };
    if (!shouldSample(`${ticker}:${fingerprint}`, fraction)) return { sampled: false, reason: 'not-sampled' };
    const date = shards.utcDate(now);
    const rows = [];
    for (const [index, event] of list.slice(0, MAX_EVENTS_JUDGED).entries()) {
      const grade = await judgeEventSupport({ ticker, event, items: items || [], client });
      rows.push(judgeRow({ date, ticker, fingerprint, promptVersion, index, event, grade, at: now }));
    }
    const persisted = await persistRows(date, rows, { store });
    return { sampled: true, rows, summary: summarizeJudgeRows(rows), persisted: persisted.written };
  } catch (err) {
    return { sampled: false, reason: 'judge-error', error: err && err.message ? String(err.message).slice(0, 200) : String(err) };
  }
}

function _resetForTests() { ledger = { days: {} }; }

module.exports = {
  AUTOEVALS_SOURCE, FACTUALITY_TEMPLATE, FACTUALITY_CHOICE_SCORES, CLOSED_QA_TEMPLATE, CLOSED_QA_CHOICE_SCORES,
  JUDGE_MODEL, JUDGE_VERSION, JUDGE_PREFIX, JUDGE_CALL_SITE, FRACTION_ENV, DEFAULT_FRACTION, MAX_EVENTS_JUDGED, SUPPORT_CRITERION,
  renderTemplate, gradeTool, scoreChoice, buildJudgeRequest, parseGrade, judgeFraction, shouldSample,
  citedHeadlines, eventSubmission, eventSupportVars, summarizeJudgeRows,
  runJudge, judgeEventSupport, readJudgeDay, sampleAndJudgeExtraction, _resetForTests,
};

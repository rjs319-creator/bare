#!/usr/bin/env node
'use strict';
// 🧪 LLM GOLDEN-SET RUNNER (GitHub-scan proposal #7) — zero dependencies, node ≥ 20.
//
//   node research/llm-evals/run.js --dry                 validate fixtures + request shapes, run
//                                                        assertions on golden outputs (no API)
//   node research/llm-evals/run.js --live [--family f] [--limit n] [--rubric] [--bless]
//                                                        call the API through the REAL request
//                                                        builders; write results/<f>.latest.json;
//                                                        compare against results/<f>.baseline.json
//   node research/llm-evals/run.js --emit-promptfoo      regenerate promptfooconfig.yaml
//
// Gating: --live requires ANTHROPIC_API_KEY; --rubric additionally spends Haiku on an
// llm-rubric grade per case (lib/llm-judge ClosedQA). node --test only ever runs --dry.
// A pass-rate drop beyond --tolerance (default 0.05) versus the blessed baseline exits 1 —
// that is the PROMPT_VERSION bump gate described in README.md.

const fs = require('fs');
const path = require('path');
const { FAMILIES, FAMILY_NAMES, checkRequestShape } = require('./families');
const A = require('./assertions');
const FC = require('../../lib/fable-call');
const U = require('../../lib/llm-usage');

const ROOT = __dirname;
const CASES_DIR = path.join(ROOT, 'cases');
const RESULTS_DIR = path.join(ROOT, 'results');
const PROMPTFOO_PATH = path.join(ROOT, 'promptfooconfig.yaml');
const MIN_CASES_PER_FAMILY = 20;
const MIN_GOLDEN_PER_FAMILY = 4;      // incl. ≥1 negative control — assertions must be able to fail
const DEFAULT_TOLERANCE = 0.05;
const LIVE_TIMEOUT_MS = 60000;
const RUBRIC_PASS_SCORE = 1;

// ── Fixtures ────────────────────────────────────────────────────────────────

function casesPath(family) { return path.join(CASES_DIR, `${family}.json`); }

function loadFamilyCases(family) {
  const raw = fs.readFileSync(casesPath(family), 'utf8');
  const doc = JSON.parse(raw);
  if (doc.family !== family) throw new Error(`${family}.json: family field is ${doc.family}`);
  if (!Array.isArray(doc.cases)) throw new Error(`${family}.json: cases[] missing`);
  return doc;
}

function fixtureViolations(adapter, c) {
  const v = [];
  if (!c || typeof c.id !== 'string' || !c.id) v.push('id required');
  if (!c || !c.input || typeof c.input !== 'object') v.push('input object required');
  else v.push(...adapter.validateInput(c.input));
  if (c && c.golden) {
    if (typeof c.golden.expectPass !== 'boolean') v.push('golden.expectPass boolean required');
    if (!c.golden.output || typeof c.golden.output !== 'object') v.push('golden.output object required');
  }
  return v;
}

// ── Dry mode (fixtures + request shapes + golden assertions) ────────────────

function runCaseDry(adapter, c) {
  const inputViolations = fixtureViolations(adapter, c);
  let request = null, requestError = null, shapeViolations = [];
  if (!inputViolations.length) {
    try { request = adapter.buildRequest(c.input); shapeViolations = checkRequestShape(adapter, request); } catch (e) { requestError = e.message; }
  }
  let golden = null;
  if (!inputViolations.length && c.golden && c.golden.output) {
    const verdict = A.all(adapter.assert(c.input, c.golden.output, request));
    golden = { expectPass: c.golden.expectPass, passed: verdict.ok, matches: verdict.ok === c.golden.expectPass, failed: verdict.failed.map(f => `${f.name}: ${f.detail}`) };
  }
  const ok = !inputViolations.length && !requestError && !shapeViolations.length && (!golden || golden.matches);
  return { id: c && c.id, ok, inputViolations, requestError, shapeViolations, golden };
}

function summarizeDryFamily(adapter, doc) {
  const details = doc.cases.map(c => runCaseDry(adapter, c));
  const goldens = details.filter(d => d.golden);
  const negatives = goldens.filter(d => d.golden.expectPass === false);
  const problems = [];
  if (doc.cases.length < MIN_CASES_PER_FAMILY) problems.push(`${doc.cases.length} cases < ${MIN_CASES_PER_FAMILY}`);
  if (goldens.length < MIN_GOLDEN_PER_FAMILY) problems.push(`${goldens.length} golden outputs < ${MIN_GOLDEN_PER_FAMILY}`);
  if (!negatives.length) problems.push('no negative-control golden (expectPass:false) — assertions could not fail');
  const ids = new Set();
  for (const c of doc.cases) { if (ids.has(c.id)) problems.push(`duplicate id ${c.id}`); ids.add(c.id); }
  const failing = details.filter(d => !d.ok);
  return {
    family: adapter.name, model: adapter.model, transport: adapter.transport, promptVersion: adapter.promptVersion,
    cases: doc.cases.length, goldens: goldens.length, negatives: negatives.length,
    ok: !problems.length && !failing.length, problems, failing, details,
  };
}

function runDry({ families = FAMILY_NAMES } = {}) {
  const out = {};
  for (const name of families) {
    const adapter = FAMILIES[name];
    if (!adapter) throw new Error(`unknown family ${name}`);
    out[name] = summarizeDryFamily(adapter, loadFamilyCases(name));
  }
  return { ok: Object.values(out).every(f => f.ok), families: out };
}

// ── Live mode ───────────────────────────────────────────────────────────────

function defaultClient() {
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
}

async function sendRequest(adapter, request, client) {
  const api = adapter.transport === 'fable' ? client.beta.messages : client.messages;
  return api.create(request, { timeout: LIVE_TIMEOUT_MS });
}

async function gradeRubric(adapter, c, output, client) {
  const J = require('../../lib/llm-judge');
  const vars = { input: JSON.stringify(c.input).slice(0, 6000), output: JSON.stringify(output).slice(0, 4000), criteria: adapter.rubric };
  return J.runJudge({ template: J.CLOSED_QA_TEMPLATE, vars, choiceScores: J.CLOSED_QA_CHOICE_SCORES, client });
}

async function runCaseLive(adapter, c, { client, rubric = false } = {}) {
  const request = adapter.buildRequest(c.input);
  const shapeViolations = checkRequestShape(adapter, request);
  let msg;
  try { msg = await sendRequest(adapter, request, client); } catch (e) {
    return { id: c.id, outcome: 'failed', error: String(e && e.message || e).slice(0, 200), pass: false, assertions: [], usd: 0, shapeViolations };
  }
  U.recordUsage({ callSite: `llm-evals:${adapter.name}`, model: msg.model || request.model, usage: msg.usage });
  const usd = U.estimateUsd(msg.model || request.model, msg.usage);
  const r = FC.extractToolInput(msg, adapter.tool.name);
  if (r.refused) return { id: c.id, outcome: 'refused', category: r.category, pass: false, assertions: [], usd, shapeViolations };
  if (!r.input) return { id: c.id, outcome: 'failed', error: 'no tool call', pass: false, assertions: [], usd, shapeViolations };
  const verdict = A.all(adapter.assert(c.input, r.input, request));
  const result = { id: c.id, outcome: 'ok', model: msg.model, pass: verdict.ok && !shapeViolations.length, assertions: verdict.failed.map(f => `${f.name}: ${f.detail}`), usd, output: r.input, shapeViolations };
  if (rubric) {
    const g = await gradeRubric(adapter, c, r.input, client);
    result.rubric = { outcome: g.outcome, choice: g.choice, score: g.score, rationale: g.rationale };
    result.rubricUsd = 0; // folded into the ledger under llm-judge; shown separately in the summary
    result.pass = result.pass && g.outcome === 'ok' && g.score === RUBRIC_PASS_SCORE;
  }
  return result;
}

async function runLiveFamily(adapter, doc, { client, limit = null, rubric = false } = {}) {
  const cases = limit ? doc.cases.slice(0, limit) : doc.cases;
  const results = [];
  for (const c of cases) results.push(await runCaseLive(adapter, c, { client, rubric }));   // sequential: bounded spend + rate
  const passed = results.filter(r => r.pass).length;
  return {
    family: adapter.name, model: adapter.model, promptVersion: adapter.promptVersion, at: new Date().toISOString(),
    n: results.length, passed, passRate: results.length ? +(passed / results.length).toFixed(4) : null,
    refused: results.filter(r => r.outcome === 'refused').length, failed: results.filter(r => r.outcome === 'failed').length,
    usd: +results.reduce((s, r) => s + (r.usd || 0), 0).toFixed(4), rubric, results,
  };
}

function baselinePath(family) { return path.join(RESULTS_DIR, `${family}.baseline.json`); }
function latestPath(family) { return path.join(RESULTS_DIR, `${family}.latest.json`); }

function readBaseline(family) {
  try { return JSON.parse(fs.readFileSync(baselinePath(family), 'utf8')); } catch { return null; }
}

/** Pure: does `result` regress versus `baseline` beyond `tolerance`? */
function compareToBaseline(result, baseline, tolerance = DEFAULT_TOLERANCE) {
  if (!baseline || baseline.passRate == null) return { ok: true, reason: 'no baseline', delta: null };
  if (result.passRate == null) return { ok: false, reason: 'no cases ran', delta: null };
  const delta = +(result.passRate - baseline.passRate).toFixed(4);
  const ok = delta >= -tolerance;
  return { ok, delta, baselinePassRate: baseline.passRate, reason: ok ? 'within tolerance' : `pass rate fell ${Math.abs(delta)} > ${tolerance}` };
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`);
}

async function runLive({ families = FAMILY_NAMES, limit = null, rubric = false, bless = false, tolerance = DEFAULT_TOLERANCE, client = null } = {}) {
  if (!client && !process.env.ANTHROPIC_API_KEY) throw new Error('--live needs ANTHROPIC_API_KEY (or an injected client)');
  const api = client || defaultClient();
  const out = {};
  for (const name of families) {
    const adapter = FAMILIES[name];
    if (!adapter) throw new Error(`unknown family ${name}`);
    const res = await runLiveFamily(adapter, loadFamilyCases(name), { client: api, limit, rubric });
    const compared = compareToBaseline(res, readBaseline(name), tolerance);
    writeJson(latestPath(name), res);
    if (bless) writeJson(baselinePath(name), { family: name, model: res.model, promptVersion: res.promptVersion, at: res.at, n: res.n, passRate: res.passRate, rubric });
    out[name] = { ...res, baseline: compared };
  }
  await U.flushUsage().catch(() => {});
  return { ok: Object.values(out).every(f => f.baseline.ok), families: out };
}

// ── promptfoo config emission ───────────────────────────────────────────────

function emitPromptfoo() {
  const lines = [
    '# Generated by `node research/llm-evals/run.js --emit-promptfoo` — do not edit by hand.',
    '# promptfoo is NOT a dependency of this repo. To use it later:',
    '#   npx promptfoo@latest eval -c research/llm-evals/promptfooconfig.yaml',
    '# The provider builds every request through the site\'s own builders (families.js) and',
    '# the assertion re-runs the same pure checks node --test runs in dry mode.',
    'description: market-news-app LLM golden-set regression (5 prompt families)',
    'providers:',
    '  - id: file://./promptfoo-provider.js',
    '    label: site-request-builders',
    'prompts:',
    "  - '{{family}}/{{caseId}}'",
    'defaultTest:',
    '  assert:',
    '    - type: javascript',
    '      value: file://./promptfoo-assert.js',
    'tests:',
  ];
  for (const name of FAMILY_NAMES) {
    for (const c of loadFamilyCases(name).cases) {
      lines.push(`  - description: ${name} ${c.id}`);
      lines.push(`    vars: { family: ${name}, caseId: ${c.id} }`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { dry: false, live: false, families: null, limit: null, rubric: false, bless: false, emitPromptfoo: false, tolerance: DEFAULT_TOLERANCE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') args.dry = true;
    else if (a === '--live') args.live = true;
    else if (a === '--rubric') args.rubric = true;
    else if (a === '--bless') args.bless = true;
    else if (a === '--emit-promptfoo') args.emitPromptfoo = true;
    else if (a === '--family') args.families = [...(args.families || []), argv[++i]];
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10) || null;
    else if (a === '--tolerance') args.tolerance = parseFloat(argv[++i]);
    else throw new Error(`unknown arg ${a}`);
  }
  return args;
}

function printDry(r) {
  for (const f of Object.values(r.families)) {
    const flag = f.ok ? 'ok ' : 'FAIL';
    console.log(`${flag} ${f.family.padEnd(20)} ${f.transport.padEnd(6)} ${f.model.padEnd(28)} cases=${f.cases} goldens=${f.goldens} negatives=${f.negatives}`);
    for (const p of f.problems) console.log(`     problem: ${p}`);
    for (const d of f.failing) {
      console.log(`     ${d.id}: ${[...d.inputViolations, d.requestError, ...d.shapeViolations].filter(Boolean).join('; ')}`);
      if (d.golden && !d.golden.matches) console.log(`       golden expectPass=${d.golden.expectPass} but passed=${d.golden.passed}: ${d.golden.failed.join(' | ') || '(no failures)'}`);
    }
  }
  console.log(r.ok ? 'DRY RUN OK' : 'DRY RUN FAILED');
}

function printLive(r) {
  for (const f of Object.values(r.families)) {
    const b = f.baseline;
    console.log(`${b.ok ? 'ok ' : 'FAIL'} ${f.family.padEnd(20)} pass ${f.passed}/${f.n} (${f.passRate}) refused=${f.refused} failed=${f.failed} $${f.usd}${b.baselinePassRate != null ? ` baseline=${b.baselinePassRate} Δ=${b.delta}` : ' (no baseline)'}`);
    for (const c of f.results.filter(x => !x.pass)) console.log(`     ${c.id} [${c.outcome}] ${(c.assertions || []).join(' | ') || c.error || c.category || ''}${c.rubric ? ` rubric=${c.rubric.choice}` : ''}`);
  }
  console.log(r.ok ? 'LIVE RUN OK' : 'LIVE RUN REGRESSED');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.emitPromptfoo) { fs.writeFileSync(PROMPTFOO_PATH, emitPromptfoo()); console.log(`wrote ${PROMPTFOO_PATH}`); return 0; }
  const families = args.families || FAMILY_NAMES;
  if (args.live) {
    const r = await runLive({ families, limit: args.limit, rubric: args.rubric, bless: args.bless, tolerance: args.tolerance });
    printLive(r);
    return r.ok ? 0 : 1;
  }
  const r = runDry({ families });
  printDry(r);
  return r.ok ? 0 : 1;
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(err => { console.error(err.message); process.exit(2); });
}

module.exports = {
  MIN_CASES_PER_FAMILY, MIN_GOLDEN_PER_FAMILY, DEFAULT_TOLERANCE, CASES_DIR, RESULTS_DIR,
  loadFamilyCases, fixtureViolations, runCaseDry, runDry, runCaseLive, runLive, compareToBaseline, emitPromptfoo, parseArgs,
};

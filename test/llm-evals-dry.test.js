'use strict';
// research/llm-evals — dry mode is the part that runs in CI: fixtures load, every request
// builds through the REAL production builders with the right shape, and the golden outputs
// (positive AND negative controls) agree with the assertions. No API key, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const R = require('../research/llm-evals/run');
const { FAMILIES, FAMILY_NAMES, checkRequestShape } = require('../research/llm-evals/families');
const A = require('../research/llm-evals/assertions');
const { validate } = require('../research/llm-evals/schema-check');

test('dry run: every family passes with ≥20 cases, ≥4 goldens and ≥1 negative control', () => {
  const r = R.runDry();
  for (const f of Object.values(r.families)) {
    assert.ok(f.ok, `${f.family}: ${f.problems.join('; ')} ${f.failing.map(d => `${d.id}:${[...d.inputViolations, d.requestError, ...d.shapeViolations, d.golden && !d.golden.matches ? d.golden.failed.join('|') : null].filter(Boolean).join(';')}`).join(' ')}`);
    assert.ok(f.cases >= R.MIN_CASES_PER_FAMILY, `${f.family} has ${f.cases} cases`);
    assert.ok(f.goldens >= R.MIN_GOLDEN_PER_FAMILY);
    assert.ok(f.negatives >= 1);
  }
  assert.deepEqual(Object.keys(r.families).sort(), [...FAMILY_NAMES].sort());
  assert.equal(r.ok, true);
});

test('every fixture file is marked as synthetic and frozen', () => {
  for (const name of FAMILY_NAMES) {
    const doc = R.loadFamilyCases(name);
    assert.match(doc.fixtureNote, /FIXTURES/);
    assert.match(doc.fixtureNote, /fictional/);
    assert.match(doc.frozenAt, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('request shapes come from the production builders: forced for Haiku/Sonnet, strict+auto for Fable', () => {
  const ee = FAMILIES['evidence-extract'];
  const c = R.loadFamilyCases('evidence-extract').cases[0];
  const req = ee.buildRequest(c.input);
  assert.deepEqual(req.tool_choice, { type: 'tool', name: 'submit_events' });
  assert.equal(req.model, require('../lib/evidence-extract').MODEL);
  assert.deepEqual(checkRequestShape(ee, req), []);

  const pn = FAMILIES['pulse-narrative'];
  const pc = R.loadFamilyCases('pulse-narrative').cases[0];
  const preq = pn.buildRequest(pc.input);
  assert.equal(preq.tool_choice.type, 'auto');
  assert.equal(preq.tools[0].strict, true);
  assert.equal(preq.model, 'claude-fable-5-1');
  assert.deepEqual(checkRequestShape(pn, preq), []);

  // The shape checker itself can fail: a forced request handed to the Fable adapter is rejected.
  assert.ok(checkRequestShape(pn, req).length >= 2);
});

test('negative controls really fail and positives really pass (assertions are not tautologies)', () => {
  for (const name of FAMILY_NAMES) {
    const adapter = FAMILIES[name];
    for (const c of R.loadFamilyCases(name).cases.filter(x => x.golden)) {
      const d = R.runCaseDry(adapter, c);
      assert.equal(d.golden.passed, c.golden.expectPass, `${name}/${c.id}: ${d.golden.failed.join(' | ')}`);
      if (!c.golden.expectPass) assert.ok(d.golden.failed.length >= 1, `${name}/${c.id} negative control must name a failure`);
    }
  }
});

test('assertions: numbers verbatim, index subsets, hedging, schema', () => {
  assert.equal(A.numbersVerbatim('raised guidance 8% and beat by $0.12', 'beats by $0.12, raises guidance 8%').ok, true);
  assert.equal(A.numbersVerbatim('raised guidance 15%', 'raises guidance 8%').ok, false);
  assert.equal(A.numbersVerbatim('FY26 outlook', 'FY2026 revenue outlook').ok, true, 'suffix of a longer token is grounded');
  assert.equal(A.numbersVerbatim('sales of 1200 units', 'sold 1,200 units').ok, true, 'comma-insensitive');
  assert.equal(A.numberFieldGrounded(0.12, 'beat by $0.12').ok, true);
  assert.equal(A.numberFieldGrounded(8, 'guidance 8%').ok, true);
  assert.equal(A.numberFieldGrounded(150, '$150 million').ok, true);
  assert.equal(A.numberFieldGrounded(12, '$0.12 beat').ok, false, '12 is not grounded by 0.12');
  assert.equal(A.numberFieldGrounded(null, '').ok, true);
  assert.equal(A.indexesSubset([0, 2], 3).ok, true);
  assert.equal(A.indexesSubset([0, 3], 3).ok, false);
  assert.equal(A.indexesSubset([1.5], 3).ok, false);
  assert.equal(A.noHedging('It could go either way here.').ok, false);
  assert.equal(A.subsetOf(['A', 'Z'], ['A', 'B']).ok, false);
  const schema = { type: 'object', properties: { n: { type: 'integer' }, k: { type: 'string', enum: ['a'] }, arr: { type: 'array', items: { type: ['number', 'null'] } } }, required: ['n', 'k'] };
  assert.deepEqual(validate(schema, { n: 1, k: 'a', arr: [1, null] }), []);
  assert.ok(validate(schema, { n: 1.5, k: 'b' }).length === 2);
  assert.ok(validate(schema, { k: 'a' }).some(v => /required/.test(v)));
});

test('compareToBaseline: tolerance gate', () => {
  assert.equal(R.compareToBaseline({ passRate: 0.9 }, { passRate: 0.95 }).ok, true);
  assert.equal(R.compareToBaseline({ passRate: 0.8 }, { passRate: 0.95 }).ok, false);
  assert.equal(R.compareToBaseline({ passRate: 0.8 }, null).ok, true);
  assert.equal(R.compareToBaseline({ passRate: null }, { passRate: 0.9 }).ok, false);
});

test('emitPromptfoo lists every case and points at the local provider/assert shims', () => {
  const yaml = R.emitPromptfoo();
  assert.match(yaml, /file:\/\/\.\/promptfoo-provider\.js/);
  assert.match(yaml, /file:\/\/\.\/promptfoo-assert\.js/);
  const total = FAMILY_NAMES.reduce((s, n) => s + R.loadFamilyCases(n).cases.length, 0);
  assert.equal((yaml.match(/caseId: /g) || []).length, total);
  const committed = fs.readFileSync(path.join(__dirname, '..', 'research', 'llm-evals', 'promptfooconfig.yaml'), 'utf8');
  assert.equal(committed, yaml, 'promptfooconfig.yaml is stale — run node research/llm-evals/run.js --emit-promptfoo');
});

test('parseArgs: CLI flags', () => {
  const a = R.parseArgs(['--live', '--family', 'bear-case', '--limit', '3', '--rubric', '--tolerance', '0.1']);
  assert.deepEqual(a.families, ['bear-case']);
  assert.equal(a.limit, 3);
  assert.equal(a.rubric, true);
  assert.equal(a.tolerance, 0.1);
  assert.throws(() => R.parseArgs(['--bogus']));
});

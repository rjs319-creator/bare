'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const gp = require('../lib/gameplan');
const { normalizeMacro, renderNarrative } = require('../lib/gameplan-routes');

test('macroLine renders present fields and is graceful when null', () => {
  assert.match(gp.macroLine({ regime: 'risk-off', vix: 28.4, vixPctile: 91, macroRisk: 62 }), /risk-off/);
  assert.match(gp.macroLine({ regime: 'risk-off', vix: 28.4 }), /VIX=28\.4/);
  assert.equal(gp.macroLine(null), 'Macro/regime: unavailable.');
});

test('headlinesBlock numbers items, caps, and tags sources', () => {
  const hs = [
    { title: 'Fed holds rates', source: { name: 'Reuters' } },
    { title: 'CPI cooler than expected', source: { name: 'CNBC' } },
  ];
  const block = gp.headlinesBlock(hs);
  assert.match(block, /1\. Fed holds rates \[Reuters\]/);
  assert.match(block, /2\. CPI cooler than expected \[CNBC\]/);
  assert.equal(gp.headlinesBlock([]), 'Headlines: none available.');
  // cap respected
  const many = Array.from({ length: 30 }, (_, i) => ({ title: `h${i}` }));
  assert.equal(gp.headlinesBlock(many, 5).split('\n').length, 6); // header + 5
});

test('signalsLine surfaces present signals only', () => {
  assert.match(gp.signalsLine({ fadeRegime: 'risk-off', trendLight: 'red' }), /fade engine=OFF \(risk-off\)/);
  assert.match(gp.signalsLine({ trendLight: 'green' }), /trend climate=green/);
  assert.equal(gp.signalsLine(null), 'App signals: none.');
});

test('optionsFlowLine renders the SHADOW read + top names, graceful when absent, no "smart money"', () => {
  const line = gp.optionsFlowLine({ marketGrade: 'Bullish', marketScore: 31, topStocks: [{ ticker: 'MU', grade: 'Very Bullish', score: 94 }, { ticker: 'TSLA', grade: 'Neutral', score: 2 }] });
  assert.match(line, /market read Bullish \(\+31\)/);
  assert.match(line, /MU Very Bullish \(\+94\)/);
  assert.match(line, /TSLA Neutral \(\+2\)/);
  assert.match(line, /SHADOW/);
  assert.doesNotMatch(line, /smart[- ]money positioning|is smart money|unusual smart-money/i, 'must not make an affirmative smart-money claim');
  assert.match(line, /provisional/i);
  assert.match(line, /NOT proof/);
  assert.equal(gp.optionsFlowLine(null), 'Options activity: unavailable.');
});

test('buildUserMessage includes the options-activity line when provided', () => {
  const msg = gp.buildUserMessage({ date: '2026-06-26', macro: null, headlines: [], signals: null,
    optionsFlow: { marketGrade: 'Bullish', marketScore: 31, topStocks: [{ ticker: 'MU', grade: 'Very Bullish', score: 94 }] }, priorNarrative: '' });
  assert.match(msg, /options activity .* market read Bullish/i);
  assert.match(msg, /MU Very Bullish/);
});

test('buildUserMessage includes date, headlines, and prior narrative when present', () => {
  const msg = gp.buildUserMessage({
    date: '2026-06-26',
    macro: { regime: 'neutral', vix: 16 },
    headlines: [{ title: 'Nvidia earnings beat' }],
    signals: { fadeRegime: 'neutral' },
    priorNarrative: 'Yesterday the tape was risk-on into CPI.',
  });
  assert.match(msg, /DATE: 2026-06-26/);
  assert.match(msg, /Nvidia earnings beat/);
  assert.match(msg, /PRIOR NARRATIVE/);
  assert.match(msg, /submit_game_plan/);
});

test('buildUserMessage omits the prior-narrative section when empty', () => {
  const msg = gp.buildUserMessage({ date: '2026-06-26', macro: null, headlines: [], signals: null, priorNarrative: '' });
  assert.doesNotMatch(msg, /PRIOR NARRATIVE/);
});

test('GAMEPLAN_TOOL schema requires the renderable fields', () => {
  const req = gp.GAMEPLAN_TOOL.input_schema.required;
  for (const f of ['sentiment', 'headline', 'drivers', 'gamePlan', 'predictions', 'novice', 'pro', 'narrativeUpdate']) {
    assert.ok(req.includes(f), `schema requires ${f}`);
  }
});

test('normalizeMacro flattens fetchMacro nested shape', () => {
  const flat = normalizeMacro({ regime: 'risk-on', vix: { level: 14.2, pctile: 8 }, macroRisk: 12, creditStress: 0 });
  assert.equal(flat.regime, 'risk-on');
  assert.equal(flat.vix, 14.2);
  assert.equal(flat.vixPctile, 8);
  assert.equal(normalizeMacro(null), null);
});

test('renderNarrative joins dated entries', () => {
  const text = renderNarrative([{ date: '2026-06-25', text: 'risk-on melt-up' }, { date: '2026-06-26', text: 'CPI day, chop' }]);
  assert.match(text, /\[2026-06-25\] risk-on melt-up/);
  assert.match(text, /\[2026-06-26\] CPI day, chop/);
  assert.equal(renderNarrative([]), '');
});

test('synthesize parses the forced tool_use block (mocked client)', async () => {
  const fakePlan = { sentiment: { tone: 'neutral', oneLiner: 'x' }, headline: 'h', drivers: [], gamePlan: { lean: [], avoid: [], watch: [] }, predictions: [], novice: 'n', pro: 'p', narrativeUpdate: 'u' };
  const client = { messages: { create: async () => ({ content: [{ type: 'tool_use', name: 'submit_game_plan', input: fakePlan }] }) } };
  const out = await gp.synthesize(client, { date: '2026-06-26', macro: null, headlines: [], signals: null, priorNarrative: '' });
  assert.deepEqual(out, fakePlan);
});

test('synthesize throws when no tool block is returned', async () => {
  const client = { messages: { create: async () => ({ content: [{ type: 'text', text: 'oops' }] }) } };
  await assert.rejects(() => gp.synthesize(client, { date: '2026-06-26', macro: null, headlines: [], signals: null, priorNarrative: '' }), /No game plan/);
});

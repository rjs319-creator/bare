'use strict';
// ONE regime view for every render (site audit 2026-10-02 #6): the Today header said RISK-ON
// (macro, VIX + credit) while the board said Risk-off (breadth). lib/regime-view composes both
// reads once, names the GOVERNING one (breadth — what the ranker/eligibility gate consume) and
// labels the macro read as macro risk, so no render can call both "the regime".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const RV = require('../lib/regime-view');

const BREADTH_OFF = { indexAbove200: true, breadthPct: 22, bearish: true, riskOn: false, raw: 'RISK_OFF', active: 'RISK_ON', condition: 'riskoff' };
const MACRO_ON = { asOf: '2026-10-01', regime: 'risk-on', macroRisk: 18, vix: { level: 15.2, pctile: 20, rising: false }, riskOff: false, riskOn: true };

test('breadth governs; macro is labelled macro risk; disagreement is stated, not averaged', () => {
  const v = RV.composeRegimeView({ breadth: BREADTH_OFF, macro: MACRO_ON });
  assert.equal(v.governing.regime, 'risk-off');
  assert.equal(v.governing.label, 'Risk-off');
  assert.equal(v.governing.basis, 'breadth');
  assert.equal(v.breadth.kind, 'Breadth regime');
  assert.equal(v.breadth.breadthPct, 22);
  assert.equal(v.breadth.latched, 'risk-on');          // the server latch (SPY 200-DMA) is exposed, not hidden
  assert.equal(v.breadth.raw, 'risk-off');
  assert.equal(v.macro.kind, 'Macro risk');
  assert.equal(v.macro.regime, 'risk-on');
  assert.equal(v.macro.vixLevel, 15.2);
  assert.equal(v.agree, false);
  assert.match(v.note, /Macro risk .* reads risk-on while the breadth regime reads risk-off/);
  assert.match(v.note, /breadth regime governs/);
});

test('op=tape shape (macro only): no governing regime is claimed and the note says where it lives', () => {
  const tape = { ok: true, regime: 'risk-on', macro: { regime: 'risk-on', macroRisk: 18, vix: { level: 15.2 } } };
  const v = RV.composeRegimeView({ macro: tape });
  assert.equal(v.governing, null);
  assert.equal(v.breadth, null);
  assert.equal(v.macro.regime, 'risk-on');
  assert.equal(v.agree, null);
  assert.match(v.note, /op=today/);
  // A bare level string (the feed's board.regime) composes the same way.
  assert.equal(RV.composeRegimeView({ macro: 'risk-off' }).macro.regime, 'risk-off');
});

test('agreeing reads carry no disagreement note; unknown inputs are null, never "neutral"', () => {
  const v = RV.composeRegimeView({ breadth: { ...BREADTH_OFF, bearish: false, riskOn: false }, macro: 'neutral' });
  assert.equal(v.governing.regime, 'neutral');
  assert.equal(v.agree, true);
  assert.equal(v.note, null);
  const empty = RV.composeRegimeView({});
  assert.equal(empty.governing, null); assert.equal(empty.macro, null); assert.equal(empty.breadth, null);
  assert.equal(RV.composeRegimeView({ macro: 'bogus' }).macro, null);
});

test('the governing label matches op=today\'s legacy regime.label exactly (one vocabulary)', () => {
  for (const [b, label] of [[{ bearish: true, riskOn: false }, 'Risk-off'], [{ bearish: false, riskOn: true }, 'Risk-on'], [{ bearish: false, riskOn: false }, 'Neutral']]) {
    const legacy = b.bearish ? 'Risk-off' : b.riskOn ? 'Risk-on' : 'Neutral';
    assert.equal(RV.composeRegimeView({ breadth: b }).governing.label, label);
    assert.equal(legacy, label);
  }
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const RR = require('../lib/algo-router-routes');

function fakeRes() {
  return {
    headers: {}, body: null, code: 200,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o) { this.body = o; return o; },
  };
}

// ── configured:false path is inert and safe (no store, no network) ───────────
test('runRouter with no store returns an inert configured:false payload', async () => {
  const hadToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  const res = fakeRes();
  await RR.runRouter({ query: {} }, res);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.configured, false);
  if (hadToken) process.env.BLOB_READ_WRITE_TOKEN = hadToken;
});

// ── longTermFromStats: maturity's 0–100 scale → 0–1 skill shape ──────────────
test('longTermFromStats rescales beat-rate/CI from percent to fraction', () => {
  const lt = RR.longTermFromStats({ excessN: 30, avgExcess: 2.1, beatMktRate: 68, beatLo: 54, beatHi: 80 });
  assert.equal(lt.effN, 30);
  assert.equal(lt.beatRate, 0.68);
  assert.equal(lt.ci.lo, 0.54);
  assert.equal(lt.ci.hi, 0.8);
  assert.equal(lt.ready, true);
});

test('longTermFromStats returns null without an excessN', () => {
  assert.equal(RR.longTermFromStats(null), null);
  assert.equal(RR.longTermFromStats({ avgExcess: 1 }), null);
});

// ── independenceFor: minimum measured credit, null when unmeasured ───────────
test('independenceFor takes the minimum measured credit across siblings', () => {
  const model = {
    credits: { 'ghost|screener': 0.3, 'ghost|momentum': 0.8 },
    pairs: [], gates: {}, priorCredit: 0.3,
  };
  // Only measured pairs count; min(0.3, 0.8) = 0.3.
  assert.equal(RR.independenceFor(model, 'ghost', ['screener', 'momentum', 'coil']), 0.3);
  // No measured pair for 'coil' → null (unknown).
  assert.equal(RR.independenceFor(model, 'coil', ['screener', 'momentum', 'ghost']), null);
});

// ── regimeCompatFor: current regime bucket ranked among the three ────────────
test('regimeCompatFor scores high when the algo paid in the CURRENT regime', () => {
  // Algo made money in risk-on, lost in risk-off.
  const series = [
    { date: 'a', excess: 3 }, { date: 'b', excess: 2 }, { date: 'c', excess: 4 }, // risk-on
    { date: 'd', excess: -3 }, { date: 'e', excess: -2 }, { date: 'f', excess: -4 }, // risk-off
  ];
  const reg = { a: 'risk-on', b: 'risk-on', c: 'risk-on', d: 'risk-off', e: 'risk-off', f: 'risk-off' };
  const macroLU = { at: (d) => ({ regime: reg[d] }) };
  assert.equal(RR.regimeCompatFor(series, macroLU, 'risk-on'), 1);   // best bucket → 1
  assert.equal(RR.regimeCompatFor(series, macroLU, 'risk-off'), 0);  // worst bucket → 0
});

test('regimeCompatFor returns null when the current bucket has too little history', () => {
  const series = [{ date: 'a', excess: 1 }, { date: 'b', excess: 2 }];
  const macroLU = { at: () => ({ regime: 'risk-on' }) };
  assert.equal(RR.regimeCompatFor(series, macroLU, 'risk-off'), null);
});

// ── marketBlock: coarse probability vector + change detection ────────────────
test('marketBlock produces a normalised state vector and flags a regime change', () => {
  const macroNow = { regime: 'risk-off', macroRisk: 70, vix: { level: 30, pctile: 88, rising: true }, credit: { trend20: -1.2, belowSma: true } };
  const b = RR.marketBlock(macroNow, 'risk-on');
  assert.equal(b.dominant, 'risk-off');
  assert.equal(b.changedRecently, true);
  const sum = b.states.reduce((a, s) => a + s.probability, 0);
  assert.ok(Math.abs(sum - 1) < 0.03);
  assert.equal(b.states[0].name, 'risk-off'); // highest probability first
});

test('marketBlock degrades gracefully when the macro feed is down', () => {
  const b = RR.marketBlock(null, null);
  assert.deepEqual(b.states, []);
  assert.equal(b.confidence, 0);
});

// ── family map bridges correlated clusters ───────────────────────────────────
test('familyOf groups the known correlated price-momentum cluster', () => {
  assert.equal(RR.familyOf('ghost'), RR.familyOf('screener'));
  assert.equal(RR.familyOf('gapgo'), RR.familyOf('daytrade'));
  assert.equal(RR.familyOf('unlisted-x'), 'unlisted-x'); // its own family by default
});

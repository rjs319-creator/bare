'use strict';
// RLT scan — determinism, full-funnel capture, shadow invariants, and the
// ATLAS-X expert integration (abstains without the injected cross-section).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runRltScan, compactLeadershipSnapshot } = require('../lib/rlt-scan');
const { assessRelativeLeadershipTransition } = require('../lib/atlasx-experts');
const { validateExpertAssessment } = require('../lib/atlasx-contracts');
const { assertShadow } = require('../lib/rlt-governance');

function mkBars(n, seed = 1, drift = 0.001) {
  let p = 50 + seed;
  const out = [];
  const d0 = new Date('2026-01-05');
  let day = 0;
  while (out.length < n) {
    const dt = new Date(d0.getTime() + day * 86400000); day++;
    const wd = dt.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    p = p * (1 + drift + 0.012 * Math.sin(seed + out.length * 0.7));
    out.push([dt.toISOString().slice(0, 10), p * 0.997, p * 1.008, p * 0.992, p, 1e6 + 1e4 * out.length, p]);
  }
  return out;
}

function fixtureScan(mode = 'shadow') {
  const spy = mkBars(140, 0, 0.0008);
  const asOf = spy[spy.length - 1][0];
  const rows = [];
  for (let i = 0; i < 12; i++) {
    rows.push({
      ticker: 'T' + i, sector: i < 9 ? 'Technology' : null, price: 60, dollarVol: 5e6,
      capGroup: 'large', scope: 'large', bars: mkBars(140, i + 1, 0.0004 + 0.0004 * i),
    });
  }
  rows.push({ ticker: 'BAD', sector: 'Technology', price: 0.2, dollarVol: 100, capGroup: 'micro', scope: 'micro', bars: mkBars(140, 50) });
  return runRltScan({
    rows, spyBars: spy, sectorBarsFor: () => mkBars(140, 99, 0.0007),
    asOf, decisionTs: asOf + 'T21:00:00Z', mode,
  });
}

test('deterministic rerun: identical inputs produce identical output', () => {
  const a = fixtureScan();
  const b = fixtureScan();
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('the capture cross-section covers the WHOLE funnel, not just picks', () => {
  const scan = fixtureScan();
  const states = new Set(scan.observations.map(o => o.selectionState));
  assert.ok(states.has('excluded'), 'ineligible names must be captured');
  assert.ok(states.has('in-inventory') || states.has('eligible-not-selected'));
  const bad = scan.observations.find(o => o.ticker === 'BAD');
  assert.equal(bad.selectionState, 'excluded');
  assert.ok(bad.exclusions.length >= 1, 'exclusion reasons recorded');
});

test('shadow scan can never mark anything actionable, and says why', () => {
  const scan = fixtureScan('shadow');
  assert.equal(scan.gate.mayAffectLive, false);
  assert.equal(scan.counts.actionable, 0);
  for (const e of scan.inventory) {
    assert.equal(e.decision.action, 'ABSTAIN');
    assert.ok(e.decision.abstainReasons.length >= 1);
  }
});

test('enforce without an artifact behaves exactly as shadow (fail closed)', () => {
  const scan = fixtureScan('enforce');
  assert.equal(scan.gate.mayAffectLive, false);
  assert.equal(scan.counts.actionable, 0);
});

test('RLT registry entry is shadow — the invariant the governance layer enforces', () => {
  assert.notEqual(assertShadow(), 'production');
});

test('ATLAS-X expert ABSTAINS without the injected cross-section', () => {
  const a = assessRelativeLeadershipTransition({ residual: null, ctx: { ticker: 'XYZ' } });
  assert.equal(a.applicability, 0);
  assert.equal(a.stage, 'no-leadership-data');
  assert.equal(a.uncertainty, 1);
  assert.equal(validateExpertAssessment(a).ok, true);
});

test('ATLAS-X expert fires from the injected snapshot and validates', () => {
  const scan = fixtureScan();
  const snap = compactLeadershipSnapshot(scan);
  assert.ok(snap && snap.byTicker, 'snapshot builds from the scan');
  const leader = scan.inventory[0];
  const a = assessRelativeLeadershipTransition({
    residual: null,
    ctx: { ticker: leader.ticker, asOf: scan.asOf, rltLeadership: snap },
  });
  assert.equal(validateExpertAssessment(a).ok, true);
  assert.ok(a.applicability > 0, 'a real leader should register some applicability');
  assert.ok(a.uncertainty >= 0.35, 'leadership alone stays uncertain — never a confident buy');
});

test('a stale snapshot discounts applicability rather than pretending freshness', () => {
  const scan = fixtureScan();
  const snap = compactLeadershipSnapshot(scan);
  const leader = scan.inventory[0];
  const fresh = assessRelativeLeadershipTransition({ ctx: { ticker: leader.ticker, asOf: scan.asOf, rltLeadership: snap } });
  const stale = assessRelativeLeadershipTransition({ ctx: { ticker: leader.ticker, asOf: '2099-01-01', rltLeadership: snap } });
  assert.ok(stale.applicability < fresh.applicability, 'stale cross-section must be discounted');
});

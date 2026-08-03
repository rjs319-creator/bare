'use strict';
// Guards for the PREREGISTERED longer-horizon momentum study
// (research/PREREGISTRATION-MOMENTUM-HORIZONS-2026-08.md). These tests pin the
// seal: the registry entry exists and widens the family denominator, the
// holdouts are sealed and untouched, the runner's Era-B boundaries match the
// document, and the accrual path can never leak an interim IC.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REG = require('../lib/research/hypothesis-registry');
const RUN = require('../research/58-momentum-horizons-confirmatory');
const CAL = require('../research/lib/calendar');
const COHORT = require('../research/lib/cohort');

test('prereg: hypothesis is registered, valid, confirmatory-mode, and counted in the family denominator', () => {
  const h = REG.find('momentum-longer-horizons');
  assert.ok(h, 'momentum-longer-horizons must be registered');
  assert.equal(h.familyId, 'swing-ranking');
  assert.equal(h.mode, 'confirmatory');
  assert.equal(h.status, 'open');
  assert.match(h.stoppingRule, /PREREGISTERED/);
  assert.match(h.stoppingRule, /NO tuning/i);
  const v = REG.validateHypothesis(h);
  assert.deepEqual(v.errors, []);
  // The two-horizon study widens the BH denominator for every future family test.
  assert.ok(REG.familyTrials('swing-ranking') >= 8);
});

test('prereg: all three holdout eras are sealed and untouched', () => {
  const ids = ['momentum-63s-prospective', 'momentum-126s-prospective', 'momentum-historical-2010-2021'];
  const untouched = REG.untouchedHoldouts().map((h) => h.id);
  for (const id of ids) {
    const h = REG.HOLDOUTS.find((x) => x.id === id);
    assert.ok(h, `${id} missing`);
    assert.ok(h.sealedAt, `${id} has no seal date`);
    assert.equal(h.openedAt, null, `${id} must be untouched at registration`);
    assert.ok(untouched.includes(id));
  }
});

test('prereg: runner boundaries match the document (2026-02-28 @63s, 2025-11-30 @126s)', () => {
  assert.equal(RUN.SEALED_AFTER[63], '2026-02-28');
  assert.equal(RUN.SEALED_AFTER[126], '2025-11-30');
  assert.equal(RUN.MIN_ESS, 30);
  // When the real ledger is materialized, the sealed boundaries must equal its
  // fully observed dates — the seal starts exactly where evaluated data ended.
  const LEDGER = path.join(__dirname, '..', 'research', 'data', 'cohort-eligibility-v3.json');
  if (fs.existsSync(LEDGER)) {
    const ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
    assert.equal(ledger.byHorizon['63'].lastFullyObservedCohortDate, RUN.SEALED_AFTER[63]);
    assert.equal(ledger.byHorizon['126'].lastFullyObservedCohortDate, RUN.SEALED_AFTER[126]);
  }
});

test('prereg: accrual reporting can never leak an interim IC (no-peek invariant)', () => {
  // Synthetic ledger: a few fully observed cohorts AFTER the sealed boundary —
  // far below the sample condition. The accrual record must carry counts only.
  const D0 = Date.UTC(2026, 2, 2);
  const days = Array.from({ length: 400 }, (_, i) => new Date(D0 + i * 86400000).toISOString().slice(0, 10));
  const cal = CAL.buildSessionCalendar(days, { source: 'test' });
  const dts = [cal.sessions[10], cal.sessions[40], cal.sessions[70]];
  const panel = { x: dts.flatMap((dt) => Array.from({ length: 40 }, (_, k) => ({ s: `S${k}`, lid: `L${k}${dt}`, dt, f63: 0.01 * k, s63: 'm', le63: cal.sessions[200], f126: 0.01 * k, s126: 'm', le126: cal.sessions[300], f21: null, s21: 'u', le21: null }))) };
  const ledger = COHORT.computeCohortLedger({ panelByMonth: panel, calendar: cal, horizons: [63, 126], labelObservationCutoff: cal.sessions[399] });
  for (const h of [63, 126]) {
    const acc = RUN.eraBAccrual({ }, ledger, h);
    assert.equal(acc.status, 'ACCRUING');
    assert.ok(acc.eligibleUnseenCohorts >= 1);
    const leaked = Object.keys(acc).filter((k) => /^(ic|ics|meanIC|hacT|tstat|spearman|ess|q|qUpperBound|ci90)$/i.test(k) || /IC$/.test(k) || /^mean/i.test(k));
    assert.deepEqual(leaked, [], `accrual record leaked metric-shaped fields: ${leaked.join(',')}`);
  }
});

test('prereg: Era A is BLOCKED without a proven-safe historical panel', () => {
  const s = RUN.eraAStatus();
  // On any tree without panel-features-hist-2010.json (all current trees) this
  // must be BLOCKED — the current universe can never stand in for 2010.
  assert.equal(s.status, 'BLOCKED');
  assert.match(s.reason, /historical|listing universe|survivorship/i);
});

test('prereg: confirmatory gates enforce ESS ≥ 30 and the FDR bound', () => {
  const mk = (n, mean, noise) => Array.from({ length: n }, (_, i) => ({ date: `d${i}`, ic: mean + Math.sin(i * 2.1) * noise, n: 100 }));
  // Small sample: even a huge IC fails the effective-sample gate.
  const small = RUN.confirmatoryGates(mk(12, 0.05, 0.01), { control: 0, trials: 11 });
  assert.equal(small.checks.sufficientEffectiveN, false);
  // Large clean sample with a real effect passes the sample + sign gates.
  const large = RUN.confirmatoryGates(mk(120, 0.05, 0.02), { control: 0, trials: 11 });
  assert.equal(large.checks.sufficientEffectiveN, true);
  assert.equal(large.checks.positiveHacT, true);
  assert.equal(large.checks.beatsControl, true);
  // Zero-effect sample must not pass FDR.
  const nul = RUN.confirmatoryGates(mk(120, 0.0, 0.02), { control: 0, trials: 11 });
  assert.equal(nul.checks.qPassesFdr, false);
});

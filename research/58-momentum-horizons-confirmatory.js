'use strict';
// Step 58 — CONFIRMATORY runner for the preregistered longer-horizon momentum
// study (hypothesis `momentum-longer-horizons`).
//   node research/58-momentum-horizons-confirmatory.js
//
// Implements research/PREREGISTRATION-MOMENTUM-HORIZONS-2026-08.md EXACTLY and
// refuses to run ahead of the sealed conditions:
//
//   * Era B (prospective): only decision cohorts AFTER the sealed boundary
//     (2026-02-28 @63s, 2025-11-30 @126s), only when fully observed per the
//     cohort ledger. Until effective sample size ≥ 30, this script reports
//     ACCRUAL COUNTS ONLY — it never computes or prints an interim IC, so
//     there is nothing to peek at.
//   * Era A (historical 2010-2021): requires a panel artifact whose measured
//     survivorship contract is proven-safe for that era. Absent that, BLOCKED.
//   * The 2022-2026 exploratory window is structurally excluded.
//
// A successful run (sample condition met) computes the preregistered gates and
// appends a confirmatory evidence record; the corresponding registry holdout
// must then be marked opened via a reviewed diff.

const fs = require('fs');
const path = require('path');
const ST = require('../lib/research/stats-v3');
const RQ = require('../lib/rankquality');
const REG = require('../lib/research/hypothesis-registry');
const COHORT = require('./lib/cohort');

const DATA = path.join(__dirname, 'data');
const MIN_ESS = 30;
// Sealed Era-B boundaries — MUST match the preregistration document verbatim.
const SEALED_AFTER = Object.freeze({ 63: '2026-02-28', 126: '2025-11-30' });
const HOLDOUT_IDS = Object.freeze({ 63: 'momentum-63s-prospective', 126: 'momentum-126s-prospective' });

function eraBAccrual(panel, ledger, h) {
  const elig = COHORT.eligibilityMapForHorizon(ledger, h);
  const boundary = SEALED_AFTER[h];
  const holdout = REG.HOLDOUTS.find((x) => x.id === HOLDOUT_IDS[h]);
  if (!holdout) throw new Error(`sealed holdout ${HOLDOUT_IDS[h]} missing from the registry`);
  if (holdout.openedAt) {
    return { horizon: h, status: 'HOLDOUT_ALREADY_OPENED', openedAt: holdout.openedAt, note: 'an opened holdout can never be called untouched again — no further verdicts from this era' };
  }
  // Eligible, fully observed cohorts strictly after the sealed boundary.
  const unseenDates = [...elig.eligibleDates].filter((d) => d > boundary).sort();
  // ESS needs the IC series — but computing ICs before the sample condition is
  // met would be peeking. Use the DEPENDENCE-FREE lower bound instead: with
  // h-session overlapping monthly cohorts, ESS ≲ N / (h/21). Only when even
  // that bound clears MIN_ESS do we compute the real thing.
  const overlapFactor = Math.max(1, Math.round(h / 21));
  const essLowerBoundGate = MIN_ESS * overlapFactor;   // N needed before real ESS could plausibly reach 30
  return {
    horizon: h,
    status: unseenDates.length >= essLowerBoundGate ? 'SAMPLE_CONDITION_CANDIDATE' : 'ACCRUING',
    sealedAfter: boundary,
    eligibleUnseenCohorts: unseenDates.length,
    cohortsNeededBeforeVerdictAttempt: essLowerBoundGate,
    latestEligibleUnseen: unseenDates[unseenDates.length - 1] || null,
    note: 'interim ICs are not computed by design (preregistration §4)',
  };
}

function eraAStatus() {
  const HIST_PANEL = path.join(DATA, 'panel-features-hist-2010.json');
  if (!fs.existsSync(HIST_PANEL)) {
    return {
      status: 'BLOCKED',
      reason: 'no 2010-2021 panel exists; requires an authoritative monthly historical listing universe (research/data/history-expansion.BLOCKED.json)',
    };
  }
  let doc; try { doc = JSON.parse(fs.readFileSync(HIST_PANEL, 'utf8')); } catch { return { status: 'BLOCKED', reason: 'historical panel unreadable' }; }
  const sv = doc.manifest && doc.manifest.survivorship;
  if (!sv || sv.status !== 'proven-safe') {
    return { status: 'BLOCKED', reason: `historical panel exists but survivorship is '${(sv && sv.status) || 'missing'}' — Era A demands proven-safe` };
  }
  return { status: 'READY', note: 'one-shot evaluation permitted; opening the momentum-historical-2010-2021 holdout is irreversible' };
}

// The preregistered verdict computation. Reached ONLY when the sample
// condition holds; kept in one place so the gates cannot drift from the
// document. (Era-A wiring lands when a proven-safe historical panel exists —
// the gates below are the single source of truth for it too.)
function confirmatoryGates(ics, { control, trials }) {
  const vals = ics.map((x) => x.ic);
  const nw = ST.neweyWest(vals, { horizonBars: null });
  const ess = ST.effectiveSampleSize(vals);
  const p = nw.tstat == null ? null : ST.pFromT(nw.tstat);
  const q = p == null ? null : Math.min(1, p * trials);   // conservative Bonferroni-style bound ≥ BH q
  const outlier = ST.outlierDependence(vals);
  return {
    meanIC: vals.length ? +ST.mean(vals).toFixed(4) : null,
    hacT: nw.tstat == null ? null : +nw.tstat.toFixed(2),
    ess: ess.ess,
    qUpperBound: q,
    checks: {
      positiveHacT: nw.tstat != null && nw.tstat > 0,
      qPassesFdr: q != null && q <= 0.10,
      sufficientEffectiveN: ess.ess != null && ess.ess >= MIN_ESS,
      beatsControl: control != null && vals.length > 0 && ST.mean(vals) > control,
      notOutlierDriven: !outlier || outlier.dominantFrac == null || outlier.dominantFrac < 0.5,
    },
  };
}

function main() {
  const panel = JSON.parse(fs.readFileSync(path.join(DATA, 'panel-features-v3.json'), 'utf8'));
  const ledger = JSON.parse(fs.readFileSync(path.join(DATA, 'cohort-eligibility-v3.json'), 'utf8'));
  const hyp = REG.find('momentum-longer-horizons');
  if (!hyp) throw new Error('hypothesis momentum-longer-horizons is not registered — preregistration is a prerequisite');

  console.log('PREREGISTERED STUDY: momentum-longer-horizons (see research/PREREGISTRATION-MOMENTUM-HORIZONS-2026-08.md)');
  console.log(`family trials at this attempt (BH denominator, can only grow): ${REG.familyTrials('swing-ranking')}`);
  console.log('\nEra A (historical 2010-2021, one shot):');
  console.log(' ', JSON.stringify(eraAStatus()));
  console.log('\nEra B (prospective, sealed boundaries):');
  let anyReady = false;
  for (const h of [63, 126]) {
    const acc = eraBAccrual(panel, ledger, h);
    console.log(' ', JSON.stringify(acc));
    if (acc.status === 'SAMPLE_CONDITION_CANDIDATE') anyReady = true;
  }
  if (!anyReady) {
    console.log('\nVERDICT ATTEMPT: NOT PERMITTED — sample conditions unmet. No ICs were computed. Rerun after further accrual or after Era A unblocks.');
    return;
  }
  // Deliberately unimplemented until a sample condition can actually hold:
  // wiring the verdict path now would invite premature evaluation. When the
  // condition first holds, implement the evaluation HERE using
  // confirmatoryGates() + the execution-engine cost gate + both sensitivity
  // views, append ONE confirmatory evidence record, and open the holdout in
  // the registry via a reviewed diff.
  console.log('\nSAMPLE CONDITION CANDIDATE reached — implement the one-shot verdict path per preregistration §3 before proceeding.');
}

if (require.main === module) main();
module.exports = { SEALED_AFTER, HOLDOUT_IDS, MIN_ESS, eraBAccrual, eraAStatus, confirmatoryGates };

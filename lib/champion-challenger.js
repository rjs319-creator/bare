'use strict';
// CHAMPION / CHALLENGER + DRIFT MONITORS (non-daytrade redesign 2026-08, Phase 13).
//
// THE RULE THIS ENCODES. A live model may get WORSE automatically (safety) but can never
// get promoted automatically (that is how reward-chasing and same-period retraining become
// live positions). Demotion is a machine decision; promotion is a human one, and only after
// a complete, semantically valid artifact (lib/promotion-artifact.js).
//
// THE LOOP.
//   1. The production CHAMPION is frozen: its scoring version, weights and cutoffs do not
//      move while it is champion.
//   2. CHALLENGERS run in shadow on the IDENTICAL opportunity set — same dates, same
//      candidates, same eligibility — so the comparison is paired, not two different books.
//   3. Outcomes accrue PROSPECTIVELY. Retrospective re-scoring of past decisions is not
//      evidence for promotion (it is a different experiment) and is labeled as such.
//   4. DRIFT MONITORS compare champion vs its own reference window on seven axes:
//      calibration, rank IC, cost-net utility, universe coverage, turnover, missingness and
//      regime stability. Breaches trigger AUTOMATIC DEMOTION.
//   5. Failed challengers are RETAINED as negative controls — a rejected model stays in the
//      registry with its rejection reason so the same idea is not rediscovered.
//   6. Every weighting change is a VERSIONED, REVERSIBLE proposal record. Nothing here
//      mutates a live weight.
//
// Pure: records in → decisions out. No network, no state, injectable clock.

const PA = require('./promotion-artifact');

const LOOP_VERSION = 'champion-challenger-v1';

// Drift thresholds. Deliberately blunt and DISCLOSED — they are safety rails, not a fitted
// model. Each is a RELATIVE degradation against the champion's own reference window.
const DRIFT_LIMITS = Object.freeze({
  calibrationErrorIncrease: 0.05,   // absolute increase in calibration error
  rankICDrop: 0.02,                 // absolute drop in mean rank IC
  costNetUtilityDrop: 0.5,          // percentage points of cost-net utility
  coverageDropPct: 0.30,            // 30% fewer names scored than the reference window
  turnoverIncrease: 0.50,           // 50 percentage points more turnover
  missingnessIncrease: 0.20,        // 20 percentage points more missing inputs
  minPositiveRegimes: 2,            // must remain positive in ≥2 distinct regimes
});

const DECISION = Object.freeze({
  HOLD: 'HOLD',
  AUTO_DEMOTE: 'AUTO_DEMOTE',
  REQUIRES_HUMAN_APPROVAL: 'REQUIRES_HUMAN_APPROVAL',
  REJECT_CHALLENGER: 'REJECT_CHALLENGER',
});

const num = (v) => (Number.isFinite(v) ? v : null);

// ── Drift monitoring ────────────────────────────────────────────────────────
// `current` and `reference` are the same shape:
//   { calibrationError, rankIC, costNetUtilityPct, namesScored, turnover,
//     missingnessRate, regimePositive: { [regime]: boolean } }
// A missing metric is a BREACH, not a pass: an unmeasurable model cannot be attested.
function evaluateDrift(current, reference, { limits = DRIFT_LIMITS } = {}) {
  const breaches = [];
  const checks = [];
  const check = (id, ok, detail) => { checks.push({ id, ok: ok === true, detail }); if (ok !== true) breaches.push({ id, detail }); };

  if (!current || !reference) {
    return { version: LOOP_VERSION, measurable: false, breaches: [{ id: 'NOT_MEASURABLE', detail: 'no current and/or reference window — drift is unprovable, which fails closed' }], checks, drifted: true };
  }

  const c = current, r = reference;
  check('calibration',
    num(c.calibrationError) != null && num(r.calibrationError) != null && (c.calibrationError - r.calibrationError) <= limits.calibrationErrorIncrease,
    `calibration error ${c.calibrationError} vs reference ${r.calibrationError} (limit +${limits.calibrationErrorIncrease})`);
  check('rankIC',
    num(c.rankIC) != null && num(r.rankIC) != null && (r.rankIC - c.rankIC) <= limits.rankICDrop,
    `rank IC ${c.rankIC} vs reference ${r.rankIC} (limit -${limits.rankICDrop})`);
  check('costNetUtility',
    num(c.costNetUtilityPct) != null && num(r.costNetUtilityPct) != null && (r.costNetUtilityPct - c.costNetUtilityPct) <= limits.costNetUtilityDrop,
    `cost-net utility ${c.costNetUtilityPct}% vs reference ${r.costNetUtilityPct}% (limit -${limits.costNetUtilityDrop}pp)`);
  check('coverage',
    num(c.namesScored) != null && num(r.namesScored) > 0 && (1 - c.namesScored / r.namesScored) <= limits.coverageDropPct,
    `scored ${c.namesScored} vs reference ${r.namesScored} (limit -${Math.round(limits.coverageDropPct * 100)}%)`);
  check('turnover',
    num(c.turnover) != null && num(r.turnover) != null && (c.turnover - r.turnover) <= limits.turnoverIncrease,
    `turnover ${c.turnover} vs reference ${r.turnover} (limit +${limits.turnoverIncrease})`);
  check('missingness',
    num(c.missingnessRate) != null && num(r.missingnessRate) != null && (c.missingnessRate - r.missingnessRate) <= limits.missingnessIncrease,
    `missingness ${c.missingnessRate} vs reference ${r.missingnessRate} (limit +${limits.missingnessIncrease})`);
  const positiveRegimes = Object.values((c.regimePositive) || {}).filter(Boolean).length;
  check('regimeStability', positiveRegimes >= limits.minPositiveRegimes,
    `positive in ${positiveRegimes} regime(s) (need ≥${limits.minPositiveRegimes})`);

  return { version: LOOP_VERSION, measurable: true, checks, breaches, drifted: breaches.length > 0 };
}

// ── The decision ────────────────────────────────────────────────────────────
// champion   { id, version, status, referenceWindow, currentWindow }
// challengers[] { id, version, paired: { dates, championUtility, challengerUtility, ci95 },
//                 prospective: boolean, artifact }
// Returns the ONLY four outcomes this loop may produce.
function decide({ champion, challengers = [], nowMs = Date.now(), identity = null } = {}) {
  const out = { version: LOOP_VERSION, generatedAt: new Date(nowMs).toISOString(), champion: null, challengers: [] };

  // 1. Champion safety first: drift can DEMOTE without a human.
  const drift = evaluateDrift(champion && champion.currentWindow, champion && champion.referenceWindow);
  out.champion = {
    id: champion && champion.id, version: champion && champion.version,
    drift,
    decision: drift.drifted ? DECISION.AUTO_DEMOTE : DECISION.HOLD,
    reason: drift.drifted
      ? `Automatic demotion (safety): ${drift.breaches.map(b => b.id).join(', ')}. Demotion never requires approval; restoration does.`
      : 'Within drift limits on every monitored axis — held, frozen, unchanged.',
    frozen: true,
    note: 'The champion is FROZEN while it is champion: no weights, cutoffs or scoring version move under it.',
  };

  // 2. Challengers: a beaten champion does NOT auto-promote the winner.
  for (const ch of challengers) {
    const paired = ch.paired || {};
    const beatsChampion = Number.isFinite(paired.challengerUtility) && Number.isFinite(paired.championUtility)
      && paired.challengerUtility > paired.championUtility
      && paired.ci95 && Number.isFinite(paired.ci95.lo) && paired.ci95.lo > 0;
    const artifactProblems = PA.validateArtifact(ch.artifact, identity || { version: ch.version }, { nowMs });
    const prospective = ch.prospective === true;

    let decision, reason;
    if (!beatsChampion) {
      decision = DECISION.REJECT_CHALLENGER;
      reason = 'Does not beat the champion on the identical paired opportunity set with an interval clear of zero. RETAINED as a negative control — it must not be re-tried as if new.';
    } else if (!prospective) {
      decision = DECISION.REJECT_CHALLENGER;
      reason = 'Beats the champion only RETROSPECTIVELY. Same-period re-scoring is a different experiment, not prospective evidence — it cannot promote.';
    } else if (artifactProblems.length) {
      decision = DECISION.REQUIRES_HUMAN_APPROVAL;
      reason = `Beats the champion prospectively, but promotion is blocked pending a complete approval record: ${artifactProblems.slice(0, 3).map(p => `[${p.code}] ${p.detail}`).join('; ')}${artifactProblems.length > 3 ? ` (+${artifactProblems.length - 3} more)` : ''}.`;
    } else {
      decision = DECISION.REQUIRES_HUMAN_APPROVAL;
      reason = 'Beats the champion prospectively AND has a complete, valid artifact — promotion is now a HUMAN decision. This loop will never take it automatically.';
    }
    out.challengers.push({
      id: ch.id, version: ch.version, decision, reason,
      beatsChampion, prospective, artifactProblems: artifactProblems.map(p => `[${p.code}] ${p.detail}`),
      retainedAsNegativeControl: decision === DECISION.REJECT_CHALLENGER,
    });
  }

  out.autoPromotionPossible = false;
  out.policy = 'Automatic DEMOTION is allowed (safety). Automatic PROMOTION is structurally impossible here: the only promotion outcome this function can emit is REQUIRES_HUMAN_APPROVAL.';
  return out;
}

// ── Versioned, reversible weighting changes ─────────────────────────────────
// A weight change is a PROPOSAL record, never an applied mutation. It carries the previous
// values so it can be reverted exactly, and it is inert until a human applies it.
function proposeWeightChange({ strategyId, from = {}, to = {}, reason = null, proposedBy = null, nowMs = Date.now() } = {}) {
  const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort();
  const changes = keys
    .filter(k => from[k] !== to[k])
    .map(k => ({ key: k, from: from[k] ?? null, to: to[k] ?? null }));
  return {
    version: LOOP_VERSION,
    proposalId: `${strategyId}@${new Date(nowMs).toISOString()}`,
    strategyId, changes,
    revert: { to: { ...from } },
    applied: false,
    appliedBy: null,
    proposedBy: proposedBy || null,
    reason,
    note: 'Inert proposal. Weights are not mutated by this loop; applying it is an explicit, reviewable, reversible human action.',
  };
}

module.exports = { LOOP_VERSION, DRIFT_LIMITS, DECISION, evaluateDrift, decide, proposeWeightChange };

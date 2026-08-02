'use strict';
// FORWARD-OUTCOME-V3 (fwd-outcome-v3) — the corrected label contract.
//
// THE v2 DEFECT THIS FIXES (verified, research/lib/pit.js forwardOutcome): a
// cached price series whose last bar was ≥30 days before a fixed cutoff was
// labeled 'delisted' — and haircut — WITHOUT consulting any authoritative
// delisting record. A stale free-feed tail, a vendor outage, an acquisition and
// a bankruptcy all looked identical. v3 requires a versioned security-master
// record to confirm a delisting; a stale tail by itself is NEVER proof.
//
// States:
//   mature             — full forward window observed. Label-ready.
//   confirmed_delisted — authoritative delisting inside the horizon. Label-ready
//                        under the configured treatment (haircut only for
//                        bankruptcy-like reasons; a rename/acquisition/merger is
//                        never automatically haircut).
//   pending            — security confirmed/prospectively observed active and
//                        the horizon has not elapsed. NULL training label.
//   unresolved         — stale tail, unknown identity, conflicting status,
//                        missing bars, unconfirmed disappearance, ambiguity.
//                        NULL training label. Fail closed.
//   no_fill            — executable-outcome callers: entry never filled.
//                        NULL training label.
//
// Only mature and confirmed_delisted may train, calibrate or grade
// (labelReady === true). Interval semantics are half-open [effectiveFrom,
// effectiveTo) throughout.
//
// Pure module: no network, no clock, no store. Callers inject the series, the
// security-master record and the cutoff.

const OUTCOME_POLICY_VERSION = 'fwd-outcome-v3';
const INTERVAL_SEMANTICS = 'half-open [effectiveFrom, effectiveTo)';

const DAY = 86400000;
const PENDING_GRACE_DAYS = 10;
const ENTRY_STALE_DAYS = 10;
const DELISTING_HAIRCUT = 0.30;        // Shumway (1997) — bankruptcy-like reasons only

// Delisting reason categories and their configured treatment.
//   haircut  — terminal-penalty treatment applies
//   carry    — terminal observation carries (acquisition proceeds, rename continuity)
const REASON_TREATMENT = Object.freeze({
  bankruptcy: 'haircut', liquidation: 'haircut', delinquency: 'haircut', regulatory: 'haircut',
  acquisition: 'carry', merger: 'carry', rename: 'carry', 'exchange-move': 'carry', 'going-private': 'carry',
});

const STATUS = Object.freeze(['mature', 'confirmed_delisted', 'pending', 'unresolved', 'no_fill']);

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const idxAsOf = (series, dateMs) => { let idx = -1; for (let k = 0; k < series.length; k++) { if (series[k].ms <= dateMs) idx = k; else break; } return idx; };

// Is `security` an authoritative, complete delisting confirmation?
// Required: stable listing ID, confirmed delisting date, authoritative source,
// confirmation timestamp (or source publication timestamp), provenance.
function delistingConfirmation(security) {
  const d = security && security.delisting;
  if (!d) return null;
  const ok = !!(security.listingId && d.date && d.source
    && (d.confirmedAt || d.sourcePublishedAt) && d.provenance);
  if (!ok) return null;
  return {
    listingId: security.listingId,
    date: d.date, source: d.source,
    confirmedAt: d.confirmedAt || null, sourcePublishedAt: d.sourcePublishedAt || null,
    reason: d.reason || null, reasonCategory: d.reasonCategory || null,
    provenance: d.provenance,
  };
}

// Validate the price-adjustment basis instead of assuming the vendor's `close`
// is correctly adjusted. Bars may carry {close, adjClose, adjFactor, split, dividend}.
function adjustmentBasisOf(series) {
  const withAdj = series.filter((b) => Number.isFinite(b.adjClose));
  if (!withAdj.length) return { basis: 'unverified-vendor-close', adjustedBarFrac: 0 };
  const consistent = withAdj.every((b) => !Number.isFinite(b.adjFactor) || Math.abs(b.adjClose - b.close * b.adjFactor) <= Math.abs(b.close) * 0.001);
  return {
    basis: consistent ? 'raw+adjusted-preserved' : 'adjustment-inconsistent',
    adjustedBarFrac: +(withAdj.length / series.length).toFixed(4),
  };
}

// forwardOutcomeV3({ series, dateMs, bars, security, opts })
//   series   — [{ ms, close, adjClose?, adjFactor? }] ascending
//   security — versioned master record:
//              { listingId, masterVersion, status: 'active'|'delisted'|'unknown',
//                observedActiveThrough?: ms|null, delisting?: {...} | null,
//                identityConfidence? }
//   opts     — { dataCutoffMs (required), delistingHaircut?, priceDataVersion?,
//                entryFilled? (false → no_fill) }
function forwardOutcomeV3({ series, dateMs, bars, security = null, opts = {} }) {
  const dataCutoffMs = opts.dataCutoffMs;
  const haircut = opts.delistingHaircut ?? DELISTING_HAIRCUT;
  const base = {
    outcomePolicyVersion: OUTCOME_POLICY_VERSION,
    intervalSemantics: INTERVAL_SEMANTICS,
    status: 'unresolved', reason: null,
    horizonBars: bars, observedBars: 0,
    entryDate: null, expectedExitDate: null, actualExitDate: null,
    rawReturn: null, adjustedReturn: null, labelReady: false, trainingLabel: null,
    delistingAdjustment: null, delistingTreatment: null,
    terminalObservation: null,
    listingId: (security && security.listingId) || null,
    securityMasterVersion: (security && security.masterVersion) || opts.securityMasterVersion || null,
    priceDataVersion: opts.priceDataVersion || null,
    dataCutoff: Number.isFinite(dataCutoffMs) ? isoDate(dataCutoffMs) : null,
    confirmation: null,
    adjustmentBasis: null,
  };
  if (opts.entryFilled === false) return { ...base, status: 'no_fill', reason: 'entry-never-filled' };
  if (!Array.isArray(series) || !series.length || !Number.isFinite(dateMs) || !(bars > 0) || !Number.isFinite(dataCutoffMs)) {
    return { ...base, reason: 'invalid-input' };
  }
  base.adjustmentBasis = adjustmentBasisOf(series);

  const idx = idxAsOf(series, dateMs);
  if (idx < 0) return { ...base, reason: 'no-bar-at-or-before-date' };
  const entryBar = series[idx];
  if (!(entryBar.close > 0)) return { ...base, reason: 'non-positive-entry-price' };
  const entry = { ...base, entryDate: isoDate(entryBar.ms) };
  if (dateMs - entryBar.ms > ENTRY_STALE_DAYS * DAY) return { ...entry, reason: 'stale-entry-bar' };

  const conf = delistingConfirmation(security);

  // CONFLICTING STATUS fails closed: bars trading AFTER a confirmed delisting
  // date contradict the master — neither source is trusted.
  if (conf) {
    const delistMs = Date.parse(conf.date);
    const lastMs = series[series.length - 1].ms;
    if (Number.isFinite(delistMs) && lastMs >= delistMs + DAY) {
      return { ...entry, reason: 'conflicting-status: bars after confirmed delisting date', confirmation: conf };
    }
  }

  const tgt = idx + bars;
  if (tgt < series.length) {
    const exitBar = series[tgt];
    if (!(exitBar.close > 0)) return { ...entry, reason: 'non-positive-exit-price' };
    const rawReturn = exitBar.close / entryBar.close - 1;
    return {
      ...entry, status: 'mature', observedBars: bars,
      expectedExitDate: isoDate(exitBar.ms), actualExitDate: isoDate(exitBar.ms),
      rawReturn, adjustedReturn: rawReturn, delistingAdjustment: 0,
      labelReady: true, trainingLabel: rawReturn,
      terminalObservation: { date: isoDate(exitBar.ms), close: exitBar.close },
      reason: 'horizon-observed',
    };
  }

  // Window runs past the series. WHY decides the state — never the staleness alone.
  const lastBar = series[series.length - 1];
  const observedBars = (series.length - 1) - idx;
  if (observedBars <= 0) return { ...entry, reason: 'no-forward-bars' };
  if (!(lastBar.close > 0)) return { ...entry, observedBars, reason: 'non-positive-exit-price' };
  const rawReturn = lastBar.close / entryBar.close - 1;
  const partial = {
    ...entry, observedBars, actualExitDate: isoDate(lastBar.ms), rawReturn,
    terminalObservation: { date: isoDate(lastBar.ms), close: lastBar.close },
  };

  // 1) Authoritative confirmed delisting inside the horizon → confirmed_delisted.
  if (conf) {
    const delistMs = Date.parse(conf.date);
    const inHorizon = Number.isFinite(delistMs) && delistMs > entryBar.ms;
    if (inHorizon) {
      const treatment = REASON_TREATMENT[conf.reasonCategory]
        || (conf.reasonCategory ? 'haircut' : (opts.haircutUnknownReason === false ? 'carry' : 'haircut'));
      const adjustment = treatment === 'haircut' ? -haircut : 0;
      return {
        ...partial, status: 'confirmed_delisted',
        confirmation: conf,
        delistingTreatment: conf.reasonCategory
          ? `${treatment}:${conf.reasonCategory}`
          : `${treatment}:unknown-reason-default`,
        delistingAdjustment: adjustment,
        adjustedReturn: (1 + rawReturn) * (1 + adjustment) - 1,
        labelReady: true,
        trainingLabel: (1 + rawReturn) * (1 + adjustment) - 1,
        reason: 'authoritative-delisting-in-horizon',
      };
    }
    // Confirmed delisting but BEFORE/AT entry — the entry itself is suspect.
    return { ...partial, reason: 'delisted-at-or-before-entry', confirmation: conf };
  }

  // 2) No confirmation. Active (confirmed or prospectively observed) + horizon
  //    not elapsed → pending. Everything else → unresolved. A stale tail with
  //    no authoritative record is UNRESOLVED — never 'delisted'.
  const tailAgeDays = (dataCutoffMs - lastBar.ms) / DAY;
  const observedActive = security
    && (security.status === 'active'
      || (Number.isFinite(security.observedActiveThrough) && security.observedActiveThrough >= dataCutoffMs - PENDING_GRACE_DAYS * DAY));
  if (observedActive && tailAgeDays <= PENDING_GRACE_DAYS) {
    return { ...partial, status: 'pending', reason: 'horizon-not-elapsed' };
  }
  if (!security || security.status === 'unknown' || !security.listingId) {
    return { ...partial, reason: 'unknown-identity-fails-closed' };
  }
  if (observedActive) {
    return { ...partial, reason: 'stale-tail-active-security-data-gap' };
  }
  return { ...partial, reason: 'stale-tail-unconfirmed-disappearance' };
}

module.exports = {
  OUTCOME_POLICY_VERSION, INTERVAL_SEMANTICS, STATUS, REASON_TREATMENT,
  PENDING_GRACE_DAYS, ENTRY_STALE_DAYS, DELISTING_HAIRCUT, DAY,
  forwardOutcomeV3, delistingConfirmation, adjustmentBasisOf,
};

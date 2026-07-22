'use strict';
// OPTIONS DAILY SNAPSHOT + NEXT-SESSION OI CONFIRMATION.
//
// The daily flow document (optionsflow/<date>.json) already persists the per-contract
// signals[] for the day. Keyed by the OCC contractSymbol, that IS a contract snapshot.
// This module diffs a contract's open interest against the PRIOR session's snapshot to
// estimate whether the unusual VOLUME actually became new POSITIONING.
//
// SCIENTIFIC HONESTY: rising OI after a volume spike is *confirmation evidence* that the
// activity opened and was held — it is NOT proof of trade direction (bought vs sold),
// and a contract can build OI on either side. Falling/flat OI suggests the volume was
// day-trading or closing, not new conviction. We report a state, never a probability.
//
// Pure functions only — dates are compared as given; no network, no Date.now().

// Noise floors so tiny-OI contracts don't flip state on a handful of contracts.
const MIN_ABS_OI_CHANGE = 50;    // absolute contracts
const MIN_PCT_OI_CHANGE = 0.05;  // 5% of prior OI

const OI_STATE = Object.freeze({
  BUILDING: 'OI_BUILDING',       // OI grew materially → positioning confirmed/added
  REDUCING: 'OI_REDUCING',       // OI fell materially → likely closing, not conviction
  FLAT: 'OI_FLAT',               // within noise → volume did not become new OI
  NO_PRIOR: 'OI_NO_PRIOR',       // no prior snapshot for this contract → cannot confirm
});
const OI_STATE_LABEL = Object.freeze({
  OI_BUILDING: 'Open interest building (positioning confirmed)',
  OI_REDUCING: 'Open interest falling (likely closing)',
  OI_FLAT: 'Open interest flat (no new positioning)',
  OI_NO_PRIOR: 'No prior day to confirm against',
});

// Minimal per-contract snapshot records from a set of scanned signals. Only contracts
// with a stable key are snapshotted (others cannot be confirmed cross-day).
function snapshotContracts(signals = [], { date = null } = {}) {
  const out = [];
  for (const s of signals) {
    if (!s || !s.contractSymbol) continue;
    out.push({
      contractSymbol: s.contractSymbol,
      ticker: s.ticker ?? null,
      side: s.side ?? null,
      strike: s.strike ?? null,
      expiry: s.expiry ?? null,
      openInterest: Number.isFinite(s.openInterest) ? s.openInterest : 0,
      volume: Number.isFinite(s.volume) ? s.volume : 0,
      date,
    });
  }
  return out;
}

// Index snapshot records by contractSymbol (last write wins). Accepts either raw
// snapshot records or full signals (anything with contractSymbol + openInterest).
function indexBySymbol(records = []) {
  const idx = Object.create(null);
  for (const r of records) {
    if (r && r.contractSymbol) idx[r.contractSymbol] = r;
  }
  return idx;
}

// The honest OI-confirmation state for one contract given its prior-session OI.
// priorOi == null (contract unseen yesterday) → NO_PRIOR. Otherwise classify the
// change against the noise floors.
function oiConfirm({ priorOi = null, oi = null } = {}) {
  const cur = Number.isFinite(oi) ? oi : null;
  if (!Number.isFinite(priorOi) || cur == null) {
    return { state: OI_STATE.NO_PRIOR, label: OI_STATE_LABEL[OI_STATE.NO_PRIOR], oiChange: null, oiChangePct: null, confirmsPositioning: false };
  }
  const change = cur - priorOi;
  const pct = priorOi > 0 ? change / priorOi : (change > 0 ? Infinity : 0);
  const material = Math.abs(change) >= MIN_ABS_OI_CHANGE && (priorOi === 0 || Math.abs(pct) >= MIN_PCT_OI_CHANGE);
  let state;
  if (!material) state = OI_STATE.FLAT;
  else if (change > 0) state = OI_STATE.BUILDING;
  else state = OI_STATE.REDUCING;
  return {
    state,
    label: OI_STATE_LABEL[state],
    oiChange: change,
    oiChangePct: Number.isFinite(pct) ? +(pct * 100).toFixed(1) : null,
    confirmsPositioning: state === OI_STATE.BUILDING,
  };
}

// Return a NEW array of signals, each with an added `oiConfirm` field computed against
// the prior-session snapshot index (keyed by contractSymbol). Immutable: inputs are not
// mutated. Signals without a contractSymbol get a NO_PRIOR confirmation (honest default).
function stampOiConfirmation(signals = [], priorIndex = {}) {
  return signals.map(s => {
    const prior = s && s.contractSymbol ? priorIndex[s.contractSymbol] : null;
    const priorOi = prior && Number.isFinite(prior.openInterest) ? prior.openInterest : null;
    return { ...s, oiConfirm: oiConfirm({ priorOi, oi: s ? s.openInterest : null }) };
  });
}

module.exports = {
  MIN_ABS_OI_CHANGE, MIN_PCT_OI_CHANGE, OI_STATE, OI_STATE_LABEL,
  snapshotContracts, indexBySymbol, oiConfirm, stampOiConfirmation,
};

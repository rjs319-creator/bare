'use strict';
// FROZEN candidate features for OMEGA_SI_LEVEL_5D_TOP10. The primary candidate is
// short-interest LEVEL only: a clamped log days-to-cover and an extreme-crowding flag,
// plus four predeclared interactions with cross-sectional OMEGA-score and r10 z-scores.
//
// Deliberately absent (kept as diagnostics only, never model inputs): changePercent /
// short-interest change, FTD, COT, GEX, alternative crowding thresholds, and any
// short-interest-percent-of-float reconstructed from CURRENT shares outstanding (that
// reconstruction is look-ahead). No "moderate crowding" boost exists — the continuous
// level and the single >=7 DTC flag are the whole candidate, frozen before results.

const DTC_CLAMP_MAX = 100;
const CROWDED_DTC = 7;

function siLogDtc(dtc) {
  if (!Number.isFinite(dtc)) return null;
  return Math.log1p(Math.min(Math.max(dtc, 0), DTC_CLAMP_MAX));
}

function siCrowded7(dtc) {
  return Number.isFinite(dtc) ? (dtc >= CROWDED_DTC ? 1 : 0) : null;
}

// Cross-sectional z-scores computed WITHIN one decision date's panel — no other date's
// information enters, so standardization can never leak the future.
function crossSectionalZ(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return values.map(() => null);
  const m = finite.reduce((a, v) => a + v, 0) / finite.length;
  const sd = Math.sqrt(finite.reduce((a, v) => a + (v - m) ** 2, 0) / finite.length);
  return values.map((v) => (Number.isFinite(v) ? (sd > 0 ? (v - m) / sd : 0) : null));
}

// Attach the frozen SI features + interactions to one decision date's rows, in place of
// nothing — returns NEW row objects. rows[i].si is the PIT-joined record (or null).
function attachSiFeatures(rows) {
  const scoreZ = crossSectionalZ(rows.map((r) => r.score));
  const r10Z = crossSectionalZ(rows.map((r) => r.r10));
  return rows.map((r, i) => {
    const dtc = r.si ? r.si.dtc : null;
    const logDtc = siLogDtc(dtc);
    const crowded = siCrowded7(dtc);
    const mul = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? a * b : null);
    return {
      ...r,
      omegaScoreZ: scoreZ[i],
      r10Z: r10Z[i],
      siLogDtc: logDtc,
      siCrowded7: crowded,
      siXscoreZ: mul(logDtc, scoreZ[i]),
      siXr10Z: mul(logDtc, r10Z[i]),
      siC7XscoreZ: mul(crowded, scoreZ[i]),
      siC7Xr10Z: mul(crowded, r10Z[i]),
    };
  });
}

// Frozen PIT regime rule from SPY alone (the live macro overlay has no point-in-time
// series). Shared by the retrospective runner and the prospective tick so both stamp
// regime identically.
function spyRegime(spySlice) {
  const n = spySlice.length;
  if (n < 200) return { riskOn: false, bearish: false, label: 'neutral' };
  const ma = (len) => { let s = 0; for (let i = n - len; i < n; i++) s += spySlice[i].close; return s / len; };
  const c = spySlice[n - 1].close, ma50 = ma(50), ma200 = ma(200);
  if (c < ma200) return { riskOn: false, bearish: true, label: 'risk-off' };
  if (c > ma50 && ma50 > ma200) return { riskOn: true, bearish: false, label: 'risk-on' };
  return { riskOn: false, bearish: false, label: 'neutral' };
}

const BASELINE_FEATURES = Object.freeze([
  'score', 'utility', 'pPositive', 'p3pct', 'p5pct', 'expResid10', 'r10', 'distFrom52High', 'relVol5',
  'regRiskOn', 'regBearish',                       // regime controls
]);
const SI_FEATURES = Object.freeze(['siLogDtc', 'siCrowded7', 'siXscoreZ', 'siXr10Z', 'siC7XscoreZ', 'siC7Xr10Z']);

module.exports = {
  DTC_CLAMP_MAX, CROWDED_DTC,
  siLogDtc, siCrowded7, crossSectionalZ, attachSiFeatures, spyRegime,
  BASELINE_FEATURES, SI_FEATURES,
};

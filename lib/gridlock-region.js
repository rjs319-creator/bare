'use strict';
// ⚡ GRIDLOCK — regional constraint model + constraint-pressure score (pure).
//
// Builds a versioned PowerRegionState from whatever adapter inputs are
// available and scores 0–100 constraint pressure with a fully decomposed,
// availability-renormalized weighting. This is a TRANSPARENT APPROXIMATION,
// not a production-cost model: every value carries a provenance label
// (observed / derived / assumed / estimated-proxy) and every missing input is
// reported as missing — never hidden inside the score.
//
// Normalization is per-region and per-season by design: mappings below are
// calibrated to the region's own structure (PJM first), and raw PJM numbers
// are never compared to ERCOT/CAISO as if the markets were identical. Adding a
// region = adding a REGION_NORMS entry, not editing the scorer.

const { BASIS, labeled } = require('./gridlock-schema');

const REGION_STATE_VERSION = 'gridlock-regionstate-v1';
const CPS_VERSION = 'gridlock-cps-v1';

// Research weights — HYPOTHESES, not validated alpha (stored with every score).
const CPS_WEIGHTS = Object.freeze({
  reserveMargin: 0.20,       // reserve-margin stress
  loadSurprise: 0.15,        // load surprise + announced load growth
  outage: 0.15,              // generator outage stress
  congestion: 0.15,          // transmission / congestion stress
  fuel: 0.10,                // fuel + marginal-generation sensitivity
  interconnection: 0.10,     // queue + construction friction
  weather: 0.10,             // weather-driven demand risk
  marketStructure: 0.05,     // capacity market / resource adequacy
});

// Per-region, per-season normalization anchors. Values are DISCLOSED modeling
// assumptions (basis: assumed) chosen from public reliability-report ranges,
// not fitted parameters. summer/winter = constrained seasons for PJM.
const REGION_NORMS = Object.freeze({
  PJM: {
    seasons: {
      summer: { months: [6, 7, 8, 9], marginComfortPct: 30, marginStressPct: 8, typicalPeakMW: 150000 },
      winter: { months: [12, 1, 2], marginComfortPct: 32, marginStressPct: 10, typicalPeakMW: 140000 },
      shoulder: { months: [3, 4, 5, 10, 11], marginComfortPct: 45, marginStressPct: 15, typicalPeakMW: 110000 },
    },
    outageComfortRatio: 0.06, outageStressRatio: 0.18,
    daRtSpreadStressAbs: 25,          // $/MWh |DA−RT| considered fully stressed
    zonalDispersionStress: 30,        // $/MWh max−min zonal DA dispersion
    gasComfort: 2.0, gasStress: 8.0,  // $/MMBtu proxy anchors
    capacityCapProxy: 330,            // $/MW-day near the 2026/27 BRA price cap
  },
});

function seasonFor(isoRegion, asOfIso) {
  const norms = REGION_NORMS[isoRegion];
  if (!norms) return null;
  const m = Number(String(asOfIso || '').slice(5, 7));
  for (const [name, s] of Object.entries(norms.seasons)) if (s.months.includes(m)) return { name, ...s };
  return { name: 'shoulder', ...norms.seasons.shoulder };
}

const clamp01 = x => Math.max(0, Math.min(1, x));
// Linear stress mapping: value at `comfort` → 0, at `stress` → 100 (either direction).
function stress(value, comfort, stressAt) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(clamp01((value - comfort) / (stressAt - comfort)) * 100);
}

// ── PowerRegionState assembly ────────────────────────────────────────────────
// `inputs` are adapter outputs; each may be null (adapter down / key missing).
//   pjm: { currentLoadMW, forecastLoadMW, dayAheadPrice, realTimePrice, zonalPrices{}, outageCapacityMW, installedCapacityMW, netInterchangeMW, generationByFuel{} }
//   eia: { demandMW, netGenerationMW, interchangeMW, generationByFuel{} }
//   nws: { activeAlerts: [{event, severity, areaDesc}] }
//   gas: { hubPriceUSD }  — proxy (e.g. from existing market data), may be null
//   pipeline: { announcedLargeLoadMW, generationPipelineMW, retirementPipelineMW }  — derived from the event ledger
function buildRegionState({ isoRegion, asOf, inputs = {}, sourceManifest = [] }) {
  const p = inputs.pjm || null, e = inputs.eia || null, w = inputs.nws || null;
  const gas = inputs.gas || null, pipe = inputs.pipeline || null;

  const currentLoadMW = p && p.currentLoadMW != null ? labeled(p.currentLoadMW, BASIS.OBSERVED)
    : e && e.demandMW != null ? labeled(e.demandMW, BASIS.OBSERVED, 'EIA hourly demand')
    : labeled(null, BASIS.OBSERVED);
  const forecastLoadMW = p && p.forecastLoadMW != null ? labeled(p.forecastLoadMW, BASIS.OBSERVED) : labeled(null, BASIS.OBSERVED);
  const forecastError = (currentLoadMW.value != null && forecastLoadMW.value != null && forecastLoadMW.value > 0)
    ? labeled(+(((currentLoadMW.value - forecastLoadMW.value) / forecastLoadMW.value) * 100).toFixed(2), BASIS.DERIVED, 'pct of forecast')
    : labeled(null, BASIS.DERIVED);

  const availableCapacityMW = p && p.installedCapacityMW != null && p.outageCapacityMW != null
    ? labeled(p.installedCapacityMW - p.outageCapacityMW, BASIS.DERIVED, 'installed − outages')
    : labeled(null, BASIS.DERIVED);
  const reserveMarginProxy = (availableCapacityMW.value != null && currentLoadMW.value != null && currentLoadMW.value > 0)
    ? labeled(+(((availableCapacityMW.value - currentLoadMW.value) / currentLoadMW.value) * 100).toFixed(1), BASIS.ESTIMATED_PROXY,
      'instantaneous (available − load)/load; NOT the planning reserve margin')
    : labeled(null, BASIS.ESTIMATED_PROXY);
  const outageRatio = (p && p.outageCapacityMW != null && p.installedCapacityMW > 0)
    ? labeled(+(p.outageCapacityMW / p.installedCapacityMW).toFixed(4), BASIS.DERIVED)
    : labeled(null, BASIS.DERIVED);

  const dayAheadPrice = p && p.dayAheadPrice != null ? labeled(p.dayAheadPrice, BASIS.OBSERVED) : labeled(null, BASIS.OBSERVED);
  const realTimePrice = p && p.realTimePrice != null ? labeled(p.realTimePrice, BASIS.OBSERVED) : labeled(null, BASIS.OBSERVED);
  const dayAheadRealTimeSpread = (dayAheadPrice.value != null && realTimePrice.value != null)
    ? labeled(+(realTimePrice.value - dayAheadPrice.value).toFixed(2), BASIS.DERIVED) : labeled(null, BASIS.DERIVED);
  const zonal = p && p.zonalPrices && Object.keys(p.zonalPrices).length >= 2 ? p.zonalPrices : null;
  const congestionProxy = zonal
    ? labeled(+(Math.max(...Object.values(zonal)) - Math.min(...Object.values(zonal))).toFixed(2), BASIS.ESTIMATED_PROXY, 'max−min zonal DA LMP dispersion')
    : labeled(null, BASIS.ESTIMATED_PROXY);

  const gasPriceProxy = gas && gas.hubPriceUSD != null ? labeled(gas.hubPriceUSD, BASIS.ESTIMATED_PROXY, gas.note || 'hub gas price proxy') : labeled(null, BASIS.ESTIMATED_PROXY);
  const representativeHeatRate = labeled(7.5, BASIS.ASSUMED, 'MMBtu/MWh — typical CCGT, disclosed assumption');
  const sparkSpreadProxy = (dayAheadPrice.value != null && gasPriceProxy.value != null)
    ? labeled(+(dayAheadPrice.value - representativeHeatRate.value * gasPriceProxy.value).toFixed(2), BASIS.DERIVED, 'DA − heatRate×gas')
    : labeled(null, BASIS.DERIVED);

  const weatherAlerts = w && Array.isArray(w.activeAlerts) ? w.activeAlerts : null;
  const weatherDemandRisk = weatherAlerts
    ? labeled(weatherAlerts.filter(a => /heat|cold|wind chill|freeze|winter storm|excessive/i.test(a.event || '')).length, BASIS.DERIVED, 'count of demand-relevant NWS alerts in footprint')
    : labeled(null, BASIS.DERIVED);

  const announcedLargeLoadMW = pipe && pipe.announcedLargeLoadMW != null ? labeled(pipe.announcedLargeLoadMW, BASIS.DERIVED, 'sum of ledger DATA_CENTER_LOAD demandDeltaMW, certainty ≥ ANNOUNCED') : labeled(null, BASIS.DERIVED);
  const generationPipelineMW = pipe && pipe.generationPipelineMW != null ? labeled(pipe.generationPipelineMW, BASIS.DERIVED, 'sum of ledger generation-build deltas') : labeled(null, BASIS.DERIVED);
  const retirementPipelineMW = pipe && pipe.retirementPipelineMW != null ? labeled(pipe.retirementPipelineMW, BASIS.DERIVED) : labeled(null, BASIS.DERIVED);
  const queueFrictionProxy = (announcedLargeLoadMW.value != null && generationPipelineMW.value != null)
    ? labeled(+((announcedLargeLoadMW.value + (retirementPipelineMW.value || 0)) / Math.max(1, generationPipelineMW.value)).toFixed(2),
      BASIS.ESTIMATED_PROXY, '(new load + retirements) / new generation — >1 means demand outruns supply pipeline')
    : labeled(null, BASIS.ESTIMATED_PROXY);

  const fields = {
    currentLoadMW, forecastLoadMW, forecastError, availableCapacityMW, reserveMarginProxy,
    generationByFuel: labeled((p && p.generationByFuel) || (e && e.generationByFuel) || null, BASIS.OBSERVED),
    netInterchange: labeled(p && p.netInterchangeMW != null ? p.netInterchangeMW : (e && e.interchangeMW != null ? e.interchangeMW : null), BASIS.OBSERVED),
    outageCapacityMW: labeled(p && p.outageCapacityMW != null ? p.outageCapacityMW : null, BASIS.OBSERVED),
    outageRatio, dayAheadPrice, realTimePrice, dayAheadRealTimeSpread,
    zonalPrices: labeled(zonal, BASIS.OBSERVED),
    congestionProxy, gasPriceProxy, representativeHeatRate, sparkSpreadProxy,
    weatherDemandRisk, announcedLargeLoadMW, generationPipelineMW, retirementPipelineMW, queueFrictionProxy,
  };
  const staleFields = Object.entries(fields).filter(([, v]) => v.value == null).map(([k]) => k);
  const observable = Object.keys(fields).length;
  const dataCoverage = +((observable - staleFields.length) / observable).toFixed(2);

  return {
    version: REGION_STATE_VERSION, isoRegion, asOf,
    season: (seasonFor(isoRegion, asOf) || {}).name || null,
    ...fields,
    dataCoverage,
    dataQuality: dataCoverage >= 0.7 ? 'good' : dataCoverage >= 0.4 ? 'partial' : 'poor',
    staleFields, sourceManifest,
  };
}

// ── Constraint-pressure score ────────────────────────────────────────────────
// history: prior [{asOf, total}] snapshots (oldest→newest) for change deltas.
function constraintPressureScore(state, history = []) {
  const norms = REGION_NORMS[state.isoRegion];
  if (!norms) {
    return { version: CPS_VERSION, isoRegion: state.isoRegion, total: null, components: {}, available: [], missing: Object.keys(CPS_WEIGHTS), confidence: 0, dataQuality: 'unsupported-region', explanation: `No normalization anchors for ${state.isoRegion}; score withheld rather than mis-normalized.` };
  }
  const season = seasonFor(state.isoRegion, state.asOf);

  const components = {
    // reserve margin: lower margin ⇒ higher stress (inverted linear between anchors)
    reserveMargin: state.reserveMarginProxy.value == null ? null
      : stress(-state.reserveMarginProxy.value, -season.marginComfortPct, -season.marginStressPct),
    loadSurprise: (() => {
      const surprise = state.forecastError.value; // % above forecast
      const pipeline = state.announcedLargeLoadMW.value != null
        ? clamp01(state.announcedLargeLoadMW.value / (season.typicalPeakMW * 0.05)) * 100 : null; // 5% of peak = fully stressed
      if (surprise == null && pipeline == null) return null;
      const s = surprise == null ? null : stress(surprise, 0, 5);   // +5% over forecast = fully stressed
      if (s == null) return Math.round(pipeline);
      if (pipeline == null) return s;
      return Math.round(0.5 * s + 0.5 * pipeline);
    })(),
    outage: state.outageRatio.value == null ? null
      : stress(state.outageRatio.value, norms.outageComfortRatio, norms.outageStressRatio),
    congestion: (() => {
      const spread = state.dayAheadRealTimeSpread.value != null ? Math.abs(state.dayAheadRealTimeSpread.value) : null;
      const disp = state.congestionProxy.value;
      const a = spread == null ? null : stress(spread, 0, norms.daRtSpreadStressAbs);
      const b = disp == null ? null : stress(disp, 0, norms.zonalDispersionStress);
      if (a == null && b == null) return null;
      return a == null ? b : b == null ? a : Math.round((a + b) / 2);
    })(),
    fuel: state.gasPriceProxy.value == null ? null : stress(state.gasPriceProxy.value, norms.gasComfort, norms.gasStress),
    interconnection: state.queueFrictionProxy.value == null ? null
      : stress(state.queueFrictionProxy.value, 0.5, 3),  // pipeline demand 3× new supply = fully stressed
    weather: state.weatherDemandRisk.value == null ? null : stress(state.weatherDemandRisk.value, 0, 6),
    marketStructure: (() => {
      const cap = state.capacityAuctionPrice != null ? state.capacityAuctionPrice : null; // optional ledger-derived input
      return cap == null ? null : stress(cap, 50, norms.capacityCapProxy);
    })(),
  };

  const available = Object.keys(components).filter(k => components[k] != null);
  const missing = Object.keys(components).filter(k => components[k] == null);
  if (!available.length) {
    return { version: CPS_VERSION, isoRegion: state.isoRegion, asOf: state.asOf, total: null, components, available, missing, dominantConstraint: null, change: {}, confidence: 0, dataQuality: state.dataQuality, explanation: 'No component inputs available — score withheld.' };
  }
  const weightAvail = available.reduce((s, k) => s + CPS_WEIGHTS[k], 0);
  const total = Math.round(available.reduce((s, k) => s + components[k] * (CPS_WEIGHTS[k] / weightAvail), 0));
  const dominantConstraint = available.slice().sort((a, b) => components[b] - components[a])[0];

  const deltaAt = (days) => {
    const cutoff = new Date(Date.parse(state.asOf) - days * 864e5).toISOString().slice(0, 10);
    const prior = history.filter(h => h.asOf <= cutoff && h.total != null).pop();
    return prior ? total - prior.total : null;
  };
  const change = { d1: deltaAt(1), d7: deltaAt(7), d30: deltaAt(30) };
  const direction = change.d7 == null ? 'unknown' : change.d7 > 3 ? 'tightening' : change.d7 < -3 ? 'easing' : 'stable';

  const confidence = +(weightAvail * (state.dataCoverage || 0)).toFixed(2);
  const explanation = [
    `${state.isoRegion} ${season.name} constraint pressure ${total}/100 (${direction}).`,
    `Dominant: ${dominantConstraint} (${components[dominantConstraint]}/100).`,
    missing.length ? `Missing inputs: ${missing.join(', ')} — weights renormalized over available components.` : 'All components available.',
    `Weights ${CPS_VERSION} are research hypotheses, not validated alpha.`,
  ].join(' ');

  return {
    version: CPS_VERSION, isoRegion: state.isoRegion, asOf: state.asOf,
    total, components, weights: CPS_WEIGHTS, available, missing,
    dominantConstraint, direction, change, confidence,
    dataQuality: state.dataQuality, explanation,
  };
}

module.exports = {
  REGION_STATE_VERSION, CPS_VERSION, CPS_WEIGHTS, REGION_NORMS,
  seasonFor, stress, buildRegionState, constraintPressureScore,
};

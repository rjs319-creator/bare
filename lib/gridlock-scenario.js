'use strict';
// ⚡ GRIDLOCK — deterministic scenario engine (pure arithmetic, NO LLM).
//
// User-editable assumptions in → transparent arithmetic out. An LLM may
// EXPLAIN these outputs elsewhere; it may never calculate them (non-negotiable
// rule). Every output is labeled with the formula that produced it. This is a
// back-of-envelope reserve-margin model, not a production-cost optimizer —
// stated on every result.

const SCENARIO_VERSION = 'gridlock-scenario-v1';

const HEAT_RATE_MMBTU_PER_MWH = 7.5;      // disclosed CCGT assumption (matches region model)
const DEFAULTS = Object.freeze({
  // PJM-scale defaults (disclosed assumptions, editable in the UI):
  baselinePeakLoadMW: 150000,
  baselineCapacityMW: 180000,
  addedLoadMW: 0,
  generationAddMW: 0,
  retirementsMW: 0,
  outagesMW: 0,
  gasPriceUSD: 3.5,                        // $/MMBtu
  weatherSeverity: 0,                      // 0 normal · 1 stressed · 2 extreme (adds 0/4/8% to peak)
  completionProb: 1,                       // probability the added load/generation materializes
  contractYears: 0,
  transmissionAvailable: true,             // false = imports impaired (capacity haircut)
});

const WEATHER_PEAK_ADDER = Object.freeze([0, 0.04, 0.08]);
const TRANSMISSION_HAIRCUT = 0.03;         // 3% of capacity unavailable when transmission impaired
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function computeScenario(assumptions = {}) {
  // Merge ignores explicitly-undefined keys so partial input (e.g. sparse query
  // params) falls back to defaults instead of clobbering them with undefined.
  const given = Object.fromEntries(Object.entries(assumptions).filter(([, v]) => v !== undefined));
  const a = { ...DEFAULTS, ...given };
  const errors = [];
  for (const k of Object.keys(DEFAULTS)) {
    if (k === 'transmissionAvailable') { if (typeof a[k] !== 'boolean') errors.push(`${k} must be boolean`); continue; }
    if (!(typeof a[k] === 'number' && Number.isFinite(a[k]))) errors.push(`${k} must be a finite number`);
  }
  if (a.completionProb < 0 || a.completionProb > 1) errors.push('completionProb must be within [0,1]');
  if (![0, 1, 2].includes(a.weatherSeverity)) errors.push('weatherSeverity must be 0, 1 or 2');
  if (errors.length) return { ok: false, version: SCENARIO_VERSION, errors };

  const effAddedLoadMW = a.addedLoadMW * a.completionProb;
  const effGenerationAddMW = a.generationAddMW * a.completionProb;
  const weatherAdderMW = a.baselinePeakLoadMW * WEATHER_PEAK_ADDER[a.weatherSeverity];
  const peakLoadMW = a.baselinePeakLoadMW + effAddedLoadMW + weatherAdderMW;
  const capacityMW = (a.baselineCapacityMW + effGenerationAddMW - a.retirementsMW - a.outagesMW) *
    (a.transmissionAvailable ? 1 : 1 - TRANSMISSION_HAIRCUT);

  const reserveMarginBeforePct = +(((a.baselineCapacityMW - a.baselinePeakLoadMW) / a.baselinePeakLoadMW) * 100).toFixed(1);
  const reserveMarginAfterPct = peakLoadMW > 0 ? +(((capacityMW - peakLoadMW) / peakLoadMW) * 100).toFixed(1) : null;
  const marginalCostProxy = +(HEAT_RATE_MMBTU_PER_MWH * a.gasPriceUSD).toFixed(2);
  // Scarcity multiplier: 1.0 at ≥25% margin → 3.0 at ≤5% margin (linear, disclosed).
  const scarcityMult = reserveMarginAfterPct == null ? null :
    +(1 + clamp((25 - reserveMarginAfterPct) / 20, 0, 1) * 2).toFixed(2);
  const priceProxyUSDMWh = scarcityMult == null ? null : +(marginalCostProxy * scarcityMult).toFixed(2);

  return {
    ok: true, version: SCENARIO_VERSION,
    assumptions: a,
    derived: {
      effAddedLoadMW: { value: Math.round(effAddedLoadMW), formula: 'addedLoadMW × completionProb' },
      weatherAdderMW: { value: Math.round(weatherAdderMW), formula: `baselinePeak × ${WEATHER_PEAK_ADDER[a.weatherSeverity]}` },
      peakLoadMW: { value: Math.round(peakLoadMW), formula: 'baselinePeak + effAddedLoad + weatherAdder' },
      capacityMW: { value: Math.round(capacityMW), formula: '(baselineCapacity + effGenAdd − retirements − outages) × transmissionFactor' },
      reserveMarginBeforePct: { value: reserveMarginBeforePct, formula: '(baselineCapacity − baselinePeak) / baselinePeak' },
      reserveMarginAfterPct: { value: reserveMarginAfterPct, formula: '(capacity − peakLoad) / peakLoad' },
      marginalCostProxyUSDMWh: { value: marginalCostProxy, formula: `heatRate ${HEAT_RATE_MMBTU_PER_MWH} × gas $${a.gasPriceUSD}` },
      scarcityMultiplier: { value: scarcityMult, formula: '1 + clamp((25 − marginAfter)/20, 0, 1) × 2' },
      priceProxyUSDMWh: { value: priceProxyUSDMWh, formula: 'marginalCostProxy × scarcityMultiplier' },
      constraintDirection: {
        value: reserveMarginAfterPct == null ? 'unknown'
          : reserveMarginAfterPct < reserveMarginBeforePct - 0.5 ? 'tightening'
          : reserveMarginAfterPct > reserveMarginBeforePct + 0.5 ? 'easing' : 'unchanged',
        formula: 'marginAfter vs marginBefore (±0.5pt band)',
      },
    },
    caveat: 'Back-of-envelope reserve-margin arithmetic with disclosed assumptions — NOT a production-cost model, NOT a price forecast.',
  };
}

// Bull / base / bear: deterministic, disclosed perturbations of the SAME
// assumption set. "Bull" = constraint tightens (for a scarcity-beneficiary
// thesis); "bear" = constraint eases / project slips.
function scenarioTriplet(assumptions = {}) {
  const base = computeScenario(assumptions);
  if (!base.ok) return { ok: false, version: SCENARIO_VERSION, errors: base.errors };
  const a = base.assumptions;
  const bull = computeScenario({
    ...a,
    completionProb: clamp(a.completionProb * 1.0, 0, 1),          // load lands as announced
    generationAddMW: a.generationAddMW * 0.5,                      // competing supply slips
    gasPriceUSD: a.gasPriceUSD * 1.3, weatherSeverity: Math.min(2, a.weatherSeverity + 1),
  });
  const bear = computeScenario({
    ...a,
    completionProb: clamp(a.completionProb * 0.4, 0, 1),          // project slips/cancels
    generationAddMW: a.generationAddMW * 1.5,                      // supply arrives faster
    retirementsMW: a.retirementsMW * 0.5,                          // retirements deferred
    gasPriceUSD: a.gasPriceUSD * 0.7, weatherSeverity: 0,
  });
  return {
    ok: true, version: SCENARIO_VERSION,
    base, bull, bear,
    adjustments: {
      bull: 'load completes; competing generation −50%; gas +30%; weather +1 notch',
      bear: 'completion prob ×0.4; competing generation +50%; retirements deferred; gas −30%; normal weather',
    },
  };
}

module.exports = { SCENARIO_VERSION, DEFAULTS, HEAT_RATE_MMBTU_PER_MWH, computeScenario, scenarioTriplet };

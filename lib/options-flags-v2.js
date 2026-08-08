'use strict';
// OPTIONS v2 FEATURE FLAGS (options-flags-v2) — mirrors the PREMOVE_V2_MODE /
// RLT_MODE convention: a single env-resolved mode with a pure resolver.
//
//   OPTIONS_V2_MODE:
//     'off' — the v2 pipeline does not scan/write and the UI serves the legacy
//             Options tab only (escape hatch / rollback lever).
//     'on'  — DEFAULT. The v2 DISCOVERY engine is live and fully visible
//             (detection is deployable immediately per the product contract).
//
// What stays SHADOW regardless of this flag (governed elsewhere, not here):
//   • The predictive/actionability value of options evidence — the strategy
//     registry entry 'optionsflow-v2' has maturity 'shadow', so v2 events can
//     never originate or boost a live Today's Pick until the registry is
//     deliberately flipped after prospective evidence clears the gate.
//   • Challenger anomaly weight-sets — scored and logged, never displayed as
//     the champion read.
// "Shadow" therefore applies to PREDICTIVE CLAIMS, never to hiding detected
// activity from the user.

const OPTIONS_FLAGS_VERSION = 'options-flags-v2.0';
const MODES = Object.freeze(['off', 'on']);
const DEFAULT_MODE = 'on';

function resolveOptionsV2Mode(raw) {
  const m = String(raw ?? process.env.OPTIONS_V2_MODE ?? '').toLowerCase();
  return MODES.includes(m) ? m : DEFAULT_MODE;
}

function optionsV2Enabled(raw) {
  return resolveOptionsV2Mode(raw) === 'on';
}

module.exports = { OPTIONS_FLAGS_VERSION, MODES, DEFAULT_MODE, resolveOptionsV2Mode, optionsV2Enabled };

'use strict';
// ADAPTIVE-LAYER DISCLOSURE (adaptive-layers-v1) — central visibility for the
// five subsystems that adapt their own weights WITHOUT consulting the central
// governance doc.
//
// The promotion audit's finding: apex Module-2 recalibration, timing tune,
// dual-read adaptation, EVOLVE's strength tilt and the alerts-Fable promotion
// all change effective behavior inside already-production strategies, and none
// of them was visible from governance/latest.json. This module does NOT gate or
// change any of them — it reads each layer's own state doc and reports, so an
// auto-promotion can no longer happen invisibly. Consolidating them UNDER
// governance remains open work; visibility is the prerequisite.
//
// States: ACTIVE (fitted/promoted state currently in force), DORMANT (layer
// exists but its shipped/default behavior is in force), UNKNOWN (read failed —
// never assumed dormant).

const { readJSON } = require('./store');

const ADAPTIVE_LAYERS_VERSION = 'adaptive-layers-v1';

async function probe(fn) {
  try { return await fn(); }
  catch (e) { return { state: 'UNKNOWN', detail: `read failed: ${String((e && e.message) || e)}` }; }
}

async function readAdaptiveLayers() {
  const layers = await Promise.all([
    probe(async () => {
      const model = await readJSON('apex/model.json', null);
      const active = !!(model && model.activeId);
      return {
        layer: 'apex-recalibrate', strategy: 'custom', doc: 'apex/model.json',
        state: active ? 'ACTIVE' : 'DORMANT',
        detail: active
          ? `fitted weights '${model.activeId}' override shipped presets (${(model.versions || []).length} version(s) on record)`
          : 'shipped regime presets in force — no fitted version active',
      };
    }),
    probe(async () => {
      const w = await readJSON('timing/weights.json', null);
      return {
        layer: 'timing-tune', strategy: 'screener (entry timing)', doc: 'timing/weights.json',
        state: w ? 'ACTIVE' : 'DORMANT',
        detail: w ? `tuned weights version '${w.version || '?'}' in force` : 'shipped timing weights in force',
      };
    }),
    probe(async () => {
      const gw = await readJSON('dualread/groupweights.json', null);
      return {
        layer: 'dualread-adapt', strategy: 'dual-horizon read', doc: 'dualread/groupweights.json',
        state: gw ? 'ACTIVE' : 'DORMANT',
        detail: gw ? 'adapted group weights in force' : 'shipped weights in force',
      };
    }),
    probe(async () => {
      const perf = await readJSON('evolve/specialist-perf.json', null);
      const promote = !!(perf && perf.strengthOOS && perf.strengthOOS.promote);
      return {
        layer: 'evolve-strength-tilt', strategy: 'evolve', doc: 'evolve/specialist-perf.json',
        state: promote ? 'ACTIVE' : 'DORMANT',
        detail: promote
          ? 'candidate-strength tilt promoted by its own OOS comparison — live path applies the tilt'
          : 'tilt not promoted — identity behavior in force',
      };
    }),
    probe(async () => {
      const { fableEdgeReport } = require('./alerts-fable');
      const log = await readJSON('alerts/log.json', null);
      const rep = fableEdgeReport(Array.isArray(log) ? log : (log && log.entries) || []);
      return {
        layer: 'alerts-fable', strategy: 'xalerts', doc: 'alerts/log.json (derived)',
        state: rep && rep.promoted ? 'ACTIVE' : 'DORMANT',
        detail: (rep && rep.verdict) || 'no A/B report',
      };
    }),
  ]);

  return Object.freeze({
    version: ADAPTIVE_LAYERS_VERSION,
    note: 'These layers self-adapt inside already-production strategies WITHOUT consulting central governance. This block is read-only disclosure — bringing them under governance is recorded open work (docs/predictive-power-closeout.md).',
    governanceConsulted: false,
    layers: Object.freeze(layers.map(l => Object.freeze({ governanceConsulted: false, ...l }))),
  });
}

module.exports = { ADAPTIVE_LAYERS_VERSION, readAdaptiveLayers };

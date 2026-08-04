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

const ADAPTIVE_LAYERS_VERSION = 'adaptive-layers-v3';

// ── Central policy (the CONTROL half) ──────────────────────────────────────
// A human-editable per-layer switch, stored in its own doc so the daily
// governance rewrite can never clobber it:
//   allow   — the layer may both apply its adapted state AND adopt new fits.
//             Granted ONLY by an explicit, valid policy record.
//   freeze  — the layer keeps its CURRENT persisted adapted state but may not
//             adopt new fits/promotions (fit-sites no-op). Derived-flag layers
//             (evolve tilt, alerts-fable) have no persisted adoption, so for
//             them freeze pins the shipped (not-promoted) behavior — a per-run
//             re-derivation is a NEW adoption, not a current state.
//   disable — apply-sites revert to shipped behavior (adapted state ignored)
//             and fit-sites no-op.
// FAIL-CLOSED (v3): a missing, unreadable, or invalid policy record resolves to
// 'freeze' — the DEFAULT is frozen. Live behavior keeps whatever adapted state
// is already persisted, but NOTHING NEW may be adopted without an explicit
// human 'allow'. A storage outage can therefore never silently activate a
// fitted adaptation (the v2 fail-open default let exactly that happen and was
// the one deliberate fail-open gate in the governance stack — removed).
const POLICY_DOC = 'governance/adaptive-policy.json';
const POLICIES = Object.freeze(['allow', 'freeze', 'disable']);
const DEFAULT_POLICY = 'freeze';
const LAYERS = Object.freeze(['apex-recalibrate', 'timing-tune', 'dualread-adapt', 'evolve-strength-tilt', 'alerts-fable']);

// Pure resolution — only an explicit valid value grants its policy; a missing
// doc, unknown layer, or bad value resolves to 'freeze' (fail-closed).
function policyFor(doc, layer) {
  const v = doc && doc.layers && doc.layers[layer];
  return POLICIES.includes(v) ? v : DEFAULT_POLICY;
}

// Short-memoized doc read so five apply-sites in one invocation cost one fetch.
let policyMemo = { at: 0, doc: null };
const POLICY_MEMO_MS = 30_000;

async function readAdaptivePolicyDoc() {
  const now = Date.now();
  if (now - policyMemo.at < POLICY_MEMO_MS) return policyMemo.doc;
  let doc = null;
  try { doc = await readJSON(POLICY_DOC, null); } catch { doc = null; }
  policyMemo = { at: now, doc };
  return doc;
}

/** The effective policy for one layer: 'allow' | 'freeze' | 'disable'. Never throws.
 *  Fail-closed: any read failure resolves to 'freeze' (nothing new adopted). */
async function layerPolicy(layer) {
  try { return policyFor(await readAdaptivePolicyDoc(), layer); }
  catch { return DEFAULT_POLICY; }
}

async function probe(fn) {
  try { return await fn(); }
  catch (e) { return { state: 'UNKNOWN', detail: `read failed: ${String((e && e.message) || e)}` }; }
}

async function readAdaptiveLayers() {
  const policyDoc = await readAdaptivePolicyDoc().catch(() => null);
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
    note: 'These layers self-adapt inside already-production strategies. Each honors the central adaptive policy (allow/freeze/disable, governance/adaptive-policy.json) at its apply- and fit-sites. v3 FAIL-CLOSED: the default (missing/broken/unset policy) is FREEZE — persisted adapted state stays in force but nothing new is adopted without an explicit human allow. A storage outage can never silently activate a fitted adaptation.',
    policyDoc: POLICY_DOC,
    policyDefault: DEFAULT_POLICY,
    layers: Object.freeze(layers.map(l => Object.freeze({ policy: policyFor(policyDoc, l.layer), ...l }))),
  });
}

module.exports = {
  ADAPTIVE_LAYERS_VERSION, POLICY_DOC, POLICIES, DEFAULT_POLICY, LAYERS,
  readAdaptiveLayers, policyFor, layerPolicy, readAdaptivePolicyDoc,
};

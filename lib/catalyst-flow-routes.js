'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// CATALYST–FLOW RANKER routes — HTTP layer only (params, cache headers, JSON).
// All logic lives in the pure lib/catalyst-flow/* modules.
//
//   op=catalystflow          public read — latest published ranking + state + limitations
//   op=catalystflowcoverage  public read — data availability: what is measurable TODAY
//   op=catalystflowregistry  public read — the versioned feature registry (declarations)
//
// SHADOW / weight-0 by construction. There is deliberately NO tick op and NO training op:
// the model is trained offline (research/catalyst_flow/train_lambdamart.py) and the
// serving layer only ever READS a published artifact. A request must never train
// LightGBM, and the absence of a write path is what guarantees it.
// ═══════════════════════════════════════════════════════════════════════════

const CFG = require('./catalyst-flow/config');
const REGISTRY = require('./catalyst-flow/registry');
const SIGNED = require('./catalyst-flow/options-signed');
const SERVING = require('./catalyst-flow/serving');
const STORE = require('./catalyst-flow/store');

const noStore = (res) => res.setHeader('Cache-Control', 'no-store');
const cached = (res, s = 120) => res.setHeader('Cache-Control', `s-maxage=${s}, stale-while-revalidate=600`);

// The session axis the freshness check needs. Derived from the app's own SPY history so
// there is one market calendar, not a second hand-maintained one. A failure here degrades
// freshness to "not evaluated" rather than failing the whole read.
async function sessionAxis() {
  try {
    const { fetchDailyHistory } = require('./screener');
    const d = await fetchDailyHistory('SPY', '1y');
    const sessions = (d && d.candles || []).map((c) => c.date).filter(Boolean).sort();
    return { sessions, today: sessions[sessions.length - 1] || null };
  } catch { return { sessions: [], today: null }; }
}

async function runCatalystFlow(req, res) {
  const { sessions, today } = await sessionAxis();
  const view = await SERVING.readLatestRanking({ sessions, today });

  // A live-eligible ranking would be cacheable; a shadow/absent one is cheap and should
  // reflect a fresh publish immediately.
  if (view.state === 'SHADOW' || view.state === 'LIVE') cached(res, 120); else noStore(res);

  return res.json({
    ok: true,
    op: 'catalystflow',
    engine: CFG.CATALYST_FLOW_VERSION,
    ...view,
    // Repeated at the top level so no consumer can render a ranking without it.
    shadow: view.state !== 'LIVE',
    promotionGates: CFG.PROMOTION_GATES,
  });
}

async function runCatalystFlowCoverage(req, res) {
  noStore(res);
  const f = CFG.flags();
  // No signed-options adapter is configured anywhere in this build; the report below is
  // the honest consequence, not a placeholder.
  const signed = SIGNED.coverageReport(null);
  const published = await STORE.listPredictionDates(30);

  return res.json({
    ok: true,
    op: 'catalystflowcoverage',
    engine: CFG.CATALYST_FLOW_VERSION,
    flags: { enabled: f.enabled, mode: f.mode, hasModelPath: !!f.modelPath, hasPredictionsPath: !!f.predictionsPath },
    providers: {
      estimatesVintage: {
        configured: !!f.estimatesProvider,
        // Measured against this repo's own vendor archive, not assumed.
        state: f.estimatesProvider ? 'CONFIGURED' : 'ABSENT',
        consequence: 'Without a genuine pre-release consensus vintage, every family-A feature is RECONSTRUCTED_EXPLORATORY and cannot support promotion.',
      },
      signedOptions: signed,
    },
    arms: {
      E0_CURRENT_OMEGA: 'requires an incumbent OMEGA score resolved per event',
      E1_SIMPLE_PEAD: 'runs wherever family A or B is populated',
      E2_CATALYST_RANKER: 'runs without family C',
      E3_CATALYST_FLOW_RANKER: signed.armE3Status,
    },
    publishedPredictionDates: published,
    storage: STORE.hasStore() ? 'configured' : 'absent',
  });
}

function runCatalystFlowRegistry(req, res) {
  cached(res, 3600);
  return res.json({
    ok: true,
    op: 'catalystflowregistry',
    version: REGISTRY.REGISTRY_VERSION,
    families: REGISTRY.FAMILY,
    counts: Object.fromEntries(Object.entries(REGISTRY.NAMES_BY_FAMILY).map(([k, v]) => [k, v.length])),
    features: REGISTRY.FEATURES,
    armFeatureFamilies: REGISTRY.ARM_FEATURE_FAMILIES,
  });
}

module.exports = { runCatalystFlow, runCatalystFlowCoverage, runCatalystFlowRegistry };

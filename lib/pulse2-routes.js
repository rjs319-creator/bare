'use strict';
// 📡 MARKET PULSE v2 — PUBLIC READ-ONLY ROUTES.
//
// These routes ONLY read persisted artifacts and compute pure derivations (clocks,
// playbook). They can never initiate an LLM call, fetch from a market-data provider,
// or mutate storage — the writers live in pulse2-ticks.js behind PRIVILEGED_OPS.
//
//   op=pulse2         the full v2 payload (market now + playbook + views + sections)
//   op=pulse2health   data-health / scheduler / coverage read
//   op=pulse2evidence evidence + track-record read (outcomes, comparison, transitions)
//
// Honesty contract: the payload always carries BOTH clocks (narrative vs market data),
// each stamped from its own source; a provider failure surfaces as UNAVAILABLE with a
// reason, never as a neutral market or an empty-but-fine page.

const { sessionInfoAt, assessFreshness } = require('./market-session');
const clocks = require('./pulse2-clocks');
const { buildPlaybook } = require('./pulse2-market-state');
const store = require('./pulse2-store');

const FLAG_ENV = 'PULSE2_MODE';   // 'on' (default) | 'off' — rollback lever

function pulse2Enabled() {
  return String(process.env[FLAG_ENV] || 'on').toLowerCase() !== 'off';
}

/** Assemble the two-clock block from persisted docs + the live wall clock. */
function buildPayloadClocks({ narrativesDoc, marketStateDoc, now }) {
  const sessionInfo = sessionInfoAt(now);
  const marketDataAsOf = marketStateDoc && marketStateDoc.state ? marketStateDoc.state.marketDataAsOf : null;
  const intradayCount = marketStateDoc && marketStateDoc.coverage ? marketStateDoc.coverage.intradayCount : 0;
  // Re-assess at READ time: a snapshot that was live at tick time decays honestly.
  const assessed = marketDataAsOf ? assessFreshness({
    sourceKind: intradayCount > 0 ? 'intraday' : 'daily',
    barTimestamp: marketDataAsOf, barIntervalSec: 300, now,
  }) : null;
  const degraded = !marketStateDoc || (marketStateDoc.coverage && marketStateDoc.coverage.degraded) || !narrativesDoc;
  return clocks.buildClocks({
    narrativeGeneratedAt: narrativesDoc ? narrativesDoc.generatedAt : null,
    marketDataAsOf,
    assessed,
    sessionInfo,
    sourceCoverageAsOf: narrativesDoc ? narrativesDoc.sourceCoverageAsOf : null,
    sectorDataAsOf: marketStateDoc ? marketStateDoc.sectorDataAsOf : null,
    now,
    dataMode: (!marketStateDoc && !narrativesDoc) ? 'unavailable' : (degraded ? 'degraded' : 'live'),
  });
}

/** Trim an event for the wire (drop bulky internals, keep the decision surface). */
function wireEvent(e) {
  if (!e) return null;
  const { firstSeenClaims, firstSeenFeatures, transitions, snapshots, ...rest } = e;
  return rest;
}

// ── op=pulse2 — the page payload ─────────────────────────────────────────────
// `refresh=1` is the HONEST refresh path: it bypasses the CDN cache (no-store) and
// re-reads the persisted snapshot, then REPORTS whether the narrative really is
// current (cache.status REFRESHED) or still the cached generation (STALE) with
// nextNarrativeRefreshAt. It never regenerates — regeneration stays behind the
// PRIVILEGED pulse2collect tick, so a public refresh cannot be abused into LLM
// spend; the read itself is the same cheap Blob fetch either way.
async function runPulse2(req, res) {
  if (!pulse2Enabled()) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: false, disabled: true, error: 'Pulse v2 is disabled (PULSE2_MODE=off) — legacy op=pulse remains available.' });
  }
  const refreshRequested = !!(req && req.query && String(req.query.refresh || '') === '1');
  const now = new Date();
  const [marketStateDoc, narrativesDoc, eventsDoc, alertsDoc, marketAlertsDoc, outDoc] = await Promise.all([
    store.readMarketState().catch(() => null),
    store.readNarratives().catch(() => null),
    store.readEvents().catch(() => ({ events: [] })),
    store.readAlerts().catch(() => ({ alerts: [] })),
    store.readMarketAlerts().catch(() => ({ alerts: [] })),
    store.readOutcomes().catch(() => ({ summary: null, comparison: null })),
  ]);

  const payloadClocks = buildPayloadClocks({ narrativesDoc, marketStateDoc, now });
  const state = marketStateDoc ? marketStateDoc.state : null;
  const events = (eventsDoc.events || []).filter(e => !e.expired);
  const byId = new Map(events.map(e => [e.id, e]));

  // Playbook inputs from persisted intelligence (deterministic).
  const sections = narrativesDoc && narrativesDoc.sections ? narrativesDoc.sections : {};
  const headlinesFor = ids => (ids || []).map(id => byId.get(id)).filter(Boolean).map(e => e.headline);
  const triggers = (narrativesDoc && narrativesDoc.views ? narrativesDoc.views.day : [])
    .filter(d => d && (d.tradeState === 'ARMED' || d.tradeState === 'PRICE_CONFIRMED') && d.trigger != null)
    .map(d => `${d.ticker} ${d.tradeState === 'ARMED' ? 'armed at' : 'confirmed through'} ${d.trigger}`);
  const today = payloadClocks.etDate;
  const eventRisk = events
    .filter(e => e.eventDate && today && e.eventDate >= today)
    .sort((a, b) => (a.eventDate < b.eventDate ? -1 : 1))
    .slice(0, 5)
    .map(e => `${e.eventDate}: ${e.headline}`);

  const playbook = state ? buildPlaybook(state, {
    freshVerified: headlinesFor(sections.freshVerified),
    triggers,
    eventRisk,
  }) : null;

  // Recently changed — from the persisted transition trail.
  const transDoc = await store.readTransitions().catch(() => ({ transitions: [] }));
  const recentlyChanged = (transDoc.transitions || []).slice(-15).reverse()
    .map(t => ({ kind: t.kind, headline: t.headline, from: t.from || null, to: t.to || null, at: t.at, date: t.date }));

  res.setHeader('Cache-Control', refreshRequested
    ? 'no-store'
    : `s-maxage=${clocks.CACHE_TTL_SECONDS}, stale-while-revalidate=300`);
  return res.json({
    ok: true,
    schema: 'pulse2-v1',
    clocks: payloadClocks,
    cache: clocks.cacheMeta({ refreshRequested, narrativeAgeMinutes: payloadClocks.narrativeAgeMinutes }),
    marketState: state,
    // Three-layer regime stack + cross-asset confirmation matrix, written by
    // pulse2statetick. Null until the first tick after this release persists — the
    // `unavailable` list below says so rather than the UI inventing a neutral regime.
    regimeStack: marketStateDoc ? marketStateDoc.regimeStack || null : null,
    crossAsset: marketStateDoc ? marketStateDoc.crossAsset || null : null,
    playbook,
    narratives: narrativesDoc ? {
      generation: narrativesDoc.generation,
      stage: narrativesDoc.stage,
      items: narrativesDoc.items,
      views: narrativesDoc.views,
      sections,
      sources: narrativesDoc.sources,
      disclaimer: narrativesDoc.disclaimer,
    } : null,
    events: events.slice(-60).map(wireEvent),
    alerts: [...(marketAlertsDoc.alerts || []), ...(alertsDoc.alerts || [])]
      .sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 20),
    recentlyChanged,
    trackRecord: { summary: outDoc.summary || null, comparison: outDoc.comparison || null },
    unavailable: [
      ...(!state ? [{ what: 'market state', why: 'no market-state tick has persisted yet (scheduler not running or store absent)' }] : []),
      ...(!narrativesDoc ? [{ what: 'narratives', why: 'no collection cycle has persisted yet' }] : []),
      ...(state && !(marketStateDoc && marketStateDoc.regimeStack)
        ? [{ what: 'regime stack', why: 'no market-state tick has persisted a regime stack yet (it is written by pulse2statetick from this release onward)' }] : []),
      ...(state && !(marketStateDoc && marketStateDoc.crossAsset)
        ? [{ what: 'cross-asset matrix', why: 'no market-state tick has persisted a cross-asset matrix yet (it is written by pulse2statetick from this release onward)' }] : []),
    ],
  });
}

// ── op=pulse2health — data health / scheduler status ─────────────────────────
async function runPulse2Health(req, res) {
  const now = new Date();
  const [health, marketStateDoc, narrativesDoc] = await Promise.all([
    store.readHealth().catch(() => ({})),
    store.readMarketState().catch(() => null),
    store.readNarratives().catch(() => null),
  ]);
  const payloadClocks = buildPayloadClocks({ narrativesDoc, marketStateDoc, now });
  res.setHeader('Cache-Control', 's-maxage=60');
  return res.json({
    ok: true,
    enabled: pulse2Enabled(),
    clocks: payloadClocks,
    components: health,
    marketDataProvider: 'yahoo-chart (keyless, 5-min bars, RTH only)',
    narrativeProvider: process.env.ANTHROPIC_API_KEY ? 'anthropic web_search (haiku collect + fable refine)' : 'UNAVAILABLE — no ANTHROPIC_API_KEY',
    storeConfigured: store.hasStore(),
    coverage: marketStateDoc ? marketStateDoc.coverage : null,
    scheduler: {
      marketStateTarget: 'every 5 min during regular hours (.github/workflows/pulse2-tick.yml)',
      narrativeTarget: 'every 60 min during regular hours + nightly warm chain',
      gradeTarget: 'nightly (warm chain pulse2 root)',
      note: 'Vercel Hobby allows one daily cron; intraday cadence depends on the GitHub Actions workflow actually running. The clocks above report reality, not the target.',
    },
    modelVersion: clocks.MODEL_VERSION,
  });
}

// ── op=pulse2evidence — evidence + track record ──────────────────────────────
async function runPulse2Evidence(req, res) {
  const [outDoc, transDoc, eventsDoc] = await Promise.all([
    store.readOutcomes().catch(() => ({ outcomes: [], summary: null, comparison: null })),
    store.readTransitions().catch(() => ({ transitions: [] })),
    store.readEvents().catch(() => ({ events: [] })),
  ]);
  res.setHeader('Cache-Control', 's-maxage=300');
  return res.json({
    ok: true,
    summary: outDoc.summary || null,
    comparison: outDoc.comparison || null,
    outcomeCount: (outDoc.outcomes || []).length,
    recentOutcomes: (outDoc.outcomes || []).slice(-25).reverse(),
    transitions: (transDoc.transitions || []).slice(-50).reverse(),
    eventCount: (eventsDoc.events || []).length,
    note: 'Prospective only. No probability is shown below the sample floor; directional value is never auto-claimed.',
  });
}

module.exports = { runPulse2, runPulse2Health, runPulse2Evidence, pulse2Enabled, buildPayloadClocks, wireEvent, FLAG_ENV };

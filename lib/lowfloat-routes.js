'use strict';
// API SURFACE for the low-float / intraday-continuation stack.
//
// NO NEW SERVERLESS FUNCTIONS. Every op here is dispatched from the existing api/tracker.js,
// which is deliberate: this deployment is on a plan that caps deployed Serverless Functions,
// and the app has already folded a dozen domains into that one dispatcher for the same reason.
//
// READ vs WRITE AUTHORITY mirrors the pattern the Day Trade board already established:
//   op=lowfloat / op=intradaycontinuation / op=largemoveraudit / op=intradayvalidation
//       → PUBLIC, READ-ONLY. They compute and return, but never advance state, never emit
//         alerts, and never write a research record.
//   op=lowfloattick / op=intradaytick / op=largemoveraudittick
//       → PRIVILEGED (CRON_SECRET bearer, enforced by api/tracker's PRIVILEGED_OPS). These are
//         the only writers.
// A public GET that could write would let a browser refresh mint entry events.

const CFG = require('./lowfloat-config');
const store = require('./lowfloat-store');
const { runPipeline, saveDiscoveryState } = require('./lowfloat-pipeline');
const { ACTION_STATES, ENTRY_TEMPLATES } = require('./intraday-actionability');
const { STRUCTURE_STATES } = require('./intraday-continuation');
const { IGNITION_STATES } = require('./low-float-ignition');
const { buildAlerts } = require('./lowfloat-alerts');
const { buildEntryEvent, resolveDay } = require('./intraday-outcomes');
const validation = require('./intraday-validation');
const audit = require('./large-mover-audit');

// ── Shared response furniture ────────────────────────────────────────────────
// Every response carries the versions that produced it and the data limitations that apply.
// Both are required by the spec and both are things a reader needs to interpret the numbers.
function envelope(extra = {}) {
  return {
    schemaVersion: CFG.SCHEMA_VERSION,
    scoringVersion: CFG.LOW_FLOAT_IGNITION_VERSION,
    configurationVersion: CFG.CONFIG_VERSION,
    versions: {
      universe: CFG.UNIVERSE_VERSION, float: CFG.FLOAT_VERSION, discovery: CFG.DISCOVERY_VERSION,
      ignition: CFG.LOW_FLOAT_IGNITION_VERSION, continuation: CFG.CONTINUATION_VERSION,
      actionability: CFG.ACTIONABILITY_VERSION, validation: CFG.VALIDATION_VERSION,
      supplyRisk: CFG.SUPPLY_RISK_VERSION, catalyst: CFG.CATALYST_VERSION, audit: CFG.AUDIT_VERSION,
    },
    flags: CFG.flags(),
    limitations: LIMITATIONS,
    generatedAt: new Date().toISOString(),
    ...extra,
  };
}

// Stated on every response. These are the things the app genuinely cannot do, and hiding them
// would make every score above look more authoritative than it is.
const LIMITATIONS = Object.freeze([
  'Bar resolution is FIVE MINUTES. A 30-second API refresh does not create 30-second market resolution, and a target and a stop inside the same bar cannot be ordered — the stop is assumed first.',
  'There is no NBBO, bid/ask spread, depth, or halt/LULD feed. Names below $5, ultra-low-float names and thin tape require a manual spread check before any entry is allowed.',
  'Float comes from a third-party provider and is only as current as the last filing it reflects. A float we do not have is UNKNOWN — it is never inferred from market capitalization.',
  'Supply/dilution risk is classified from news headlines and the price record, not from a filings index. Absence of evidence is not evidence of absence.',
  'Explosion Potential and Trade Quality are interpretable rankings built from pre-registered weights. Neither is a probability, neither is fitted, and no profitability is claimed.',
  'No entry template has passed the promotion gate. Everything actionable is PAPER only.',
]);

function noStore(res) { res.setHeader('Cache-Control', 'no-store'); }
// Intraday routes get a short shared-cache window (~45s) so a page refreshing on a 30-second
// cadence coalesces at the CDN instead of re-running the pipeline per viewer. Deliberately
// NOT the 15-minute Day Trade cache — an actionable intraday state cannot be minutes old.
function shortCache(res, seconds = 45) { res.setHeader('Cache-Control', `s-maxage=${seconds}, stale-while-revalidate=15`); }

function etDate(now = new Date()) {
  return new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ── Promotion state (read once, used by the pipeline to gate LIVE labels) ────
async function loadPromotion() {
  const doc = await store.readPromotionState().catch(() => null);
  return (doc && doc.byTemplate) || {};
}

// ── LOW-FLOAT IGNITION RADAR ─────────────────────────────────────────────────
async function computeRadar({ now = new Date(), t0 = Date.now(), mutate = false, req = null } = {}) {
  const promotionByTemplate = await loadPromotion();
  const sessionDate = etDate(now);

  // Spread confirmations are per-browser and arrive as a query parameter; they are consumed
  // as a gate input only and are never persisted server-side (they are a human attestation
  // about that human's own broker screen, not a fact about the market).
  const spreadConfirmations = {};
  if (req && req.query && req.query.spreadok) {
    for (const t of String(req.query.spreadok).split(',').map(s => s.trim().toUpperCase()).filter(Boolean)) {
      spreadConfirmations[t] = true;
    }
  }

  let regime = 'neutral';
  try { const m = await require('./macro').fetchMacro(); if (m) regime = m.regime; } catch { /* regime is context */ }

  const priorDoc = mutate ? await store.readAlertState().catch(() => null) : null;
  const priorRecords = {};
  if (priorDoc && priorDoc.sessionDate === sessionDate) {
    for (const [t, v] of Object.entries(priorDoc.byTicker || {})) priorRecords[t] = v;
  }

  const result = await runPipeline({
    now, t0, mutate, regime, promotionByTemplate, spreadConfirmations, priorRecords,
  });
  return { ...result, regime, sessionDate, promotionByTemplate };
}

// Project the pipeline records into the shape the Low-Float Radar renders.
function radarCard(r) {
  return {
    ticker: r.ticker, company: r.company, sector: r.sector,
    price: r.price, marketCap: r.marketCap,
    floatShares: r.floatShares, floatTier: r.floatTier, floatConfidence: r.floatConfidence,
    floatPctOfOutstanding: r.floatPctOfOutstanding, floatTurnover: r.floatTurnover,
    sharesOutstanding: r.sharesOutstanding,
    dayChangePct: r.dayChangePct, relativeVolume: r.relativeVolume,
    currentSessionVolume: r.currentSessionVolume,
    currentSessionDollarVolume: r.currentSessionDollarVolume,
    currentDollarVolume5m: r.currentDollarVolume5m, currentDollarVolume15m: r.currentDollarVolume15m,
    fiveMinVolumeAcceleration: r.fiveMinVolumeAcceleration,
    fifteenMinVolumeAcceleration: r.fifteenMinVolumeAcceleration,
    fiveMinPriceAcceleration: r.fiveMinPriceAcceleration,
    fifteenMinPriceAcceleration: r.fifteenMinPriceAcceleration,
    thirtyMinPriceAcceleration: r.thirtyMinPriceAcceleration,
    catalyst: r.catalyst, catalystTier: r.catalystTier, catalystFreshnessMinutes: r.catalystFreshnessMinutes,
    dilutionRisk: r.dilutionRisk,
    explosionPotentialScore: r.explosionPotentialScore, explosionFamilies: r.explosionFamilies,
    tradeQualityScore: r.tradeQualityScore, tradeQualityFamilies: r.tradeQualityFamilies,
    continuationScore: r.continuationScore, remainingEdgeScore: r.remainingEdgeScore,
    exhaustionScore: r.exhaustionScore,
    ignitionState: r.ignitionState, structureState: r.structureState, actionState: r.actionState,
    entryTemplate: r.entryTemplate, setupEntryClassification: r.setupEntryClassification,
    entryQualityScore: r.entryQualityScore, entryAllowed: r.entryAllowed,
    templatePromotionState: r.templatePromotionState,
    trigger: r.trigger, entryZoneLow: r.entryZoneLow, entryZoneHigh: r.entryZoneHigh,
    maximumChasePrice: r.maximumChasePrice, invalidation: r.invalidation,
    target1: r.target1, target2: r.target2, riskReward: r.riskReward,
    sessionVwap: r.sessionVwap, ema9: r.ema9, ema21: r.ema21,
    distanceFromHighPct: r.distanceFromHighPct,
    minutesUntilClose: r.minutesUntilClose, sessionWindow: r.sessionWindow,
    checklist: r.checklist, blockingReasons: r.blockingReasons, cautionReasons: r.cautionReasons,
    warnings: r.warnings, reasonCodes: (r.reasonCodes || []).slice(0, 3),
    manualSpreadCheckRequired: r.manualSpreadCheckRequired, spreadConfirmed: r.spreadConfirmed,
    whatMustHappenNext: r.whatMustHappenNext, recommendedActionText: r.recommendedActionText,
    headline: headlineFor(r),
    discoverySources: r.discoverySources, discoveryRank: r.discoveryRank,
    firstDetectedAt: r.firstDetectedAt, priceAtFirstDetection: r.priceAtFirstDetection,
    dataTimestamp: r.dataTimestamp, lastCompletedBarAt: r.lastCompletedBarAt,
    barResolutionMinutes: r.barResolutionMinutes, temporalResolutionRisk: r.temporalResolutionRisk,
    stale: r.stale, analyzed: r.analyzed,
  };
}

// The HEADLINE is the primary thing rendered — more prominent than any score, because a
// number invites the reader to supply their own interpretation and a sentence does not.
function headlineFor(r) {
  if (r.stale) return 'NO TRADE — STALE DATA';
  if (r.blockingReasons && r.blockingReasons.includes('MANUAL_SPREAD_CONFIRMATION_REQUIRED')) return 'NO TRADE — SPREAD NOT VERIFIED';
  switch (r.structureState) {
    case STRUCTURE_STATES.FAILED_BREAKOUT: return 'FAILED BREAKOUT';
    case STRUCTURE_STATES.DISTRIBUTION: return 'DISTRIBUTION RISK';
    case STRUCTURE_STATES.EXHAUSTED: return 'EXHAUSTED — NO NEW ENTRY';
    default: break;
  }
  if (r.actionState === ACTION_STATES.MISSED_OR_EXTENDED) return 'DO NOT CHASE';
  if (r.actionState === ACTION_STATES.LIVE_VALIDATED_ENTRY) return 'LIVE VALIDATED ENTRY';
  if (r.actionState === ACTION_STATES.PAPER_ENTRY_ELIGIBLE) return 'PAPER ENTRY ONLY';
  if (r.actionState === ACTION_STATES.READY_IF_TRIGGERED) return 'READY IF TRIGGERED';
  if (r.actionState === ACTION_STATES.MANAGE_EXISTING_ONLY) return 'TOO LATE — MANAGE ONLY';
  if ((r.explosionPotentialScore ?? 0) >= 60 && (r.tradeQualityScore ?? 0) < 40) return 'HIGH EXPLOSION — POOR TRADE QUALITY';
  if (r.ignitionState === IGNITION_STATES.EARLY_IGNITION) return 'EARLY IGNITION — WATCH';
  if (r.actionState === ACTION_STATES.SETUP_BUILDING) return 'SETUP BUILDING';
  if (r.actionState === ACTION_STATES.AVOID) return 'AVOID';
  return 'WATCH ONLY';
}

// Tab bucketing for the radar. Note what it is NOT sorted by: the day's largest percentage
// gain. That ordering is what produced a screen full of names whose move had already happened.
function bucketRadar(cards) {
  const avoid = cards.filter(c => [ACTION_STATES.AVOID, ACTION_STATES.NO_TRADE].includes(c.actionState)
    || [STRUCTURE_STATES.FAILED_BREAKOUT, STRUCTURE_STATES.DISTRIBUTION].includes(c.structureState));
  const extended = cards.filter(c => c.actionState === ACTION_STATES.MISSED_OR_EXTENDED
    || c.structureState === STRUCTURE_STATES.EXHAUSTED);
  const ready = cards.filter(c => [ACTION_STATES.READY_IF_TRIGGERED, ACTION_STATES.PAPER_ENTRY_ELIGIBLE,
    ACTION_STATES.LIVE_VALIDATED_ENTRY, ACTION_STATES.WATCH_ONLY, ACTION_STATES.SETUP_BUILDING].includes(c.actionState)
    && !extended.includes(c) && !avoid.includes(c));
  const potential = cards.filter(c => (c.explosionPotentialScore ?? 0) >= 45 && !avoid.includes(c) && !extended.includes(c));
  return {
    potentialMovers: potential, readyWatching: ready, tooExtended: extended, avoid, all: cards,
  };
}

async function runLowFloat(req, res) {
  const t0 = Date.now();
  try {
    const out = await computeRadar({ now: new Date(), t0, mutate: false, req });
    if (!out.ok) { noStore(res); return res.status(200).json(envelope({ ok: false, error: out.error, session: out.session, diagnostics: out.diagnostics })); }
    const cards = (out.records || []).map(radarCard);
    shortCache(res);
    return res.json(envelope({
      ok: true,
      readOnly: true,
      authority: 'read-only-projection',
      session: out.session,
      regime: out.regime,
      disabled: out.disabled || null,
      emptyReason: out.emptyReason || null,
      // An honest empty state. The system is permitted to say there is nothing.
      emptyMessage: cards.length ? null : 'No validated intraday entry is currently available.',
      buckets: bucketRadar(cards),
      counts: countsOf(cards),
      coverage: coverageOf(out),
      elapsedMs: Date.now() - t0,
      partialResults: !!out.partialResults,
    }));
  } catch (e) {
    noStore(res);
    return res.status(200).json(envelope({ ok: false, error: String((e && e.message) || e), elapsedMs: Date.now() - t0 }));
  }
}

function countsOf(cards) {
  const by = key => cards.reduce((m, c) => { const k = c[key] || 'NONE'; m[k] = (m[k] || 0) + 1; return m; }, {});
  return {
    total: cards.length,
    byActionState: by('actionState'),
    byStructureState: by('structureState'),
    byIgnitionState: by('ignitionState'),
    byFloatTier: by('floatTier'),
    highExplosion: cards.filter(c => (c.explosionPotentialScore ?? 0) >= 60).length,
    highExplosionPoorQuality: cards.filter(c => (c.explosionPotentialScore ?? 0) >= 60 && (c.tradeQualityScore ?? 0) < 40).length,
    paperEligible: cards.filter(c => c.actionState === ACTION_STATES.PAPER_ENTRY_ELIGIBLE).length,
    liveValidated: cards.filter(c => c.actionState === ACTION_STATES.LIVE_VALIDATED_ENTRY).length,
  };
}

// The coverage diagnostics block the spec requires on every response.
function coverageOf(out) {
  const d = (out && out.diagnostics && out.diagnostics.stages) || {};
  return {
    universeSize: d.universe ? d.universe.universeSize : null,
    universeCoverage: d.universe ? d.universe.coverage : null,
    universeAgeHours: d.universe ? d.universe.ageHours : null,
    scannedThisCycle: d.discovery ? d.discovery.scannedThisCycle : null,
    universeTruncated: d.discovery ? d.discovery.universeTruncated : null,
    bulkQuotesReceived: d.discovery ? d.discovery.bulkQuotesReceived : null,
    quoteCoveragePct: d.discovery ? d.discovery.quoteCoveragePct : null,
    quoteProvider: d.discovery ? d.discovery.provider : null,
    volumeAvailable: d.discovery ? d.discovery.volumeAvailable : null,
    // The two honest notes a reader needs to interpret everything above: whether a volume-
    // capable provider answered at all, and what that costs in recall.
    quoteNote: d.discovery ? (d.discovery.capabilityNote || d.discovery.note || null) : null,
    candidatesDiscovered: d.discovery ? d.discovery.candidatesDiscovered : null,
    discoveryLaneCounts: d.discovery ? d.discovery.laneCounts : null,
    discoveryRejections: d.discovery ? d.discovery.rejected : null,
    floatEnriched: d.float ? d.float.withFloat : null,
    floatMissing: d.float ? d.float.withoutFloat : null,
    floatCoveragePct: d.float ? d.float.floatCoveragePct : null,
    floatProviderConfigured: d.float ? d.float.providerConfigured : null,
    floatNote: d.float ? d.float.note : null,
    intradayEnriched: d.intraday ? d.intraday.enriched : null,
    intradayFailures: d.intraday ? d.intraday.failed : null,
    intradayDeadlineSkipped: d.intraday ? d.intraday.deadlineSkipped : null,
    barResolutionMinutes: d.intraday ? d.intraday.barResolutionMinutes : null,
    catalystEnriched: d.catalyst ? d.catalyst.enriched : null,
    staleCandidates: d.scoring ? d.scoring.staleCandidates : null,
    candidatesRanked: d.scoring ? d.scoring.candidatesRanked : null,
    elapsedMs: out.elapsedMs ?? null,
    partialResults: !!out.partialResults,
    providerCoverage: {
      quotes: d.discovery ? d.discovery.provider : null,
      bars: d.intraday ? d.intraday.provider : null,
      float: d.float ? d.float.providers : null,
    },
  };
}

// ── PRIVILEGED TICK — the one writer ─────────────────────────────────────────
// SESSION GUARD for the scheduled tick. A cron cannot know the exchange calendar, so it
// fires on a fixed UTC window that necessarily overshoots both DST regimes, weekends aside.
// Running the full pipeline outside regular hours costs ~24 bulk-quote requests to learn
// something the stale-quote guard was going to reject anyway, and this app has already hit a
// provider plan limit once. So an off-session tick returns cheaply and says why.
// `force=1` overrides it for manual verification (the op is privileged, so only the bearer
// holder can use it).
function offSessionSkip(session, req) {
  if (req && req.query && (req.query.force === '1' || req.query.force === 'true')) return null;
  if (session.isRegularHours) return null;
  // Allow a short pre-open lead-in so the first bars of the session are captured promptly.
  const leadInMin = 10;
  if (session.minutesSinceOpen >= -leadInMin && session.minutesUntilClose > 0) return null;
  return session.minutesSinceOpen < 0
    ? 'before the open — the pipeline runs from ~10 minutes pre-open'
    : 'after the close — no live quotes to evaluate';
}

async function runLowFloatTick(req, res) {
  const t0 = Date.now();
  const now = new Date();
  const sessionDate = etDate(now);
  noStore(res);
  try {
    const session = require('./intraday-data').sessionStatus(now);
    const skip = offSessionSkip(session, req);
    if (skip) {
      return res.json(envelope({
        ok: true, skipped: true, reason: skip, sessionDate, session,
        note: 'No provider calls were made. Pass force=1 to run anyway.',
        elapsedMs: Date.now() - t0,
      }));
    }
    const out = await computeRadar({ now, t0, mutate: true, req });
    if (!out.ok) return res.status(200).json(envelope({ ok: false, error: out.error, diagnostics: out.diagnostics }));

    const records = out.records || [];
    const cards = records.map(radarCard);

    // 1) Persist the discovery interval state so the NEXT scan can compute acceleration.
    const stateSave = await saveDiscoveryState(out.nextDiscoveryState);

    // 2) Log EVERY candidate at every stage — winners and losers alike. A ledger of only the
    //    names that worked is how a screener convinces itself it is good.
    const snapshots = { discovery: null, ignition: null, continuation: null };
    if (store.hasStore()) {
      try {
        await store.writeDiscoverySnapshot(sessionDate, {
          schemaVersion: CFG.SCHEMA_VERSION, sessionDate, generatedAt: now.toISOString(),
          coverage: out.diagnostics.stages.discovery,
          candidates: (out.allDiscovered || []).map(c => ({
            ticker: c.ticker, discoverySources: c.discoverySources, discoveryRank: c.discoveryRank,
            discoveryPriority: c.discoveryPriority, firstDetectedAt: c.firstDetectedAt,
            priceAtFirstDetection: c.priceAtFirstDetection, dayChangeAtFirstDetection: c.dayChangeAtFirstDetection,
            price: c.price, dayChangePct: c.dayChangePct, relativeVolume: c.relativeVolume,
            currentSessionDollarVolume: c.currentSessionDollarVolume, dataTimestamp: c.dataTimestamp,
          })),
        }, now);
        snapshots.discovery = 'written';
      } catch (e) { snapshots.discovery = `failed: ${(e && e.message) || e}`; }

      try {
        await store.writeIgnitionSnapshot(sessionDate, {
          schemaVersion: CFG.SCHEMA_VERSION, sessionDate, generatedAt: now.toISOString(),
          records: records.map(r => ({
            ticker: r.ticker, floatShares: r.floatShares, floatTier: r.floatTier,
            floatConfidence: r.floatConfidence, floatTurnover: r.floatTurnover,
            explosionPotentialScore: r.explosionPotentialScore, tradeQualityScore: r.tradeQualityScore,
            ignitionState: r.ignitionState, actionState: r.actionState, entryTemplate: r.entryTemplate,
            blockingReasons: r.blockingReasons, catalyst: r.catalyst, catalystTier: r.catalystTier,
            dilutionRisk: r.dilutionRisk, discoveryRank: r.discoveryRank,
            displayed: (r.explosionPotentialScore ?? 0) >= 45,
            configurationVersion: r.configurationVersion,
          })),
        }, now);
        snapshots.ignition = 'written';
      } catch (e) { snapshots.ignition = `failed: ${(e && e.message) || e}`; }

      try {
        await store.writeContinuationSnapshot(sessionDate, {
          schemaVersion: CFG.SCHEMA_VERSION, sessionDate, generatedAt: now.toISOString(),
          records: records.filter(r => r.analyzed).map(r => ({
            ticker: r.ticker, structureState: r.structureState, continuationScore: r.continuationScore,
            remainingEdgeScore: r.remainingEdgeScore, exhaustionScore: r.exhaustionScore,
            trigger: r.trigger, invalidation: r.invalidation, target1: r.target1,
            riskReward: r.riskReward, entryQualityScore: r.entryQualityScore,
            setupEntryClassification: r.setupEntryClassification,
            lastCompletedBarAt: r.lastCompletedBarAt, stale: r.stale,
          })),
        }, now);
        snapshots.continuation = 'written';
      } catch (e) { snapshots.continuation = `failed: ${(e && e.message) || e}`; }
    }

    // 3) Point-in-time entry events for everything that became eligible THIS cycle.
    const eligible = records.filter(r => r.entryAllowed && r.entryTemplate);
    const events = eligible.map(r => buildEntryEvent({
      ticker: r.ticker, sessionDate,
      signalTimestamp: now.toISOString(),
      // The signal becomes user-visible when this tick publishes it. Anchoring the fill here
      // is what stops the measurement from crediting a price nobody could have acted on.
      firstUserVisibleTimestamp: now.toISOString(),
      providerTimestamp: r.dataTimestamp,
      lastCompletedBarTimestamp: r.lastCompletedBarAt,
      entryTemplate: r.entryTemplate,
      entryReferencePrice: r.price, trigger: r.trigger, structuralStop: r.invalidation,
      target1: r.target1, target2: r.target2, minutesUntilClose: r.minutesUntilClose,
      barResolution: r.barResolutionMinutes || 5,
      sessionDollarVolume: r.currentSessionDollarVolume,
      actionState: r.actionState, explosionPotentialScore: r.explosionPotentialScore,
      tradeQualityScore: r.tradeQualityScore, structureState: r.structureState,
      floatTier: r.floatTier, floatShares: r.floatShares, catalystTier: r.catalystTier,
      dilutionRisk: r.dilutionRisk, sessionWindow: r.sessionWindow,
      discoverySources: r.discoverySources, firstDetectedAt: r.firstDetectedAt,
    }));
    let eventResult = { appended: 0, total: 0 };
    if (events.length && store.hasStore()) {
      try { eventResult = await store.appendEvents(sessionDate, events); }
      catch (e) { eventResult = { appended: 0, total: 0, error: String((e && e.message) || e) }; }
    }

    // 4) Alerts on meaningful transitions.
    const priorAlertState = await store.readAlertState().catch(() => null);
    const usablePrior = priorAlertState && priorAlertState.sessionDate === sessionDate ? priorAlertState : { sessionDate, byTicker: {}, dayCounts: {} };
    const alertOut = buildAlerts(cards, usablePrior, { now, sessionDate });
    let alertSave = { saved: false };
    if (store.hasStore()) {
      try { await store.writeAlertState(alertOut.nextState); alertSave = { saved: true }; }
      catch (e) { alertSave = { saved: false, error: String((e && e.message) || e) }; }
    }

    return res.json(envelope({
      ok: true,
      authority: 'privileged-tick',
      sessionDate,
      session: out.session,
      candidatesRanked: records.length,
      snapshots,
      discoveryStateSaved: stateSave,
      entryEvents: eventResult,
      alerts: alertOut.alerts,
      alertsEmitted: alertOut.alerts.length,
      alertsSuppressed: alertOut.suppressed,
      alertStateSaved: alertSave,
      coverage: coverageOf(out),
      durableStore: store.hasStore(),
      elapsedMs: Date.now() - t0,
    }));
  } catch (e) {
    return res.status(200).json(envelope({ ok: false, error: String((e && e.message) || e), elapsedMs: Date.now() - t0 }));
  }
}

// ── INTRADAY BREAKOUT RADAR ──────────────────────────────────────────────────
// Same pipeline, different lens: this view is about STRUCTURE, and it includes names whose
// float is unknown (most of the market). The Low-Float Radar is the float-constrained subset.
async function runIntradayContinuation(req, res) {
  const t0 = Date.now();
  try {
    const out = await computeRadar({ now: new Date(), t0, mutate: false, req });
    if (!out.ok) { noStore(res); return res.status(200).json(envelope({ ok: false, error: out.error, diagnostics: out.diagnostics })); }
    const cards = (out.records || []).filter(r => r.analyzed).map(radarCard);
    const byState = {};
    for (const s of Object.values(STRUCTURE_STATES)) byState[s] = cards.filter(c => c.structureState === s);
    shortCache(res);
    return res.json(envelope({
      ok: true, readOnly: true, authority: 'read-only-projection',
      session: out.session, regime: out.regime,
      emptyMessage: cards.length ? null : 'No candidate has analyzable current-session structure right now.',
      byStructureState: byState,
      cards,
      counts: countsOf(cards),
      coverage: coverageOf(out),
      elapsedMs: Date.now() - t0,
      partialResults: !!out.partialResults,
    }));
  } catch (e) {
    noStore(res);
    return res.status(200).json(envelope({ ok: false, error: String((e && e.message) || e) }));
  }
}

// ── RESEARCH BOOKS ───────────────────────────────────────────────────────────
// The full logged record for a session: every candidate at every stage, not just the ones
// that produced an entry.
async function runLowFloatBook(req, res) {
  noStore(res);
  const date = String((req.query && req.query.date) || etDate());
  try {
    const [discovery, ignition, continuation, events, outcomes] = await Promise.all([
      store.readSnapshotsForDay(store.DISCOVERY_PREFIX, date),
      store.readSnapshotsForDay(store.IGNITION_PREFIX, date),
      store.readSnapshotsForDay(store.CONTINUATION_PREFIX, date),
      store.readEventsDay(date),
      store.readOutcomesDay(date),
    ]);
    return res.json(envelope({
      ok: true, date,
      durableStore: store.hasStore(),
      snapshots: { discovery: discovery.length, ignition: ignition.length, continuation: continuation.length },
      discoveredTickers: [...new Set(discovery.flatMap(d => (d.candidates || []).map(c => c.ticker)))].length,
      analyzedTickers: [...new Set(continuation.flatMap(d => (d.records || []).map(c => c.ticker)))].length,
      events: (events && events.events) || [],
      outcomes: (outcomes && outcomes.events) || [],
      outcomeSummary: (outcomes && outcomes.summary) || null,
      note: store.hasStore()
        ? 'Every Stage-0 candidate, Stage-1 score and Stage-2 structure recorded this session, including the rejections and the near misses.'
        : 'Blob storage is not configured — nothing is being logged, so no forward record can accrue.',
      availableDates: await store.listSnapshotDates(store.DISCOVERY_PREFIX).catch(() => []),
    }));
  } catch (e) {
    return res.status(200).json(envelope({ ok: false, error: String((e && e.message) || e), date }));
  }
}

// ── OUTCOME RESOLUTION (privileged) ──────────────────────────────────────────
async function runIntradayResolve(req, res) {
  noStore(res);
  const date = String((req.query && req.query.date) || etDate());
  try {
    const doc = await store.readEventsDay(date);
    const events = (doc && doc.events) || [];
    if (!events.length) return res.json(envelope({ ok: true, date, resolved: 0, note: 'no entry events logged for this date' }));

    const { fetchIntradayBatch } = require('./intraday-data');
    const tickers = [...new Set(events.map(e => e.ticker))];
    const bars = await fetchIntradayBatch(tickers, { now: new Date(), sessionDate: date, cap: 120, deadline: 45000 });
    const barsByTicker = {};
    for (const [t, r] of Object.entries(bars.byTicker)) if (r.ok) barsByTicker[t] = r.completed;

    const resolvedOut = resolveDay(events, barsByTicker);
    if (store.hasStore()) {
      await store.writeOutcomesDay(date, {
        schemaVersion: CFG.SCHEMA_VERSION, date,
        events: resolvedOut.events, summary: resolvedOut.summary,
        resolvedAt: new Date().toISOString(),
      });
    }
    return res.json(envelope({
      ok: true, date,
      ...resolvedOut.summary,
      barCoverage: bars.coverage,
      durableStore: store.hasStore(),
    }));
  } catch (e) {
    return res.status(200).json(envelope({ ok: false, error: String((e && e.message) || e), date }));
  }
}

// ── VALIDATION DASHBOARD ─────────────────────────────────────────────────────
async function runIntradayValidation(req, res) {
  noStore(res);
  try {
    const dates = await store.listSnapshotDates(store.OUTCOMES_PREFIX).catch(() => []);
    const recent = dates.slice(-120);
    const docs = await Promise.all(recent.map(d => store.readOutcomesDay(d).catch(() => null)));
    const allEvents = docs.filter(Boolean).flatMap(d => d.events || []).filter(e => e && e.resolved);

    const promotionDoc = await store.readPromotionState().catch(() => null);
    const stored = (promotionDoc && promotionDoc.byTemplate) || {};

    const byTemplate = {};
    for (const tmpl of Object.values(ENTRY_TEMPLATES)) {
      const stats = validation.calculateTemplateStats(allEvents, { template: tmpl });
      // Baseline: the SAME events measured under the naive rule "buy the top-ranked candidate
      // as soon as it appears". Constructed from the same pool at the same instants, which is
      // the only comparison that means anything.
      const baselineStats = validation.calculateTemplateStats(
        allEvents.filter(e => e.actionState && (e.discoverySources || []).length), { template: null });
      const baselineComparison = validation.compareToMatchedBaseline(stats, {
        ...baselineStats, template: validation.BASELINES.BUY_TOP_RANKED_IMMEDIATELY,
      });
      const recentStats = validation.calculateTemplateStats(
        allEvents.filter(e => e.entryTemplate === tmpl).slice(-CFG.PROMOTION.DRIFT_WINDOW_EVENTS), { template: tmpl });
      const drift = validation.evaluateModelDrift(stored[tmpl] || null, recentStats, {
        currentConfigVersion: CFG.CONFIG_VERSION,
        baselineRate: baselineStats.targetBeforeStopRate,
      });
      byTemplate[tmpl] = {
        stats,
        baselineComparison,
        promotion: validation.evaluateTemplatePromotion(stats, {
          currentConfigVersion: CFG.CONFIG_VERSION,
          baselineComparison,
          driftStatus: drift.status === 'HEALTHY' ? 'HEALTHY' : drift.status,
        }),
        drift,
        storedPromotion: stored[tmpl] || null,
      };
    }

    return res.json(envelope({
      ok: true,
      datesWithOutcomes: dates.length,
      resolvedEvents: allEvents.length,
      byTemplate,
      promotionThresholds: CFG.PROMOTION,
      baselines: validation.BASELINES,
      durableStore: store.hasStore(),
      note: 'Templates are evaluated SEPARATELY and never pooled. No template is live-validated; every actionable state in this app is PAPER.',
    }));
  } catch (e) {
    return res.status(200).json(envelope({ ok: false, error: String((e && e.message) || e) }));
  }
}

// Privileged: recompute promotion state and persist it (with automatic demotion applied).
async function runIntradayPromote(req, res) {
  noStore(res);
  try {
    const dates = await store.listSnapshotDates(store.OUTCOMES_PREFIX).catch(() => []);
    const docs = await Promise.all(dates.slice(-200).map(d => store.readOutcomesDay(d).catch(() => null)));
    const allEvents = docs.filter(Boolean).flatMap(d => d.events || []).filter(e => e && e.resolved);
    const priorDoc = await store.readPromotionState().catch(() => null);
    const prior = (priorDoc && priorDoc.byTemplate) || {};

    const next = {}, drifts = {};
    for (const tmpl of Object.values(ENTRY_TEMPLATES)) {
      const stats = validation.calculateTemplateStats(allEvents, { template: tmpl });
      const baselineStats = validation.calculateTemplateStats(allEvents, { template: null });
      const baselineComparison = validation.compareToMatchedBaseline(stats, { ...baselineStats, template: validation.BASELINES.BUY_TOP_RANKED_IMMEDIATELY });
      const recentStats = validation.calculateTemplateStats(
        allEvents.filter(e => e.entryTemplate === tmpl).slice(-CFG.PROMOTION.DRIFT_WINDOW_EVENTS), { template: tmpl });
      drifts[tmpl] = validation.evaluateModelDrift(prior[tmpl] || null, recentStats, {
        currentConfigVersion: CFG.CONFIG_VERSION, baselineRate: baselineStats.targetBeforeStopRate,
      });
      next[tmpl] = validation.evaluateTemplatePromotion(stats, {
        currentConfigVersion: CFG.CONFIG_VERSION, baselineComparison, driftStatus: drifts[tmpl].status,
      });
    }
    const withDrift = validation.applyDrift(next, drifts);
    if (store.hasStore()) {
      await store.writePromotionState({ schemaVersion: CFG.SCHEMA_VERSION, updatedAt: new Date().toISOString(), byTemplate: withDrift });
    }
    return res.json(envelope({
      ok: true, byTemplate: withDrift, drifts,
      liveValidated: Object.entries(withDrift).filter(([, v]) => v.promotionState === 'LIVE_VALIDATED').map(([k]) => k),
      durableStore: store.hasStore(),
    }));
  } catch (e) {
    return res.status(200).json(envelope({ ok: false, error: String((e && e.message) || e) }));
  }
}

// ── LARGE-MOVER MISS AUDIT ───────────────────────────────────────────────────
async function computeAudit(date, { now = new Date(), t0 = Date.now() } = {}) {
  const { loadTradableUniverse } = require('./tradable-universe');
  const { fetchBulkQuotes } = require('./quote-provider');
  const { fetchIntradayBatch } = require('./intraday-data');

  const universeDoc = await loadTradableUniverse({ now }).catch(() => null);
  const securities = (universeDoc && universeDoc.securities) || [];
  const symbols = securities.map(s => s.symbol);

  const bulk = await fetchBulkQuotes(symbols.slice(0, CFG.DISCOVERY.UNIVERSE_QUOTE_CAP));
  const movers = audit.rankMovers(bulk.rows || [], { topN: 20 });

  // Only the union of the leaderboards gets a bar fetch (bounded), which is what makes the
  // 30/60-minute maxima affordable.
  const moverTickers = [...new Set(Object.values(movers)
    .filter(Array.isArray).flat().map(r => r.ticker))].slice(0, 60);
  const bars = await fetchIntradayBatch(moverTickers, { now, sessionDate: date, cap: 60, deadline: 35000, t0 });
  const barsByTicker = {};
  for (const [t, r] of Object.entries(bars.byTicker)) if (r.ok) barsByTicker[t] = r.completed;

  const [discovery, ignition, continuation, eventsDoc] = await Promise.all([
    store.readSnapshotsForDay(store.DISCOVERY_PREFIX, date),
    store.readSnapshotsForDay(store.IGNITION_PREFIX, date),
    store.readSnapshotsForDay(store.CONTINUATION_PREFIX, date),
    store.readEventsDay(date),
  ]);

  const trail = {
    universe: new Set(symbols),
    universeExclusions: new Map(),   // populated below from the universe coverage report
    quoted: new Set((bulk.rows || []).map(r => r.ticker)),
    discovery, ignition, continuation,
    events: (eventsDoc && eventsDoc.events) || [],
    rejections: [],
  };
  // A mover absent from the universe gets its exclusion reason by re-running the pure
  // classifier over the directory row, so the audit says WHICH filter dropped it.
  try {
    const { classifySecurity, parseListed } = require('./tradable-universe');
    const { fetchUniverseSources } = require('./universe-expand');
    const rows = await fetchUniverseSources();
    const byTicker = new Map(rows.map(r => [String(r.symbol || '').toUpperCase(), r]));
    for (const m of Object.values(movers).filter(Array.isArray).flat()) {
      if (trail.universe.has(m.ticker)) continue;
      const row = byTicker.get(m.ticker);
      trail.universeExclusions.set(m.ticker, row ? classifySecurity(row).exclusionReason : 'NOT_IN_SYMBOL_DIRECTORY');
    }
    void parseListed;
  } catch { /* exclusions stay unknown; the audit reports NOT_IN_UNIVERSE without a sub-reason */ }

  return audit.buildAudit({
    sessionDate: date, movers, trail, barsByTicker,
    displayCut: 12, cfg: CFG.DISCOVERY,
    universeCoverage: universeDoc ? universeDoc.coverage : null,
  });
}

async function runLargeMoverAudit(req, res) {
  noStore(res);
  const date = String((req.query && req.query.date) || etDate());
  const flags = CFG.flags();
  if (!flags.ENABLE_LARGE_MOVER_AUDIT) {
    return res.json(envelope({ ok: true, disabled: 'ENABLE_LARGE_MOVER_AUDIT is off', date }));
  }
  try {
    // Prefer the persisted post-close audit; recompute only when asked or when absent.
    const cached = await store.readAuditDay(date).catch(() => null);
    if (cached && !(req.query && req.query.refresh)) {
      return res.json(envelope({ ok: true, date, cached: true, ...cached }));
    }
    const built = await computeAudit(date, { now: new Date(), t0: Date.now() });
    return res.json(envelope({ ok: true, date, cached: false, ...built }));
  } catch (e) {
    return res.status(200).json(envelope({ ok: false, error: String((e && e.message) || e), date }));
  }
}

// Privileged: build and PERSIST the audit for a completed session.
async function runLargeMoverAuditTick(req, res) {
  noStore(res);
  const date = String((req.query && req.query.date) || etDate());
  try {
    const built = await computeAudit(date, { now: new Date(), t0: Date.now() });
    let saved = false;
    if (store.hasStore()) { await store.writeAuditDay(date, built); saved = true; }
    return res.json(envelope({
      ok: true, date, saved,
      moversAudited: built.records.length,
      recall: built.recall,
      missHistogram: built.missHistogram,
    }));
  } catch (e) {
    return res.status(200).json(envelope({ ok: false, error: String((e && e.message) || e), date }));
  }
}

async function runLargeMoverBook(req, res) {
  noStore(res);
  try {
    const dates = await store.listSnapshotDates(store.AUDIT_PREFIX).catch(() => []);
    const recent = dates.slice(-30);
    const docs = (await Promise.all(recent.map(d => store.readAuditDay(d).catch(() => null)))).filter(Boolean);
    // Aggregate the miss histogram across sessions — the single most useful number in the
    // whole system, because it names the filter costing the most recall.
    const histogram = {};
    for (const d of docs) for (const [k, v] of Object.entries(d.missHistogram || {})) histogram[k] = (histogram[k] || 0) + v;
    const recallSeries = docs.map(d => ({
      date: d.sessionDate,
      recallTop10: d.recall ? d.recall.recallOfTop10OpenToHighMovers : null,
      recallTop20: d.recall ? d.recall.recallOfTop20OpenToHighMovers : null,
      overall: d.recall ? d.recall.overallRecallPct : null,
      before20Pct: d.recall ? d.recall.recallBefore20PctMove : null,
    }));
    const sortedHistogram = Object.fromEntries(Object.entries(histogram).sort((a, b) => b[1] - a[1]));
    return res.json(envelope({
      ok: true,
      sessions: docs.length,
      availableDates: dates,
      aggregateMissHistogram: sortedHistogram,
      largestSingleCauseOfMisses: Object.keys(sortedHistogram)[0] || null,
      categoryLabels: audit.CATEGORY_LABEL,
      recallSeries,
      durableStore: store.hasStore(),
    }));
  } catch (e) {
    return res.status(200).json(envelope({ ok: false, error: String((e && e.message) || e) }));
  }
}

// ── FLOAT PROVIDER PROBE ─────────────────────────────────────────────────────
// Answers one question the rest of the stack cannot answer from a local environment: does the
// configured provider plan ACTUALLY return share-float data? The whole low-float lane is
// worth exactly as much as that answer, and assuming it works would be the same mistake as
// assuming a stock has a small float because it has a small market cap.
//
// Bounded to five tickers, read-only, no persistence. Returns the raw record including the
// as-of date and the reliability assessment, so a "yes" can be distinguished from a "yes but
// the value is three years old".
async function runFloatProbe(req, res) {
  noStore(res);
  const raw = String((req.query && req.query.tickers) || 'AAPL,GME,SAVA,TSLA').toUpperCase();
  const tickers = raw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);
  try {
    const { fetchFloatData, PROVIDERS } = require('./float-data');
    const now = new Date();
    const records = await Promise.all(tickers.map(t => fetchFloatData(t, { now }).catch(e => ({
      ticker: t, floatShares: null, floatTier: 'UNKNOWN', floatConfidence: 'LOW',
      notes: [String((e && e.message) || e)],
    }))));
    const withFloat = records.filter(r => r.floatShares != null);
    return res.json(envelope({
      ok: true,
      providerConfigured: !!process.env.FMP_API_KEY,
      providers: PROVIDERS.map(p => ({ name: p.name, suppliesFloat: p.suppliesFloat })),
      requested: tickers.length,
      answered: withFloat.length,
      floatDataAvailable: withFloat.length > 0,
      records,
      verdict: !process.env.FMP_API_KEY
        ? 'No float provider is configured. Every float is UNKNOWN and the low-float lane will correctly surface nothing rather than guess from market capitalization.'
        : withFloat.length === 0
          ? 'The provider is configured but returned NO float for any probe ticker — the plan does not appear to include share-float. The low-float lane cannot operate until a provider that supplies float is added to the registry in lib/float-data.js.'
          : `Float data IS available (${withFloat.length}/${tickers.length} answered). Check each record's filingDate and confidence — a stale float is usable context but earns reduced supply-constraint credit.`,
    }));
  } catch (e) {
    return res.status(200).json(envelope({ ok: false, error: String((e && e.message) || e) }));
  }
}

// ── BULK-QUOTE PROVIDER PROBE ────────────────────────────────────────────────
// Which provider actually answers, and does it carry VOLUME? This decides three of the seven
// discovery lanes: relative volume, volume acceleration and low-float turnover all need a
// share count, and the keyless fallback supplies none of them. A scan that silently degrades
// to the no-volume provider loses most of its recall while still reporting "ok".
//
// Probes the volume-capable provider DIRECTLY (not through the fallback chain) so a failure
// surfaces its actual HTTP status instead of being masked by a successful fallback.
async function runQuoteProbe(req, res) {
  noStore(res);
  const raw = String((req.query && req.query.tickers) || 'AAPL,MSFT,NVDA,TSLA,AMD').toUpperCase();
  const tickers = raw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 10);
  const key = process.env.FMP_API_KEY;
  const out = { tickers, fmpConfigured: !!key };

  if (key) {
    const url = `https://financialmodelingprep.com/stable/batch-quote?symbols=${tickers.join(',')}&apikey=${key}`;
    try {
      const r = await require('./http').fetchWithTimeout(url, { timeoutMs: 12000 });
      out.fmpStatus = r.status;
      const text = await r.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* not JSON */ }
      out.fmpShape = Array.isArray(parsed) ? 'array' : (parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 5) : 'unparseable');
      out.fmpRows = Array.isArray(parsed) ? parsed.length : 0;
      out.fmpSample = Array.isArray(parsed) && parsed[0] ? Object.keys(parsed[0]) : null;
      out.fmpHasVolume = Array.isArray(parsed) && parsed.some(q => q && q.volume != null);
      // The provider's own error text is the most useful thing here — never swallow it.
      if (!r.ok || !Array.isArray(parsed)) out.fmpError = text.slice(0, 300);
    } catch (e) {
      out.fmpError = String((e && e.message) || e);
    }
  }

  try {
    const bulk = await require('./quote-provider').fetchBulkQuotes(tickers);
    out.resolvedProvider = bulk.coverage.provider;
    out.resolvedRows = bulk.rows.length;
    out.resolvedVolumeAvailable = bulk.coverage.volumeAvailable;
    out.sampleRow = bulk.rows[0] || null;
  } catch (e) {
    out.resolvedError = String((e && e.message) || e);
  }

  out.verdict = !out.fmpConfigured
    ? 'No FMP key configured — the scan uses the keyless fallback, which carries NO volume, so the relative-volume, volume-acceleration and low-float-turnover lanes cannot run.'
    : out.resolvedProvider === 'fmp-batch'
      ? 'The volume-capable provider is answering. All seven discovery lanes can run.'
      : `FMP is configured but the batch-quote endpoint did not answer usably (HTTP ${out.fmpStatus ?? 'n/a'}) — the scan fell back to the keyless no-volume provider, which disables three of the seven discovery lanes. See fmpError.`;

  return res.json(envelope({ ok: true, ...out }));
}

// ── POSITION-SIZING CALCULATOR ───────────────────────────────────────────────
// Pure arithmetic exposed as an endpoint so the client and the tests share ONE implementation
// (the app has been bitten before by a scorer duplicated between server and browser).
async function runPositionSize(req, res) {
  noStore(res);
  const q = (req && req.query) || {};
  const num = (v, d = null) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
  try {
    const out = require('./position-sizing').calculatePositionSize({
      entryPrice: num(q.entry), invalidation: num(q.stop),
      sessionDollarVolume: num(q.dollarvol), floatTier: q.floattier || null,
      openRiskPct: num(q.openrisk, 0),
      settings: {
        accountSize: num(q.account, undefined), maxRiskPerTradePct: num(q.riskpct, undefined),
        maxPositionPct: num(q.maxpos, undefined), maxPortfolioOpenRiskPct: num(q.maxportfolio, undefined),
        maxTradeValue: num(q.maxvalue), maxShares: num(q.maxshares),
      },
    });
    return res.json(envelope({ ok: true, ...out, neverPlacesOrders: true }));
  } catch (e) {
    return res.status(200).json(envelope({ ok: false, error: String((e && e.message) || e) }));
  }
}

module.exports = {
  runLowFloat, runLowFloatTick, runLowFloatBook,
  runIntradayContinuation, runIntradayResolve,
  runIntradayValidation, runIntradayPromote,
  runLargeMoverAudit, runLargeMoverAuditTick, runLargeMoverBook,
  runPositionSize, runFloatProbe, runQuoteProbe,
  computeRadar, computeAudit, radarCard, headlineFor, bucketRadar, countsOf, coverageOf, offSessionSkip,
  envelope, LIMITATIONS,
};

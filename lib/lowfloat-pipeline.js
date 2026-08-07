'use strict';
// THE STAGED PIPELINE, ASSEMBLED. Stage 0 → 1 → 2 → 3, with the budget discipline that keeps
// the whole thing inside one serverless invocation.
//
// COST SHAPE (this is the design constraint that dictates everything else):
//   Stage 0  ~10 bulk-quote requests for the WHOLE universe            — cheap, runs on everything
//   Stage 1  float lookups for the top N candidates (cached daily)     — bounded
//   Stage 2  one 5-minute chart fetch per enriched candidate           — bounded, the expensive part
//   Stage 3  pure arithmetic                                           — free
// The caps live in lowfloat-config DISCOVERY and are all env-overridable. Nothing here fans
// out per-symbol over the full universe, and no LLM is called anywhere in this path.
//
// PARTIAL RESULTS ARE A FEATURE. Every stage is deadline-aware and reports what it did not
// reach. A response that covered 40 of 60 candidates says so; it never silently presents the
// 40 as though they were the whole picture.

const CFG = require('./lowfloat-config');
const { loadTradableUniverse } = require('./tradable-universe');
const { runMoverDiscovery } = require('./mover-discovery');
const { enrichFloatData } = require('./float-data');
const { fetchIntradayBatch, sessionStatus } = require('./intraday-data');
const { analyzeIntradayContinuation, STRUCTURE_STATES } = require('./intraday-continuation');
const { analyzeLowFloatIgnition, sortIgnitionRecords } = require('./low-float-ignition');
const { evaluateActionability, ACTION_STATES } = require('./intraday-actionability');
const { fetchCatalystContext, unevaluatedCatalyst } = require('./catalyst-context');
const { fetchSupplyRisk, unknownSupplyRisk } = require('./supply-risk');
const { readJSON, writeJSON, hasStore } = require('./store');

const DISCOVERY_STATE_KEY = 'lowfloat/discovery-state.json';

// ── Bounded, deadline-aware map ──────────────────────────────────────────────
async function mapBounded(items, limit, fn, { t0, deadline }) {
  const out = new Array(items.length).fill(null);
  let i = 0, skipped = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      if (deadline && Date.now() - t0 > deadline) { skipped++; continue; }
      try { out[idx] = await fn(items[idx], idx); } catch { out[idx] = null; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, worker));
  return { out, skipped };
}

// ── THE PIPELINE ─────────────────────────────────────────────────────────────
async function runPipeline({
  now = new Date(), t0 = Date.now(), deadline = CFG.DISCOVERY.REQUEST_DEADLINE_MS,
  mutate = false, regime = 'neutral', priorRecords = {}, spreadConfirmations = {},
  promotionByTemplate = {}, forceUniverseRebuild = false,
} = {}) {
  const flags = CFG.flags();
  const session = sessionStatus(now);
  const diagnostics = { stages: {}, flags };

  // ── STAGE 0a — the eligible universe ───────────────────────────────────────
  const universeDoc = await loadTradableUniverse({ now, forceRebuild: forceUniverseRebuild }).catch(() => null);
  const securities = (universeDoc && universeDoc.securities) || [];
  diagnostics.stages.universe = {
    universeSize: securities.length,
    fromCache: universeDoc ? universeDoc.fromCache : null,
    ageHours: universeDoc ? universeDoc.ageHours : null,
    coverage: universeDoc ? universeDoc.coverage : null,
  };
  if (!flags.ENABLE_LOW_FLOAT_DISCOVERY) {
    return { ok: true, disabled: 'ENABLE_LOW_FLOAT_DISCOVERY is off', session, records: [], diagnostics, flags };
  }
  if (!securities.length) {
    return {
      ok: false, error: 'eligible universe is empty — the symbol-directory build failed',
      session, records: [], diagnostics, flags,
    };
  }

  // ── STAGE 0b — high-recall discovery over one bulk snapshot ────────────────
  const priorState = hasStore() ? await readJSON(DISCOVERY_STATE_KEY, null).catch(() => null) : null;
  // Interval state from a PRIOR SESSION must never seed this session's acceleration maths —
  // an overnight gap would read as a colossal five-minute move. A session change resets it.
  const usableState = priorState && priorState.sessionDate === session.etDate ? priorState.state : {};

  // Float cache is consulted BEFORE discovery so the low-float-demand lane can fire on names
  // enriched in an earlier cycle without spending a lookup here.
  const cachedFloat = hasStore() ? await require('./lowfloat-store').readFloatCache().catch(() => null) : null;
  const floatSeed = (cachedFloat && cachedFloat.byTicker) || {};

  // Catalyst cache, same reasoning: catalyst enrichment (below, Stage 2/3) only ever runs on
  // the narrow post-discovery top-N, AFTER lanes are evaluated. Without a seed here the
  // FRESH_CATALYST lane can never fire during discovery — it would always see catalystTier
  // null. `reassessCatalyst` recomputes freshnessMinutes against THIS cycle's clock, so a
  // headline cached three cycles ago correctly ages out instead of reading as still-fresh.
  const cachedCatalyst = hasStore() ? await require('./lowfloat-store').readCatalystCache().catch(() => null) : null;
  const catalystSeed = {};
  if (cachedCatalyst && cachedCatalyst.byTicker) {
    const { reassessCatalyst } = require('./catalyst-context');
    for (const [t, rec] of Object.entries(cachedCatalyst.byTicker)) catalystSeed[t] = reassessCatalyst(rec, now);
  }

  // The whole eligible universe is scanned every cycle: the crumb-authenticated Yahoo quote
  // provider covers ~4,700 names in ~24 requests (~1 s) and carries volume, so there is no
  // reason to truncate. The cap remains as a defensive bound only.
  const scanUniverse = securities.slice(0, CFG.DISCOVERY.UNIVERSE_QUOTE_CAP);

  const discovery = await runMoverDiscovery({
    universe: scanUniverse, state: usableState, floatByTicker: floatSeed, catalystByTicker: catalystSeed,
    now, minutesSinceOpen: session.minutesSinceOpen, t0,
  });

  // CAPABILITY is read from what the provider ACTUALLY returned, not from which API key
  // happens to be configured. Those diverged once already: FMP is configured but its
  // batch-quote endpoint is restricted on this plan, so keying the diagnostic off the key's
  // presence would have reported full capability while three lanes were dark.
  const volumeCapableProvider = discovery.coverage.volumeAvailable === true;
  diagnostics.stages.discovery = {
    ...discovery.coverage,
    eligibleUniverseSize: securities.length,
    scannedThisCycle: scanUniverse.length,
    universeTruncated: scanUniverse.length < securities.length,
    volumeCapableProvider,
    capabilityNote: volumeCapableProvider ? null
      : 'The answering bulk-quote provider returned NO volume, so the relative-volume, volume-acceleration and low-float-turnover lanes could not run this scan. Recall is materially reduced — the percent-move, price-acceleration, gap and catalyst lanes still ran.',
  };

  const candidates = discovery.candidates || [];
  if (!candidates.length) {
    return {
      ok: true, session, records: [], alerts: [], diagnostics, flags,
      emptyReason: discovery.coverage.bulkQuotesReceived === 0
        ? 'The bulk-quote provider returned no rows this scan — nothing could be evaluated.'
        : 'No candidate tripped a discovery lane this scan.',
      nextDiscoveryState: discovery.nextState,
      elapsedMs: Date.now() - t0,
      partialResults: discovery.coverage.bulkQuotesReceived < scanUniverse.length,
    };
  }

  // ── STAGE 1 — float enrichment for the top of the ranking ──────────────────
  const floatTargets = candidates.slice(0, CFG.DISCOVERY.FLOAT_ENRICHMENT_CAP).map(c => c.ticker);
  const floatRes = await enrichFloatData(floatTargets, { now, cap: CFG.DISCOVERY.FLOAT_ENRICHMENT_CAP, deadline: deadline * 0.5, t0 });
  diagnostics.stages.float = floatRes.coverage;

  // ── STAGE 2 — intraday bars for the enrichment budget ──────────────────────
  // Re-rank with float in hand so a genuine low-float name is not left out of the bar budget
  // because it ranked 70th on the quote snapshot alone.
  const withFloat = candidates.map(c => {
    const f = floatRes.byTicker[c.ticker] || null;
    const usable = !!(f && f.usable && f.floatShares > 0);
    const turnover = usable && Number.isFinite(c.currentSessionVolume) ? c.currentSessionVolume / f.floatShares : null;
    return {
      ...c,
      floatShares: f ? f.floatShares : null,
      floatTier: f ? f.floatTier : 'UNKNOWN',
      floatConfidence: f ? f.floatConfidence : 'LOW',
      floatUsable: usable,
      sharesOutstanding: f ? f.sharesOutstanding : null,
      floatPctOfOutstanding: f ? f.floatPctOfOutstanding : null,
      floatTurnover: turnover != null ? +turnover.toFixed(4) : c.floatTurnover,
      enrichmentPriority: c.discoveryPriority + (usable ? Math.min(30, (turnover || 0) * 20) : 0),
    };
  }).sort((a, b) => b.enrichmentPriority - a.enrichmentPriority);

  const barTargets = withFloat.slice(0, CFG.DISCOVERY.INTRADAY_ENRICHMENT_CAP);
  const barsRes = flags.ENABLE_INTRADAY_CONTINUATION
    ? await fetchIntradayBatch(barTargets.map(c => c.ticker), {
      now, sessionDate: session.etDate, t0, deadline: deadline * 0.85, cap: CFG.DISCOVERY.INTRADAY_ENRICHMENT_CAP,
    })
    : { byTicker: {}, coverage: { requested: 0, enriched: 0, failed: 0, deadlineSkipped: 0, note: 'intraday continuation disabled by flag' } };
  diagnostics.stages.intraday = barsRes.coverage;

  // ── Catalyst + supply-risk enrichment for the narrow displayed set ─────────
  // Bounded hard: these are per-symbol news calls and they run for the top few only, AFTER
  // structure is known, so they can never consume the budget the structure analysis needs.
  const newsTargets = barTargets.slice(0, CFG.DISCOVERY.NEWS_ENRICHMENT_CAP).map(c => c.ticker);
  const catalystByTicker = {}, supplyByTicker = {};
  const newsRes = await mapBounded(newsTargets, 4, async t => {
    const [cat, sup] = await Promise.all([
      fetchCatalystContext(t, { now, sessionOpenIso: session.sessionOpenIso }).catch(() => null),
      fetchSupplyRisk(t, { now, floatPctOfOutstanding: (floatRes.byTicker[t] || {}).floatPctOfOutstanding }).catch(() => null),
    ]);
    if (cat) catalystByTicker[t] = cat;
    if (sup) supplyByTicker[t] = sup;
    return true;
  }, { t0, deadline: deadline * 0.95 });
  diagnostics.stages.catalyst = {
    requested: newsTargets.length,
    enriched: Object.keys(catalystByTicker).length,
    skipped: newsRes.skipped,
    supplyAssessed: Object.keys(supplyByTicker).length,
  };

  // Feed this cycle's catalyst answers back into the cache so the NEXT cycle's discovery pass
  // (Stage 0b, above) can see them. Only present catalysts are worth carrying forward — caching
  // "no catalyst" would just make a temporary gap look permanent.
  if (hasStore()) {
    const fresh = Object.entries(catalystByTicker).filter(([, rec]) => rec && rec.catalystPresent);
    if (fresh.length) {
      try {
        const store = require('./lowfloat-store');
        const merged = { ...((cachedCatalyst && cachedCatalyst.byTicker) || {}) };
        for (const [t, rec] of fresh) merged[t] = rec;
        await store.writeCatalystCache({ schema: CFG.CATALYST_VERSION, updatedAt: new Date().toISOString(), byTicker: merged });
      } catch { /* cache write is best-effort */ }
    }
  }

  // ── STAGE 2/3 — structure, scoring, actionability (all pure) ───────────────
  const records = [];
  for (const c of withFloat) {
    const bar = barsRes.byTicker[c.ticker] || null;
    const analyzed = !!(bar && bar.ok && bar.completed && bar.completed.length);
    const stale = !analyzed || (bar.freshness && bar.freshness.stale === true);
    const prior = priorRecords[c.ticker] || null;

    const structure = analyzed
      ? analyzeIntradayContinuation(bar.completed, {
        now, formingBar: bar.forming, stale,
        dayChangePct: c.dayChangePct,
        temporalResolutionRisk: bar.temporalResolutionRisk,
        priorState: prior ? prior.structureState : null,
        priorConstructiveStreak: prior ? prior.constructiveStreak || 0 : 0,
      })
      : null;

    const catalyst = catalystByTicker[c.ticker] || unevaluatedCatalyst(c.ticker);
    const supplyRisk = supplyByTicker[c.ticker] || unknownSupplyRisk(c.ticker);

    const ignitionCtx = {
      now, floatTier: c.floatTier, floatConfidence: c.floatConfidence,
      catalyst, supplyRisk, regime, stale,
      structure, barAgeMinutes: bar && bar.freshness ? bar.freshness.barAgeMinutes : null,
      quoteAgeMs: c.dataAgeMs, temporalResolutionRisk: bar ? bar.temporalResolutionRisk : true,
      volumeClimax: structure ? structure.exhaustionScore >= 70 : false,
    };
    const ignition = analyzeLowFloatIgnition({
      ticker: c.ticker, price: c.price, prevClose: c.prevClose,
      sessionVolume: c.currentSessionVolume, sessionDollarVolume: c.currentSessionDollarVolume,
      floatShares: c.floatShares, floatUsable: c.floatUsable, sharesOutstanding: c.sharesOutstanding,
      bars: analyzed ? bar.completed : null,
      minutesSinceOpen: session.minutesSinceOpen, relativeVolume: c.relativeVolume,
      dayChangePct: c.dayChangePct, fiveMinChange: c.fiveMinChange,
      fifteenMinChange: c.fifteenMinChange, thirtyMinChange: c.thirtyMinChange,
      volumeAcceleration: c.volumeAcceleration, firstDetectedAt: c.firstDetectedAt,
    }, ignitionCtx);

    const actionCtx = {
      price: c.price, sessionDollarVolume: c.currentSessionDollarVolume,
      barAgeMinutes: bar && bar.freshness ? bar.freshness.barAgeMinutes : null,
      stale, priorSessionData: !analyzed && !!bar,
      floatTier: c.floatTier, floatConfidence: c.floatConfidence, floatUsable: c.floatUsable,
      floatTurnover: c.floatTurnover, catalyst, supplyRisk, regime,
      dayChangePct: c.dayChangePct,
      temporalResolutionRisk: bar ? bar.temporalResolutionRisk : true,
      spreadConfirmed: spreadConfirmations[c.ticker] === true,
      spreadObserved: false,     // this app has no NBBO — stated, never assumed
      morningLeader: prior ? prior.morningLeader === true : false,
      heldMiddayVwap: prior ? prior.heldMiddayVwap : null,
      volumeReaccelerating: structure ? (structure.volumeAcceleration || 0) >= 1.5 : false,
      currentConfigVersion: CFG.CONFIG_VERSION,
      templatePromotion: null,   // filled below once the template is known
      promotionConfigVersion: null,
      flags,
    };
    // Two-pass: the template is chosen by the structure, then its promotion status is looked
    // up and the decision re-run so promotion genuinely gates the state.
    const firstPass = evaluateActionability(structure || staleAnalysis(c), actionCtx);
    const promo = firstPass.entryTemplate ? (promotionByTemplate[firstPass.entryTemplate] || null) : null;
    const action = promo
      ? evaluateActionability(structure || staleAnalysis(c), {
        ...actionCtx,
        templatePromotion: promo.promotionState,
        promotionConfigVersion: promo.configurationVersion,
      })
      : firstPass;

    records.push({
      ...ignition,
      // Stage-0 provenance travels all the way through — the audit needs to know which lane
      // found this name and when.
      discoverySources: c.discoverySources,
      discoveryRank: c.discoveryRank,
      discoveryPriority: c.discoveryPriority,
      firstDetectedAt: c.firstDetectedAt,
      priceAtFirstDetection: c.priceAtFirstDetection,
      dayChangeAtFirstDetection: c.dayChangeAtFirstDetection,
      company: (securities.find(s => s.symbol === c.ticker) || {}).company || null,
      sector: (securities.find(s => s.symbol === c.ticker) || {}).sector || null,
      marketCap: (securities.find(s => s.symbol === c.ticker) || {}).marketCap || null,
      floatTier: c.floatTier,
      floatConfidence: c.floatConfidence,
      floatPctOfOutstanding: c.floatPctOfOutstanding,
      floatTurnover: c.floatTurnover,
      relativeVolume: c.relativeVolume,
      // Stage 2
      structureState: structure ? structure.structureState : STRUCTURE_STATES.STALE_DATA,
      constructiveStreak: structure ? structure.constructiveStreak : 0,
      continuationScore: structure ? structure.continuationScore : null,
      remainingEdgeScore: structure ? structure.remainingEdgeScore : null,
      exhaustionScore: structure ? structure.exhaustionScore : null,
      sessionVwap: structure ? structure.sessionVwap : null,
      ema9: structure ? structure.ema9 : null,
      ema21: structure ? structure.ema21 : null,
      distanceFromHighPct: structure ? structure.distanceFromHighPct : null,
      // Stage 3
      actionState: action.actionState,
      entryTemplate: action.entryTemplate,
      setupEntryClassification: action.setupEntryClassification,
      entryQualityScore: action.entryQualityScore,
      entryAllowed: action.entryAllowed,
      trigger: action.trigger,
      entryZoneLow: action.entryZoneLow,
      entryZoneHigh: action.entryZoneHigh,
      maximumChasePrice: action.maximumChasePrice,
      invalidation: action.invalidation,
      target1: action.target1,
      target2: action.target2,
      riskReward: action.riskReward,
      checklist: action.checklist,
      blockingReasons: [...new Set([...(ignition.blockingReasons || []), ...action.blockingReasons])],
      cautionReasons: action.cautionReasons,
      manualSpreadCheckRequired: action.manualSpreadCheckRequired,
      spreadConfirmed: action.spreadConfirmed,
      whatMustHappenNext: action.whatMustHappenNext,
      recommendedActionText: action.recommendedActionText,
      templatePromotionState: promo ? promo.promotionState : 'UNVALIDATED',
      // Provenance
      dataTimestamp: c.dataTimestamp,
      lastCompletedBarAt: bar && bar.freshness ? bar.freshness.lastCompletedBarAt : null,
      barResolutionMinutes: bar ? bar.barResolutionMinutes : null,
      temporalResolutionRisk: bar ? bar.temporalResolutionRisk : true,
      stale,
      analyzed,
      configurationVersion: CFG.CONFIG_VERSION,
    });
  }

  const sorted = sortIgnitionRecords(records);
  diagnostics.stages.scoring = {
    candidatesRanked: sorted.length,
    analyzedWithBars: sorted.filter(r => r.analyzed).length,
    staleCandidates: sorted.filter(r => r.stale).length,
    paperEligible: sorted.filter(r => r.actionState === ACTION_STATES.PAPER_ENTRY_ELIGIBLE).length,
    liveValidated: sorted.filter(r => r.actionState === ACTION_STATES.LIVE_VALIDATED_ENTRY).length,
  };

  return {
    ok: true,
    session,
    records: sorted,
    diagnostics,
    flags,
    nextDiscoveryState: { sessionDate: session.etDate, state: discovery.nextState, updatedAt: new Date(now).toISOString() },
    allDiscovered: discovery.allCandidates || [],
    elapsedMs: Date.now() - t0,
    partialResults: !!(diagnostics.stages.intraday.deadlineSkipped || newsRes.skipped),
  };
}

// A minimal analysis object for a candidate with no usable bars, so the actionability layer
// still returns a fully-formed (blocked) decision rather than being skipped.
function staleAnalysis(c) {
  return {
    structureState: STRUCTURE_STATES.STALE_DATA,
    price: c.price, trigger: null, invalidation: null, target1: null, target2: null,
    riskReward: null, stopDistancePct: null, minutesUntilClose: null,
    vwapExtensionAtr: null, vwapDistancePct: null, remainingEdgeScore: 0,
    upperWickRisk: null, lowerHighCount: null, aboveVwap: null, atr5m: null,
    sessionWindow: null, features: {},
  };
}

async function saveDiscoveryState(next) {
  if (!hasStore() || !next) return { saved: false, reason: 'no store' };
  try { await writeJSON(DISCOVERY_STATE_KEY, next, 0); return { saved: true }; }
  catch (e) { return { saved: false, reason: String((e && e.message) || e) }; }
}

module.exports = { runPipeline, saveDiscoveryState, mapBounded, DISCOVERY_STATE_KEY, staleAnalysis };

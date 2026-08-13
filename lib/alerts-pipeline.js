'use strict';
// ALERTS PIPELINE — composes the pure modules into the two flows the route drives.
//
//  buildLeads()      ingest-time: records → clustered, lifecycle-parsed thesis leads (no market
//                    data). Fed into episode folding.
//  buildDecisions()  cron-time: active episodes + market data → scored four-view decisions.
//
// Kept separate from the route so the composition is unit-testable without Blob/network.

const { clusterPosts, postKey, saturatingConfirmation } = require('./alerts-coordination');
const { parsePost } = require('./alerts-lifecycle');
const { skillFor } = require('./alerts-skill');
const { independentClusterCount, ROLES } = require('./alerts-episodes');
const { evaluateSetup } = require('./stock-setup');
const { verifyCatalyst } = require('./alerts-catalyst');
const { scoreEpisode, bucketViews } = require('./alerts-score');
const { assessExecution } = require('./alerts-execution');
const { assessRegimeFit } = require('./alerts-regime');
const { assessFreshness } = require('./alerts-freshness');
const { capturePriceAtAlert, readPriceAtAlert } = require('./alerts-price-at-alert');

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

/**
 * Ingest-time: turn immutable v2 records into thesis leads (deterministic, no market data).
 * Clusters for coordination, parses lifecycle per ticker, stamps the current skill weight.
 *
 * P0: when the caller supplies alert-time quotes (`quoteByTicker` + `quoteSource` +
 * `sessionInfo`), each lead carries an IMMUTABLE price-at-alert record with the provider
 * quote timestamp, market session, and source. No quote ⇒ an explicit UNAVAILABLE record;
 * nothing is ever stamped with server time or backfilled later.
 */
function buildLeads(records, { skillModel = null, quoteByTicker = null, quoteSource = null, sessionInfo = null, now = Date.now() } = {}) {
  const list = (records || []).filter(r => r && r.text);
  const { clusters, byKey } = clusterPosts(list);
  const clusterById = new Map(clusters.map(c => [c.id, c]));
  const leads = [];
  for (const r of list) {
    const parsed = parsePost(r.text);
    const cid = byKey.get(postKey(r));
    const cluster = clusterById.get(cid);
    const coordinated = !!(cluster && cluster.coordinated);
    const skillW = r.identityKnown ? skillFor(skillModel, r.accountKey).skillWeight : 0;
    for (const pt of parsed.perTicker) {
      const priceAtAlert = capturePriceAtAlert({
        ticker: pt.ticker,
        quote: quoteByTicker ? (quoteByTicker.get ? quoteByTicker.get(pt.ticker) : quoteByTicker[pt.ticker]) : null,
        source: quoteSource, sessionInfo, now,
      });
      leads.push({
        priceAtAlert,
        // `execRef` stays populated for the existing grader contract, but ONLY from a
        // genuinely captured quote — never from an unverifiable one.
        execRef: priceAtAlert.state === 'CAPTURED' ? priceAtAlert.price : null,
        ticker: pt.ticker, side: pt.direction, event: pt.event, isNewThesis: pt.isNewThesis,
        sourceKey: r.accountKey, handle: r.handle, identityKnown: r.identityKnown,
        publishedAt: r.publishedAt, collectedAt: r.collectedAt,
        clusterId: cid, coordinated,
        catalysts: parsed.catalysts, levels: parsed.levels, horizon: parsed.timeframe,
        setupClass: parsed.catalysts[0] || (parsed.option ? 'options' : 'momentum'),
        skillWeight: skillW, provenanceQuality: r.provenanceQuality,
        text: r.text,
      });
    }
  }
  return { leads, clusters };
}

// Correlation-adjusted social confirmation for an episode: distinct NON-coordinated clusters,
// each contributing at its discoverer/confirmer's skill weight, through the saturating accumulator.
function socialConfirmation(episode, skillModel) {
  const contribs = [];
  const seen = new Set();
  for (const c of episode.contributors || []) {
    if (c.role === ROLES.ECHO) continue;                 // echoes already collapsed
    const cid = c.clusterId || c.sourceKey;
    if (seen.has(cid)) continue; seen.add(cid);
    const w = c.sourceKey ? skillFor(skillModel, c.sourceKey).skillWeight : 0;
    contribs.push({ skillWeight: w, coordinated: c.role === ROLES.COORDINATED || episode.coordinatedSeen });
  }
  const sat = saturatingConfirmation(contribs, { includeCoordinated: false });
  return {
    confirmation: sat.confirmation,
    clustersCounted: sat.clustersCounted,
    independentClusters: independentClusterCount(episode),
    coordinated: !!episode.coordinatedSeen,
  };
}

// Simple, deterministic dollar-liquidity read from candles (no new feed). Floor: $3M ADV.
function liquidityOk(candles, floor = 3e6) {
  if (!Array.isArray(candles) || candles.length < 20) return null;
  const recent = candles.slice(-20);
  const adv = mean(recent.map(c => (c.close || 0) * (c.volume || 0)));
  return adv >= floor;
}

/**
 * Cron-time: score active episodes into the four coordinated views using market data.
 * @param {Array} activeEpisodes  open episodes
 * @param {object} ctx { candlesByTicker:Map, spy, sectorByTicker:Map, skillModel, regime,
 *                        earningsByTicker:Map, semanticById:object }
 */
function buildDecisions(activeEpisodes, ctx = {}) {
  const {
    candlesByTicker = new Map(), skillModel = null, regime = {}, earningsByTicker = new Map(),
    semanticById = {}, sectorByTicker = new Map(), spreadBpsByTicker = new Map(),
    borrowByTicker = new Map(), riskBudgetUsd = null, now = Date.now(),
  } = ctx;
  const decisions = [];
  for (const ep of activeEpisodes || []) {
    const candles = candlesByTicker.get(ep.ticker);
    const setup = candles ? evaluateSetup(candles) : { direction: 'none', valid: false, quality: 0 };
    const skill = ep.firstSourceKey ? skillFor(skillModel, ep.firstSourceKey) : { state: 'UNKNOWN', skillWeight: 0, accountPoints: 0, n: 0, weightReason: 'Unknown source — no track-record bonus.' };
    const earnings = earningsByTicker.get(ep.ticker) || null;
    const catalyst = verifyCatalyst(
      { catalysts: ep.catalysts || [], ticker: ep.ticker, asOfDate: ep.firstSeenDate },
      { earnings },
    );
    const social = socialConfirmation(ep, skillModel);
    const priceNow = setup.spot != null ? setup.spot : (candles && candles.length ? candles[candles.length - 1].close : null);
    // The decision price has its own clock: the date of the last daily bar it came from.
    const priceAsOf = candles && candles.length ? candles[candles.length - 1].date || null : null;

    const priceAtAlert = readPriceAtAlert(ep);
    const freshness = assessFreshness({
      firstSeenAt: ep.firstSeen || ep.firstSeenDate || null,
      lastSeenAt: ep.lastSeen || ep.lastSeenDate || null,
      priceAsOf, horizon: ep.intendedHorizon || null, now,
    });
    const execution = assessExecution({
      side: ep.side,
      candles,
      spreadBps: spreadBpsByTicker.get(ep.ticker) ?? null,
      orderNotionalUsd: riskBudgetUsd,
      borrow: borrowByTicker.get(ep.ticker) || null,
      earnings,
      asOfDate: ep.lastSeenDate || ep.firstSeenDate || null,
      // Keep the older ADV verdict as a fallback source of liquidity evidence, but only
      // when it is a genuine boolean — `null` means "unmeasured" and must stay unmeasured.
      liquidityVerdict: liquidityOk(candles),
    });
    const regimeFit = assessRegimeFit({ market: regime, sector: sectorByTicker.get(ep.ticker) || null, side: ep.side });

    // Execution/regime/freshness are supplied as records, so `market` only carries price.
    const market = { priceNow };
    const decision = scoreEpisode(ep, {
      setup, skill, catalyst, social, market, regime,
      priceAtAlert, freshness, execution, regimeFit, candles, earnings, now,
    });
    decisions.push({
      ...decision,
      firstSeenDate: ep.firstSeenDate,
      lastSeenDate: ep.lastSeenDate,
      intendedHorizon: ep.intendedHorizon,
      horizonAssumed: ep.horizonAssumed,
      catalysts: ep.catalysts || [],
      statedLevels: ep.statedLevels || null,
      distinctClusters: ep.distinctClusters || 0,
      appearances: ep.appearances || 1,
      status: ep.status,
      handle: ep.contributors && ep.contributors[0] ? ep.contributors[0].handle : null,
      priceNow, priceAsOf,
      // Back-compat scalars for older readers; the authoritative records are the objects
      // `priceAtAlert` / `moveSinceAlert` already on the decision.
      moveSinceAlertPct: decision.moveSinceAlert.available ? decision.moveSinceAlert.movePct : null,
      accountRecord: { state: skill.state, n: skill.n || 0, ci90: skill.ci90 || null, weightReason: skill.weightReason || null },
      semantic: semanticById[ep.id] || null,
      sampleText: ep.contributors && ep.contributors[0] ? null : null,
    });
  }
  return { decisions, views: bucketViews(decisions) };
}

module.exports = { buildLeads, socialConfirmation, liquidityOk, buildDecisions };

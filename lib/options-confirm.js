'use strict';
// OPTIONS CONFIRMATION ENGINE — judge options evidence AGAINST an independent stock setup.
//
// The options-flow layer is shadow: it may CONFIRM a valid price setup, CONTRADICT it, or
// flag it as AMBIGUOUS/RISKY — it can never originate a trade. This module produces one
// deterministic decision record per ticker, joining the chart-math setup (lib/stock-setup)
// with the honest options read (directionState, OI confirmation, event risk, liquidity).
//
// Every price LEVEL in the record comes from the setup (chart math), NEVER from options or
// an LLM. The final action is REVIEW / WAIT / AVOID. Pure + testable.

// Does the options lean agree with the setup direction?
function agreement(setupDir, directionState) {
  const bull = directionState === 'PROVISIONAL_BULLISH';
  const bear = directionState === 'PROVISIONAL_BEARISH';
  if (directionState === 'MIXED') return 'mixed';
  if (directionState === 'DIRECTION_UNKNOWN' || (!bull && !bear)) return 'unknown';
  if (setupDir === 'long') return bull ? 'confirms' : 'contradicts';
  if (setupDir === 'short') return bear ? 'confirms' : 'contradicts';
  return 'unknown';
}

// Evidence quality from the honest signals: reliable provisional direction + OI confirmation
// + low unknown share = clear; suspected spreads / mostly-unknown = thin.
function evidenceQuality(flow) {
  const unknownShare = flow.unknownShare != null ? flow.unknownShare : 1;
  const multiLeg = flow.suspectedMultiLeg || 0;
  const provisional = flow.directionState === 'PROVISIONAL_BULLISH' || flow.directionState === 'PROVISIONAL_BEARISH';
  const oiConfirmed = (flow.oiConfirmedContracts || 0) > 0;
  if (multiLeg >= 2 || unknownShare > 0.7) return 'thin';
  if (provisional && unknownShare < 0.4 && oiConfirmed) return 'clear';
  if (provisional && unknownShare < 0.55) return 'mixed';
  return 'thin';
}

// Evidence tier (research maturity is ALWAYS shadow — the layer is weight 0).
function evidenceTier(agree, quality) {
  if (agree === 'confirms' && quality === 'clear') return 'confirmed-shadow';
  if (agree === 'confirms') return 'provisional';
  if (agree === 'contradicts') return 'contradiction';
  return 'informational';
}

const CONFIRM_QUALITY = new Set(['clear', 'mixed']);

// Build the deterministic decision record for one ticker.
//   setup = evaluateSetup(candles); flow = a byTicker rollup row (directionState, unknownShare,
//   oiConfirmedContracts, earningsBeforeExpiry, suspectedMultiLeg, isIndex, ...).
function buildDecision(setup, flow) {
  setup = setup || { direction: 'none', valid: false };
  flow = flow || {};
  const agree = agreement(setup.direction, flow.directionState);
  const quality = evidenceQuality(flow);
  const eventRisk = flow.earningsBeforeExpiry ? 'earnings-before-expiry' : 'none';
  const isIndex = !!flow.isIndex;
  const reasons = [];

  let action, view;
  if (!setup.valid) {
    // No independent setup to confirm — this is raw activity only, never a REVIEW.
    action = 'WAIT'; view = 'neutral';
    reasons.push('No valid stock setup — options activity shown as raw evidence only, not a confirmation.');
  } else if (isIndex) {
    action = 'AVOID'; view = 'contradiction';
    reasons.push('Index/ETF flow is usually hedging — ambiguous for a single-name thesis.');
  } else if (agree === 'contradicts') {
    action = 'AVOID'; view = 'contradiction';
    reasons.push(`Options lean ${flow.directionLabel || flow.directionState} conflicts with the ${setup.direction} price setup.`);
  } else if (agree === 'confirms' && CONFIRM_QUALITY.has(quality) && !(eventRisk !== 'none' && quality !== 'clear')) {
    action = 'REVIEW'; view = 'confirmation';
    reasons.push(`Options ${flow.directionLabel || 'lean'} supports the ${setup.direction} setup (evidence ${quality}${(flow.oiConfirmedContracts || 0) > 0 ? ', OI building' : ''}).`);
    if (eventRisk !== 'none') reasons.push('Earnings before the options expiry — size for event risk.');
  } else if (eventRisk !== 'none') {
    action = 'AVOID'; view = 'contradiction';
    reasons.push('Earnings before expiry with unclear evidence — binary event risk outweighs the read.');
  } else {
    action = 'WAIT'; view = 'neutral';
    reasons.push(agree === 'mixed'
      ? 'Options are two-sided (mixed) — no clear confirmation of the setup yet.'
      : 'Options direction is unknown on delayed data — wait for clearer evidence or a price trigger.');
  }

  return {
    ticker: flow.ticker || null,
    action,                          // REVIEW | WAIT | AVOID
    view,                            // confirmation | contradiction | neutral (Raw shows all)
    // stock setup (independent)
    setupDirection: setup.direction,
    setupValid: !!setup.valid,
    setupQuality: setup.quality != null ? setup.quality : null,
    // options read (honest)
    optionsDirection: flow.directionState || 'DIRECTION_UNKNOWN',
    optionsDirectionLabel: flow.directionLabel || 'Direction unknown',
    confirmationState: agree,        // confirms | contradicts | mixed | unknown
    evidenceQuality: quality,        // clear | mixed | thin
    evidenceTier: evidenceTier(agree, quality),
    horizonAlignment: flow.dteBucket || null,
    eventRisk,
    liquidityQuality: isIndex ? 'index-hedge' : 'ok',
    dataQuality: 'delayed',          // free chains are always delayed
    oiConfirmedContracts: flow.oiConfirmedContracts || 0,
    // DETERMINISTIC levels (chart math only — never options/LLM)
    trigger: setup.trigger ?? null,
    invalidation: setup.invalidation ?? null,
    target: setup.target ?? null,
    support: setup.support ?? null,
    resistance: setup.resistance ?? null,
    rr: setup.rr ?? null,
    spot: setup.spot ?? flow.underlying ?? null,
    researchMaturity: 'shadow',      // the whole layer is weight 0
    reasons,
  };
}

// Bucket a set of decisions into the four coordinated views. Confirmations and
// Contradictions are the interpreted lenses; Raw Activity is every ticker (transparent).
function bucketViews(decisions) {
  const list = decisions || [];
  return {
    confirmations: list.filter(d => d.view === 'confirmation'),
    contradictions: list.filter(d => d.view === 'contradiction'),
    raw: list,   // Raw Activity shows all underlying activity with no interpretation filter
  };
}

module.exports = { agreement, evidenceQuality, evidenceTier, buildDecision, bucketViews };

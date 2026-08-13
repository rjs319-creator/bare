'use strict';
// 📡 MARKET PULSE v2 — THREE-LAYER REGIME STACK.
//
// One number cannot describe a market that is chopping intraday, thrusting on a 1–4 week
// horizon, and decelerating on a 1–6 month horizon at the same time. Compressing those
// into a single "regime" is how a swing trader ends up fighting the tape they are actually
// trading. This module keeps the three horizons SEPARATE and never averages them.
//
// Each layer reports:
//   state · previousState · transitionAt · persistence · supporting · contradicting ·
//   whatWouldFlipIt · coverage
//
// Rules enforced here:
//   • A layer with insufficient inputs is UNAVAILABLE with a reason. It is never "neutral".
//   • Contradicting observations are KEPT, not netted out of the supporting ones.
//   • `whatWouldFlipIt` is a falsifiable, observable condition — the layer states in
//     advance what would change its mind.
//   • Persistence is measured from the persisted previous stack, never asserted.
//
// Pure: every input is pre-fetched and injected. No I/O, no LLM.

const STACK_VERSION = 'pulse2-regime-stack-v1';

const LAYERS = Object.freeze(['intraday', 'tactical', 'strategic']);

const INTRADAY_STATES = Object.freeze(['TRENDING_UP', 'TRENDING_DOWN', 'CHOPPY', 'VOLATILITY_EXPANSION', 'UNAVAILABLE']);
const TACTICAL_STATES = Object.freeze(['BROADENING', 'NARROWING', 'RISK_SEEKING', 'RISK_AVERSE', 'MIXED', 'UNAVAILABLE']);
const STRATEGIC_STATES = Object.freeze(['EXPANSION', 'SLOWDOWN', 'CONTRACTION', 'RECOVERY', 'MIXED', 'UNAVAILABLE']);

const round = (n, d = 2) => (n == null || !Number.isFinite(n) ? null : +n.toFixed(d));
const isNum = v => v != null && Number.isFinite(v);

// One observation, with the value that produced it, so a reader can audit the claim.
const obs = (text, value = null, source = null) => ({ text, value, source });

/**
 * Shape a layer result. `supporting` and `contradicting` are kept separate on purpose —
 * this is the "preserve disagreement" rule applied to market state itself.
 */
function layer({ name, state, supporting = [], contradicting = [], whatWouldFlipIt = [], inputsSeen = 0, inputsPossible = 1, unavailableReason = null, prev = null, now = null }) {
  const prevState = prev && prev.state ? prev.state : null;
  const changed = !!(prevState && prevState !== state);
  // Persistence: how long this state has held. Carried forward when unchanged, reset on a
  // genuine transition. Measured, never asserted.
  const persistence = changed || !prev
    ? { sinceISO: now, observations: 1 }
    : { sinceISO: (prev.persistence && prev.persistence.sinceISO) || now, observations: ((prev.persistence && prev.persistence.observations) || 0) + 1 };

  return {
    name,
    state,
    available: state !== 'UNAVAILABLE',
    unavailableReason: state === 'UNAVAILABLE' ? (unavailableReason || 'insufficient inputs') : null,
    previousState: prevState,
    changed,
    transitionAt: changed ? now : (prev && prev.transitionAt) || null,
    persistence,
    supporting,
    contradicting,
    // Disagreement is surfaced, not netted: a layer can be TRENDING_UP and still carry
    // three contradicting observations, and the reader should see both.
    contested: contradicting.length > 0,
    whatWouldFlipIt,
    coverage: { seen: inputsSeen, possible: inputsPossible, fraction: inputsPossible ? round(inputsSeen / inputsPossible, 2) : 0 },
  };
}

// ── Layer 1: INTRADAY — trend/chop, breadth, VWAP participation, RV expansion ──

function intradayLayer({ marketState = null, prev = null, now = null } = {}) {
  const s = marketState || {};
  const idx = s.indexes || {};
  const spy = idx.SPY || {}, qqq = idx.QQQ || {}, iwm = idx.IWM || {}, rsp = idx.RSP || {};
  const supporting = [], contradicting = [], flip = [];

  let seen = 0;
  const possible = 5;   // SPY, QQQ, VWAP participation, range expansion, breadth

  if (!spy.available || spy.dayReturnPct == null) {
    return layer({ name: 'intraday', state: 'UNAVAILABLE', unavailableReason: 'no SPY intraday or daily bar — the intraday layer has no anchor', inputsSeen: 0, inputsPossible: possible, prev, now });
  }
  seen++;
  if (qqq.available && qqq.dayReturnPct != null) seen++;

  const spyRet = spy.dayReturnPct;
  const qqqRet = qqq.available ? qqq.dayReturnPct : null;

  // VWAP participation: how many measured instruments are on the same side of VWAP.
  const vwapReads = [spy, qqq, iwm, rsp].filter(x => x.available && x.aboveVWAP != null);
  const aboveCount = vwapReads.filter(x => x.aboveVWAP).length;
  const vwapParticipation = vwapReads.length ? round(aboveCount / vwapReads.length, 2) : null;
  if (vwapReads.length) seen++;

  // Realized-volatility expansion from the measured intraday range expansion.
  const expansions = [spy, qqq, iwm].filter(x => x.available && isNum(x.rangeExpansion)).map(x => x.rangeExpansion);
  const meanExpansion = expansions.length ? round(expansions.reduce((a, b) => a + b, 0) / expansions.length, 2) : null;
  if (expansions.length) seen++;

  const breadth = s.breadth && s.breadth.available ? s.breadth : null;
  if (breadth && isNum(breadth.pctAbove50dma)) seen++;

  let state;
  const trendUp = spyRet >= 0.5 && (qqqRet == null || qqqRet > 0) && (vwapParticipation == null || vwapParticipation >= 0.6);
  const trendDown = spyRet <= -0.5 && (qqqRet == null || qqqRet < 0) && (vwapParticipation == null || vwapParticipation <= 0.4);
  const volExpanding = isNum(meanExpansion) && meanExpansion >= 1.5;

  if (volExpanding && Math.abs(spyRet) < 0.5) {
    state = 'VOLATILITY_EXPANSION';
    supporting.push(obs(`Intraday range is ${meanExpansion}× the recent norm with no directional resolution`, meanExpansion, 'intraday-features'));
  } else if (trendUp) {
    state = 'TRENDING_UP';
    supporting.push(obs(`SPY ${spyRet >= 0 ? '+' : ''}${spyRet}% on the session`, spyRet, 'intraday'));
    if (vwapParticipation != null) supporting.push(obs(`${aboveCount}/${vwapReads.length} tracked indexes above VWAP`, vwapParticipation, 'intraday-features'));
  } else if (trendDown) {
    state = 'TRENDING_DOWN';
    supporting.push(obs(`SPY ${spyRet}% on the session`, spyRet, 'intraday'));
    if (vwapParticipation != null) supporting.push(obs(`${vwapReads.length - aboveCount}/${vwapReads.length} tracked indexes below VWAP`, vwapParticipation, 'intraday-features'));
  } else {
    state = 'CHOPPY';
    supporting.push(obs(`SPY ${spyRet >= 0 ? '+' : ''}${spyRet}% — no directional resolution`, spyRet, 'intraday'));
  }

  // Contradictions are collected regardless of the state chosen.
  if (state === 'TRENDING_UP') {
    if (iwm.available && isNum(iwm.dayReturnPct) && iwm.dayReturnPct < 0) contradicting.push(obs(`Small caps (IWM) ${iwm.dayReturnPct}% are NOT participating`, iwm.dayReturnPct, 'intraday'));
    if (rsp.available && isNum(rsp.dayReturnPct) && rsp.dayReturnPct < spyRet - 0.2) contradicting.push(obs(`Equal-weight (RSP) is lagging cap-weight by ${round(spyRet - rsp.dayReturnPct)}pp — narrow`, round(spyRet - rsp.dayReturnPct), 'intraday'));
    if (breadth && isNum(breadth.pctAbove50dma) && breadth.pctAbove50dma < 45) contradicting.push(obs(`Only ${breadth.pctAbove50dma}% of the universe is above its 50DMA`, breadth.pctAbove50dma, 'breadth'));
  }
  if (state === 'TRENDING_DOWN') {
    if (breadth && isNum(breadth.pctAbove50dma) && breadth.pctAbove50dma > 55) contradicting.push(obs(`Breadth is still healthy (${breadth.pctAbove50dma}% above 50DMA) despite the index decline`, breadth.pctAbove50dma, 'breadth'));
    if (iwm.available && isNum(iwm.dayReturnPct) && iwm.dayReturnPct > 0) contradicting.push(obs(`Small caps (IWM) ${iwm.dayReturnPct > 0 ? '+' : ''}${iwm.dayReturnPct}% are holding up`, iwm.dayReturnPct, 'intraday'));
  }
  if (state === 'CHOPPY' && isNum(s.participation && s.participation.equalVsCapPct) && Math.abs(s.participation.equalVsCapPct) > 0.5) {
    contradicting.push(obs(`Index is flat but equal-vs-cap spread is ${s.participation.equalVsCapPct}pp — rotation under the surface`, s.participation.equalVsCapPct, 'participation'));
  }

  flip.push(`SPY closing beyond ${state === 'TRENDING_UP' ? 'the session VWAP to the downside' : state === 'TRENDING_DOWN' ? 'the session VWAP to the upside' : '±0.5% with matching VWAP participation'}`);
  if (isNum(meanExpansion)) flip.push(`Intraday range expansion moving through ${meanExpansion >= 1.5 ? '1.0×' : '1.5×'} the recent norm`);

  return layer({ name: 'intraday', state, supporting, contradicting, whatWouldFlipIt: flip, inputsSeen: seen, inputsPossible: possible, prev, now });
}

// ── Layer 2: TACTICAL (1–4 weeks) — breadth thrust, leadership, credit, rates, dollar, vol curve ──

function tacticalLayer({ crossAsset = null, marketState = null, sectorLeadership = null, prev = null, now = null } = {}) {
  const ca = crossAsset || {};
  const rows = ca.rows || {};
  const supporting = [], contradicting = [], flip = [];
  const possible = 6;   // breadth, leadership, credit, rates, dollar, vol curve
  let seen = 0;

  const s = marketState || {};
  const breadth = s.breadth && s.breadth.available ? s.breadth : null;
  const credit = rows.credit && rows.credit.available ? rows.credit : null;
  const rates = rows.rates2y && rows.rates2y.available ? rows.rates2y : null;
  const dollar = rows.dollar && rows.dollar.available ? rows.dollar : null;
  const volCurve = rows.volCurve && rows.volCurve.available ? rows.volCurve : null;
  const participation = s.participation || {};

  if (breadth) seen++;
  if (credit) seen++;
  if (rates) seen++;
  if (dollar) seen++;
  if (volCurve) seen++;
  if (sectorLeadership || (s.sectors && s.sectors.available)) seen++;

  if (seen < 2) {
    return layer({ name: 'tactical', state: 'UNAVAILABLE', unavailableReason: `only ${seen}/${possible} tactical inputs available — a 1–4 week read needs at least two independent legs`, inputsSeen: seen, inputsPossible: possible, prev, now });
  }

  // Risk-seeking evidence vs risk-averse evidence, counted separately (never netted).
  const riskOn = [], riskOff = [];
  if (credit) {
    (credit.changePct >= 0 ? riskOn : riskOff).push(obs(`Credit proxy ${credit.changePct >= 0 ? '+' : ''}${credit.changePct}% over the window`, credit.changePct, credit.source));
  }
  if (volCurve) {
    (volCurve.contango ? riskOn : riskOff).push(obs(volCurve.contango ? 'Volatility term structure in contango (calm forward pricing)' : 'Volatility term structure inverted (near-dated stress bid)', volCurve.slope, volCurve.source));
  }
  if (breadth && isNum(breadth.pctAbove50dma)) {
    (breadth.pctAbove50dma >= 55 ? riskOn : breadth.pctAbove50dma <= 40 ? riskOff : riskOn)
      .push(obs(`${breadth.pctAbove50dma}% of the universe above its 50DMA`, breadth.pctAbove50dma, 'breadth'));
  }
  if (isNum(participation.smallVsLargePct)) {
    (participation.smallVsLargePct >= 0 ? riskOn : riskOff).push(obs(`Small caps ${participation.smallVsLargePct >= 0 ? 'leading' : 'lagging'} large by ${Math.abs(participation.smallVsLargePct)}pp`, participation.smallVsLargePct, 'participation'));
  }
  if (dollar) {
    (dollar.changePct <= 0 ? riskOn : riskOff).push(obs(`Dollar proxy ${dollar.changePct >= 0 ? '+' : ''}${dollar.changePct}% (a stronger dollar is a headwind for risk)`, dollar.changePct, dollar.source));
  }

  // Broadening vs narrowing is a SEPARATE axis from risk appetite.
  const equalVsCap = participation.equalVsCapPct;
  const narrowing = isNum(equalVsCap) && equalVsCap <= -0.3;
  const broadening = isNum(equalVsCap) && equalVsCap >= 0.3;

  let state;
  if (narrowing && riskOn.length >= riskOff.length) state = 'NARROWING';
  else if (broadening && riskOn.length >= riskOff.length) state = 'BROADENING';
  else if (riskOff.length > riskOn.length) state = 'RISK_AVERSE';
  else if (riskOn.length > riskOff.length) state = 'RISK_SEEKING';
  else state = 'MIXED';

  const primary = (state === 'RISK_AVERSE') ? riskOff : riskOn;
  const counter = (state === 'RISK_AVERSE') ? riskOn : riskOff;
  supporting.push(...primary);
  contradicting.push(...counter);
  if (narrowing) (state === 'NARROWING' ? supporting : contradicting).push(obs(`Equal-weight trailing cap-weight by ${Math.abs(equalVsCap)}pp — leadership is narrow`, equalVsCap, 'participation'));
  if (broadening) (state === 'BROADENING' ? supporting : contradicting).push(obs(`Equal-weight leading cap-weight by ${equalVsCap}pp — leadership is broadening`, equalVsCap, 'participation'));

  flip.push('Credit proxy reversing its 20-day trend against the current read');
  flip.push('Breadth crossing 50% above the 50DMA in the opposite direction');
  if (volCurve) flip.push(`Volatility term structure flipping ${volCurve.contango ? 'into inversion' : 'back into contango'}`);

  return layer({ name: 'tactical', state, supporting, contradicting, whatWouldFlipIt: flip, inputsSeen: seen, inputsPossible: possible, prev, now });
}

// ── Layer 3: STRATEGIC (1–6 months) — growth, inflation, liquidity, revisions, valuation ──

function strategicLayer({ macroInputs = null, crossAsset = null, prev = null, now = null } = {}) {
  const m = macroInputs || {};
  const rows = (crossAsset || {}).rows || {};
  const supporting = [], contradicting = [], flip = [];
  const possible = 5;   // growth, inflation, liquidity, earnings revisions, valuation
  let seen = 0;

  const legs = {
    growth: m.growth,           // { trend: 'up'|'down'|'flat', value, source }
    inflation: m.inflation,
    liquidity: m.liquidity,
    revisions: m.earningsRevisions,
    valuation: m.valuation,
  };
  for (const v of Object.values(legs)) if (v && v.trend) seen++;

  // Curve slope is a real, measurable strategic input when the rates legs exist.
  const curve = rows.curve && rows.curve.available ? rows.curve : null;
  if (curve) seen++;

  if (seen < 2) {
    return layer({
      name: 'strategic', state: 'UNAVAILABLE',
      unavailableReason: `only ${seen}/${possible} strategic inputs available. Growth, inflation, liquidity, earnings-revision, and valuation series are NOT wired to a provider in this deployment — the 1–6 month layer is honestly unavailable rather than guessed from price.`,
      inputsSeen: seen, inputsPossible: possible, prev, now,
    });
  }

  const expansionary = [], contractionary = [];
  if (legs.growth && legs.growth.trend) (legs.growth.trend === 'up' ? expansionary : contractionary).push(obs(`Growth trend ${legs.growth.trend}`, legs.growth.value, legs.growth.source));
  if (legs.liquidity && legs.liquidity.trend) (legs.liquidity.trend === 'up' ? expansionary : contractionary).push(obs(`Liquidity trend ${legs.liquidity.trend}`, legs.liquidity.value, legs.liquidity.source));
  if (legs.revisions && legs.revisions.trend) (legs.revisions.trend === 'up' ? expansionary : contractionary).push(obs(`Earnings revisions ${legs.revisions.trend}`, legs.revisions.value, legs.revisions.source));
  if (legs.inflation && legs.inflation.trend) (legs.inflation.trend === 'down' ? expansionary : contractionary).push(obs(`Inflation trend ${legs.inflation.trend}`, legs.inflation.value, legs.inflation.source));
  if (curve) (curve.value >= 0 ? expansionary : contractionary).push(obs(`2s10s curve ${curve.value >= 0 ? 'positive' : 'inverted'} at ${curve.value}bp`, curve.value, curve.source));
  if (legs.valuation && legs.valuation.trend) (legs.valuation.trend === 'down' ? expansionary : contractionary).push(obs(`Valuation ${legs.valuation.trend}`, legs.valuation.value, legs.valuation.source));

  const growthUp = legs.growth && legs.growth.trend === 'up';
  let state;
  if (expansionary.length > contractionary.length) state = growthUp ? 'EXPANSION' : 'RECOVERY';
  else if (contractionary.length > expansionary.length) state = growthUp ? 'SLOWDOWN' : 'CONTRACTION';
  else state = 'MIXED';

  const primary = ['EXPANSION', 'RECOVERY'].includes(state) ? expansionary : contractionary;
  supporting.push(...primary);
  contradicting.push(...(primary === expansionary ? contractionary : expansionary));

  flip.push('Earnings revisions breadth turning negative for two consecutive months');
  flip.push('A sustained inversion or re-steepening of the 2s10s curve');

  return layer({ name: 'strategic', state, supporting, contradicting, whatWouldFlipIt: flip, inputsSeen: seen, inputsPossible: possible, prev, now });
}

/**
 * Build the full three-layer stack. Pure.
 *
 * @param {object} p
 * @param {object} p.marketState       lib/pulse2-market-state buildMarketState() output
 * @param {object} p.crossAsset        lib/pulse2-cross-asset buildCrossAssetMatrix() output
 * @param {object} p.macroInputs       strategic legs, if any provider supplies them
 * @param {object} p.sectorLeadership  persisted RLT leadership summary
 * @param {object} p.prevStack         the previously persisted stack (for persistence/transitions)
 * @param {Date}   p.now
 */
function buildRegimeStack({ marketState = null, crossAsset = null, macroInputs = null, sectorLeadership = null, prevStack = null, now = new Date() } = {}) {
  const nowISO = now instanceof Date ? now.toISOString() : String(now);
  const prev = prevStack && prevStack.layers ? prevStack.layers : {};

  const layers = {
    intraday: intradayLayer({ marketState, prev: prev.intraday || null, now: nowISO }),
    tactical: tacticalLayer({ crossAsset, marketState, sectorLeadership, prev: prev.tactical || null, now: nowISO }),
    strategic: strategicLayer({ macroInputs, crossAsset, prev: prev.strategic || null, now: nowISO }),
  };

  const available = LAYERS.filter(l => layers[l].available);
  // Horizons that DISAGREE are the most decision-relevant fact the stack produces, so it
  // is reported explicitly rather than resolved into one number.
  const conflicts = [];
  const iu = layers.intraday.state === 'TRENDING_UP', id = layers.intraday.state === 'TRENDING_DOWN';
  const tRiskOff = layers.tactical.state === 'RISK_AVERSE';
  const tRiskOn = layers.tactical.state === 'RISK_SEEKING' || layers.tactical.state === 'BROADENING';
  if (iu && tRiskOff) conflicts.push('Intraday is trending up while the 1–4 week read is risk-averse — an intraday long is fighting the tactical horizon.');
  if (id && tRiskOn) conflicts.push('Intraday is trending down while the 1–4 week read is risk-seeking — a short here is fighting the tactical horizon.');
  if (layers.tactical.state === 'NARROWING' && layers.strategic.state === 'EXPANSION') conflicts.push('Narrowing tactical leadership inside a strategic expansion — a late-cycle pattern, not a confirmation.');

  return {
    schema: STACK_VERSION,
    asOf: nowISO,
    layers,
    layerOrder: LAYERS,
    // NOT a composite score. There is deliberately no single "regime number" here.
    compositeScore: null,
    compositeNote: 'The three horizons are reported separately by design. There is no composite regime score: compressing them hides exactly the horizon conflict an expert needs to see.',
    horizonConflicts: conflicts,
    contested: LAYERS.some(l => layers[l].contested) || conflicts.length > 0,
    coverage: {
      layersAvailable: available.length,
      layersPossible: LAYERS.length,
      unavailable: LAYERS.filter(l => !layers[l].available).map(l => ({ layer: l, reason: layers[l].unavailableReason })),
      degraded: available.length < LAYERS.length,
    },
  };
}

/**
 * Side-aware fit of the stack against a proposed trade. A risk-averse tactical regime is a
 * headwind for a long and a tailwind for a short — the same rule the alerts layer applies.
 */
function regimeFitFor(stack, { side = null, horizon = 'swing' } = {}) {
  const layerName = horizon === 'intraday' ? 'intraday' : horizon === 'investor' ? 'strategic' : 'tactical';
  const l = stack && stack.layers ? stack.layers[layerName] : null;
  if (!l || !l.available) {
    return { layer: layerName, alignment: 'UNKNOWN', fit: null, reason: l ? l.unavailableReason : 'no regime stack available' };
  }
  if (!side) return { layer: layerName, alignment: 'UNKNOWN', fit: null, reason: 'no side claimed — regime cannot be oriented' };

  const bullishStates = new Set(['TRENDING_UP', 'RISK_SEEKING', 'BROADENING', 'EXPANSION', 'RECOVERY']);
  const bearishStates = new Set(['TRENDING_DOWN', 'RISK_AVERSE', 'CONTRACTION', 'SLOWDOWN']);
  const longView = bullishStates.has(l.state) ? 'TAILWIND' : bearishStates.has(l.state) ? 'HEADWIND' : 'NEUTRAL';
  const alignment = side === 'short'
    ? (longView === 'TAILWIND' ? 'HEADWIND' : longView === 'HEADWIND' ? 'TAILWIND' : 'NEUTRAL')
    : longView;
  const fit = alignment === 'TAILWIND' ? 1 : alignment === 'NEUTRAL' ? 0.6 : 0.15;
  return {
    layer: layerName,
    alignment,
    fit,
    state: l.state,
    contested: l.contested,
    reason: `${layerName} regime ${l.state} is a ${alignment.toLowerCase()} for a ${side}`
      + (l.contested ? ` (contested: ${l.contradicting.length} contradicting observation(s))` : ''),
  };
}

module.exports = {
  STACK_VERSION, LAYERS, INTRADAY_STATES, TACTICAL_STATES, STRATEGIC_STATES,
  buildRegimeStack, regimeFitFor, intradayLayer, tacticalLayer, strategicLayer, layer, obs,
};

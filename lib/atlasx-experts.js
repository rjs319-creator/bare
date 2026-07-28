'use strict';
// ATLAS-X — mixture-of-experts swing assessors (SHADOW / weight-0).
//
// Six specialist "experts", each of which reads the same point-in-time evidence
// (residualized returns, transition scores, path shape, raw candles + context)
// but reasons about a DIFFERENT swing regime. None of them trades: every
// assessment is a structured opinion the router (atlasx-router.js) later weighs.
//
// Design rules honored here:
//   • PURE functions, no I/O, no mutation of inputs. Every returned object is
//     Object.freeze-d so a downstream layer can never rewrite an opinion.
//   • Reuse the battle-tested signal engines (coil.js, downday.js) instead of
//     re-deriving compression / reversal math.
//   • Distinct applicability, target and explanation per expert — averaging six
//     look-alike opinions would be false confirmation, so each expert must have
//     a genuinely different reason to fire.
//   • Honest uncertainty: e.g. compression ALONE does not predict profit, so a
//     compression opinion carries high uncertainty even when it fires strongly.

const { VERSIONS, PERMITTED, EXPERT_PARAMS } = require('./atlasx-config');
const { EXPERTS } = require('./atlasx-contracts');
const { coilFeatures, coilTradePlan } = require('./coil');
const { classify, tapeState } = require('./downday');

// ── tunables (named, never inline magic numbers) ─────────────────────────────
const CATALYST_MAX_DAYS = 20;      // post-event drift (PEAD-style) window
const EVENT_LOOKBACK = 5;          // sessions scanned for a dislocation gap
const MIN_EVENT_GAP = 0.04;        // 4% open-vs-prior-close = a repricing gap
const MAX_PULLBACK = 0.12;         // >12% "pullback" is a trend break, not a dip
const OVEREXTENDED_RET5 = 0.15;    // 5-day run beyond which continuation is late
const SEC_DAY = 86400;

// ── tiny pure helpers ────────────────────────────────────────────────────────
const clamp01 = x => (x == null || !isFinite(x) ? 0 : Math.max(0, Math.min(1, x)));
const num = x => (x == null || !isFinite(Number(x)) ? 0 : Number(x));

function asOfUnix(asOf) {
  if (!asOf) return null;
  const t = Date.parse(`${String(asOf)}T00:00:00Z`);
  return isFinite(t) ? t / 1000 : null;
}

// Latest close from an object-form candle (matches coil/downday candle shape).
function lastClose(candles) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const c = candles[candles.length - 1];
  const px = c && (c.close != null ? c.close : c.c);
  return px > 0 ? Number(px) : null;
}

// Recent swing high/low over the last `win` bars (object-form candles).
function swingBounds(candles, win = 20) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const start = Math.max(0, candles.length - win);
  let hi = -Infinity, lo = Infinity;
  for (let k = start; k < candles.length; k++) {
    const c = candles[k];
    const h = c && (c.high != null ? c.high : c.h);
    const l = c && (c.low != null ? c.low : c.l);
    if (h != null && h > hi) hi = h;
    if (l != null && l < lo) lo = l;
  }
  return isFinite(hi) && isFinite(lo) ? { hi, lo } : null;
}

// Largest recent open-vs-prior-close gap (a repricing event, not momentum).
function recentGap(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return { gap: 0, dir: 'neutral' };
  let best = 0;
  const start = Math.max(1, candles.length - EVENT_LOOKBACK);
  for (let k = start; k < candles.length; k++) {
    const prev = candles[k - 1], cur = candles[k];
    const pc = prev && (prev.close != null ? prev.close : prev.c);
    const op = cur && (cur.open != null ? cur.open : cur.o);
    if (!(pc > 0) || op == null) continue;
    const g = op / pc - 1;
    if (Math.abs(g) > Math.abs(best)) best = g;
  }
  return { gap: best, dir: best > 0 ? 'bullish' : best < 0 ? 'bearish' : 'neutral' };
}

// Assemble a validated-shape assessment. `direction` is an ATLAS-X extension the
// router uses to detect opposing experts; extra keys are permitted by the
// contract validator.
function makeAssessment(expert, f) {
  return Object.freeze({
    expert,
    applicability: clamp01(f.applicability),
    stage: f.stage,
    contributions: Object.freeze(f.contributions || {}),
    entryIntent: Object.freeze(f.entryIntent || { action: 'NO_TRADE' }),
    invalidation: Object.freeze(f.invalidation || { note: 'n/a' }),
    target: Object.freeze(f.target || { note: 'n/a' }),
    uncertainty: clamp01(f.uncertainty),
    maturity: f.maturity,
    direction: f.direction || 'neutral',
    explanation: f.explanation || '',
    version: VERSIONS.experts,
  });
}

// ── expert 1: compression release ────────────────────────────────────────────
// A tight, coiled base that is beginning to expand. Reuses coil.js for the
// squeeze read + coilTradePlan for the breakout geometry. HONEST: compression is
// a *necessary-not-sufficient* condition — it predicts an abnormal move is more
// likely, NOT that it will be profitable — so uncertainty stays high.
function assessCompressionRelease({ candles, residual, transition } = {}) {
  const t = (transition && transition.scores) || {};
  const f = (transition && transition.features) || {};
  const feats = coilFeatures(candles);
  const coilComp = feats ? clamp01(1 - (num(feats.bbPctile) + num(feats.hvPctile)) / 2) : null;
  // Phase 5.1 fix: `expansionNow` is a continuous RATIO (recent/baseline range,
  // ~1.0 typical) and `wasCompressed` a continuous 0..1 percentile. They were
  // previously coerced with `!!` — any non-zero value became `true`, so both
  // indicators were constants in practice. The continuous values are PRESERVED;
  // a binary read exists only for the stage label, via explicit versioned
  // thresholds (atlasx-config EXPERT_PARAMS) — never an implicit truthy cast.
  const expansionRatio = num(f.expansionNow) ?? 1;               // 1.0 = no expansion vs baseline
  const compressionPctile = clamp01(num(f.wasCompressed) ?? 0.5);
  const expansionDegree = clamp01((expansionRatio - 1) / (EXPERT_PARAMS.expansionNowThreshold - 1) / 2);
  const isReleasing = expansionRatio >= EXPERT_PARAMS.expansionNowThreshold;
  const isCoiled = compressionPctile >= EXPERT_PARAMS.wasCompressedThreshold;
  const residInflection = num(residual && residual.residualAccel) > 0;

  const applicability = clamp01(
    0.6 * num(t.compressionToExpansion) +
    0.2 * expansionDegree +
    0.2 * compressionPctile,
  );
  // Compression alone ≠ profit → start uncertain, relax only with confirmation.
  const uncertainty = clamp01(
    0.75 - 0.2 * expansionDegree - 0.2 * (coilComp || 0) - 0.1 * (residInflection ? 1 : 0),
  );

  const plan = coilTradePlan(candles);
  const target = plan
    ? { kind: 'breakout', entry: plan.entry, stop: plan.stop, target: plan.target, rr: plan.rr, remainingRR: plan.rr }
    : { kind: 'breakout', note: 'insufficient history for a coil plan' };

  return makeAssessment('compressionRelease', {
    applicability,
    stage: isReleasing ? 'releasing' : isCoiled ? 'coiled' : 'watch',
    contributions: {
      compressionToExpansion: num(t.compressionToExpansion),
      expansionRatio,                    // continuous, preserved
      expansionDegree,                   // continuous 0..1 mapping used in the blend
      compressionPctile,                 // continuous, preserved
      coilCompression: coilComp,
      residualInflection: residInflection ? 1 : 0,
      thresholdsVersion: EXPERT_PARAMS.version,
    },
    entryIntent: { action: 'WAIT_BREAKOUT', trigger: plan ? plan.entry : null },
    invalidation: { below: plan ? plan.stop : null, note: 'volatility re-expansion fails / base breaks down' },
    target,
    uncertainty,
    maturity: feats ? 'accruing' : 'experimental',
    direction: 'bullish',
    explanation: 'Coiled base beginning to expand; breakout above the coil ceiling. Compression raises the odds of a move, not its profitability.',
  });
}

// ── expert 2: catalyst drift ─────────────────────────────────────────────────
// Post-event drift AFTER a timestamped catalyst. STRICT: it consumes ONLY the
// structured ctx.catalyst fields (type / tsUnix / surprise). A missing catalyst
// is UNKNOWN, not neutral — applicability 0, maturity experimental. It never
// invents a catalyst; an LLM extraction lives upstream, not here.
function assessCatalystDrift({ residual, ctx } = {}) {
  const cat = ctx && ctx.catalyst;
  if (!cat || cat.tsUnix == null) {
    return makeAssessment('catalystDrift', {
      applicability: 0,
      stage: 'no-catalyst',
      contributions: {},
      entryIntent: { action: 'NO_TRADE' },
      invalidation: { note: 'no catalyst on record' },
      target: { kind: 'drift', note: 'unknown — no timestamped catalyst supplied' },
      uncertainty: 1,
      maturity: 'experimental',
      direction: 'neutral',
      explanation: 'No structured catalyst record; catalyst drift is unknown here (not neutral).',
    });
  }
  const now = asOfUnix(ctx && ctx.asOf);
  const daysSince = now != null ? (now - Number(cat.tsUnix)) / SEC_DAY : null;
  // NOTE: this module's num() maps null→0 — an unknown surprise must be checked
  // on the RAW field or it silently becomes a zero surprise (and `null >= 0`
  // would then read bullish).
  const surpriseKnown = cat.surprise != null && isFinite(Number(cat.surprise));
  const surprise = surpriseKnown ? Number(cat.surprise) : null;
  const postResid = num(residual && residual.byHorizon && residual.byHorizon[5] && residual.byHorizon[5].residual);

  let freshness;
  if (daysSince == null || daysSince < 0 || daysSince > CATALYST_MAX_DAYS) freshness = 0.1;
  else freshness = 1 - 0.5 * (daysSince / CATALYST_MAX_DAYS);
  // Drift is credible when the post-event residual confirms the surprise sign.
  // UNKNOWN surprise (a dated event without point-in-time surprise data) is
  // neutral evidence — it must never be read as bullish (the old `null >= 0`
  // comparison did exactly that). Direction then comes from the post-event
  // residual alone, at reduced applicability and full uncertainty.
  const confirms = !surpriseKnown ? 0.5
    : surprise === 0 ? 0.5
      : (Math.sign(postResid) === Math.sign(surprise) ? 1 : 0.3);
  const surpriseTerm = surpriseKnown ? Math.min(Math.abs(surprise), 1) : 0;
  const applicability = clamp01(freshness * (0.4 + 0.4 * surpriseTerm + 0.2 * confirms) * (surpriseKnown ? 1 : 0.6));

  return makeAssessment('catalystDrift', {
    applicability,
    stage: freshness > 0.6 ? 'fresh-event' : 'late-drift',
    contributions: {
      freshness, surprise, surpriseKnown, postEventResidual: postResid, confirms,
    },
    entryIntent: {
      action: 'WAIT_FIRST_HOUR',
      trigger: surpriseKnown
        ? `drift in surprise direction (${surprise >= 0 ? 'up' : 'down'})`
        : 'drift in post-event residual direction (surprise unknown)',
    },
    invalidation: { note: 'residual reverses the surprise sign / drift window elapses' },
    target: { kind: 'drift', driftDays: CATALYST_MAX_DAYS, note: 'residual continuation post-event' },
    uncertainty: clamp01((surpriseKnown ? 0.5 : 0.7) + 0.3 * (1 - confirms)),
    maturity: 'experimental',
    direction: surpriseKnown
      ? (surprise >= 0 ? 'bullish' : 'bearish')
      : (postResid != null && postResid !== 0 ? (postResid > 0 ? 'bullish' : 'bearish') : 'neutral'),
    explanation: surpriseKnown
      ? 'Post-event residual drift measured strictly from the timestamped catalyst fields.'
      : 'Timestamped catalyst without point-in-time surprise data — direction from post-event residual only, reduced applicability.',
  });
}

// ── expert 3: first pullback ─────────────────────────────────────────────────
// A newly-established RESIDUAL leader taking its first controlled pullback:
// shallow dip, higher lows, declining supply, constructive close, room to the
// prior high. Requires positive 20-session residual (a real leader, not the tape).
function assessFirstPullback({ candles, residual, transition } = {}) {
  const t = (transition && transition.scores) || {};
  const f = (transition && transition.features) || {};
  const resid20 = residual && residual.byHorizon && residual.byHorizon[20] && residual.byHorizon[20].residual;
  const isLeader = resid20 != null && resid20 > 0;

  const shallow = f.pullbackDepth != null ? clamp01(1 - num(f.pullbackDepth) / MAX_PULLBACK) : 0.5;
  const higherLows = clamp01(num(f.higherLowFrac));
  const constructive = clamp01(num(f.closeLocRecent));
  const pbScore = clamp01(num(t.firstPullback));

  const applicability = isLeader
    ? clamp01(0.45 * pbScore + 0.2 * shallow + 0.2 * higherLows + 0.15 * constructive)
    : clamp01(0.08 * pbScore);

  const px = lastClose(candles);
  const bounds = swingBounds(candles);
  let target = { kind: 'pullback', note: 'insufficient data' };
  if (px && bounds) {
    const stop = bounds.lo;
    const tgt = bounds.hi;
    const risk = px - stop, reward = tgt - px;
    const remainingRR = risk > 0 ? +(reward / risk).toFixed(2) : null;
    target = { kind: 'pullback', entry: +px.toFixed(2), stop: +stop.toFixed(2), target: +tgt.toFixed(2), remainingRR };
  }

  return makeAssessment('firstPullback', {
    applicability,
    stage: isLeader ? (pbScore > 0.5 ? 'first-dip' : 'holding') : 'not-a-leader',
    contributions: { isLeader: isLeader ? 1 : 0, residual20: num(resid20), firstPullback: pbScore, shallow, higherLows, constructive },
    entryIntent: { action: 'WAIT_PULLBACK', trigger: 'reclaim after a shallow, higher-low pullback' },
    invalidation: { below: bounds ? bounds.lo : null, note: 'loses the pullback low / deep undercut of support' },
    target,
    uncertainty: clamp01(isLeader ? 0.45 : 0.8),
    maturity: 'accruing',
    direction: 'bullish',
    explanation: 'First controlled pullback of an established residual leader with room to the prior high.',
  });
}

// ── expert 4: breakout continuation ──────────────────────────────────────────
// A GENUINE resistance break with participation (volume acceleration) and
// acceptance above the level, not yet over-extended, with adequate range left.
function assessBreakoutContinuation({ candles, transition } = {}) {
  const t = (transition && transition.scores) || {};
  const f = (transition && transition.features) || {};
  const brokeOut = !!f.brokeOut;
  const accept = clamp01(num(t.breakoutAcceptance));
  const reject = clamp01(num(t.breakoutRejection));
  const volAccel = clamp01(num(f.volAccel));
  const extended = f.ret5 != null ? clamp01(num(f.ret5) / OVEREXTENDED_RET5) : 0;

  const applicability = brokeOut
    ? clamp01(0.5 * accept + 0.3 * volAccel + 0.2 * (1 - extended) - 0.4 * reject)
    : clamp01(0.08 * accept);

  const plan = coilTradePlan(candles);
  const target = plan
    ? { kind: 'continuation', entry: plan.entry, stop: plan.stop, target: plan.target, rr: plan.rr, remainingRR: plan.rr }
    : { kind: 'continuation', note: 'insufficient history for a plan' };

  return makeAssessment('breakoutContinuation', {
    applicability,
    stage: brokeOut ? (extended > 0.8 ? 'extended' : 'accepted') : 'no-break',
    contributions: { brokeOut: brokeOut ? 1 : 0, breakoutAcceptance: accept, breakoutRejection: reject, volAccel, extension: extended },
    entryIntent: { action: brokeOut ? 'ENTER_NEXT_OPEN' : 'WAIT_BREAKOUT', trigger: plan ? plan.entry : null },
    invalidation: { below: plan ? plan.stop : null, note: 'loss of the breakout level (failed break / rejection)' },
    target,
    uncertainty: clamp01(0.5 - 0.2 * accept + 0.3 * extended),
    maturity: 'accruing',
    direction: 'bullish',
    explanation: 'Confirmed resistance break with participation and acceptance; continuation with range remaining.',
  });
}

// ── expert 5: red-tape reversal ──────────────────────────────────────────────
// Oversold reversion / blow-off fade — REUSES downday.classify + tapeState.
// DISABLED unless the tape is genuinely risk-off (PERMITTED.redTapeRequiresRiskOff).
// The edge is red-tape-specific and lives in FRESH turns; a confirmed-and-consumed
// reversal has already been spent, so it is down-weighted.
function assessRedTapeReversal({ candles, spy, ctx } = {}) {
  const requiresRiskOff = PERMITTED.redTapeRequiresRiskOff === true;
  const enabled = requiresRiskOff ? (ctx && ctx.riskOff === true) : true;

  if (!enabled) {
    return makeAssessment('redTapeReversal', {
      applicability: 0,
      stage: 'disabled',
      contributions: { riskOff: 0 },
      entryIntent: { action: 'NO_TRADE' },
      invalidation: { note: 'informational only outside a risk-off regime' },
      target: { kind: 'reversal', note: 'disabled — requires a documented risk-off tape' },
      uncertainty: 1,
      maturity: 'accruing',
      direction: 'neutral',
      explanation: 'Reversal edge is red-tape-specific; disabled while the tape is not risk-off.',
    });
  }

  const spyChangePct = spyDayChangePct(spy);
  const tape = tapeState(spyChangePct, ctx && ctx.regime);
  const cls = classify(candles) || null;
  const freshBounce = !!(cls && cls.bucket === 'bounce' && cls.signals && !cls.signals.expired && cls.tier !== 'CONFIRMED');
  const freshFade = !!(cls && cls.bucket === 'fade' && cls.signals && !cls.signals.expired);

  // Active regime → the expert is at least watching; a fresh classified turn
  // lifts applicability by its down-day-adjusted score.
  let applicability;
  if (freshBounce || freshFade) applicability = clamp01(0.4 + num(cls.downScore) / 100 * 0.6);
  else applicability = tape.down ? 0.3 : 0.2;

  const direction = cls && cls.side === 'short' ? 'bearish' : 'bullish';
  const sig = cls && cls.signals ? cls.signals : {};

  return makeAssessment('redTapeReversal', {
    applicability,
    stage: cls ? (cls.tier || 'turn') : 'watch',
    contributions: { riskOff: 1, tapeDown: tape.down ? 1 : 0, downScore: cls ? num(cls.downScore) : 0, fresh: freshBounce || freshFade ? 1 : 0 },
    entryIntent: { action: 'WAIT_CONFIRMATION', trigger: cls ? cls.label : 'oversold turn on a red tape' },
    invalidation: { note: 'undercut of the reversal pivot / tape stops being risk-off' },
    target: { kind: 'reversal', rr: sig.rr != null ? sig.rr : null, note: 'measured-move bounce/fade, red-tape-specific edge' },
    uncertainty: clamp01(freshBounce || freshFade ? 0.55 : 0.8),
    maturity: 'accruing',
    direction,
    explanation: 'Fresh oversold reversal / blow-off fade on a confirmed risk-off tape (not a confirmed-and-consumed turn).',
  });
}

// SPY same-day % change from object-form candles (last close vs prior close).
function spyDayChangePct(spy) {
  if (!Array.isArray(spy) || spy.length < 2) return 0;
  const a = spy[spy.length - 2], b = spy[spy.length - 1];
  const pc = a && (a.close != null ? a.close : a.c);
  const c = b && (b.close != null ? b.close : b.c);
  if (!(pc > 0) || !(c > 0)) return 0;
  return (c / pc - 1) * 100;
}

// ── expert 6: event dislocation ──────────────────────────────────────────────
// A price GAP / repricing handled SEPARATELY from ordinary momentum. It does NOT
// inherit any intraday Gap&Go evidence — the swing outcome must be validated
// independently — so maturity is ALWAYS experimental.
function assessEventDislocation({ candles, residual } = {}) {
  const { gap, dir } = recentGap(candles);
  const magnitude = Math.abs(gap);
  const dislocated = magnitude >= MIN_EVENT_GAP;
  const resid5 = num(residual && residual.byHorizon && residual.byHorizon[5] && residual.byHorizon[5].residual);

  const applicability = dislocated
    ? clamp01(0.35 + Math.min(magnitude / (MIN_EVENT_GAP * 3), 1) * 0.5)
    : clamp01(magnitude / MIN_EVENT_GAP * 0.05);

  return makeAssessment('eventDislocation', {
    applicability,
    stage: dislocated ? 'repricing' : 'no-gap',
    contributions: { gap, magnitude, postGapResidual: resid5 },
    entryIntent: { action: 'WAIT_CONFIRMATION', trigger: 'post-gap acceptance, swing horizon only' },
    invalidation: { note: 'gap fills / repricing rejected' },
    target: { kind: 'dislocation', gap, note: 'swing outcome must be validated independently of intraday Gap&Go' },
    uncertainty: clamp01(0.7),
    maturity: 'experimental',
    direction: dir,
    explanation: 'Event-driven gap/repricing treated as its own regime; intraday Gap&Go evidence is NOT transferred to the swing horizon.',
  });
}

// ── expert 7: RELATIVE LEADERSHIP TRANSITION (v2) ────────────────────────────
// Reads the CROSS-SECTIONAL leadership snapshot precomputed by the RLT scan
// (lib/rlt-scan.js) and injected via ctx.rltLeadership — an expert inside the
// per-candidate loop cannot see peers, so the ranking happens upstream. A
// per-name price path alone is exactly the pseudo-independence the residual
// layer exists to prevent, so with NO injected cross-section this expert
// ABSTAINS (applicability 0) — it never re-derives leadership from one chart.
function assessRelativeLeadershipTransition({ residual, ctx = {} } = {}) {
  const snap = ctx.rltLeadership || null;
  const lead = snap && snap.byTicker && ctx.ticker ? snap.byTicker[ctx.ticker] : null;
  if (!lead) {
    return makeAssessment('relativeLeadershipTransition', {
      applicability: 0, stage: 'no-leadership-data',
      contributions: {}, uncertainty: 1, maturity: 'experimental', direction: 'neutral',
      explanation: 'No cross-sectional leadership snapshot for this name — peer rank cannot be derived from a single chart, so this expert abstains.',
    });
  }

  const pct = num(lead.pctile);
  const vel5 = lead.rankVel5 != null && isFinite(lead.rankVel5) ? lead.rankVel5 : null;
  const accel = lead.rankAccel != null && isFinite(lead.rankAccel) ? lead.rankAccel : null;
  const belowMedian = lead.pctile == null || pct < EXPERT_PARAMS.rltMinPctile;
  const improving = vel5 != null && vel5 >= EXPERT_PARAMS.rltVelocityFloor * 5;
  const stale = snap.asOf && ctx.asOf && snap.asOf !== ctx.asOf;
  const marketOnly = lead.groupingLevel === 'market';
  const extended = lead.extensionState === 'extended';
  const peerCollapse = lead.leaderOnPeerWeaknessOnly === true;

  // Applicability: the TRANSITION (rank change), not the level, is the signal.
  let applicability = clamp01(
    0.25 * clamp01((pct - EXPERT_PARAMS.rltMinPctile) / (1 - EXPERT_PARAMS.rltMinPctile))
    + 0.45 * clamp01((vel5 ?? 0) / 0.2)
    + 0.2 * clamp01((accel ?? 0) / 0.1)
    + 0.1 * (lead.crossHorizonAgreement != null ? lead.crossHorizonAgreement : 0),
  );
  if (belowMedian || !improving) applicability = Math.min(applicability, 0.15);
  if (extended) applicability *= 0.4;
  if (peerCollapse) applicability *= 0.3;
  if (stale) applicability *= EXPERT_PARAMS.rltStaleDiscount;

  const stage = stale ? 'leadership-data-stale'
    : lead.state === 'ARMED' ? 'armed-near-trigger'
      : lead.state === 'PRIMED' ? 'primed'
        : lead.state === 'EMERGING_LEADER' ? 'emerging-leader'
          : improving ? 'leadership-improving' : 'no-transition';

  // Levels from the injected pivot geometry (never invented here).
  const pivot = num(lead.pivot) || null;
  const atr = num(lead.atr) || null;
  const stop = pivot != null && atr != null ? pivot - atr : null;
  const target = pivot != null && atr != null ? pivot + 1.5 * atr : null;
  const r10 = residual && residual.byHorizon && residual.byHorizon[10]
    ? residual.byHorizon[10].residual : null;

  return makeAssessment('relativeLeadershipTransition', {
    applicability,
    stage,
    contributions: {
      withinSectorPercentile: lead.pctile ?? null,
      rankVelocity5: vel5,
      rankAcceleration: accel,
      crossHorizonAgreement: lead.crossHorizonAgreement ?? null,
      peerGroupSize: lead.peerGroupSize ?? null,
      groupingLevel: lead.groupingLevel ?? null,
      residual10: r10,
      transitionRank: lead.transitionRank ?? null,
    },
    entryIntent: { action: lead.state === 'ARMED' ? 'WAIT_BREAKOUT' : 'WAIT_CONFIRMATION', trigger: pivot },
    invalidation: stop != null
      ? { below: stop, note: 'pivot minus 1 ATR — leadership thesis fails on structural break' }
      : { note: 'no pivot structure available' },
    target: target != null
      ? { kind: 'pivot-anchored', price: target, entry: pivot, stop, target, rr: stop != null && pivot != null && pivot - stop > 0 ? (target - pivot) / (pivot - stop) : null }
      : { note: 'no pivot structure available' },
    // Leadership rank alone is NOT a buy signal; uncertainty stays elevated,
    // higher for market-only fallbacks (no true sector peers) and thin groups.
    uncertainty: clamp01(0.5
      + (marketOnly ? 0.15 : 0)
      + (lead.peerGroupSize != null && lead.peerGroupSize < 12 ? 0.1 : 0)
      + (peerCollapse ? 0.2 : 0)
      - 0.15 * clamp01((lead.crossHorizonAgreement ?? 0))),
    maturity: 'experimental',
    direction: improving && !belowMedian ? 'bullish' : 'neutral',
    explanation: `Sector-relative leadership ${lead.pctile != null ? `at the ${Math.round(pct * 100)}th peer percentile` : 'rank unavailable'}`
      + `${vel5 != null ? `, ${vel5 >= 0 ? '+' : ''}${Math.round(vel5 * 100)} pts over 5 sessions` : ''}`
      + `${marketOnly ? ' (market-wide fallback — no sector peers)' : ''}`
      + `${stale ? ' [cross-section one session old]' : ''}.`,
  });
}

// ── orchestrator ─────────────────────────────────────────────────────────────
const APPLICABLE_FLOOR = 0.4; // mirrors HURDLES.minExpertApplicability

function assessExperts({ candles, spy, sector, residual, transition, path, ctx } = {}) {
  const c = ctx || {};
  const assessments = {
    compressionRelease: assessCompressionRelease({ candles, residual, transition, path, ctx: c }),
    catalystDrift: assessCatalystDrift({ candles, residual, ctx: c }),
    firstPullback: assessFirstPullback({ candles, residual, transition, ctx: c }),
    breakoutContinuation: assessBreakoutContinuation({ candles, residual, transition, ctx: c }),
    redTapeReversal: assessRedTapeReversal({ candles, spy, ctx: c }),
    eventDislocation: assessEventDislocation({ candles, residual, ctx: c }),
    relativeLeadershipTransition: assessRelativeLeadershipTransition({ residual, ctx: c }),
  };
  const applicable = EXPERTS.filter(id => assessments[id].applicability >= APPLICABLE_FLOOR);
  return Object.freeze({ assessments: Object.freeze(assessments), applicable: Object.freeze(applicable) });
}

module.exports = {
  assessExperts,
  assessCompressionRelease,
  assessCatalystDrift,
  assessFirstPullback,
  assessBreakoutContinuation,
  assessRedTapeReversal,
  assessEventDislocation,
  assessRelativeLeadershipTransition,
  APPLICABLE_FLOOR,
  CATALYST_MAX_DAYS,
  MIN_EVENT_GAP,
};

'use strict';
// SWING ACTIONABILITY — absolute score, hard gates, four-view decision, honest probability.
//
// One deterministic decision per episode. The score is ABSOLUTE (0-100 points, comparable
// across days — no batch-relative stars) and additive in points so every cap is explicit:
//
//   30  independent price / relative-strength setup     (the backbone — social can't fake it)
//   20  context-specific account track record            (capped; unknown accounts = 0)
//   15  verified catalyst + freshness
//   15  execution quality: liquidity, spread, chase risk
//   10  market + sector regime
//   10  correlation-adjusted social corroboration        (saturating, already de-duped)
//
// HARD GATES: an elite account can RAISE a valid setup's priority but can NEVER rescue a
// broken chart, an unverified catalyst, an illiquid name, a stale alert, an already-consumed
// move, a risk-off veto, or an invalid R:R. Those cap the action below REVIEW regardless of
// score. Probability is SUPPRESSED unless a frozen, out-of-sample calibrated model exists.
//
// Pure + testable. Consumes the deterministic setup (lib/stock-setup), the social/skill
// evidence, the catalyst verification, and market/regime context.

const { isVerified, catalystScore, STATUS: CAT } = require('./alerts-catalyst');
const { assessExecution, executionPermitsAction, STATE: EXEC } = require('./alerts-execution');
const { assessRegimeFit, ALIGNMENT } = require('./alerts-regime');
const { assessFreshness, STATE: FRESH } = require('./alerts-freshness');
const { readPriceAtAlert, moveSinceAlert } = require('./alerts-price-at-alert');

const WEIGHTS = { setup: 30, account: 20, catalyst: 15, execution: 15, regime: 10, social: 10 };
const ACTIONS = { REVIEW: 'REVIEW', WAIT: 'WAIT', AVOID: 'AVOID', EXIT_REASSESS: 'EXIT/REASSESS' };
const VIEWS = { CONFIRMATION: 'confirmation', WAITING: 'waiting', CROWDED: 'crowded', CONTRADICTION: 'contradiction' };
const TIERS = ['actionable', 'watch', 'late-or-crowded', 'contradicted', 'informational'];

const clamp01 = v => Math.max(0, Math.min(1, v));
const pts = (frac, w) => +(clamp01(frac) * w).toFixed(2);

// Does the social thesis side agree with the independent chart setup?
function setupAgreement(side, setupDir) {
  if (setupDir === 'none' || !setupDir) return 'no-setup';
  const want = side === 'long' ? 'long' : side === 'short' ? 'short' : null;
  if (!want) return 'unknown';
  return setupDir === want ? 'confirms' : 'contradicts';
}

// Chase-risk: how extended the name is at the realistic entry. Returns { extended, late, atrExt }.
function chaseRisk({ setup, preMovePct }) {
  const atrExt = setup && setup.atr && setup.spot && setup.sma20 != null
    ? +(((setup.spot - setup.sma20) / setup.atr)).toFixed(2) : null;
  const rsi = setup && setup.rsi;
  const preMoveLate = preMovePct != null && preMovePct >= 8;                 // ≥8% of the move already gone to entry
  const atrLate = atrExt != null && Math.abs(atrExt) >= 4;                   // >4 ATR from the 20-day mean
  const rsiLate = rsi != null && (setup.direction === 'long' ? rsi >= 80 : rsi <= 20);
  const extended = preMoveLate || atrLate || rsiLate;
  return { extended, late: extended, atrExt, preMovePct: preMovePct ?? null };
}

// ── Research priority: an ORDERING, not a probability ───────────────────────
// The card used to lead with `score`/100 next to an action badge, which reads as a
// confidence. Research priority is the honest replacement: a band that says where to
// spend attention first, with the disclaimer attached to the record itself so no
// renderer can drop it.
const PRIORITY_BANDS = Object.freeze(['P1', 'P2', 'P3', 'P4']);
const PRIORITY_NOT_PROBABILITY =
  'Research priority is an attention ORDERING derived from evidence coverage and gate outcomes. '
  + 'It is not a probability, not an expected return, and not calibrated.';

function priorityOf(score, action, freshness, execution) {
  // Gate outcomes dominate the raw component sum: an un-actionable card cannot outrank an
  // actionable one just because it accumulated points.
  const gateFloor = action === ACTIONS.REVIEW ? 0
    : action === ACTIONS.WAIT ? 1
      : 2;
  const scoreBand = score >= 65 ? 0 : score >= 45 ? 1 : score >= 25 ? 2 : 3;
  let idx = Math.max(gateFloor, scoreBand);
  if (freshness && (freshness.state === 'STALE' || freshness.state === 'UNKNOWN')) idx = Math.max(idx, 2);
  if (freshness && freshness.state === 'EXPIRED') idx = 3;
  if (execution && execution.state === 'UNKNOWN') idx = Math.max(idx, 2);
  const band = PRIORITY_BANDS[Math.min(idx, PRIORITY_BANDS.length - 1)];
  return {
    band,
    rank: idx + 1,
    label: { P1: 'Look first', P2: 'Watch', P3: 'Background', P4: 'Archive' }[band],
    basedOn: { gateAction: action, componentSum: score, freshness: freshness ? freshness.state : null, executionState: execution ? execution.state : null },
    isProbability: false,
    note: PRIORITY_NOT_PROBABILITY,
  };
}

/**
 * Score + classify one episode. Returns the decision record (absolute score, component
 * breakdown, tier, action, view, gates). Pure.
 *
 * @param {object} ep  { side, status, catalysts, statedLevels, coordinatedSeen, ... episode }
 * @param {object} ctx {
 *   setup,            // evaluateSetup(candles) — the INDEPENDENT read (may be {valid:false})
 *   skill,            // account skill record { state, skillWeight, accountPoints, n, ci90, weightReason }
 *   catalyst,         // verifyCatalyst(...) result
 *   social,           // { confirmation:0..1, independentClusters, coordinated, roles }
 *   market,           // { liquidityOk, spreadBps, preMovePct, priceNow, priceAtAlert, moveSinceAlertPct, ageDays }
 *   regime,           // { riskOff:boolean, supportive:boolean, label }
 * }
 */
function scoreEpisode(ep, ctx = {}) {
  const setup = ctx.setup || { direction: 'none', valid: false, quality: 0 };
  const skill = ctx.skill || { state: 'UNKNOWN', skillWeight: 0, accountPoints: 0, n: 0 };
  const catalyst = ctx.catalyst || { status: CAT.UNVERIFIED };
  const social = ctx.social || { confirmation: 0, independentClusters: 0, coordinated: false };
  const market = ctx.market || {};
  const regime = ctx.regime || {};
  const side = ep.side;

  const agree = setupAgreement(side, setup.direction);

  // ── P0: immutable alert price → honest "move already consumed" ──
  // `ctx.priceAtAlert` is the capture record; a legacy episode yields LEGACY_NOT_CAPTURED
  // and the consumed-move guard degrades to the chart-only ATR extension read.
  const priceAtAlert = ctx.priceAtAlert || readPriceAtAlert(ep);
  const priceNow = market.priceNow ?? setup.spot ?? null;
  const move = moveSinceAlert(priceAtAlert, priceNow, side);
  const preMovePct = move.available ? move.consumedPct : (market.preMovePct ?? null);
  const chase = chaseRisk({ setup, preMovePct });

  // ── P0: freshness/TTL evaluated HERE, on every decision build ──
  const freshness = ctx.freshness || assessFreshness({
    firstSeenAt: ep.firstSeen || ep.firstSeenDate || null,
    lastSeenAt: ep.lastSeen || ep.lastSeenDate || null,
    priceAsOf: ctx.priceAsOf || null,
    horizon: ep.intendedHorizon || null,
    now: ctx.now || Date.now(),
  });

  // ── P0: execution evidence with NO favorable default for missing data ──
  const execution = ctx.execution || assessExecution({
    side,
    candles: ctx.candles || null,
    advUsd: market.advUsd ?? null,
    spreadBps: market.spreadBps ?? null,
    orderNotionalUsd: ctx.orderNotionalUsd ?? null,
    borrow: ctx.borrow || null,
    earnings: ctx.earnings || null,
    asOfDate: ep.lastSeenDate || ep.firstSeenDate || null,
    liquidityVerdict: market.liquidityOk === undefined ? null : market.liquidityOk,
  });

  // ── P0: side-aware market + sector regime ──
  const regimeFit = ctx.regimeFit || assessRegimeFit({ market: regime, sector: ctx.sector || null, side });

  const reasons = [];

  // ── Component points (each capped by design) ──
  const setupPts = pts(setup.valid && agree === 'confirms' ? setup.quality : setup.valid && agree === 'contradicts' ? 0 : 0, WEIGHTS.setup);
  const accountPts = Math.min(WEIGHTS.account, skill.accountPoints || 0);   // unknown accounts contribute 0
  // A stale thesis cannot keep full catalyst credit either — freshness is part of the claim.
  const freshFactor = freshness.state === FRESH.FRESH ? 1 : freshness.state === FRESH.AGING ? 0.7 : 0;
  const catPts = pts(catalystScore(catalyst.status) * (chase.extended ? 0.5 : 1) * freshFactor, WEIGHTS.catalyst);
  // Execution credit is the measured credit fraction — already capped by evidence coverage.
  // Extension and R:R modulate it, but they can never manufacture credit out of nothing.
  const execFrac = clamp01(execution.creditFraction * (chase.extended ? 0.5 : 1) * (setup.rr && setup.rr >= 2 ? 1.15 : 1));
  const execPts = pts(execFrac, WEIGHTS.execution);
  const regimePts = pts(regimeFit.creditFraction, WEIGHTS.regime);
  const socialFrac = social.coordinated ? social.confirmation * 0.25 : social.confirmation;  // coordinated corroboration discounted
  const socialPts = pts(socialFrac, WEIGHTS.social);

  const score = Math.round(Math.min(100, setupPts + accountPts + catPts + execPts + regimePts + socialPts));

  // ── HARD GATES → action ceiling (score cannot buy past these) ──
  const st = ep.status;
  const isExitState = st === 'EXITED' || st === 'INVALIDATED';
  let action, view, tier;

  if (isExitState || ep.contradicted) {
    action = ACTIONS.EXIT_REASSESS; view = VIEWS.CONTRADICTION; tier = 'contradicted';
    reasons.push(st === 'INVALIDATED' ? 'Thesis invalidated (stop/flip) — reassess, do not enter.' : 'Source has exited — the trade is closed, reassess.');
  } else if (freshness.state === FRESH.EXPIRED) {
    action = ACTIONS.EXIT_REASSESS; view = VIEWS.CONTRADICTION; tier = 'contradicted';
    reasons.push(`Expired: ${freshness.reasons[0] || 'past its TTL'} — an expired alert is never actionable.`);
  } else if (freshness.state === FRESH.STALE || freshness.state === FRESH.UNKNOWN || freshness.priceState === FRESH.STALE) {
    action = ACTIONS.WAIT; view = VIEWS.WAITING; tier = 'watch';
    reasons.push(freshness.reasons[0] || 'Alert age cannot be established — not actionable.');
  } else if (agree === 'contradicts') {
    action = ACTIONS.AVOID; view = VIEWS.CONTRADICTION; tier = 'contradicted';
    reasons.push(`Social ${side} thesis conflicts with the independent ${setup.direction} chart setup.`);
  } else if (!setup.valid) {
    action = ACTIONS.WAIT; view = VIEWS.WAITING; tier = 'watch';
    reasons.push('No clean independent setup yet — social lead only; wait for price structure.');
  } else if (social.coordinated) {
    action = ACTIONS.AVOID; view = VIEWS.CROWDED; tier = 'late-or-crowded';
    reasons.push('Suspected coordinated promotion — kept for research, not a follow.');
  } else if (chase.extended) {
    action = ACTIONS.AVOID; view = VIEWS.CROWDED; tier = 'late-or-crowded';
    reasons.push(`Move already consumed / over-extended (${chase.preMovePct != null ? chase.preMovePct + '% pre-entry, ' : ''}ATR ext ${chase.atrExt}) — LATE, don't chase.`);
  } else if (execution.state === EXEC.BLOCKED) {
    action = ACTIONS.AVOID; view = VIEWS.CROWDED; tier = 'late-or-crowded';
    reasons.push(`Not executably tradeable: ${execution.notes.find(n => /floor|no borrow|capacity/.test(n)) || 'measured execution constraint'}.`);
  } else if (!executionPermitsAction(execution)) {
    // UNKNOWN execution evidence: WAIT, never a favorable default.
    action = ACTIONS.WAIT; view = VIEWS.WAITING; tier = 'watch';
    reasons.push(execution.unavailableReason || 'Execution evidence unavailable — UNKNOWN, so not actionable.');
  } else if (regimeFit.vetoes.length) {
    action = ACTIONS.WAIT; view = VIEWS.WAITING; tier = 'watch';
    reasons.push(`Regime headwind for this ${side}: ${regimeFit.vetoes.map(v => v.reason).join('; ')} — wait.`);
  } else if (setup.rr != null && setup.rr < 1) {
    action = ACTIONS.WAIT; view = VIEWS.WAITING; tier = 'watch';
    reasons.push(`R:R ${setup.rr} below 1 — wait for a better entry against the invalidation.`);
  } else {
    // Setup valid + confirms + fresh + liquid + not extended + acceptable regime & R:R.
    const catalystOk = isVerified(catalyst.status) || (setup.trigger != null && setup.rr != null && setup.rr >= 1.5);
    if (agree === 'confirms' && catalystOk) {
      action = ACTIONS.REVIEW; view = VIEWS.CONFIRMATION; tier = 'actionable';
      reasons.push(`Independent ${setup.direction} setup${isVerified(catalyst.status) ? ' + verified catalyst' : ' + strong technical trigger'}${skill.skillWeight > 0 ? ` + ${skill.state.toLowerCase()} source` : ''}.`);
    } else {
      action = ACTIONS.WAIT; view = VIEWS.WAITING; tier = 'watch';
      reasons.push(isVerified(catalyst.status) ? 'Setup forming but not yet triggered — wait for the level.' : 'Catalyst unverified and no strong trigger yet — wait for confirmation.');
    }
  }

  // ── The investor-facing ordering. NOT a probability, NOT an expected return. ──
  // The prominent number on the card is this BAND; `score` stays in the payload as the
  // auditable component sum, but the UI must not present it as a /100 confidence.
  const researchPriority = priorityOf(score, action, freshness, execution);
  const setupState = !setup.valid ? 'NO_SETUP'
    : agree === 'contradicts' ? 'CONTRADICTED'
      : setup.trigger != null && priceNow != null && (side === 'short' ? priceNow <= setup.trigger : priceNow >= setup.trigger) ? 'TRIGGERED'
        : 'FORMING';

  return {
    episodeId: ep.id || null,
    ticker: ep.ticker || null,
    side,
    score,                    // absolute 0-100 component SUM (auditable; not a probability)
    scoreIsProbability: false,
    researchPriority,         // the display ordering — band + explicit disclaimer
    setupState,
    tier, action, view,
    components: {
      setup: setupPts, account: accountPts, catalyst: catPts,
      execution: execPts, regime: regimePts, social: socialPts,
    },
    weights: WEIGHTS,
    setupAgreement: agree,
    chase,
    // ── P0 evidence blocks (each self-describing when unavailable) ──
    priceAtAlert,
    moveSinceAlert: move,
    freshness,
    execution,
    regimeFit,
    // deterministic levels (chart math only — never social / LLM)
    trigger: setup.trigger ?? null, invalidation: setup.invalidation ?? null,
    target: setup.target ?? null, support: setup.support ?? null, resistance: setup.resistance ?? null,
    rr: setup.rr ?? null, spot: setup.spot ?? market.priceNow ?? null,
    catalystStatus: catalyst.status,
    accountState: skill.state, accountPointsCapped: accountPts,
    independentClusters: social.independentClusters || 0,
    coordinated: !!social.coordinated,
    researchMaturity: 'shadow',   // whole layer is weight 0 — cannot originate/boost a live trade
    reasons,
  };
}

// Bucket decisions into the four coordinated views.
function bucketViews(decisions) {
  const list = decisions || [];
  return {
    confirmations: list.filter(d => d.view === VIEWS.CONFIRMATION),
    waiting: list.filter(d => d.view === VIEWS.WAITING),
    crowded: list.filter(d => d.view === VIEWS.CROWDED),
    contradictions: list.filter(d => d.view === VIEWS.CONTRADICTION),
  };
}

// Probability display gate. Without a frozen, out-of-sample, base-rate-beating calibrated
// model there is NO honest probability to show — return the suppression string.
const PROBABILITY_UNAVAILABLE = 'Probability unavailable — insufficient prospective calibrated evidence.';
function probabilityDisplay(calibration) {
  if (calibration && calibration.frozen && calibration.outOfSample && calibration.beatsBaseRate && calibration.n >= 150) {
    return { available: true, prob: calibration.prob, modelVersion: calibration.version, n: calibration.n };
  }
  return { available: false, message: PROBABILITY_UNAVAILABLE };
}

module.exports = {
  WEIGHTS, ACTIONS, VIEWS, TIERS, PROBABILITY_UNAVAILABLE,
  PRIORITY_BANDS, PRIORITY_NOT_PROBABILITY, priorityOf,
  setupAgreement, chaseRisk, scoreEpisode, bucketViews, probabilityDisplay,
};

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
  const chase = chaseRisk({ setup, preMovePct: market.preMovePct });
  const reasons = [];

  // ── Component points (each capped by design) ──
  const setupPts = pts(setup.valid && agree === 'confirms' ? setup.quality : setup.valid && agree === 'contradicts' ? 0 : 0, WEIGHTS.setup);
  const accountPts = Math.min(WEIGHTS.account, skill.accountPoints || 0);   // unknown accounts contribute 0
  const catPts = pts(catalystScore(catalyst.status) * (chase.extended ? 0.5 : 1), WEIGHTS.catalyst);
  const execFrac = clamp01((market.liquidityOk === false ? 0.1 : 0.7) + (chase.extended ? -0.4 : 0.1) + (setup.rr && setup.rr >= 2 ? 0.2 : 0));
  const execPts = pts(execFrac, WEIGHTS.execution);
  const regimeFrac = regime.riskOff ? 0.15 : regime.supportive ? 1 : 0.6;
  const regimePts = pts(regimeFrac, WEIGHTS.regime);
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
  } else if (market.liquidityOk === false) {
    action = ACTIONS.AVOID; view = VIEWS.CROWDED; tier = 'late-or-crowded';
    reasons.push('Illiquid / wide spread — not executably tradeable regardless of the call.');
  } else if (regime.riskOff) {
    action = ACTIONS.WAIT; view = VIEWS.WAITING; tier = 'watch';
    reasons.push('Risk-off regime veto — wait for the tape to stabilize.');
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

  return {
    episodeId: ep.id || null,
    ticker: ep.ticker || null,
    side,
    score,                    // absolute 0-100 (NOT batch-relative)
    tier, action, view,
    components: {
      setup: setupPts, account: accountPts, catalyst: catPts,
      execution: execPts, regime: regimePts, social: socialPts,
    },
    weights: WEIGHTS,
    setupAgreement: agree,
    chase,
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
  setupAgreement, chaseRisk, scoreEpisode, bucketViews, probabilityDisplay,
};

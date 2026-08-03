'use strict';
// PATTERN GRADING — fill-aware, leakage-safe outcome resolution.
//
// THE DEFECT THIS CLOSES: the old grader restarted barrier evaluation at the beginning of
// the forward window, so a stop hit BEFORE the entry ever filled was counted against the
// setup. Here the exact first fill bar is located first; stop/target evaluation begins AT
// the fill — never earlier.
//
// EXECUTION ASSUMPTIONS (explicit and conservative, all recorded on the outcome):
//   • Entry: first forward bar whose range reaches the frozen trigger. A gap THROUGH the
//     trigger fills at the OPEN (the worse price), never at the trigger.
//   • Stop: a stop order — an intraday touch fills it. A gap through the stop exits at
//     the OPEN (worse than the stop).
//   • Target: a limit order — an intraday touch fills at the target.
//   • Same-bar target+stop with only daily data: resolved as STOP and labeled
//     `ambiguous` (conservative; lower-resolution data may refine it upstream).
//   • Costs: round-trip cost subtracted from the net return.
//
// Outcome vocabulary is exhaustive and distinct: 'no-fill' | 'target' | 'stop' |
// 'timeout' | 'ambiguous' | 'data-unavailable'.

const isNum = v => typeof v === 'number' && isFinite(v);
const round2 = v => (isNum(v) ? Math.round(v * 100) / 100 : null);

const DEFAULT_ROUND_TRIP_COST_PCT = 0.2; // 0.2% round trip (spread+slippage), in percent

// Resolve one episode/plan against strictly-forward bars.
//   plan        : { trigger, stop, target } (frozen)
//   direction   : 'LONG' | 'SHORT'
//   forwardBars : daily bars STRICTLY AFTER the pattern as-of date, in time order
//   opts        : { horizonBars (post-fill), entryValidBars (bars the entry may fill in),
//                   roundTripCostPct }
function resolveOutcome(plan, direction, forwardBars, { horizonBars = 21, entryValidBars = null, roundTripCostPct = DEFAULT_ROUND_TRIP_COST_PCT } = {}) {
  const assumptions = [
    'gap-through-entry fills at open',
    'gap-through-stop exits at open',
    'fill-bar with pre-trigger open: stop judged on the close (range extremes may be pre-fill)',
    'same-bar target+stop resolves as stop (ambiguous)',
    `round-trip cost ${roundTripCostPct}%`,
  ];
  if (!plan || ![plan.trigger, plan.stop, plan.target].every(isNum)) {
    return { outcome: 'data-unavailable', targetFirst: null, filled: false, reason: 'no-plan', assumptions };
  }
  const bars = (forwardBars || []).filter(b => b && [b.open, b.high, b.low, b.close].every(isNum));
  if (!bars.length) {
    return { outcome: 'data-unavailable', targetFirst: null, filled: false, reason: 'no-forward-bars', assumptions };
  }
  const long = direction !== 'SHORT';
  const entryWindow = isNum(entryValidBars) ? entryValidBars : horizonBars;

  // ---- locate the exact first fill bar (never grade anything before it) ----
  let fillIdx = -1;
  let entryPrice = null;
  let gapEntry = false;
  for (let i = 0; i < Math.min(bars.length, entryWindow); i++) {
    const b = bars[i];
    const reached = long ? b.high >= plan.trigger : b.low <= plan.trigger;
    if (!reached) continue;
    const gapped = long ? b.open > plan.trigger : b.open < plan.trigger;
    entryPrice = gapped ? b.open : plan.trigger;
    gapEntry = gapped;
    fillIdx = i;
    break;
  }
  if (fillIdx < 0) {
    return { outcome: 'no-fill', targetFirst: false, filled: false, entryDate: null, entryPrice: null, exitDate: null, exitPrice: null, netReturnPct: 0, grossReturnPct: 0, costPct: 0, barsHeld: 0, ambiguous: false, gapEntry: false, assumptions };
  }

  const entryBar = bars[fillIdx];
  const horizonEnd = Math.min(bars.length, fillIdx + horizonBars);

  // ---- barrier evaluation starting AT the fill bar ----
  // FILL-BAR RULE (documented): when the bar OPENED on the pre-trigger side, price had to
  // travel THROUGH the trigger to fill — so an extreme beyond the stop on that same bar
  // is attributable to pre-fill trading and is NOT counted as a post-entry stop. The
  // post-fill stop evidence on the fill bar is its CLOSE. A gap-fill (opened beyond the
  // trigger) holds the position from the open, so its whole range is post-fill.
  for (let i = fillIdx; i < horizonEnd; i++) {
    const b = bars[i];
    const isFillBar = i === fillIdx;
    const preTriggerOpen = isFillBar && !gapEntry;
    const hitTarget = long ? b.high >= plan.target : b.low <= plan.target;
    const gapThroughStop = !isFillBar && (long ? b.open <= plan.stop : b.open >= plan.stop);
    const rangeHitStop = long ? b.low <= plan.stop : b.high >= plan.stop;
    const closeHitStop = long ? b.close <= plan.stop : b.close >= plan.stop;
    const hitStop = preTriggerOpen ? closeHitStop : rangeHitStop;
    const stopExitPrice = gapThroughStop ? b.open : (preTriggerOpen && closeHitStop ? b.close : plan.stop);

    if (hitTarget && hitStop) {
      return finish('stop', false, entryPrice, stopExitPrice, b, i - fillIdx + 1, { ambiguous: true, outcomeLabel: 'ambiguous' });
    }
    if (hitStop) return finish('stop', false, entryPrice, stopExitPrice, b, i - fillIdx + 1, { gapExit: gapThroughStop });
    if (hitTarget) return finish('target', true, entryPrice, plan.target, b, i - fillIdx + 1, {});
  }
  const lastBar = bars[horizonEnd - 1];
  return finish('timeout', false, entryPrice, lastBar.close, lastBar, horizonEnd - fillIdx, {});

  function finish(kind, targetFirst, entry, exit, bar, barsHeld, { ambiguous = false, gapExit = false, outcomeLabel = null } = {}) {
    const gross = pctMove(entry, exit, long);
    const net = round2(gross - roundTripCostPct);
    return {
      outcome: outcomeLabel || kind,
      targetFirst,
      filled: true,
      entryDate: entryBar.date || null,
      entryPrice: round2(entry),
      exitDate: bar.date || null,
      exitPrice: round2(exit),
      grossReturnPct: round2(gross),
      netReturnPct: net,
      costPct: roundTripCostPct,
      barsHeld,
      ambiguous,
      gapEntry,
      gapExit,
      assumptions,
    };
  }
}

function pctMove(entry, exit, long) {
  if (!isNum(entry) || entry === 0) return 0;
  const raw = ((exit - entry) / entry) * 100;
  return long ? raw : -raw;
}

// The unique resolved-record key IS the episode key (ticker | family | direction |
// timeframe | patternStart | trigger identity | model version) — collisions between two
// same-day detections of different structures are impossible by construction.
function outcomeRecord(episode, outcome, { horizonBars, resolvedAt }) {
  return {
    key: episode.key,
    episodeId: episode.episodeId,
    ticker: episode.ticker,
    family: episode.family,
    direction: episode.direction,
    timeframe: episode.timeframe,
    patternStart: episode.patternStart,
    patternAsOf: episode.patternAsOf,
    detectedDate: episode.detectedDate,
    trigger: episode.frozen.trigger.price,
    stop: episode.frozen.invalidation.price,
    target: episode.frozen.target.price,
    regimeAtDetection: episode.regimeAtDetection,
    structuralValidity: episode.structuralValidity,
    modelVersion: episode.modelVersion,
    featureVersion: episode.featureVersion,
    horizonBars,
    resolvedAt,
    ...outcome,
  };
}

module.exports = { resolveOutcome, outcomeRecord, DEFAULT_ROUND_TRIP_COST_PCT };

'use strict';
// SIGNAL ORCHESTRATOR — lookup-orchestrator-v1.
//
// Produces ONE authoritative recommendation per horizon from the normalized
// engine outputs, instead of several disconnected/contradictory verdicts.
//
// RULES (each closes an audited defect):
//   1. Stale/closed/unavailable inputs can never emit an actionable entry.
//   2. Setup quality ≠ trigger confirmation: a swing BUY whose trigger sits
//      ABOVE the current price is WATCH/READY, never TRIGGERED (defect D1).
//   3. A forming daily bar cannot confirm a swing trigger — confirmation
//      demotes to READY "pending daily close" (defect D2).
//   4. Correlated signals contribute once per evidence family — EMA/MACD/VWAP
//      are one price-trend voice, not four independent confirmations.
//   5. Long-term output is a TREND STATE with side-correct invalidation
//      language (bearish theses invalidate on a RECLAIM, defect D3).
//   6. Contradictions are surfaced, never averaged away.
//   7. Extras (patterns/options/news/social) confirm, contradict, or add risk
//      context — they never create or upgrade a primary entry by themselves.
//   8. No probability is ever fabricated: calibratedProbability stays null
//      unless a valid out-of-sample artifact is attached upstream.
//
// Pure & deterministic: no clock, no network, no store. The route/caller
// supplies every input. Designed so calibrated models can later replace the
// deterministic rules without changing the output shape.

const VERSION = 'lookup-orchestrator-v1';

const HOLDING_PERIODS = Object.freeze({
  intraday: 'minutes to hours (same session)',
  swing: '2–12 weeks',
  longterm: '6–12 months',
});

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = v => (Array.isArray(v) ? v : []);

// ── Evidence families (correlation-aware, one voice per family) ─────────────
function swingFamilies(swing) {
  const fams = [];
  const f = swing && swing.families;
  if (f && num(f.trend) != null) fams.push({ family: 'price-trend', score: f.trend, detail: 'Daily trend structure (MA stack, slopes, range position)' });
  if (f && num(f.relativeStrength) != null) fams.push({ family: 'relative-strength', score: f.relativeStrength, detail: 'Excess return vs SPY' + (swing.sectorAvailable ? ' and sector' : '') });
  if (f && num(f.participation) != null) fams.push({ family: 'participation', score: f.participation, detail: 'Up/down volume balance and breakout participation' });
  return fams;
}

function intradayFamilies(intraday) {
  // The intraday engine's EMA/MACD/VWAP/RSI additive score is ONE correlated
  // price voice — reported as a single family, with volume separate.
  const fams = [];
  if (intraday && intraday.available) {
    const d = intradayDirection(intraday);
    const bias = d === 'bullish' ? 1 : d === 'bearish' ? -1 : 0;
    fams.push({ family: 'price-trend', score: bias, detail: 'Intraday trend/momentum stack (EMA, MACD, VWAP, RSI — correlated, counted once)' });
    const hasVolumeReason = arr(intraday.reasons).concat(arr(intraday.counter)).some(r => /volume/i.test(r));
    if (hasVolumeReason) fams.push({ family: 'participation', score: bias, detail: 'Volume confirmation on the latest bar' });
  }
  return fams;
}

function longTermFamilies(lt) {
  const fams = [];
  if (lt && lt.available) {
    fams.push({ family: 'price-trend', score: num(lt.composite) ?? 0, detail: 'Multi-month trend vs 50/200-day structure' });
    const rs = lt.factors && (num(lt.factors.rs6mPct) ?? num(lt.factors.rs3mPct));
    if (rs != null) fams.push({ family: 'relative-strength', score: Math.max(-1, Math.min(1, rs / 20)), detail: 'Multi-month excess return vs SPY' });
  }
  return fams;
}

// ── Direction helpers ───────────────────────────────────────────────────────
function intradayDirection(intraday) {
  if (!intraday || !intraday.available) return 'unknown';
  const a = intraday.action || '';
  if (a.includes('BUY')) return 'bullish';
  if (a.includes('SELL')) return 'bearish';
  if (intraday.priorBias) return intraday.priorBias;
  return 'neutral';
}

function swingDirection(swing) {
  if (!swing || swing.action === 'UNAVAILABLE') return 'unknown';
  if (swing.action === 'BUY') return 'bullish';
  if (swing.action === 'SELL') return 'bearish';
  const s = num(swing.signedScore);
  if (s != null && Math.abs(s) >= 0.1) return s > 0 ? 'bullish' : 'bearish';
  return 'neutral';
}

// ── Plans ───────────────────────────────────────────────────────────────────
function swingPlanOf(swing) {
  const p = swing && swing.plan;
  if (!p) return null;
  return {
    trigger: num(p.trigger),
    entryZone: p.entryZone || (num(p.trigger) != null ? `on confirmation through $${p.trigger}` : null),
    invalidation: num(p.invalidation),
    targets: num(p.objective) != null ? [p.objective] : [],
    timeStop: p.expiry || p.window || null,
    setupType: p.setupType || null,
    side: p.side || null,
  };
}

function intradayPlanOf(intraday) {
  const l = intraday && intraday.levels;
  if (!l) return null;
  return {
    trigger: num(+l.entry),
    entryZone: `near $${l.entry}`,
    invalidation: num(+l.stop),
    targets: num(+l.target) != null ? [+l.target] : [],
    timeStop: 'end of session',
    setupType: 'momentum-continuation',
    side: null,
  };
}

// ── Contradiction assembly ──────────────────────────────────────────────────
function contradictionsFor(direction, { intraday, swing, longTerm }, horizon) {
  const out = [];
  const push = (src, dir, note) => {
    if (direction !== 'unknown' && dir !== 'unknown' && dir !== 'neutral' && dir !== direction) {
      out.push(`${src} leans ${dir} (${note})`);
    }
  };
  if (horizon !== 'intraday' && intraday && intraday.available && intraday.freshness === 'live') {
    push('Intraday tape', intradayDirection(intraday), 'today\'s session read');
  }
  if (horizon !== 'swing' && swing && swing.action !== 'UNAVAILABLE') {
    push('Swing read', swingDirection(swing), '2–12 week structure');
  }
  if (horizon !== 'longterm' && longTerm && longTerm.available) {
    push('Long-term trend', longTerm.trend === 'bullish' ? 'bullish' : longTerm.trend === 'bearish' ? 'bearish' : 'neutral', '6–12 month structure');
  }
  return out;
}

// Extras: already-normalized lookup-contract signals from patterns/options/
// news/social. They may add evidence, contradictions, event risks and warnings
// — NEVER an action upgrade.
function foldExtras(rec, extras) {
  const supporting = [];
  const contradicting = [];
  const eventRisks = [];
  const warnings = [];
  for (const x of arr(extras)) {
    if (!x || x.horizon && rec.horizon && x.horizon !== rec.horizon && x.engine !== 'optionsflow') continue;
    for (const r of arr(x.eventRisks)) eventRisks.push(r);
    for (const w of arr(x.warnings)) warnings.push(w);
    if (x.direction === 'unknown' || x.direction === 'neutral' || !x.engine) continue;
    const line = `${x.engine}: ${x.explanation || `${x.direction} (${x.setupState})`}`;
    if (rec.direction !== 'unknown' && x.direction !== rec.direction) contradicting.push(line);
    else supporting.push(line);
  }
  return { supporting, contradicting, eventRisks, warnings };
}

// ── Per-horizon recommendation builders ─────────────────────────────────────
function recommendIntraday({ intraday, sessionMeta, positionState }) {
  const fresh = intraday ? intraday.freshness : null;
  const dir = intradayDirection(intraday);
  const execAllowed = !!(sessionMeta && sessionMeta.executionAllowed);
  const base = {
    horizon: 'intraday', direction: dir, plan: null, setupState: 'none',
    expectedHoldingPeriod: HOLDING_PERIODS.intraday,
  };

  if (!intraday || !intraday.available || fresh === 'daily-fallback') {
    return { ...base, action: 'UNAVAILABLE', direction: 'unknown',
      headline: 'Intraday read unavailable',
      explanation: 'No intraday feed for this name — a daily-bar fallback cannot produce a live intraday signal.',
      nextStep: 'Use the swing or long-term view; intraday signals need a live 5-minute tape.' };
  }
  if (fresh === 'closed') {
    return { ...base, action: 'NO_TRADE',
      headline: 'Market closed — no live intraday trade',
      explanation: `The exchange is closed. The last session read${intraday.priorBias ? ` leaned ${intraday.priorBias}` : ''} and is shown as historical context only.`,
      nextStep: 'Wait for the next regular session; re-evaluate on a fresh tape after the open.' };
  }
  if (fresh === 'stale') {
    return { ...base, action: 'STALE', direction: 'unknown',
      headline: 'Intraday data stale — no live signal',
      explanation: 'The newest intraday bar is older than the freshness threshold, so no live intraday action can be justified.',
      nextStep: 'Refresh once the feed catches up; act only on live data.' };
  }

  const plan = intradayPlanOf(intraday);
  const provisional = fresh === 'premarket' || fresh === 'afterhours';
  if (dir === 'bullish' || dir === 'bearish') {
    const wantsShort = dir === 'bearish';
    if (wantsShort && positionState === 'holding') {
      return { ...base, action: 'EXIT', plan, setupState: 'triggered',
        headline: 'Intraday deterioration — exit/de-risk signal for holders',
        explanation: 'The intraday tape has flipped against the position.',
        nextStep: plan && plan.invalidation != null ? `Manage against $${plan.invalidation}.` : 'Manage the position; conditions are against it.' };
    }
    if (wantsShort && positionState !== 'short') {
      return { ...base, action: 'AVOID', plan: null, setupState: 'none',
        headline: 'Intraday tape is against a new long',
        explanation: 'Sellers control the session — avoid initiating a long here. (A short is a separate decision with its own borrow/risk checks.)',
        nextStep: 'Stand aside for this session or wait for a reclaim of VWAP/structure.' };
    }
    // Momentum-condition signals mean "conditions are met NOW" — TRIGGERED only
    // on a live regular-session tape; extended hours are READY (provisional).
    const action = execAllowed && !provisional ? 'TRIGGERED' : 'READY';
    return { ...base, action, plan,
      setupState: action === 'TRIGGERED' ? 'triggered' : 'ready',
      headline: action === 'TRIGGERED'
        ? `Intraday ${dir === 'bullish' ? 'long' : 'short'} conditions met`
        : `Intraday ${dir} conditions met — provisional (${fresh})`,
      explanation: action === 'TRIGGERED'
        ? 'Live regular-session tape with trend, momentum and participation aligned.'
        : 'Extended-hours tape is thin and provisional — treat as preparation, not an entry.',
      nextStep: action === 'TRIGGERED'
        ? (plan ? `Entries ${plan.entryZone}; invalidate below $${plan.invalidation}.` : 'Execution levels unavailable — regular-session volatility could not be computed; size down or skip.')
        : 'Wait for the regular session to confirm with real liquidity.' };
  }
  return { ...base, action: 'NO_TRADE', setupState: 'none',
    headline: 'No intraday edge right now',
    explanation: 'The session read is mixed/neutral — nothing worth paying spread and slippage for.',
    nextStep: 'Re-check on a VWAP reclaim/loss or a volume surge.' };
}

function recommendSwing({ swing, sessionMeta, price, positionState, dailyBarComplete }) {
  const base = {
    horizon: 'swing', direction: swingDirection(swing), plan: swingPlanOf(swing),
    setupState: 'none', expectedHoldingPeriod: HOLDING_PERIODS.swing,
  };
  if (!swing || swing.action === 'UNAVAILABLE') {
    return { ...base, action: 'UNAVAILABLE', direction: 'unknown',
      headline: 'Swing read unavailable',
      explanation: 'Daily price history could not be loaded.',
      nextStep: 'Retry later — this is a data failure, not a neutral verdict.' };
  }

  const px = num(price);
  const plan = base.plan;
  const trig = plan ? plan.trigger : null;
  const evid = num(swing.evidenceStrength);

  if (swing.action === 'BUY' || (swing.action === 'SELL' && positionState === 'short')) {
    const wantsShort = swing.action === 'SELL';
    const beyondTrigger = px != null && trig != null && (wantsShort ? px <= trig : px >= trig);
    let action, setupState, note;
    if (!beyondTrigger) {
      // The engine's structural read is constructive but the trigger has NOT
      // been hit — this is a WATCH/READY, never a live entry (defect D1).
      action = evid != null && evid >= 7 ? 'READY' : 'WATCH';
      setupState = action === 'READY' ? 'ready' : 'forming';
      note = 'Trigger not yet hit.';
    } else if (!dailyBarComplete) {
      // Price is beyond the trigger on a FORMING daily bar — a forming candle
      // is not a confirmed close (defect D2).
      action = 'READY';
      setupState = 'ready';
      note = 'Price is beyond the trigger intraday, but today\'s daily candle has not closed — confirmation pending.';
    } else {
      action = 'TRIGGERED';
      setupState = 'triggered';
      note = 'Trigger confirmed on a completed daily close.';
    }
    const dirWord = wantsShort ? 'short' : 'long';
    return { ...base, action, setupState,
      headline: `Swing ${dirWord} setup — ${action === 'TRIGGERED' ? 'triggered' : action === 'READY' ? 'ready, awaiting confirmation' : 'not yet triggered'}`,
      explanation: `${arr(swing.reasons).slice(0, 2).join(' ') || 'Constructive structure.'} ${note}`,
      nextStep: trig != null
        ? (action === 'TRIGGERED'
          ? `Manage against invalidation $${plan.invalidation}${plan.targets.length ? `, first objective $${plan.targets[0]}` : ''}.`
          : `Watch for a daily close ${wantsShort ? 'below' : 'above'} $${trig}${plan && plan.invalidation != null ? `; setup invalid ${wantsShort ? 'above' : 'below'} $${plan.invalidation}` : ''}.`)
        : 'Watch for a structural trigger to form.' };
  }

  if (swing.action === 'SELL') {
    // Bearish read while NOT hunting a short: avoiding a long and exiting an
    // existing long are different decisions from opening a short.
    const holder = positionState === 'holding';
    return { ...base, action: holder ? 'EXIT' : 'AVOID',
      setupState: 'none',
      headline: holder ? 'Swing structure damaged — exit signal for holders' : 'Damaged structure — avoid new longs',
      explanation: arr(swing.reasons).slice(0, 2).join(' ') || 'Multiple independent damages to the daily structure.',
      nextStep: holder
        ? 'Reduce or exit into strength; structure must repair before re-entry.'
        : 'Stand aside. A short is a separate decision needing borrow/liquidity checks.' };
  }

  // WAIT — must still be a useful watch plan, never an empty shrug (defect D5).
  const constructive = evid != null && evid >= 5 && base.direction !== 'bearish';
  return { ...base, action: constructive ? 'WATCH' : 'NO_TRADE',
    setupState: constructive ? 'forming' : 'none',
    headline: constructive ? 'Constructive but waiting — watch plan active' : 'No swing edge right now',
    explanation: arr(swing.reasons).slice(0, 2).join(' ') || (constructive ? 'Evidence is building but a valid entry structure has not formed.' : 'Neither trend, relative strength nor participation supports a position.'),
    nextStep: plan && plan.trigger != null
      ? `Watch for a daily close above $${plan.trigger}; invalid below $${plan.invalidation ?? '—'}.`
      : (constructive ? 'Wait for a defined trigger (prior-high reclaim or pullback hold) to form.' : 'Re-check after the structure changes.') };
}

function recommendLongTerm({ longTerm, positionState }) {
  const base = {
    horizon: 'longterm', plan: null, setupState: 'none',
    expectedHoldingPeriod: HOLDING_PERIODS.longterm,
  };
  if (!longTerm || !longTerm.available) {
    return { ...base, action: 'UNAVAILABLE', direction: 'unknown',
      headline: 'Long-term read unavailable',
      explanation: 'Daily history could not be loaded.', nextStep: 'Retry later.' };
  }
  const sma200 = longTerm.factors ? num(longTerm.factors.sma200) : null;
  const trend = longTerm.trend;
  // TREND STATE semantics with side-correct invalidation language (defect D3):
  // a bullish thesis dies on LOSING support; a bearish thesis dies on
  // RECLAIMING resistance.
  if (trend === 'bullish') {
    return { ...base, direction: 'bullish',
      action: positionState === 'holding' ? 'MANAGE' : 'WATCH',
      setupState: 'forming',
      headline: 'Long-term uptrend intact',
      explanation: arr(longTerm.reasons).slice(0, 2).join(' ') || 'Price holds above its long-term moving-average structure with positive relative strength.',
      nextStep: sma200 != null
        ? `Thesis invalidated on a sustained LOSS of the 200-day (~$${sma200}). ${positionState === 'holding' ? 'Hold; add only at defined supports.' : 'For new money, prefer entries at defined supports rather than chasing.'}`
        : 'Watch the long-term moving-average structure for invalidation.' };
  }
  if (trend === 'bearish') {
    return { ...base, direction: 'bearish',
      action: positionState === 'holding' ? 'REDUCE' : 'AVOID',
      setupState: 'none',
      headline: 'Long-term downtrend',
      explanation: arr(longTerm.reasons).slice(0, 2).join(' ') || 'Price is below its long-term moving-average structure with negative relative strength.',
      nextStep: sma200 != null
        ? `Bearish thesis invalidated on a sustained RECLAIM of the 200-day (~$${sma200}).`
        : 'The bearish thesis invalidates on a reclaim of long-term resistance.' };
  }
  return { ...base, direction: 'neutral', action: 'NO_TRADE', setupState: 'none',
    headline: 'Long-term trend is unresolved',
    explanation: 'Mixed long-term structure — neither trend has control.',
    nextStep: sma200 != null
      ? `Resolves bullish on a sustained hold above ~$${sma200}; bearish on a sustained loss of it.`
      : 'Watch for the long-term structure to resolve either way.' };
}

// ── Top-level orchestration ─────────────────────────────────────────────────
// Returns the ONE authoritative recommendation for the selected horizon plus
// the evidence-family breakdown and explicit contradictions.
function orchestrate({
  ticker = null,
  horizon = 'swing',
  positionState = 'new',           // 'new' | 'holding' | 'short'
  intraday = null, swing = null, longTerm = null,
  sessionMeta = null,
  price = null,                    // best current price (for trigger checks)
  dailyBarComplete = true,         // is the newest daily bar a completed close?
  extras = [],                     // normalized lookup-contract signals (patterns/options/news/social)
} = {}) {
  const ctx = { intraday, swing, longTerm, sessionMeta, price, positionState, dailyBarComplete };
  const rec = horizon === 'intraday' ? recommendIntraday(ctx)
    : horizon === 'longterm' ? recommendLongTerm(ctx)
    : recommendSwing(ctx);

  // Evidence families — one combined voice per family, engine-tagged.
  const familyMap = new Map();
  const sources = horizon === 'intraday' ? [intradayFamilies(intraday)]
    : horizon === 'longterm' ? [longTermFamilies(longTerm)]
    : [swingFamilies(swing)];
  // Off-horizon engines contribute as CONTEXT families (weight shown, not voted).
  for (const fams of sources) {
    for (const f of fams) {
      const prev = familyMap.get(f.family);
      if (!prev || Math.abs(f.score) > Math.abs(prev.score)) familyMap.set(f.family, f);
    }
  }
  const families = [...familyMap.values()].map(f => Object.freeze({ ...f }));

  const conflicts = contradictionsFor(rec.direction, ctx, horizon);
  const folded = foldExtras(rec, extras);

  const evidenceStrength = horizon === 'intraday'
    ? num(intraday && intraday.evidenceStrength)
    : horizon === 'longterm'
      ? (longTerm && longTerm.available ? Math.min(10, Math.abs(num(longTerm.score) ?? 0)) : null)
      : num(swing && swing.evidenceStrength);

  const freshness = sessionMeta ? {
    marketSession: sessionMeta.marketSession ?? null,
    freshnessState: sessionMeta.freshnessState ?? null,
    dataAsOf: sessionMeta.dataAsOf ?? null,
    ageSeconds: sessionMeta.ageSeconds ?? null,
    executionAllowed: sessionMeta.executionAllowed === true,
    provisional: sessionMeta.provisional === true,
  } : null;

  const warnings = [...folded.warnings];
  if (horizon !== 'longterm' && !(swing && swing.factors && num(swing.factors.medDollarVol) != null && swing.factors.medDollarVol >= 1e6)) {
    if (horizon === 'swing' && swing && swing.factors) warnings.push('Liquidity is thin — execution costs will be a real tax on this name.');
  }
  if (horizon === 'intraday') warnings.push('Spread data unavailable from this feed — assume extra execution cost.');

  return Object.freeze({
    schema: 'lookup-primary-v1',
    version: VERSION,
    ticker: ticker ? String(ticker).toUpperCase() : null,
    horizon,
    positionState,
    action: rec.action,
    direction: rec.direction,
    setupState: rec.setupState,
    headline: rec.headline,
    explanation: rec.explanation,
    nextStep: rec.nextStep,
    plan: rec.plan ? Object.freeze({ ...rec.plan, targets: Object.freeze(arr(rec.plan.targets).slice()) }) : null,
    expectedHoldingPeriod: rec.expectedHoldingPeriod,
    evidenceStrength,
    calibratedProbability: null,          // no artifact exists yet — never fabricated
    probabilityNote: 'Evidence strength is a heuristic score, NOT a probability. Probability unavailable (no calibrated model for this horizon).',
    freshness,
    families: Object.freeze(families),
    supporting: Object.freeze(folded.supporting.slice(0, 6)),
    contradicting: Object.freeze([...conflicts, ...folded.contradicting].slice(0, 6)),
    eventRisks: Object.freeze(folded.eventRisks.slice(0, 4)),
    warnings: Object.freeze(warnings.slice(0, 6)),
    modelMaturity: 'heuristic',
    calibrated: false,
  });
}

module.exports = {
  VERSION, HOLDING_PERIODS, orchestrate,
  // exported for focused tests
  recommendIntraday, recommendSwing, recommendLongTerm,
  swingFamilies, intradayFamilies, longTermFamilies, foldExtras,
};

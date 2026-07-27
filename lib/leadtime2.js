'use strict';
// LEAD-TIME v2 (leadtime-v2) — Phase 2 of the pre-move transition redesign
// (docs/premove-transition-v2.md). Replaces v1's raw "+8% within 63 bars" event,
// which rewards high-volatility names (the app's own Coil research: compression
// predicts ABNORMAL — vol-normalized — breaks, not raw %), uses the future
// breakout entry as the detection anchor, treats truncated forward windows as
// resolved negatives, and keeps only the first ticker/tier occurrence forever.
//
// v2 contracts (each has a regression test in test/leadtime2.test.js):
//   DETECTION  — the anchor is the DECISION CLOSE (last bar ≤ pick date), never
//                the pick's future entry price. Features (trailing vol) use only
//                candles dated at or before the decision cutoff.
//   EVENTS     — barriers are volatility-normalized (Coil's abnormal-expansion
//                definition is the baseline) and outcomes are measured on the
//                MARKET/SECTOR-RESIDUAL path, so a beta rally is not an "event".
//   TAXONOMY   — no-trigger ≠ trigger-but-no-fill ≠ stop-before-target. The full
//                per-horizon outcome set: censored | no-trigger | downside-first
//                | trigger-no-fill | target-before-stop | stop-before-target |
//                timeout.
//   CENSORING  — a horizon whose window has not fully elapsed is `censored` and
//                is EXCLUDED from every rate; it is never a resolved negative.
//   EPISODES   — recurring setups re-enter after the per-strategy contract
//                cooldown (lib/scoreboard-episodes), not first-occurrence-forever.
//   EXECUTION  — trigger fills reuse the app's stop-entry rules: gap-through
//                fills at the worse open; a gap beyond MAX_GAP is a no-fill;
//                same-bar target/stop ambiguity resolves to the STOP.
//   COSTS      — R outcomes are cost-net via lib/costs tiers.
//
// Pure: picks + candles in, report out. No network, no clock, no persistence.

const { trailingDailyVol } = require('./coil');
const { costBreakdown, tierForPick } = require('./costs');

const LEADTIME2_VERSION = 'leadtime-v2';

// Barrier definitions are VERSIONED research parameters. The baseline reuses
// Coil's abnormal-expansion sigma (2.5× own vol, √T-scaled). Alternates are the
// PREREGISTERED sensitivity set — compared in the research harness, never
// silently swapped in. `triggerSigma` scales the fallback trigger when a pick
// carries no plan entry; plan levels (known at decision time) take precedence.
const BARRIERS = Object.freeze({
  'lt2-coilsigma-v1': Object.freeze({ upSigma: 2.5, downSigma: 1.25, triggerSigma: 1.0 }),
  'lt2-tight-v1': Object.freeze({ upSigma: 2.0, downSigma: 1.0, triggerSigma: 0.75 }),
  'lt2-wide-v1': Object.freeze({ upSigma: 3.0, downSigma: 1.5, triggerSigma: 1.25 }),
});
const DEFAULT_BARRIER = 'lt2-coilsigma-v1';

const CONFIG = Object.freeze({
  HORIZONS: Object.freeze([5, 10, 21]),  // sessions searched for the upside trigger
  MAX_GAP: 0.05,                          // open beyond trigger×(1+MAX_GAP) ⇒ no chase, no fill
  VOL_MIN_BARS: 21,                       // trailing-vol needs 20 returns before the decision bar
  CONSUMED_LOOKBACK: 20,                  // bars for the "move already consumed" base low
  MIN_N: 12,                              // resolved-sample floor before a verdict is offered
  barrierVersion: DEFAULT_BARRIER,
});

// Stage-A / Stage-B outcome vocabulary (kept flat per horizon for aggregation).
const OUTCOMES = Object.freeze([
  'censored',            // window not fully elapsed → excluded from rates
  'no-trigger',          // full window, neither barrier touched
  'downside-first',      // invalidation touched before any upside trigger
  'trigger-no-fill',     // trigger occurred but no executable fill (gap beyond MAX_GAP)
  'target-before-stop',  // filled, then target touched before stop
  'stop-before-target',  // filled, then stop touched first (same-bar ⇒ stop, conservative)
  'timeout',             // filled, exit window elapsed with neither barrier
]);

const num = (v) => (Number.isFinite(v) ? v : null);
const median = (arr) => {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return +(a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2).toFixed(3);
};
const rate = (k, n) => (n > 0 ? +(k / n).toFixed(3) : null);

// date → close lookup for the residual path. Returns null when no bar ≤ date.
function closeAtOrBefore(candles, date) {
  if (!Array.isArray(candles) || !candles.length) return null;
  let px = null;
  for (const c of candles) { if (c.date <= date) px = c.close; else break; }
  return num(px);
}

// Cumulative RESIDUAL return from the decision bar to `date`: raw minus the
// sector benchmark when available, else minus the market benchmark, else raw
// with `residualized:false` (labeled, never silently pretended).
function residualReturnTo(rawRet, benchCandles, sectorCandles, fromDate, toDate) {
  const pick = (cs) => {
    const a = closeAtOrBefore(cs, fromDate), b = closeAtOrBefore(cs, toDate);
    return a > 0 && b != null ? b / a - 1 : null;
  };
  const sec = sectorCandles ? pick(sectorCandles) : null;
  const mkt = benchCandles ? pick(benchCandles) : null;
  const bench = sec != null ? sec : mkt;
  if (bench == null) return { residual: rawRet, residualized: false, benchKind: 'none' };
  return { residual: rawRet - bench, residualized: true, benchKind: sec != null ? 'sector' : 'market' };
}

// ── Per-episode, per-horizon resolution ──────────────────────────────────────
// pick: { date, ticker, entry?, stop?, target?, section?, tier?, scope?, band?, decile?, rejected? }
// ctx:  { benchCandles?, sectorCandles?, asOf?, tier?, cfg? }
//
// Returns { detect, dailyVol, horizons: { [H]: outcomeRow } } or
// { skipped: reason } — a skip is a coverage fact, never a resolved negative.
function episodeLeadTime(pick, candles, ctx = {}) {
  const cfg = { ...CONFIG, ...(ctx.cfg || {}) };
  const bar = BARRIERS[cfg.barrierVersion] || BARRIERS[DEFAULT_BARRIER];
  if (!pick || !pick.date || !Array.isArray(candles) || !candles.length) return { skipped: 'no-candles' };

  let idx = -1;
  for (let k = 0; k < candles.length; k++) { if (candles[k].date <= pick.date) idx = k; else break; }
  if (idx < 0) return { skipped: 'no-decision-bar' };
  if (idx + 1 < cfg.VOL_MIN_BARS) return { skipped: 'insufficient-history' };

  // DETECTION PRICE = decision close. pick.entry is a PLAN level (used as the
  // trigger barrier below), never the measurement anchor — v1's defect.
  const detect = num(candles[idx].close);
  if (detect == null || detect <= 0) return { skipped: 'no-decision-price' };

  // Feature cutoff: trailing vol from bars ≤ decision only.
  const dailyVol = trailingDailyVol(candles.slice(0, idx + 1));
  if (!(dailyVol > 0)) return { skipped: 'no-volatility' };

  const liqTier = ctx.tier || tierForPick(pick);
  const asOf = ctx.asOf || null;
  const lastUsableIdx = (() => {
    if (!asOf) return candles.length - 1;
    let li = candles.length - 1;
    while (li >= 0 && candles[li].date > asOf) li--;
    return li;
  })();

  // "Move already consumed at detection": where the decision close sits between
  // the recent base low and the eventual forward high (per horizon, below).
  let lo20 = Infinity;
  for (let k = Math.max(0, idx - cfg.CONSUMED_LOOKBACK + 1); k <= idx; k++) {
    const lo = num(candles[k].low != null ? candles[k].low : candles[k].close);
    if (lo != null && lo < lo20) lo20 = lo;
  }
  if (!Number.isFinite(lo20)) lo20 = null;

  const horizons = {};
  for (const H of cfg.HORIZONS) {
    horizons[H] = resolveHorizon({ pick, candles, idx, detect, dailyVol, H, bar, cfg, ctx, liqTier, lastUsableIdx, lo20 });
  }
  return { detect, decisionDate: candles[idx].date, dailyVol: +dailyVol.toFixed(6), barrierVersion: cfg.barrierVersion, horizons };
}

function resolveHorizon({ pick, candles, idx, detect, dailyVol, H, bar, cfg, ctx, liqTier, lastUsableIdx, lo20 }) {
  const sigmaH = dailyVol * Math.sqrt(H);

  // Barriers. Plan levels (entry/stop — known at decision time) take precedence;
  // fallbacks are vol-scaled from the decision close (versioned above).
  const trigger = num(pick.entry) > detect ? pick.entry : detect * (1 + bar.triggerSigma * sigmaH);
  const invalidation = (num(pick.stop) != null && pick.stop < detect && pick.stop > 0)
    ? pick.stop : detect * (1 - bar.downSigma * sigmaH);
  const abnormalLevel = detect * (1 + bar.upSigma * sigmaH);   // Coil's "the move got going" marker

  const windowEnd = idx + H;                    // last bar of the Stage-A search window
  const searchEnd = Math.min(windowEnd, lastUsableIdx);

  let triggerBar = null;
  let downBar = null;
  let maeBeforeTrigger = 0;                     // worst adverse move from detect while waiting
  for (let k = idx + 1; k <= searchEnd; k++) {
    const c = candles[k];
    const hi = num(c.high != null ? c.high : c.close);
    const lo = num(c.low != null ? c.low : c.close);
    if (lo != null) maeBeforeTrigger = Math.min(maeBeforeTrigger, lo / detect - 1);
    // Same-bar trigger+invalidation ⇒ downside first (conservative in Stage A too).
    if (lo != null && lo <= invalidation) { downBar = k; break; }
    if (hi != null && hi >= trigger) { triggerBar = k; break; }
  }

  const stageAComplete = searchEnd >= windowEnd;
  const base = {
    horizon: H,
    trigger: +trigger.toFixed(4), invalidation: +invalidation.toFixed(4),
    abnormalLevel: +abnormalLevel.toFixed(4),
    maeBeforeTriggerPct: +(maeBeforeTrigger * 100).toFixed(2),
  };

  // Residual close-path diagnostics over the elapsed window (labeled honestly).
  const endIdx = triggerBar ?? downBar ?? searchEnd;
  const rawRet = num(candles[endIdx] && candles[endIdx].close) != null ? candles[endIdx].close / detect - 1 : null;
  const resid = rawRet == null ? { residual: null, residualized: false, benchKind: 'none' }
    : residualReturnTo(rawRet, ctx.benchCandles, ctx.sectorCandles, candles[idx].date, candles[endIdx].date);

  // Abnormal-expansion event (Coil baseline): max residual close move ≥ upSigma·σ_H.
  // Only decidable on a COMPLETE window; a partial window leaves it null.
  let abnormalBreak = null;
  if (stageAComplete) {
    let maxResid = -Infinity;
    for (let k = idx + 1; k <= windowEnd && k < candles.length; k++) {
      const raw = num(candles[k].close) != null ? candles[k].close / detect - 1 : null;
      if (raw == null) continue;
      const rr = residualReturnTo(raw, ctx.benchCandles, ctx.sectorCandles, candles[idx].date, candles[k].date);
      if (rr.residual != null && rr.residual > maxResid) maxResid = rr.residual;
    }
    abnormalBreak = Number.isFinite(maxResid) ? maxResid >= bar.upSigma * sigmaH : null;
  }

  if (downBar != null) {
    return { ...base, outcome: 'downside-first', sessionsToOutcome: downBar - idx, abnormalBreak,
      residualReturn: resid.residual != null ? +(resid.residual * 100).toFixed(2) : null,
      residualized: resid.residualized, benchKind: resid.benchKind };
  }
  if (triggerBar == null) {
    if (!stageAComplete) return { ...base, outcome: 'censored', reason: `window-open:need-${windowEnd - searchEnd}-more-sessions` };
    return { ...base, outcome: 'no-trigger', sessionsToOutcome: H, abnormalBreak,
      residualReturn: resid.residual != null ? +(resid.residual * 100).toFixed(2) : null,
      residualized: resid.residualized, benchKind: resid.benchKind };
  }

  // ── Stage B: executable fill on the trigger bar ────────────────────────────
  const tBar = candles[triggerBar];
  const open = num(tBar.open != null ? tBar.open : tBar.close);
  if (open != null && open > trigger * (1 + cfg.MAX_GAP)) {
    return { ...base, outcome: 'trigger-no-fill', sessionsToTrigger: triggerBar - idx, abnormalBreak,
      fillReason: 'gap-beyond-max-entry',
      residualReturn: resid.residual != null ? +(resid.residual * 100).toFixed(2) : null,
      residualized: resid.residualized, benchKind: resid.benchKind };
  }
  // Stop-entry semantics: gap-through fills at the (worse) open, else the trigger.
  const fillPrice = open != null && open > trigger ? open : trigger;
  // Target must sit STRICTLY above the fill: when the plan trigger already sits
  // beyond the detection-anchored abnormal level (tiny vol + high plan entry),
  // extending from the fill prevents an instant, fake "target hit" on the fill bar.
  let target = (num(pick.target) != null && pick.target > fillPrice) ? pick.target : detect * (1 + bar.upSigma * sigmaH);
  if (!(target > fillPrice)) target = fillPrice * (1 + bar.upSigma * sigmaH);
  const risk = fillPrice - invalidation;
  if (!(risk > 0)) {
    return { ...base, outcome: 'trigger-no-fill', sessionsToTrigger: triggerBar - idx, fillReason: 'no-positive-risk' };
  }

  const exitEnd = triggerBar + H;               // exit window: H sessions after the fill
  const exitSearchEnd = Math.min(exitEnd, lastUsableIdx);
  let exit = null;
  for (let k = triggerBar; k <= exitSearchEnd; k++) {
    const c = candles[k];
    const hi = num(c.high != null ? c.high : c.close);
    const lo = num(c.low != null ? c.low : c.close);
    // Conservative same-bar ordering: the stop is checked FIRST.
    if (lo != null && lo <= invalidation) { exit = { kind: 'stop-before-target', k, px: invalidation }; break; }
    if (hi != null && hi >= target) { exit = { kind: 'target-before-stop', k, px: target }; break; }
  }
  const stageBComplete = exitSearchEnd >= exitEnd;
  if (!exit && !stageBComplete) {
    return { ...base, outcome: 'censored', sessionsToTrigger: triggerBar - idx,
      reason: `filled-but-exit-window-open:need-${exitEnd - exitSearchEnd}-more-sessions`,
      fillPrice: +fillPrice.toFixed(4) };
  }
  const exitIdx = exit ? exit.k : exitEnd;
  const exitPx = exit ? exit.px : num(candles[exitIdx] && candles[exitIdx].close);
  const holdSessions = exitIdx - triggerBar;
  const grossR = exitPx != null ? (exitPx - fillPrice) / risk : null;
  const costPct = costBreakdown(liqTier, { side: 'long', holdSessions: Math.max(1, holdSessions) }).totalPct;
  const costR = (costPct / 100) * fillPrice / risk;
  const netR = grossR != null ? +(grossR - costR).toFixed(3) : null;

  const rawExitRet = exitPx != null ? exitPx / detect - 1 : null;
  const residExit = rawExitRet == null ? { residual: null, residualized: false, benchKind: 'none' }
    : residualReturnTo(rawExitRet, ctx.benchCandles, ctx.sectorCandles, candles[idx].date, candles[exitIdx] ? candles[exitIdx].date : candles[searchEnd].date);

  // Consumed share: how much of the detect→forward-high move was already behind
  // the decision price relative to the recent base low.
  let consumedPct = null;
  if (lo20 != null) {
    let futureHi = -Infinity;
    for (let k = idx + 1; k <= searchEnd; k++) {
      const hi = num(candles[k].high != null ? candles[k].high : candles[k].close);
      if (hi != null && hi > futureHi) futureHi = hi;
    }
    if (Number.isFinite(futureHi) && futureHi > lo20) consumedPct = +(((detect - lo20) / (futureHi - lo20)) * 100).toFixed(1);
  }

  return {
    ...base,
    outcome: exit ? exit.kind : 'timeout',
    sessionsToTrigger: triggerBar - idx,
    holdSessions,
    fillPrice: +fillPrice.toFixed(4),
    target: +target.toFixed(4),
    grossR: grossR != null ? +grossR.toFixed(3) : null,
    costR: +costR.toFixed(3),
    netR,
    abnormalBreak,
    consumedPct,
    residualReturn: residExit.residual != null ? +(residExit.residual * 100).toFixed(2) : null,
    residualized: residExit.residualized, benchKind: residExit.benchKind,
  };
}

// ── Aggregation ──────────────────────────────────────────────────────────────
// rows: per-episode results from episodeLeadTime (with pick metadata attached by
// the caller: { key, band?, rejected? }). Produces per-horizon rates over the
// RESOLVED sample only — censored episodes are counted but never scored.
function aggregateHorizon(rows, H) {
  const hs = rows.map(r => ({ ...r.horizons[H], band: r.band, rejected: !!r.rejected })).filter(h => h && h.outcome);
  const censored = hs.filter(h => h.outcome === 'censored');
  const resolved = hs.filter(h => h.outcome !== 'censored');
  const n = resolved.length;
  const triggered = resolved.filter(h => ['trigger-no-fill', 'target-before-stop', 'stop-before-target', 'timeout'].includes(h.outcome));
  const filled = resolved.filter(h => ['target-before-stop', 'stop-before-target', 'timeout'].includes(h.outcome));
  const tbs = filled.filter(h => h.outcome === 'target-before-stop');
  const downFirst = resolved.filter(h => h.outcome === 'downside-first');
  const byOutcome = {};
  for (const o of OUTCOMES) byOutcome[o] = hs.filter(h => h.outcome === o).length;

  const bandRows = resolved.filter(h => h.band != null);
  const calibrationByBand = bandRows.length ? Object.fromEntries(
    [...new Set(bandRows.map(h => h.band))].sort().map(b => {
      const g = bandRows.filter(h => h.band === b);
      const gt = g.filter(h => ['trigger-no-fill', 'target-before-stop', 'stop-before-target', 'timeout'].includes(h.outcome));
      return [b, { n: g.length, triggerRate: rate(gt.length, g.length), abnormalBreakRate: rate(g.filter(h => h.abnormalBreak === true).length, g.filter(h => h.abnormalBreak != null).length) }];
    })) : null;

  const selectedRows = resolved.filter(h => !h.rejected);
  const rejectedRows = resolved.filter(h => h.rejected);
  const grp = (g) => ({
    n: g.length,
    triggerRate: rate(g.filter(h => ['trigger-no-fill', 'target-before-stop', 'stop-before-target', 'timeout'].includes(h.outcome)).length, g.length),
    medianNetR: median(g.map(h => h.netR)),
  });

  return {
    horizon: H,
    n, censored: censored.length,
    byOutcome,
    triggerConversionRate: rate(triggered.length, n),
    falseEarlyRate: rate(downFirst.length + resolved.filter(h => h.outcome === 'no-trigger').length, n),
    downsideFirstRate: rate(downFirst.length, n),
    fillRate: rate(filled.length, triggered.length),
    targetBeforeStopGivenFill: rate(tbs.length, filled.length),
    medianSessionsToTrigger: median(triggered.map(h => h.sessionsToTrigger)),
    medianMaeBeforeTriggerPct: median(resolved.map(h => h.maeBeforeTriggerPct)),
    medianNetR: median(filled.map(h => h.netR)),
    medianResidualReturnPct: median(resolved.map(h => h.residualReturn)),
    residualizedShare: rate(resolved.filter(h => h.residualized).length, n),
    abnormalBreakRate: rate(resolved.filter(h => h.abnormalBreak === true).length, resolved.filter(h => h.abnormalBreak != null).length),
    medianConsumedPct: median(filled.map(h => h.consumedPct)),
    // Opportunity-wait cost: sessions of capital committed per unit of net R.
    waitSessionsPerNetR: (() => {
      const w = median(triggered.map(h => h.sessionsToTrigger));
      const r = median(filled.map(h => h.netR));
      return (w != null && r != null && r > 0) ? +(w / r).toFixed(2) : null;
    })(),
    calibrationByBand,
    selectedVsRejected: rejectedRows.length ? { selected: grp(selectedRows), rejected: grp(rejectedRows) } : null,
  };
}

// episodes: [{ pick, candles }] where pick carries { key, band?, rejected?, ... }.
// The caller is responsible for EPISODE construction (recurring setups after the
// per-strategy cooldown — lib/scoreboard-episodes.createEpisodeMap), so this
// module never re-implements dedup.
function computeLeadTime2(episodes, ctx = {}) {
  const cfg = { ...CONFIG, ...(ctx.cfg || {}) };
  const rows = [];
  const skips = {};
  for (const { pick, candles } of episodes || []) {
    const r = episodeLeadTime(pick, candles, { ...ctx, cfg });
    if (r.skipped) { skips[r.skipped] = (skips[r.skipped] || 0) + 1; continue; }
    rows.push({ ...r, key: pick.key ?? pick.section ?? 'unknown', band: pick.band ?? pick.decile ?? null, rejected: !!pick.rejected });
  }
  const byKey = new Map();
  for (const r of rows) {
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key).push(r);
  }
  const algorithms = [...byKey.entries()].map(([key, group]) => ({
    key,
    episodes: group.length,
    horizons: Object.fromEntries(cfg.HORIZONS.map(H => [H, aggregateHorizon(group, H)])),
    verdict: verdictFor(group, cfg),
  })).sort((a, b) => (a.key < b.key ? -1 : 1));

  return {
    version: LEADTIME2_VERSION,
    barrierVersion: cfg.barrierVersion,
    barrier: BARRIERS[cfg.barrierVersion] || BARRIERS[DEFAULT_BARRIER],
    horizons: cfg.HORIZONS,
    outcomes: OUTCOMES,
    algorithms,
    coverage: { episodes: (episodes || []).length, evaluated: rows.length, skipped: skips },
    note: 'Volatility-normalized, residualized, censor-aware lead-time. Censored episodes are excluded from every rate. This is measurement, not a trading edge claim.',
  };
}

// Honest verdict at the mid horizon (10 sessions): a detector is "early" only
// when triggers convert, the wait is tradeable, and fills carry positive net R.
function verdictFor(group, cfg) {
  const H = cfg.HORIZONS.includes(10) ? 10 : cfg.HORIZONS[0];
  const a = aggregateHorizon(group, H);
  if (a.n < cfg.MIN_N) return { verdict: 'insufficient', resolvedN: a.n, minN: cfg.MIN_N };
  const converts = a.triggerConversionRate != null && a.triggerConversionRate >= 0.4;
  const pays = a.medianNetR != null && a.medianNetR > 0;
  const wait = a.medianSessionsToTrigger != null && a.medianSessionsToTrigger <= H;
  return {
    verdict: converts && pays && wait ? 'genuinely-early'
      : !converts ? 'low-conversion' : !pays ? 'converts-but-does-not-pay' : 'slow-to-pay',
    resolvedN: a.n, atHorizon: H,
  };
}

module.exports = {
  LEADTIME2_VERSION, CONFIG, BARRIERS, DEFAULT_BARRIER, OUTCOMES,
  episodeLeadTime, computeLeadTime2, aggregateHorizon, residualReturnTo, median,
};

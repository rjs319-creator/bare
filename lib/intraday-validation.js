'use strict';
// STAGE 4 — VALIDATION AND PROMOTION. The only thing in this system with the authority to
// turn a research idea into a live label, and the only thing that can take it away.
//
// The gate is deliberately hard to pass, because the app's own multi-session research record
// is a long list of promising signals that died under proper out-of-sample testing (momentum
// exits, PEAD, congressional trades, analyst revisions — all NOT-CONFIRMED). A gate that a
// hand-weighted intraday score could stroll through would be worthless.
//
// WHAT MAKES A TEMPLATE LIVE-VALIDATED:
//   • enough resolved events, and enough of them in a LOCKED out-of-sample block
//   • positive expectancy after conservative friction
//   • target-before-stop materially above its MATCHED baseline
//   • the Wilson lower bound not materially below the baseline point estimate
//   • stability across at least three time blocks
//   • no single ticker carrying it, no single month carrying the profit
//   • the SAME configuration version as the events that earned it
//
// Templates are evaluated SEPARATELY and never pooled. A breakout retest passing tells you
// nothing about an early-ignition continuation.

const { PROMOTION, VALIDATION_VERSION, CONFIG_VERSION } = require('./lowfloat-config');

const PROMOTION_STATES = Object.freeze({
  UNVALIDATED: 'UNVALIDATED',
  INSUFFICIENT_SAMPLE: 'INSUFFICIENT_SAMPLE',
  FAILED: 'FAILED',
  PAPER_PROMISING: 'PAPER_PROMISING',
  LIVE_VALIDATED: 'LIVE_VALIDATED',
});

// The baselines every template is measured AGAINST. A template only earns a promotion by
// beating a baseline built from the SAME candidate pool at the SAME instants — otherwise the
// comparison is to an easier universe, which is how most backtests flatter themselves.
const BASELINES = Object.freeze({
  BUY_TOP_RANKED_IMMEDIATELY: 'BUY_TOP_RANKED_IMMEDIATELY',
  FIRST_COMPLETED_HOD_BREAKOUT: 'FIRST_COMPLETED_HOD_BREAKOUT',
  FIRST_BREAKOUT_RETEST: 'FIRST_BREAKOUT_RETEST',
  VWAP_PULLBACK_RECOVERY: 'VWAP_PULLBACK_RECOVERY',
  ABOVE_VWAP_EMA_STACKED: 'ABOVE_VWAP_EMA_STACKED',
  CLOSEST_TO_HIGH_RVOL2: 'CLOSEST_TO_HIGH_RVOL2',
  PCARRY_RANK: 'PCARRY_RANK',
  RANDOM_MATCHED: 'RANDOM_MATCHED',
});

const finite = v => Number.isFinite(v);

// Wilson score interval — the same estimator the rest of the app uses for rate confidence.
function wilson(successes, n, z = 1.96) {
  if (!(n > 0)) return { lo: 0, hi: 1, point: null };
  const p = successes / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return { lo: Math.max(0, (c - s) / d), hi: Math.min(1, (c + s) / d), point: p };
}

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

// ── TEMPLATE STATISTICS ──────────────────────────────────────────────────────
// `events` are RESOLVED outcome records from lib/intraday-outcomes.
function calculateTemplateStats(events, { template = null } = {}) {
  const rows = (events || []).filter(e => e && e.resolved && (!template || e.entryTemplate === template));
  const n = rows.length;
  if (!n) {
    return {
      template, n: 0, resolved: 0, targetBeforeStopRate: null, expectancyR: null,
      byTimeBlock: [], byTicker: {}, byMonth: {}, insufficient: true, version: VALIDATION_VERSION,
    };
  }

  const decided = rows.filter(r => r.targetHitBeforeInvalidation != null);
  const wins = decided.filter(r => r.targetHitBeforeInvalidation === true).length;
  const w = wilson(wins, decided.length);
  const rs = rows.map(r => r.rMultiple).filter(finite);

  // Time blocks = calendar months present, ordered. Used for the stability test.
  const byMonth = {};
  for (const r of rows) {
    const m = String(r.sessionDate || '').slice(0, 7);
    (byMonth[m] ||= []).push(r);
  }
  const months = Object.keys(byMonth).sort();
  const byTimeBlock = months.map(m => {
    const set = byMonth[m];
    const dec = set.filter(x => x.targetHitBeforeInvalidation != null);
    const win = dec.filter(x => x.targetHitBeforeInvalidation === true).length;
    const r = set.map(x => x.rMultiple).filter(finite);
    return {
      block: m, n: set.length,
      targetBeforeStopRate: dec.length ? +(win / dec.length).toFixed(3) : null,
      expectancyR: r.length ? +mean(r).toFixed(3) : null,
      totalR: r.length ? +r.reduce((a, b) => a + b, 0).toFixed(3) : null,
    };
  });

  // Concentration checks.
  const byTicker = {};
  for (const r of rows) byTicker[r.ticker] = (byTicker[r.ticker] || 0) + 1;
  const maxTickerShare = n ? Math.max(...Object.values(byTicker)) / n : 0;
  const positiveMonthR = byTimeBlock.filter(b => finite(b.totalR) && b.totalR > 0);
  const totalPositiveR = positiveMonthR.reduce((a, b) => a + b.totalR, 0);
  const maxMonthProfitShare = totalPositiveR > 0
    ? Math.max(...positiveMonthR.map(b => b.totalR)) / totalPositiveR : null;

  // Out-of-sample = events explicitly marked as belonging to the locked test period, or (when
  // no explicit marking exists) events after the lock date the caller supplies.
  const oos = rows.filter(r => r.outOfSample === true);

  const ambiguous = rows.filter(r => r.sameBarAmbiguous === true).length;

  return {
    version: VALIDATION_VERSION,
    template,
    n, resolved: n, decided: decided.length,
    targetBeforeStopRate: decided.length ? +(wins / decided.length).toFixed(3) : null,
    targetBeforeStopWilsonLo: decided.length ? +w.lo.toFixed(3) : null,
    targetBeforeStopWilsonHi: decided.length ? +w.hi.toFixed(3) : null,
    expectancyR: rs.length ? +mean(rs).toFixed(3) : null,
    totalR: rs.length ? +rs.reduce((a, b) => a + b, 0).toFixed(3) : null,
    medianReturn30m: median(rows.map(r => r.return30m).filter(finite)),
    medianReturnToClose: median(rows.map(r => r.returnToClose).filter(finite)),
    avgMfe60m: mean(rows.map(r => r.maximumFavorableExcursion60m).filter(finite)),
    avgMae60m: mean(rows.map(r => r.maximumAdverseExcursion60m).filter(finite)),
    outOfSampleN: oos.length,
    byTimeBlock, byTicker, months,
    maxTickerShare: +maxTickerShare.toFixed(3),
    maxMonthProfitShare: maxMonthProfitShare == null ? null : +maxMonthProfitShare.toFixed(3),
    sameBarAmbiguous: ambiguous,
    sameBarAmbiguousShare: n ? +((ambiguous / n) * 100).toFixed(1) : null,
    configurationVersions: [...new Set(rows.map(r => r.configurationVersion).filter(Boolean))],
    insufficient: n < PROMOTION.MIN_RESOLVED_EVENTS,
  };
}

function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return +(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2).toFixed(3);
}

// ── MATCHED BASELINE COMPARISON ──────────────────────────────────────────────
// The baseline must be built from the SAME candidate pool at the SAME instants. This function
// only performs the comparison; constructing the matched baseline events is the caller's job
// (lib/lowfloat-routes builds them from the same discovery snapshots).
function compareToMatchedBaseline(templateStats, baselineStats) {
  if (!templateStats || !baselineStats) {
    return { comparable: false, reason: 'missing stats' };
  }
  const t = templateStats.targetBeforeStopRate;
  const b = baselineStats.targetBeforeStopRate;
  if (!finite(t) || !finite(b)) return { comparable: false, reason: 'a rate is unavailable' };

  const edge = +(t - b).toFixed(3);
  const loShortfall = finite(templateStats.targetBeforeStopWilsonLo)
    ? +(b - templateStats.targetBeforeStopWilsonLo).toFixed(3) : null;
  const expectancyEdge = finite(templateStats.expectancyR) && finite(baselineStats.expectancyR)
    ? +(templateStats.expectancyR - baselineStats.expectancyR).toFixed(3) : null;

  return {
    comparable: true,
    baseline: baselineStats.template || baselineStats.baseline || 'baseline',
    templateRate: t, baselineRate: b,
    edge,
    edgeMeetsMinimum: edge >= PROMOTION.MIN_EDGE_OVER_BASELINE,
    templateWilsonLo: templateStats.targetBeforeStopWilsonLo ?? null,
    lowerBoundShortfall: loShortfall,
    lowerBoundAcceptable: loShortfall == null ? false : loShortfall <= PROMOTION.MAX_LOWER_BOUND_SHORTFALL,
    expectancyEdge,
    baselineN: baselineStats.n ?? null,
  };
}

// ── PROMOTION EVALUATION ─────────────────────────────────────────────────────
// Returns the state plus EVERY criterion with its pass/fail, so a "FAILED" verdict always
// says which condition failed rather than being an opaque no.
function evaluateTemplatePromotion(stats, configuration = {}) {
  const cfg = { ...PROMOTION, ...(configuration.thresholds || {}) };
  const currentConfigVersion = configuration.currentConfigVersion || CONFIG_VERSION;
  const baselineComparison = configuration.baselineComparison || null;
  const criteria = [];
  const check = (key, pass, detail) => { criteria.push({ key, pass: pass === true, detail }); return pass === true; };

  if (!stats || !stats.n) {
    return {
      version: VALIDATION_VERSION, template: stats ? stats.template : null,
      promotionState: PROMOTION_STATES.UNVALIDATED,
      criteria: [{ key: 'ANY_RESOLVED_EVENTS', pass: false, detail: 'no resolved events yet' }],
      reason: 'No resolved events — nothing to evaluate.',
      configurationVersion: currentConfigVersion,
    };
  }

  const okSample = check('MIN_RESOLVED_EVENTS', stats.n >= cfg.MIN_RESOLVED_EVENTS,
    `${stats.n} of ${cfg.MIN_RESOLVED_EVENTS} required`);
  const okOos = check('MIN_OUT_OF_SAMPLE_EVENTS', (stats.outOfSampleN || 0) >= cfg.MIN_OUT_OF_SAMPLE_EVENTS,
    `${stats.outOfSampleN || 0} of ${cfg.MIN_OUT_OF_SAMPLE_EVENTS} locked out-of-sample events`);

  // Below the sample floor nothing can pass — but the state distinguishes "not enough data"
  // from "enough data and it failed", which are very different signals to a reader.
  if (!okSample || !okOos) {
    return {
      version: VALIDATION_VERSION, template: stats.template,
      promotionState: PROMOTION_STATES.INSUFFICIENT_SAMPLE,
      criteria,
      reason: `Insufficient sample: ${stats.n} resolved (need ${cfg.MIN_RESOLVED_EVENTS}), ${stats.outOfSampleN || 0} out-of-sample (need ${cfg.MIN_OUT_OF_SAMPLE_EVENTS}).`,
      configurationVersion: currentConfigVersion,
      stats,
    };
  }

  const okExpectancy = check('POSITIVE_EXPECTANCY_AFTER_FRICTION',
    finite(stats.expectancyR) && stats.expectancyR >= cfg.MIN_EXPECTANCY_R,
    `expectancy ${stats.expectancyR}R (need ≥ ${cfg.MIN_EXPECTANCY_R}R)`);

  const okEdge = check('BEATS_MATCHED_BASELINE',
    !!(baselineComparison && baselineComparison.comparable && baselineComparison.edgeMeetsMinimum),
    baselineComparison && baselineComparison.comparable
      ? `edge ${baselineComparison.edge} over ${baselineComparison.baseline} (need ≥ ${cfg.MIN_EDGE_OVER_BASELINE})`
      : 'no comparable matched baseline');

  const okLowerBound = check('LOWER_BOUND_NOT_MATERIALLY_WORSE',
    !!(baselineComparison && baselineComparison.lowerBoundAcceptable),
    baselineComparison ? `shortfall ${baselineComparison.lowerBoundShortfall} (max ${cfg.MAX_LOWER_BOUND_SHORTFALL})` : 'unavailable');

  const stableBlocks = (stats.byTimeBlock || []).filter(b => finite(b.expectancyR) && b.expectancyR > 0).length;
  const okStability = check('STABLE_ACROSS_TIME_BLOCKS',
    (stats.byTimeBlock || []).length >= cfg.MIN_TIME_BLOCKS && stableBlocks >= cfg.MIN_TIME_BLOCKS,
    `${stableBlocks} positive of ${(stats.byTimeBlock || []).length} blocks (need ≥ ${cfg.MIN_TIME_BLOCKS})`);

  const okTicker = check('NO_SINGLE_TICKER_DOMINANCE',
    finite(stats.maxTickerShare) && stats.maxTickerShare <= cfg.MAX_SINGLE_TICKER_SHARE,
    `largest ticker share ${(stats.maxTickerShare * 100).toFixed(1)}% (max ${(cfg.MAX_SINGLE_TICKER_SHARE * 100).toFixed(0)}%)`);

  const okMonth = check('NO_SINGLE_MONTH_CARRIES_PROFIT',
    stats.maxMonthProfitShare == null || stats.maxMonthProfitShare <= cfg.MAX_SINGLE_MONTH_PROFIT_SHARE,
    stats.maxMonthProfitShare == null ? 'no positive months' : `largest month ${(stats.maxMonthProfitShare * 100).toFixed(0)}% of profit (max ${(cfg.MAX_SINGLE_MONTH_PROFIT_SHARE * 100).toFixed(0)}%)`);

  const versions = stats.configurationVersions || [];
  const okConfig = check('SAME_CONFIGURATION_VERSION',
    versions.length === 1 && versions[0] === currentConfigVersion,
    versions.length === 1
      ? (versions[0] === currentConfigVersion ? `all events on ${currentConfigVersion}` : `events were produced under ${versions[0]}, current is ${currentConfigVersion}`)
      : `events span ${versions.length} configuration versions`);

  const okRecent = check('RECENT_PERFORMANCE_NOT_DETERIORATED',
    configuration.driftStatus == null || configuration.driftStatus === 'HEALTHY',
    configuration.driftStatus ? `drift ${configuration.driftStatus}` : 'drift not evaluated');

  const allPass = okExpectancy && okEdge && okLowerBound && okStability && okTicker && okMonth && okConfig && okRecent;
  const failed = criteria.filter(c => !c.pass).map(c => c.key);

  // PAPER_PROMISING is the honest middle: enough data, positive expectancy, but at least one
  // promotion criterion unmet. It is NOT a licence to trade — it is a reason to keep logging.
  const promotionState = allPass ? PROMOTION_STATES.LIVE_VALIDATED
    : (okExpectancy && finite(stats.expectancyR) && stats.expectancyR > 0) ? PROMOTION_STATES.PAPER_PROMISING
    : PROMOTION_STATES.FAILED;

  return {
    version: VALIDATION_VERSION,
    template: stats.template,
    promotionState,
    criteria,
    failedCriteria: failed,
    reason: allPass
      ? 'All promotion criteria met under the current configuration version.'
      : `Not promoted — unmet: ${failed.join(', ')}.`,
    configurationVersion: currentConfigVersion,
    evaluatedAt: new Date().toISOString(),
    stats,
    baselineComparison,
    honesty: 'Promotion is a statement about a measured out-of-sample record, not a prediction. No profitability is claimed or implied.',
  };
}

// ── DRIFT AND AUTOMATIC DEMOTION ─────────────────────────────────────────────
// A live label must be able to expire. Old backtest success cannot keep a template live once
// the recent record, the data quality, or the configuration has changed underneath it.
function evaluateModelDrift(validatedStats, recentStats, context = {}) {
  const reasons = [];
  const cfg = { ...PROMOTION, ...(context.thresholds || {}) };

  if (!recentStats || !recentStats.n) {
    return { status: 'UNKNOWN', demote: false, reasons: ['no recent events to evaluate'], version: VALIDATION_VERSION };
  }

  // Recent expectancy materially negative.
  if (finite(recentStats.expectancyR) && recentStats.expectancyR < cfg.DRIFT_EXPECTANCY_FLOOR_R) {
    reasons.push(`RECENT_EXPECTANCY_NEGATIVE (${recentStats.expectancyR}R)`);
  }
  // Target-before-stop below the matched baseline.
  if (finite(recentStats.targetBeforeStopRate) && finite(context.baselineRate)
      && recentStats.targetBeforeStopRate < context.baselineRate) {
    reasons.push(`BELOW_BASELINE (${recentStats.targetBeforeStopRate} vs ${context.baselineRate})`);
  }
  // Data quality / capability changes.
  if (context.dataQualityDegraded === true) reasons.push('DATA_QUALITY_DEGRADED');
  if (context.floatProviderChanged === true) reasons.push('FLOAT_PROVIDER_CHANGED');
  if (context.barResolutionChanged === true) reasons.push('BAR_RESOLUTION_CHANGED');
  // Configuration version changed out from under the validated record.
  if (context.currentConfigVersion && validatedStats && validatedStats.configurationVersion
      && context.currentConfigVersion !== validatedStats.configurationVersion) {
    reasons.push(`CONFIG_VERSION_CHANGED (${validatedStats.configurationVersion} → ${context.currentConfigVersion})`);
  }
  // Universe shift: the recent candidate pool no longer resembles the validated one.
  if (finite(context.universeSimilarity) && context.universeSimilarity < 0.5) {
    reasons.push(`CANDIDATE_UNIVERSE_SHIFTED (similarity ${context.universeSimilarity})`);
  }

  const enoughRecent = recentStats.n >= Math.min(cfg.DRIFT_WINDOW_EVENTS, 20);
  const demote = reasons.length > 0 && enoughRecent;
  return {
    version: VALIDATION_VERSION,
    status: reasons.length === 0 ? 'HEALTHY' : (demote ? 'DEMOTE' : 'WATCH'),
    demote,
    demoteTo: demote ? PROMOTION_STATES.PAPER_PROMISING : null,
    reasons,
    recentN: recentStats.n,
    recentExpectancyR: recentStats.expectancyR ?? null,
    evaluatedAt: new Date().toISOString(),
    note: demote
      ? 'Automatic demotion: the live label is withdrawn and the template returns to paper until it re-earns promotion.'
      : (reasons.length ? 'Watch — one or more drift signals present but the recent sample is too small to act on.' : null),
  };
}

// Apply drift to a stored promotion map, returning a NEW map (no mutation).
function applyDrift(promotionMap, driftByTemplate) {
  const out = {};
  for (const [tmpl, rec] of Object.entries(promotionMap || {})) {
    const d = (driftByTemplate || {})[tmpl];
    if (d && d.demote && rec.promotionState === PROMOTION_STATES.LIVE_VALIDATED) {
      out[tmpl] = {
        ...rec,
        promotionState: PROMOTION_STATES.PAPER_PROMISING,
        demotedAt: new Date().toISOString(),
        demotionReasons: d.reasons,
        previousState: rec.promotionState,
      };
    } else {
      out[tmpl] = rec;
    }
  }
  return out;
}

module.exports = {
  PROMOTION_STATES, BASELINES, VALIDATION_VERSION,
  wilson, median, calculateTemplateStats, compareToMatchedBaseline,
  evaluateTemplatePromotion, evaluateModelDrift, applyDrift,
};

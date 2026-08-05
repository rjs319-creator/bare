'use strict';
// CANONICAL EXECUTABLE-EPISODE LEDGER (non-daytrade redesign 2026-08, Phase 6).
//
// THE DEFECT THIS CLOSES. Outcome grading is fragmented across at least five shapes: the
// Scoreboard's `forwardPath` rows (proxy close-to-close, later trigger-verified on daily
// bars), `lib/swing-evaluate` episodes (real next-open fills, gap-skip, same-bar-stop),
// `lib/gapgo-verify` intraday ORB episodes, `lib/coil-reliability`'s Stage-B lane and the
// per-strategy books. Each is internally honest; together they cannot be compared, their
// attrition is invisible, and `fillVerified` was a hand-set CONTRACT FLAG rather than a
// property derived from the records themselves.
//
// THE CONTRACT. One versioned episode representation, one place attrition is counted, and
// `fillVerified` DERIVED from the episodes (a strategy is fill-verified when its resolved
// episodes actually carry verified executable fills — nobody can toggle it).
//
// WHAT THIS IS NOT. It does not re-grade anything. The specialised graders keep their
// logic; adapters map their output into this shape so the records become comparable and
// the reconciliation report can show what the migration changed.
//
// Pure: records in → records out. No network, no store, no clock (timestamps are inputs).

const EI = require('./evidence-identity');

const EPISODE_SCHEMA_VERSION = 'episode-v1';

// Terminal and non-terminal statuses. `no-fill`, `gap-skip` and `invalid-data` are
// OUTCOMES, not absences: a plan that never became a position is evidence about the
// strategy, and dropping those rows is how a fill rate silently becomes 100%.
const FILL_STATUS = Object.freeze({
  FILLED: 'filled',
  NO_FILL: 'no-fill',           // the trigger never traded inside the window
  GAP_SKIP: 'gap-skip',         // opened beyond the chase ceiling — refused, never chased
  INVALID_DATA: 'invalid-data', // the record cannot be graded (see attritionReason)
  PENDING: 'pending',           // the entry session has not happened yet
});

const EXIT_REASON = Object.freeze({
  TARGET: 'target', STOP: 'stop', TIME: 'time-exit', DELISTED: 'delisted',
  CORPORATE_ACTION: 'corporate-action', OPEN: 'open', UNRESOLVED: 'unresolved',
});

// Every way a candidate can fail to become a gradeable episode. Counted, never silent.
const ATTRITION = Object.freeze({
  NO_HISTORY: 'no-history',
  MISSING_ENTRY_SESSION: 'missing-entry-session',
  DELISTED: 'delisted',
  SYMBOL_CHANGE: 'symbol-change',
  NO_LIQUIDITY: 'no-liquidity',
  NO_FILL: 'no-fill',
  GAP_SKIP: 'gap-skip',
  INVALID_TIMESTAMPS: 'invalid-timestamps',
  TRUNCATED_HISTORY: 'truncated-history',
  MISSING_BENCHMARK: 'missing-benchmark',
});

// A fill is VERIFIED only when it was resolved against bars that could actually have
// filled it: an intraday-verified trigger, or a next-session open/trigger resolved on
// daily bars with honest no-fill/gap-skip semantics. A signal-day close is never a fill.
const VERIFIED_FILL_BASES = Object.freeze(['intraday-verified', 'next-open', 'trigger-verified-daily']);
const UNVERIFIED_FILL_BASES = Object.freeze(['signal-close-proxy', 'assumed-filled', 'unknown']);

const num = (v) => (Number.isFinite(+v) && v !== null && v !== '' && typeof v !== 'boolean' ? +v : null);
const str = (v) => (v == null || v === '' ? null : String(v));
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v);

// Build ONE canonical episode. Never throws: an unusable record becomes an INVALID_DATA
// episode carrying its attrition reason, because a dropped record is a biased record.
function makeEpisode(input = {}) {
  const errors = [];
  const req = (k, v) => { if (v == null) errors.push(`missing ${k}`); };

  const identity = EI.canonicalIdentity(input.identity || input);
  const decisionTs = str(input.decisionTs);
  const infoCutoff = str(input.informationCutoff ?? input.dataCutoffSession);
  const expectedEntrySession = str(input.expectedEntrySession);
  const actualEntryTs = str(input.actualEntryTs ?? input.fillDate);

  req('ticker', str(input.ticker));
  req('decisionTs', decisionTs);
  req('informationCutoff', infoCutoff);

  let fillStatus = input.fillStatus || (actualEntryTs ? FILL_STATUS.FILLED : FILL_STATUS.PENDING);
  let attritionReason = input.attritionReason || null;

  // TIMESTAMP ORDERING — a trade that begins before the decision that produced it is not
  // evidence, it is leakage. Fails to INVALID_DATA rather than being graded.
  if (decisionTs && actualEntryTs && actualEntryTs <= decisionTs) {
    fillStatus = FILL_STATUS.INVALID_DATA;
    attritionReason = ATTRITION.INVALID_TIMESTAMPS;
    errors.push(`entry ${actualEntryTs} is not after decision ${decisionTs}`);
  }
  if (infoCutoff && decisionTs && isDate(infoCutoff) && isDate(decisionTs) && infoCutoff > decisionTs.slice(0, 10)) {
    fillStatus = FILL_STATUS.INVALID_DATA;
    attritionReason = ATTRITION.INVALID_TIMESTAMPS;
    errors.push(`information cutoff ${infoCutoff} is AFTER the decision ${decisionTs} — look-ahead`);
  }
  // A declared expected entry session that was never available must NOT be substituted
  // with a later one (the Gap & Go rule, applied to every strategy).
  if (expectedEntrySession && actualEntryTs && isDate(expectedEntrySession) && isDate(actualEntryTs)
      && actualEntryTs.slice(0, 10) !== expectedEntrySession) {
    fillStatus = FILL_STATUS.INVALID_DATA;
    attritionReason = ATTRITION.MISSING_ENTRY_SESSION;
    errors.push(`entry session ${actualEntryTs.slice(0, 10)} is not the expected ${expectedEntrySession} — a later session is never substituted`);
  }

  const fillBasis = str(input.fillBasis) || 'unknown';
  const fillVerified = VERIFIED_FILL_BASES.includes(fillBasis) && fillStatus === FILL_STATUS.FILLED;

  return {
    schemaVersion: EPISODE_SCHEMA_VERSION,
    // ── identity (immutable) ──
    identity,
    identityKey: EI.identityKey(identity),
    identityClass: EI.classifyIdentity(identity),
    episodeId: str(input.episodeId) || `${EI.identityKey(identity)}#${str(input.ticker)}@${decisionTs}`,
    ticker: str(input.ticker),
    securityId: str(input.securityId ?? input.permId ?? input.cik) || null,   // permanent id when known
    // ── time ──
    decisionTs, informationCutoff: infoCutoff,
    expectedEntrySession, actualEntryTs,
    // ── execution ──
    fillStatus, fillBasis, fillVerified,
    entryPrice: num(input.entryPrice ?? input.fillPrice),
    entryPriceSource: str(input.entryPriceSource) || null,
    slippageAssumptionPct: num(input.slippageAssumptionPct),
    spreadAssumptionPct: num(input.spreadAssumptionPct),
    // ── plan ──
    stop: num(input.stop), target: num(input.target),
    timeExitSessions: num(input.timeExitSessions),
    // ── resolution ──
    exitReason: str(input.exitReason) || (fillStatus === FILL_STATUS.FILLED ? EXIT_REASON.OPEN : null),
    exitPrice: num(input.exitPrice), exitTs: str(input.exitTs),
    // ── costs & shorts ──
    borrowAvailable: input.borrowAvailable === undefined ? null : input.borrowAvailable === true,
    borrowCostBps: num(input.borrowCostBps),
    transactionCostPct: num(input.transactionCostPct),
    // ── benchmarks ──
    benchmarkReturnPct: num(input.benchmarkReturnPct),
    sectorReturnPct: num(input.sectorReturnPct),
    // ── data integrity ──
    delisted: input.delisted === true,
    corporateAction: str(input.corporateAction) || null,
    missingHistoryResolution: str(input.missingHistoryResolution) || null,
    attritionReason,
    // ── outcomes ──
    grossReturnPct: num(input.grossReturnPct),
    netReturnPct: num(input.netReturnPct),
    grossExcessPct: num(input.grossExcessPct),
    netExcessPct: num(input.netExcessPct),
    rMultipleGross: num(input.rMultipleGross),
    rMultipleNet: num(input.rMultipleNet),
    // ── provenance ──
    dataLineage: input.dataLineage && typeof input.dataLineage === 'object' ? { ...input.dataLineage } : null,
    evaluatorVersion: str(input.evaluatorVersion) || null,
    valid: errors.length === 0,
    errors,
  };
}

// DERIVED fill verification (Phase 6 rule 1). A strategy is fill-verified when it has a
// meaningful number of RESOLVED episodes and all of them were resolved on a verified fill
// basis. Never a hand-set flag.
function deriveFillVerified(episodes, { minResolved = 20 } = {}) {
  const eps = (episodes || []).filter(Boolean);
  const resolved = eps.filter(e => e.fillStatus === FILL_STATUS.FILLED && e.exitReason && e.exitReason !== EXIT_REASON.OPEN);
  const bases = [...new Set(eps.map(e => e.fillBasis).filter(Boolean))];
  const unverifiedBases = bases.filter(b => !VERIFIED_FILL_BASES.includes(b));
  const verified = resolved.length >= minResolved && resolved.every(e => e.fillVerified === true) && unverifiedBases.length === 0;
  return {
    fillVerified: verified,
    resolved: resolved.length,
    minResolved,
    bases,
    unverifiedBases,
    reason: verified
      ? `${resolved.length} resolved episodes, all on verified executable fills (${bases.join(', ')})`
      : resolved.length < minResolved
        ? `only ${resolved.length} resolved episodes (need ≥${minResolved}) — fill verification unproven (fails closed)`
        : `episodes carry unverified fill bases: ${unverifiedBases.join(', ')} — proxy outcomes cannot claim verified fills`,
  };
}

// ATTRITION accounting (Phase 6 rule 3). Every candidate that did not become a graded
// position, by reason — the number that makes a fill rate honest.
function attritionReport(episodes) {
  const eps = (episodes || []).filter(Boolean);
  const counts = Object.fromEntries(Object.values(ATTRITION).map(k => [k, 0]));
  for (const e of eps) {
    if (e.attritionReason && counts[e.attritionReason] !== undefined) counts[e.attritionReason]++;
    else if (e.fillStatus === FILL_STATUS.NO_FILL) counts[ATTRITION.NO_FILL]++;
    else if (e.fillStatus === FILL_STATUS.GAP_SKIP) counts[ATTRITION.GAP_SKIP]++;
  }
  const candidates = eps.length;
  const filled = eps.filter(e => e.fillStatus === FILL_STATUS.FILLED).length;
  const pending = eps.filter(e => e.fillStatus === FILL_STATUS.PENDING).length;
  const attrited = candidates - filled - pending;
  return {
    candidates, filled, pending, attrited,
    fillRatePct: candidates - pending > 0 ? +((filled / (candidates - pending)) * 100).toFixed(1) : null,
    byReason: counts,
    note: 'Unfilled, gap-skipped and ungradeable candidates are COUNTED, never dropped — excluding them is what turns a 60% fill rate into a fictional 100%.',
  };
}

// Aggregate the canonical ledger into the ONE population lib/evidence-stats summarizes.
// Only FILLED, resolved episodes carry a return; everything else is attrition (and an
// unfilled plan is never averaged in as a 0% return — that would fabricate an outcome).
function toDateSeriesRows(episodes, { net = true } = {}) {
  return (episodes || [])
    .filter(e => e && e.fillStatus === FILL_STATUS.FILLED)
    .map(e => ({ date: (e.actualEntryTs || e.decisionTs || '').slice(0, 10), netExc: net ? e.netExcessPct : e.grossExcessPct }))
    .filter(r => r.date && Number.isFinite(r.netExc));
}

// ── Adapters ────────────────────────────────────────────────────────────────
// Map an existing grader's output into the canonical shape WITHOUT re-grading it.

// lib/swing-evaluate.evaluate() result + its origin.
function fromSwingEvaluate(origin, evaluated, { identity = null, evaluatorVersion = 'swing-evaluate', dataLineage = null } = {}) {
  const f = (evaluated && evaluated.fill) || {};
  const b = (evaluated && evaluated.barrier) || {};
  const statusMap = { filled: FILL_STATUS.FILLED, unfilled: FILL_STATUS.NO_FILL, 'gap-skip': FILL_STATUS.GAP_SKIP, skipped: FILL_STATUS.GAP_SKIP };
  const fillStatus = statusMap[f.status] || (f.status ? FILL_STATUS.INVALID_DATA : FILL_STATUS.PENDING);
  return makeEpisode({
    identity: identity || { strategyId: origin && origin.strategyId, scoringVersion: origin && origin.scoringVersion, side: origin && origin.side },
    ticker: origin && origin.ticker,
    securityId: origin && (origin.securityId || origin.permId),
    decisionTs: origin && origin.firstDecisionDate,
    informationCutoff: (origin && (origin.dataCutoffSession || origin.firstDecisionDate)) || null,
    actualEntryTs: f.fillDate || null,
    fillStatus,
    fillBasis: f.reason === 'ENTER_NOW_NEXT_OPEN' ? 'next-open' : (f.status === 'filled' ? 'trigger-verified-daily' : 'unknown'),
    attritionReason: f.status === 'unfilled' ? (f.reason === 'NO_SESSION_YET' ? ATTRITION.MISSING_ENTRY_SESSION : ATTRITION.NO_FILL) : null,
    entryPrice: f.fillPrice, entryPriceSource: f.reason || null,
    stop: evaluated && evaluated.stop, target: evaluated && evaluated.target,
    timeExitSessions: origin && origin.originalHoldingWindow,
    exitReason: b.reason || null, exitPrice: b.exitPrice ?? null, exitTs: b.exitDate || null,
    grossReturnPct: evaluated && evaluated.returnSinceFill != null ? evaluated.returnSinceFill * 100 : null,
    grossExcessPct: evaluated && evaluated.excessVsSpy != null ? evaluated.excessVsSpy * 100 : null,
    sectorReturnPct: evaluated && evaluated.excessVsSector != null ? evaluated.excessVsSector * 100 : null,
    evaluatorVersion, dataLineage,
  });
}

// lib/gapgo-verify.resolveOrbFromBars() result for one frozen decision.
function fromGapGoVerify(pick, resolved, { identity = null, evaluatorVersion = 'gapgo-orb-verify-v2', dataLineage = null } = {}) {
  const statusMap = {
    'target-before-stop': { fill: FILL_STATUS.FILLED, exit: EXIT_REASON.TARGET },
    'stop-before-target': { fill: FILL_STATUS.FILLED, exit: EXIT_REASON.STOP },
    'time-exit': { fill: FILL_STATUS.FILLED, exit: EXIT_REASON.TIME },
    'session-close': { fill: FILL_STATUS.FILLED, exit: EXIT_REASON.TIME },
    'no-trigger': { fill: FILL_STATUS.NO_FILL, exit: null, attrition: ATTRITION.NO_FILL },
    'gap-skip': { fill: FILL_STATUS.GAP_SKIP, exit: null, attrition: ATTRITION.GAP_SKIP },
    'insufficient-bars': { fill: FILL_STATUS.INVALID_DATA, exit: null, attrition: ATTRITION.TRUNCATED_HISTORY },
    'invalid-geometry': { fill: FILL_STATUS.INVALID_DATA, exit: null, attrition: ATTRITION.INVALID_TIMESTAMPS },
    'no-entry-session': { fill: FILL_STATUS.INVALID_DATA, exit: null, attrition: ATTRITION.MISSING_ENTRY_SESSION },
    'entry-session-uncertain': { fill: FILL_STATUS.INVALID_DATA, exit: null, attrition: ATTRITION.MISSING_ENTRY_SESSION },
  };
  const m = statusMap[resolved && resolved.status] || { fill: FILL_STATUS.INVALID_DATA, exit: null, attrition: ATTRITION.INVALID_TIMESTAMPS };
  return makeEpisode({
    identity: identity || { strategyId: 'gapgo', scoringVersion: pick && pick.scoringVersion, side: 'long', policyTier: pick && pick.take === true ? 'TAKE' : 'CONTROL' },
    ticker: pick && pick.ticker,
    decisionTs: pick && (pick.decisionTs || pick.date),
    informationCutoff: pick && (pick.dataCutoffSession || pick.date),
    expectedEntrySession: pick && pick.entrySession,
    actualEntryTs: m.fill === FILL_STATUS.FILLED ? (pick && pick.entrySession) : null,
    fillStatus: m.fill, fillBasis: 'intraday-verified',
    attritionReason: m.attrition || null,
    entryPrice: resolved && resolved.fill, entryPriceSource: '5-min opening-range breakout',
    stop: resolved && resolved.stop, target: resolved && resolved.target,
    timeExitSessions: 1,
    exitReason: m.exit, exitPrice: resolved && resolved.exit, exitTs: resolved && resolved.at,
    transactionCostPct: resolved && resolved.costPct,
    rMultipleGross: resolved && resolved.grossR, rMultipleNet: resolved && resolved.netR,
    evaluatorVersion, dataLineage,
  });
}

// A legacy Scoreboard forwardPath row (proxy or trigger-verified daily basis).
function fromScoreboardRow(row, { identity = null, basis = 'signal-close-proxy', evaluatorVersion = 'apex-routes/forwardPath' } = {}) {
  const filled = row && row.ret != null && Number.isFinite(row.ret);
  return makeEpisode({
    identity: identity || { strategyId: row && row.section, policyTier: row && row.tier, side: row && row.short ? 'short' : 'long', scope: row && row.scope },
    ticker: row && row.ticker,
    decisionTs: row && row.date,
    informationCutoff: row && (row.dataCutoffSession || row.date),
    actualEntryTs: filled ? (row.fillDate || null) : null,
    fillStatus: filled ? FILL_STATUS.FILLED : FILL_STATUS.NO_FILL,
    fillBasis: basis,
    attritionReason: filled ? null : ATTRITION.NO_FILL,
    entryPrice: row && row.entry,
    grossReturnPct: row && row.ret, netReturnPct: row && row.net,
    grossExcessPct: row && row.exc, netExcessPct: row && row.netExc,
    sectorReturnPct: row && row.secExc,
    evaluatorVersion,
  });
}

// RECONCILIATION (Phase 6 rule 5): old grading vs the canonical ledger, side by side.
// Differences are REPORTED, never reconciled away.
function reconcile(legacyRows, episodes, { label = 'migration' } = {}) {
  const legacy = (legacyRows || []).filter(Boolean);
  const eps = (episodes || []).filter(Boolean);
  const legacyGraded = legacy.filter(r => Number.isFinite(r.ret ?? r.netExc ?? r.exc));
  const canonicalFilled = eps.filter(e => e.fillStatus === FILL_STATUS.FILLED);
  const mean = (a) => (a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(3) : null);
  const legacyMean = mean(legacyGraded.map(r => r.netExc ?? r.exc ?? r.ret).filter(Number.isFinite));
  const canonicalMean = mean(canonicalFilled.map(e => e.netExcessPct ?? e.grossExcessPct).filter(Number.isFinite));
  return {
    label,
    legacy: { rows: legacy.length, graded: legacyGraded.length, meanOutcome: legacyMean },
    canonical: { episodes: eps.length, filled: canonicalFilled.length, meanOutcome: canonicalMean },
    countDelta: canonicalFilled.length - legacyGraded.length,
    meanDelta: legacyMean != null && canonicalMean != null ? +(canonicalMean - legacyMean).toFixed(3) : null,
    attrition: attritionReport(eps),
    note: 'A negative countDelta is expected and healthy: the canonical ledger refuses to grade plans that never filled, which the proxy basis counted as trades.',
  };
}

module.exports = {
  EPISODE_SCHEMA_VERSION, FILL_STATUS, EXIT_REASON, ATTRITION,
  VERIFIED_FILL_BASES, UNVERIFIED_FILL_BASES,
  makeEpisode, deriveFillVerified, attritionReport, toDateSeriesRows,
  fromSwingEvaluate, fromGapGoVerify, fromScoreboardRow, reconcile,
};

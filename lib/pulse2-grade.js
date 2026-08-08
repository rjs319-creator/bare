'use strict';
// 📡 MARKET PULSE v2 — HORIZON-SPECIFIC, APPENDABLE PROSPECTIVE OUTCOMES.
//
// Repairs of the v1 grader, each locked by tests:
//   • maturity is TRADING SESSIONS counted from actual bar dates (lib/swing-sessions),
//     never calendar days described as sessions;
//   • an event is NEVER "fully graded" at its shortest horizon — each horizon appends
//     independently when IT matures; missing horizons stay missing (no 5-session label
//     on a 3-session number);
//   • multi-ticker events grade EVERY ticker separately under the shared event id;
//   • sector-relative outcomes use the event ticker's sector benchmark when provided;
//   • awareness requires a MATERIAL post-detection move — a dead story detected "ahead"
//     of nothing is not a success;
//   • uncertainty clusters by decision date (and event cluster), reporting effective
//     sample size instead of pretending correlated same-day events are independent.
//
// Pure: bars in → outcomes out. Fetching lives in pulse2-routes.

const { sessionsSince } = require('./swing-sessions');

const round = (n, d = 2) => (n == null || !Number.isFinite(n) ? null : +n.toFixed(d));

// Horizons in TRADING SESSIONS, by view. Intraday horizons are graded by the
// day-trade resolver from intraday bars; session horizons from daily bars.
const SESSION_HORIZONS = Object.freeze([1, 3, 5, 10, 21, 63]);
const HORIZONS_BY_VIEW = Object.freeze({
  day: [1, 3],
  swing: [3, 5, 10, 21],
  investor: [21, 63],
});
const MATERIAL_MOVE_PCT = 3;      // |move| that counts as a consequence
const AWARENESS_MIN_POST_PCT = 2; // post-detection move must be at least this to claim awareness

/** Wilson score interval (~90% two-sided). Pure. */
function wilson(successes, n, z = 1.645) {
  if (!n) return { rate: null, lo: null, hi: null, n: 0 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return { rate: round(p * 100, 1), lo: round((center - half) * 100, 1), hi: round((center + half) * 100, 1), n };
}

/** Index of the entry bar: first bar dated STRICTLY after the decision date. Pure. */
function entryIndex(rows, decisionDate) {
  if (!Array.isArray(rows)) return -1;
  return rows.findIndex(r => r && r.date > decisionDate);
}

/**
 * Grade ONE (event, ticker) pair at EXACTLY the horizons that have matured and are not
 * yet recorded. Appends — never overwrites, never relabels. PURE.
 *
 * @param {object} p
 * @param {object} p.event        ledger event (firstSeenDate, firstSeenDirection, …)
 * @param {string} p.ticker       the specific ticker being graded
 * @param {Array}  p.rows         daily bars [{date,open,high,low,close}] oldest→newest
 * @param {Array|null} p.spyRows  SPY daily bars
 * @param {Array|null} p.sectorRows  sector-benchmark daily bars (or null → sectorExcess null)
 * @param {string|null} p.sectorBenchmark  e.g. 'XLK'
 * @param {object} p.existing     previously recorded outcomes for this pair: {horizons:{[h]:…}}
 * @param {number[]} p.horizons   horizons to consider (defaults SESSION_HORIZONS)
 * @returns {{outcome:object|null, appended:number[]}}  null when nothing new matured
 */
function gradeEventTicker({
  event, ticker, rows, spyRows = null, sectorRows = null, sectorBenchmark = null,
  existing = null, horizons = SESSION_HORIZONS,
} = {}) {
  if (!event || !ticker || !Array.isArray(rows) || !rows.length) return { outcome: null, appended: [] };
  const decisionDate = event.firstSeenDate;
  const eIdx = entryIndex(rows, decisionDate);
  if (eIdx < 0 || rows[eIdx].open == null) return { outcome: null, appended: [] };
  const entryOpen = rows[eIdx].open;
  const matured = sessionsSince(decisionDate, rows);   // sessions elapsed since decision, from REAL bar dates

  const spyIdx = spyRows ? entryIndex(spyRows, decisionDate) : -1;
  const spyEntry = spyIdx >= 0 && spyRows[spyIdx] ? spyRows[spyIdx].open : null;
  const secIdx = sectorRows ? entryIndex(sectorRows, decisionDate) : -1;
  const secEntry = secIdx >= 0 && sectorRows[secIdx] ? sectorRows[secIdx].open : null;

  const prevHorizons = (existing && existing.horizons) || {};
  const appended = [];
  const horizonOut = {};

  for (const h of horizons) {
    if (prevHorizons[h]) continue;                    // already recorded — immutable
    // Maturity in TRADING SESSIONS: the h-th session bar after entry must exist.
    if (matured == null || matured < h + 1) continue; // entry consumes session 1
    const row = rows[eIdx + h];
    if (!row || row.close == null) continue;          // data gap → stays missing, retried later
    const ret = ((row.close - entryOpen) / entryOpen) * 100;
    let spyExcess = null;
    if (spyEntry && spyRows[spyIdx + h] && spyRows[spyIdx + h].close != null) {
      spyExcess = ret - ((spyRows[spyIdx + h].close - spyEntry) / spyEntry) * 100;
    }
    let sectorExcess = null;
    if (secEntry && sectorRows[secIdx + h] && sectorRows[secIdx + h].close != null) {
      sectorExcess = ret - ((sectorRows[secIdx + h].close - secEntry) / secEntry) * 100;
    }
    // Path stats to THIS horizon.
    let mfe = 0, mae = 0;
    for (let i = eIdx; i <= eIdx + h && i < rows.length; i++) {
      if (rows[i].high != null) mfe = Math.max(mfe, ((rows[i].high - entryOpen) / entryOpen) * 100);
      if (rows[i].low != null) mae = Math.min(mae, ((rows[i].low - entryOpen) / entryOpen) * 100);
    }
    horizonOut[h] = {
      horizonSessions: h,
      entryBasis: 'next-session-open',
      exitBasis: 'session-close',
      ret: round(ret), spyExcess: round(spyExcess), sectorExcess: round(sectorExcess),
      sectorBenchmark: sectorExcess != null ? sectorBenchmark : null,
      mfe: round(mfe), mae: round(mae),
      costsNote: 'gross returns; no slippage/commission modeled',
      resolvedAt: rows[eIdx + h].date,
    };
    appended.push(h);
  }
  if (!appended.length) return { outcome: null, appended: [] };

  const dir = event.firstSeenDirection;
  const declared = dir === 'BULLISH' || dir === 'BEARISH';
  const merged = { ...prevHorizons, ...horizonOut };

  // Direction correctness per newly-appended horizon (SPY-relative when available).
  for (const h of appended) {
    const o = merged[h];
    if (declared && o.spyExcess != null) {
      o.directionCorrect = dir === 'BULLISH' ? o.spyExcess > 0 : o.spyExcess < 0;
    } else o.directionCorrect = null;
  }

  // Awareness — computed once, at the first horizon ≥5 that matures (or 63 for investor
  // events). Zero pre-move AND zero post-move is NOT early detection.
  let awareness = existing && existing.awareness ? existing.awareness : null;
  const awH = [5, 10, 3, 21, 63, 1].find(h => merged[h]);
  if (!awareness && awH && merged[awH]) {
    const pre = event.firstSeenFeatures && event.firstSeenFeatures[ticker]
      ? Math.abs(event.firstSeenFeatures[ticker].ret3 || event.firstSeenFeatures[ticker].rawPct || 0) : 0;
    const post = Math.abs(merged[awH].ret || 0);
    awareness = {
      horizonSessions: awH,
      preMove: round(pre), postMove: round(post),
      materialConsequence: post >= MATERIAL_MOVE_PCT,
      // detected ahead ⇒ a MATERIAL post-move that exceeds what was already in the tape
      detectedAhead: post >= AWARENESS_MIN_POST_PCT && post >= pre,
      captureFraction: (pre + post) > 0 ? round(post / (pre + post), 3) : null,
    };
  }

  return {
    outcome: {
      eventId: event.id,
      ticker: String(ticker).toUpperCase(),
      decisionDate,
      direction: dir || 'UNKNOWN',
      thesisVersion: event.thesisVersion || 1,
      family: event.family,
      evidenceAtDecision: event.firstSeenEvidence || 'UNVERIFIED',
      horizons: merged,
      awareness,
      fullyMatured: horizons.every(h => merged[h] != null),
      updatedAt: null,   // stamped by the route (no Date.now in pure code)
    },
    appended,
  };
}

/**
 * Cluster-aware aggregate. The effective independent sample is DISTINCT DECISION DATES
 * (same-day correlated events collapse), further capped by distinct event clusters.
 * No probability is surfaced below the sample floor. PURE.
 */
function summarizeOutcomes(outcomes, { minSample = 20, horizon = 5 } = {}) {
  const rows = (outcomes || []).filter(o => o && o.horizons && o.horizons[horizon]);
  const distinctDates = new Set(rows.map(o => o.decisionDate)).size;
  const distinctEvents = new Set(rows.map(o => o.eventId)).size;
  const effectiveN = Math.min(distinctDates === 0 ? 0 : rows.length, distinctDates * 3, distinctEvents);

  const declared = rows.filter(o => (o.direction === 'BULLISH' || o.direction === 'BEARISH') && o.horizons[horizon].directionCorrect != null);
  const directional = wilson(declared.filter(o => o.horizons[horizon].directionCorrect).length, declared.length);
  const aware = rows.filter(o => o.awareness);
  const awareness = wilson(aware.filter(o => o.awareness.detectedAhead && o.awareness.materialConsequence).length, aware.length);
  const consequence = wilson(rows.filter(o => Math.abs(o.horizons[horizon].ret || 0) >= MATERIAL_MOVE_PCT).length, rows.length);

  const suppressed = distinctDates < minSample;
  const claim = (w, label) => ({
    ...w, label,
    status: w.n === 0 ? 'Insufficient history' : (suppressed ? 'Collecting evidence' : 'Measured'),
    probability: (!suppressed && w.n >= minSample) ? w.rate : null,
  });

  return {
    horizonSessions: horizon,
    rawEventCount: rows.length,
    distinctDecisionDates: distinctDates,
    distinctEventClusters: distinctEvents,
    effectiveSampleSize: effectiveN,
    minSample,
    prospective: true,
    directionalValueProven: false,   // never auto-claimed; requires explicit reviewed governance
    directional: claim(directional, `Declared direction correct (SPY-relative, ${horizon}-session)`),
    awareness: claim(awareness, 'Detected ahead of a material move'),
    consequence: claim(consequence, `Material move followed (≥${MATERIAL_MOVE_PCT}%)`),
  };
}

/**
 * INCREMENTAL VALUE comparison: price/market setup alone (A) vs the identical setup
 * plus narrative evidence (B), on IDENTICAL base events. Each outcome row must carry
 * `setupValidAtDecision` (boolean) and its evidence state; cohort B = setup AND
 * verified narrative. Reports per-cohort stats side by side — no automatic promotion.
 * PURE.
 */
function compareSetupVsSetupPlusPulse(outcomes, { horizon = 5, minSample = 20 } = {}) {
  const base = (outcomes || []).filter(o =>
    o && o.horizons && o.horizons[horizon] && o.setupValidAtDecision === true
    && (o.direction === 'BULLISH' || o.direction === 'BEARISH'));
  const withPulse = base.filter(o => o.evidenceAtDecision === 'VERIFIED' || o.evidenceAtDecision === 'SUPPORTED');

  const stats = rows => {
    const n = rows.length;
    const dates = new Set(rows.map(o => o.decisionDate)).size;
    const correct = rows.filter(o => o.horizons[horizon].directionCorrect === true).length;
    const judged = rows.filter(o => o.horizons[horizon].directionCorrect != null).length;
    const excess = rows.map(o => o.horizons[horizon].spyExcess).filter(Number.isFinite);
    const mfe = rows.map(o => o.horizons[horizon].mfe).filter(Number.isFinite);
    const mae = rows.map(o => o.horizons[horizon].mae).filter(Number.isFinite);
    const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
    return {
      n, distinctDates: dates,
      precision: wilson(correct, judged),
      meanSpyExcess: round(mean(excess)),
      meanMfe: round(mean(mfe)), meanMae: round(mean(mae)),
    };
  };

  const a = stats(base), b = stats(withPulse);
  const enough = a.distinctDates >= minSample && b.distinctDates >= Math.ceil(minSample / 2);
  return {
    horizonSessions: horizon,
    baseCohort: { label: 'Price/market setup alone', ...a },
    pulseCohort: { label: 'Identical setup + verified Pulse evidence', ...b },
    identicalBaseEvents: true,
    verdict: !enough ? 'INSUFFICIENT_SAMPLE'
      : (b.precision.lo != null && a.precision.rate != null && b.precision.lo > a.precision.rate)
        ? 'PULSE_ADDS_VALUE_PROVISIONAL' : 'NO_MEASURED_INCREMENTAL_VALUE',
    note: 'Narrative evidence remains context unless it prospectively improves the identical setup. No automatic promotion.',
  };
}

module.exports = {
  SESSION_HORIZONS, HORIZONS_BY_VIEW, MATERIAL_MOVE_PCT, AWARENESS_MIN_POST_PCT,
  wilson, entryIndex, gradeEventTicker, summarizeOutcomes, compareSetupVsSetupPlusPulse,
};

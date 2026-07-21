'use strict';
// 📡 MARKET PULSE — PROSPECTIVE grading (shadow, honest cold-start).
//
// Grades ONLY immutable first-seen decisions, forward, once a horizon has elapsed. It never
// fabricates history from present-day search. Four separable claims are graded, so a story
// can be "good awareness" without any directional bet:
//   • awareness   — was the story detected BEFORE the bulk of the price reaction?
//   • continuation — did the narrative keep appearing / build?
//   • consequence — did a material move / volume actually follow?
//   • direction   — ONLY when the snapshot declared a directional thesis; next-open entry,
//                    SPY-relative, at 1/3/5/10 sessions.
//   • contrarian  — separately: did crowded names underperform? ("avoid chasing" ≠ a short.)
//
// Pure grading + aggregation (tested); the route wires storage + a bounded forward fetch.
// No probability is emitted until an effective independent sample clears a floor.

const round = (n, d = 2) => (n == null || !Number.isFinite(n) ? null : +n.toFixed(d));

// Wilson score interval (2-sided ~90%, z=1.645) — a shrinkage-aware rate with bounds.
function wilson(successes, n, z = 1.645) {
  if (!n) return { rate: null, lo: null, hi: null, n: 0 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return { rate: round(p * 100, 1), lo: round((center - half) * 100, 1), hi: round((center + half) * 100, 1), n };
}

const MATERIAL_MOVE_PCT = 5;   // |return| this large = a materially consequential move

/**
 * Grade one episode from its first-seen record + forward prices. PURE.
 * @param {object} episode  ledger episode (firstSeenState, firstSeenEnrichment, snapshots…)
 * @param {object} forward  { entryOpen:number, closes:{[h]:number}, spyRet:{[h]:number},
 *                            sectorRet?:{[h]:number}, mfe?:number, mae?:number }
 * @param {{horizons?:number[]}} opts
 * @returns {object} outcome (gradable:false when there is no tradeable entry / data)
 */
function gradeEpisode(episode, forward, { horizons = [1, 3, 5, 10] } = {}) {
  const base = { episodeId: episode.id, firstSeenDate: episode.firstSeenDate, gradable: false };
  if (!forward || !forward.entryOpen || !forward.closes) return { ...base, reason: 'no-entry' };
  const entry = forward.entryOpen;
  const fs = episode.firstSeenState || {};

  const perHorizon = {};
  for (const h of horizons) {
    const close = forward.closes[h];
    if (!Number.isFinite(close)) continue;
    const ret = ((close - entry) / entry) * 100;
    const spy = forward.spyRet ? forward.spyRet[h] : null;
    const sector = forward.sectorRet ? forward.sectorRet[h] : null;
    perHorizon[h] = {
      ret: round(ret),
      spyExcess: Number.isFinite(spy) ? round(ret - spy) : null,
      sectorExcess: Number.isFinite(sector) ? round(ret - sector) : null,
    };
  }
  if (!Object.keys(perHorizon).length) return { ...base, reason: 'no-forward-closes' };

  const ret5 = perHorizon[5] ? perHorizon[5].ret : (perHorizon[3] ? perHorizon[3].ret : perHorizon[1].ret);
  const excess5 = perHorizon[5] ? perHorizon[5].spyExcess : (perHorizon[3] ? perHorizon[3].spyExcess : null);

  // Awareness: detected AHEAD of the move if the post-detection move is at least as large
  // as the pre-detection move already in the tape at first-seen.
  const preMove = episode.firstSeenEnrichment ? Math.abs(episode.firstSeenEnrichment.ret3 || 0) : 0;
  const postMove = Math.abs(ret5 || 0);
  const awareness = { detectedAhead: postMove >= preMove, preMove: round(preMove), postMove: round(postMove) };

  // Continuation: narrative kept appearing after first-seen.
  const continuation = {
    persisted: (episode.snapshots || []).length >= 2 && episode.lastSeenDate > episode.firstSeenDate,
    snapshots: (episode.snapshots || []).length,
  };

  // Consequence: a material move actually followed.
  const consequence = { materialMove: postMove >= MATERIAL_MOVE_PCT, mfe: round(forward.mfe), mae: round(forward.mae) };

  // Direction: ONLY when the snapshot explicitly declared a side (bullish/bearish ticker).
  let direction = { declared: false };
  const declared = fs.category === 'ticker' && (fs.sentiment === 'bullish' || fs.sentiment === 'bearish');
  if (declared && excess5 != null) {
    const wantUp = fs.sentiment === 'bullish';
    direction = { declared: true, side: wantUp ? 'long' : 'short', excess5, correct: wantUp ? excess5 > 0 : excess5 < 0 };
  }

  // Contrarian: separate from direction. Crowded names "should" underperform.
  let contrarian = { applicable: false };
  if ((fs.crowding === 'crowded' || fs.crowding === 'capitulation') && excess5 != null) {
    contrarian = { applicable: true, crowding: fs.crowding, underperformed: excess5 < 0, excess5 };
  }

  return { ...base, gradable: true, entry: round(entry), perHorizon, awareness, continuation, consequence, direction, contrarian };
}

/**
 * Aggregate graded outcomes into class stats with Wilson bounds + insufficient-sample
 * SUPPRESSION. PURE. Grouped by INDEPENDENT decision date so same-day clusters don't
 * inflate n. No probability is surfaced until effective n ≥ minSample.
 */
function summarizePulseOutcomes(outcomes, { minSample = 20 } = {}) {
  const gradable = (outcomes || []).filter(o => o && o.gradable);
  const distinctDates = new Set(gradable.map(o => o.firstSeenDate)).size;

  const tally = arr => {
    const n = arr.length;
    const succ = arr.filter(Boolean).length;
    return wilson(succ, n);
  };
  const awareness = tally(gradable.map(o => o.awareness && o.awareness.detectedAhead));
  const consequence = tally(gradable.map(o => o.consequence && o.consequence.materialMove));
  const continuation = tally(gradable.map(o => o.continuation && o.continuation.persisted));

  const dir = gradable.filter(o => o.direction && o.direction.declared);
  const directional = tally(dir.map(o => o.direction.correct));
  const contra = gradable.filter(o => o.contrarian && o.contrarian.applicable);
  const contrarian = tally(contra.map(o => o.contrarian.underperformed));

  // Effective independent sample = distinct decision dates, the honest unit for claims.
  const enoughFor = w => distinctDates >= minSample && w.n >= minSample;
  const claim = (w, label) => ({
    ...w,
    status: w.n === 0 ? 'Insufficient history' : (enoughFor(w) ? 'Measured' : 'Collecting evidence'),
    // A probability is ONLY meaningful once the sample clears the floor.
    probability: enoughFor(w) ? w.rate : null,
    label,
  });

  return {
    total: gradable.length,
    distinctDates,
    minSample,
    directionalValueProven: false,   // never claimed automatically — requires explicit review
    awareness: claim(awareness, 'Detected ahead of the move'),
    consequence: claim(consequence, 'Material move followed'),
    continuation: claim(continuation, 'Narrative persisted'),
    directional: { ...claim(directional, 'Declared direction correct (SPY-relative, 5-session)'), benchmark: 'SPY', horizon: '5 sessions' },
    contrarian: claim(contrarian, 'Crowded names underperformed SPY'),
  };
}

module.exports = { wilson, gradeEpisode, summarizePulseOutcomes, MATERIAL_MOVE_PCT };

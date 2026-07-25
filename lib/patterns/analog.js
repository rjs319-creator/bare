// HISTORICAL ANALOG ENGINE — point-in-time, leakage-safe nearest-neighbour search.
//
// Given a CURRENT pattern (normalized path + context), find the closest historical windows
// that STRICTLY PREDATE the query timestamp, then — if those windows have resolved forward
// outcomes — report the empirical target-first rate against a matched-control baseline.
//
// LEAKAGE GUARANTEES (all enforced here, not by convention):
//   1. Only records with asOfDate < queryDate are eligible (no future information).
//   2. A stock can never match a window of its OWN history that overlaps or post-dates the
//      query (guards against a name matching its own future).
//   3. Overlapping windows from the same ticker collapse to ONE effective sample — the
//      reported effectiveSampleSize is the de-overlapped count, never the raw duplicate
//      count (overlapping windows are near-duplicates, not independent evidence).
//
// The core is PURE and operates over provided arrays. Building/caching the corpus (a
// versioned, precomputed analog index) is the route/offline job — a live request must not
// brute-force the archive.

const S = require('./similarity');

const isNum = v => typeof v === 'number' && isFinite(v);
const round = (v, p = 4) => (isNum(v) ? Math.round(v * 10 ** p) / 10 ** p : null);

// Similarity between the query and one historical analog record. Blends normalized-path
// correlation with context agreement (regime/vol). Volume/geometry can be layered in as the
// corpus grows richer; kept lean for v1.
function analogSimilarity(query, record) {
  const pathCorr = S.pathCorrelation(query.path, record.path);
  const parts = [];
  if (isNum(pathCorr)) parts.push({ v: (pathCorr + 1) / 2, w: 0.7 });
  if (query.context && record.context) {
    const ctx = contextAgreement(query.context, record.context);
    if (isNum(ctx)) parts.push({ v: ctx, w: 0.3 });
  }
  if (!parts.length) return null;
  const wsum = parts.reduce((a, b) => a + b.w, 0);
  return round(parts.reduce((a, b) => a + b.v * b.w, 0) / wsum);
}

function contextAgreement(a, b) {
  const parts = [];
  if (a.marketRegime && b.marketRegime) parts.push(a.marketRegime === b.marketRegime ? 1 : 0.4);
  if (isNum(a.volPercentile) && isNum(b.volPercentile)) parts.push(1 - Math.min(1, Math.abs(a.volPercentile - b.volPercentile) / 100));
  if (!parts.length) return null;
  return parts.reduce((x, y) => x + y, 0) / parts.length;
}

// Strict date compare on 'YYYY-MM-DD' (or ISO) strings.
function before(dateA, dateB) {
  if (!dateA || !dateB) return false;
  return String(dateA) < String(dateB);
}

// De-overlap same-ticker analogs: keep the best-similarity record per ticker within an
// overlap window (in days). Returns the reduced list — its length is the effective N.
function deOverlap(sorted, overlapDays = 20) {
  const keptByTicker = new Map();
  const result = [];
  for (const r of sorted) { // sorted desc by similarity already
    const list = keptByTicker.get(r.ticker) || [];
    const clashes = list.some(kept => Math.abs(dayDiff(kept.asOfDate, r.asOfDate)) < overlapDays);
    if (clashes) continue;
    list.push(r);
    keptByTicker.set(r.ticker, list);
    result.push(r);
  }
  return result;
}

function dayDiff(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!isNum(ta) || !isNum(tb)) return Infinity;
  return (ta - tb) / 86400000;
}

// Find analogs for a query pattern.
//   query   : { path, context, family, direction, ticker, queryDate }
//   corpus  : [{ ticker, asOfDate, path, context, family, direction, outcome? }]
//             outcome (optional, resolved): { targetFirst:bool, netReturnPct, excessPct, ... }
//   controls: optional resolved records for the SAME regime WITHOUT the pattern (matched
//             baseline). If absent, baselineRate is null (we do not fabricate a baseline).
//   opts    : { minSim, maxAnalogs, overlapDays, minEffectiveN, sameFamilyOnly }
function findAnalogs(query, corpus = [], { controls = null, minSim = 0.6, maxAnalogs = 200, overlapDays = 20, minEffectiveN = 30, sameFamilyOnly = true } = {}) {
  if (!query || !Array.isArray(query.path) || query.path.length < 2) {
    return { available: false, reason: 'no-query-path', effectiveSampleSize: 0 };
  }
  const eligible = (corpus || []).filter(r => {
    if (!r || !Array.isArray(r.path)) return false;
    if (!before(r.asOfDate, query.queryDate)) return false;                 // guarantee 1
    if (r.ticker && query.ticker && r.ticker === query.ticker && !before(r.asOfDate, query.queryDate)) return false; // redundant belt+braces
    if (sameFamilyOnly && query.family && r.family && r.family !== query.family) return false;
    if (query.direction && r.direction && r.direction !== query.direction) return false;
    return true;
  });

  // Guarantee 2: a same-ticker record whose window would overlap/post-date the query is
  // dropped even if asOfDate < queryDate (its window can extend past the query).
  const queryDate = query.queryDate;
  const safe = eligible.filter(r => !(r.ticker === query.ticker && dayDiff(queryDate, r.asOfDate) < overlapDays));

  const scored = safe
    .map(r => ({ ...r, similarity: analogSimilarity(query, r) }))
    .filter(r => isNum(r.similarity) && r.similarity >= minSim)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, maxAnalogs);

  const rawCount = scored.length;
  const deduped = deOverlap(scored, overlapDays);           // guarantee 3
  const effectiveSampleSize = deduped.length;

  const resolved = deduped.filter(r => r.outcome && typeof r.outcome.targetFirst === 'boolean');
  const targetFirstRate = resolved.length ? round(resolved.filter(r => r.outcome.targetFirst).length / resolved.length) : null;

  let baselineRate = null;
  if (Array.isArray(controls) && controls.length) {
    const cr = controls.filter(c => c && c.outcome && typeof c.outcome.targetFirst === 'boolean' && before(c.asOfDate, queryDate));
    if (cr.length) baselineRate = round(cr.filter(c => c.outcome.targetFirst).length / cr.length);
  }

  // Representative examples (only from resolved, de-overlapped analogs).
  const successExamples = resolved.filter(r => r.outcome.targetFirst).slice(0, 3).map(slimAnalog);
  const failureExamples = resolved.filter(r => !r.outcome.targetFirst).slice(0, 3).map(slimAnalog);

  // Calibration is only asserted with enough resolved, de-overlapped, leakage-safe samples.
  const calibrated = resolved.length >= minEffectiveN && targetFirstRate != null;

  return {
    available: rawCount > 0,
    rawCount,
    effectiveSampleSize,
    resolvedCount: resolved.length,
    targetFirstRate,
    baselineRate,
    incrementalLift: isNum(targetFirstRate) && isNum(baselineRate) ? round(targetFirstRate - baselineRate) : null,
    calibrated,
    sufficient: effectiveSampleSize >= minEffectiveN,
    successExamples,
    failureExamples,
    topSimilarity: scored.length ? scored[0].similarity : null,
  };
}

function slimAnalog(r) {
  return { ticker: r.ticker, asOfDate: r.asOfDate, similarity: r.similarity, outcome: r.outcome ? { targetFirst: r.outcome.targetFirst, netReturnPct: r.outcome.netReturnPct ?? null, excessPct: r.outcome.excessPct ?? null } : null };
}

module.exports = { findAnalogs, analogSimilarity, deOverlap, before, dayDiff };

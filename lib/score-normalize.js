'use strict';
// SCORE COMPARABILITY + AN EXPLICIT MERGE MODEL (non-daytrade redesign 2026-08, Phase 9).
//
// THE DEFECT THIS CLOSES. The board combined heterogeneous 0–100 numbers as if they meant
// the same thing: an LLM's "confidence" in a read-through thesis, a technical composite, a
// virality score and a quant rank all entered `confidenceScore` on one scale, and a merge
// across sources took `Math.max(rawConfidence)` — so the single loudest source set the
// conviction for the merged row, and three correlated sources agreeing looked like strong
// independent confirmation.
//
// WHAT REPLACES IT.
//   1. WITHIN-SOURCE NORMALIZATION. A source's score is converted to its percentile inside
//      its OWN same-day cross-section — the only comparison that is defensible without a
//      calibrated model. Percentiles need a cross-section: below `MIN_CROSS_SECTION` rows
//      the value is SHRUNK toward neutral instead (an unknown scale must lose confidence,
//      not borrow someone else's).
//   2. AN EXPLICIT MERGE MODEL. conviction = a frozen per-source PRIOR applied to the best
//      normalized read, plus DISCOUNTED increments from additional sources, with a hard cap
//      so correlated agreement cannot manufacture conviction. Missing inputs are recorded
//      as missingness, never imputed.
//   3. A DECOMPOSITION. Every contribution is returned with its discount and reason, so an
//      expert can audit the number and a novice can be given one plain sentence.
//
// WHAT THIS IS NOT. It is not a calibration. A percentile is a RELATIVE SETUP SCORE, never
// a probability — see lib/rank-semantics.js for the labelling rule.
//
// DAY TRADE IS PINNED (user directive): its scores pass through untouched.
//
// Pure. No network, no state, no fitting: the priors and discounts are FROZEN constants,
// versioned with this file, and can only change by an explicit, reviewable edit.

const NORMALIZE_VERSION = 'score-normalize-v1';

// A source needs at least this many same-day rows before a percentile means anything.
const MIN_CROSS_SECTION = 8;
// Below that, the raw score is shrunk toward neutral by this factor (an unproven scale
// keeps its ORDER but loses its extremes).
const THIN_SHRINK = 0.5;
const NEUTRAL = 50;

// FROZEN per-source priors. NOT fitted — they encode what KIND of claim a source makes:
//   1.00 a source with an executable plan and a graded record
//   0.60 a lead-only source (information, no executable plan — see strategy-contracts)
//   0.40 an LLM/narrative read whose "confidence" is a generated number, not a measurement
// A prior is a CEILING on how much a source may contribute, never a booster.
const SOURCE_PRIOR = Object.freeze({
  screener: 1.0, ghost: 1.0, daytrade: 1.0, downday: 1.0, ignition: 1.0, momentum: 1.0,
  gapgo: 0.8, gapdown: 0.8, coil: 0.8, coremo: 0.8, emergingleader: 0.8,
  biotech: 0.6, optionsflow: 0.6, attention: 0.6,
  readthrough: 0.4, anomaly: 0.4, secondwave: 0.4, crossasset: 0.4, toneshift: 0.4, tone: 0.4,
});
const DEFAULT_PRIOR = 0.4;                 // an unregistered source is treated as a narrative read
const prior = (src) => (Object.prototype.hasOwnProperty.call(SOURCE_PRIOR, src) ? SOURCE_PRIOR[src] : DEFAULT_PRIOR);

// Increments from additional agreeing sources.
const SAME_FAMILY_DISCOUNT = 0.15;   // a second read of the SAME evidence family is nearly free information
const CROSS_FAMILY_CREDIT = 0.5;     // a genuinely different family still only counts half
const DECAY = 0.6;                   // each further source decays geometrically
const CAP_MULT = 1.25;               // total conviction may never exceed 1.25x the best single read
const LEAD_ONLY_PENALTY = 0.85;      // a row with no executable plan carries execution uncertainty

// Sources pinned to their existing behavior (frozen by user directive).
const PINNED = new Set(['daytrade']);

const num = (v) => (Number.isFinite(+v) && v !== null && v !== '' && typeof v !== 'boolean' ? +v : null);

// Percentile of `v` within `sorted` (ascending), as 0..100. Ties take the midpoint so a
// flat cross-section maps everything to the middle rather than to an arbitrary extreme.
function percentileOf(v, sorted) {
  let below = 0, equal = 0;
  for (const x of sorted) { if (x < v) below++; else if (x === v) equal++; }
  return ((below + equal / 2) / sorted.length) * 100;
}

// Normalize a batch of RAW signals within each source's own cross-section. Returns a new
// array (immutable) with `normalized` = { value, basis, sourceN, prior, missing }.
function normalizeSignals(signals, { minCrossSection = MIN_CROSS_SECTION } = {}) {
  const bySource = new Map();
  for (const s of signals || []) {
    if (!s || !s.source) continue;
    if (!bySource.has(s.source)) bySource.set(s.source, []);
    const v = num(s.rawConfidence);
    if (v != null) bySource.get(s.source).push(v);
  }
  const sorted = new Map([...bySource.entries()].map(([k, v]) => [k, v.slice().sort((a, b) => a - b)]));
  return (signals || []).map(s => normalizeOne(s, sorted, minCrossSection));
}

function normalizeOne(s, sortedBySource, minCrossSection) {
  if (!s) return s;
  const raw = num(s.rawConfidence);
  const src = s.source;
  const p = prior(src);
  if (PINNED.has(src)) {
    return { ...s, normalized: { value: raw, basis: 'pinned (frozen source — passed through untouched)', sourceN: null, prior: 1, missing: raw == null } };
  }
  if (raw == null) {
    // MISSINGNESS INDICATOR: no score at all ⇒ neutral, flagged, and it can never boost.
    return { ...s, normalized: { value: NEUTRAL, basis: 'missing score — neutral, flagged, cannot boost', sourceN: 0, prior: p, missing: true } };
  }
  const pool = sortedBySource.get(src) || [];
  if (pool.length >= minCrossSection) {
    return { ...s, normalized: { value: +percentileOf(raw, pool).toFixed(1), basis: 'within-source percentile (same-day cross-section)', sourceN: pool.length, prior: p, missing: false } };
  }
  const shrunk = NEUTRAL + (raw - NEUTRAL) * THIN_SHRINK;
  return {
    ...s,
    normalized: {
      value: +shrunk.toFixed(1),
      basis: `cross-section of ${pool.length} < ${minCrossSection} — no percentile is meaningful, so the score is shrunk toward neutral (order kept, extremes removed)`,
      sourceN: pool.length, prior: p, missing: false,
    },
  };
}

// THE MERGE MODEL. members = the signals being merged for one (ticker, horizon, side).
// Returns { conviction, decomposition, capped, missing } — conviction is on the same 0..100
// scale the rest of the engine uses, so it is a drop-in for the old Math.max.
//   familyOf — signal → its evidence family (dependence axis)
function mergeConviction(members, { familyOf = (m) => m.family || 'priceTrend', leadOnly = () => false } = {}) {
  const rows = (members || []).filter(Boolean).map(m => ({
    source: m.source,
    value: m.normalized ? m.normalized.value : num(m.rawConfidence) ?? NEUTRAL,
    prior: m.normalized ? m.normalized.prior : prior(m.source),
    missing: !!(m.normalized && m.normalized.missing),
    family: familyOf(m),
    leadOnly: !!leadOnly(m),
  }));
  if (!rows.length) return { conviction: NEUTRAL, decomposition: [], capped: false, missing: true };

  // Best read first — by prior-weighted value, so a strong narrative read cannot outrank a
  // modest measured one purely on the size of a generated number.
  rows.sort((a, b) => (b.value * b.prior) - (a.value * a.prior));
  const best = rows[0];
  const decomposition = [];

  let conviction = NEUTRAL + (best.value - NEUTRAL) * best.prior;
  if (best.leadOnly) conviction = NEUTRAL + (conviction - NEUTRAL) * LEAD_ONLY_PENALTY;
  decomposition.push({
    source: best.source, role: 'base', normalized: best.value, prior: best.prior,
    contribution: +(conviction - NEUTRAL).toFixed(2),
    reason: `strongest prior-weighted read${best.leadOnly ? '; lead-only execution uncertainty applied' : ''}`,
  });

  const base = conviction;
  const seenFamilies = new Set([best.family]);
  let k = 0;
  for (const r of rows.slice(1)) {
    const sameFamily = seenFamilies.has(r.family);
    const credit = sameFamily ? SAME_FAMILY_DISCOUNT : CROSS_FAMILY_CREDIT;
    const decay = DECAY ** k;
    // Only the ABOVE-neutral part of an additional read can add conviction; a weak
    // agreeing source never lifts the row (and never lowers the base either — it simply
    // contributes nothing, which is what "no information" means).
    const raw = Math.max(0, r.value - NEUTRAL) * r.prior * credit * decay * (r.leadOnly ? LEAD_ONLY_PENALTY : 1);
    const add = r.missing ? 0 : raw;
    conviction += add;
    decomposition.push({
      source: r.source, role: 'increment', normalized: r.value, prior: r.prior,
      family: r.family, sameFamily, discount: credit, decay: +decay.toFixed(3),
      contribution: +add.toFixed(2),
      reason: r.missing ? 'no score — contributes nothing (missingness is not evidence)'
        : sameFamily ? `same evidence family as the base read — correlated, discounted to ${Math.round(credit * 100)}%`
          : `independent evidence family — credited at ${Math.round(credit * 100)}%`,
    });
    seenFamilies.add(r.family);
    k++;
  }

  // HARD CAP: correlated agreement can never manufacture conviction beyond CAP_MULT of the
  // best single read (and never beyond the scale).
  const ceiling = Math.min(100, NEUTRAL + (base - NEUTRAL) * CAP_MULT + (base <= NEUTRAL ? 0 : 0));
  const capped = conviction > ceiling;
  const finalConviction = Math.max(0, Math.min(100, capped ? ceiling : conviction));
  if (capped) {
    decomposition.push({ role: 'cap', contribution: +(ceiling - conviction).toFixed(2), reason: `capped at ${CAP_MULT}x the best single read — agreeing sources cannot compound into false conviction` });
  }
  return {
    version: NORMALIZE_VERSION,
    conviction: +finalConviction.toFixed(1),
    decomposition,
    capped,
    missing: rows.some(r => r.missing),
    sources: rows.length,
  };
}

// PLAIN-LANGUAGE explanation of a merged conviction, for the novice lane.
function explainConviction(merge) {
  if (!merge || !merge.decomposition || !merge.decomposition.length) return 'No comparable score was available for this name.';
  const base = merge.decomposition.find(d => d.role === 'base');
  const adds = merge.decomposition.filter(d => d.role === 'increment' && d.contribution > 0);
  const parts = [`Ranked mainly on the ${base.source} read (${base.normalized} out of 100 relative to that screener's own candidates today).`];
  if (adds.length) parts.push(`${adds.length} other source${adds.length > 1 ? 's' : ''} agree${adds.length > 1 ? '' : 's'}, counted at a discount because ${adds.every(a => a.sameFamily) ? 'they read the same kind of evidence' : 'agreement between screeners is rarely independent'}.`);
  else if (merge.sources > 1) parts.push('Other sources mention this name but add no new information.');
  if (merge.capped) parts.push('Agreement was capped — several screeners saying the same thing is not the same as several independent reasons.');
  parts.push('This is a relative setup score, not a probability.');
  return parts.join(' ');
}

module.exports = {
  NORMALIZE_VERSION, MIN_CROSS_SECTION, THIN_SHRINK, NEUTRAL,
  SOURCE_PRIOR, DEFAULT_PRIOR, SAME_FAMILY_DISCOUNT, CROSS_FAMILY_CREDIT, DECAY, CAP_MULT,
  LEAD_ONLY_PENALTY, PINNED,
  prior, percentileOf, normalizeSignals, normalizeOne, mergeConviction, explainConviction,
};

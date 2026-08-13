// Transparent baseline challenger (transparent-v1) — SHADOW, weight-0, frozen.
//
// The one multi-factor swing ranker in this repo whose weights were not fitted:
//   score = rank(sectorResidualMomentum126→21)
//         + rank(tightness20d)
//         − rank(extensionInATR)
//         − rank(idiosyncraticVolatility63d)
//         − rank(expectedRoundTripCost)
// Signs are economic priors declared before any evaluation; weights are EQUAL and
// may not be optimized during initial prospective testing (a fitted variant would
// be a different strategy under a different version). Ranks (not z-scores) — robust
// to the micro-cap outliers the z-score composites have to winsorize around, and
// cost sits INSIDE the score rather than being subtracted after ranking.
//
// The full cohort — including every rejected name with its reasons — is returned
// with the ranking denominator, because a selection is only interpretable relative
// to the population it was chosen from.
//
// DECLARED LIMITS (fail-closed where checkable, disclosed where not):
//   • no halt/corporate-action feed → untradeable-interval gate NOT implementable.
//     The compensating control is the STALENESS gate in scoreCohort: a name whose last
//     bar is more than GATES.MAX_STALE_SESSIONS cohort sessions behind the cross-section
//     is rejected ('stale-last-bar'), which is the shape a halt or a stopped feed takes
//     here. It is a proxy for an untradeable interval, not a substitute for the feed.
//   • sector residualization uses the sector ETF total return when candles are
//     supplied, else the market benchmark (labeled per name via `residualBasis`).

const { costBreakdown } = require('./costs');

const TRANSPARENT_VERSION = 'transparent-v1';

// Frozen eligibility gates — every constant declared here, never tuned in place.
const GATES = Object.freeze({
  MIN_BARS: 150,                 // 126→21 momentum window + slack
  MIN_DOLLAR_VOL: 3e6,           // the project's validated tradeable floor ($/day, 20d avg)
  MAX_EXTENSION_ATR: 6,          // volatility-scaled extension ceiling
  MAX_FAILED_BREAKOUTS_63D: 2,   // >2 failed breakouts in 63 sessions ⇒ repeated-failure veto
  MAX_STALE_SESSIONS: 3,         // last bar older than this many sessions vs cohort ⇒ stale
});

const r6 = x => (Number.isFinite(x) ? +x.toFixed(6) : null);

function sma(closes, n, end) {
  if (end + 1 < n) return null;
  let s = 0;
  for (let i = end - n + 1; i <= end; i++) s += closes[i];
  return s / n;
}

function atr(candles, n, end) {
  if (end < n) return null;
  let s = 0;
  for (let i = end - n + 1; i <= end; i++) {
    const c = candles[i], prev = candles[i - 1];
    s += Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  }
  return s / n;
}

function ret(closes, from, to) {
  return (closes[from] > 0 && Number.isFinite(closes[to])) ? closes[to] / closes[from] - 1 : null;
}

// Daily simple returns over the trailing `n` sessions ending at `end`.
function dailyReturns(closes, n, end) {
  const out = [];
  for (let i = Math.max(1, end - n + 1); i <= end; i++) {
    if (closes[i - 1] > 0) out.push(closes[i] / closes[i - 1] - 1);
  }
  return out;
}

function std(xs) {
  if (xs.length < 5) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

// Failed breakout: close crosses above the prior-20-session high, then closes back
// below that level within 3 sessions. Counted over the trailing 63 sessions.
function failedBreakouts63(candles, end) {
  const closes = candles.map(c => c.close);
  let fails = 0;
  const start = Math.max(21, end - 63);
  for (let i = start; i <= end; i++) {
    let hi = -Infinity;
    for (let j = i - 20; j < i; j++) hi = Math.max(hi, candles[j].high);
    if (closes[i - 1] <= hi && closes[i] > hi) {
      const back = Math.min(end, i + 3);
      for (let k = i + 1; k <= back; k++) {
        if (closes[k] < hi) { fails++; break; }
      }
    }
  }
  return fails;
}

// Per-name features, computed from contemporaneously available bars only.
// `benchCloses` = the residualization series (sector ETF when known, else market).
function computeFeatures(candles, benchCloses, { dollarVol = null } = {}) {
  const closes = candles.map(c => c.close);
  const end = closes.length - 1;
  const bEnd = benchCloses ? benchCloses.length - 1 : -1;

  // Momentum 126→21 (skip-month), residualized against the benchmark's same window.
  const own = (end >= 126) ? ret(closes, end - 126, end - 21) : null;
  const bench = (bEnd >= 126) ? ret(benchCloses, bEnd - 126, bEnd - 21) : null;
  const sectorResidualMomentum126To21 = (own != null && bench != null) ? own - bench : null;

  // 20-session tightness: negated normalized range — tighter (smaller range) ranks higher.
  let tightness20d = null;
  if (end >= 20) {
    let hi = -Infinity, lo = Infinity;
    for (let i = end - 19; i <= end; i++) { hi = Math.max(hi, candles[i].high); lo = Math.min(lo, candles[i].low); }
    const mid = (hi + lo) / 2;
    if (mid > 0) tightness20d = -((hi - lo) / mid);
  }

  // Extension above the 20-session mean, in ATR(14) units.
  const s20 = sma(closes, 20, end);
  const a14 = atr(candles, 14, end);
  const extensionInATR = (s20 != null && a14 > 0) ? (closes[end] - s20) / a14 : null;

  // Idiosyncratic volatility: std of (stock − bench) daily returns over 63 sessions.
  let idiosyncraticVolatility63d = null;
  if (benchCloses && end >= 63 && bEnd >= 63) {
    const rs = dailyReturns(closes, 63, end);
    const rb = dailyReturns(benchCloses, 63, bEnd);
    const n = Math.min(rs.length, rb.length);
    idiosyncraticVolatility63d = std(rs.slice(-n).map((x, i) => x - rb.slice(-n)[i]));
  }

  // Expected round-trip cost from the central cost model, liquidity-tiered.
  const tier = dollarVol == null ? 'small'
    : dollarVol >= 50e6 ? 'liquid' : dollarVol >= 10e6 ? 'mid' : dollarVol >= 3e6 ? 'small' : 'micro';
  const expectedRoundTripCost = costBreakdown(tier, { side: 'long' }).totalPct;

  return {
    sectorResidualMomentum126To21: r6(sectorResidualMomentum126To21),
    tightness20d: r6(tightness20d),
    extensionInATR: r6(extensionInATR),
    idiosyncraticVolatility63d: r6(idiosyncraticVolatility63d),
    expectedRoundTripCost: r6(expectedRoundTripCost),
    failedBreakouts63d: end >= 84 ? failedBreakouts63(candles, end) : null,
    costTier: tier,
  };
}

// Cross-sectional percentile ranks (0..1, ties averaged) over the ELIGIBLE cohort.
function percentileRanks(values) {
  const idx = values.map((v, i) => [v, i]).filter(([v]) => Number.isFinite(v));
  idx.sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length).fill(null);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = idx.length > 1 ? ((i + j) / 2) / (idx.length - 1) : 0.5;
    for (let k = i; k <= j; k++) out[idx[k][1]] = avg;
    i = j + 1;
  }
  return out;
}

// Frozen ablation arms — every arm scores the SAME eligible cohort on the same date.
// `frozenExisting` consumes an externally supplied production composite (never
// recomputed here); `frozenInverse` is the sign-flipped full model — the negative
// control the repo lacked (a harness that can't distinguish a model from its inverse
// is measuring exposure, not selection).
const ARMS = Object.freeze({
  full:                 r => r.mom + r.tight - r.ext - r.ivol - r.cost,
  residualMomentumOnly: r => r.mom,
  tightnessExtension:   r => r.tight - r.ext,
  lowVolOnly:           r => -r.ivol,
  frozenInverse:        r => -(r.mom + r.tight - r.ext - r.ivol - r.cost),
});

// Score one cross-section. `cohort` = [{ ticker, candles, dollarVol?, benchCloses?,
// residualBasis?, existingScore? }]. Returns the FULL denominator: every name with
// features, eligibility verdict + reasons, per-arm ranks for eligible names.
function scoreCohort(cohort, { asOf = null } = {}) {
  // STALENESS GATE (alpha-research pass 3). MAX_STALE_SESSIONS was declared in GATES and
  // never enforced — no rejection reason referenced it — while the module header claimed
  // "stale last bars are rejected via the freshness gate instead", offering that as the
  // compensating control for the missing halt/corporate-action feed. The stated
  // compensating control did not exist.
  //
  // Staleness is measured in COHORT sessions, which is what the constant says: build the
  // sorted set of distinct last-bar dates across the cohort, and count how many are newer
  // than a given row's own last bar. That needs no trading calendar and is exactly the
  // "behind the rest of the cross-section" notion the gate is for. A name whose feed has
  // stopped updating — the shape a halt or a delisting takes here — falls out.
  const lastBarOf = (c) => {
    const cd = Array.isArray(c && c.candles) ? c.candles : [];
    const last = cd.length ? cd[cd.length - 1] : null;
    return (last && (last.date || last.d)) ? String(last.date || last.d) : null;
  };
  // The session axis is the union of EVERY candle date in the cohort, not just the set of
  // last-bar dates. Using last bars alone made the measure depend on cohort size: with
  // three names there are at most three distinct last bars, so a badly stale name scored
  // "2 sessions behind" and slipped under the threshold. The union is a real trading-day
  // axis and behaves the same for a 3-name cohort as for a 3,000-name one.
  const axis = new Set();
  for (const c of (cohort || [])) {
    for (const cd of (Array.isArray(c && c.candles) ? c.candles : [])) {
      const d = cd && (cd.date || cd.d);
      if (d) axis.add(String(d));
    }
  }
  // asOf is a REFERENCE point, not an axis. It is folded in only when the candles
  // themselves are dated — otherwise a caller passing bare price arrays plus an asOf
  // would produce a one-element "axis" and every undated row would read as anomalous.
  const hasDatedCandles = axis.size > 0;
  if (asOf && hasDatedCandles) axis.add(String(asOf));
  const sessions = hasDatedCandles ? [...axis].sort() : [];
  const idxOf = new Map(sessions.map((d, i) => [d, i]));
  const newest = sessions.length ? sessions[sessions.length - 1] : null;
  const sessionsBehind = (date) => {
    if (!date || newest == null) return null;
    const i = idxOf.get(date);
    return i == null ? null : (sessions.length - 1) - i;
  };

  const rows = (cohort || []).map(c => {
    const reasons = [];
    const candles = Array.isArray(c.candles) ? c.candles : [];
    if (candles.length < GATES.MIN_BARS) reasons.push('insufficient-history');
    const f = candles.length >= 21 ? computeFeatures(candles, c.benchCloses || null, { dollarVol: c.dollarVol ?? null }) : null;
    if (!f || f.sectorResidualMomentum126To21 == null) reasons.push('momentum-uncomputable');
    if (c.dollarVol == null) reasons.push('liquidity-unknown');
    else if (c.dollarVol < GATES.MIN_DOLLAR_VOL) reasons.push('below-liquidity-floor');
    if (f && f.extensionInATR != null && f.extensionInATR > GATES.MAX_EXTENSION_ATR) reasons.push('over-extended');
    if (f && f.failedBreakouts63d != null && f.failedBreakouts63d > GATES.MAX_FAILED_BREAKOUTS_63D) reasons.push('repeated-failed-breakouts');
    if (f && (f.tightness20d == null || f.idiosyncraticVolatility63d == null)) reasons.push('feature-missing');
    // The gate applies only when the cohort HAS a session axis. Undated candles make
    // staleness unmeasurable, not bad — rejecting on absent metadata would turn a gap in
    // the input contract into a total veto and would empty the cohort for any caller that
    // scores on bare price arrays. But once peers ARE dated, a dateless row is genuinely
    // anomalous against them and is rejected.
    const lastBar = lastBarOf(c);
    const behind = sessionsBehind(lastBar);
    if (sessions.length > 0) {
      if (lastBar == null) reasons.push('last-bar-undated');
      else if (behind != null && behind > GATES.MAX_STALE_SESSIONS) reasons.push('stale-last-bar');
    }
    return {
      ticker: c.ticker,
      lastBar,
      sessionsBehind: behind,
      features: f,
      residualBasis: c.residualBasis || (c.benchCloses ? 'sector' : 'none'),
      existingScore: Number.isFinite(c.existingScore) ? c.existingScore : null,
      eligible: reasons.length === 0,
      rejectionReasons: reasons,
    };
  });

  const eligible = rows.filter(r => r.eligible);
  const rank = key => percentileRanks(eligible.map(r => r.features[key]));
  const mom = rank('sectorResidualMomentum126To21');
  const tight = rank('tightness20d');
  const ext = rank('extensionInATR');
  const ivol = rank('idiosyncraticVolatility63d');
  const cost = rank('expectedRoundTripCost');
  const existing = percentileRanks(eligible.map(r => r.existingScore));

  eligible.forEach((r, i) => {
    const ranks = { mom: mom[i], tight: tight[i], ext: ext[i], ivol: ivol[i], cost: cost[i] };
    r.ranks = ranks;
    r.scores = {};
    for (const [arm, fn] of Object.entries(ARMS)) r.scores[arm] = r6(fn(ranks));
    // Frozen existing composite rides along as its own arm when supplied.
    r.scores.frozenExisting = existing[i] != null ? r6(existing[i]) : null;
  });

  return {
    version: TRANSPARENT_VERSION,
    asOf,
    gates: GATES,
    arms: [...Object.keys(ARMS), 'frozenExisting'],
    cohortSize: rows.length,
    eligibleCount: eligible.length,
    rejectedCount: rows.length - eligible.length,
    // Full denominator: EVERY evaluated name, selected or not, with its reasons.
    cohort: rows,
    ranked: eligible.slice().sort((a, b) => (b.scores.full ?? -Infinity) - (a.scores.full ?? -Infinity)).map(r => r.ticker),
  };
}

module.exports = { TRANSPARENT_VERSION, GATES, ARMS, computeFeatures, percentileRanks, failedBreakouts63, scoreCohort };

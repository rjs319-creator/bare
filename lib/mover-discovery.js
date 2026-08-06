'use strict';
// STAGE 0 — FULL-MARKET HIGH-RECALL DISCOVERY.
//
// The question this layer answers is NOT "which stock should I buy" but "which stocks are
// doing something unusual RIGHT NOW". It is tuned for RECALL: a candidate needs to trip ONE
// lane, not all of them. Precision is the job of Stage 1 (explosion potential), Stage 2
// (structure) and Stage 3 (trade quality).
//
// SEVEN INDEPENDENT LANES, merged by ticker with the provenance preserved:
//   A PCT_MOVER              — largest current % changes, from +3% (not the legacy +8%)
//   B RVOL_MOVER             — session volume abnormal vs the time-of-day expectation
//   C VOLUME_ACCELERATION    — participation ACCELERATING vs the previous scan interval
//   D PRICE_ACCELERATION     — 5/15/30-minute returns, rising rather than decaying
//   E FRESH_CATALYST         — material news published recently
//   F LOW_FLOAT_DEMAND       — real float turning over on real dollar volume
//   G GAP_PREMARKET          — a gap with regular-session follow-through, or a reclaim
//
// COST DISCIPLINE: one bulk-quote snapshot covers the whole universe in ~10 provider
// requests (lib/quote-provider). Interval-over-interval acceleration comes from comparing
// this snapshot with the PREVIOUS one held in Blob state — not from thousands of per-symbol
// chart calls. Only the shortlist that survives the lanes is ever enriched with bars, float
// or news.
//
// EXPLICITLY ABSENT: any historical-average-volume hard block. A stock dormant for two years
// that suddenly trades $40M in an hour is exactly the candidate this system exists to find,
// and a 500k average-volume gate would delete it. Historical volume enters only as CONTEXT
// (the relative-volume baseline and a slippage input).

const { DISCOVERY, DISCOVERY_VERSION, SCHEMA_VERSION } = require('./lowfloat-config');
const { fetchBulkQuotes } = require('./quote-provider');

const MIN_MS = 60_000;

const LANES = Object.freeze({
  PCT_MOVER: 'PCT_MOVER',
  RVOL_MOVER: 'RVOL_MOVER',
  VOLUME_ACCELERATION: 'VOLUME_ACCELERATION',
  PRICE_ACCELERATION: 'PRICE_ACCELERATION',
  FRESH_CATALYST: 'FRESH_CATALYST',
  LOW_FLOAT_DEMAND: 'LOW_FLOAT_DEMAND',
  GAP_PREMARKET: 'GAP_PREMARKET',
});

const LANE_LABEL = Object.freeze({
  PCT_MOVER: 'Percent mover',
  RVOL_MOVER: 'Relative-volume mover',
  VOLUME_ACCELERATION: 'Volume accelerating',
  PRICE_ACCELERATION: 'Price accelerating',
  FRESH_CATALYST: 'Fresh catalyst',
  LOW_FLOAT_DEMAND: 'Low-float demand',
  GAP_PREMARKET: 'Gap with follow-through',
});

// ── Time-of-day volume expectation ───────────────────────────────────────────
// Relative volume mid-session cannot divide today's partial volume by a FULL-day average —
// that reads 0.2× at 10:15 on a name doing 5× its normal business. The expected fraction of a
// day's volume printed by minute-of-session follows the well-known U shape (heavy open,
// light midday, heavy close). This is a fixed, pre-registered curve — not a fitted one — and
// it is far closer to reality than linear pacing.
//
// Cumulative share of the regular session's volume by minutes since 09:30.
const VOLUME_CURVE = Object.freeze([
  [0, 0.000], [15, 0.090], [30, 0.150], [60, 0.245], [90, 0.320],
  [120, 0.385], [150, 0.440], [180, 0.492], [210, 0.542], [240, 0.592],
  [270, 0.645], [300, 0.703], [330, 0.775], [360, 0.865], [390, 1.000],
]);

// Linear interpolation on the curve; clamped to [0.02, 1] so an early-session divide can
// never explode toward infinity.
function expectedVolumeFraction(minutesSinceOpen) {
  const m = Math.max(0, Math.min(390, Number(minutesSinceOpen) || 0));
  for (let i = 1; i < VOLUME_CURVE.length; i++) {
    const [m0, f0] = VOLUME_CURVE[i - 1];
    const [m1, f1] = VOLUME_CURVE[i];
    if (m <= m1) {
      const t = m1 === m0 ? 0 : (m - m0) / (m1 - m0);
      return Math.max(0.02, Math.min(1, f0 + t * (f1 - f0)));
    }
  }
  return 1;
}

// Session-aware relative volume: today's cumulative volume ÷ (average full-day volume ×
// expected fraction printed by now). Null when either input is missing — never a fabricated 1.
function sessionRelativeVolume(sessionVolume, avgDailyVolume, minutesSinceOpen) {
  if (!(sessionVolume > 0) || !(avgDailyVolume > 0)) return null;
  const expected = avgDailyVolume * expectedVolumeFraction(minutesSinceOpen);
  if (!(expected > 0)) return null;
  return +(sessionVolume / expected).toFixed(2);
}

// ── Interval deltas from the previous snapshot ───────────────────────────────
// `prev` = { price, dayVolume, at } captured by the previous scan. Returns the per-interval
// return and volume, plus the acceleration ratios against the trailing interval averages the
// state carries. All null when there is no comparable prior observation.
function intervalDeltas(prev, quote, nowMs) {
  if (!prev || !Number.isFinite(prev.price) || !(prev.price > 0)) return null;
  const prevMs = Date.parse(prev.at);
  if (!Number.isFinite(prevMs) || nowMs <= prevMs) return null;
  const elapsedMin = (nowMs - prevMs) / MIN_MS;
  // A gap of more than an hour spans a data outage or a session boundary — not an interval.
  if (elapsedMin <= 0 || elapsedMin > 60) return null;
  const ret = quote.price > 0 ? (quote.price / prev.price - 1) : null;
  const vol = Number.isFinite(quote.dayVolume) && Number.isFinite(prev.dayVolume)
    ? Math.max(0, quote.dayVolume - prev.dayVolume) : null;
  return {
    elapsedMin: +elapsedMin.toFixed(2),
    intervalReturn: ret == null ? null : +ret.toFixed(5),
    intervalVolume: vol,
    // Per-minute normalization so a 3-minute and a 7-minute interval are comparable.
    returnPerMin: ret == null ? null : +(ret / elapsedMin).toFixed(6),
    volumePerMin: vol == null ? null : Math.round(vol / elapsedMin),
  };
}

// Rolling mean update used to carry a per-name baseline of interval activity across scans.
function rollingUpdate(prevMean, value, n, alpha = 0.25) {
  if (!Number.isFinite(value)) return prevMean;
  if (!Number.isFinite(prevMean) || !(n > 0)) return value;
  return prevMean * (1 - alpha) + value * alpha;
}

// ── Lane evaluation (pure) ───────────────────────────────────────────────────
// `input` describes ONE name at ONE instant. Returns the lanes it trips with the evidence
// that tripped them. Every threshold comes from DISCOVERY config — no literals here.
function evaluateLanes(input, cfg = DISCOVERY) {
  const {
    price, prevClose, sessionVolume, sessionDollarVolume, avgDailyVolume, minutesSinceOpen,
    open, dayChangePct, relativeVolume, fiveMinChange, fifteenMinChange, thirtyMinChange,
    volumeAcceleration, priorVolumeAcceleration, floatShares, floatUsable,
    catalystTier, catalystFreshnessMinutes, gapPct,
  } = input;

  const lanes = [];
  const evidence = {};

  // A — PERCENT MOVERS. Deliberately below the legacy explosive gate so a name at +4% that
  // is about to become +40% is already in the pool.
  if (Number.isFinite(dayChangePct) && dayChangePct >= cfg.PCT_MOVER_MIN) {
    lanes.push(LANES.PCT_MOVER);
    evidence.PCT_MOVER = { dayChangePct };
  }

  // B — RELATIVE-VOLUME MOVERS, on the time-of-day curve rather than linear pacing.
  if (Number.isFinite(relativeVolume) && relativeVolume >= cfg.RVOL_MIN) {
    lanes.push(LANES.RVOL_MOVER);
    evidence.RVOL_MOVER = { relativeVolume, minutesSinceOpen };
  }

  // C — VOLUME ACCELERATION. Participation must be RISING, not merely large: a name whose
  // recent interval volume is a multiple of its own trailing interval average.
  if (Number.isFinite(volumeAcceleration) && volumeAcceleration >= cfg.VOLUME_ACCEL_MIN) {
    lanes.push(LANES.VOLUME_ACCELERATION);
    evidence.VOLUME_ACCELERATION = {
      volumeAcceleration,
      accelerating: Number.isFinite(priorVolumeAcceleration) ? volumeAcceleration > priorVolumeAcceleration : null,
    };
  }

  // D — PRICE ACCELERATION. Any of the three horizons qualifies, but the evidence records
  // whether momentum is building or decaying so Stage 1 can tell an early move from a late one.
  const accelHit = (Number.isFinite(fiveMinChange) && fiveMinChange >= cfg.PRICE_ACCEL_5M_MIN)
    || (Number.isFinite(fifteenMinChange) && fifteenMinChange >= cfg.PRICE_ACCEL_15M_MIN);
  if (accelHit) {
    lanes.push(LANES.PRICE_ACCELERATION);
    // Building = the last 5 minutes carried more than a third of the last 15. Decaying
    // momentum still qualifies for DISCOVERY (recall), it just carries the flag.
    const building = Number.isFinite(fiveMinChange) && Number.isFinite(fifteenMinChange) && fifteenMinChange > 0
      ? fiveMinChange / fifteenMinChange > 1 / 3 : null;
    evidence.PRICE_ACCELERATION = { fiveMinChange, fifteenMinChange, thirtyMinChange, building };
  }

  // E — FRESH CATALYST. Tier 1-3 only; a dilutive financing or a social mention (tier 4) is
  // never a discovery reason on its own.
  if (Number.isFinite(catalystTier) && catalystTier <= 3
      && Number.isFinite(catalystFreshnessMinutes) && catalystFreshnessMinutes <= cfg.CATALYST_FRESH_MINUTES) {
    lanes.push(LANES.FRESH_CATALYST);
    evidence.FRESH_CATALYST = { catalystTier, catalystFreshnessMinutes };
  }

  // F — LOW-FLOAT DEMAND. Requires a USABLE float (never an UNKNOWN treated as small) plus
  // real turnover of it plus real dollars. This is the lane the app previously had no way to
  // express, because it only knew market capitalization.
  if (floatUsable && Number.isFinite(floatShares) && floatShares > 0 && Number.isFinite(sessionVolume)) {
    const turnover = sessionVolume / floatShares;
    if (turnover >= cfg.LOW_FLOAT_TURNOVER_MIN && (sessionDollarVolume || 0) >= cfg.MIN_SESSION_DOLLAR_VOLUME) {
      lanes.push(LANES.LOW_FLOAT_DEMAND);
      evidence.LOW_FLOAT_DEMAND = { floatShares, floatTurnover: +turnover.toFixed(3), sessionDollarVolume };
    }
  }

  // G — GAP WITH FOLLOW-THROUGH. A gap alone is not a discovery event; the regular session
  // must be holding or extending it (price at/above the open), which is what separates a
  // continuation from a gap-and-fade.
  if (Number.isFinite(gapPct) && gapPct >= cfg.GAP_MIN_PCT) {
    const holdingOpen = Number.isFinite(open) && Number.isFinite(price) ? price >= open * 0.995 : null;
    if (holdingOpen !== false) {
      lanes.push(LANES.GAP_PREMARKET);
      evidence.GAP_PREMARKET = { gapPct, open, holdingOpen };
    }
  }

  return { lanes, evidence };
}

// ── Snapshot → candidate rows ────────────────────────────────────────────────
// Pure. `quotes` are normalized provider rows; `baselines` supplies avgDailyVolume (context
// only); `state.byTicker` is the previous scan's observation per name; `floatByTicker` and
// `catalystByTicker` are optional pre-enrichments from a prior cycle.
function buildCandidates({
  quotes = [], baselines = {}, state = {}, floatByTicker = {}, catalystByTicker = {},
  now = new Date(), minutesSinceOpen = null, cfg = DISCOVERY,
} = {}) {
  const nowIso = new Date(now).toISOString();
  const nowMs = new Date(now).getTime();
  const prior = (state && state.byTicker) || {};
  const nextState = {};
  const candidates = [];
  const rejected = { belowPrice: 0, abovePrice: 0, noPrice: 0, staleQuote: 0, thinSession: 0, noLane: 0 };

  for (const q of quotes) {
    if (!q || !q.ticker) continue;
    const t = q.ticker;
    if (!Number.isFinite(q.price) || q.price <= 0) { rejected.noPrice++; continue; }
    if (q.price < cfg.MIN_PRICE) { rejected.belowPrice++; continue; }
    if (q.price > cfg.MAX_PRICE) { rejected.abovePrice++; continue; }

    // Quote integrity: a quote with NO provider timestamp is never stamped with server time,
    // and one older than the scan cadence cannot describe "right now".
    const quoteMs = q.asOf ? Date.parse(q.asOf) : NaN;
    const quoteAgeMs = Number.isFinite(quoteMs) ? nowMs - quoteMs : null;
    if (quoteAgeMs != null && quoteAgeMs > 15 * MIN_MS) { rejected.staleQuote++; continue; }

    const base = baselines[t] || {};
    const prevClose = Number.isFinite(q.prevClose) ? q.prevClose : (Number.isFinite(base.prevClose) ? base.prevClose : null);
    const dayChangePct = Number.isFinite(prevClose) && prevClose > 0
      ? +(((q.price / prevClose) - 1) * 100).toFixed(2) : null;
    const sessionVolume = Number.isFinite(q.dayVolume) ? q.dayVolume : null;
    const sessionDollarVolume = sessionVolume != null ? Math.round(sessionVolume * q.price) : null;
    const avgDailyVolume = Number.isFinite(q.avgVolume) ? q.avgVolume : (Number.isFinite(base.avgVol) ? base.avgVol : null);
    const gapPct = Number.isFinite(q.open) && Number.isFinite(prevClose) && prevClose > 0
      ? +(((q.open / prevClose) - 1) * 100).toFixed(2) : null;

    const prev = prior[t] || null;
    const deltas = intervalDeltas(prev, q, nowMs);

    // Per-name interval baselines, carried forward. `volMean` is the trailing average
    // interval volume PER MINUTE; the acceleration is the newest interval against it.
    const nObs = (prev && prev.n) || 0;
    const volMean = prev ? prev.volMean : null;
    const retMean = prev ? prev.retMean : null;
    const volumeAcceleration = deltas && deltas.volumePerMin != null && Number.isFinite(volMean) && volMean > 0
      ? +(deltas.volumePerMin / volMean).toFixed(2) : null;

    nextState[t] = {
      price: q.price,
      dayVolume: sessionVolume,
      at: q.asOf || nowIso,
      n: nObs + 1,
      volMean: deltas && deltas.volumePerMin != null ? rollingUpdate(volMean, deltas.volumePerMin, nObs) : volMean,
      retMean: deltas && deltas.returnPerMin != null ? rollingUpdate(retMean, Math.abs(deltas.returnPerMin), nObs) : retMean,
      lastAccel: volumeAcceleration,
      // Short trail of interval returns so 15/30-minute change can be reconstructed from
      // scan state alone when no bar fetch has happened yet.
      trail: [...((prev && prev.trail) || []), ...(deltas && deltas.intervalReturn != null
        ? [{ at: q.asOf || nowIso, r: deltas.intervalReturn, m: deltas.elapsedMin }] : [])].slice(-12),
    };

    const trail = nextState[t].trail;
    const fiveMinChange = deltas && deltas.intervalReturn != null ? +(deltas.intervalReturn * 100).toFixed(2) : null;
    const fifteenMinChange = trailReturnPct(trail, 15, nowMs);
    const thirtyMinChange = trailReturnPct(trail, 30, nowMs);

    const fl = floatByTicker[t] || null;
    const cat = catalystByTicker[t] || null;
    const relativeVolume = sessionRelativeVolume(sessionVolume, avgDailyVolume, minutesSinceOpen);

    const laneInput = {
      price: q.price, prevClose, sessionVolume, sessionDollarVolume, avgDailyVolume,
      minutesSinceOpen, open: q.open ?? null, dayChangePct, relativeVolume,
      fiveMinChange, fifteenMinChange, thirtyMinChange,
      volumeAcceleration, priorVolumeAcceleration: prev ? prev.lastAccel : null,
      floatShares: fl ? fl.floatShares : null,
      floatUsable: !!(fl && fl.usable && fl.floatShares > 0),
      catalystTier: cat ? cat.catalystTier : null,
      catalystFreshnessMinutes: cat ? cat.freshnessMinutes : null,
      gapPct,
    };
    const { lanes, evidence } = evaluateLanes(laneInput, cfg);
    if (!lanes.length) { rejected.noLane++; continue; }

    // CURRENT-SESSION tradeability floor — the ONLY liquidity gate at this stage, and it is
    // about today, not history. A name with no volume field at all (spark fallback) is NOT
    // rejected here: it passes with sessionDollarVolume=null and is flagged, because dropping
    // it would silently delete the whole universe whenever the volume-capable provider fails.
    if (sessionDollarVolume != null && sessionDollarVolume < cfg.MIN_SESSION_DOLLAR_VOLUME
        && !lanes.includes(LANES.FRESH_CATALYST)) {
      rejected.thinSession++;
      continue;
    }

    const firstSeen = prev && prev.firstDetectedAt ? prev.firstDetectedAt : nowIso;
    nextState[t].firstDetectedAt = firstSeen;
    nextState[t].priceAtFirstDetection = prev && prev.priceAtFirstDetection != null ? prev.priceAtFirstDetection : q.price;
    nextState[t].dayChangeAtFirstDetection = prev && prev.dayChangeAtFirstDetection != null ? prev.dayChangeAtFirstDetection : dayChangePct;

    candidates.push({
      schemaVersion: SCHEMA_VERSION,
      scoringVersion: DISCOVERY_VERSION,
      ticker: t,
      discoverySources: lanes,
      discoveryEvidence: evidence,
      firstDetectedAt: firstSeen,
      priceAtFirstDetection: nextState[t].priceAtFirstDetection,
      dayChangeAtFirstDetection: nextState[t].dayChangeAtFirstDetection,
      price: q.price,
      prevClose,
      open: q.open ?? null,
      dayChangePct,
      gapPct,
      fiveMinChange,
      fifteenMinChange,
      thirtyMinChange,
      currentSessionVolume: sessionVolume,
      currentSessionDollarVolume: sessionDollarVolume,
      relativeVolume,
      volumeAcceleration,
      avgDailyVolume,
      minutesSinceOpen,
      dataTimestamp: q.asOf || null,
      dataAgeMs: quoteAgeMs,
      volumeAvailable: sessionVolume != null,
      floatShares: fl ? fl.floatShares : null,
      floatTier: fl ? fl.floatTier : 'UNKNOWN',
      floatConfidence: fl ? fl.floatConfidence : 'LOW',
      floatTurnover: fl && fl.usable && fl.floatShares > 0 && sessionVolume != null
        ? +(sessionVolume / fl.floatShares).toFixed(3) : null,
      catalystTier: cat ? cat.catalystTier : null,
      catalystType: cat ? cat.catalystType : null,
      catalystFreshnessMinutes: cat ? cat.freshnessMinutes : null,
    });
  }

  // Carry forward state for names that did NOT quote this scan, so a one-scan provider gap
  // does not reset their first-detection time or interval baselines.
  for (const [t, s] of Object.entries(prior)) {
    if (!nextState[t]) nextState[t] = s;
  }

  return { candidates, nextState: { byTicker: nextState, updatedAt: nowIso }, rejected };
}

// Sum the trailing interval returns inside a window (minutes) into a percent change.
function trailReturnPct(trail, windowMin, nowMs) {
  if (!Array.isArray(trail) || !trail.length) return null;
  const cutoff = nowMs - windowMin * MIN_MS;
  const inWindow = trail.filter(x => Date.parse(x.at) >= cutoff);
  if (!inWindow.length) return null;
  // Compound the interval returns — summing them understates a fast move.
  const compounded = inWindow.reduce((acc, x) => acc * (1 + (x.r || 0)), 1) - 1;
  return +(compounded * 100).toFixed(2);
}

// ── Ranking for the enrichment budget ────────────────────────────────────────
// This is NOT a quality score. It decides which candidates get the expensive Stage 1-2
// enrichment first, and it deliberately rewards BREADTH of evidence (a name tripping four
// lanes is more likely to be a genuine event than one tripping a single loose threshold).
function discoveryPriority(c) {
  let p = 0;
  p += (c.discoverySources || []).length * 12;
  if (Number.isFinite(c.relativeVolume)) p += Math.min(25, c.relativeVolume * 3);
  if (Number.isFinite(c.volumeAcceleration)) p += Math.min(20, c.volumeAcceleration * 4);
  if (Number.isFinite(c.dayChangePct)) p += Math.min(20, Math.max(0, c.dayChangePct) * 0.6);
  if (Number.isFinite(c.fiveMinChange)) p += Math.min(15, Math.max(0, c.fiveMinChange) * 3);
  if (Number.isFinite(c.floatTurnover)) p += Math.min(20, c.floatTurnover * 10);
  if (Number.isFinite(c.catalystTier)) p += (4 - c.catalystTier) * 5;
  // Dollar volume is a TIE-BREAK, not a gate — a thin name that trips four lanes still
  // outranks a deep one that trips one.
  if (Number.isFinite(c.currentSessionDollarVolume)) p += Math.min(10, Math.log10(Math.max(1, c.currentSessionDollarVolume)) - 5);
  return +p.toFixed(2);
}

function rankCandidates(candidates, { cap = DISCOVERY.DISCOVERY_CANDIDATE_CAP } = {}) {
  const ranked = [...candidates]
    .map(c => ({ ...c, discoveryPriority: discoveryPriority(c) }))
    .sort((a, b) => b.discoveryPriority - a.discoveryPriority || (a.ticker < b.ticker ? -1 : 1))
    .map((c, i) => ({ ...c, discoveryRank: i + 1 }));
  return { ranked: ranked.slice(0, cap), truncated: Math.max(0, ranked.length - cap), all: ranked };
}

// ── Network orchestration ────────────────────────────────────────────────────
// One bulk snapshot over the eligible universe. Returns candidates + the next scan state +
// an honest coverage report. Never throws: a provider failure yields zero candidates and a
// coverage record that says why.
async function runMoverDiscovery({
  universe = [], baselines = {}, state = {}, floatByTicker = {}, catalystByTicker = {},
  now = new Date(), minutesSinceOpen = null, cfg = DISCOVERY, t0 = Date.now(),
} = {}) {
  const started = Date.now();
  const symbols = universe
    .map(u => (typeof u === 'string' ? u : u && u.symbol))
    .filter(Boolean)
    .slice(0, cfg.UNIVERSE_QUOTE_CAP);

  if (!symbols.length) {
    return {
      candidates: [], nextState: state, coverage: {
        universeSize: 0, bulkQuotesReceived: 0, candidatesDiscovered: 0, provider: null,
        volumeAvailable: false, elapsedMs: Date.now() - started, error: 'empty universe',
      },
    };
  }

  let rows = [], quoteCoverage = { provider: null, returned: 0, volumeAvailable: false };
  try {
    const bulk = await fetchBulkQuotes(symbols);
    rows = bulk.rows || [];
    quoteCoverage = bulk.coverage || quoteCoverage;
  } catch (e) {
    return {
      candidates: [], nextState: state, coverage: {
        universeSize: symbols.length, bulkQuotesReceived: 0, candidatesDiscovered: 0,
        provider: null, volumeAvailable: false, elapsedMs: Date.now() - started,
        error: String((e && e.message) || e),
      },
    };
  }

  const built = buildCandidates({ quotes: rows, baselines, state, floatByTicker, catalystByTicker, now, minutesSinceOpen, cfg });
  const { ranked, truncated, all } = rankCandidates(built.candidates, { cap: cfg.DISCOVERY_CANDIDATE_CAP });

  const laneCounts = {};
  for (const c of all) for (const l of c.discoverySources) laneCounts[l] = (laneCounts[l] || 0) + 1;

  return {
    candidates: ranked,
    allCandidates: all,
    nextState: built.nextState,
    coverage: {
      universeSize: symbols.length,
      bulkQuotesReceived: rows.length,
      quoteCoveragePct: symbols.length ? +((rows.length / symbols.length) * 100).toFixed(1) : null,
      candidatesDiscovered: all.length,
      candidatesReturned: ranked.length,
      truncatedByCap: truncated,
      laneCounts,
      rejected: built.rejected,
      provider: quoteCoverage.provider,
      volumeAvailable: !!quoteCoverage.volumeAvailable,
      volumeCoveragePct: quoteCoverage.volumeCoveragePct ?? null,
      diagnostics: quoteCoverage.diagnostics || null,
      hasPriorSnapshot: !!(state && state.byTicker && Object.keys(state.byTicker).length),
      elapsedMs: Date.now() - started,
      deadlineExceeded: Date.now() - t0 > cfg.REQUEST_DEADLINE_MS,
      note: quoteCoverage.volumeAvailable
        ? null
        : 'The quote provider returned NO volume this scan — the relative-volume, volume-acceleration and low-float-turnover lanes are inactive, so recall is materially reduced. Percent, price-acceleration, gap and catalyst lanes still ran.',
      scoringVersion: DISCOVERY_VERSION,
      schemaVersion: SCHEMA_VERSION,
    },
  };
}

module.exports = {
  LANES, LANE_LABEL, VOLUME_CURVE,
  expectedVolumeFraction, sessionRelativeVolume, intervalDeltas, rollingUpdate, trailReturnPct,
  evaluateLanes, buildCandidates, discoveryPriority, rankCandidates, runMoverDiscovery,
  DISCOVERY_VERSION,
};

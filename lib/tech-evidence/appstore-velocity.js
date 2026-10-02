'use strict';
// Tech Operational Evidence — app-store review-velocity acceleration (pure math).
//
// Store rating counts are CUMULATIVE counters snapshotted once a night (FOLDS.appstore →
// bucket.ratings[day] = count). From them:
//   velocity(end)      = (count(end) − count(end−30)) / span × 30   reviews per 30 days
//   recentGrowth(end)  = velocity(end) / velocity(end−30) − 1        scale-free acceleration
//   ownExpected        = median of recentGrowth at the 12 prior weekly cutoffs
//   surprise, z        = vs own history (robustZ: MAD-based, zero-MAD → null never ±Inf)
// Per-app z-scoring makes a 50M-rating app and a 50k-rating app comparable; the ticker
// composite averages the available platforms (iOS + Play) and degrades quality when one
// is missing. Nothing here reads a snapshot dated after the cutoff. Windows and thresholds
// are prespecified (hypothesis-registry row appstore-review-velocity-preearnings).

const { median } = require('../orbit-math');

const PARAMS = Object.freeze({
  windowDays: 30,           // velocity window
  toleranceDays: 3,         // a missed night may borrow the nearest EARLIER snapshot this far back
  baselineSamples: 12,      // weekly prior cutoffs for own history
  baselineStepDays: 7,
  minBaseline: 4,           // robustZ floor
  minVelocityPerDay: 1,     // a prior window with < 1 review/day has no meaningful growth ratio
  preEarningsMinSessions: 5,
  preEarningsMaxCalendarDays: 45,
});

const dayMs = 86400000;
const addDays = (iso, n) => new Date(new Date(iso + 'T00:00:00Z').getTime() + n * dayMs).toISOString().slice(0, 10);
const spanDays = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / dayMs);

// Nearest snapshot at or before `day` within tolerance — never after it.
function countAt(ratings, day) {
  for (let back = 0; back <= PARAMS.toleranceDays; back += 1) {
    const d = addDays(day, -back);
    const v = ratings[d];
    if (Number.isFinite(v)) return { day: d, value: v };
  }
  return null;
}

// Reviews per day over the window ending at `end` (null when either edge is missing).
function velocityAt(ratings, end) {
  const a = countAt(ratings || {}, end);
  const b = countAt(ratings || {}, addDays(end, -PARAMS.windowDays));
  if (!a || !b) return null;
  const span = spanDays(b.day, a.day);
  if (span <= 0) return null;
  return { perDay: (a.value - b.value) / span, startDay: b.day, endDay: a.day, span };
}

// Scale-free acceleration: growth of the latest 30-day velocity over the prior one.
function growthAt(ratings, end) {
  const recent = velocityAt(ratings, end);
  const prior = velocityAt(ratings, addDays(end, -PARAMS.windowDays));
  if (!recent || !prior) return null;
  if (prior.perDay < PARAMS.minVelocityPerDay) return null;
  return recent.perDay / prior.perDay - 1;
}

function platformSignal(bucket, cutoffDate) {
  const { robustZ } = require('./signals');
  const ratings = (bucket && bucket.ratings) || {};
  const recentGrowth = growthAt(ratings, cutoffDate);
  if (recentGrowth == null) return { available: false, reason: 'need two complete 30-day velocity windows of nightly snapshots before the cutoff' };
  const baseline = [];
  for (let k = 1; k <= PARAMS.baselineSamples; k += 1) {
    const g = growthAt(ratings, addDays(cutoffDate, -k * PARAMS.baselineStepDays));
    if (g != null) baseline.push(g);
  }
  if (baseline.length < PARAMS.minBaseline) {
    return { available: false, reason: `only ${baseline.length}/${PARAMS.minBaseline} usable baseline windows — velocity history still accruing` };
  }
  const ownExpected = median(baseline);
  const { z, mad: dispersion, reason: zReason } = robustZ(recentGrowth, baseline);
  const recent = velocityAt(ratings, cutoffDate);
  return {
    available: true, recentGrowth, ownExpected, surprise: recentGrowth - ownExpected, z, dispersion,
    baselineSamples: baseline.length, zReason,
    velocityPerDay: recent ? recent.perDay : null, window: recent ? `${recent.startDay}..${recent.endDay}` : null,
  };
}

const meanOf = (vals) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null);

// bucket: { platforms: { ios?: <series bucket>, android?: <series bucket> } }
function appstoreSignal(bucket, cutoffDate) {
  const platforms = (bucket && bucket.platforms) || {};
  const per = Object.entries(platforms).map(([platform, b]) => ({ platform, calc: platformSignal(b, cutoffDate) }));
  const usable = per.filter((p) => p.calc.available);
  if (!usable.length) {
    const reasons = per.map((p) => `${p.platform}: ${p.calc.reason}`);
    return { available: false, reason: reasons.length ? reasons.join('; ') : 'no store mapping snapshots for this ticker' };
  }
  const zs = usable.map((p) => p.calc.z).filter(Number.isFinite);
  const caveats = ['store ratings are a public engagement proxy, not downloads or revenue; counters can be restated by the store'];
  let quality = 'ok';
  if (usable.length < 2) { quality = 'degraded'; caveats.push(`only ${usable[0].platform} available — single-platform read`); }
  if (zs.length < usable.length) { quality = 'low'; caveats.push('zero dispersion on a platform — z undefined, not infinite'); }
  return {
    available: true,
    metricLabel: '30-day review-velocity growth vs own 12-week baseline (iOS + Play, z per app)',
    windows: Object.fromEntries(usable.map((p) => [p.platform, p.calc.window])),
    recentGrowth: meanOf(usable.map((p) => p.calc.recentGrowth)),
    ownExpected: meanOf(usable.map((p) => p.calc.ownExpected)),
    surprise: meanOf(usable.map((p) => p.calc.surprise)),
    z: zs.length ? meanOf(zs) : null,
    dispersion: meanOf(usable.map((p) => p.calc.dispersion).filter(Number.isFinite)),
    quality, caveats,
    coverage: { platforms: usable.map((p) => p.platform), velocityPerDay: Object.fromEntries(usable.map((p) => [p.platform, p.calc.velocityPerDay])) },
  };
}

// Pre-earnings annotation for appstore events: the hypothesis conditions on the signal
// arriving ≥5 sessions (≈7 calendar days) and ≤45 calendar days before the next report.
// `lookup(ticker)` → { earningsDate } | null (lib/fundamentals.fetchEarningsInfo); any
// failure is recorded as unavailable, never as "no earnings".
async function annotateEarnings(events, { lookup, now = new Date() } = {}) {
  const out = [];
  for (const e of events) {
    if (e.arm !== 'appstore') { out.push(e); continue; }
    let info = null;
    let note = null;
    try { info = await lookup(e.ticker); } catch (err) { note = `lookup unavailable: ${String((err && err.message) || err).slice(0, 80)}`; }
    const nextDate = info && /^\d{4}-\d{2}-\d{2}$/.test(String(info.earningsDate)) ? info.earningsDate : null;
    const calendarDaysUntil = nextDate ? spanDays(e.cutoffDate, nextDate) : null;
    const preEarningsWindow = calendarDaysUntil != null
      && calendarDaysUntil >= Math.ceil(PARAMS.preEarningsMinSessions * 7 / 5)
      && calendarDaysUntil <= PARAMS.preEarningsMaxCalendarDays;
    out.push(Object.freeze({
      ...e,
      earnings: { nextDate, calendarDaysUntil, preEarningsWindow, source: 'finnhub-calendar', checkedAt: now.toISOString(), note: nextDate ? null : (note || 'unavailable: no upcoming report date returned') },
    }));
  }
  return out;
}

module.exports = { PARAMS, addDays, spanDays, countAt, velocityAt, growthAt, platformSignal, appstoreSignal, annotateEarnings };

'use strict';
// Tech Operational Evidence — signal derivation (pure; reads series buckets, never the network).
//
// Core construction per the declared hypothesis:
//   recentGrowth      — growth over a COMPLETED recent window (partial periods excluded upstream)
//   ownExpected       — robust (median) expectation from the company's own prior windows only
//   surprise          — recentGrowth − ownExpected
//   peerMedianSurprise— median surprise among OTHER eligible mapped entities at the same cutoff
//   adjustedSurprise  — surprise − peerMedianSurprise
//   z                 — surprise / (1.4826 × MAD of own historical surprises); zero-MAD → null, never ±Inf
//
// No value computed here may use data unavailable at the cutoff: npm days ≤ cutoff−1,
// GitHub releases published ≤ cutoff, SEC facts FILED ≤ cutoff.

const { median, mad } = require('../orbit-math');
const SCHEMA = require('./schema');

const SIGNALS_VERSION = 'techev-signals-v1';

// Prespecified windows/thresholds — do not tune after seeing results.
const NPM = Object.freeze({ windowDays: 28, baselineSamples: 12, baselineStepDays: 7, minHistoryDays: 150, maxMissingPct: 10 });
const GH = Object.freeze({ windowDays: 84, baselineSamples: 12, baselineStepDays: 28, minSpanDays: 365 });
const SEC = Object.freeze({ freshFiledDays: 7, yoyToleranceDays: 20, minQuarters: 6 });
const ELIGIBLE_ABS_Z = 1.0;
const MAD_SCALE = 1.4826;

const dayMs = 86400000;
const addDays = (iso, n) => new Date(new Date(iso + 'T00:00:00Z').getTime() + n * dayMs).toISOString().slice(0, 10);
const spanDays = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / dayMs);

function robustZ(x, history) {
  const clean = history.filter(Number.isFinite);
  if (!Number.isFinite(x) || clean.length < 4) return { z: null, mad: null, reason: 'insufficient history for dispersion' };
  const m = mad(clean, median(clean));
  if (!Number.isFinite(m) || m <= 0) return { z: null, mad: 0, reason: 'zero dispersion (MAD=0) — z undefined, not infinite' };
  return { z: (x - median(clean)) / (MAD_SCALE * m), mad: m, reason: null };
}

// ── npm: download-growth surprise ────────────────────────────────────────────
function windowSum(points, endDate, days) {
  let sum = 0;
  let present = 0;
  for (let i = 0; i < days; i += 1) {
    const v = points[addDays(endDate, -i)];
    if (Number.isFinite(v)) { sum += v; present += 1; }
  }
  return { sum, present, missing: days - present };
}

function growthAt(points, endDate, days) {
  const recent = windowSum(points, endDate, days);
  const prior = windowSum(points, addDays(endDate, -days), days);
  if (prior.present < days * 0.9 || recent.present < days * 0.9 || prior.sum <= 0) return null;
  return recent.sum / prior.sum - 1;
}

function npmSignal(bucket, cutoffDate) {
  const points = (bucket && bucket.points) || {};
  const end = addDays(cutoffDate, -1); // day counts publish next day — cutoff sees ≤ cutoff−1
  const dates = Object.keys(points).filter((d) => d <= end).sort();
  const caveats = [];
  if (dates.length < NPM.minHistoryDays) {
    return { available: false, reason: `insufficient history: ${dates.length}/${NPM.minHistoryDays} complete days` };
  }
  const recentWin = windowSum(points, end, NPM.windowDays);
  const recentGrowth = growthAt(points, end, NPM.windowDays);
  if (recentGrowth == null) return { available: false, reason: 'recent/prior window incomplete or prior volume zero' };
  const baseline = [];
  for (let k = 1; k <= NPM.baselineSamples; k += 1) {
    const g = growthAt(points, addDays(end, -k * NPM.baselineStepDays), NPM.windowDays);
    if (g != null) baseline.push(g);
  }
  if (baseline.length < 6) return { available: false, reason: `only ${baseline.length}/6 usable baseline windows` };
  const ownExpected = median(baseline);
  const surprise = recentGrowth - ownExpected;
  const { z, mad: dispersion, reason: zReason } = robustZ(recentGrowth, baseline);
  const missingPct = (recentWin.missing / NPM.windowDays) * 100;
  let quality = 'ok';
  if (missingPct > NPM.maxMissingPct) { quality = 'degraded'; caveats.push(`${recentWin.missing} missing days in recent window`); }
  if (z == null) { quality = 'low'; caveats.push(zReason); }
  caveats.push('weekday seasonality is absorbed by whole-week (28-day) windows');
  return {
    available: true, metricLabel: '28-day download growth vs own 12-window baseline',
    windows: { recent: `${addDays(end, -(NPM.windowDays - 1))}..${end}`, baselineSamples: baseline.length },
    recentGrowth, ownExpected, surprise, z, dispersion, quality, caveats,
    coverage: { presentDays: recentWin.present, missingDays: recentWin.missing },
  };
}

// ── GitHub: release-cadence surprise ─────────────────────────────────────────
function releaseDays(bucket) {
  return Object.keys((bucket && bucket.releases) || {}).map((k) => k.split('|')[0]).sort();
}

function countIn(days, endDate, windowDays) {
  const start = addDays(endDate, -(windowDays - 1));
  return days.filter((d) => d >= start && d <= endDate).length;
}

function githubSignal(bucket, cutoffDate) {
  const days = releaseDays(bucket).filter((d) => d <= cutoffDate);
  if (!days.length) return { available: false, reason: 'no releases observed' };
  if (spanDays(days[0], cutoffDate) < GH.minSpanDays) {
    return { available: false, reason: `release history spans ${spanDays(days[0], cutoffDate)}d < ${GH.minSpanDays}d minimum` };
  }
  const recentCount = countIn(days, cutoffDate, GH.windowDays);
  const baseline = [];
  for (let k = 1; k <= GH.baselineSamples; k += 1) {
    const end = addDays(cutoffDate, -k * GH.baselineStepDays);
    if (end < days[0]) break;
    baseline.push(countIn(days, end, GH.windowDays));
  }
  if (baseline.length < 6) return { available: false, reason: `only ${baseline.length}/6 usable baseline windows` };
  const ownExpected = median(baseline);
  const surprise = recentCount - ownExpected;
  const { z, mad: dispersion, reason: zReason } = robustZ(recentCount, baseline);
  const caveats = ['release cadence measures producer investment, not customer demand directly'];
  let quality = 'ok';
  if (z == null) { quality = 'low'; caveats.push(zReason); }
  return {
    available: true, metricLabel: `${GH.windowDays}-day release count vs own baseline`,
    windows: { recent: `${addDays(cutoffDate, -(GH.windowDays - 1))}..${cutoffDate}`, baselineSamples: baseline.length },
    recentGrowth: recentCount, ownExpected, surprise, z, dispersion, quality, caveats,
    coverage: { releasesTotal: days.length },
  };
}

// ── SEC: revenue-growth acceleration (event-driven, filed-date PIT) ─────────
function factsAsOf(bucket, cutoffDate) {
  return Object.values((bucket && bucket.facts) || {}).filter((f) => f.filed && f.filed <= cutoffDate);
}

function quarterPair(quarters, endDate, offsetDays, tol) {
  return quarters.find((q) => Math.abs(spanDays(q.end, endDate) - offsetDays) <= tol) || null;
}

function revenueAcceleration(facts, cutoffDate) {
  const revenue = facts.filter((f) => f.measure === 'revenue' && f.start)
    .sort((a, b) => (a.end < b.end ? 1 : -1)); // newest first; earliest-filed value per period comes first from adapter
  const seen = new Set();
  const quarters = revenue.filter((q) => { // one value per period end: the first (original) filing
    if (seen.has(q.end)) return false;
    seen.add(q.end);
    return true;
  });
  if (quarters.length < SEC.minQuarters) return { available: false, reason: `only ${quarters.length}/${SEC.minQuarters} comparable quarters filed by cutoff` };
  const yoyAt = (q) => {
    const prior = quarterPair(quarters, q.end, 365, SEC.yoyToleranceDays);
    return prior && prior.val > 0 ? { yoy: q.val / prior.val - 1, prior } : null;
  };
  const accelSeries = [];
  for (let i = 0; i < quarters.length; i += 1) {
    const a = yoyAt(quarters[i]);
    const prevQ = quarterPair(quarters, quarters[i].end, 91, SEC.yoyToleranceDays);
    const b = prevQ ? yoyAt(prevQ) : null;
    if (a && b) accelSeries.push({ end: quarters[i].end, filed: quarters[i].filed, accel: a.yoy - b.yoy, yoy: a.yoy, prevYoy: b.yoy });
  }
  if (!accelSeries.length) return { available: false, reason: 'no comparable YoY quarter pairs (periods incomparable — rejected, not approximated)' };
  const latest = accelSeries[0];
  if (!latest.filed || spanDays(latest.filed, cutoffDate) > SEC.freshFiledDays || latest.filed > cutoffDate) {
    return { available: false, reason: `latest comparable quarter filed ${latest.filed || 'unknown'} — outside the ${SEC.freshFiledDays}-day event window`, stale: true };
  }
  const history = accelSeries.slice(1).map((x) => x.accel);
  const { z, mad: dispersion, reason: zReason } = robustZ(latest.accel, history);
  const caveats = ['derived only from directly tagged comparable quarters; amended values tracked as revisions'];
  let quality = 'ok';
  if (z == null) { quality = 'low'; caveats.push(zReason || 'insufficient acceleration history'); }
  return {
    available: true, metricLabel: 'YoY revenue growth acceleration (ΔYoY) at filing',
    windows: { latestQuarterEnd: latest.end, filed: latest.filed, baselineSamples: history.length },
    recentGrowth: latest.yoy, ownExpected: latest.prevYoy, surprise: latest.accel, z, dispersion, quality, caveats,
    coverage: { quarters: quarters.length },
  };
}

function secSignal(bucket, cutoffDate) {
  return revenueAcceleration(factsAsOf(bucket, cutoffDate), cutoffDate);
}

const ARM_DERIVERS = Object.freeze({ npm: npmSignal, github: githubSignal, sec: secSignal });

// ── cross-entity assembly with peer adjustment ───────────────────────────────
// entries: [{ ticker, entity, mappingId, mappingVersion, bucket }]
function deriveArmSignals(arm, entries, cutoffDate) {
  const derive = ARM_DERIVERS[arm];
  if (!derive) return [];
  const drafts = entries.map((e) => ({ ...e, calc: derive(e.bucket, cutoffDate) }));
  const usable = drafts.filter((d) => d.calc.available && Number.isFinite(d.calc.surprise));
  return drafts.map((d) => {
    const c = d.calc;
    const peers = usable.filter((u) => u.ticker !== d.ticker).map((u) => u.calc.surprise);
    const peerMedianSurprise = peers.length >= 2 ? median(peers) : null;
    const adjustedSurprise = c.available && Number.isFinite(c.surprise)
      ? (peerMedianSurprise != null ? c.surprise - peerMedianSurprise : c.surprise)
      : null;
    const caveats = [...(c.caveats || [])];
    if (c.available && peerMedianSurprise == null) caveats.push('fewer than 2 peers at this cutoff — peer adjustment unavailable, quality reduced');
    const quality = !c.available ? 'unavailable' : (peerMedianSurprise == null && c.quality === 'ok' ? 'degraded' : c.quality);
    const eligible = c.available && quality === 'ok' && Number.isFinite(c.z) && Math.abs(c.z) >= ELIGIBLE_ABS_Z;
    return Object.freeze({
      v: SIGNALS_VERSION, id: SCHEMA.signalId({ arm, ticker: d.ticker, cutoffDate }),
      arm, ticker: d.ticker, entity: d.entity, cutoffDate,
      mappingId: d.mappingId, mappingVersion: d.mappingVersion,
      available: !!c.available, unavailableReason: c.available ? null : c.reason,
      metricLabel: c.metricLabel || null, windows: c.windows || null,
      recentGrowth: c.recentGrowth ?? null, ownExpected: c.ownExpected ?? null,
      surprise: c.surprise ?? null, z: c.z ?? null, dispersion: c.dispersion ?? null,
      peerMedianSurprise, adjustedSurprise,
      quality, caveats, coverage: c.coverage || null,
      eligible, eligibleReason: eligible ? `|z| ≥ ${ELIGIBLE_ABS_Z} with ok quality` : (c.available ? `not eligible: quality=${quality}, z=${c.z == null ? 'null' : c.z.toFixed(2)}` : c.reason),
      direction: Number.isFinite(c.surprise) ? (c.surprise >= 0 ? 'positive' : 'negative') : null,
    });
  });
}

// Research Attention Score: SORT ORDER ONLY — abnormality × freshness × mapping quality.
// Explicitly NOT expected return, NOT conviction, NOT validated alpha.
const WEIGHT_FACTOR = { high: 1.0, medium: 0.8, low: 0.5 };
function attentionScore(signal, { monetizationWeight = 'medium', ageDays = 0 } = {}) {
  if (!signal.available || !Number.isFinite(signal.z)) return null;
  const abnormality = Math.min(Math.abs(signal.z), 4) / 4;
  const freshness = Math.max(0, 1 - ageDays / 10);
  const qualityFactor = signal.quality === 'ok' ? 1 : signal.quality === 'degraded' ? 0.6 : 0.3;
  return Math.round(100 * abnormality * freshness * qualityFactor * (WEIGHT_FACTOR[monetizationWeight] || 0.8));
}

module.exports = {
  SIGNALS_VERSION, NPM, GH, SEC, ELIGIBLE_ABS_Z,
  addDays, robustZ, windowSum, growthAt,
  npmSignal, githubSignal, secSignal, revenueAcceleration,
  deriveArmSignals, attentionScore,
};

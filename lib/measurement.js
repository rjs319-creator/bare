'use strict';
/**
 * Validated financial measurement — the data-to-claim boundary.
 *
 * A bare number cannot say whether it is a yield LEVEL, a percent price CHANGE, or a
 * basis-point SPREAD, and a template that guesses produces sentences like "2s10s curve
 * inverted at -0.22bp" from an IEF-vs-SHY relative ETF return of -0.22%. Every number
 * that feeds a factual sentence travels as a measurement that names its unit, what the
 * value means, the instrument it was read from, and whether that instrument is a proxy.
 *
 * Pure. No I/O. Templates call `supports()` and stay silent when it refuses.
 */

const UNITS = Object.freeze(['pct', 'pp', 'bp', 'price', 'index', 'ratio']);
// level            — the quantity itself (a yield of 4.20%, a VIX of 16)
// change           — the quantity's own move over `period`
// relative_return  — one instrument's return minus another's (never a spread level)
// spread           — a difference of two comparable LEVELS (10Y yield − 2Y yield)
const KINDS = Object.freeze(['level', 'change', 'relative_return', 'spread']);

const BP_PER_PP = 100;
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const round = (n, d = 2) => (isNum(n) ? +n.toFixed(d) : null);

/** Why a measurement is unusable, or [] when it is well-formed. */
function measurementProblems(m) {
  if (!m || typeof m !== 'object') return ['not_a_measurement'];
  const problems = [];
  if (!m.metricId || typeof m.metricId !== 'string') problems.push('missing_metric_id');
  if (!isNum(m.value)) problems.push('non_finite_value');
  if (!UNITS.includes(m.unit)) problems.push('unknown_unit');
  if (!KINDS.includes(m.kind)) problems.push('unknown_kind');
  if (!m.instrument || typeof m.instrument !== 'string') problems.push('missing_instrument');
  if (typeof m.isProxy !== 'boolean') problems.push('proxy_flag_missing');
  if (!m.source || typeof m.source !== 'string') problems.push('missing_source');
  return problems;
}

/**
 * Build a measurement. Never throws and never fills a gap: an invalid one comes back
 * with `valid:false` and its `problems`, so a caller cannot mistake it for data.
 */
function makeMeasurement({ metricId, value, unit, kind, period = null, instrument, isProxy, observedAt = null, source, coverage = null, inputs = null } = {}) {
  const m = {
    metricId: metricId || null,
    value: isNum(value) ? value : null,
    unit: unit || null,
    kind: kind || null,
    period,
    instrument: instrument || null,
    isProxy: typeof isProxy === 'boolean' ? isProxy : null,
    observedAt: observedAt || null,
    source: source || null,
    coverage,
    inputs,
  };
  const problems = measurementProblems(m);
  return { ...m, valid: problems.length === 0, problems };
}

/**
 * May this measurement back a claim that needs `unit` and `kind` from a NON-proxy
 * instrument? Returns { ok, reason }. This is the guard a sentence template calls.
 */
function supports(m, { unit, kind, allowProxy = false } = {}) {
  const problems = measurementProblems(m);
  if (problems.length) return { ok: false, reason: problems[0] };
  if (unit && m.unit !== unit) return { ok: false, reason: `unit_is_${m.unit}_not_${unit}` };
  if (kind && m.kind !== kind) return { ok: false, reason: `kind_is_${m.kind}_not_${kind}` };
  if (m.isProxy && !allowProxy) return { ok: false, reason: 'proxy_cannot_support_level_claim' };
  return { ok: true, reason: null };
}

/**
 * A yield-curve spread from two comparable yield LEVELS quoted in percent.
 * 10Y 4.20% − 2Y 4.42% = −0.22 percentage points = −22 bp.
 * Refuses proxies, non-levels, and yields observed on different dates.
 */
function yieldSpreadBp({ longLeg, shortLeg, metricId = 'UST_2S10S_SPREAD' } = {}) {
  for (const leg of [longLeg, shortLeg]) {
    const s = supports(leg, { unit: 'pct', kind: 'level' });
    if (!s.ok) return makeMeasurement({ metricId, value: null, unit: 'bp', kind: 'spread', instrument: 'unavailable', isProxy: false, source: `refused:${s.reason}` });
  }
  if (longLeg.observedAt !== shortLeg.observedAt) {
    return makeMeasurement({ metricId, value: null, unit: 'bp', kind: 'spread', instrument: 'unavailable', isProxy: false, source: 'refused:legs_observed_on_different_dates' });
  }
  return makeMeasurement({
    metricId,
    value: round((longLeg.value - shortLeg.value) * BP_PER_PP, 1),
    unit: 'bp',
    kind: 'spread',
    instrument: `${longLeg.instrument} minus ${shortLeg.instrument}`,
    isProxy: false,
    observedAt: longLeg.observedAt,
    source: longLeg.source === shortLeg.source ? longLeg.source : `${longLeg.source}+${shortLeg.source}`,
    inputs: [longLeg, shortLeg],
  });
}

const UNIT_SUFFIX = Object.freeze({ pct: '%', pp: ' pp', bp: ' bp', price: '', index: '', ratio: '' });

/** Render a value with its own unit. Returns null for an invalid measurement. */
function formatMeasurement(m, { signed = false } = {}) {
  if (measurementProblems(m).length) return null;
  const sign = signed && m.value > 0 ? '+' : '';
  return `${sign}${m.value}${UNIT_SUFFIX[m.unit]}`;
}

module.exports = { UNITS, KINDS, BP_PER_PP, makeMeasurement, measurementProblems, supports, yieldSpreadBp, formatMeasurement };

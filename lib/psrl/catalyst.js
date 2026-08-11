'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// PSRL addendum — point-in-time catalyst confirmation. PURE mapper.
//
// Consumes INJECTED catalyst events (the caller supplies whatever PIT feeds
// exist — 8-K / insider filing archives, earnings dates, revisions). Only
// events with firstSeenAt ≤ the decision timestamp count; nothing here
// fetches, and no old estimate revision is ever reconstructed from current
// estimates (that would be lookahead).
//
// DATA HONESTY (current plan, documented): quarterly analyst estimates,
// press releases and transcripts are 402-gated on the live FMP tier, so
// estimateRevision7d/30d and analystBreadth7d are structurally UNAVAILABLE
// today — they are emitted as null with reasons, never imputed. A catalyst
// is measured context, not assumed alpha: its incremental value is part of
// the registered psrl-predictive-layer ablation.
// ═══════════════════════════════════════════════════════════════════════════

const CATALYST_VERSION = 'psrl-catalyst-v1';

const CATALYST_TYPES = Object.freeze([
  'EARNINGS_SURPRISE', 'ESTIMATE_REVISION', 'GUIDANCE_CHANGE', 'EARNINGS_DATE_REVISION',
  'ANALYST_REVISION', 'PRICE_TARGET_CHANGE', 'SEC_8K', 'PRESS_RELEASE',
  'OFFERING_DILUTION', 'INSIDER_PURCHASE_CLUSTER', 'OTHER',
]);

const isNum = (x) => Number.isFinite(x);

function sessionsBetween(fromDate, toDate, calendarDates = null) {
  if (!fromDate || !toDate) return null;
  if (Array.isArray(calendarDates) && calendarDates.length) {
    const a = calendarDates.filter((d) => d > String(fromDate) && d <= String(toDate)).length;
    return a;
  }
  const ms = Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`);
  return isNum(ms) ? Math.max(0, Math.round(ms / 86400000 * 5 / 7)) : null;
}

/**
 * Catalyst features for one name at asOf.
 * events: [{type, direction ('positive'|'negative'|'neutral'), firstSeenAt,
 *           gapPct?, dilutionRisk?, binary?}] — PIT-stamped by the caller.
 */
function catalystFeatures({ events = [], asOf, calendarDates = null } = {}) {
  const pit = (events || []).filter((e) => e && e.firstSeenAt && String(e.firstSeenAt) <= String(asOf));
  const dropped = (events || []).length - pit.length;
  if (!pit.length) {
    return {
      version: CATALYST_VERSION, available: false,
      reason: dropped > 0 ? 'all-events-after-decision-timestamp' : 'no-catalyst-feed-wired',
      catalystSupportGrade: 'UNAVAILABLE',
      estimateRevision7d: null, estimateRevision30d: null, analystBreadth7d: null,
      unavailableReasons: {
        estimateRevisions: 'quarterly analyst-estimate history plan-gated (402) — never reconstructed from current estimates',
      },
      droppedFutureEvents: dropped,
    };
  }
  const latest = [...pit].sort((a, b) => (a.firstSeenAt < b.firstSeenAt ? 1 : -1))[0];
  const sessionsSince = sessionsBetween(latest.firstSeenAt, asOf, calendarDates);
  const dilution = pit.some((e) => e.type === 'OFFERING_DILUTION' || e.dilutionRisk);
  const binary = pit.some((e) => e.binary);
  const positive = pit.filter((e) => e.direction === 'positive').length;
  const negative = pit.filter((e) => e.direction === 'negative').length;
  let grade = 'WEAK';
  if (positive >= 2 && negative === 0) grade = 'STRONG';
  else if (positive > negative) grade = 'MODERATE';
  else if (negative > positive) grade = 'NEGATIVE';
  return {
    version: CATALYST_VERSION, available: true,
    catalystType: latest.type && CATALYST_TYPES.includes(latest.type) ? latest.type : 'OTHER',
    catalystDirection: latest.direction || 'neutral',
    firstSeenAt: latest.firstSeenAt,
    sessionsSinceCatalyst: sessionsSince,
    catalystGap: isNum(latest.gapPct) ? latest.gapPct : null,
    dilutionRisk: dilution,
    binaryEventRisk: binary,
    eventsConsidered: pit.length,
    droppedFutureEvents: dropped,
    catalystSupportGrade: grade,
    estimateRevision7d: null, estimateRevision30d: null, analystBreadth7d: null,
    unavailableReasons: {
      estimateRevisions: 'quarterly analyst-estimate history plan-gated (402) — never reconstructed from current estimates',
    },
  };
}

module.exports = { CATALYST_VERSION, CATALYST_TYPES, catalystFeatures };

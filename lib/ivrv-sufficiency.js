'use strict';
// COIL × IV/RV SAMPLE-SUFFICIENCY ACCOUNTING (ivrv-sample-v1).
//
// The daily archive was widened on 2026-07-01 specifically so Coil candidates
// (and their decile-stratified controls) get a same-day ATM implied-vol reading;
// the Coil ledger already carries each pick's own 20-bar realized vol. The
// planned experiment — does IV/RV level/change interact with compression to
// predict abnormal breaks? — pre-registered a bar of ≥150 MATURED joined picks
// (research/ALPHA-RESEARCH-2026-07.md #5) before ANY verdict may be drawn.
//
// Until now that bar lived only in a research markdown: nothing counted how many
// Coil picks actually have a same-date archived atmIV and a matured outcome, so
// "is the sample ready?" was a guess. This module is the machine check.
//
// Honesty rules:
//   - NO VERDICT HERE. This module counts evidence; it never computes the
//     experiment. status is INSUFFICIENT_SAMPLE until the pre-registered bar is
//     met, then READY_FOR_EVALUATION — never PASS/FAIL.
//   - Maturity is approximated on the calendar (sessions × 7/5 + weekend slack)
//     and labeled `maturable`, not `matured` — true maturity needs candles and
//     belongs to the experiment itself, which must re-verify.
//   - Archive truncation is DISCLOSED: a day's missing name is only evidence of
//     absence if the day recorded fewer names than its cap.
//
// Pure: ledgers in, frozen report out. No network, no clock — `asOf` supplied.

const IVRV_SAMPLE_VERSION = 'ivrv-sample-v1';

// Pre-registered evaluation bar (do not tune this against the accrued sample).
const MIN_MATURABLE_JOINED = 150;

// Coil's break horizon (sessions) and a calendar approximation for "maturable".
const COIL_HORIZON_SESSIONS = 10;
const MATURABLE_CALENDAR_DAYS = Math.ceil(COIL_HORIZON_SESSIONS * 7 / 5) + 2;

const num = (v) => (Number.isFinite(v) ? v : null);

function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}

// archiveDays: [{ date, records:[{ ticker, sources, options:{ atmIV } }], count, withOptions }]
// coilDays:    [{ date, picks:[{ ticker, dailyVol, selected, band, decile }] }]
function assessIvRvSample({ archiveDays = [], coilDays = [], asOf, minMaturable = MIN_MATURABLE_JOINED } = {}) {
  // Index the archive: date → ticker → atmIV (null-safe; absent options ≠ zero vol).
  const ivByDateTicker = new Map();
  const archiveMeta = new Map();
  for (const d of archiveDays) {
    if (!d || !d.date) continue;
    const m = new Map();
    for (const r of d.records || []) {
      if (r && r.ticker) m.set(String(r.ticker).toUpperCase(), num(r.options && r.options.atmIV));
    }
    ivByDateTicker.set(d.date, m);
    archiveMeta.set(d.date, { count: d.count ?? (d.records || []).length, withOptions: d.withOptions ?? null });
  }

  // Cohort classification: sampleKind is authoritative ('selected' vs
  // 'decile-stratified'); the boolean `selected` is the back-compat signal; rows
  // predating BOTH fields are UNKNOWN — never silently counted as selected.
  const cohortOf = (p) => {
    if (p.sampleKind === 'decile-stratified') return 'control';
    if (p.sampleKind === 'selected') return 'selected';
    if (p.selected === false) return 'control';
    if (p.selected === true) return 'selected';
    return 'unknown';
  };

  const perDay = [];
  const totals = { coilPicks: 0, joined: 0, joinedWithIv: 0, joinedWithRv: 0, usable: 0, maturable: 0, selectedUsable: 0, controlUsable: 0, unknownCohortUsable: 0 };
  for (const cd of coilDays) {
    if (!cd || !cd.date || !Array.isArray(cd.picks)) continue;
    const ivMap = ivByDateTicker.get(cd.date) || null;
    const meta = archiveMeta.get(cd.date) || null;
    let joined = 0, joinedWithIv = 0, usable = 0, maturableN = 0, sel = 0, ctl = 0, unk = 0;
    for (const p of cd.picks) {
      if (!p || !p.ticker) continue;
      totals.coilPicks++;
      const t = String(p.ticker).toUpperCase();
      const inArchive = !!(ivMap && ivMap.has(t));
      if (!inArchive) continue;
      joined++;
      const iv = ivMap.get(t);
      const rv = num(p.dailyVol);
      if (iv != null) joinedWithIv++;
      if (rv != null) totals.joinedWithRv++;
      if (iv != null && rv != null && rv > 0) {
        usable++;
        const maturable = asOf ? daysBetween(cd.date, asOf) >= MATURABLE_CALENDAR_DAYS : false;
        if (maturable) {
          maturableN++;
          const cohort = cohortOf(p);
          if (cohort === 'control') ctl++; else if (cohort === 'selected') sel++; else unk++;
        }
      }
    }
    totals.joined += joined;
    totals.joinedWithIv += joinedWithIv;
    totals.usable += usable;
    totals.maturable += maturableN;
    totals.selectedUsable += sel;
    totals.controlUsable += ctl;
    totals.unknownCohortUsable += unk;
    perDay.push({
      date: cd.date,
      coilPicks: cd.picks.length,
      archived: !!ivMap,
      joined, joinedWithIv, usable, maturable: maturableN,
      // Truncation disclosure: absence from a FULL archive day is not evidence
      // the name was unfetchable — the cap may simply have been reached.
      archiveCount: meta ? meta.count : null,
      archiveWithOptions: meta ? meta.withOptions : null,
    });
  }

  const joinedDates = perDay.filter(d => d.usable > 0).map(d => d.date).sort();
  const status = totals.maturable >= minMaturable ? 'READY_FOR_EVALUATION' : 'INSUFFICIENT_SAMPLE';

  // The pre-registered bar counts picks, but the experiment's design compares
  // selected vs CONTROL cohorts — a met bar with a starved control side must
  // say so loudly rather than let READY imply the comparison is runnable.
  const warnings = [];
  if (status === 'READY_FOR_EVALUATION' && totals.controlUsable < Math.max(20, minMaturable / 5)) {
    warnings.push(`control cohort starved: only ${totals.controlUsable} maturable control rows — the selected-vs-control comparison is not yet runnable despite the raw bar being met`);
  }
  if (totals.unknownCohortUsable > 0) {
    warnings.push(`${totals.unknownCohortUsable} maturable rows predate cohort labeling (no sampleKind/selected field) — usable for IV/RV level studies, unusable for the selected-vs-control comparison`);
  }

  return Object.freeze({
    version: IVRV_SAMPLE_VERSION,
    preRegisteredBar: { minMaturableJoined: minMaturable, source: 'research/ALPHA-RESEARCH-2026-07.md #5' },
    status,
    warnings: Object.freeze(warnings),
    verdict: null,   // ALWAYS null here — this module counts evidence, it never judges the hypothesis
    asOf: asOf || null,
    maturityApproximation: `calendar ≥${MATURABLE_CALENDAR_DAYS}d after pick date (≈${COIL_HORIZON_SESSIONS} sessions); the experiment must re-verify true maturity against candles`,
    totals,
    remaining: Math.max(0, minMaturable - totals.maturable),
    coverage: {
      coilDays: coilDays.length,
      archiveDays: archiveDays.length,
      joinableDays: joinedDates.length,
      firstJoinableDate: joinedDates[0] || null,
      lastJoinableDate: joinedDates[joinedDates.length - 1] || null,
    },
    perDay: Object.freeze(perDay),
  });
}

module.exports = {
  IVRV_SAMPLE_VERSION, MIN_MATURABLE_JOINED, COIL_HORIZON_SESSIONS, MATURABLE_CALENDAR_DAYS,
  assessIvRvSample,
};

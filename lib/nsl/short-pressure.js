'use strict';
// NOVEL SIGNAL LAB — Engine 1: securities-lending & short-pressure (short-pressure-v1).
//
// Short interest is NOT mechanically bearish or bullish — its meaning depends on the
// interaction of level, days-to-cover, borrow cost/availability and price behaviour
// (Drechsler-Drechsler NBER w20282; days-to-cover, NBER w21166). This engine reuses the
// FREE FINRA consolidated short-interest feed (lib/shortinterest.js) — a survivorship-safe,
// semi-monthly source — and models the pieces it can honestly see. The borrow-fee /
// utilization / real-time FTD inputs require a securities-lending data licence this
// deployment does NOT hold, so the sub-signals that depend on them (informed pressure,
// covering intensity, borrow constraint) are emitted UNAVAILABLE or EXPERIMENTAL, never
// faked as zero.
//
// PUBLICATION DELAY (acceptance criterion): FINRA publishes consolidated short interest
// ~8 business days AFTER the settlement date. A settlement dated D is therefore not public
// until ~D+12 calendar days. For any as-of decision earlier than that, the record is
// invisible. This is enforced here, not assumed.

const { fetchShortInterest, siFlag, SI_HIGH_PCT, DTC_HIGH } = require('../shortinterest');
const { makeEnvelope, unavailable, STATUS, DIRECTION, clamp01 } = require('./registry');
const { providerStatus } = require('./providers');

const PUBLICATION_DELAY_DAYS = 12; // conservative calendar delay from settlement to public availability
const daysBetween = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);

// PURE. Assess short pressure from a FINRA record as of `asOf`. `rec` = { si, dtc, adv }.
// Returns null if the record is not yet public at asOf (publication delay) or has no usable
// field. `borrow` (optional) = { feeBps, utilization } from a licensed provider — absent here.
function assessShortPressure(rec, { sharesOut = null, settlementDate = null, asOf, borrow = null } = {}) {
  if (!rec || !asOf) return null;
  if (settlementDate) {
    const publicAt = new Date(Date.parse(settlementDate) + PUBLICATION_DELAY_DAYS * 86400000).toISOString().slice(0, 10);
    if (asOf < publicAt) return { notYetPublic: true, publicAt, settlementDate };
  }
  const flag = siFlag(rec, sharesOut); // { pct (%), dtc, level } or null
  if (!flag) return null;
  const pctFrac = flag.pct != null ? flag.pct / 100 : null; // back to fraction
  const dtc = flag.dtc;

  // Crowding: how concentrated is the short position (level + slow-to-cover). REAL.
  const pctTerm = pctFrac != null ? Math.min(1, pctFrac / (2 * SI_HIGH_PCT)) : null;      // saturates at 2×high
  const dtcTerm = dtc != null ? Math.min(1, dtc / (2 * DTC_HIGH)) : null;
  const crowding = avg([pctTerm, dtcTerm]);

  // Squeeze risk: high crowding + tight borrow. Borrow is UNAVAILABLE, so this is a
  // borrow-blind LOWER BOUND from crowding alone — flagged in confidence, not hidden.
  const borrowTight = borrow && Number.isFinite(borrow.feeBps) ? Math.min(1, borrow.feeBps / 2000) : null;
  const squeeze = borrowTight != null ? avg([crowding, borrowTight]) : (crowding != null ? crowding * 0.6 : null);

  return {
    pct: flag.pct, dtc, level: flag.level, sharesOut,
    crowding, squeeze,
    borrowKnown: borrowTight != null,
    coverageInputs: [pctFrac != null, dtc != null, borrowTight != null], // for coverage fraction
    settlementDate, asOf,
  };
}

const avg = (arr) => { const v = arr.filter(x => x != null && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

// Build the standard envelope. Short pressure is a SHORT-SIDE signal in this long-only app
// (high crowding ⇒ typical underperformance, per shortinterest.js research), so direction is
// SHORT when crowding is high; the score is the (negative) expected-return tilt.
function toEnvelope(a, { ticker, securityId, asOf } = {}) {
  if (!a) return unavailable('short_pressure', { engine: 1, ticker, securityId, asOf, reason: 'no short-interest record', provider: 'finra_si' });
  if (a.notYetPublic) return unavailable('short_pressure', { engine: 1, ticker, securityId, asOf, reason: `SI settlement ${a.settlementDate} not public until ${a.publicAt}`, provider: 'finra_si' });

  const coverage = a.coverageInputs.filter(Boolean).length / a.coverageInputs.length;
  const ageDays = a.settlementDate ? daysBetween(asOf, a.settlementDate) : null;
  // Signed score: crowding pushes expected return DOWN (short-side). Range ~[-0.6, 0].
  const score = a.crowding != null ? -0.6 * a.crowding : 0;
  const borrowProv = providerStatus('borrow_fee');

  return makeEnvelope({
    engine: 1, signal: 'short_pressure', signalVersion: 'short-pressure-v1', ticker, securityId, asOf,
    status: STATUS.USABLE,
    score: +score.toFixed(4),
    direction: a.crowding != null && a.crowding >= 0.5 ? DIRECTION.SHORT : DIRECTION.NEUTRAL,
    // Confidence is capped low because the borrow leg is missing — we cannot separate
    // "informed bearish" from "crowded but constrained" without lending data.
    confidence: +(clamp01(0.25 + 0.25 * coverage + (a.borrowKnown ? 0.3 : 0))).toFixed(3),
    coverage: +coverage.toFixed(3),
    staleness: ageDays != null ? { ageDays, publishedTs: a.settlementDate } : null,
    expectedDecay: { halfLifeDays: 30, reversal: false },
    historicalSupport: { n: null, note: 'cross-sectional SI effect (survivorship-safe FINRA panel)' },
    warnings: [
      'borrow fee / utilization UNAVAILABLE — cannot separate informed vs constrained short',
      'change/acceleration & covering UNAVAILABLE — only latest settlement is cached',
    ],
    restrictions: borrowProv.note,
    inputs: {
      short_crowding: a.crowding != null ? +a.crowding.toFixed(3) : null,
      squeeze_probability: a.squeeze != null ? +a.squeeze.toFixed(3) : null,
      informed_short_pressure: null,   // needs borrow×price interaction — UNAVAILABLE
      covering_intensity: null,        // needs SI time series — UNAVAILABLE
      borrow_constraint: null,         // licensed — UNAVAILABLE
      si_pct: a.pct, days_to_cover: a.dtc, level: a.level, shares_out: a.sharesOut,
    },
    sourceTimestamps: { finra_settlement: a.settlementDate },
  });
}

// ASYNC. Compute for one ticker as of `asOf`. Requires sharesOut for the strong SI% signal;
// falls back to DTC-only when absent. `siData` may be pre-fetched to avoid a per-name call.
async function computeShortPressure(ticker, { asOf, securityId = null, sharesOut = null, siData = null } = {}) {
  if (!asOf) throw new Error('computeShortPressure requires asOf');
  let data = siData;
  if (!data) { try { data = await fetchShortInterest(); } catch { data = null; } }
  if (!data || !data.bySymbol) return unavailable('short_pressure', { engine: 1, ticker, securityId, asOf, reason: 'FINRA feed unavailable', provider: 'finra_si' });
  const rec = data.bySymbol[String(ticker).toUpperCase()];
  const a = assessShortPressure(rec, { sharesOut, settlementDate: data.settlementDate, asOf });
  return toEnvelope(a, { ticker, securityId, asOf });
}

module.exports = { assessShortPressure, toEnvelope, computeShortPressure, PUBLICATION_DELAY_DAYS };

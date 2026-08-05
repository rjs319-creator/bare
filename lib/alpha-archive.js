'use strict';
// ALPHA ARCHIVE — pure logic for the three archive-first collection streams.
//
// THE POINT OF THESE STREAMS: each one captures data that CANNOT be bought or
// reconstructed retroactively — vendors overwrite scheduled earnings dates, option
// open-interest snapshots exist only on the day, and analyst-event feeds truncate.
// Every un-archived day is lost forever, so the collectors run daily and the
// hypotheses they serve are preregistered in lib/research/hypothesis-registry.js
// with earliest-test dates. NOTHING here scores, ranks, or moves a live pick —
// write-only accrual until each ledger matures.
//
//   A. calendar  — FMP earnings-calendar snapshots, diffed into a scheduled-DATE
//                  revision ledger (Johnson & So "Time Will Tell": advances tend
//                  to precede good news, delays bad news).
//   B. gex       — per-name dealer-gamma proxy from Yahoo option chains
//                  (single-name positioning; index-level GEX is crowded, single
//                  name mid-cap is not).
//   C. revisions — analyst grade/price-target events with REAL second-resolution
//                  publish timestamps (cascade velocity: who moved first and how
//                  fast others follow).
//
// Everything in this file is pure (no network, no clock, no store) so the diff
// semantics and the options math are unit-testable exactly.

const MS_PER_DAY = 86_400_000;

const dayMs = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return Date.UTC(y, m - 1, d);
};

// ── A. Earnings-calendar snapshot diff ──────────────────────────────────────
//
// A snapshot row is the compact form the archive writes: { s, d, eps, rev, lu }
// (symbol, scheduled date, epsEstimated, revenueEstimated, lastUpdated). A symbol
// can carry several rows (this quarter + next); the event that matters for the
// revision signal is the NEXT upcoming announcement, so we compare each symbol's
// earliest not-yet-passed date across the two snapshots.
//
// Returns { revisions, addedCount, removedCount, compared } where a revision is
//   { symbol, prevDate, newDate, deltaDays, direction, epsEstimated, observedAt }
// direction: 'advanced' (moved earlier — the literature's good-news tell) or
// 'delayed'. Pure: observedAt is injected, never read from a clock.
function nextEventBySymbol(rows, obsDate) {
  const obs = dayMs(obsDate);
  const map = new Map();
  for (const r of rows || []) {
    const sym = String(r.s || '').toUpperCase();
    const t = dayMs(r.d);
    if (!sym || t == null || obs == null || t < obs) continue;   // already announced
    const prev = map.get(sym);
    if (!prev || t < dayMs(prev.d)) map.set(sym, r);
  }
  return map;
}

function diffCalendarSnapshots(prevRows, currRows, { prevObservedAt, observedAt } = {}) {
  // Both snapshots are reduced to "next upcoming event" AS OF THE SAME date (the
  // current observation date): comparing prev's next-event as of ITS OWN date
  // would flag every announcement that simply happened in between as a change.
  const prev = nextEventBySymbol(prevRows, observedAt);
  const curr = nextEventBySymbol(currRows, observedAt);

  const revisions = [];
  let addedCount = 0, removedCount = 0, compared = 0;
  for (const [sym, c] of curr) {
    const p = prev.get(sym);
    if (!p) { addedCount++; continue; }         // entered the forward window — not a reschedule
    compared++;
    const dp = dayMs(p.d), dc = dayMs(c.d);
    if (dp === dc) continue;
    const deltaDays = Math.round((dc - dp) / MS_PER_DAY);
    revisions.push({
      symbol: sym,
      prevDate: String(p.d).slice(0, 10),
      newDate: String(c.d).slice(0, 10),
      deltaDays,
      direction: deltaDays < 0 ? 'advanced' : 'delayed',
      epsEstimated: c.eps ?? null,
      prevSnapshotDate: prevObservedAt || null,
      observedAt: observedAt || null,
    });
  }
  for (const sym of prev.keys()) if (!curr.has(sym)) removedCount++;
  return { revisions, addedCount, removedCount, compared };
}

// ── B. Dealer-gamma (GEX) proxy from an option chain ────────────────────────
//
// Black-Scholes gamma, identical for calls and puts: φ(d1) / (S·σ·√T).
// The rate term barely moves gamma at these horizons; a fixed 4% keeps the
// function pure without dragging in a rates feed.
const RATE = 0.04;
const SQRT_2PI = Math.sqrt(2 * Math.PI);
const normPdf = (x) => Math.exp(-0.5 * x * x) / SQRT_2PI;

function bsGamma({ spot, strike, iv, dteYears, rate = RATE }) {
  if (!(spot > 0) || !(strike > 0) || !(iv > 0) || !(dteYears > 0)) return null;
  const sT = iv * Math.sqrt(dteYears);
  const d1 = (Math.log(spot / strike) + (rate + 0.5 * iv * iv) * dteYears) / sT;
  return normPdf(d1) / (spot * sT);
}

// Contract sanity filters, matching the ATM-IV heuristics in options-baseline.js:
// Yahoo reports degenerate ~0 IV on illiquid strikes, and far-wing strikes carry
// junk IV while contributing negligible gamma — both excluded rather than patched.
const IV_MIN = 0.05, IV_MAX = 5;
const STRIKE_BAND = 0.33;                       // only strikes within ±33% of spot

// One expiry's chain ({ calls, puts, expirationDate }) → dollar-gamma summary.
// gex* = Σ gamma·OI·100·S²·1% — the dollar gamma dealers re-hedge per 1% move.
// netGex uses the standard customer-flow sign convention (dealers long the calls
// customers sold them / short the puts customers bought): net = calls − puts.
// That convention is an ASSUMPTION, recorded here once so research reads it with
// the data; it is wrong for some names and periods, which is exactly what the
// preregistered validation (vol forecast first) is designed to catch.
function expiryGex(chain, spot, nowSec) {
  if (!chain || !(spot > 0)) return null;
  const expSec = chain.expirationDate || null;
  const dteYears = expSec ? (expSec - nowSec) / (365.25 * 86_400) : null;
  if (!(dteYears > 0)) return null;

  const leg = (contracts) => {
    let oi = 0, gex = 0, used = 0;
    for (const c of contracts || []) {
      const strike = c && c.strike, iv = c && c.impliedVolatility, o = (c && c.openInterest) || 0;
      if (!(o > 0) || !(strike > 0) || !isFinite(iv) || iv < IV_MIN || iv > IV_MAX) continue;
      if (Math.abs(strike - spot) / spot > STRIKE_BAND) continue;
      const g = bsGamma({ spot, strike, iv, dteYears });
      if (g == null) continue;
      oi += o;
      gex += g * o * 100 * spot * spot * 0.01;
      used++;
    }
    return { oi, gex, used };
  };

  const calls = leg(chain.calls), puts = leg(chain.puts);
  if (!calls.used && !puts.used) return null;
  const round = (x) => Math.round(x);
  return {
    expiry: expSec ? new Date(expSec * 1000).toISOString().slice(0, 10) : null,
    dte: Math.round(dteYears * 365.25),
    callOI: calls.oi, putOI: puts.oi,
    callGex: round(calls.gex), putGex: round(puts.gex),
    netGex: round(calls.gex - puts.gex),
    contractsUsed: calls.used + puts.used,
  };
}

// Full Yahoo optionChain result (possibly multi-expiry via fetchChainMultiExpiry)
// → one per-name archive record, or null when nothing computable.
function nameGexRecord(ticker, chainResult, nowSec) {
  const spot = chainResult?.quote?.regularMarketPrice ?? null;
  if (!(spot > 0)) return null;
  const expiries = (chainResult.options || [])
    .map(ch => expiryGex(ch, spot, nowSec))
    .filter(Boolean);
  if (!expiries.length) return null;
  const total = (f) => expiries.reduce((s, e) => s + e[f], 0);
  return {
    t: String(ticker).toUpperCase(),
    spot: +spot.toFixed(2),
    expiries,
    netGex: total('netGex'),
    totalOI: total('callOI') + total('putOI'),
  };
}

// ── C. Analyst-event feed dedup ─────────────────────────────────────────────
//
// The two FMP feeds (grades-latest-news, price-target-latest-news) are pulled as
// overlapping fixed-page sweeps each day — overlap is BY DESIGN (no read-modify-
// write against yesterday's shard), so identity keys make the read side exact.
const gradeEventKey = (e) => [e.symbol, e.publishedDate, e.gradingCompany, e.action].join('|');
const targetEventKey = (e) => [e.symbol, e.publishedDate, e.analystCompany, e.priceTarget].join('|');

function dedupeEvents(rows, keyFn) {
  const seen = new Set(); const out = [];
  for (const r of rows || []) {
    if (!r || !r.symbol || !r.publishedDate) continue;
    const k = keyFn(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

// Compact forms the archive persists (URLs/titles dropped: bulk without signal).
const compactGradeEvent = (e) => ({
  symbol: String(e.symbol || '').toUpperCase(),
  publishedDate: e.publishedDate || null,
  gradingCompany: e.gradingCompany || null,
  action: e.action || null,
  newGrade: e.newGrade || null,
  previousGrade: e.previousGrade || null,
  priceWhenPosted: e.priceWhenPosted ?? null,
});
const compactTargetEvent = (e) => ({
  symbol: String(e.symbol || '').toUpperCase(),
  publishedDate: e.publishedDate || null,
  analystCompany: e.analystCompany || null,
  analystName: e.analystName || null,
  priceTarget: e.priceTarget ?? null,
  adjPriceTarget: e.adjPriceTarget ?? null,
  priceWhenPosted: e.priceWhenPosted ?? null,
});

module.exports = {
  diffCalendarSnapshots, nextEventBySymbol,
  bsGamma, expiryGex, nameGexRecord, IV_MIN, IV_MAX, STRIKE_BAND,
  gradeEventKey, targetEventKey, dedupeEvents, compactGradeEvent, compactTargetEvent,
};

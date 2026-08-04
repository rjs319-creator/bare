'use strict';
// GAP & GO — INTRADAY ORB VERIFICATION CHANNEL (gapgo-orb-verify-v1).
//
// The prospective gap ledger grades a 3-session daily-close PROXY of the intraday
// opening-range-breakout trade (disclosed in the contract; structurally blocked from
// promotion by the maturity-v2 fillVerified gate). This module builds the REAL record
// the promotion bar requires: for each logged gap episode it fetches actual 5-minute
// bars, constructs the genuine first-30-minute opening range (never the completed
// daily high), and resolves a FROZEN verification contract:
//
//   entry   buy-stop at the OR high, valid only AFTER the range completes;
//           gap-through fills at the worse open; an open beyond the 5% chase
//           ceiling is a GAP-SKIP (refused), never an optimistic fill
//   stop    the OR low
//   target  entry + 2R (risk = entry − OR low)
//   exits   stop / target (same-bar ambiguity resolves to the STOP), else the
//           session close (time exit); netR charges the liquidity-tier round trip
//   no bars fail closed: 'bars-unavailable' is recorded, never imputed
//
// Episodes are append-only in their own doc (gapgo/verified.json) — the proxy ledger
// is never rewritten, and this channel never emits a verdict. When enough verified
// episodes accrue, promotion is judged HERE, on the frozen `take` tiers only.

const S = require('./store');
const { roundTripCostPct } = require('./costs');

const GAPGO_VERIFY_VERSION = 'gapgo-orb-verify-v1';
const CHASE_CEILING_PCT = 5;      // refuse fills beyond trigger×1.05 (matches premove-trigger-v1 gap refusal)
const R_MULTIPLE = 2;             // 1:2 target, per the displayed ORB plan geometry
const OR_END = '10:00';           // first 30 minutes: 09:30 ≤ t < 10:00
const SESSION_START = '09:30';
const SESSION_END = '16:00';
const MIN_OR_BARS = 5;            // a real 30-min range needs ≥5 of the 6 5-min bars
const LOOKBACK_DAYS = 7;          // calendar window of ledger rows to (re)try
const UNAVAILABLE_AFTER_DAYS = 4; // only after this do we record bars-unavailable (before: retry)
const FETCH_CAP = 25;             // bounded FMP calls per run

// Mirrors the gap ledger's own cost tiering (screener-routes gapCostTier) without
// importing from that module: unknown ADV must never earn the cheapest tier.
function verifyCostTier(advUsd) {
  if (!Number.isFinite(advUsd) || advUsd <= 0) return 'small';
  if (advUsd >= 50_000_000) return 'liquid';
  if (advUsd >= 10_000_000) return 'small';
  return 'micro';
}

// ── PURE resolver ────────────────────────────────────────────────────────────
// bars: [{ t: 'HH:MM', open, high, low, close }] ascending, one regular session.
function resolveOrbFromBars(bars, { chaseCeilingPct = CHASE_CEILING_PCT, rMultiple = R_MULTIPLE, costPct = 0 } = {}) {
  const session = (bars || []).filter(b => b && b.t >= SESSION_START && b.t < SESSION_END
    && Number.isFinite(b.open) && Number.isFinite(b.high) && Number.isFinite(b.low) && Number.isFinite(b.close));
  const orBars = session.filter(b => b.t < OR_END);
  const postBars = session.filter(b => b.t >= OR_END);
  if (orBars.length < MIN_OR_BARS || orBars[0].t !== SESSION_START || !postBars.length) {
    return { version: GAPGO_VERIFY_VERSION, status: 'insufficient-bars', orBars: orBars.length, postBars: postBars.length };
  }
  const orHigh = Math.max(...orBars.map(b => b.high));
  const orLow = Math.min(...orBars.map(b => b.low));
  const trigger = orHigh, stop = orLow;
  const ceiling = trigger * (1 + chaseCeilingPct / 100);
  const base = { version: GAPGO_VERIFY_VERSION, orHigh: +orHigh.toFixed(4), orLow: +orLow.toFixed(4), trigger: +trigger.toFixed(4) };

  let fill = null, fillIdx = -1;
  for (let i = 0; i < postBars.length; i++) {
    const b = postBars[i];
    if (b.open >= ceiling) return { ...base, status: 'gap-skip', at: b.t, open: b.open, ceiling: +ceiling.toFixed(4) };
    if (b.open >= trigger) { fill = b.open; fillIdx = i; break; }         // gapped through: worse fill at the open
    if (b.high >= trigger) { fill = trigger; fillIdx = i; break; }        // touched: stop-entry fills at the trigger
  }
  if (fill == null) return { ...base, status: 'no-trigger' };
  const risk = fill - stop;
  if (!(risk > 0)) return { ...base, status: 'invalid-geometry', fill: +fill.toFixed(4), stop: +stop.toFixed(4) };
  const target = fill + rMultiple * risk;
  const done = (status, exit, at) => {
    const grossR = +(((exit - fill) / risk)).toFixed(3);
    const netR = +((((exit - fill) - fill * (costPct / 100)) / risk)).toFixed(3);
    return { ...base, status, fill: +fill.toFixed(4), stop: +stop.toFixed(4), target: +target.toFixed(4), exit: +exit.toFixed(4), at, grossR, netR, costPct };
  };
  // Same-bar honesty on the FILL bar: if it also spans the stop, that resolves to the
  // stop regardless of whether the target printed too (5-min bars can't order ticks).
  const fb = postBars[fillIdx];
  if (fb.low <= stop) return done('stop-before-target', stop, fb.t);
  if (fb.high >= target) return done('target-before-stop', target, fb.t);
  for (let i = fillIdx + 1; i < postBars.length; i++) {
    const b = postBars[i];
    if (b.low <= stop) return done('stop-before-target', stop, b.t);     // stop checked FIRST — conservative
    if (b.high >= target) return done('target-before-stop', target, b.t);
  }
  return done('timeout', postBars[postBars.length - 1].close, postBars[postBars.length - 1].t);
}

// ── FMP 5-minute bars (fail closed — never fabricated) ───────────────────────
async function fetchFmp5min(ticker, date) {
  const key = process.env.FMP_API_KEY;
  if (!key) return null;
  try {
    const url = `https://financialmodelingprep.com/stable/historical-chart/5min?symbol=${encodeURIComponent(ticker)}&from=${date}&to=${date}&apikey=${key}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    return rows
      .filter(x => x && typeof x.date === 'string' && x.date.startsWith(date))
      .map(x => ({ t: x.date.slice(11, 16), open: +x.open, high: +x.high, low: +x.low, close: +x.close }))
      .sort((a, b) => a.t.localeCompare(b.t));
  } catch { return null; }
}

// ── op=gapgoverify — accrue the verified channel (cron/manual-with-bearer) ───
const VERIFIED_DOC = 'gapgo/verified.json';

async function runGapGoVerify(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!S.hasStore()) return res.json({ ok: false, note: 'Blob storage not configured' });
  const doc = (await S.readJSON(VERIFIED_DOC, null).catch(() => null)) || { version: GAPGO_VERIFY_VERSION, episodes: {} };
  const days = await S.readAllGapDays().catch(() => []);
  const todayMs = Date.now();
  const cutoff = new Date(todayMs - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);

  const pending = [];
  for (const d of days) {
    if (!d || !d.date || d.date < cutoff) continue;
    for (const p of (d.picks || [])) {
      if (!p || !p.ticker) continue;
      const k = `${d.date}:${p.ticker}`;
      if (doc.episodes[k]) continue;                       // append-only — never regraded
      pending.push({ key: k, date: d.date, pick: p });
    }
  }

  let graded = 0, unavailable = 0, deferred = 0;
  for (const item of pending.slice(0, FETCH_CAP)) {
    const bars = await fetchFmp5min(item.pick.ticker, item.date);
    const ageDays = Math.round((todayMs - Date.parse(item.date)) / 86400000);
    if (!bars) {
      if (ageDays >= UNAVAILABLE_AFTER_DAYS) {
        doc.episodes[item.key] = {
          date: item.date, ticker: item.pick.ticker, tier: item.pick.tier || null,
          version: GAPGO_VERIFY_VERSION, status: 'bars-unavailable', gradedAt: new Date().toISOString(),
        };
        unavailable++;
      } else deferred++;                                   // young — retry on the next run
      continue;
    }
    const costPct = roundTripCostPct(verifyCostTier(item.pick.advUsd));
    const r = resolveOrbFromBars(bars, { costPct });
    doc.episodes[item.key] = {
      date: item.date, ticker: item.pick.ticker, tier: item.pick.tier || null,
      cause: item.pick.cause || null, advUsd: item.pick.advUsd ?? null,
      ...r, gradedAt: new Date().toISOString(),
    };
    graded++;
  }
  if (graded || unavailable) {
    doc.updatedAt = new Date().toISOString();
    await S.writeJSON(VERIFIED_DOC, doc, 0);
  }

  const all = Object.values(doc.episodes);
  const counts = {};
  for (const e of all) counts[e.status] = (counts[e.status] || 0) + 1;
  return res.json({
    ok: true, version: GAPGO_VERIFY_VERSION,
    gradedNow: graded, unavailableNow: unavailable, deferred, pending: Math.max(0, pending.length - FETCH_CAP),
    episodes: all.length, statusCounts: counts,
    contract: 'FROZEN verification: OR-high stop-entry after the 30-min range completes; gap-through at the worse open; >5% open beyond trigger = gap-skip; OR-low stop; 2R target; same-bar → stop; session-close time exit; netR charges the liquidity-tier round trip.',
    note: 'VERIFIED intraday channel — separate from (and never rewriting) the daily-close proxy ledger. No verdict is emitted here; promotion is judged on this record only once it clears the registry criteria (≥50 episodes / ≥20 dates, cost-net CI clear of zero).',
  });
}

module.exports = { GAPGO_VERIFY_VERSION, resolveOrbFromBars, fetchFmp5min, runGapGoVerify, verifyCostTier, CHASE_CEILING_PCT, R_MULTIPLE };

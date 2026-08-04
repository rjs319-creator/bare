'use strict';
// GAP & GO — INTRADAY ORB VERIFICATION CHANNEL (gapgo-orb-verify-v2).
//
// The prospective gap ledger grades a 3-session daily-close PROXY of the intraday
// opening-range-breakout trade (disclosed in the contract; structurally blocked from
// promotion by the maturity-v2 fillVerified gate). This module builds the REAL record
// the promotion bar requires — with decision-time honesty:
//
//   The durable gap decision is logged POST-CLOSE (nightly tick) from the completed
//   daily candle, so the earliest session this decision can trade is the NEXT one.
//   v1 of this channel graded the gap session's own opening range — a trade that
//   began ~6.5h BEFORE the decision existed. Those records are kept immutable but
//   marked superseded and are non-promotable (see SUPERSEDED_VERSIONS).
//
// v2 FROZEN contract — EOD decision, next-session opening-range trade:
//   signal   the logged gap session (dataCutoffSession = that session's close)
//   entry    on the FIRST trading session AFTER the signal session: buy-stop at the
//            30-min OR high, valid only AFTER the range completes; gap-through fills
//            at the worse open; an open beyond the 5% chase ceiling is a GAP-SKIP
//   stop     the OR low; target entry + 2R; same-bar ambiguity resolves to the STOP
//   exits    stop / target, else the session close (time exit); netR charges the
//            liquidity-tier round trip
//   cohorts  only picks whose FROZEN logged decision was take:true enter the
//            promotion-grade TAKE cohort; take:false picks are CONTROL; legacy picks
//            with no persisted decision are LEGACY-NO-DECISION and never promotable
//   no bars fail closed: 'bars-unavailable' is recorded, never imputed; an entry
//            session that cannot be pinned down is 'entry-session-uncertain'
//
// Episodes are append-only in their own doc (gapgo/verified.json) — the proxy ledger
// is never rewritten, and this channel never emits a verdict. v1 and v2 episodes
// never pool: v2 keys are namespaced and every aggregate filters on `version`.

const S = require('./store');
const { roundTripCostPct } = require('./costs');

const GAPGO_VERIFY_VERSION = 'gapgo-orb-verify-v2';
const SUPERSEDED_VERSIONS = {
  'gapgo-orb-verify-v1': 'same-session ORB: the graded trade began before the post-close decision was logged (look-ahead). Records kept immutable; never promotable; never pooled with v2.',
};
const CHASE_CEILING_PCT = 5;      // refuse fills beyond trigger×1.05 (matches premove-trigger-v1 gap refusal)
const R_MULTIPLE = 2;             // 1:2 target, per the displayed ORB plan geometry
const OR_END = '10:00';           // first 30 minutes: 09:30 ≤ t < 10:00
const SESSION_START = '09:30';
const SESSION_END = '16:00';
const MIN_OR_BARS = 5;            // a real 30-min range needs ≥5 of the 6 5-min bars
const LOOKBACK_DAYS = 8;          // calendar window of ledger rows to (re)try
const UNAVAILABLE_AFTER_DAYS = 5; // only after this do we record a terminal miss (before: retry)
const MAX_ENTRY_GAP_DAYS = 5;     // signal→entry farther than a weekend+holiday = uncertain, refused
const ENTRY_FETCH_SPAN_DAYS = 7;  // calendar window fetched to find the next trading session
const FETCH_CAP = 25;             // bounded FMP calls per run

// Mirrors the gap ledger's own cost tiering (screener-routes gapCostTier) without
// importing from that module: unknown ADV must never earn the cheapest tier.
function verifyCostTier(advUsd) {
  if (!Number.isFinite(advUsd) || advUsd <= 0) return 'small';
  if (advUsd >= 50_000_000) return 'liquid';
  if (advUsd >= 10_000_000) return 'small';
  return 'micro';
}

// ── PURE entry-session selection ─────────────────────────────────────────────
// The decision exists only after the signal session's close, so the entry session
// must be STRICTLY LATER than the signal session; the earliest such session wins.
// A first-available session farther out than a weekend+holiday means we cannot
// prove it is the immediate next session (data hole) — refused, never guessed.
function selectEntrySession(sessionDates, signalDate) {
  const later = [...new Set(sessionDates || [])].filter(d => typeof d === 'string' && d > signalDate).sort();
  if (!later.length) return { status: 'no-entry-session' };
  const gapDays = Math.round((Date.parse(later[0]) - Date.parse(signalDate)) / 86400000);
  if (!(gapDays >= 1) || gapDays > MAX_ENTRY_GAP_DAYS) {
    return { status: 'entry-session-uncertain', candidate: later[0], gapDays };
  }
  return { status: 'ok', entrySession: later[0], gapDays };
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

// ── PURE per-episode grader ──────────────────────────────────────────────────
// pick: a logged gap-ledger pick (may or may not carry the frozen decision fields).
// barsBySession: { 'YYYY-MM-DD': [5-min bars] } fetched for sessions AFTER the signal.
// Decision fields are COPIED from the pick, never recomputed — bar data can change
// the execution outcome but can never change the frozen decision or its cohort.
function gradeVerifyEpisode(pick, barsBySession) {
  const take = pick.take === true ? true : pick.take === false ? false : null;
  const cohort = take === true ? 'TAKE' : take === false ? 'CONTROL' : 'LEGACY-NO-DECISION';
  const decisionTs = typeof pick.decisionTs === 'string' ? pick.decisionTs : null;
  const frozen = {
    version: GAPGO_VERIFY_VERSION,
    date: pick.date, ticker: pick.ticker, tier: pick.tier || null,
    cause: pick.cause || null, advUsd: pick.advUsd ?? null,
    take, cohort, decisionTs,
    scoringVersion: pick.scoringVersion || null,
    dataCutoffSession: pick.dataCutoffSession || pick.date || null,
    // Promotion-grade evidence requires the frozen TAKE decision AND its provenance.
    promotionEligible: cohort === 'TAKE' && !!decisionTs,
  };
  const sessions = Object.keys(barsBySession || {}).filter(d => Array.isArray(barsBySession[d]) && barsBySession[d].length);
  const sel = selectEntrySession(sessions, pick.date);
  if (sel.status !== 'ok') return { ...frozen, status: sel.status, promotionEligible: false, entrySession: sel.candidate || null };
  // Structural look-ahead guard: only the selected entry session's bars are graded.
  const r = resolveOrbFromBars(barsBySession[sel.entrySession], { costPct: pick.costPct });
  return { ...frozen, entrySession: sel.entrySession, ...r, ...frozen.promotionEligible ? {} : { promotionEligible: false } };
}

// ── FMP 5-minute bars (fail closed — never fabricated) ───────────────────────
async function fetchFmp5min(ticker, fromDate, toDate = null) {
  const key = process.env.FMP_API_KEY;
  if (!key) return null;
  const to = toDate || fromDate;
  try {
    const url = `https://financialmodelingprep.com/stable/historical-chart/5min?symbol=${encodeURIComponent(ticker)}&from=${fromDate}&to=${to}&apikey=${key}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    const bySession = {};
    for (const x of rows) {
      if (!x || typeof x.date !== 'string') continue;
      const d = x.date.slice(0, 10);
      if (d < fromDate || d > to) continue;
      (bySession[d] = bySession[d] || []).push({ t: x.date.slice(11, 16), open: +x.open, high: +x.high, low: +x.low, close: +x.close });
    }
    for (const d of Object.keys(bySession)) bySession[d].sort((a, b) => a.t.localeCompare(b.t));
    return Object.keys(bySession).length ? bySession : null;
  } catch { return null; }
}

// ── op=gapgoverify — accrue the verified channel (cron/manual-with-bearer) ───
const VERIFIED_DOC = 'gapgo/verified.json';
const isoDate = ms => new Date(ms).toISOString().slice(0, 10);

async function runGapGoVerify(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!S.hasStore()) return res.json({ ok: false, note: 'Blob storage not configured' });
  const doc = (await S.readJSON(VERIFIED_DOC, null).catch(() => null)) || { episodes: {} };
  doc.version = GAPGO_VERIFY_VERSION;
  doc.superseded = SUPERSEDED_VERSIONS;          // metadata only — v1 episode objects are never touched
  const days = await S.readAllGapDays().catch(() => []);
  const todayMs = Date.now();
  const cutoff = isoDate(todayMs - LOOKBACK_DAYS * 86400000);

  const pending = [];
  for (const d of days) {
    if (!d || !d.date || d.date < cutoff) continue;
    for (const p of (d.picks || [])) {
      if (!p || !p.ticker) continue;
      const k = `v2:${d.date}:${p.ticker}`;       // v2 namespace — v1 keys (`date:ticker`) never block or pool
      if (doc.episodes[k]) continue;              // append-only — never regraded
      pending.push({ key: k, date: d.date, pick: { ...p, date: d.date } });
    }
  }

  let graded = 0, unavailable = 0, deferred = 0;
  for (const item of pending.slice(0, FETCH_CAP)) {
    const from = isoDate(Date.parse(item.date) + 86400000);
    const to = isoDate(Date.parse(item.date) + ENTRY_FETCH_SPAN_DAYS * 86400000);
    const barsBySession = await fetchFmp5min(item.pick.ticker, from, to);
    const ageDays = Math.round((todayMs - Date.parse(item.date)) / 86400000);
    const costPct = roundTripCostPct(verifyCostTier(item.pick.advUsd));
    if (!barsBySession) {
      if (ageDays >= UNAVAILABLE_AFTER_DAYS) {
        doc.episodes[item.key] = {
          ...gradeVerifyEpisode({ ...item.pick, costPct }, {}),
          status: 'bars-unavailable', gradedAt: new Date().toISOString(),
        };
        unavailable++;
      } else deferred++;                           // young — retry on the next run
      continue;
    }
    const ep = gradeVerifyEpisode({ ...item.pick, costPct }, barsBySession);
    // A young episode whose entry session hasn't traded (or hasn't reached FMP) yet
    // is deferred, not stamped: fail-closed statuses become terminal only with age.
    if ((ep.status === 'no-entry-session' || ep.status === 'entry-session-uncertain') && ageDays < UNAVAILABLE_AFTER_DAYS) { deferred++; continue; }
    doc.episodes[item.key] = { ...ep, gradedAt: new Date().toISOString() };
    graded++;
  }
  if (graded || unavailable) {
    doc.updatedAt = new Date().toISOString();
    await S.writeJSON(VERIFIED_DOC, doc, 0);
  }

  const all = Object.values(doc.episodes);
  const v2 = all.filter(e => e && e.version === GAPGO_VERIFY_VERSION);
  const v1 = all.length - v2.length;
  const counts = {};
  for (const e of v2) counts[e.status] = (counts[e.status] || 0) + 1;
  const cohorts = {};
  for (const e of v2) cohorts[e.cohort || 'LEGACY-NO-DECISION'] = (cohorts[e.cohort || 'LEGACY-NO-DECISION'] || 0) + 1;
  return res.json({
    ok: true, version: GAPGO_VERIFY_VERSION,
    gradedNow: graded, unavailableNow: unavailable, deferred, pending: Math.max(0, pending.length - FETCH_CAP),
    episodes: v2.length, statusCounts: counts, cohorts,
    supersededEpisodes: v1, superseded: SUPERSEDED_VERSIONS,
    contract: 'FROZEN v2 verification: EOD post-close decision; entry on the NEXT trading session only — OR-high stop-entry after that session\'s 30-min range completes; gap-through at the worse open; >5% open beyond trigger = gap-skip; OR-low stop; 2R target; same-bar → stop; session-close time exit; netR charges the liquidity-tier round trip. The verifier can never trade the session that produced the decision.',
    note: 'VERIFIED intraday channel — separate from (and never rewriting) the daily-close proxy ledger. No verdict is emitted here; promotion is judged on the v2 TAKE cohort only (frozen take:true decisions with logged decisionTs) once it clears the registry criteria (≥50 episodes / ≥20 dates, cost-net CI clear of zero). v1 episodes are superseded look-ahead records: immutable, non-promotable, never pooled.',
  });
}

module.exports = {
  GAPGO_VERIFY_VERSION, SUPERSEDED_VERSIONS, resolveOrbFromBars, selectEntrySession,
  gradeVerifyEpisode, fetchFmp5min, runGapGoVerify, verifyCostTier, CHASE_CEILING_PCT, R_MULTIPLE,
};

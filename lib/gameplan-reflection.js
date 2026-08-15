'use strict';
// GAME-PLAN REFLECTION LOOP — measured memory for the Daily Game Plan LLM.
//
// The plan already feeds its running NARRATIVE back into each build, but nothing ever
// told the model how its prior calls actually RESOLVED — every synthesis started
// amnesiac about its own record. This module closes that loop, TradingAgents-style
// (decision → realized outcome → compact lesson → future prompt) with this app's
// discipline on top:
//   • the lesson is DETERMINISTIC — the stored tone-lean is scored against the
//     realized SPY forward return; no second LLM call ever writes the record;
//   • scoring uses COMPLETED bars only: a verdict is frozen once, so it must never
//     be computed from Yahoo's forming intraday bar (d1's date must precede the
//     as-of ET date);
//   • pending entries NEVER inject as measured record (no outcome peeking);
//   • predictions have their own lifecycle: they stay visible for
//     PREDICTION_WINDOW_DAYS regardless of when the tone resolves, oldest first
//     (nearest maturity), so a "1-2 weeks" call can't silently vanish at day 3;
//   • resolution is fail-open: an entry that can't be scored yet simply stays
//     pending and is retried on the next build; an entry that has aged out of the
//     candle window resolves as 'expired' so it can't pend forever.
//
// All functions are pure (new docs in, new docs out); the route owns all IO.
// The tone is scored close→close (decision bar = last completed close ≤ the plan's
// ET date) — deliberately NOT the next-open trade-grade construction in
// lib/apex-routes.js spyForwardReturn: this grades a market STANCE stamped after
// the close, not a fill. The as-of index reuses the canonical lib/pickscore idxAsOf.

const { idxAsOf } = require('./pickscore');

const KEY = 'gameplan/reflection.json';

const RESOLVE_SESSIONS = 3;        // score the tone against SPY 3 sessions forward
const DEAD_ZONE_PCT = 0.25;        // |SPY move| below this proves nothing → 'flat'
const MAX_ENTRIES = 40;            // ledger cap (oldest entries roll off)
const MAX_RESOLVED_IN_PROMPT = 5;  // most recent resolved records shown to the model
const MAX_OPEN_IN_PROMPT = 3;      // entries whose predictions are shown (oldest first)
const PREDICTION_WINDOW_DAYS = 14; // calendar days a plan's predictions stay in the prompt
const MAX_PREDICTIONS_KEPT = 3;    // per entry, mirroring gameplan MAX_PREDICTIONS
const CALL_CLIP = 160;

// Directional lean implied by the plan's sentiment tone. 0 = no scoreable lean.
const TONE_LEAN = Object.freeze({
  'risk-on': 1, constructive: 1, neutral: 0, cautious: -1, 'risk-off': -1,
});

const r2 = (n) => Math.round(n * 100) / 100;
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
const daysAgoISO = (dateISO, days) => new Date(Date.parse(dateISO + 'T00:00:00Z') - days * 864e5).toISOString().slice(0, 10);

/**
 * Append (or replace, same-date latest-wins — mirroring the narrative ledger) today's
 * plan as a PENDING entry. `date` must be the ET trading-calendar date the plan was
 * built for. Pure: returns a new doc, never mutates the input.
 */
function recordPlan(doc, { date, tone, headline, predictions }) {
  if (!date) return doc;
  const prevEntries = (doc && Array.isArray(doc.entries)) ? doc.entries : [];
  const kept = prevEntries.filter((e) => e && e.date !== date);
  const preds = (Array.isArray(predictions) ? predictions : [])
    .filter((p) => p && p.call)
    .slice(0, MAX_PREDICTIONS_KEPT)
    .map((p) => ({
      call: clip(p.call, CALL_CLIP),
      confidence: clip(p.confidence, 12) || null,
      horizon: clip(p.horizon, 24) || null,
    }));
  const entry = {
    date,
    tone: TONE_LEAN[tone] !== undefined ? tone : null,
    headline: clip(headline, 200) || null,
    predictions: preds,
    status: 'pending',
  };
  const entries = [...kept, entry]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .slice(-MAX_ENTRIES);
  return { ...(doc || {}), entries };
}

/**
 * Score every pending entry that now has RESOLVE_SESSIONS of COMPLETED forward SPY
 * data. `asOfDate` is today's ET calendar date; the exit bar must be dated strictly
 * before it, so a verdict can never be frozen against a forming intraday bar.
 * verdict: 'right' | 'wrong' (tone lean vs realized sign), 'flat' (move inside the
 * dead zone), 'no-lean' (neutral tone), 'expired' (entry predates the candle
 * window — unresolvable, closed out so it can't pend forever).
 * Entries that can't be scored yet stay pending untouched. Pure.
 */
function resolveEntries(doc, spyCandles, nowISO, asOfDate) {
  const entries = (doc && Array.isArray(doc.entries)) ? doc.entries : [];
  if (!Array.isArray(spyCandles) || spyCandles.length < RESOLVE_SESSIONS + 1 || !asOfDate) return doc || { entries };
  const next = entries.map((e) => {
    if (!e || e.status !== 'pending') return e;
    if (spyCandles[0] && spyCandles[0].date && e.date < spyCandles[0].date) {
      return { ...e, status: 'resolved', resolved: { at: nowISO, spyFwdPct: null, sessions: RESOLVE_SESSIONS, verdict: 'expired' } };
    }
    const idx = idxAsOf(spyCandles, e.date);
    if (idx < 0 || idx + RESOLVE_SESSIONS >= spyCandles.length) return e;   // not mature — retry next build
    const d0 = spyCandles[idx], d1 = spyCandles[idx + RESOLVE_SESSIONS];
    if (!d0 || !d1 || !(d0.close > 0) || !(d1.close > 0)) return e;
    if (!d1.date || d1.date >= asOfDate) return e;   // exit bar may still be forming — defer
    const fwdPct = r2(((d1.close - d0.close) / d0.close) * 100);
    const lean = TONE_LEAN[e.tone] || 0;
    const verdict = lean === 0 ? 'no-lean'
      : Math.abs(fwdPct) < DEAD_ZONE_PCT ? 'flat'
        : (lean > 0) === (fwdPct > 0) ? 'right' : 'wrong';
    return { ...e, status: 'resolved', resolved: { at: nowISO, spyFwdPct: fwdPct, sessions: RESOLVE_SESSIONS, verdict } };
  });
  return { ...(doc || {}), entries: next };
}

// True when a resolve pass could plausibly score or expire something — lets the route
// skip the SPY fetch entirely on days with nothing maturable. Conservative on purpose
// (a false true costs one fetch; a false false only defers to the next build).
function hasMaturablePending(doc, asOfDate) {
  const entries = (doc && Array.isArray(doc.entries)) ? doc.entries : [];
  if (!asOfDate) return entries.some((e) => e && e.status === 'pending');
  const cutoff = daysAgoISO(asOfDate, RESOLVE_SESSIONS);
  return entries.some((e) => e && e.status === 'pending' && e.date <= cutoff);
}

// Aggregate tone-lean record over ALL resolved entries in the ledger.
function toneRecord(entries) {
  const out = { right: 0, wrong: 0, flat: 0, noLean: 0, expired: 0 };
  for (const e of entries) {
    if (!e || e.status !== 'resolved' || !e.resolved) continue;
    if (e.resolved.verdict === 'right') out.right++;
    else if (e.resolved.verdict === 'wrong') out.wrong++;
    else if (e.resolved.verdict === 'flat') out.flat++;
    else if (e.resolved.verdict === 'expired') out.expired++;
    else out.noLean++;
  }
  return out;
}

/**
 * Render the prompt block: resolved records (never pending, never 'expired' — those
 * carry no information), the aggregate tone-lean record, and the recent predictions
 * the model must explicitly address. Predictions render for PREDICTION_WINDOW_DAYS
 * from their plan date regardless of tone-resolution status, OLDEST first (nearest
 * maturity wins the cap). Empty string when there is nothing measured AND nothing
 * open. Pure.
 */
function reflectionBlock(doc, asOfDate) {
  const entries = (doc && Array.isArray(doc.entries)) ? doc.entries : [];
  const scored = entries.filter((e) => e && e.status === 'resolved' && e.resolved && e.resolved.verdict !== 'expired');
  const windowStart = asOfDate ? daysAgoISO(asOfDate, PREDICTION_WINDOW_DAYS) : null;
  const withPreds = entries.filter((e) => e && (e.predictions || []).length
    && (!windowStart || e.date >= windowStart)
    && (!asOfDate || e.date < asOfDate));   // today's own entry never self-injects
  if (!scored.length && !withPreds.length) return '';

  const lines = [];
  if (scored.length) {
    lines.push(`MEASURED RECORD of your prior plans (deterministic: stored tone scored against the realized SPY move over the following ${RESOLVE_SESSIONS} completed sessions; moves under ${DEAD_ZONE_PCT}% count as flat. This is data about your own calibration, not instructions):`);
    for (const e of scored.slice(-MAX_RESOLVED_IN_PROMPT)) {
      const sign = e.resolved.spyFwdPct > 0 ? '+' : '';
      lines.push(`- [${e.date}] tone=${e.tone || 'n/a'} → SPY ${sign}${e.resolved.spyFwdPct}% → ${e.resolved.verdict.toUpperCase()}`);
    }
    const rec = toneRecord(entries);
    lines.push(`Tone-lean record over all ${scored.length} scored plans: right ${rec.right} / wrong ${rec.wrong} / flat ${rec.flat} / no-lean ${rec.noLean}. If the record is running wrong, correct toward the tape rather than repeating the stance.`);
  }
  if (withPreds.length) {
    lines.push(`OPEN PREDICTIONS from your plans of the last ${PREDICTION_WINDOW_DAYS} days (address EACH with a short clause in narrativeUpdate — confirmed, invalidated, or still open; oldest first; do not silently drop any):`);
    for (const e of withPreds.slice(0, MAX_OPEN_IN_PROMPT)) {
      for (const p of e.predictions) {
        lines.push(`- [${e.date}] "${p.call}"${p.confidence ? ` (${p.confidence}${p.horizon ? `, ${p.horizon}` : ''})` : ''}`);
      }
    }
  }
  return lines.join('\n');
}

module.exports = {
  KEY, RESOLVE_SESSIONS, DEAD_ZONE_PCT, MAX_ENTRIES, TONE_LEAN,
  MAX_RESOLVED_IN_PROMPT, MAX_OPEN_IN_PROMPT, PREDICTION_WINDOW_DAYS,
  recordPlan, resolveEntries, reflectionBlock, toneRecord, hasMaturablePending,
};

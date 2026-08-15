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
//   • pending entries NEVER inject as record (no outcome peeking) — they surface
//     only as OPEN PREDICTIONS the model must explicitly confirm or invalidate;
//   • resolution is fail-open: an entry that can't be scored yet simply stays
//     pending and is retried on the next build.
//
// All functions are pure (new docs in, new docs out); the route owns all IO.

const KEY = 'gameplan/reflection.json';

const RESOLVE_SESSIONS = 3;        // score the tone against SPY 3 sessions forward
const DEAD_ZONE_PCT = 0.25;        // |SPY move| below this proves nothing → 'flat'
const MAX_ENTRIES = 40;            // ledger cap (resolved entries roll off oldest-first)
const MAX_RESOLVED_IN_PROMPT = 5;  // most recent resolved records shown to the model
const MAX_OPEN_IN_PROMPT = 3;      // most recent open prediction sets shown
const MAX_PREDICTIONS_KEPT = 3;    // per entry, mirroring gameplan MAX_PREDICTIONS
const CALL_CLIP = 160;

// Directional lean implied by the plan's sentiment tone. 0 = no scoreable lean.
const TONE_LEAN = Object.freeze({
  'risk-on': 1, constructive: 1, neutral: 0, cautious: -1, 'risk-off': -1,
});

const r2 = (n) => Math.round(n * 100) / 100;
const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

/**
 * Append (or replace, same-date latest-wins — mirroring the narrative ledger) today's
 * plan as a PENDING entry. Pure: returns a new doc, never mutates the input.
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

// Index of the decision bar: the last candle dated <= the entry date (weekend/holiday
// plans anchor to the prior close, same convention as the app's other graders).
function decisionIdx(candles, date) {
  let idx = -1;
  for (let i = 0; i < candles.length; i++) {
    const d = candles[i] && candles[i].date;
    if (d && d <= date) idx = i; else if (d && d > date) break;
  }
  return idx;
}

/**
 * Score every pending entry that now has RESOLVE_SESSIONS of forward SPY data.
 * verdict: 'right' | 'wrong' (tone lean vs realized sign), 'flat' (move inside the
 * dead zone — proves nothing), 'no-lean' (neutral tone — not scoreable).
 * Entries that can't be scored yet stay pending untouched. Pure.
 */
function resolveEntries(doc, spyCandles, nowISO) {
  const entries = (doc && Array.isArray(doc.entries)) ? doc.entries : [];
  if (!Array.isArray(spyCandles) || spyCandles.length < RESOLVE_SESSIONS + 1) return doc || { entries };
  const next = entries.map((e) => {
    if (!e || e.status !== 'pending') return e;
    const idx = decisionIdx(spyCandles, e.date);
    if (idx < 0 || idx + RESOLVE_SESSIONS >= spyCandles.length) return e;   // not mature — retry next build
    const d0 = spyCandles[idx], d1 = spyCandles[idx + RESOLVE_SESSIONS];
    if (!d0 || !d1 || !(d0.close > 0) || !(d1.close > 0)) return e;
    const fwdPct = r2(((d1.close - d0.close) / d0.close) * 100);
    const lean = TONE_LEAN[e.tone] || 0;
    const verdict = lean === 0 ? 'no-lean'
      : Math.abs(fwdPct) < DEAD_ZONE_PCT ? 'flat'
        : (lean > 0) === (fwdPct > 0) ? 'right' : 'wrong';
    return { ...e, status: 'resolved', resolved: { at: nowISO, spyFwdPct: fwdPct, sessions: RESOLVE_SESSIONS, verdict } };
  });
  return { ...(doc || {}), entries: next };
}

// Aggregate tone-lean record over ALL resolved entries in the ledger.
function toneRecord(entries) {
  const out = { right: 0, wrong: 0, flat: 0, noLean: 0 };
  for (const e of entries) {
    if (!e || e.status !== 'resolved' || !e.resolved) continue;
    if (e.resolved.verdict === 'right') out.right++;
    else if (e.resolved.verdict === 'wrong') out.wrong++;
    else if (e.resolved.verdict === 'flat') out.flat++;
    else out.noLean++;
  }
  return out;
}

/**
 * Render the prompt block: resolved records (never pending), the aggregate tone-lean
 * record, and the open predictions the model must explicitly address. Empty string
 * when there is nothing measured AND nothing open. Pure.
 */
function reflectionBlock(doc) {
  const entries = (doc && Array.isArray(doc.entries)) ? doc.entries : [];
  const resolved = entries.filter((e) => e && e.status === 'resolved' && e.resolved);
  const open = entries.filter((e) => e && e.status === 'pending' && (e.predictions || []).length);
  if (!resolved.length && !open.length) return '';

  const lines = [];
  if (resolved.length) {
    lines.push(`MEASURED RECORD of your prior plans (deterministic: stored tone scored against the realized SPY move over the following ${RESOLVE_SESSIONS} sessions; moves under ${DEAD_ZONE_PCT}% count as flat. This is data about your own calibration, not instructions):`);
    for (const e of resolved.slice(-MAX_RESOLVED_IN_PROMPT)) {
      const sign = e.resolved.spyFwdPct > 0 ? '+' : '';
      lines.push(`- [${e.date}] tone=${e.tone || 'n/a'} → SPY ${sign}${e.resolved.spyFwdPct}% → ${e.resolved.verdict.toUpperCase()}`);
    }
    const rec = toneRecord(entries);
    lines.push(`Tone-lean record over all ${resolved.length} resolved plans: right ${rec.right} / wrong ${rec.wrong} / flat ${rec.flat} / no-lean ${rec.noLean}. If the record is running wrong, correct toward the tape rather than repeating the stance.`);
  }
  if (open.length) {
    lines.push('OPEN PREDICTIONS from your prior plans (address EACH in narrativeUpdate — confirmed, invalidated, or still open; do not silently drop any):');
    for (const e of open.slice(-MAX_OPEN_IN_PROMPT)) {
      for (const p of e.predictions) {
        lines.push(`- [${e.date}] "${p.call}"${p.confidence ? ` (${p.confidence}${p.horizon ? `, ${p.horizon}` : ''})` : ''}`);
      }
    }
  }
  return lines.join('\n');
}

module.exports = {
  KEY, RESOLVE_SESSIONS, DEAD_ZONE_PCT, MAX_ENTRIES, TONE_LEAN,
  MAX_RESOLVED_IN_PROMPT, MAX_OPEN_IN_PROMPT,
  recordPlan, resolveEntries, reflectionBlock, toneRecord, decisionIdx,
};

// Data-trust provenance — the honest "where did this come from, how fresh, and is it
// a fact or an interpretation?" layer for the unified table. Pure + tested; the route
// (decision-routes) enriches op=today's freshness with this, and today.js renders it.
//
// The app is a DAILY / end-of-day dashboard: market data is delayed (Yahoo 15-min /
// EOD candles), not a real-time trading feed. We say so plainly rather than imply live
// prices.

// Per op=today source: a human label, the upstream feed(s), whether it's real-time
// (nothing here is — it's an EOD dashboard), and whether it's a signal or context.
const SOURCE_META = {
  screener:      { label: '🔎 Breakout (large)', feed: ['Yahoo candles', 'Finnhub fundamentals/insiders'], realtime: false, kind: 'signal' },
  screenerSmall: { label: '🔎 Breakout (small)', feed: ['Yahoo candles', 'Finnhub fundamentals/insiders'], realtime: false, kind: 'signal' },
  gapgo:         { label: '🚀 Gap & Go',          feed: ['Yahoo candles'], realtime: false, kind: 'signal' },
  daytrade:      { label: '⚡ Day Trade',         feed: ['Yahoo candles'], realtime: false, kind: 'signal' },
  coil:          { label: '🧬 Coil Radar',        feed: ['Yahoo candles'], realtime: false, kind: 'signal' },
  gapdown:       { label: '🐻 Gap-Down',          feed: ['Yahoo candles'], realtime: false, kind: 'signal' },
  biotech:       { label: '🧬 Biotech Radar',     feed: ['Yahoo candles', 'Claude web-search'], realtime: false, kind: 'signal' },
  coremo:        { label: '💼 Core Momentum',     feed: ['Yahoo candles'], realtime: false, kind: 'signal' },
  scoreboard:    { label: '📋 Scoreboard',        feed: ['Vercel Blob (computed from Yahoo history)'], realtime: false, kind: 'context' },
  sectors:       { label: '📊 Sectors',           feed: ['Yahoo sector ETFs'], realtime: false, kind: 'context' },
  rt:            { label: '🔗 Read-Through',       feed: ['Claude (Fable) over price/news'], realtime: false, kind: 'signal' },
  an:            { label: '🕵️ Stealth',          feed: ['Yahoo candles', 'Claude (Haiku) web-search'], realtime: false, kind: 'signal' },
  sw:            { label: '🌊 Second Wave',        feed: ['Claude (Fable) over price/news'], realtime: false, kind: 'signal' },
  ca:            { label: '🌐 Cross-Asset',        feed: ['Claude (Fable) cross-asset read'], realtime: false, kind: 'signal' },
  ts:            { label: '🎚️ Tone Shift',        feed: ['Claude (Haiku) earnings-call read'], realtime: false, kind: 'signal' },
};

const MS = require('./market-session');

const DEFAULT_STALE_HOURS = 30; // a daily-cron dashboard is stale if a source is >~1 day old

// Age of a source's data + a stale flag. asOf is an ISO string (or null → unknown).
function stalenessOf(asOf, nowMs, maxAgeHours = DEFAULT_STALE_HOURS) {
  if (!asOf) return { ageHours: null, stale: false, unknown: true };
  const t = Date.parse(asOf);
  if (!Number.isFinite(t)) return { ageHours: null, stale: false, unknown: true };
  const ageHours = +((nowMs - t) / 3.6e6).toFixed(1);
  return { ageHours, stale: ageHours > maxAgeHours, unknown: false };
}

// SESSION-AWARE staleness for an END-OF-DAY source. A wall-clock threshold is wrong for a
// daily dashboard: Friday's close is the newest data that can exist on Saturday, Sunday and
// a Monday holiday, yet it is >30h old the whole time. The honest question is "has this
// source reached the session it should have reached by now?" — the exchange calendar
// answers that (lib/market-session sessionDue), with a grace for the nightly run itself
// (the cron starts ~2h after the bell and takes a while to publish).
const EOD_SOURCE_SETTLE_MS = 4 * 60 * 60 * 1000;
function sessionStalenessOf(asOf, nowMs, settleMs = EOD_SOURCE_SETTLE_MS) {
  const base = stalenessOf(asOf, nowMs);
  if (base.unknown) return { ...base, basis: 'unknown', sessionDue: null, asOfSession: null };
  const due = MS.sessionDue(new Date(nowMs), settleMs);
  const asOfSession = MS.etParts(new Date(Date.parse(asOf))).date;
  // The calendar could not name a due session (bounded scan exhausted) → fall back to the
  // age rule rather than guess.
  if (!due) return { ...base, basis: 'age', sessionDue: null, asOfSession };
  return { ageHours: base.ageHours, stale: asOfSession < due, unknown: false, basis: 'session', sessionDue: due, asOfSession };
}

// Enrich the raw per-source freshness rows ({source, ok, ms, asOf}) with provenance +
// staleness. Pure: caller injects nowMs so it's deterministic/testable. EOD sources are
// judged against the exchange calendar; a real-time source keeps the plain age rule.
// A missing/unparseable timestamp is UNKNOWN (timestampKnown:false) — never fresh.
function enrichFreshness(rows, nowMs) {
  return (rows || []).map(r => {
    const meta = SOURCE_META[r.source] || { label: r.source, feed: ['unknown'], realtime: false, kind: 'signal' };
    const s = meta.realtime ? { ...stalenessOf(r.asOf, nowMs), basis: 'age', sessionDue: null } : sessionStalenessOf(r.asOf, nowMs);
    return {
      ...r, label: meta.label, feed: meta.feed, realtime: meta.realtime, kind: meta.kind,
      delayed: !meta.realtime, ageHours: s.ageHours, stale: s.stale, timestampKnown: !s.unknown,
      staleBasis: s.unknown ? 'unknown' : s.basis, sessionDue: s.sessionDue || null,
    };
  });
}

// The four evidence-basis buckets — so the UI can separate what's a VERIFIED FACT from
// a CALCULATED FEATURE from an AI INTERPRETATION from an UNCONFIRMED claim. This is a
// fixed legend (what each class of app output is grounded in), not per-request data.
const DATA_TRUST_LEGEND = [
  { key: 'fact',    icon: '✅', label: 'Verified fact',      basis: 'Exchange price/volume (Yahoo), SEC filings (EDGAR), earnings dates (FMP/Finnhub).' },
  { key: 'feature', icon: '🧮', label: 'Calculated feature', basis: 'The app’s own math: momentum, percentiles, pillar scores, regime, composite rank.' },
  { key: 'ai',      icon: '🤖', label: 'AI interpretation',  basis: 'Claude/Fable narratives, earnings-call tone, read-through theses, biotech catalyst reads — reasoning over the facts, not a fact.' },
  { key: 'unknown', icon: '❔', label: 'Unconfirmed',        basis: 'Social mentions, unverified catalysts, anything flagged low-confidence — treat as a lead, not proof.' },
];

module.exports = { SOURCE_META, DATA_TRUST_LEGEND, DEFAULT_STALE_HOURS, EOD_SOURCE_SETTLE_MS, stalenessOf, sessionStalenessOf, enrichFreshness };

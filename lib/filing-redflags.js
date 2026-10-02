'use strict';
// FILING RED FLAGS — pure core of the AVOID-side shadow lane (weight 0, never a score input).
//
// Six SEC-filing events the literature and this registry's own history (dilution-events,
// buyback-authorization-8k, activist-13d-initial) say are followed by SPY-underperformance:
//   NT_FIRST            NT 10-K / NT 10-Q late-filing notice, FIRST in 252 sessions
//   ITEM_4_02           8-K Item 4.02 non-reliance on previously issued financials (restatement)
//   ITEM_4_01           8-K Item 4.01 change in certifying accountant, stand-alone (no Item 2.02)
//   ITEM_3_01           8-K Item 3.01 notice of delisting / failure to satisfy a listing rule
//   ITEM_5_02_CXO       8-K Item 5.02 where the primary document names a CEO/CFO departure
//   GOING_CONCERN_FIRST 10-K/10-Q full-text hit for "substantial doubt" + "going concern", first in 252 sessions
//
// The lane is an AVOID hypothesis: the expectation is NEGATIVE cost-net SPY-excess from the
// next open at 5/21/63 sessions, measured by the Scoreboard on the `redflags` contract and
// decided by the registry rows (lib/research/hypothesis-registry.js, ids redflag-*). The
// same-name placebo 126 sessions earlier separates the filing effect from a chronic-loser
// name effect — the lesson of activist-13d-initial. Nothing here may ever gate, rank, size
// or alert: it renders as a labeled 🚩 research chip and accrues a ledger. That is all.
//
// Pure module: no network, no clock, no store. I/O lives in lib/filing-redflags-feed.js.

const VERSION = 'filing-redflags-v1';
const EXCLUDED_TIER = 'EXCLUDED';

// Frozen BEFORE the first ledger day. Do not tune against the ledger.
const FROZEN = Object.freeze({
  version: VERSION,
  // "First in 252 sessions" is implemented on a 365 calendar-day proxy: the state machine
  // stores filing dates (immutable public record) and a session calendar would add a
  // dependency for a one-day difference around holidays. Stated here; never re-fitted.
  firstInSessions: 252,
  firstInCalendarDays: 365,
  // Same-name placebo: the identical outcome construction 126 sessions earlier, requiring
  // ≥60 prior bars (the kit's eligibility floor) at the placebo decision bar.
  placeboShiftSessions: 126,
  minPriorBars: 60,
  // Kit eligibility (research/lib/experiment-kit + the external-events preregistration).
  eligibility: Object.freeze({ minBars: 60, minClose: 2, minAdv60: 2e6 }),
  // The chip stays on a name while its most recent event is inside ~63 sessions.
  flagWindowDays: 91,
  horizons: Object.freeze([5, 21, 63]),
  minDevEventsPerFlag: 300,
});

const FLAGS = Object.freeze({
  NT_FIRST: Object.freeze({ hypothesisId: 'redflag-nt-first', label: 'Late-filing notice (NT 10-K / NT 10-Q), first in a year' }),
  ITEM_4_02: Object.freeze({ hypothesisId: 'redflag-item-4-02', label: '8-K Item 4.02 — non-reliance on prior financials (restatement)' }),
  ITEM_4_01: Object.freeze({ hypothesisId: 'redflag-item-4-01', label: '8-K Item 4.01 — auditor change (stand-alone)' }),
  ITEM_3_01: Object.freeze({ hypothesisId: 'redflag-item-3-01', label: '8-K Item 3.01 — listing deficiency / delisting notice' }),
  ITEM_5_02_CXO: Object.freeze({ hypothesisId: 'redflag-item-5-02-cxo', label: '8-K Item 5.02 — CEO/CFO departure' }),
  GOING_CONCERN_FIRST: Object.freeze({ hypothesisId: 'redflag-going-concern-first', label: '10-K/10-Q "substantial doubt" going-concern language, first in a year' }),
});

const DAY_MS = 86_400_000;

// Liquidity tier by as-of 60-session dollar volume — the kit's thresholds
// (research/lib/experiment-kit costFractions), so the live ledger and the research
// pass charge the same cost tier to the same name.
const LIQUID_ADV = 2e7;
const SMALL_ADV = 5e6;
function costFractionTier(dollarVol) {
  if (!Number.isFinite(dollarVol)) return 'micro';
  return dollarVol >= LIQUID_ADV ? 'liquid' : dollarVol >= SMALL_ADV ? 'small' : 'micro';
}

// ── 8-K items ────────────────────────────────────────────────────────────────
function parseItems(items) {
  return String(items || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// Item codes → direct flags. 4.01 counts only without a 2.02 earnings release in the same
// filing (an auditor rotation disclosed alongside results is routine housekeeping). 5.02 is
// a CANDIDATE: officer changes are mostly appointments, so the primary document decides.
function classify8kItems(items) {
  const set = new Set(items || []);
  const flags = [];
  if (set.has('4.02')) flags.push('ITEM_4_02');
  if (set.has('4.01') && !set.has('2.02')) flags.push('ITEM_4_01');
  if (set.has('3.01')) flags.push('ITEM_3_01');
  return { flags, needsText: set.has('5.02') };
}

// ── 5.02 text classifier ─────────────────────────────────────────────────────
const ROLE_RE = /\b(chief executive officer|chief financial officer|principal executive officer|principal financial officer|CEO|CFO)\b/gi;
const DEPART_RE = /\b(resign\w*|retir\w*|depart\w*|terminat\w*|step(?:ped|s)?\s+down|separat\w*|remov\w*|ceas\w*|dismiss\w*|no longer serv\w*)\b/i;
const CONTEXT_CHARS = 320;

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function roleCode(match) {
  const m = match.toLowerCase();
  return (m.includes('executive') || m === 'ceo') ? 'CEO' : 'CFO';
}

// A CEO/CFO role mention with departure language within CONTEXT_CHARS of it.
function classify502Text(html) {
  const text = stripHtml(html);
  if (!text) return { cxoDeparture: false, roles: [] };
  const roles = new Set();
  for (const m of text.matchAll(ROLE_RE)) {
    const window = text.slice(Math.max(0, m.index - CONTEXT_CHARS), m.index + m[0].length + CONTEXT_CHARS);
    if (DEPART_RE.test(window)) roles.add(roleCode(m[0]));
  }
  const list = [...roles].sort();
  return { cxoDeparture: list.length > 0, roles: list };
}

// ── Daily form index (form.YYYYMMDD.idx) ─────────────────────────────────────
// Rows: `<form> <company…> <cik> <yyyymmdd> <path>`; form types may contain a space
// ("NT 10-K"). Amendments (…/A) are excluded: they revise an event already counted.
const INDEX_ROW_RE = /^(8-K|NT 10-K|NT 10-Q)\s+(.*?)\s+(\d+)\s+(\d{8})\s+(edgar\/data\/\d+\/(\d{10}-\d{2}-\d{6})\.txt)\s*$/;

function parseDailyIndex(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = INDEX_ROW_RE.exec(line);
    if (!m) continue;
    const d = m[4];
    out.push({
      form: m[1], company: m[2].trim(), cik: m[3].padStart(10, '0'),
      dateFiled: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
      fileName: m[5], accession: m[6],
    });
  }
  return out;
}

const ntKind = (form) => (form === 'NT 10-K' || form === 'NT 10-Q' ? 'NT' : null);

// ── First-in-window state machine ────────────────────────────────────────────
// state = { version, byTicker: { TICKER: { NT: 'YYYY-MM-DD', GC: 'YYYY-MM-DD' } } }.
// Immutable: advanceState returns a new document; isFirstIn is a pure read.
const emptyState = () => ({ version: VERSION, byTicker: {} });

function isFirstIn(state, ticker, kind, date, { windowDays = FROZEN.firstInCalendarDays } = {}) {
  const prev = state && state.byTicker && state.byTicker[ticker] && state.byTicker[ticker][kind];
  if (!prev) return true;
  if (prev === date) return true;                       // the same event seen again (re-tick)
  const gapDays = (Date.parse(date) - Date.parse(prev)) / DAY_MS;
  if (!Number.isFinite(gapDays)) return true;
  return gapDays > windowDays;
}

function advanceState(state, ticker, kind, date) {
  const byTicker = (state && state.byTicker) || {};
  const cur = byTicker[ticker] || {};
  const prev = cur[kind];
  const next = prev && prev >= date ? prev : date;
  return { ...(state || emptyState()), version: VERSION, byTicker: { ...byTicker, [ticker]: { ...cur, [kind]: next } } };
}

// ── Placebo / decision-bar math ──────────────────────────────────────────────
function placeboIndex(decisionIdx, { shift = FROZEN.placeboShiftSessions, minPriorBars = FROZEN.minPriorBars } = {}) {
  if (!Number.isInteger(decisionIdx)) return null;
  const pi = decisionIdx - shift;
  return pi >= minPriorBars ? pi : null;
}

// The decision bar: the last session whose date ≤ eventDate (-1 when none).
function decisionIndex(candles, eventDate) {
  const c = candles || [];
  for (let i = c.length - 1; i >= 0; i--) if (c[i] && c[i].date <= eventDate) return i;
  return -1;
}

function placeboDecisionDate(candles, eventDate, opts) {
  const i = decisionIndex(candles, eventDate);
  if (i < 0) return null;
  const pi = placeboIndex(i, opts);
  return pi == null ? null : candles[pi].date;
}

// ── Eligibility + ledger row ─────────────────────────────────────────────────
function classifyEligibility(facts) {
  if (!facts) return { eligible: false, reasons: ['no-history'], liqTier: null };
  const E = FROZEN.eligibility;
  const reasons = [];
  if (!(facts.bars >= E.minBars)) reasons.push('too-few-bars');
  if (!(facts.close >= E.minClose)) reasons.push('sub-$2');
  if (!(facts.adv60 >= E.minAdv60)) reasons.push('adv60-below-$2M');
  return { eligible: reasons.length === 0, reasons, liqTier: costFractionTier(facts.adv60) };
}

const eventKey = (e) => `${e.ticker}|${e.flag}|${e.accession}`;

// One Scoreboard row per event (section RedFlags, graded on the `redflags` contract).
// `scope` is the MEASURED as-of liquidity tier so lib/costs tierForPick charges the row by
// what it was; absent history ⇒ no scope ⇒ the section's conservative default.
function ledgerRow(event, facts, tickDate) {
  const elig = classifyEligibility(facts);
  return {
    ticker: event.ticker, cik: event.cik || null,
    flag: event.flag, tier: elig.eligible ? event.flag : EXCLUDED_TIER, liqTier: elig.liqTier, reasons: elig.reasons,
    scope: elig.liqTier === 'liquid' ? 'large' : (elig.liqTier || null),
    date: tickDate, eventDate: event.filingDate, form: event.form, accession: event.accession,
    detail: event.detail || null,
    close: facts ? facts.close : null, adv60: facts ? facts.adv60 : null, priceAsOf: facts ? facts.asOf : null,
    entry: null, fillPolicy: 'next-session-open', side: 'long', key: eventKey(event),
  };
}

module.exports = {
  VERSION, FROZEN, FLAGS, EXCLUDED_TIER,
  parseItems, classify8kItems, classify502Text, stripHtml,
  parseDailyIndex, ntKind,
  emptyState, isFirstIn, advanceState,
  placeboIndex, decisionIndex, placeboDecisionDate,
  classifyEligibility, ledgerRow, eventKey, costFractionTier,
};

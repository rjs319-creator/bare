'use strict';
// SHARED INTRADAY DATA ACCESS — one place that answers "what bars do we actually have, how
// old are they, and which of them are allowed to be used as evidence".
//
// This module is a THIN, HONEST layer over primitives the app already has:
//   lib/intraday-capture.js  — the Yahoo 5-minute chart fetch (two hosts, hard timeouts)
//   lib/intraday-features.js — completed/forming bar split, ET session minutes, session grouping
//   lib/market-session.js    — the exchange calendar (holidays, early closes)
// Rather than reimplementing any of that, it composes them and adds the contract the new
// staged system needs: bar validation, per-ticker failure isolation, bounded concurrency,
// same-bar caching, and a freshness verdict that FAILS CLOSED.
//
// TWO RULES THAT ARE NEVER RELAXED:
//   1. A FORMING bar is not evidence. It may be labelled and displayed as provisional, but no
//      confirmation may consume it. (Enforced by splitCompletedForming upstream and by
//      completedBarsOnly here.)
//   2. Five-minute data is never described as real-time. `barResolutionMinutes` travels with
//      every result and `temporalResolutionRisk` is set whenever 5-minute is all we have —
//      which keeps the affected setups in paper mode.

const { fetchFiveMin, extractSessionBars, BAR_PROVIDER_CAPABILITY } = require('./intraday-capture');
const feat = require('./intraday-features');
const { ENTRY, DISCOVERY } = require('./lowfloat-config');

const MIN_MS = 60_000;
const BAR_INTERVAL_MIN = 5;

// ── Session status ───────────────────────────────────────────────────────────
// Wraps lib/market-session so the new stack has ONE session answer (calendar-aware, DST-safe),
// and adds the minute-of-session fields the continuation model needs.
function sessionStatus(now = new Date()) {
  let info = null;
  try { info = require('./market-session').sessionInfoAt(now); } catch { info = null; }
  const etMin = feat.etMinutes(now);
  const minutesSinceOpen = etMin - feat.OPEN_MIN;
  const minutesUntilClose = feat.CLOSE_MIN - etMin;
  const etDate = feat.etDate(now);
  const isRegular = info ? info.session === 'REGULAR' : (minutesSinceOpen >= 0 && minutesUntilClose > 0);
  return {
    now: new Date(now).toISOString(),
    etDate,
    session: info ? info.session : (isRegular ? 'REGULAR' : 'CLOSED'),
    isRegularHours: !!isRegular,
    minutesSinceOpen: minutesSinceOpen,
    minutesUntilClose: Math.max(0, minutesUntilClose),
    sessionOpenIso: sessionOpenIso(now),
    calendarAvailable: !!info,
  };
}

// ISO instant of 09:30 ET on the ET date of `now`. Used to bound "published during this
// session" questions without importing a timezone library.
function sessionOpenIso(now = new Date()) {
  const d = new Date(now);
  const etMin = feat.etMinutes(d);
  return new Date(d.getTime() - (etMin - feat.OPEN_MIN) * MIN_MS).toISOString();
}

// ── Bar validation ───────────────────────────────────────────────────────────
// Rejects malformed and physically impossible OHLCV rather than passing them into the
// feature math where they would produce plausible-looking nonsense.
function validateBars(bars) {
  const clean = [];
  const rejected = { missingField: 0, nonPositive: 0, inconsistentRange: 0, badTimestamp: 0, outOfOrder: 0, absurdMove: 0 };
  let lastMs = -Infinity;
  for (const b of bars || []) {
    if (!b || b.o == null || b.h == null || b.l == null || b.c == null) { rejected.missingField++; continue; }
    const o = +b.o, h = +b.h, l = +b.l, c = +b.c, v = +(b.v ?? 0);
    if (![o, h, l, c].every(Number.isFinite) || o <= 0 || h <= 0 || l <= 0 || c <= 0 || v < 0) { rejected.nonPositive++; continue; }
    if (h < l || h < Math.max(o, c) - 1e-9 || l > Math.min(o, c) + 1e-9) { rejected.inconsistentRange++; continue; }
    const ms = Date.parse(b.t);
    if (!Number.isFinite(ms)) { rejected.badTimestamp++; continue; }
    if (ms < lastMs) { rejected.outOfOrder++; continue; }
    // A single 5-minute bar whose range exceeds 10× its own open is a data artifact, not a
    // trade. (Even LULD-halted reopenings do not print this within one bar.)
    if (h / l > 10) { rejected.absurdMove++; continue; }
    lastMs = ms;
    clean.push({ t: new Date(ms).toISOString(), o, h, l, c, v });
  }
  const rejectedCount = Object.values(rejected).reduce((a, x) => a + x, 0);
  return { bars: clean, rejected, rejectedCount, valid: clean.length > 0 };
}

// Regular-hours bars for ONE session date, sorted. Delegates the RTH filter to the shared
// session grouping so premarket/postmarket handling matches the rest of the app.
function regularSessionBars(bars, sessionDate) {
  if (!Array.isArray(bars)) return [];
  return bars
    .filter(b => b && feat.etDate(b.t) === sessionDate)
    .filter(b => { const m = feat.etMinutes(b.t); return m >= feat.OPEN_MIN && m < feat.CLOSE_MIN; })
    .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

// Completed bars only — the evidence set. `now` is explicit so tests and replay are exact.
function completedBarsOnly(bars, now = new Date(), { intervalMin = BAR_INTERVAL_MIN } = {}) {
  return feat.splitCompletedForming(bars, new Date(now).toISOString(), { intervalMin }).completed;
}

function formingBar(bars, now = new Date(), { intervalMin = BAR_INTERVAL_MIN } = {}) {
  const f = feat.splitCompletedForming(bars, new Date(now).toISOString(), { intervalMin }).forming;
  return f.length ? f[f.length - 1] : null;
}

// ── Freshness verdict (FAILS CLOSED) ─────────────────────────────────────────
// Missing timestamps, future timestamps and over-age bars all resolve to stale. A caller can
// therefore treat `stale === false` as a positive assertion, which is what an entry gate needs.
function dataFreshness(bars, providerMetadata = {}, now = new Date()) {
  const nowMs = new Date(now).getTime();
  const completed = completedBarsOnly(bars, now);
  const forming = formingBar(bars, now);
  const newestObserved = (forming || completed[completed.length - 1]) || null;

  if (!completed.length) {
    return {
      stale: true, reason: 'no completed current-session bars',
      lastCompletedBarAt: null, lastCompletedBarEndAt: null, barAgeMinutes: null,
      newestObservedBarAt: newestObserved ? newestObserved.t : null,
      formingBarPresent: !!forming,
      providerTimestamp: providerMetadata.providerTimestamp || null,
      barResolutionMinutes: providerMetadata.barResolutionMinutes || BAR_INTERVAL_MIN,
      temporalResolutionRisk: true,
    };
  }

  const last = completed[completed.length - 1];
  const endMs = Date.parse(last.t) + BAR_INTERVAL_MIN * MIN_MS;
  const ageMin = (nowMs - endMs) / MIN_MS;
  // A bar that ENDS in the future beyond publication tolerance is contradictory data.
  const futureSkewMin = -ageMin;
  const contradictory = futureSkewMin > 1.5;
  const tooOld = ageMin > ENTRY.MAX_COMPLETED_BAR_AGE_MINUTES;
  const resolution = providerMetadata.barResolutionMinutes || BAR_INTERVAL_MIN;

  return {
    stale: contradictory || tooOld,
    reason: contradictory ? 'bar timestamp is in the future (clock skew or corrupt feed)'
      : tooOld ? `newest completed bar is ${ageMin.toFixed(1)} min old (limit ${ENTRY.MAX_COMPLETED_BAR_AGE_MINUTES})`
      : null,
    lastCompletedBarAt: last.t,
    lastCompletedBarEndAt: new Date(endMs).toISOString(),
    barAgeMinutes: +ageMin.toFixed(2),
    newestObservedBarAt: newestObserved ? newestObserved.t : null,
    formingBarPresent: !!forming,
    providerTimestamp: providerMetadata.providerTimestamp || null,
    barResolutionMinutes: resolution,
    // Five-minute bars cannot resolve the order of a target and a stop inside one bar, and
    // cannot time an entry within the bar. Anything relying on them stays in paper mode.
    temporalResolutionRisk: resolution >= BAR_INTERVAL_MIN,
  };
}

// ── Same-bar cache ───────────────────────────────────────────────────────────
// Within one completed 5-minute interval the bars cannot change, so repeated calls in the
// same interval reuse the fetch. Process-local by design: it must never outlive an
// invocation, because a warm Lambda serving a later interval must refetch.
const _barCache = new Map();   // ticker → { slot, result, at }

function intervalSlot(now = new Date()) {
  return Math.floor(new Date(now).getTime() / (BAR_INTERVAL_MIN * MIN_MS));
}

function cacheKey(ticker) { return String(ticker || '').toUpperCase(); }

// ── Fetch for ONE ticker ─────────────────────────────────────────────────────
// Returns a fully-described result — never throws. A failed ticker yields `ok:false` with a
// reason, so one bad name can never take down a scan.
async function fetchIntradayBars(ticker, { now = new Date(), sessionDate = null, useCache = true } = {}) {
  const sym = cacheKey(ticker);
  if (!/^[A-Z][A-Z0-9.-]{0,6}$/.test(sym)) {
    return { ok: false, ticker: sym, reason: 'invalid ticker', bars: [], priorSessions: [] };
  }
  const slot = intervalSlot(now);
  if (useCache) {
    const hit = _barCache.get(sym);
    if (hit && hit.slot === slot) return { ...hit.result, cached: true };
  }

  let raw = null;
  try { raw = await fetchFiveMin(sym); } catch { raw = null; }
  if (!raw) {
    const out = { ok: false, ticker: sym, reason: 'provider returned no chart', bars: [], priorSessions: [], provider: BAR_PROVIDER_CAPABILITY.provider };
    return out;   // failures are NOT cached — the next interval retries immediately
  }

  const day = sessionDate || feat.etDate(now);
  const byDate = feat.sessionsFromResult(raw);
  const todayRaw = byDate[day] || [];
  const validated = validateBars(todayRaw);
  const priorDates = Object.keys(byDate).filter(d => d < day).sort();
  const priorSessions = priorDates.slice(-5).map(d => validateBars(byDate[d]).bars);

  const providerMeta = {
    providerTimestamp: raw.meta && raw.meta.regularMarketTime
      ? new Date(raw.meta.regularMarketTime * 1000).toISOString() : null,
    barResolutionMinutes: BAR_INTERVAL_MIN,
  };
  const freshness = dataFreshness(validated.bars, providerMeta, now);

  const result = {
    ok: true,
    ticker: sym,
    sessionDate: day,
    bars: validated.bars,
    completed: completedBarsOnly(validated.bars, now),
    forming: formingBar(validated.bars, now),
    priorSessions,
    prevClose: raw.meta && raw.meta.chartPreviousClose != null ? +raw.meta.chartPreviousClose : null,
    validation: { rejected: validated.rejected, rejectedCount: validated.rejectedCount },
    freshness,
    provider: BAR_PROVIDER_CAPABILITY.provider,
    barResolutionMinutes: BAR_INTERVAL_MIN,
    temporalResolutionRisk: freshness.temporalResolutionRisk,
    capabilities: BAR_PROVIDER_CAPABILITY,
    cached: false,
  };
  if (useCache) _barCache.set(sym, { slot, result, at: Date.now() });
  // Bound the process-local cache so a long-lived warm instance cannot grow without limit.
  if (_barCache.size > 800) {
    for (const k of [..._barCache.keys()].slice(0, 400)) _barCache.delete(k);
  }
  return result;
}

// ── Bounded-concurrency batch ────────────────────────────────────────────────
// Deadline-aware: names not reached before the deadline come back as explicit failures with
// reason 'deadline', so the coverage report can distinguish "we didn't look" from "it failed".
async function fetchIntradayBatch(tickers, {
  now = new Date(), sessionDate = null, concurrency = DISCOVERY.YAHOO_CONCURRENCY,
  deadline = DISCOVERY.REQUEST_DEADLINE_MS, t0 = Date.now(), cap = DISCOVERY.INTRADAY_ENRICHMENT_CAP,
} = {}) {
  const list = [...new Set((tickers || []).map(cacheKey).filter(Boolean))].slice(0, cap);
  const byTicker = {};
  let i = 0, ok = 0, failed = 0, deadlineSkipped = 0;

  const worker = async () => {
    while (i < list.length) {
      if (Date.now() - t0 > deadline) return;
      const t = list[i++];
      const r = await fetchIntradayBars(t, { now, sessionDate });
      byTicker[t] = r;
      if (r.ok) ok++; else failed++;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length || 1)) }, worker));

  for (const t of list) {
    if (!byTicker[t]) {
      byTicker[t] = { ok: false, ticker: t, reason: 'deadline', bars: [], priorSessions: [] };
      deadlineSkipped++;
    }
  }
  return {
    byTicker,
    coverage: {
      requested: list.length, enriched: ok, failed, deadlineSkipped,
      coveragePct: list.length ? +((ok / list.length) * 100).toFixed(1) : null,
      provider: BAR_PROVIDER_CAPABILITY.provider,
      barResolutionMinutes: BAR_INTERVAL_MIN,
      capabilities: BAR_PROVIDER_CAPABILITY,
      note: 'Five-minute regular-hours bars. NOT real-time: the newest bar is confirmed only after its interval completes, and no premarket bars or bid/ask are available from this feed.',
    },
  };
}

function clearBarCache() { _barCache.clear(); }

module.exports = {
  BAR_INTERVAL_MIN,
  sessionStatus, sessionOpenIso, validateBars, regularSessionBars, completedBarsOnly,
  formingBar, dataFreshness, fetchIntradayBars, fetchIntradayBatch, intervalSlot, clearBarCache,
  BAR_PROVIDER_CAPABILITY, extractSessionBars,
};

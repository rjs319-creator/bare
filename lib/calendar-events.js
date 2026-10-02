'use strict';
// CALENDAR EVENTS — official calendar rows (lib/nasdaq-calendar) → the two consumers
// that take scheduled events (calendar-events-v1). Pure; every function takes `now`.
//
//   toScheduledEvents()  pulse2-freshness vocabulary: a scheduled calendar item has a KNOWN
//                        event time (the ex/execution/report date, publisher confidence) and
//                        a known publication time when the venue gives an announcement date.
//                        Discovery time is stamped separately, so a split first seen today
//                        that was announced three weeks ago is never presented as "new".
//   splitsToCernEvents() CERN forced-flow CANDIDATE events (type SPLIT_FLOW, shadow/logOnly):
//                        a forward split moves nothing fundamental but reshuffles share
//                        counts in index/ETF baskets and retail access; a reverse split is
//                        usually a listing-compliance distress signal. Both are logged for
//                        the counterfactual archive only — no paper position is ever taken
//                        until the ledger shows a kernel.

const { DATE_CONFIDENCE } = require('./pulse2-freshness');

const CALENDAR_EVENTS_VERSION = 'calendar-events-v1';
const KIND_DATE = Object.freeze({ earnings: 'date', splits: 'executionDate', dividends: 'exDate' });
const SPLIT_WINDOW_BEFORE_D = 3;   // flow starts a few sessions before execution
const SPLIT_WINDOW_AFTER_D = 7;    // and the post-execution giveback is the measured leg
const SPLIT_FLOW_ADV_MULT = 2;     // estFlowShares ≈ 2 days of ADV (reshuffle, not a passive rebalance)
const DAY_MS = 86_400_000;

const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const dayStartIso = (iso) => `${iso}T00:00:00.000Z`;
const confidence = DATE_CONFIDENCE.includes('publisher') ? 'publisher' : DATE_CONFIDENCE[0];

/** Calendar rows → pulse2-freshness-shaped scheduled events. Rows without a date are dropped. */
function toScheduledEvents(kind, rows, { now = Date.now(), source = 'nasdaq' } = {}) {
  const dateKey = KIND_DATE[kind];
  if (!dateKey) throw new TypeError(`calendar-events: unknown kind "${kind}"`);
  const seen = new Date(now).toISOString();
  return (rows || []).filter((r) => r && r.symbol && isIsoDate(r[dateKey])).map((r) => ({
    id: `calendar:${kind}:${r.symbol}:${r[dateKey]}`,
    kind, ticker: r.symbol, scheduled: true, source,
    eventOccurredAt: dayStartIso(r[dateKey]),
    firstPublishedAt: isIsoDate(r.announcementDate) ? dayStartIso(r.announcementDate) : null,
    firstSeenAt: seen, lastSeenAt: seen, lastCorroboratedAt: null,
    dateConfidence: confidence,
    detail: kind === 'splits' ? { ratio: r.ratio, factor: r.factor, reverse: !!r.reverse }
      : kind === 'dividends' ? { rate: r.rate, recordDate: r.recordDate, payDate: r.payDate }
        : { time: r.time, epsForecast: r.epsForecast },
  }));
}

/**
 * Splits with an execution date inside the flow window → CERN candidate events.
 * `advShares(symbol)` supplies the flow estimate (null → the event is skipped: no bars, no event).
 */
function splitsToCernEvents(rows, { nowMs = Date.now(), advShares = () => null, before = SPLIT_WINDOW_BEFORE_D, after = SPLIT_WINDOW_AFTER_D, max = 20 } = {}) {
  const out = [];
  for (const r of rows || []) {
    if (!r || !r.symbol || !isIsoDate(r.executionDate) || !Number.isFinite(r.factor)) continue;
    const execMs = Date.parse(dayStartIso(r.executionDate));
    const deltaD = (execMs - nowMs) / DAY_MS;
    if (deltaD > before || deltaD < -after) continue;
    const adv = advShares(r.symbol);
    if (!(adv > 0)) continue;
    out.push({
      type: 'SPLIT_FLOW', symbol: r.symbol, dateMs: execMs,
      // Forward split: mechanical demand into execution, fade after (short the giveback,
      // direction +1 like INDEX_ADD_FADE). Reverse split: forced/distressed supply, dir −1.
      direction: r.factor >= 1 ? 1 : -1,
      estFlowShares: SPLIT_FLOW_ADV_MULT * adv,
      meta: { source: 'nasdaq-splits', ratio: r.ratio, factor: r.factor, reverse: r.factor < 1, executionDate: r.executionDate, shadow: true },
    });
    if (out.length >= max) break;
  }
  return out;
}

module.exports = { CALENDAR_EVENTS_VERSION, KIND_DATE, SPLIT_WINDOW_BEFORE_D, SPLIT_WINDOW_AFTER_D, SPLIT_FLOW_ADV_MULT, toScheduledEvents, splitsToCernEvents };

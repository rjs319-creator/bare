'use strict';
// RLT TRANSITION ALERTS — server-authoritative, transition-only, deduplicated.
// Modeled on lib/daytrade-alerts.js (the proven template): only a REASON-CODED
// STATE TRANSITION can alert, and each (ticker, toState) pair alerts AT MOST
// ONCE per day — the dedup key is persisted in the day's alert log before the
// user-facing feed is written, so refreshes/races can never re-emit.
//
// Every alert states: what changed, why it matters, the trigger/state, the
// invalidation, the timeframe, watch-only vs actionable, and the data/
// calibration state. In shadow mode EVERY alert is watch-only by definition.
//
// Unchanged states never re-alert (transition-only by construction).

const { readJSON, writeJSON, hasStore, readNotifyFeed, writeNotifyFeed } = require('./store');
const { STATES } = require('./rlt-states');

const alertsKey = date => `rlt/alerts/${date}.json`;
const FEED_CAP = 80;

// Which transitions alert, and how loudly. Everything else is board-only.
const ALERT_KIND = Object.freeze({
  [STATES.EMERGING_LEADER]: { kind: 'NEW EMERGING LEADER', sev: 'low' },
  [STATES.PRIMED]: { kind: 'PRIMED', sev: 'low' },
  [STATES.ARMED]: { kind: 'ARMED NEAR TRIGGER', sev: 'med' },
  [STATES.TRIGGERED]: { kind: 'TRIGGERED', sev: 'high' },
  [STATES.ACCEPTED]: { kind: 'TRIGGER ACCEPTED', sev: 'high' },
  [STATES.WEAKENING]: { kind: 'LEADERSHIP WEAKENING', sev: 'med' },
  [STATES.INVALIDATED]: { kind: 'INVALIDATED', sev: 'med' },
  [STATES.COMPLETED]: { kind: 'COMPLETED', sev: 'low' },
});

function classifyTransition(tr) {
  if (!tr || !tr.newState) return null;
  const meta = ALERT_KIND[tr.newState];
  if (!meta) return null;   // DISCOVERED / EXPIRED / DROPPED are board-only
  // Extension caution: an ARMED/PRIMED name that fell back purely on extension.
  if (tr.newState === STATES.WEAKENING && (tr.reasonCodes || []).includes('TOO_EXTENDED')) {
    return { kind: 'ENTRY TOO EXTENDED', sev: 'low' };
  }
  return meta;
}

/** Sector-level alert when a sector flips to WEAKENING/RISK_OFF. */
function sectorRolloverAlerts(prevSectorStates, nextSectorStates, date) {
  const out = [];
  if (!prevSectorStates || !nextSectorStates) return out;
  for (const [sector, next] of Object.entries(nextSectorStates)) {
    const prev = prevSectorStates[sector];
    const was = prev ? prev.state : null;
    const now = next ? next.state : null;
    if (now === was) continue;
    if ((now === 'WEAKENING' || now === 'RISK_OFF') && was && was !== 'INSUFFICIENT_DATA') {
      out.push({
        id: `rlt|sector|${sector}|${now}|${date}`,
        kind: 'SECTOR ROLLOVER', sev: 'med', sector, date,
        whatChanged: `${sector} sector state moved ${was} → ${now}`,
        whyItMatters: 'Open leadership candidates in this sector carry increased failure risk.',
        actionability: 'watch-only (shadow)',
        calibration: 'sector state is a labeled classification over measured breadth — no probability implied',
      });
    }
  }
  return out;
}

/** Build the full, structured alert from an RLT transition record. */
function buildAlert(tr, entry, { date } = {}) {
  const cls = classifyTransition(tr);
  if (!cls) return null;
  const setup = entry && entry.features && entry.features.setup ? entry.features.setup : {};
  const pivot = setup.pivot != null ? +setup.pivot.toFixed(2) : null;
  const stop = pivot != null && setup.atr != null ? +(pivot - setup.atr).toFixed(2) : null;
  const pct = tr.residualRank != null ? Math.round(tr.residualRank * 100) : null;
  return {
    id: `rlt|${tr.ticker}|${tr.newState}|${date}`,
    ticker: tr.ticker,
    date,
    at: tr.at || null,
    kind: cls.kind,
    sev: cls.sev,
    fromState: tr.prevState,
    toState: tr.newState,
    whatChanged: `${tr.ticker}: ${tr.prevState || 'not tracked'} → ${tr.newState}`,
    whyItMatters: pct != null
      ? `Sector-relative leadership at the ${pct}th peer percentile; reason: ${(tr.reasonCodes || []).join(', ') || 'state change'}`
      : `Reason: ${(tr.reasonCodes || []).join(', ') || 'state change'}`,
    trigger: pivot != null ? `acceptance above ${pivot}` : 'no structured trigger (watch)',
    invalidation: stop != null ? `thesis weakens below ${stop}` : 'no structured invalidation yet',
    timeframe: 'swing (5–21 sessions)',
    actionability: 'watch-only (shadow, weight-0 — never a buy signal)',
    calibration: entry && entry.calibrationStatus
      ? `calibration: ${entry.calibrationStatus} — rank/band only, no probability`
      : 'calibration: unavailable',
    sectorState: tr.sectorState || null,
  };
}

/**
 * Emit alerts for a day's transitions. Dedup: the durable log is written
 * FIRST; only genuinely new ids reach the notify feed.
 */
async function emitRltAlerts(transitions, inventoryByTicker, { date, prevSectorStates = null, nextSectorStates = null } = {}) {
  if (!hasStore() || !date) return { emitted: 0, reason: 'no-store-or-date' };
  const alerts = [];
  for (const tr of transitions || []) {
    const a = buildAlert(tr, inventoryByTicker ? inventoryByTicker[tr.ticker] : null, { date });
    if (a) alerts.push(a);
  }
  alerts.push(...sectorRolloverAlerts(prevSectorStates, nextSectorStates, date));
  if (!alerts.length) return { emitted: 0, reason: 'no-alertable-transitions' };

  const key = alertsKey(date);
  const day = await readJSON(key, { date, alerts: [] });
  const seen = new Set((day.alerts || []).map(a => a.id));
  const fresh = alerts.filter(a => !seen.has(a.id));
  if (!fresh.length) return { emitted: 0, reason: 'all-deduplicated' };

  await writeJSON(key, { date, alerts: [...(day.alerts || []), ...fresh] }, 0);

  const feed = await readNotifyFeed();
  const items = Array.isArray(feed.items) ? feed.items : [];
  const feedSeen = new Set(items.map(i => i.id));
  const feedFresh = fresh
    .filter(a => !feedSeen.has(a.id))
    .map(a => ({
      id: a.id, at: a.at || new Date().toISOString(), source: 'rlt',
      sev: a.sev, ticker: a.ticker || a.sector || null,
      title: `🧭 ${a.kind}${a.ticker ? ` — ${a.ticker}` : a.sector ? ` — ${a.sector}` : ''}`,
      body: `${a.whatChanged}. ${a.trigger !== undefined ? `Trigger: ${a.trigger}. ` : ''}${a.invalidation !== undefined ? `Invalidation: ${a.invalidation}. ` : ''}${a.actionability}`,
    }));
  if (feedFresh.length) {
    await writeNotifyFeed({ items: [...feedFresh, ...items].slice(0, FEED_CAP) });
  }
  return { emitted: fresh.length, feed: feedFresh.length };
}

async function readRltAlerts(date) {
  return readJSON(alertsKey(date), { date, alerts: [] });
}

module.exports = { classifyTransition, buildAlert, sectorRolloverAlerts, emitRltAlerts, readRltAlerts };

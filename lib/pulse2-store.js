'use strict';
// 📡 MARKET PULSE v2 — VERSIONED STORAGE (thin layer over lib/store Blob helpers).
//
// One authoritative writer per artifact; v2 lives under pulse/v2/* so it coexists
// with the legacy pulse/* ledger (which is never destructively rewritten).
//
//   pulse/v2/market-state/latest.json     writer: op=pulse2statetick
//   pulse/v2/market-state/prev.json       writer: op=pulse2statetick (previous snap for deltas)
//   pulse/v2/narratives/latest.json       writer: op=pulse2collect / op=pulse2refine
//   pulse/v2/events.json                  writer: op=pulse2collect (ledger fold)
//   pulse/v2/transitions.json             writer: op=pulse2collect (rolling)
//   pulse/v2/outcomes.json                writer: op=pulse2grade
//   pulse/v2/alert-state.json             writer: op=pulse2collect / statetick
//   pulse/v2/health.json                  writer: every privileged tick (merge)
//   pulse/v2/snap/<gen>.json              immutable per-generation archive (write-once)
//
// persisted:true is only ever claimed after a read-back (writeVerified).

const { readJSON, writeJSON, hasStore } = require('./store');

const KEYS = Object.freeze({
  MARKET_STATE: 'pulse/v2/market-state/latest.json',
  MARKET_STATE_PREV: 'pulse/v2/market-state/prev.json',
  NARRATIVES: 'pulse/v2/narratives/latest.json',
  EVENTS: 'pulse/v2/events.json',
  TRANSITIONS: 'pulse/v2/transitions.json',
  OUTCOMES: 'pulse/v2/outcomes.json',
  ALERT_STATE: 'pulse/v2/alert-state.json',          // writer: op=pulse2collect (event alerts)
  ALERTS: 'pulse/v2/alerts.json',                    // writer: op=pulse2collect (event alerts)
  MARKET_ALERTS: 'pulse/v2/alerts-market.json',      // writer: op=pulse2statetick (market alerts)
  HEALTH: 'pulse/v2/health.json',
  SNAP_PREFIX: 'pulse/v2/snap/',
});

const readMarketState = () => readJSON(KEYS.MARKET_STATE, null);
const readMarketStatePrev = () => readJSON(KEYS.MARKET_STATE_PREV, null);
const readNarratives = () => readJSON(KEYS.NARRATIVES, null);
const readEvents = () => readJSON(KEYS.EVENTS, { events: [] });
const readTransitions = () => readJSON(KEYS.TRANSITIONS, { transitions: [] });
const readOutcomes = () => readJSON(KEYS.OUTCOMES, { outcomes: [], summary: null, comparison: null });
const readAlertState = () => readJSON(KEYS.ALERT_STATE, { emitted: {}, lastByKind: {} });
const readAlerts = () => readJSON(KEYS.ALERTS, { alerts: [] });
const readMarketAlerts = () => readJSON(KEYS.MARKET_ALERTS, { alerts: [], state: { emitted: {}, lastByKind: {} } });
const readHealth = () => readJSON(KEYS.HEALTH, {});

const snapKey = gen => `${KEYS.SNAP_PREFIX}${String(gen).replace(/[^0-9A-Za-z_-]/g, '')}.json`;
const writeSnapshot = (gen, doc) => writeJSON(snapKey(gen), doc, 31536000);   // immutable

/** Write-then-read-back verification — persisted:true is earned, never assumed. */
async function writeVerified(key, doc, predicate, cacheMaxAge = 0) {
  if (!hasStore()) return false;
  try {
    await writeJSON(key, doc, cacheMaxAge);
    const back = await readJSON(key, null);
    return !!(back && (predicate ? predicate(back) : true));
  } catch { return false; }
}

const READBACK_RETRY_MS = 1500;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Write with honest two-part status: `written` (the put was accepted — a throw here IS
 * failure) and `verified` (a read-back matched the predicate). Vercel Blob overwrites
 * propagate with a 10-30s+ lag, so a read-back can serve the PRE-write copy long after
 * a successful put — that is a diagnostic, not a failure. One delayed retry is made;
 * callers treat written&&!verified as success with `verifiedReadback:false` in health,
 * never as a scheduler-visible 500.
 */
async function writeChecked(key, doc, predicate, cacheMaxAge = 0) {
  if (!hasStore()) return { written: false, verified: false };
  try {
    await writeJSON(key, doc, cacheMaxAge);
  } catch { return { written: false, verified: false }; }
  for (const delay of [0, READBACK_RETRY_MS]) {
    if (delay) await sleep(delay);
    try {
      const back = await readJSON(key, null);
      if (back && (predicate ? predicate(back) : true)) return { written: true, verified: true };
    } catch { /* verification only — the write already succeeded */ }
  }
  return { written: true, verified: false };
}

/** Merge a partial health record for one component into pulse/v2/health.json. */
async function mergeHealth(component, record) {
  if (!hasStore()) return false;
  try {
    const prior = await readHealth();
    const doc = { ...prior, [component]: { ...(prior[component] || {}), ...record }, updatedAt: new Date().toISOString() };
    await writeJSON(KEYS.HEALTH, doc, 0);
    return true;
  } catch { return false; }
}

module.exports = {
  KEYS, hasStore, snapKey,
  readMarketState, readMarketStatePrev, readNarratives, readEvents, readTransitions,
  readOutcomes, readAlertState, readAlerts, readMarketAlerts, readHealth,
  writeSnapshot, writeVerified, writeChecked, mergeHealth,
  writeJSON, readJSON,
};

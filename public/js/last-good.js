// 🕰 LAST-GOOD SNAPSHOT LAYER — remembers the last usable payload per op key (IndexedDB via the
// vendored idb-keyval, loaded as a classic script in index.html → globalThis.idbKeyval) and hands
// it back flagged `stale:true, asOf` when a refresh fails, returns an empty/degraded state, or was
// served by the service worker from its own cache. The caller renders an honest "as of HH:MM ·
// showing last good data" strip instead of an empty state. Pure merge logic is exported for tests;
// EVERY storage access is wrapped — a blocked IndexedDB must never break a render.
import './sw-policy.js';

const POLICY = globalThis.SW_POLICY;
export const LAST_GOOD_PREFIX = 'lastgood:';
// A week-old board is not "last good", it is history — refuse it and let the empty state show.
export const LAST_GOOD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const NY_TIME = { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' };
const NY_DAY = { timeZone: 'America/New_York', year: 'numeric', month: 'short', day: 'numeric' };

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function defaultStore() {
  const k = globalThis.idbKeyval;
  return k && typeof k.get === 'function' && typeof k.set === 'function' ? k : null;
}

function isValidEntry(v) {
  return isPlainObject(v) && typeof v.asOf === 'string' && Number.isFinite(Date.parse(v.asOf)) && isPlainObject(v.data);
}

export async function rememberSnapshot(key, data, nowMs = Date.now(), store = defaultStore()) {
  if (!store || !key || !isPlainObject(data)) return false;
  try { await store.set(LAST_GOOD_PREFIX + key, { asOf: new Date(nowMs).toISOString(), data }); return true; } catch { return false; }
}

export async function recallSnapshot(key, store = defaultStore()) {
  if (!store || !key) return null;
  try { const v = await store.get(LAST_GOOD_PREFIX + key); return isValidEntry(v) ? v : null; } catch { return null; }
}

// A payload is usable when it is a real, non-empty object that was NOT itself served from a cache.
export function isUsablePayload(p) {
  return isPlainObject(p) && p.stale !== true && !POLICY.isEmptyState(p);
}

function staleReasonFor(fresh, error) {
  if (error) return `refresh failed (${String((error && error.message) || error).slice(0, 120)})`;
  if (fresh == null) return 'refresh returned nothing';
  if (fresh.stale) return fresh.staleReason || 'served from the offline cache';
  return 'server returned an empty board';
}

/**
 * Pure: pick what to render. Returns `fresh` untouched when usable; otherwise a NEW object made
 * from the cached snapshot with {stale:true, asOf, staleReason}; otherwise `fresh` as-is.
 */
export function mergeLastGood(fresh, cached, { error = null, nowMs = Date.now() } = {}) {
  if (isUsablePayload(fresh)) return fresh;
  const valid = isValidEntry(cached) && nowMs - Date.parse(cached.asOf) <= LAST_GOOD_MAX_AGE_MS;
  if (!valid) return fresh;
  const freshIsNewerStale = isPlainObject(fresh) && fresh.stale === true && Number.isFinite(Date.parse(fresh.asOf))
    && Date.parse(fresh.asOf) >= Date.parse(cached.asOf);
  if (freshIsNewerStale) return fresh;
  return { ...cached.data, stale: true, asOf: cached.asOf, staleReason: staleReasonFor(fresh, error) };
}

/**
 * Run a fetch thunk under a last-good key. Remembers a usable result; on failure / empty /
 * sw-cache result returns the remembered snapshot flagged stale. With nothing remembered it
 * preserves the thunk's own contract (rethrows the error, passes the empty payload through).
 */
export async function withLastGood(key, run, { store = defaultStore(), nowMs } = {}) {
  let fresh = null, error = null;
  try { fresh = await run(); } catch (e) { error = e; }
  const stamp = nowMs ?? Date.now();   // asOf = when the answer ARRIVED, not when the read began
  if (isUsablePayload(fresh)) { await rememberSnapshot(key, fresh, stamp, store); return fresh; }
  const cached = await recallSnapshot(key, store);
  const merged = mergeLastGood(fresh, cached, { error, nowMs: stamp });
  if (merged == null && error) throw error;
  return merged;
}

// "1:30 PM ET" when the stamp is today in New York, "Sep 28, 2026, 1:30 PM ET" otherwise —
// a days-old snapshot must never read as a time of day (frontend-staleness-honesty rule).
export function asOfLabel(iso, now = new Date()) {
  const d = new Date(iso);
  if (!iso || !Number.isFinite(d.getTime())) return '–';
  try {
    const time = d.toLocaleTimeString('en-US', NY_TIME);
    const day = d.toLocaleDateString('en-US', NY_DAY);
    const sameDay = day === new Date(now).toLocaleDateString('en-US', NY_DAY);
    return sameDay ? `${time} ET` : `${day}, ${time} ET`;
  } catch { return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`; }
}

export function lastGoodStripHTML(payload, { now = new Date(), cls = '' } = {}) {
  if (!isPlainObject(payload) || payload.stale !== true) return '';
  const reason = payload.staleReason ? ` <span class="lg-why">· ${esc(payload.staleReason)}</span>` : '';
  return `<div class="lg-strip${cls ? ` ${cls}` : ''}" role="status">🕰 as of ${esc(asOfLabel(payload.asOf, now))} · showing last good data${reason}</div>`;
}

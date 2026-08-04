'use strict';
// WEB PUSH DELIVERY — feature-flagged, degrade-to-no-op server push for day-trade alerts.
//
// This module is OPTIONAL infrastructure: nothing here may ever throw at load or break a
// caller when the operator hasn't opted in. Three independent preconditions gate real
// delivery, and each degrades honestly:
//   1. VAPID env (VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY; VAPID_SUBJECT optional with a
//      default) — without them isConfigured() is false and sendAlerts() reports
//      'not-configured'.
//   2. The `web-push` npm dependency — require()'d lazily inside try/catch because it may
//      not be installed yet; absence also makes isConfigured() false.
//   3. Blob storage (subscriptions live there) — without it every storage op returns
//      { ok:false, reason:'no-store' } instead of throwing.
//
// PRIVACY: a push endpoint is a CAPABILITY URL — anyone holding it can send that browser
// notifications. So list responses expose only counts and short hashes, never endpoints,
// and payloads are minimized (title/body clipped, no plan levels) because push payloads
// transit third-party push services.

const { readJSON, writeJSON, hasStore } = require('./store');

const SUBS_PATH = 'notify/push-subscriptions.json';
const DEFAULT_SUBJECT = 'mailto:rjs319@gmail.com';

const MAX_SUBSCRIPTIONS = 200;     // cap the doc; oldest evicted (one small JSON blob)
const MAX_SENDS_PER_CALL = 20;     // per-invocation item cap — a burst should not spam
const MAX_CONSECUTIVE_FAILURES = 5; // transient-error tolerance before pruning a sub
const SENT_IDS_CAP = 200;          // rolling cross-invocation dedup window
const PUSH_TTL_SECONDS = 900;      // 15 min — past that an intraday alert is stale noise
const TITLE_MAX = 80;
const BODY_MAX = 160;

// ── Feature flag ─────────────────────────────────────────────────────────────

// Lazy + guarded: the dependency may simply not be installed yet (it is wired by the main
// session). Re-evaluated per call (cheap — require cache) so a deploy that adds the
// package flips the flag without code changes.
function loadWebPush() {
  try { return require('web-push'); } catch { return null; }
}

function vapidEnv() {
  return {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || DEFAULT_SUBJECT,
  };
}

function isConfigured() {
  const { publicKey, privateKey } = vapidEnv();
  return !!(publicKey && privateKey && loadWebPush());
}

// ── Subscription identity ────────────────────────────────────────────────────

// FNV-1a — deterministic short hash (same pattern as lib/intraday-dataset.js, duplicated
// on purpose to keep this optional module dependency-free of the research code).
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
const subIdOf = endpoint => fnv1a(String(endpoint)).toString(36);

// ── Validation (pure) ────────────────────────────────────────────────────────

// Push endpoints are browser-minted https URLs; anything else is malformed or unsafe
// (an http:// endpoint would leak the capability URL in cleartext). Fail fast with a
// machine-readable reason — validation runs BEFORE the store check so bad input is
// rejected identically with or without Blob.
function validateSubscription(sub) {
  if (!sub || typeof sub !== 'object' || typeof sub.endpoint !== 'string') {
    return { ok: false, reason: 'invalid-endpoint' };
  }
  let url;
  try { url = new URL(sub.endpoint); } catch { return { ok: false, reason: 'invalid-endpoint' }; }
  if (url.protocol !== 'https:') return { ok: false, reason: 'insecure-endpoint' };
  const keys = sub.keys;
  const hasKeys = keys && typeof keys.p256dh === 'string' && keys.p256dh.length > 0
    && typeof keys.auth === 'string' && keys.auth.length > 0;
  if (!hasKeys) return { ok: false, reason: 'missing-keys' };
  return { ok: true };
}

// ── Subscription storage (Blob singleton doc) ────────────────────────────────

const emptyDoc = () => ({ subscriptions: [], sentIds: [] });

async function readSubsDoc() {
  const doc = await readJSON(SUBS_PATH, null);
  if (!doc || !Array.isArray(doc.subscriptions)) return emptyDoc();
  return { subscriptions: doc.subscriptions, sentIds: Array.isArray(doc.sentIds) ? doc.sentIds : [] };
}

// cacheMaxAge 0: read-modify-write doc; a stale CDN copy would drop subscriptions.
const writeSubsDoc = doc => writeJSON(SUBS_PATH, doc, 0);

async function addSubscription(sub) {
  const valid = validateSubscription(sub);
  if (!valid.ok) return valid;
  if (!hasStore()) return { ok: false, reason: 'no-store' };
  try {
    const doc = await readSubsDoc();
    const id = subIdOf(sub.endpoint);
    const now = new Date().toISOString();
    const existing = doc.subscriptions.find(s => s.endpoint === sub.endpoint);
    // Re-subscribe refreshes keys and clears the failure streak but keeps identity/createdAt.
    const entry = existing
      ? { ...existing, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, failures: 0 }
      : { id, endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, createdAt: now, lastSuccessAt: null, failures: 0 };
    const others = doc.subscriptions.filter(s => s.endpoint !== sub.endpoint);
    // Append order = age order, so capping from the front evicts the oldest.
    const subscriptions = [...others, entry].slice(-MAX_SUBSCRIPTIONS);
    await writeSubsDoc({ ...doc, subscriptions });
    return { ok: true, id, count: subscriptions.length };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

async function removeSubscription(endpoint) {
  if (!hasStore()) return { ok: false, reason: 'no-store' };
  try {
    const doc = await readSubsDoc();
    const subscriptions = doc.subscriptions.filter(s => s.endpoint !== endpoint);
    const removed = subscriptions.length < doc.subscriptions.length;
    if (removed) await writeSubsDoc({ ...doc, subscriptions });
    return { ok: true, removed, count: subscriptions.length };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

// Count + short ids ONLY — endpoints are capability URLs and must never appear in a
// list/diagnostic response.
async function listSubscriptions() {
  if (!hasStore()) return { ok: false, reason: 'no-store' };
  try {
    const doc = await readSubsDoc();
    return { ok: true, count: doc.subscriptions.length, ids: doc.subscriptions.map(s => s.id) };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

// ── Payload minimization (pure) ──────────────────────────────────────────────

function clip(text, max) {
  const s = String(text || '');
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

// The push payload transits Google/Mozilla/Apple push relays: send ONLY what the lock
// screen needs. No plan levels, no prices beyond what the feed title already carries.
// tag = alert id so the service worker dedups repeat deliveries of the same alert.
function minimizePayload(item) {
  return {
    title: clip(item.title, TITLE_MAX),
    body: clip(item.body, BODY_MAX),
    tag: String(item.id || ''),
    kind: item.kind || null,
    sev: item.sev || null,
  };
}

// ── Delivery ─────────────────────────────────────────────────────────────────

// Send one minimized payload to one subscription. Returns the sub's next state:
//   { entry, dead } — dead=true means prune now (gone endpoint or failure streak).
async function pushToSubscription(webpush, entry, payloads) {
  let failures = entry.failures || 0;
  let lastSuccessAt = entry.lastSuccessAt || null;
  for (const body of payloads) {
    try {
      await webpush.sendNotification(
        { endpoint: entry.endpoint, keys: entry.keys },
        body,
        { TTL: PUSH_TTL_SECONDS },
      );
      failures = 0;
      lastSuccessAt = new Date().toISOString();
    } catch (e) {
      const code = e && e.statusCode;
      // 404/410 = the browser revoked the subscription; it will never work again.
      if (code === 404 || code === 410) return { entry, dead: true, sent: 0, reason: 'gone' };
      failures += 1;
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        return { entry: { ...entry, failures }, dead: true, sent: 0, reason: 'failure-streak' };
      }
      // Transient failure: keep the sub but stop this batch for it (likely all fail).
      return { entry: { ...entry, failures }, dead: false, sent: 0, reason: 'error' };
    }
  }
  return { entry: { ...entry, failures, lastSuccessAt }, dead: false, sent: payloads.length, reason: null };
}

// items: [{ id, kind, sev, title, body }]. Fans each fresh item out to every stored
// subscription; persists the updated subscription doc ONCE at the end (send results +
// rolling sentIds dedup window).
async function sendAlerts(items) {
  if (!isConfigured()) return { sent: 0, reason: 'not-configured' };
  if (!hasStore()) return { sent: 0, reason: 'no-store' };
  const list = (Array.isArray(items) ? items : []).filter(it => it && typeof it.id === 'string' && it.id);
  if (!list.length) return { sent: 0, reason: 'no-items' };
  try {
    const doc = await readSubsDoc();
    if (!doc.subscriptions.length) return { sent: 0, reason: 'no-subscriptions' };

    // Cross-invocation dedup: an alert id already pushed (any prior call) never re-pushes.
    const already = new Set(doc.sentIds);
    const fresh = list.filter(it => !already.has(it.id)).slice(0, MAX_SENDS_PER_CALL);
    if (!fresh.length) return { sent: 0, reason: 'all-duplicates' };

    const webpush = loadWebPush();
    const { publicKey, privateKey, subject } = vapidEnv();
    webpush.setVapidDetails(subject, publicKey, privateKey);

    const payloads = fresh.map(it => JSON.stringify(minimizePayload(it)));
    const results = await Promise.all(doc.subscriptions.map(s => pushToSubscription(webpush, s, payloads)));

    const subscriptions = results.filter(r => !r.dead).map(r => r.entry);
    const removed = results.length - subscriptions.length;
    const sent = results.reduce((n, r) => n + r.sent, 0);
    const sentIds = [...doc.sentIds, ...fresh.map(it => it.id)].slice(-SENT_IDS_CAP);

    let persisted = true;
    try { await writeSubsDoc({ subscriptions, sentIds }); } catch { persisted = false; }
    return { sent, delivered: fresh.length, removed, subscriptions: subscriptions.length, persisted };
  } catch (e) {
    return { sent: 0, reason: String((e && e.message) || e) };
  }
}

// ── Diagnostics ──────────────────────────────────────────────────────────────

function missingEnvNames() {
  const names = [];
  if (!process.env.VAPID_PUBLIC_KEY) names.push('VAPID_PUBLIC_KEY');
  if (!process.env.VAPID_PRIVATE_KEY) names.push('VAPID_PRIVATE_KEY');
  return names;
}

// Honest operator-facing status: names exactly what is missing, never echoes values.
async function status() {
  const dependencyInstalled = !!loadWebPush();
  const missing = missingEnvNames();
  const vapidPresent = missing.length === 0;
  const configured = vapidPresent && dependencyInstalled;

  let subscriptions = null;
  if (hasStore()) {
    const listed = await listSubscriptions();
    subscriptions = listed.ok ? listed.count : null;
  }

  let note;
  if (configured) {
    note = 'Web Push configured.' + (subscriptions === null ? ' Subscription count unavailable (Blob store not configured).' : '');
  } else {
    const problems = [];
    if (missing.length) problems.push(`missing env ${missing.join(', ')}`);
    if (!dependencyInstalled) problems.push('web-push dependency not installed (npm i web-push)');
    note = `Not configured: ${problems.join('; ')}. Push is a silent no-op until fixed; the in-app feed still delivers alerts.`;
  }
  return { configured, dependencyInstalled, vapidPresent, subscriptions, note };
}

module.exports = {
  isConfigured, status,
  addSubscription, removeSubscription, listSubscriptions,
  sendAlerts, minimizePayload, validateSubscription,
  SUBS_PATH, MAX_SUBSCRIPTIONS, MAX_SENDS_PER_CALL, PUSH_TTL_SECONDS, TITLE_MAX, BODY_MAX,
};

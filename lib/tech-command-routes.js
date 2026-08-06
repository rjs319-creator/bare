'use strict';
// TECH COMMAND CENTER — HTTP SURFACE (tech-command-routes-v1).
//
//   PUBLIC, READ-ONLY (never mutate, never fan out over the universe)
//     op=techcommand              versioned snapshot for the page
//     op=techcommandticker&ticker= one name's dossier
//     op=techcommandhealth        data health + freshness + evidence disclosures
//
//   PRIVILEGED (bearer CRON_SECRET via api/tracker PRIVILEGED_OPS)
//     op=techcommandtick          build → advance lifecycle → emit alerts →
//                                 persist snapshot + immutable evaluation records
//     op=techcommandresolve       resolve matured swing / long-term outcomes
//
// The public reads serve the persisted snapshot. When none is fresh they fall back
// to a BOUNDED live build (mode 'lite': already-cached public ops + benchmark
// candles only) that is explicitly labeled and is never written back. A public GET
// therefore cannot append an episode, change a lifecycle state, or send an alert.

const { readJSON, writeJSON, hasStore } = require('./store');
const { sessionInfoAt } = require('./market-session');
const { redactSecrets } = require('./redact');
const BUILD = require('./tech-command-build');
const LIFE = require('./tech-command-lifecycle');
const DOS = require('./tech-command-dossier');
const EVAL = require('./tech-command-evaluation');

const ROUTES_VERSION = 'tech-command-routes-v1';

const KEYS = Object.freeze({
  latest: 'techcommand/latest.json',
  lifecycle: h => `techcommand/lifecycle-${h}.json`,
  tickHealth: 'techcommand/tick-health.json',
  lease: 'techcommand/tick-lease.json',
});

const SNAPSHOT_FRESH_MS = 20 * 60 * 1000;      // during a session
const SNAPSHOT_FRESH_CLOSED_MS = 20 * 60 * 60 * 1000;   // outside one, a post-close build stays valid
const LEASE_MS = 55 * 1000;

const err = e => redactSecrets(String((e && e.message) || e));

// ── Public: the board ───────────────────────────────────────────────────────
async function runTechCommand(req, res) {
  const now = new Date();
  const t0 = Date.now();
  try {
    const stored = await readSnapshot();
    const fresh = isFresh(stored, now);
    let payload;
    if (fresh) {
      payload = { ...stored, servedFrom: 'persisted-snapshot', stale: false };
    } else {
      const built = await BUILD.buildSnapshot({ mode: 'lite', now, t0 });
      payload = {
        ...BUILD.toPublicPayload(built),
        servedFrom: 'bounded-live-build',
        stale: false,
        liteMode: true,
        liteNote: 'No fresh persisted snapshot was available, so this was rebuilt live within a bounded budget: already-cached public boards plus benchmark candles only. Breadth, fundamentals, the long-term board and news are NOT computed in this mode and are listed under dataHealth.unavailable. Nothing was written.',
        previousSnapshotAt: stored ? stored.generatedAt : null,
      };
    }
    payload.readOnly = true;
    payload.authority = 'read-only-projection';
    payload.elapsedMs = Date.now() - t0;
    // Actionable content is time-sensitive: keep the CDN window short and never
    // serve a long stale-while-revalidate copy of a "trigger confirmed".
    res.setHeader('Cache-Control', 's-maxage=45, stale-while-revalidate=45');
    return res.json(payload);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      schema: BUILD.SNAPSHOT_VERSION, ok: false, readOnly: true, degraded: true,
      error: err(e),
      note: 'The Technology Command Center could not be assembled. Every board is empty because of this failure, not because nothing qualified.',
      generatedAt: now.toISOString(),
    });
  }
}

// ── Public: one name's dossier ──────────────────────────────────────────────
async function runTechCommandTicker(req, res) {
  const now = new Date();
  const raw = String(req.query.ticker || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z.-]{0,6}$/.test(raw)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({ ok: false, error: 'A valid ticker is required.' });
  }
  try {
    const stored = await readSnapshot();
    const snapshot = isFresh(stored, now)
      ? stored
      : BUILD.toPublicPayload(await BUILD.buildSnapshot({ mode: 'lite', now, t0: Date.now() }));
    const lifecycle = await readAllLifecycle();
    const dossier = DOS.buildDossier({ ticker: raw, snapshot: { ...snapshot, lifecycle } });
    res.setHeader('Cache-Control', 's-maxage=45, stale-while-revalidate=45');
    return res.json({
      ok: true, readOnly: true, schema: ROUTES_VERSION,
      generatedAt: new Date().toISOString(),
      snapshotAt: snapshot ? snapshot.generatedAt : null,
      servedFrom: isFresh(stored, now) ? 'persisted-snapshot' : 'bounded-live-build',
      dossier,
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: false, readOnly: true, error: err(e), ticker: raw });
  }
}

// ── Public: health ──────────────────────────────────────────────────────────
async function runTechCommandHealth(req, res) {
  const now = new Date();
  try {
    const [stored, tick] = await Promise.all([readSnapshot(), readJSON(KEYS.tickHealth, null).catch(() => null)]);
    const session = sessionInfoAt(now);
    const fresh = isFresh(stored, now);
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.json({
      ok: true, schema: ROUTES_VERSION, readOnly: true,
      generatedAt: now.toISOString(),
      marketSession: session.marketSession, sessionDate: session.etDate,
      storeConfigured: hasStore(),
      snapshot: stored ? {
        present: true, generatedAt: stored.generatedAt, mode: stored.mode,
        ageMinutes: Math.round((now.getTime() - Date.parse(stored.generatedAt)) / 60000),
        fresh, sessionDate: stored.sessionDate,
        counts: {
          universe: stored.universe ? stored.universe.count : null,
          daytrade: stored.daytrade ? stored.daytrade.counts.total : null,
          swing: stored.swing ? stored.swing.counts.total : null,
          longterm: stored.longterm ? stored.longterm.counts.total : null,
        },
      } : { present: false, note: 'No snapshot has been persisted yet — public reads are serving a bounded live build.' },
      dataHealth: stored ? stored.dataHealth : null,
      disclosures: BUILD.DISCLOSURES,
      tick: tick || { note: 'The privileged tick has not run yet.' },
      evaluation: await EVAL.status().catch(e => ({ error: err(e) })),
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: false, error: err(e) });
  }
}

// ── Privileged: the ONE writer ──────────────────────────────────────────────
async function runTechCommandTick(req, res) {
  const t0 = Date.now();
  const now = new Date();
  const nowIso = now.toISOString();
  res.setHeader('Cache-Control', 'no-store');

  if (!hasStore()) {
    return res.status(200).json({ ok: false, skipped: 'no-store', note: 'Blob storage is not configured — nothing can be persisted.' });
  }
  // Lease: overlapping schedulers must not double-write or double-alert.
  try {
    const lease = await readJSON(KEYS.lease, null);
    if (lease && lease.at && Date.now() - Date.parse(lease.at) < LEASE_MS) {
      return res.status(200).json({ ok: true, skipped: 'lease-held', leaseAt: lease.at });
    }
    await writeJSON(KEYS.lease, { at: nowIso }, 0);
  } catch { /* best-effort; alert-id dedup bounds double emission */ }

  let snapshot = null, failure = null;
  try {
    snapshot = await BUILD.buildSnapshot({ mode: 'full', now, t0 });
  } catch (e) {
    failure = err(e);
  }

  const result = { transitions: 0, alerts: 0, departed: 0, evaluationsWritten: 0 };
  const lifecycleOut = {};
  if (snapshot && !snapshot.degraded) {
    // Advance the persistent lifecycle for each horizon, independently.
    for (const [horizon, rows] of Object.entries(lifecycleRowsOf(snapshot))) {
      try {
        const prior = await readJSON(KEYS.lifecycle(horizon), null).catch(() => null);
        const adv = LIFE.advance({ prior, horizon, rows, now, sessionDay: snapshot.sessionDate });
        await writeJSON(KEYS.lifecycle(horizon), {
          schema: adv.schema, horizon, updatedAt: nowIso,
          records: adv.records, alertIndex: adv.alertIndex,
          lastTransitions: adv.transitions.slice(0, 60), lastAlerts: adv.alerts,
        }, 0);
        lifecycleOut[horizon] = { transitions: adv.transitions, alerts: adv.alerts, departed: adv.departed, counts: adv.counts, records: adv.records };
        result.transitions += adv.counts.transitions;
        result.alerts += adv.counts.alerts;
        result.departed += adv.counts.departed;
      } catch (e) {
        failure = failure || `lifecycle(${horizon}): ${err(e)}`;
      }
    }
    // Immutable prospective evaluation records (write-once per session day).
    try {
      const written = await EVAL.record({ snapshot, now });
      result.evaluationsWritten = written.written;
      result.evaluationNote = written.note;
    } catch (e) {
      failure = failure || `evaluation: ${err(e)}`;
    }
    // Persist the snapshot LAST so a partially-advanced lifecycle can never be
    // presented as the board the alerts were computed from.
    try {
      const payload = BUILD.toPublicPayload(snapshot);
      await writeJSON(KEYS.latest, {
        ...payload,
        lifecycleSummary: Object.fromEntries(Object.entries(lifecycleOut).map(([h, v]) => [h, v.counts])),
        persistedLifecycleChanges: Object.fromEntries(Object.entries(lifecycleOut).map(([h, v]) => [h, {
          transitions: v.transitions.slice(0, 30), departed: v.departed.slice(0, 30), alerts: v.alerts.slice(0, 20),
        }])),
      }, 0);
    } catch (e) {
      failure = failure || `snapshot persist: ${err(e)}`;
    }
  }

  const health = {
    lastAttemptAt: nowIso,
    lastSuccessAt: failure ? undefined : nowIso,
    lastError: failure || null,
    lastDurationMs: Date.now() - t0,
    mode: 'full',
    session: snapshot ? snapshot.marketSession : null,
    universeCount: snapshot && snapshot.universe ? snapshot.universe.count : null,
    ...result,
    expectedNextAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };
  try {
    const prior = await readJSON(KEYS.tickHealth, {});
    await writeJSON(KEYS.tickHealth, {
      ...prior, ...health,
      lastSuccessAt: health.lastSuccessAt || prior.lastSuccessAt || null,
      consecutiveErrors: failure ? ((prior.consecutiveErrors || 0) + 1) : 0,
    }, 0);
  } catch { /* health writing is best-effort */ }

  return res.status(failure ? 500 : 200).json({ ok: !failure, tick: health, error: failure || undefined });
}

// ── Privileged: resolve matured outcomes ────────────────────────────────────
async function runTechCommandResolve(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!hasStore()) return res.status(200).json({ ok: false, skipped: 'no-store' });
  try {
    const out = await EVAL.resolve({ now: new Date(), limitDays: parseInt(req.query.limit || '10', 10) || 10 });
    return res.json({ ok: true, ...out });
  } catch (e) {
    return res.status(500).json({ ok: false, error: err(e) });
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
async function readSnapshot() {
  if (!hasStore()) return null;
  try { return await readJSON(KEYS.latest, null); } catch { return null; }
}

function isFresh(snapshot, now) {
  if (!snapshot || !snapshot.generatedAt) return false;
  const age = new Date(now).getTime() - Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(age) || age < 0) return false;
  const session = sessionInfoAt(now);
  const budget = session.marketSession === 'closed' ? SNAPSHOT_FRESH_CLOSED_MS : SNAPSHOT_FRESH_MS;
  return age <= budget;
}

async function readAllLifecycle() {
  if (!hasStore()) return {};
  const out = {};
  await Promise.all(LIFE.HORIZONS.map(async (h) => {
    try {
      const doc = await readJSON(KEYS.lifecycle(h), null);
      if (doc) out[h] = { records: doc.records || {}, transitions: doc.lastTransitions || [] };
    } catch { /* a missing horizon ledger is reported by absence */ }
  }));
  return out;
}

/** Snapshot boards → the row shape the lifecycle state machine consumes. */
function lifecycleRowsOf(snapshot) {
  const dt = ((snapshot.daytrade && snapshot.daytrade.rows) || []).map(r => ({
    ticker: r.ticker, action: r.action, subsector: r.subsector,
    rationale: r.transitionReason || r.catalyst || `Day Trade lifecycle ${r.lifecycleState}`,
    trigger: r.trigger, invalidation: r.invalidation, target: r.target,
    catalyst: r.catalyst, contradicting: [],
    stale: r.currentSessionFresh === false,
  }));
  const sw = ((snapshot.swing && snapshot.swing.rows) || []).filter(r => !r.persisted).map(r => ({
    ticker: r.ticker, action: r.action, subsector: r.subsector,
    rationale: r.whyNow, trigger: r.trigger, invalidation: r.invalidation, target: r.target,
    catalyst: r.catalyst, contradicting: (r.contradicting || []).map(c => c.label),
    stale: r.removalReason === 'inputs went stale — cannot be presented as a live decision',
  }));
  const lt = ((snapshot.longterm && snapshot.longterm.rows) || []).map(r => ({
    ticker: r.ticker, action: r.action, subsector: r.subsector,
    rationale: r.coreThesis, trigger: null, invalidation: null, target: null,
    catalyst: (r.nextProofPoints && r.nextProofPoints[0] && r.nextProofPoints[0].what) || null,
    contradicting: (r.contradicting || []).map(c => c.label),
    stale: r.action === 'INSUFFICIENT_DATA',
  }));
  // Options / attention state joined on so the alert rules can see them change.
  const optBy = Object.fromEntries(((snapshot.options && snapshot.options.rows) || []).map(r => [r.ticker, r.state]));
  const socBy = Object.fromEntries(((snapshot.sentiment && snapshot.sentiment.rows) || []).map(r => [r.ticker, r.state]));
  const decorate = rows => rows.map(r => ({ ...r, optionsState: optBy[r.ticker] || null, attentionState: socBy[r.ticker] || null }));
  return { daytrade: decorate(dt), swing: decorate(sw), longterm: decorate(lt) };
}

module.exports = {
  ROUTES_VERSION, KEYS, SNAPSHOT_FRESH_MS, LEASE_MS,
  runTechCommand, runTechCommandTicker, runTechCommandHealth,
  runTechCommandTick, runTechCommandResolve,
  isFresh, lifecycleRowsOf, readAllLifecycle,
};

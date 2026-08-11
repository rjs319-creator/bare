'use strict';
// IGNITION LIVE — HTTP surface + the tick-side processor.
//
// AUTHORITY MODEL (mirrors lib/lowfloat-routes.js exactly):
//   op=ignitionlive / op=ignitionreplay / op=ignitionleadtime → PUBLIC, READ-ONLY. They only
//     read persisted snapshots; they never run the pipeline and never write.
//   processIgnitionTick(...) → called ONLY from the privileged op=lowfloattick writer, inside
//     its lease. There is no separate ignition writer op: one pipeline compute per tick
//     serves both boards (the spec's efficiency rule — never recompute what a sibling
//     already computed).
//
// The public read serves the LAST PERSISTED tick (≤ ~10 minutes old in-session) and states
// its freshness. That is an honest trade: a live recompute would double the provider spend
// for a board whose data resolution is 5 minutes anyway.

const CFG = require('./ignition-live-config');
const LFCFG = require('./lowfloat-config');
const store = require('./lowfloat-store');
const live = require('./ignition-live');
const attn = require('./attention-rank');
const dilution = require('./dilution-filings');
const { readNotifyFeed, writeNotifyFeed } = require('./store');

const LIMITATIONS = Object.freeze([
  'IGNITION is a synthesis over 5-MINUTE completed bars refreshed on a ~10-minute scheduled tick. Sub-5-minute returns, real-time streaming and premarket bars do not exist on this stack.',
  'There is no halt/LULD feed — halt fields are UNKNOWN, never modeled. There is no NBBO — spread must be checked manually on thin names.',
  'Attention rank compares this scan against PRIOR scans of the same session; "5 minutes ago" is the nearest earlier scan stamp, and the first scans of a session have no history.',
  'IGNITION_SCORE and OPPORTUNITY_SCORE are pre-registered interpretable rankings labeled RULE_BASED_ESTIMATE. Neither is a probability; no ML model exists; no edge is claimed.',
  'Dilution risk combines news headlines with EDGAR filing DATES (form types only, no document parsing). UNKNOWN means unknown — it is never treated as safe.',
  'Historical replay covers only dates where this system persisted its own snapshots — the free bar feed serves ~5 trailing days, so there is no way to reconstruct earlier sessions.',
]);

function envelope(extra = {}) {
  return {
    schemaVersion: LFCFG.SCHEMA_VERSION,
    ignitionLiveVersion: CFG.IGNITION_LIVE_VERSION,
    attentionRankVersion: CFG.ATTENTION_RANK_VERSION,
    dilutionFilingsVersion: CFG.DILUTION_FILINGS_VERSION,
    pipelineConfigurationVersion: LFCFG.CONFIG_VERSION,
    limitations: LIMITATIONS,
    generatedAt: new Date().toISOString(),
    ...extra,
  };
}
function noStore(res) { res.setHeader('Cache-Control', 'no-store'); }
function shortCache(res, seconds = 45) { res.setHeader('Cache-Control', `s-maxage=${seconds}, stale-while-revalidate=15`); }
function etDate(now = new Date()) {
  return new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ── TICK PROCESSOR (privileged path only) ────────────────────────────────────
// Never throws: the low-float tick's own persistence must not fail because the synthesis
// layer had a bad day. Every partial failure is reported in the returned summary.
async function processIgnitionTick({ records = [], allDiscovered = [], sessionDate, now = new Date(), regime = 'neutral' } = {}) {
  const summary = { views: 0, attention: null, dilution: null, alerts: null, snapshot: null };
  try {
    // 1) Market-wide attention ranking over EVERYTHING discovery saw this scan (not just the
    //    enriched top — rank change through the whole pool is the point).
    const pool = (allDiscovered && allDiscovered.length ? allDiscovered : records);
    const ranks = attn.rankCandidates(pool);
    let historyDoc = null;
    try {
      const prior = store.hasStore() ? await store.readAttentionDay(sessionDate).catch(() => null) : null;
      historyDoc = attn.updateHistory(prior, ranks, now, sessionDate);
      if (store.hasStore()) await store.writeAttentionDay(sessionDate, historyDoc);
      summary.attention = { ranked: ranks.universeRanked, stamps: historyDoc.stamps.length, saved: store.hasStore() };
    } catch (e) {
      historyDoc = attn.updateHistory(null, ranks, now, sessionDate);
      summary.attention = { ranked: ranks.universeRanked, saved: false, error: String((e && e.message) || e) };
    }

    // 2) EDGAR filing enrichment for the top of the board (cached 24h, hard per-tick cap).
    let filingsByTicker = {};
    try {
      const targets = records
        .filter(r => (r.explosionPotentialScore ?? 0) >= 45)
        .map(r => r.ticker);
      const fr = await dilution.enrichFilings(targets, { now, t0: Date.now(), deadlineMs: 12000 });
      filingsByTicker = fr.byTicker;
      summary.dilution = fr.coverage;
    } catch (e) { summary.dilution = { error: String((e && e.message) || e) }; }

    // 3) Short interest — one cached FINRA doc for the candidate set; degrades to unknown.
    let siByTicker = {};
    try {
      const si = require('./shortinterest');
      const doc = await si.fetchShortInterest(new Set(records.map(r => r.ticker)));
      for (const r of records) {
        const rec = doc && doc.bySymbol ? doc.bySymbol[r.ticker] : null;
        if (rec) {
          const flag = si.siFlag(rec, r.sharesOutstanding);
          siByTicker[r.ticker] = { known: true, level: flag ? flag.level : null, pct: flag ? flag.pct : null, dtc: flag ? flag.dtc : null };
        }
      }
    } catch { siByTicker = {}; }

    // 4) Synthesize the IGNITION view per record.
    const views = records.map(r => {
      const attention = attn.attentionMetrics(historyDoc, r.ticker, now);
      const dil = dilution.assessDilution(r.ticker, r.supplyRiskDetail, filingsByTicker, now);
      return live.synthesizeIgnitionView(r, {
        attention,
        dilution: dil,
        shortPressure: siByTicker[r.ticker] || null,
        regime,
        turnoverVelocityPerMin: attention.turnoverVelocityPerMin,
      });
    }).sort((a, b) => (b.opportunityScore - a.opportunityScore) || (b.ignitionScore - a.ignitionScore));
    summary.views = views.length;

    // 5) Alerts — state transitions only, deduped per (ticker|state|session), budgeted.
    let alertOut = { alerts: [], suppressed: 0 };
    try {
      const priorState = store.hasStore() ? await store.readIgnitionAlertState().catch(() => null) : null;
      alertOut = buildIgnitionAlerts(views, priorState, { now, sessionDate });
      if (store.hasStore()) await store.writeIgnitionAlertState(alertOut.nextState);
      summary.alerts = { emitted: alertOut.alerts.length, suppressed: alertOut.suppressed };
      if (alertOut.alerts.length && store.hasStore()) {
        try {
          const feed = await readNotifyFeed().catch(() => ({ items: [] }));
          const items = [...alertOut.alerts.map(a => ({
            ts: a.at, id: a.id, type: 'ignition', kind: a.state,
            sev: ['CONFIRMED', 'BREAKOUT', 'FAILED', 'PARABOLIC_WARNING'].includes(a.state) ? 'high' : 'low',
            go: 'ignitionlive', title: a.title, detail: a.message,
          })), ...(feed.items || [])];
          await writeNotifyFeed({ ...feed, items: items.slice(0, 80) });
        } catch { /* feed is best-effort; the durable state already saved */ }
      }
    } catch (e) { summary.alerts = { error: String((e && e.message) || e) }; }

    // 6) Persist the snapshot — the document the public reads and the replay serves.
    const snapshot = {
      schemaVersion: LFCFG.SCHEMA_VERSION,
      ignitionLiveVersion: CFG.IGNITION_LIVE_VERSION,
      sessionDate,
      generatedAt: new Date(now).toISOString(),
      regime,
      universeRanked: ranks.universeRanked,
      alerts: alertOut.alerts,
      views,
    };
    try {
      if (store.hasStore()) { await store.writeIgnitionLiveSnapshot(sessionDate, snapshot, now); summary.snapshot = 'written'; }
      else summary.snapshot = 'no-store';
    } catch (e) { summary.snapshot = `failed: ${(e && e.message) || e}`; }

    return { ok: true, ...summary };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), ...summary };
  }
}

// ── ALERTS ───────────────────────────────────────────────────────────────────
// One alert per (ticker, state) per session. Higher-value states first under the cycle
// budget. FAILED only fires for names that were previously alerted constructively — nobody
// needs a failure notice for a name they were never told about.
const STATE_PRIORITY = ['CONFIRMED', 'BREAKOUT', 'IGNITION', 'PARABOLIC_WARNING', 'FAILED', 'ATTENTION_SURGE', 'WATCH'];
function buildIgnitionAlerts(views, priorState, { now = new Date(), sessionDate } = {}) {
  const prior = priorState && priorState.sessionDate === sessionDate
    ? priorState : { sessionDate, emitted: {}, dayCounts: {} };
  const emitted = { ...prior.emitted };
  const dayCounts = { ...prior.dayCounts };
  const alerts = [];
  let suppressed = 0;

  const candidates = [];
  for (const v of views) {
    for (const state of v.alertStates || []) {
      const id = `ignition|${v.ticker}|${state}`;
      if (emitted[id]) { suppressed++; continue; }
      if (state === 'FAILED') {
        const wasAlerted = STATE_PRIORITY.slice(0, 3).some(s => emitted[`ignition|${v.ticker}|${s}`]);
        if (!wasAlerted) { suppressed++; continue; }
      }
      candidates.push({ v, state, id });
    }
  }
  candidates.sort((a, b) => STATE_PRIORITY.indexOf(a.state) - STATE_PRIORITY.indexOf(b.state));

  for (const c of candidates) {
    if (alerts.length >= CFG.ALERTS.MAX_PER_CYCLE) { suppressed++; continue; }
    if ((dayCounts[c.v.ticker] || 0) >= CFG.ALERTS.MAX_PER_TICKER_PER_DAY) { suppressed++; continue; }
    emitted[c.id] = new Date(now).toISOString();
    dayCounts[c.v.ticker] = (dayCounts[c.v.ticker] || 0) + 1;
    alerts.push(formatAlert(c.v, c.state, now));
  }
  return { alerts, suppressed, nextState: { sessionDate, emitted, dayCounts, updatedAt: new Date(now).toISOString() } };
}

const money = v => (Number.isFinite(v) ? `$${v.toFixed(2)}` : 'n/a');
function formatAlert(v, state, now) {
  const attentionLine = v.attention && Number.isFinite(v.attention.rank20mAgo) && Number.isFinite(v.attention.rankNow)
    ? ` Attention #${v.attention.rank20mAgo} → #${v.attention.rankNow}.` : '';
  const core = `Ignition ${v.ignitionScore}/100, Opportunity ${v.opportunityScore}/100, stage ${v.stage}, extension ${v.extensionRisk ?? '?'}/100.`;
  const plan = v.trigger != null
    ? ` Trigger ${money(v.trigger)}, invalidation ${money(v.invalidation)}, do not chase above ${money(v.doNotChasePrice)}.` : '';
  const msg = {
    WATCH: `${v.ticker}: early ignition forming. ${core}${attentionLine} Watch only.`,
    IGNITION: `${v.ticker}: ignition underway. ${core}${attentionLine}${plan}`,
    CONFIRMED: `${v.ticker}: IGNITION CONFIRMED. ${core}${attentionLine}${plan} Setup: ${v.setup || 'n/a'}. Risk: extreme volatility.`,
    BREAKOUT: `${v.ticker}: breakout stage. ${core}${plan}`,
    ATTENTION_SURGE: `${v.ticker}: attention surging.${attentionLine} ${core}`,
    PARABOLIC_WARNING: `${v.ticker}: PARABOLIC — do not chase, exit bias. ${core}`,
    FAILED: `${v.ticker}: momentum failed (${v.structureState || 'structure lost'}). No new entries.`,
  }[state] || `${v.ticker}: ${state}`;
  return {
    id: `ignition|${v.ticker}|${state}`,
    ticker: v.ticker, state, at: new Date(now).toISOString(),
    title: `IGNITION ${state} — ${v.ticker}`,
    message: msg,
    ignitionScore: v.ignitionScore, opportunityScore: v.opportunityScore,
    stage: v.stage, extensionRisk: v.extensionRisk,
    referencePrice: v.price, trigger: v.trigger, invalidation: v.invalidation,
    doNotChasePrice: v.doNotChasePrice, setup: v.setup,
    catalystGrade: v.catalystGrade,
    attentionRankNow: v.attention ? v.attention.rankNow : null,
  };
}

// ── PUBLIC READS ─────────────────────────────────────────────────────────────
async function latestSnapshot(date) {
  const docs = await store.readSnapshotsForDay(store.IGNITION_LIVE_PREFIX, date, { limit: 200 });
  return docs.length ? docs[docs.length - 1] : null;
}

async function runIgnitionLive(req, res) {
  const t0 = Date.now();
  try {
    const date = (req.query && req.query.date) || etDate();
    const snap = await latestSnapshot(date);
    if (!snap) {
      noStore(res);
      return res.json(envelope({
        ok: true, sessionDate: date, views: [], alerts: [],
        emptyMessage: 'No IGNITION snapshot has been persisted for this session yet — the privileged tick writes one every ~10 minutes during regular hours.',
        durableStore: store.hasStore(),
        elapsedMs: Date.now() - t0,
      }));
    }
    const ageMin = Math.round((Date.now() - Date.parse(snap.generatedAt)) / 60000);
    shortCache(res);
    return res.json(envelope({
      ok: true,
      readOnly: true,
      authority: 'read-only-projection of the last privileged tick',
      sessionDate: snap.sessionDate,
      snapshotGeneratedAt: snap.generatedAt,
      snapshotAgeMinutes: ageMin,
      snapshotStale: ageMin > 20,
      regime: snap.regime,
      universeRanked: snap.universeRanked,
      defaultSort: 'opportunityScore desc — deliberately NOT percent change',
      alerts: snap.alerts || [],
      views: snap.views || [],
      elapsedMs: Date.now() - t0,
    }));
  } catch (e) {
    noStore(res);
    return res.status(200).json(envelope({ ok: false, error: String((e && e.message) || e), elapsedMs: Date.now() - t0 }));
  }
}

// Replay: step through the persisted snapshots of one session. Point-in-time by
// construction — each snapshot only ever contained what was known at its stamp.
async function runIgnitionReplay(req, res) {
  const t0 = Date.now();
  try {
    const date = req.query && req.query.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      noStore(res);
      return res.status(200).json(envelope({ ok: false, error: 'pass date=YYYY-MM-DD (a session this system persisted snapshots for)' }));
    }
    const ticker = req.query.ticker ? String(req.query.ticker).toUpperCase() : null;
    const docs = await store.readSnapshotsForDay(store.IGNITION_LIVE_PREFIX, date, { limit: 200 });
    if (!docs.length) {
      const dates = await store.listSnapshotDates(store.IGNITION_LIVE_PREFIX, { limit: 60 });
      noStore(res);
      return res.json(envelope({
        ok: true, sessionDate: date, frames: [],
        emptyMessage: 'No snapshots were persisted for this date. Replay only covers sessions this system recorded — earlier history cannot be reconstructed from the free 5-day bar feed.',
        availableDates: dates,
        elapsedMs: Date.now() - t0,
      }));
    }
    const compact = v => ({
      ticker: v.ticker, price: v.price, dayChangePct: v.dayChangePct,
      ignitionScore: v.ignitionScore, opportunityScore: v.opportunityScore,
      stage: v.stage, extensionRisk: v.extensionRisk, extensionLabel: v.extensionLabel,
      catalystGrade: v.catalystGrade, supplyPressureScore: v.supplyPressureScore,
      relativeVolume: v.relativeVolume, fiveMinVolumeAcceleration: v.fiveMinVolumeAcceleration,
      dollarVolumeAcceleration: v.dollarVolumeAcceleration,
      floatTurnover: v.floatTurnover,
      attentionRankNow: v.attention ? v.attention.rankNow : null,
      attentionVelocity: v.attention ? v.attention.velocity : null,
      setup: v.setup, doNotChasePrice: v.doNotChasePrice, trigger: v.trigger,
      alertStates: v.alertStates,
    });
    const frames = docs.map(d => ({
      at: d.generatedAt,
      alerts: (d.alerts || []).filter(a => !ticker || a.ticker === ticker),
      views: (d.views || []).filter(v => !ticker || v.ticker === ticker).slice(0, ticker ? 1 : 15).map(compact),
    }));
    shortCache(res, 300);
    return res.json(envelope({
      ok: true, sessionDate: date, ticker, frameCount: frames.length, frames,
      note: 'Each frame is the snapshot exactly as persisted at that stamp — future information was not available to it and is not shown.',
      elapsedMs: Date.now() - t0,
    }));
  } catch (e) {
    noStore(res);
    return res.status(200).json(envelope({ ok: false, error: String((e && e.message) || e), elapsedMs: Date.now() - t0 }));
  }
}

// Lead time: join the day's large-mover audit (which already measures how early discovery
// saw each big mover) with the day's IGNITION alert stamps, per alert state.
async function runIgnitionLeadtime(req, res) {
  const t0 = Date.now();
  try {
    const date = (req.query && req.query.date) || etDate();
    const [auditDoc, snaps] = await Promise.all([
      store.readAuditDay(date).catch(() => null),
      store.readSnapshotsForDay(store.IGNITION_LIVE_PREFIX, date, { limit: 200 }),
    ]);
    if (!auditDoc || !snaps.length) {
      noStore(res);
      return res.json(envelope({
        ok: true, sessionDate: date, joined: [],
        emptyMessage: !auditDoc
          ? 'No large-mover audit exists for this date (it runs post-close).'
          : 'No IGNITION snapshots exist for this date.',
        elapsedMs: Date.now() - t0,
      }));
    }
    // First alert stamp per ticker per state across the day's snapshots.
    const firstAlert = {};
    for (const s of snaps) {
      for (const a of s.alerts || []) {
        const key = `${a.ticker}|${a.state}`;
        if (!firstAlert[key]) firstAlert[key] = { at: a.at, referencePrice: a.referencePrice, ignitionScore: a.ignitionScore };
      }
    }
    const movers = (auditDoc.records || auditDoc.movers || []);
    const joined = movers.map(m => {
      const states = {};
      for (const st of ['WATCH', 'IGNITION', 'CONFIRMED', 'BREAKOUT']) {
        const hit = firstAlert[`${m.ticker}|${st}`];
        if (hit) states[st] = hit;
      }
      return {
        ticker: m.ticker,
        eventualGainPct: m.dayChangePct ?? m.openToHighPct ?? null,
        gainAtFirstDiscovery: m.gainAtFirstDiscovery ?? null,
        discoveredBefore10Pct: m.discoveredBefore10Pct ?? null,
        discoveredBefore20Pct: m.discoveredBefore20Pct ?? null,
        discoveredBefore50PctOfFinalMove: m.discoveredBefore50PctOfFinalMove ?? null,
        firstAlerts: states,
        alerted: Object.keys(states).length > 0,
      };
    });
    const alertedShare = joined.length ? +(joined.filter(j => j.alerted).length / joined.length).toFixed(2) : null;
    shortCache(res, 300);
    return res.json(envelope({
      ok: true, sessionDate: date,
      moverCount: joined.length, alertedShare, joined,
      note: 'Earliness fields come from the existing large-mover audit; firstAlerts are the IGNITION alert stamps. A mover with no alerts is a recall miss for this layer.',
      elapsedMs: Date.now() - t0,
    }));
  } catch (e) {
    noStore(res);
    return res.status(200).json(envelope({ ok: false, error: String((e && e.message) || e), elapsedMs: Date.now() - t0 }));
  }
}

module.exports = {
  LIMITATIONS, envelope, processIgnitionTick, buildIgnitionAlerts, formatAlert,
  runIgnitionLive, runIgnitionReplay, runIgnitionLeadtime, latestSnapshot,
};

// FORWARD LEDGER for the independent swing read — makes it FALSIFIABLE.
//
// Two pure functions (snapshot + grade) plus thin shadow routes. Design honours
// the app's constraints:
//   • The ordinary /api/chart GET never writes here — logging is done by a warm
//     cron over a CONSISTENT daily cross-section, so the research cohort is not
//     selection-biased toward whatever users happened to search.
//   • User-searched tickers ARE tracked, but tagged cohort:'searched' and kept
//     separate from cohort:'universe' so the two are never pooled for research.
//   • Outcomes resolve at 10/21/42/63 sessions. A no-fill is NOT graded as a
//     losing trade. BUY / WAIT / SELL are graded separately.
//   • Nothing here promotes a model or touches production weights — shadow only.

const HORIZONS = [5, 10, 21, 42, 63];   // trading-session forward horizons
const ROUND_TRIP_COST = 0.002;   // 20 bps round-trip (cost-adjusted return)
const TRIGGER_WINDOW = 15;       // sessions the entry trigger stays valid
const DAY_PREFIX = 'swingsearch/day/';
const RESOLVED_PREFIX = 'swingsearch/resolved/';

const round = (v, d = 4) => (v == null || !isFinite(v) ? null : +v.toFixed(d));

// Stable episode identity — the SAME setup logged twice (repeated searches, a
// re-run cron) resolves to the SAME identity so it can be deduped instead of
// double-counted. A genuinely different structural trigger is a different
// episode, never a silent merge.
function stableIdentity(ticker, swing) {
  const p = swing.plan || {};
  return [
    String(ticker || '').toUpperCase(),
    swing.version || 'swing-v1',
    swing.action,
    swing.setup || 'none',
    p.side || '-',
    p.setupType || '-',
    p.trigger != null ? `t@${p.trigger}` : 't@-',
  ].join('|');
}

// Immutable decision-time snapshot. `swing` is a lib/swingread output.
// meta.primary (optional) = the orchestrator's primary recommendation for this
// horizon — recorded verbatim so the ledger grades what the USER actually saw.
function buildSwingSnapshot(ticker, swing, meta = {}) {
  const p = swing.plan || {};
  const prim = meta.primary || null;
  const snap = {
    ticker: String(ticker || '').toUpperCase(),
    identity: meta.identity || stableIdentity(ticker, swing),
    decisionAt: meta.asOf || swing.dataAsOf || null, // decision timestamp (last bar)
    loggedAt: meta.loggedAt || null,                 // wall-clock log time (ISO)
    nextSession: meta.nextSession || null,           // next executable session date
    action: swing.action,
    setup: swing.setup || null,
    signedScore: swing.signedScore ?? null,
    evidenceStrength: swing.evidenceStrength ?? null,
    reasons: (swing.reasons || []).slice(0, 4),
    version: swing.version || 'swing-v1',
    features: swing.factors || {},                   // complete feature snapshot
    plan: p.trigger != null ? {
      side: p.side, setupType: p.setupType, trigger: p.trigger,
      invalidation: p.invalidation, objective: p.objective,
      timeStop: p.timeStop || null, watchOnly: p.watchOnly === true,
    } : null,
    // The user-independent recommendation state (WATCH/READY/TRIGGERED…), its
    // freshness envelope and evidence families at decision time.
    primary: prim ? {
      action: prim.action || null, setupState: prim.setupState || null,
      direction: prim.direction || null,
      orchestratorVersion: prim.version || null,
      freshnessState: prim.freshness ? prim.freshness.freshnessState : null,
      marketSession: prim.freshness ? prim.freshness.marketSession : null,
      dataAsOf: prim.freshness ? prim.freshness.dataAsOf : null,
      families: (prim.families || []).map(f => f.family),
      eventRisks: (prim.eventRisks || []).slice(0, 4),
      warnings: (prim.warnings || []).slice(0, 4),
    } : null,
    regime: meta.regime || null,                     // market/sector regime
    provenance: { source: meta.source || 'yahoo-daily', freshness: swing.freshness || 'daily-close', priceBasis: meta.priceBasis || 'split-adjusted' },
    missingData: {
      benchmark: swing.benchmarkAvailable === false,
      sector: swing.sectorAvailable === false,
    },
    cohort: meta.cohort === 'searched' ? 'searched' : 'universe',
    calibrated: false,
  };
  return Object.freeze(snap);
}

// Favorable/adverse excursion over the forward window, in signed (side-aware) terms.
function excursions(forward, entry, side, upTo) {
  let mfe = 0, mae = 0;
  for (let i = 1; i <= upTo && i < forward.length; i++) {
    const f = forward[i];
    const up = side > 0 ? (f.high - entry) / entry : (entry - f.low) / entry;
    const dn = side > 0 ? (f.low - entry) / entry : (entry - f.high) / entry;
    if (up > mfe) mfe = up;
    if (dn < mae) mae = dn;
  }
  return { mfe: round(mfe), mae: round(mae) };
}

// Trigger / target / invalidation resolution (only meaningful when a plan exists).
function resolvePlan(plan, forward) {
  if (!plan) return { filled: null, outcome: 'no-plan' };
  const long = plan.side === 'long';
  let filled = false, entryIdx = -1;
  for (let i = 0; i < Math.min(TRIGGER_WINDOW, forward.length); i++) {
    const f = forward[i];
    if (long ? f.high >= plan.trigger : f.low <= plan.trigger) { filled = true; entryIdx = i; break; }
  }
  if (!filled) return { filled: false, outcome: 'no-fill' };
  for (let i = entryIdx; i < forward.length; i++) {
    const f = forward[i];
    const hitObj = long ? f.high >= plan.objective : f.low <= plan.objective;
    const hitInv = long ? f.low <= plan.invalidation : f.high >= plan.invalidation;
    if (hitInv && hitObj) return { filled: true, outcome: 'ambiguous', entryIdx };  // both in one bar → conservative
    if (hitInv) return { filled: true, outcome: 'invalidation', entryIdx };
    if (hitObj) return { filled: true, outcome: 'target', entryIdx };
  }
  return { filled: true, outcome: 'timeout', entryIdx };
}

/**
 * Grade a snapshot against forward daily bars (strictly AFTER the decision date).
 * @param {Object} snapshot buildSwingSnapshot output
 * @param {Array} forward next-executable-session-onward daily candles {open,high,low,close}
 * @param {Array|null} spyForward SPY bars aligned index-for-index with `forward`
 */
function gradeSwingSnapshot(snapshot, forward, spyForward = null) {
  if (!Array.isArray(forward) || forward.length < 2) return { resolved: false, reason: 'insufficient-forward' };
  const side = snapshot.action === 'SELL' ? -1 : 1;
  const isTrade = snapshot.action === 'BUY' || snapshot.action === 'SELL';
  const plan = resolvePlan(snapshot.plan, forward);

  // ENTRY IS THE PLAN'S FILL, not day-1's open: a BUY whose trigger fills on
  // day 7 is graded from the price the plan actually told the user to pay
  // (trigger, or the open when price gaps through it). Planless/watch rows and
  // no-fills keep the next-open basis for reference.
  let entryIdx = 0;
  let entry = forward[0].open || forward[0].close;
  let entryBasis = 'next-open';
  if (isTrade && plan.filled === true && plan.entryIdx >= 0 && snapshot.plan) {
    const bar = forward[plan.entryIdx];
    const long = snapshot.plan.side === 'long';
    const gapThrough = long ? (bar.open >= snapshot.plan.trigger) : (bar.open <= snapshot.plan.trigger);
    entry = gapThrough ? bar.open : snapshot.plan.trigger;
    entryIdx = plan.entryIdx;
    entryBasis = 'fill';
  }
  const fwd = forward.slice(entryIdx);
  const spyFwd = spyForward && spyForward.length === forward.length ? spyForward.slice(entryIdx) : null;
  const spyEntry = spyFwd && spyFwd[0] ? (spyFwd[0].open || spyFwd[0].close) : null;

  const byHorizon = {};
  for (const H of HORIZONS) {
    if (fwd.length <= H) { byHorizon[H] = { resolved: false }; continue; }
    const px = fwd[H].close;
    const raw = (px - entry) / entry;
    const dir = raw * side;                                  // positive = the call worked
    let spyRel = null;
    if (spyEntry) { const s = (spyFwd[H].close - spyEntry) / spyEntry; spyRel = round(dir - s * side); }
    const { mfe, mae } = excursions(fwd, entry, side, H);
    byHorizon[H] = {
      resolved: true,
      rawReturn: round(raw), directional: round(dir),
      spyRelative: spyRel,
      costAdjusted: round(dir - ROUND_TRIP_COST),
      mfe, mae,
    };
  }
  return {
    resolved: true,
    ticker: snapshot.ticker,
    identity: snapshot.identity || null,
    action: snapshot.action,          // graded per-action by the caller
    cohort: snapshot.cohort,
    isTrade,
    entry: round(entry, 2),
    entryBasis,
    entryIdx,
    filled: plan.filled,              // false = no-fill (NOT counted as a loss)
    planOutcome: plan.outcome,
    byHorizon,
  };
}

// Aggregate resolved rows into per-action, per-horizon stats. Pure.
function summarize(rows) {
  const out = {};
  for (const act of ['BUY', 'WAIT', 'SELL']) {
    const forAct = rows.filter(r => r.resolved && r.action === act);
    const filled = forAct.filter(r => r.filled !== false);       // exclude no-fills from trade P&L
    const perH = {};
    for (const H of HORIZONS) {
      const vals = filled.map(r => r.byHorizon[H]).filter(x => x && x.resolved);
      const dir = vals.map(v => v.directional).filter(v => v != null);
      const rel = vals.map(v => v.spyRelative).filter(v => v != null);
      perH[H] = {
        n: dir.length,
        hitRate: dir.length ? round(dir.filter(v => v > 0).length / dir.length, 3) : null,
        avgDirectional: dir.length ? round(dir.reduce((a, b) => a + b, 0) / dir.length) : null,
        avgSpyRelative: rel.length ? round(rel.reduce((a, b) => a + b, 0) / rel.length) : null,
      };
    }
    out[act] = { total: forAct.length, noFill: forAct.filter(r => r.filled === false).length, byHorizon: perH };
  }
  return out;
}

// ── Shadow routes (cron-driven; never invoked by the read path) ──────────────
function lightRegime(spy) {
  if (!spy || !spy.length) return 'unknown';
  const closes = spy.map(c => c.close);
  const sma50 = closes.length >= 50 ? closes.slice(-50).reduce((a, b) => a + b, 0) / 50 : null;
  if (sma50 == null) return 'unknown';
  return closes[closes.length - 1] > sma50 ? 'risk-on' : 'risk-off';
}

// Wall + concurrency budget for the cron cross-section (each name = one 2y daily
// fetch, so cost is high and unknown-in-advance). Stay under the 60s function wall.
const LOG_BUDGET_MS = 45000;
const LOG_CONCURRENCY = 6;
const DEFAULT_PANEL = 150;   // fixed liquid panel size logged EVERY run (consistent cohort)

// Resolve the tickers to log. Two cohorts, never pooled:
//   • cohort='searched' — explicit ?ticker=/?tickers= (a user-searched name)
//   • cohort='universe' — the DEFAULT: a fixed, alphabetical, liquid SP500 panel
//     logged the SAME every run, so the research cohort is a consistent daily
//     cross-section, not whatever users happened to search. `cursor`+`limit` let a
//     chain sweep a wider slice across runs without breaking day-over-day consistency.
function resolveLogUniverse(req) {
  const explicit = String(req.query.tickers || req.query.ticker || '')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (explicit.length) return { cohort: 'searched', tickers: explicit.slice(0, 60) };
  const U = require('./universe');
  const panel = Array.isArray(U.SP500) ? U.SP500 : [];
  const limit = Math.max(1, Math.min(300, parseInt(req.query.limit, 10) || DEFAULT_PANEL));
  const cursor = Math.max(0, parseInt(req.query.cursor, 10) || 0);
  return { cohort: 'universe', tickers: panel.slice(cursor, cursor + limit) };
}

async function runSwingSearchLog(req, res) {
  const { hasStore, writeJSON } = require('./store');
  if (!hasStore()) return res.status(200).json({ ok: false, reason: 'no-store' });
  const { fetchDailyHistory } = require('./screener');
  const { swingRead } = require('./swingread');

  const { cohort, tickers } = resolveLogUniverse(req);
  if (!tickers.length) return res.status(400).json({ ok: false, error: 'no tickers' });

  const spy = await fetchDailyHistory('SPY', '2y').catch(() => null);
  const regime = lightRegime(spy && spy.candles);

  // Bounded-concurrency worker pool with a wall budget — a partial sweep self-heals
  // next run (the panel is fixed), and the skip count is reported honestly.
  const snaps = [];
  const t0 = Date.now();
  let i = 0, skipped = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++];
      if (Date.now() - t0 > LOG_BUDGET_MS) { skipped++; continue; }
      const d = await fetchDailyHistory(t, '2y').catch(() => null);
      if (!d || !d.candles || d.candles.length < 60) continue;
      const swing = swingRead(d.candles, spy && spy.candles, {});
      // Record the orchestrator's user-facing state (WATCH/READY/TRIGGERED…)
      // alongside the raw engine action, so the ledger grades what was shown.
      // The cron runs post-close, so the newest daily bar is a completed close.
      let primary = null;
      try {
        const { orchestrate } = require('./lookup-orchestrator');
        primary = orchestrate({ ticker: t, horizon: 'swing', swing,
          price: d.candles[d.candles.length - 1].close, dailyBarComplete: true });
      } catch { /* primary capture is best-effort */ }
      snaps.push(buildSwingSnapshot(t, swing, {
        asOf: d.candles[d.candles.length - 1].date, nextSession: null,
        loggedAt: new Date().toISOString(),
        regime, cohort, priceBasis: d.priceBasis || 'split-adjusted',
        primary,
      }));
    }
  };
  await Promise.all(Array.from({ length: LOG_CONCURRENCY }, worker));

  // Date = the panel's latest decision date (all names share the trading day).
  const date = snaps.reduce((m, s) => (s.decisionAt > m ? s.decisionAt : m),
    snaps[0] ? snaps[0].decisionAt : new Date().toISOString().slice(0, 10));
  const path = `${DAY_PREFIX}${cohort}-${date}.json`;
  // MERGE, never overwrite: two searched tickers logged on the same day used to
  // destroy each other's shard (plain write with allowOverwrite). Existing
  // episodes win on identity so a repeated search cannot duplicate or mutate an
  // already-logged decision (append-only per identity per day).
  const { readJSON } = require('./store');
  const existing = await readJSON(path, null).catch(() => null);
  const prior = (existing && Array.isArray(existing.snapshots)) ? existing.snapshots : [];
  const seen = new Set(prior.map(s => s.identity).filter(Boolean));
  const fresh = snaps.filter(s => !s.identity || !seen.has(s.identity));
  const merged = [...prior, ...fresh];
  await writeJSON(path, { date, cohort, regime, snapshots: merged, savedAt: new Date().toISOString() }, 0).catch(() => {});
  return res.status(200).json({ ok: true, date, cohort, logged: fresh.length, deduped: snaps.length - fresh.length, total: merged.length, requested: tickers.length, budgetSkipped: skipped });
}

// ── Public read-only status (no secret) ──────────────────────────────────────
// Pure: pick the latest day-shard PATH per cohort from a list of blob pathnames.
// Filenames are `swingsearch/day/<cohort>-<YYYY-MM-DD>.json`, so a lexicographic
// max over the date is the newest shard for that cohort.
function pickLatestShards(paths) {
  const latest = {};
  const re = /swingsearch\/day\/(universe|searched)-(\d{4}-\d{2}-\d{2})\.json$/;
  for (const p of paths) {
    const m = re.exec(p || '');
    if (!m) continue;
    const [, cohort, date] = m;
    if (!latest[cohort] || date > latest[cohort].date) latest[cohort] = { date, path: p };
  }
  return latest;
}

// Pure: action distribution over a shard's snapshots (BUY/WAIT/SELL/UNAVAILABLE).
function actionDist(snapshots) {
  const d = { BUY: 0, WAIT: 0, SELL: 0, UNAVAILABLE: 0 };
  for (const s of snapshots || []) if (d[s.action] != null) d[s.action]++;
  return d;
}

async function runSwingSearchStatus(req, res) {
  const { hasStore, readJSON } = require('./store');
  res.setHeader('Cache-Control', 's-maxage=60');   // read-only, safe to cache
  if (!hasStore()) return res.status(200).json({ ok: true, store: false, cohorts: {}, days: 0 });
  const { list } = require('@vercel/blob');

  const paths = [];
  let cursor;
  try {
    do { const r = await list({ prefix: DAY_PREFIX, cursor, limit: 1000 }); paths.push(...r.blobs.map(b => b.pathname || b.url)); cursor = r.cursor; } while (cursor);
  } catch (e) {
    return res.status(200).json({ ok: false, store: true, error: 'list failed', cohorts: {}, days: 0 });
  }
  const latest = pickLatestShards(paths);
  const cohorts = {};
  for (const [cohort, info] of Object.entries(latest)) {
    const day = await readJSON(info.path, null).catch(() => null);
    const snaps = (day && day.snapshots) || [];
    cohorts[cohort] = {
      date: info.date, count: snaps.length, regime: day && day.regime || null,
      savedAt: day && day.savedAt || null, actions: actionDist(snaps),
    };
  }
  return res.status(200).json({ ok: true, store: true, days: paths.length, cohorts });
}

async function runSwingSearchGrade(req, res) {
  const { hasStore, readJSON, writeJSON } = require('./store');
  if (!hasStore()) return res.status(200).json({ ok: false, reason: 'no-store' });
  const { list } = require('@vercel/blob');
  const { fetchDailyHistory } = require('./screener');

  // Load every logged day-shard, grade any whose horizon has now elapsed.
  const blobs = [];
  let cursor;
  do { const r = await list({ prefix: DAY_PREFIX, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const spy = await fetchDailyHistory('SPY', '2y').catch(() => null);
  const spyByDate = new Map((spy && spy.candles || []).map(c => [c.date, c]));

  const resolved = [];
  for (const b of blobs.slice(0, 40)) {
    const day = await readJSON(b.pathname || b.url, null).catch(() => null);
    if (!day || !Array.isArray(day.snapshots)) continue;
    for (const snap of day.snapshots) {
      const d = await fetchDailyHistory(snap.ticker, '2y').catch(() => null);
      if (!d || !d.candles) continue;
      const idx = d.candles.findIndex(c => c.date > snap.decisionAt);
      if (idx < 0) continue;
      const forward = d.candles.slice(idx);
      const spyForward = forward.map(c => spyByDate.get(c.date)).filter(Boolean);
      const graded = gradeSwingSnapshot(snap, forward, spyForward.length === forward.length ? spyForward : null);
      if (graded.resolved) resolved.push(graded);
    }
  }
  const summary = summarize(resolved);
  await writeJSON(`${RESOLVED_PREFIX}latest.json`, { summary, n: resolved.length, at: new Date().toISOString() }, 0).catch(() => {});
  return res.status(200).json({ ok: true, graded: resolved.length, summary });
}

module.exports = {
  buildSwingSnapshot, gradeSwingSnapshot, summarize, resolvePlan, excursions, stableIdentity,
  runSwingSearchLog, runSwingSearchGrade, runSwingSearchStatus,
  resolveLogUniverse, lightRegime, pickLatestShards, actionDist,
  HORIZONS, ROUND_TRIP_COST, DAY_PREFIX, RESOLVED_PREFIX, DEFAULT_PANEL,
};

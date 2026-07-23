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

const HORIZONS = [10, 21, 42, 63];
const ROUND_TRIP_COST = 0.002;   // 20 bps round-trip (cost-adjusted return)
const TRIGGER_WINDOW = 15;       // sessions the entry trigger stays valid
const DAY_PREFIX = 'swingsearch/day/';
const RESOLVED_PREFIX = 'swingsearch/resolved/';

const round = (v, d = 4) => (v == null || !isFinite(v) ? null : +v.toFixed(d));

// Immutable decision-time snapshot. `swing` is a lib/swingread output.
function buildSwingSnapshot(ticker, swing, meta = {}) {
  const p = swing.plan || {};
  const snap = {
    ticker: String(ticker || '').toUpperCase(),
    identity: meta.identity || null,                 // stable id when available
    decisionAt: meta.asOf || swing.dataAsOf || null, // decision timestamp (last bar)
    nextSession: meta.nextSession || null,           // next executable session date
    action: swing.action,
    setup: swing.setup || null,
    signedScore: swing.signedScore ?? null,
    evidenceStrength: swing.evidenceStrength ?? null,
    reasons: (swing.reasons || []).slice(0, 4),
    version: swing.version || 'swing-v1',
    features: swing.factors || {},                   // complete feature snapshot
    plan: p.trigger != null ? { side: p.side, setupType: p.setupType, trigger: p.trigger, invalidation: p.invalidation, objective: p.objective } : null,
    regime: meta.regime || null,                     // market/sector regime
    provenance: { source: meta.source || 'yahoo-daily', freshness: swing.freshness || 'daily-close', priceBasis: meta.priceBasis || 'split-adjusted' },
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
  const entry = forward[0].open || forward[0].close;
  const spyEntry = spyForward && spyForward[0] ? (spyForward[0].open || spyForward[0].close) : null;

  const byHorizon = {};
  for (const H of HORIZONS) {
    if (forward.length <= H) { byHorizon[H] = { resolved: false }; continue; }
    const px = forward[H].close;
    const raw = (px - entry) / entry;
    const dir = raw * side;                                  // positive = the call worked
    let spyRel = null;
    if (spyEntry) { const s = (spyForward[H].close - spyEntry) / spyEntry; spyRel = round(dir - s * side); }
    const { mfe, mae } = excursions(forward, entry, side, H);
    byHorizon[H] = {
      resolved: true,
      rawReturn: round(raw), directional: round(dir),
      spyRelative: spyRel,
      costAdjusted: round(dir - ROUND_TRIP_COST),
      mfe, mae,
    };
  }
  const plan = resolvePlan(snapshot.plan, forward);
  return {
    resolved: true,
    ticker: snapshot.ticker,
    action: snapshot.action,          // graded per-action by the caller
    cohort: snapshot.cohort,
    isTrade,
    entry: round(entry, 2),
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

async function runSwingSearchLog(req, res) {
  const { hasStore, readJSON, writeJSON } = require('./store');
  if (!hasStore()) return res.status(200).json({ ok: false, reason: 'no-store' });
  const { fetchDailyHistory } = require('./screener');
  const { swingRead } = require('./swingread');
  const { latestSessionDate, nextSessionBar } = require('./swing-sessions');

  const cohort = req.query.cohort === 'searched' ? 'searched' : 'universe';
  const tickers = String(req.query.tickers || req.query.ticker || '')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 60);
  if (!tickers.length) return res.status(400).json({ ok: false, error: 'no tickers' });

  const spy = await fetchDailyHistory('SPY', '2y').catch(() => null);
  const regime = lightRegime(spy && spy.candles);
  const snaps = [];
  for (const t of tickers) {
    const d = await fetchDailyHistory(t, '2y').catch(() => null);
    if (!d || !d.candles || d.candles.length < 60) continue;
    const swing = swingRead(d.candles, spy && spy.candles, {});
    const asOf = d.candles[d.candles.length - 1].date;
    snaps.push(buildSwingSnapshot(t, swing, {
      asOf, nextSession: null, regime, cohort,
      priceBasis: d.priceBasis || 'split-adjusted',
    }));
  }
  const date = (snaps[0] && snaps[0].decisionAt) || new Date().toISOString().slice(0, 10);
  const path = `${DAY_PREFIX}${cohort}-${date}.json`;
  await writeJSON(path, { date, cohort, regime, snapshots: snaps, savedAt: new Date().toISOString() }, 0).catch(() => {});
  return res.status(200).json({ ok: true, date, cohort, logged: snaps.length });
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
  buildSwingSnapshot, gradeSwingSnapshot, summarize, resolvePlan, excursions,
  runSwingSearchLog, runSwingSearchGrade,
  HORIZONS, ROUND_TRIP_COST, DAY_PREFIX, RESOLVED_PREFIX,
};

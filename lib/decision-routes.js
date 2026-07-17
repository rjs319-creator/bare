'use strict';
// UNIFIED DECISION ENGINE routes (op=today) — folded into api/tracker.js (no new
// Serverless Function). Server-authoritative: ranks every screener's picks into ONE
// canonical, validated, horizon-bucketed table via lib/decision.js, so the client
// only renders (no client/server scoring skew). Self-fetches the already-cached
// source endpoints (the warm cron keeps them fresh), then CDN-caches its own result.
//
//   op=today          : the ranked command-center payload
//   op=today&log=1     : also persist today's snapshot (warm-cron) so tomorrow can
//                        compute the new/upgraded/downgraded/failed/expired lanes

const { internalHeaders } = require('./auth');
const { hasStore, readJSON, writeJSON } = require('./store');
const { nowET } = require('./stats');
const D = require('./decision');
const N = require('./decision-normalizers');
const PF = require('./decision-portfolio');
const { enrichFreshness, DATA_TRUST_LEGEND } = require('./provenance');
const SCHEMA_VERSION = D.SCHEMA_VERSION;

const RO = require('./remaining-edge-origins');

const HOST = process.env.WARM_HOST || 'market-news-app-chi.vercel.app';
const SNAP_PATH = 'today/latest.json';
const ORIGINS_PATH = 'today/origins.json';

// One self-fetch of a cached endpoint. Never throws — a dead source contributes
// nothing + a freshness warning (error ≠ empty, per the app's honesty premise).
async function pull(path) {
  const t0 = Date.now();
  try {
    const r = await fetch('https://' + HOST + path, { headers: internalHeaders(), signal: AbortSignal.timeout(12000) });
    if (!r.ok) return { path, ok: false, status: r.status, ms: Date.now() - t0, data: null };
    return { path, ok: true, status: 200, ms: Date.now() - t0, data: await r.json() };
  } catch (e) {
    return { path, ok: false, error: String((e && e.message) || e), ms: Date.now() - t0, data: null };
  }
}

// ── Pure payload assembly (testable without network) ────────────────────────
// sources: { screener, screenerSmall, gapgo, daytrade, coil, scoreboard, sectors, ai:{rt,an,sw,ca,ts} }
// prev: the previous snapshot ({ids:[{id,state,rank,score}]}) or null.
// `redundancy` (optional) = the measured model from lib/redundancy.js. Null → rankSignals
// keeps the static family prior, so op=today is unchanged until the ledgers earn a change.
// `origins` (optional) = the immutable remaining-edge origin map (today/origins.json). Null →
// rankSignals forces remainingMult 1, so the board is unchanged until origins are persisted.
function buildToday(sources = {}, prev = null, redundancy = null, origins = null) {
  const s = sources;
  const regime = (s.screener && s.screener.regime) || {};
  const sec = N.sectorStrength(s.sectors || {});

  // 1) Normalize every source → raw canonical inputs, stamped with sector strength.
  const raw = [
    ...N.fromScreener(s.screener || {}),
    ...N.fromScreener(s.screenerSmall || {}),
    ...N.fromGapGo(s.gapgo || {}),
    ...N.fromDayTrade(s.daytrade || {}),
    ...N.fromCoil(s.coil || {}),
    ...N.fromGapDown(s.gapdown || {}),
    ...N.fromBiotech(s.biotech || {}),
    ...N.fromCoreMomentum(s.coremo || {}),
    ...N.fromDownDay(s.downday || {}),
    ...N.fromOptionsFlow(s.optionsflow || {}),
    ...N.fromAiScreeners(s.ai || {}),
  ].map(sig => ({ ...sig, sectorStrength: sig.sector != null ? (sec.byName[sig.sector] ?? null) : null }));

  // 2) Merge same (ticker,horizon) across sources (independent-evidence #3), validate.
  const merged = D.mergeSignals(raw).map(m => D.makeSignal(m).signal);

  // 3) Rank against live regime + Scoreboard expectancy.
  const scoreboard = s.scoreboard || {};
  const active = D.rankSignals(merged, { regime, scoreboard, redundancy, origins });
  const all = D.rankSignals(merged, { regime, scoreboard, includeInactive: true, redundancy, origins });

  // 4) Bucket by horizon (#2 — never mixed).
  const horizons = {};
  for (const h of D.HORIZONS) horizons[h] = active.filter(x => x.horizon === h);

  // 5) Lanes — diff against the previous snapshot (empty on day 1 → all "new").
  const prevMap = new Map(((prev && prev.ids) || []).map(x => [x.id, x]));
  const lanes = { new: [], upgraded: [], downgraded: [], failed: [], expired: [], resolved: [] };
  for (const sig of active) {
    const p = prevMap.get(sig.id);
    if (!p) { lanes.new.push(sig); continue; }
    if (sig.score >= p.score + 8) lanes.upgraded.push(sig);
    else if (sig.score <= p.score - 8) lanes.downgraded.push(sig);
  }
  const activeIds = new Set(active.map(x => x.id));
  for (const sig of all) {
    if (!prevMap.has(sig.id)) continue;                 // only report on names we were tracking
    if (sig.state === 'failed') lanes.failed.push(sig);
    else if (sig.state === 'expired' && !activeIds.has(sig.id)) lanes.expired.push(sig);
    else if (sig.state === 'resolved') lanes.resolved.push(sig);
  }

  // 6) Upcoming risk events attached to signals (#8) — binary risk (print inside the
  // hold window) first, then passed/scheduled. Deduped by ticker.
  const EK = { binary: 0, passed: 1, scheduled: 2 };
  const seenEv = new Set();
  const events = active.filter(x => x.event && (x.event.kind === 'binary' || x.event.kind === 'passed'))
    .map(x => ({ ticker: x.ticker, horizon: x.horizon, ...x.event }))
    .sort((a, b) => (EK[a.kind] ?? 3) - (EK[b.kind] ?? 3) || (a.inDays ?? 999) - (b.inDays ?? 999))
    .filter(e => (seenEv.has(e.ticker) ? false : (seenEv.add(e.ticker), true)));

  const top = active.slice(0, 10);   // the single ranked 5–10 shortlist (#1b)

  // 7) Portfolio-aware selection (#8). `top` stays the pure per-signal rank — the two
  // answer different questions ("what scored best?" vs "what would I actually hold?") and
  // the difference between them IS the product. Nothing here re-orders on merit; it only
  // removes for set-level reasons and says exactly why.
  const portfolio = PF.buildPortfolio(active, { size: 10 });
  return {
    generatedAt: new Date().toISOString(),
    regime: {
      riskOn: regime.riskOn === true, bearish: regime.bearish === true,
      breadthPct: regime.breadthPct ?? null, condition: regime.condition || null,
      label: regime.bearish ? 'Risk-off' : regime.riskOn ? 'Risk-on' : 'Neutral',
    },
    sectors: { leading: sec.leading, weakening: sec.weakening },
    counts: { signals: active.length, byHorizon: Object.fromEntries(D.HORIZONS.map(h => [h, horizons[h].length])) },
    horizons, top, lanes, events, portfolio,
    evidenceLegend: D.FAMILY_LABEL,
    strategyFamilyLegend: D.STRATEGY_FAMILY_META,
    // How the double-counting penalty was decided TODAY — asserted vs earned. Surfaced so
    // a reader can audit whether an "N families agree" chip reflects measured independence
    // or the hand-assigned 0.3 prior. Null model → explicitly says it is the prior.
    redundancy: redundancy ? {
      method: 'measured',
      version: redundancy.version,
      verdict: redundancy.verdict,
      measurablePairs: redundancy.summary.measurablePairs,
      totalPairs: redundancy.summary.totalPairs,
      avgMeasuredCredit: redundancy.summary.avgMeasuredCredit,
      avgConfirmationLift: redundancy.summary.avgConfirmationLift,
      confirmationPays: redundancy.summary.confirmationPays,
      priorCredit: redundancy.priorCredit,
      asOf: redundancy.generatedAt || null,
      note: redundancy.note,
    } : {
      method: 'prior',
      priorCredit: D.CORR_DISCOUNT,
      note: 'No measured redundancy model yet — a second agreeing screener in the same family is charged the static prior. Run op=redundancy once the ledgers have ≥8 paired dates per algorithm pair.',
    },
    // Remaining-edge model status (spec §3). Active once origins have been persisted; until
    // then every name is treated as fresh (mult 1) and the board is unchanged.
    remainingEdge: origins && Object.keys(origins).length ? {
      active: true, version: require('./remaining-edge').REMAINING_EDGE_VERSION,
      tracked: Object.keys(origins).length,
      note: 'Live candidates are ranked by how much of their advertised move is still ahead — a name that has already run is demoted, and a name with no net edge left to enter on drops off. Measured against an immutable origin snapshot per signal.',
    } : {
      active: false,
      note: 'Remaining-edge ranking is dormant — origin snapshots have not been persisted yet (they accrue on the daily cron). Names are ranked on their original score until then.',
    },
  };
}

// Trim an enriched signal down to what the snapshot needs for tomorrow's diff.
const snapRow = (x) => ({ id: x.id, ticker: x.ticker, horizon: x.horizon, state: x.state, rank: x.rank, score: x.score });

async function runToday(req, res) {
  const paths = {
    screener: '/api/screener?scope=large', screenerSmall: '/api/screener?scope=small',
    gapgo: '/api/tracker?op=gapgo', daytrade: '/api/tracker?op=daytrade', coil: '/api/tracker?op=coil',
    gapdown: '/api/tracker?op=gapdown', biotech: '/api/tracker?op=biotech',
    coremo: '/api/tracker?op=core',
    // Adapter coverage (#1): downday supplies the meanReversion family (declared in
    // SOURCE_FAMILY but never emitted until now) and optionsflow supplies the first
    // non-price evidence family on the board.
    downday: '/api/tracker?op=downday', optionsflow: '/api/tracker?op=optionsflow',
    scoreboard: '/api/tracker?op=scoreboard', sectors: '/api/sectors',
    rt: '/api/tracker?op=readthrough', an: '/api/tracker?op=anomaly',
    sw: '/api/tracker?op=secondwave', ca: '/api/tracker?op=crossasset', ts: '/api/tracker?op=toneshift',
  };
  const keys = Object.keys(paths);
  const results = await Promise.all(keys.map(k => pull(paths[k])));
  const got = {}; keys.forEach((k, i) => { got[k] = results[i]; });

  const sources = {
    screener: got.screener.data, screenerSmall: got.screenerSmall.data,
    gapgo: got.gapgo.data, daytrade: got.daytrade.data, coil: got.coil.data,
    gapdown: got.gapdown.data, biotech: got.biotech.data,
    coremo: got.coremo.data,
    downday: got.downday.data, optionsflow: got.optionsflow.data,
    scoreboard: got.scoreboard.data, sectors: got.sectors.data,
    ai: { rt: got.rt.data, an: got.an.data, sw: got.sw.data, ca: got.ca.data, ts: got.ts.data },
  };
  const prev = await readJSON(SNAP_PATH, null).catch(() => null);
  // Best-effort: a missing/thin/failed model returns null → static family prior.
  const redundancy = await require('./redundancy-routes').loadRedundancyModel().catch(() => null);
  // Immutable origin snapshots for the remaining-edge model (spec §3). Absent on a cold store
  // → null → rankSignals leaves the board unchanged.
  const originsDoc = await readJSON(ORIGINS_PATH, null).catch(() => null);
  const origins = (originsDoc && originsDoc.origins) || null;
  const payload = buildToday(sources, prev, redundancy, origins);

  // Freshness / system-health + data-trust provenance (#10 + data-trust ask): which
  // sources answered, how stale, what feed they came from, delayed vs real-time.
  const rawFresh = keys.map(k => ({
    source: k, ok: got[k].ok, ms: got[k].ms,
    asOf: got[k].data && (got[k].data.generatedAt || got[k].data.at) || null,
  }));
  const freshness = enrichFreshness(rawFresh, Date.now());
  const down = freshness.filter(f => !f.ok).map(f => f.label || f.source);
  const staleSrc = freshness.filter(f => f.stale).map(f => f.label || f.source);
  const warnings = [];
  if (down.length) warnings.push(`${down.length} source(s) unavailable: ${down.join(', ')}`);
  if (staleSrc.length) warnings.push(`${staleSrc.length} source(s) stale (>1 day): ${staleSrc.join(', ')}`);
  payload.freshness = { sources: freshness, warnings, delayedFeed: true, legend: DATA_TRUST_LEGEND, dataVersion: SCHEMA_VERSION };
  payload.configured = hasStore();

  // Persist snapshot for tomorrow's lanes (cron-only, gated by ?log=1 + store).
  if (req.query.log === '1' && hasStore()) {
    const { date } = nowET();
    const active = [...payload.top, ...Object.values(payload.horizons).flat()]
      .filter((v, i, a) => a.findIndex(z => z.id === v.id) === i);
    const ids = active.map(snapRow);
    try { await writeJSON(SNAP_PATH, { date, generatedAt: payload.generatedAt, ids }, 0); payload.logged = ids.length; }
    catch (e) { payload.logError = String((e && e.message) || e); }
    // Advance the immutable origin store: capture new names, age existing ones, prune stale.
    // Written with cacheMaxAge 0 to avoid the read-modify-write staleness race (per store.js).
    try {
      const nextOrigins = RO.updateOrigins(origins, active, date);
      await writeJSON(ORIGINS_PATH, { version: RO.ORIGINS_VERSION, date, origins: nextOrigins }, 0);
      payload.originsTracked = Object.keys(nextOrigins).length;
    } catch (e) { payload.originsError = String((e && e.message) || e); }
  }

  // Fresh for 10 min, then serve STALE instantly for up to 24h while revalidating in the
  // background. The daily warm cron computes this once/day, so with a 24h SWR window a
  // servable copy almost always exists — users get an instant response and the slow
  // 12-source recompute happens off the critical path. (Data is EOD/delayed anyway.)
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=86400');
  return res.json({ ok: true, ...payload });
}

module.exports = { runToday, buildToday, snapRow };

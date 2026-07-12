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

const HOST = process.env.WARM_HOST || 'market-news-app-chi.vercel.app';
const SNAP_PATH = 'today/latest.json';

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
function buildToday(sources = {}, prev = null) {
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
    ...N.fromAiScreeners(s.ai || {}),
  ].map(sig => ({ ...sig, sectorStrength: sig.sector != null ? (sec.byName[sig.sector] ?? null) : null }));

  // 2) Merge same (ticker,horizon) across sources (independent-evidence #3), validate.
  const merged = D.mergeSignals(raw).map(m => D.makeSignal(m).signal);

  // 3) Rank against live regime + Scoreboard expectancy.
  const scoreboard = s.scoreboard || {};
  const active = D.rankSignals(merged, { regime, scoreboard });
  const all = D.rankSignals(merged, { regime, scoreboard, includeInactive: true });

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

  // 6) Upcoming risk events attached to signals (earnings/binary).
  const events = active.filter(x => x.event).map(x => ({ ticker: x.ticker, horizon: x.horizon, ...x.event }));

  const top = active.slice(0, 8);
  return {
    generatedAt: new Date().toISOString(),
    regime: {
      riskOn: regime.riskOn === true, bearish: regime.bearish === true,
      breadthPct: regime.breadthPct ?? null, condition: regime.condition || null,
      label: regime.bearish ? 'Risk-off' : regime.riskOn ? 'Risk-on' : 'Neutral',
    },
    sectors: { leading: sec.leading, weakening: sec.weakening },
    counts: { signals: active.length, byHorizon: Object.fromEntries(D.HORIZONS.map(h => [h, horizons[h].length])) },
    horizons, top, lanes, events,
    evidenceLegend: D.FAMILY_LABEL,
  };
}

// Trim an enriched signal down to what the snapshot needs for tomorrow's diff.
const snapRow = (x) => ({ id: x.id, ticker: x.ticker, horizon: x.horizon, state: x.state, rank: x.rank, score: x.score });

async function runToday(req, res) {
  const paths = {
    screener: '/api/screener?scope=large', screenerSmall: '/api/screener?scope=small',
    gapgo: '/api/tracker?op=gapgo', daytrade: '/api/tracker?op=daytrade', coil: '/api/tracker?op=coil',
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
    scoreboard: got.scoreboard.data, sectors: got.sectors.data,
    ai: { rt: got.rt.data, an: got.an.data, sw: got.sw.data, ca: got.ca.data, ts: got.ts.data },
  };
  const prev = await readJSON(SNAP_PATH, null).catch(() => null);
  const payload = buildToday(sources, prev);

  // Freshness / system-health (#10): which sources answered, and how stale.
  const freshness = keys.map(k => ({
    source: k, ok: got[k].ok, ms: got[k].ms,
    asOf: got[k].data && (got[k].data.generatedAt || got[k].data.at) || null,
  }));
  const down = freshness.filter(f => !f.ok).map(f => f.source);
  payload.freshness = { sources: freshness, warnings: down.length ? [`${down.length} source(s) unavailable: ${down.join(', ')}`] : [] };
  payload.configured = hasStore();

  // Persist snapshot for tomorrow's lanes (cron-only, gated by ?log=1 + store).
  if (req.query.log === '1' && hasStore()) {
    const { date } = nowET();
    const ids = [...payload.top, ...Object.values(payload.horizons).flat()]
      .filter((v, i, a) => a.findIndex(z => z.id === v.id) === i).map(snapRow);
    try { await writeJSON(SNAP_PATH, { date, generatedAt: payload.generatedAt, ids }, 0); payload.logged = ids.length; }
    catch (e) { payload.logError = String((e && e.message) || e); }
  }

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
  return res.json({ ok: true, ...payload });
}

module.exports = { runToday, buildToday, snapRow };

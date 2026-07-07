// Dispatcher ops for the dual-horizon read (see lib/longterm.js + lib/dualread-fable.js).
//
//   op=dualread     POST — Fable narrative for one ticker, Blob-cached by quadrant
//                          (the per-stock view calls this async to enrich the banner)
//   op=dualreadlog  cron — log the trending universe tagged with its short×long
//                          quadrant, so the read is falsifiable
//   op=dualreadbook GET  — resolve logged reads to forward excess-vs-SPY BY QUADRANT
//
// Keeps the app's 12-function budget: all three fold into api/tracker.js.

const DUAL_H = 21;                 // ~1 month — a dual-horizon read is a swing/position call, not a day trade
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;  // regenerate the Fable narrative at most every 6h (or on quadrant change)
const CACHE_PREFIX = 'dualread/cache/';
const LOG_UNIVERSE_MAX = 18;       // trending names to log per day (bounded like the momentum scan)

const cleanTicker = t => String(t || '').toUpperCase().replace(/[^A-Z.^-]/g, '').slice(0, 8);

async function fetchTrending() {
  try {
    const r = await fetch('https://api.stocktwits.com/api/2/trending/symbols/equities.json?limit=30',
      { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const d = await r.json();
    return (d.symbols || []).map(s => s.symbol);
  } catch { return []; }
}

// ── op=dualread — Fable narrative for one ticker, cached by quadrant ─────────
async function runDualRead(req, res) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const ticker = cleanTicker(body && body.ticker);
  const st = body && body.st, lt = body && body.lt, mech = body && body.mech;
  if (!ticker || !st || !lt || !mech || !mech.quadrant) {
    return res.status(400).json({ ok: false, error: 'expected JSON { ticker, price, st:{action,confidence,reasons}, lt:{trend,score,reasons,factors}, mech:{quadrant,verdict,setupClass} }' });
  }

  const { readJSON, writeJSON, hasStore } = require('./store');
  const cachePath = `${CACHE_PREFIX}${ticker}.json`;

  // Serve a fresh, same-quadrant cached narrative without re-calling Fable.
  if (hasStore()) {
    const cached = await readJSON(cachePath, null).catch(() => null);
    if (cached && cached.quadrant === mech.quadrant && cached.at &&
        Date.now() - new Date(cached.at).getTime() < CACHE_TTL_MS) {
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ ok: true, ai: cached.ai, quadrant: cached.quadrant, cached: true });
    }
  }

  const { analyzeDualRead } = require('./dualread-fable');
  const ai = await analyzeDualRead({ ticker, price: body.price, st, lt, mech });
  if (ai && hasStore()) {
    await writeJSON(cachePath, { ticker, quadrant: mech.quadrant, ai, at: new Date().toISOString() }, 0).catch(() => {});
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, ai: ai || null, quadrant: mech.quadrant, cached: false });
}

// ── op=dualreadlog — cron: log trending universe tagged by quadrant ─────────
async function runDualReadLog(req, res) {
  const { hasStore, writeDualReadDay } = require('./store');
  if (!hasStore()) return res.json({ ok: false, error: 'no blob store' });
  const { analyze } = require('./signal');
  const { nowET } = require('./stats');
  const date = (nowET ? nowET() : new Date()).toISOString().slice(0, 10);

  const universe = (await fetchTrending()).slice(0, LOG_UNIVERSE_MAX);
  const picks = [];
  const t0 = Date.now();
  let i = 0;
  const worker = async () => {
    while (i < universe.length) {
      const tk = universe[i++];
      if (Date.now() - t0 > 45000) return;   // stay under the function wall
      try {
        const r = await analyze(tk);
        if (!r || !r.dual || !r.longTerm) continue;
        picks.push({
          ticker: r.ticker,
          quadrant: r.dual.quadrant,
          setupClass: r.dual.setupClass,
          stAction: r.live.action,
          ltTrend: r.longTerm.trend,
          ltScore: r.longTerm.score,
          signals: r.longTerm.signals || null,   // per-factor votes → what the tuner learns from
          group: r.longTerm.group || 'other',    // behavior bucket → per-group adaptation
          price: r.price.live,
        });
      } catch { /* skip name */ }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  if (picks.length) await writeDualReadDay(date, picks);
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, date, logged: picks.length, picks });
}

// Active long-term weights (what the tuner has promoted) — default until proven.
async function loadDualReadWeights() {
  const { DEFAULT_LT_WEIGHTS } = require('./longterm');
  try {
    const { readJSON, hasStore } = require('./store');
    if (!hasStore()) return DEFAULT_LT_WEIGHTS;
    const w = await readJSON('dualread/weights.json', null);
    return (w && w.weights) ? w.weights : DEFAULT_LT_WEIGHTS;
  } catch { return DEFAULT_LT_WEIGHTS; }
}

// Shared resolver: every logged read → forward H-session excess-vs-SPY. Returns
// { entries:[{...pick, date, fwd}], resolved, pending }. Used by both book + tune.
async function resolveDualForward(H) {
  const { readAllDualReadDays } = require('./store');
  const { fetchDailyHistory } = require('./screener');
  const days = await readAllDualReadDays();

  // First appearance per ticker+quadrant+date (avoid double-counting a persistent read).
  const seen = new Set();
  const raw = [];
  for (const d of days) for (const p of (d.picks || [])) {
    const key = `${p.ticker}|${p.quadrant}|${d.date}`;
    if (seen.has(key)) continue; seen.add(key);
    raw.push({ ...p, date: d.date });
  }

  const spy = await fetchDailyHistory('SPY', '1y').catch(() => null);
  const spyC = spy && spy.candles;
  const afterN = (c, date, n) => { const idx = c.findIndex(x => x.date >= date); if (idx < 0 || idx + n >= c.length) return null; return { c0: c[idx].close, c1: c[idx + n].close }; };

  const uniq = [...new Set(raw.map(e => e.ticker))];
  const candleCache = {};
  let j = 0;
  const worker = async () => {
    while (j < uniq.length) {
      const tk = uniq[j++];
      try { const d = await fetchDailyHistory(tk, '1y'); candleCache[tk] = d && d.candles; } catch { candleCache[tk] = null; }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));

  const entries = []; let pending = 0;
  for (const e of raw) {
    const c = candleCache[e.ticker];
    if (!c || !spyC) { pending++; continue; }
    const st = afterN(c, e.date, H), m = afterN(spyC, e.date, H);
    if (!st || !m) { pending++; continue; }
    const fwd = ((st.c1 - st.c0) / st.c0 - (m.c1 - m.c0) / m.c0) * 100;
    entries.push({ ...e, fwd });
  }
  return { entries, resolved: entries.length, pending };
}

// ── op=dualreadbook — resolve logged reads to forward excess-vs-SPY by quadrant ─
async function runDualReadBook(req, res) {
  const H = Math.max(1, parseInt(req.query.h, 10) || DUAL_H);
  const { entries, resolved, pending } = await resolveDualForward(H);

  const buckets = {};   // quadrant -> { n, excSum, wins }
  for (const e of entries) {
    const b = buckets[e.quadrant] || (buckets[e.quadrant] = { n: 0, excSum: 0, wins: 0 });
    b.n++; b.excSum += e.fwd; if (e.fwd > 0) b.wins++;
  }
  const byQuadrant = Object.entries(buckets).map(([quadrant, b]) => ({
    quadrant, n: b.n,
    avgExcessPct: +(b.excSum / b.n).toFixed(2),
    beatRatePct: +((b.wins / b.n) * 100).toFixed(0),
  })).sort((a, b) => b.avgExcessPct - a.avgExcessPct);

  // Surface the self-tuner state (global + per behavior-group) so the UI/user can see
  // it's live and which kinds of stocks have earned personalized weights.
  const { MIN_RESOLVED } = require('./dualread-adapt');
  let engine = { version: 'shipped', promoted: false, groups: {} };
  try {
    const { readJSON, hasStore } = require('./store');
    if (hasStore()) {
      const doc = await readJSON('dualread/groupweights.json', null);
      if (doc && doc.global) {
        engine.version = doc.global.version || 'shipped';
        engine.promoted = !!doc.global.promotedAt;
        engine.reason = doc.global.reason || null;
        const g = {};
        for (const [k, v] of Object.entries(doc.groups || {})) g[k] = { personalized: !!v.personalized, version: v.version || 'shipped', resolved: v.resolved || 0 };
        engine.groups = g;
      }
    }
  } catch { /* default */ }
  engine.resolved = resolved; engine.minResolved = MIN_RESOLVED;

  res.setHeader('Cache-Control', 's-maxage=300');
  return res.json({
    ok: true, horizon: H, resolved, pending, byQuadrant, engine,
    note: `Forward ${H}-session excess-vs-SPY of every logged dual-read, split by its short×long quadrant. The read earns its keep if "aligned up"/"pullback-buy" beat SPY while "downtrend"/"bear-bounce" lag. The self-tuner (op=dualreadtune) re-weights the long-term factors from this same ledger once ≥${MIN_RESOLVED} resolve. Accrues via the daily cron.`,
  });
}

// ── op=dualreadtune — cron: champion/challenger re-weight, GLOBAL then PER-GROUP ─
// First tunes the global weights (challenger vs current global). Then, for each
// behavior group, tunes weights that must beat GLOBAL out-of-sample on that group's
// own reads to be adopted — so a group personalizes only where it's proven more
// predictive, else it rides global.
async function runDualReadTune(req, res) {
  const { hasStore, readJSON, writeJSON } = require('./store');
  const { championChallenger, championChallengerByGroup, DEFAULT_LT_WEIGHTS } = require('./dualread-adapt');
  if (!hasStore()) return res.json({ ok: false, error: 'Blob storage not configured.' });

  const prev = await readJSON('dualread/groupweights.json', null);
  const prevGlobal = (prev && prev.global && prev.global.weights) || DEFAULT_LT_WEIGHTS;
  const prevGlobalVer = (prev && prev.global && prev.global.version) || 'shipped';

  const { entries } = await resolveDualForward(DUAL_H);
  const rows = entries.filter(e => e.signals).map(e => ({ signals: e.signals, fwd: e.fwd, date: e.date, group: e.group || 'other' }));

  // 1) Global.
  const gcc = championChallenger(rows, prevGlobal);
  const globalActive = gcc.promoted ? gcc.weights : prevGlobal;
  const globalVer = gcc.promoted ? `v${(parseInt(String(prevGlobalVer).replace(/\D/g, ''), 10) || 0) + 1}` : prevGlobalVer;

  // 2) Per-group, each vs the (updated) global.
  const { groups } = championChallengerByGroup(rows, globalActive);
  const prevGroups = (prev && prev.groups) || {};
  const groupDoc = {};
  for (const [g, r] of Object.entries(groups)) {
    const prevVer = (prevGroups[g] && prevGroups[g].version) || 'shipped';
    groupDoc[g] = {
      personalized: r.personalized,
      weights: r.weights,
      version: r.personalized ? (prevGroups[g] && prevGroups[g].personalized ? prevVer : `v${(parseInt(String(prevVer).replace(/\D/g, ''), 10) || 0) + 1}`) : prevVer,
      resolved: r.resolved, reason: r.reason, oosIcGroup: r.oosIcGroup, oosIcGlobal: r.oosIcGlobal,
    };
  }

  const doc = {
    global: { weights: globalActive, version: globalVer, promotedAt: gcc.promoted ? new Date().toISOString() : (prev && prev.global && prev.global.promotedAt) || null, reason: gcc.reason, resolved: gcc.resolved },
    groups: groupDoc,
    updatedAt: new Date().toISOString(),
  };
  await writeJSON('dualread/groupweights.json', doc, 0);
  // Keep the flat global doc too (back-compat for any reader of dualread/weights.json).
  await writeJSON('dualread/weights.json', { weights: globalActive, version: globalVer, promotedAt: doc.global.promotedAt, reason: gcc.reason }, 0);

  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, globalPromoted: gcc.promoted, global: doc.global, groups: groupDoc, resolved: gcc.resolved, defaultWeights: DEFAULT_LT_WEIGHTS });
}

module.exports = { runDualRead, runDualReadLog, runDualReadBook, runDualReadTune, loadDualReadWeights, DUAL_H };

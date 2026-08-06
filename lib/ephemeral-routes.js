'use strict';
// EPHEMERAL EDGE FACTORY routes — op=ephemeraltick (cron WRITE) + op=ephemeral
// (public paper read). See lib/ephemeral.js for the three-chamber design and
// research/PREREGISTRATION-EPHEMERAL-2026-08.md for the sealed live-stream
// hypothesis. 100% PAPER: nothing here can move a live pick.
const { nowET } = require('./stats');
const { hasStore, readJSON, writeJSON } = require('./store');
const { loadCandleCache, cacheGet } = require('./candle-cache');
const { fetchDailyHistory } = require('./screener');
const E = require('./ephemeral');

const SCAN_PATH = 'ephemeral/scan.json';        // latest survivor set (overwritten each tick)
const DAY_PREFIX = 'ephemeral/day/';            // paper-pick day shards (write-once + resolve-once)
const DAY_RE = /^ephemeral\/day\/\d{4}-\d{2}-\d{2}\.json$/;
const LOOKBACK_SESSIONS = 230;                  // trailing screen window (cache holds ~300 bars)

async function readAllEphemeralDays() {
  if (!hasStore()) return [];
  const { list } = require('@vercel/blob');
  const blobs = []; let cursor;
  do { const r = await list({ prefix: DAY_PREFIX, cursor, limit: 1000 }); blobs.push(...r.blobs); cursor = r.cursor; } while (cursor);
  const days = [];
  await Promise.all(blobs.filter((b) => DAY_RE.test(b.pathname)).map(async (b) => {
    try {
      const res = await fetch(b.url + '?_=' + Date.now(), { cache: 'no-store' });
      if (res.ok) { const j = await res.json(); if (j && j.date) days.push(j); }
    } catch { /* skip */ }
  }));
  return days.sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Build the labeled feature panel from the candle caches: per name-day features,
// cross-sectional z-scores, and next-open→+h-close SPY-excess forward labels.
function buildRows(universeBars, spyBars) {
  const spyOpenAt = new Map(spyBars.map((b, i) => [b.date, i]));
  const rows = [];
  for (const [sym, bars] of universeBars) {
    const start = Math.max(21, bars.length - LOOKBACK_SESSIONS);
    for (let i = start; i < bars.length; i++) {
      const f = E.rawFeatures(bars, i);
      if (!f) continue;
      const fwd = {};
      for (const h of E.HORIZONS) {
        const e0 = i + 1, e1 = i + 1 + h;
        fwd[h] = null;
        if (e1 < bars.length && bars[e0].open > 0) {
          const s = spyOpenAt.get(bars[e0].date);
          const s1 = s != null ? s + h : null;
          if (s1 != null && s1 < spyBars.length && spyBars[s].open > 0) {
            fwd[h] = +(((bars[e1].close / bars[e0].open - 1) - (spyBars[s1].close / spyBars[s].open - 1)) * 100).toFixed(4);
          }
        }
      }
      rows.push({ sym, date: bars[i].date, f, z: {}, fwd });
    }
  }
  return E.zScoreByDate(rows);
}

async function loadUniverseBars() {
  const out = new Map();
  for (const scope of ['large', 'small']) {
    const doc = await loadCandleCache(scope);
    if (!doc || !doc.data) continue;
    for (const t of Object.keys(doc.data)) {
      if (out.has(t)) continue;
      const v = cacheGet(doc, t);
      if (v && Array.isArray(v.candles) && v.candles.length >= 60) out.set(t, v.candles);
    }
  }
  return out;
}

// ── op=ephemeraltick : rescan the grammar, log survivors' firings, resolve matured picks ──
async function runEphemeralTick(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured', op: 'ephemeraltick' });
  const t0 = Date.now();
  const { date, isMarketClosed } = nowET();
  if (isMarketClosed && req.query.force !== '1') {
    return res.status(200).json({ ok: true, op: 'ephemeraltick', skipped: 'market-closed', date });
  }
  const [universeBars, spyD] = await Promise.all([loadUniverseBars(), fetchDailyHistory('SPY')]);
  const spy = spyD ? spyD.candles : null;
  if (!universeBars.size || !spy) return res.status(503).json({ ok: false, op: 'ephemeraltick', error: 'candle cache or SPY unavailable' });

  const rows = buildRows(universeBars, spy);
  const latestDate = rows.reduce((m, r) => (r.date > m ? r.date : m), '');
  const evaln = E.evaluateGrammar(rows);
  const firing = E.currentFirings(rows, evaln.survivors, latestDate);

  // Resolve matured prior picks (single-writer resolve-once, fadetick pattern).
  const days = await readAllEphemeralDays();
  let resolved = 0;
  for (const d of days) {
    let changed = false;
    for (const p of d.picks || []) {
      if (p.resolution) continue;
      const bars = universeBars.get(p.sym);
      const r = bars ? E.resolvePick(p, bars, spy) : null;
      if (r) { p.resolution = r; changed = true; resolved++; }
    }
    if (changed) await writeJSON(`${DAY_PREFIX}${d.date}.json`, d, 0);
  }

  // Persist the survivor scan (compact: stats only, full cell list capped) + today's picks.
  await writeJSON(SCAN_PATH, {
    version: evaln.version, date: latestDate, trials: evaln.trials,
    survivors: evaln.survivors, evaluatedCells: evaln.cells.length,
    cellsWithMinN: evaln.cells.filter((c) => c.dsr != null).length,
    savedAt: new Date().toISOString(),
  }, 0);
  if (firing.picks.length) {
    await writeJSON(`${DAY_PREFIX}${latestDate}.json`, {
      date: latestDate, picks: firing.picks, overflow: firing.overflow, savedAt: new Date().toISOString(),
    }, 0);
  }
  return res.status(200).json({
    ok: true, op: 'ephemeraltick', date: latestDate,
    trials: evaln.trials, survivors: evaln.survivors.length,
    picksLogged: firing.picks.length, overflow: firing.overflow, resolved,
    rows: rows.length, names: universeBars.size, elapsedMs: Date.now() - t0,
  });
}

// ── op=ephemeral : PUBLIC paper read — survivors, current picks, pooled live record ──
async function runEphemeral(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured', op: 'ephemeral' });
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  const [scan, days] = await Promise.all([readJSON(SCAN_PATH, null), readAllEphemeralDays()]);
  const all = days.flatMap((d) => d.picks || []);
  const done = all.filter((p) => p.resolution);
  const rets = done.map((p) => p.resolution.netExcessPct);
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
  return res.status(200).json({
    ok: true, op: 'ephemeral', paper: true, version: E.EPHEMERAL_VERSION,
    scan: scan ? { date: scan.date, trials: scan.trials, survivors: (scan.survivors || []).map((c) => ({ id: c.id, n: c.n, dsr: c.dsr, meanNetPct: c.meanNetPct, hitRate: c.hitRate })) } : null,
    openPicks: all.filter((p) => !p.resolution),
    liveRecord: {
      n: done.length,
      winRate: done.length ? +(done.filter((p) => p.resolution.win).length / done.length).toFixed(3) : null,
      meanNetExcessPct: done.length ? +mean(rets).toFixed(4) : null,
      t: done.length > 2 ? +((mean(rets) / (sd(rets) / Math.sqrt(rets.length)))).toFixed(2) : null,
      note: 'pooled LIVE paper record of survivor firings — the ONLY lane the sealed hypothesis may ever cite; per-pick t is overlap-naive (evaluation will cluster by date)',
    },
    generatedAt: new Date().toISOString(),
  });
}

module.exports = { runEphemeralTick, runEphemeral, buildRows, readAllEphemeralDays, LOOKBACK_SESSIONS };

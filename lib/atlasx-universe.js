'use strict';
// ATLAS-X — candidate & research universe construction.
//
// ATLAS-X must NOT merely re-rank op=today's top names. The evaluable universe is a
// UNION of: current swing-algo candidates ∪ non-terminal ATLAS-X episodes ∪ near-miss
// names around the selection threshold ∪ a research pool for matched controls. In
// live mode it rides the CACHED full-universe daily candles (lib/candle-cache.js) —
// bounded and deterministic, no paid provider, no per-request fan-out — and DISCLOSES
// coverage honestly: which scopes are present, stale or missing, and that partial
// coverage is not a complete market scan.
//
// PURE over its inputs (candleDocs are loaded by the caller) so it is fully testable.

const { toBars } = require('./atlasx-residual');

const DEFAULT_SCOPES = Object.freeze(['large', 'small', 'micro', 'expanded']);
const DEFAULT_CAP = 220;            // bound the deep-evaluation set (serverless-safe)
const NEAR_MISS_KEEP = 60;          // deterministic near-miss names drawn from the pool
const FRESH_HOURS = 26;             // a scope cache younger than this is usable

// capitalization / liquidity group from median dollar-volume.
function capGroupFor(dollarVol) {
  if (dollarVol == null) return 'unknown';
  if (dollarVol >= 100e6) return 'large';
  if (dollarVol >= 20e6) return 'mid';
  if (dollarVol >= 2e6) return 'small';
  return 'micro';
}

function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Cheap PIT liquidity + momentum proxy from a ticker's cached candles.
function poolStats(candles) {
  const bars = toBars(candles);
  if (bars.length < 21) return null;
  const last = bars[bars.length - 1];
  const dv = median(bars.slice(-20).map(b => b.c * b.v));
  const then = bars[bars.length - 21].c;
  const mom20 = then > 0 ? last.c / then - 1 : null;
  return { price: last.c, dollarVol: dv, mom20, capGroup: capGroupFor(dv), lastDate: last.date };
}

// Extract current swing candidates from an op=today payload.
function currentFromToday(todayData) {
  if (!todayData || !todayData.horizons) return [];
  const swing = todayData.horizons.swing || [];
  return swing.map(s => ({
    ticker: s.ticker, sector: s.sector || null, score: s.score, rank: s.rank,
    price: s.price, source: s.source || (s.sources && s.sources[0]) || 'unknown',
  })).filter(x => x.ticker);
}

/**
 * @param {object} p
 * @param {object} p.todayData      op=today payload (current swing-algo candidates)
 * @param {Array}  p.prevEpisodes   ATLAS-X prior episodes
 * @param {object} p.candleDocs     { [scope]: candle-cache doc } already loaded
 * @param {object} [p.opts]         { scopes, cap, nowMs }
 * @returns {object} frozen universe descriptor
 */
function buildUniverse({ todayData, prevEpisodes = [], candleDocs = {}, opts = {} } = {}) {
  const scopes = opts.scopes || DEFAULT_SCOPES;
  const cap = opts.cap || DEFAULT_CAP;
  const nowMs = opts.nowMs || 0;

  const current = currentFromToday(todayData);
  const currentTickers = current.map(c => c.ticker);
  const episodeTickers = (prevEpisodes || [])
    .filter(e => e && e.origin && !e.terminal)
    .map(e => e.origin.ticker);

  // ── scope coverage + research pool from the cached universe ────────────────
  const scopesPresent = [];
  const scopesMissing = [];
  const scopesStale = [];
  const pool = {}; // ticker → stats (deduped across scopes)
  let universeSize = 0;

  for (const scope of scopes) {
    const doc = candleDocs[scope];
    if (!doc || !doc.data) { scopesMissing.push(scope); continue; }
    const ageHours = doc.updatedAt && nowMs ? (nowMs - doc.updatedAt) / 3.6e6 : null;
    const fresh = ageHours == null ? true : ageHours < FRESH_HOURS;
    const size = doc.n || Object.keys(doc.data).length;
    universeSize += size;
    scopesPresent.push({ scope, size, builtDate: doc.builtDate || null, ageHours: round1(ageHours), fresh });
    if (!fresh) scopesStale.push(scope);
    for (const t of Object.keys(doc.data)) {
      if (pool[t]) continue;
      const entry = doc.data[t];
      const candles = Array.isArray(entry.c) ? entry.c : null;
      const st = candles ? poolStats(candles) : null;
      if (st) pool[t] = { ticker: t, scope, ...st };
    }
  }

  // ── near-miss: names NOT already selected, ranked by a simple momentum screen
  // (the deterministic "nearly qualified on plain momentum" set). Honest proxy —
  // it is not op=today's exact rejected set, which is disclosed in the note.
  const selected = new Set([...currentTickers, ...episodeTickers]);
  const nearMiss = Object.values(pool)
    .filter(p => !selected.has(p.ticker) && p.mom20 != null && p.dollarVol >= 2e6)
    .sort((a, b) => (b.mom20 || -9) - (a.mom20 || -9))
    .slice(0, NEAR_MISS_KEEP)
    .map(p => p.ticker);

  // ── evaluable set (bounded, deterministic): union, current first, capped ─────
  const evalTickers = dedupCap([...currentTickers, ...episodeTickers, ...nearMiss], cap);

  const requested = new Set([...currentTickers, ...episodeTickers, ...nearMiss]).size;
  const partial = scopesMissing.length > 0 || scopesStale.length > 0 || evalTickers.length < requested;

  const coverage = Object.freeze({
    scopesPresent, scopesMissing, scopesStale,
    universeSize, poolSize: Object.keys(pool).length,
    requested, evaluable: evalTickers.length, cap,
    partial,
    note: universeSize === 0
      ? 'No cached full-universe candles available — ATLAS-X is evaluating ONLY current op=today swing candidates and prior episodes. This is NOT a full-market scan.'
      : `Coverage is bounded and deterministic over ${universeSize} cached names across ${scopesPresent.length} scope(s). ` +
        (partial ? 'Partial: some scopes are missing/stale or the union exceeded the evaluation cap — this is not a complete market scan.' : 'All requested names are within the evaluation cap.'),
    nearMissMethod: 'plain-momentum proxy over the cached universe (not op=today\'s exact rejected set)',
  });

  return Object.freeze({
    evalTickers,
    sources: Object.freeze({
      current: currentTickers,
      episodes: [...new Set(episodeTickers)],
      nearMiss,
    }),
    current,                       // full current descriptors (sector/score/rank)
    pool: Object.freeze(pool),     // research pool for matched controls
    coverage,
    sectors: [...new Set(current.map(c => c.sector).filter(Boolean))],
  });
}

function dedupCap(arr, cap) {
  const seen = new Set();
  const out = [];
  for (const t of arr) {
    if (!t || seen.has(t)) continue;
    seen.add(t); out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}
const round1 = x => (x == null ? null : Math.round(x * 10) / 10);

module.exports = { buildUniverse, capGroupFor, poolStats, currentFromToday, DEFAULT_SCOPES, DEFAULT_CAP };

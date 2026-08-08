'use strict';
// OPTIONS UNIVERSE v2 — dynamic, deterministic, budget-aware scan universe.
//
// Replaces the fixed LIQUID_OPTIONS list as the SOLE universe. The scan now draws
// from prioritized tiers — the proven liquid core, the app's own screener/mover/
// watchlist candidates, and a ROTATING SHARD of a broader universe so coverage is
// fair and reproducible over time — all under an explicit provider budget.
//
// Deterministic: the same session date + same inputs always produce the same
// universe (shards rotate on the session's day index, not on randomness), so a scan
// is reproducible and a retry is idempotent. Pure — callers inject the source lists.

const { UNIVERSE, DTE_BUCKETS_V2 } = require('./options-config-v2');

const DAY_MS = 86_400_000;

function normTickers(list) {
  const out = [];
  const seen = new Set();
  for (const raw of (list || [])) {
    const t = String(typeof raw === 'string' ? raw : (raw && (raw.ticker || raw.symbol)) || '').toUpperCase().trim();
    if (!t || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// Day index of an ISO session date (UTC midnight) — the deterministic rotation clock.
function dayIndexOf(sessionISO) {
  const ms = Date.parse(`${String(sessionISO).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.floor(ms / DAY_MS) : 0;
}

// The rotating shard: sort the broad list (stable), split into shards of
// `shardSize`, pick shard (dayIndex % shardCount). Every name is visited on a
// fixed cadence — fair, reproducible coverage of the long tail.
function broadShard(broad, sessionISO, shardSize = UNIVERSE.broadShardSize) {
  const sorted = [...normTickers(broad)].sort();
  if (!sorted.length || shardSize <= 0) return { shard: [], shardIndex: null, shardCount: 0 };
  const shardCount = Math.max(1, Math.ceil(sorted.length / shardSize));
  const shardIndex = ((dayIndexOf(sessionISO) % shardCount) + shardCount) % shardCount;
  return { shard: sorted.slice(shardIndex * shardSize, (shardIndex + 1) * shardSize), shardIndex, shardCount };
}

/**
 * Build the session's scan universe from prioritized source tiers.
 * Tiers fill in order until the budget is exhausted; each entry records its source
 * so coverage diagnostics can show WHERE scanned names came from.
 *
 * @param {{core?:string[], screener?:string[], movers?:string[], watchlist?:string[],
 *          catalysts?:string[], broad?:string[]}} sources
 * @param {{session:string, budget?:number, shardSize?:number}} ctx
 * @returns {{tickers:string[], entries:{ticker:string,source:string}[],
 *            shardIndex:number|null, shardCount:number, budget:number, truncated:boolean}}
 */
function buildUniverse(sources = {}, { session, budget = UNIVERSE.scanBudget, shardSize = UNIVERSE.broadShardSize } = {}) {
  const { shard, shardIndex, shardCount } = broadShard(sources.broad, session, shardSize);
  const tiers = [
    ['core', normTickers(sources.core)],
    ['screener', normTickers(sources.screener)],
    ['movers', normTickers(sources.movers)],
    ['catalysts', normTickers(sources.catalysts)],
    ['watchlist', normTickers(sources.watchlist)],
    ['broad-shard', shard],
  ];
  const entries = [];
  const seen = new Set();
  let truncated = false;
  for (const [source, list] of tiers) {
    for (const t of list) {
      if (seen.has(t)) continue;
      if (entries.length >= budget) { truncated = true; break; }
      seen.add(t);
      entries.push({ ticker: t, source });
    }
    if (entries.length >= budget && tiers.some(([, l]) => l.some(t => !seen.has(t)))) truncated = true;
  }
  return { tickers: entries.map(e => e.ticker), entries, shardIndex, shardCount, budget, truncated };
}

// ── Expiry planning per DTE bucket ───────────────────────────────────────────
// Choose ONE representative expiry per configured DTE bucket from the chain's
// available expirations (unix seconds), under a fetch budget. The nearest expiry
// arrives free with the base fetch; extras cost one request each, so we spend the
// budget on the buckets the nearest expiry does NOT cover. Records requested-vs-
// covered buckets so missing coverage is visible, never silent.
function planExpiries({ expirationDates = [], nearestTs = null, nowSec = 0, maxExtra = UNIVERSE.maxExpiryFetches } = {}) {
  const avail = (expirationDates || [])
    .filter(ts => Number.isFinite(ts) && (ts - nowSec) / 86_400 >= 0)
    .map(ts => ({ ts, dte: (ts - nowSec) / 86_400 }));
  const nearestDte = nearestTs != null ? (nearestTs - nowSec) / 86_400 : null;
  const plan = [];
  const used = new Set(nearestTs != null ? [nearestTs] : []);
  const buckets = [];
  for (const b of DTE_BUCKETS_V2) {
    const coveredByNearest = nearestDte != null && nearestDte >= b.min && nearestDte <= b.max;
    let chosen = null;
    if (!coveredByNearest && plan.length < maxExtra) {
      let best = null, bestDist = Infinity;
      for (const c of avail) {
        if (used.has(c.ts)) continue;
        if (c.dte < b.min || c.dte > b.max) continue;
        const d = Math.abs(c.dte - b.targetDte);
        if (d < bestDist) { bestDist = d; best = c; }
      }
      if (best) { chosen = best.ts; used.add(best.ts); plan.push(best.ts); }
    }
    buckets.push({
      bucket: b.key,
      requested: true,
      covered: coveredByNearest || chosen != null,
      via: coveredByNearest ? 'nearest' : (chosen != null ? 'extra-fetch' : 'unavailable'),
    });
  }
  return { extraExpiries: plan, buckets };
}

module.exports = { buildUniverse, broadShard, planExpiries, normTickers, dayIndexOf };

'use strict';
// OPTIONS DECISION EPISODES — immutable, deduplicated theses.
//
// A daily flow snapshot re-lists the same tickers day after day. Grading each daily
// appearance as a separate "prediction" would manufacture many statistically DEPENDENT
// observations from one continuing thesis and inflate any apparent edge. An EPISODE
// collapses repeated appearances of the SAME ticker + directional lean into ONE record,
// held open until the thesis MATERIALLY CHANGES (the lean flips), it goes STALE (stops
// appearing), or — later — a price trigger/invalidation resolves it.
//
// IMMUTABLE: first-seen fields (the honest "decided at" record the grader depends on) are
// written once and never rewritten by a later snapshot. Pure + injected clock (`now`) and
// reference date, so identity and transitions are deterministic and unit-testable. Storage
// lives in the route (a single-writer optionsflow/episodes.json), mirroring pulse-store.

// Map an honest per-ticker directionState to a coarse THESIS side. Identity includes the
// side so a lean flip becomes a NEW episode (material change) rather than silently
// rewriting a directional thesis. MIXED/UNKNOWN collapse to 'neutral'.
function leanSide(directionState) {
  if (directionState === 'PROVISIONAL_BULLISH') return 'bullish';
  if (directionState === 'PROVISIONAL_BEARISH') return 'bearish';
  return 'neutral';
}

function episodeKey(item) {
  return `${String(item.ticker || '').toUpperCase()}:${leanSide(item.directionState)}`;
}

function makeEpisodeId(key, dateISO, seq) {
  const slug = key.replace(/[^A-Za-z0-9]+/g, '').slice(0, 16).toLowerCase();
  return `oep_${String(dateISO).slice(0, 10)}_${slug || 'x'}_${seq}`;
}

function ageDays(fromDate, toDate) {
  if (!fromDate || !toDate) return 0;
  const a = Date.parse(`${fromDate}T00:00:00Z`);
  const b = Date.parse(`${toDate}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

const MAX_GAP_DAYS = 4;    // not seen for > this many days → the thesis is stale
const MAX_EPISODES = 600;  // bounded archival cap
const MAX_SNAPSHOTS = 40;  // per-episode history bound

// One immutable snapshot appended to an episode's history each time its thesis reappears.
function snapOf(item, date, nowISO) {
  return {
    date,
    directionState: item.directionState ?? null,
    score: item.score ?? null,
    underlying: item.underlying ?? null,
    unknownShare: item.unknownShare ?? null,
    oiConfirmedContracts: item.oiConfirmedContracts ?? 0,
    at: nowISO,
  };
}

/**
 * Fold a fresh per-ticker snapshot into the episode ledger. IMMUTABLE — returns a NEW
 * ledger + the transitions emitted; never mutates the input.
 *
 * @param {Array} prevEpisodes existing ledger
 * @param {Array} items        per-ticker rows: {ticker, directionState, underlying, score, ...}
 * @param {{date:string, now?:function, maxGapDays?:number}} ctx
 */
function foldEpisodes(prevEpisodes, items, { date, now = () => new Date().toISOString(), maxGapDays = MAX_GAP_DAYS } = {}) {
  const nowISO = typeof now === 'function' ? now() : now;
  const episodes = (prevEpisodes || []).map(e => ({ ...e }));
  const transitions = [];
  let seq = episodes.length;

  const seenToday = new Set();
  for (const item of items || []) {
    if (!item || !item.ticker) continue;
    const key = episodeKey(item);
    const ticker = String(item.ticker).toUpperCase();
    const side = leanSide(item.directionState);
    seenToday.add(key);

    // A lean FLIP: any OPEN episode for this ticker with a DIFFERENT directional side is
    // materially superseded today — close it (immutable history is retained).
    for (const e of episodes) {
      if (e.status === 'open' && e.ticker === ticker && e.side !== side && (e.side === 'bullish' || e.side === 'bearish') && (side === 'bullish' || side === 'bearish')) {
        e.status = 'closed_flip';
        e.closedDate = date;
        transitions.push({ episodeId: e.id, kind: 'flip', from: e.side, to: side, date, ticker });
      }
    }

    let ep = episodes.find(e => e.key === key && e.status === 'open');
    if (!ep) {
      ep = {
        id: makeEpisodeId(key, date, seq++),
        key, ticker, side,
        firstSeen: nowISO,
        firstSeenDate: date,
        // The decision record — written ONCE, never rewritten (no lookahead).
        firstSeenState: {
          directionState: item.directionState ?? null,
          entryRef: item.underlying ?? null,       // decision-time underlying; grader enters NEXT open
          score: item.score ?? null,
          unknownShare: item.unknownShare ?? null,
          earningsBeforeExpiry: item.earningsBeforeExpiry ?? null,
          oiConfirmedContracts: item.oiConfirmedContracts ?? 0,
          abnormalVsNormal: item.abnormalVsNormal ?? null,
        },
        lastSeen: nowISO,
        lastSeenDate: date,
        appearances: 1,
        snapshots: [snapOf(item, date, nowISO)],
        status: 'open',
        invalidated: false,
      };
      episodes.push(ep);
      transitions.push({ episodeId: ep.id, kind: 'opened', side, date, ticker });
    } else {
      // Existing OPEN episode — preserve first-seen, extend the tail.
      ep.lastSeen = nowISO;
      ep.lastSeenDate = date;
      ep.appearances = (ep.appearances || 1) + 1;
      ep.snapshots = [...ep.snapshots, snapOf(item, date, nowISO)].slice(-MAX_SNAPSHOTS);
    }
  }

  // Stale-close: open episodes not seen today whose last appearance is older than the gap.
  for (const e of episodes) {
    if (e.status !== 'open' || seenToday.has(e.key)) continue;
    if (ageDays(e.lastSeenDate, date) > maxGapDays) {
      e.status = 'closed_stale';
      e.closedDate = date;
      transitions.push({ episodeId: e.id, kind: 'stale', side: e.side, date, ticker: e.ticker });
    }
  }

  return { episodes: episodes.slice(-MAX_EPISODES), transitions };
}

module.exports = {
  MAX_GAP_DAYS, MAX_EPISODES, leanSide, episodeKey, makeEpisodeId, ageDays, foldEpisodes,
};

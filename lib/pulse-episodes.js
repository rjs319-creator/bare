'use strict';
// 📡 MARKET PULSE — narrative EPISODES.
//
// A snapshot is a point-in-time list; an EPISODE is a narrative tracked ACROSS snapshots
// (e.g. "$XYZ FDA decision") with a stable identity, an immutable first-seen record, and
// a lifecycle history. This is what lets Pulse show "Emerging → Building → Crowded" and,
// later, grade whether a story was detected BEFORE or after the price reaction.
//
// Pure + injectable (`now`): no network, no wall clock of its own, so identity + transition
// logic is deterministic and unit-testable. Storage lives in pulse-store.js.

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'as', 'at',
  'by', 'with', 'from', 'this', 'that', 'it', 'its', 'be', 'was', 'will', 'has', 'have',
  'after', 'amid', 'over', 'into', 'up', 'down', 'new', 'us', 'stock', 'stocks', 'shares',
  'market', 'markets', 'says', 'said', 'could', 'may', 'more', 'than', 'plan', 'plans',
]);

/** Significant lowercase word tokens from a headline/theme. Pure. */
function themeTokens(text) {
  return [...new Set(String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(w => w.length >= 4 && !STOPWORDS.has(w)))];
}

/** Canonical clustering key for an item. Ticker names key on their primary ticker;
 *  macro themes key on their significant-word slug. Pure. */
function episodeKey(item) {
  const tks = (item.tickers || []).map(t => String(t).toUpperCase());
  if (tks.length) return 'T:' + tks.slice().sort()[0];
  return 'M:' + themeTokens(item.headline).sort().slice(0, 4).join('-');
}

/** Do two items describe the same narrative? Shared primary ticker, ticker overlap, or
 *  a meaningful theme-word overlap. Pure. */
function sameEpisode(a, b) {
  const at = new Set((a.tickers || []).map(t => String(t).toUpperCase()));
  const bt = new Set((b.tickers || []).map(t => String(t).toUpperCase()));
  if (at.size && bt.size) {
    for (const t of at) if (bt.has(t)) return true;
    return false;                       // both have tickers but none shared → different
  }
  if (at.size !== bt.size) return false; // one macro, one ticker → different
  // both macro: compare theme tokens
  const aw = new Set(themeTokens(a.headline));
  const bw = themeTokens(b.headline);
  let shared = 0;
  for (const w of bw) if (aw.has(w)) shared++;
  return shared >= 2;
}

/** Find the existing episode (from a ledger) that matches an item, or null. Pure. */
function findEpisode(episodes, item) {
  const key = episodeKey(item);
  const byKey = episodes.find(e => e.key === key);
  if (byKey) return byKey;
  return episodes.find(e => e.repr && sameEpisode(e.repr, item)) || null;
}

/** Stable, collision-resistant episode id from key + first-seen date + a short hash. Pure. */
function makeEpisodeId(key, dateISO, seq) {
  const slug = key.replace(/[^A-Za-z0-9]+/g, '').slice(0, 16).toLowerCase();
  return `ep_${dateISO.slice(0, 10)}_${slug || 'x'}_${seq}`;
}

const LIFECYCLE_ORDER = { New: 0, Emerging: 1, Building: 2, Crowded: 3, Fading: 4 };

/**
 * Fold a fresh snapshot into the episode ledger. IMMUTABLE: returns a NEW ledger and a
 * list of transitions; never mutates the input episodes.
 *
 * - first-seen fields (firstSeen, firstSeenState, firstSeenEnrichment) are set ONCE and
 *   preserved forever — a later snapshot can never rewrite them (no lookahead into the
 *   past, and the honest "detected at" record the grader depends on).
 * - a transition is emitted when lifecycle or evidence grade changes vs the prior snapshot.
 *
 * @param {Array} prevEpisodes  existing ledger
 * @param {Array} items         sanitized+state-derived snapshot items
 * @param {{date:string, generation:string|number, now?:function}} ctx
 */
function foldSnapshot(prevEpisodes, items, { date, generation, now = () => new Date().toISOString() } = {}) {
  const episodes = (prevEpisodes || []).map(e => ({ ...e }));
  const nowISO = typeof now === 'function' ? now() : now;
  const transitions = [];
  let seq = episodes.length;

  for (const item of items || []) {
    const key = episodeKey(item);
    let ep = findEpisode(episodes, item);
    const snap = {
      date, generation,
      lifecycleState: item.lifecycleState,
      actionState: item.actionState,
      evidenceState: item.evidenceState,
      rank: item.rank,
      independentSources: item.independentSources || 0,
      at: nowISO,
    };
    if (!ep) {
      ep = {
        id: makeEpisodeId(key, date, seq++),
        key,
        repr: { headline: item.headline, tickers: item.tickers || [], category: item.category },
        canonicalTheme: item.headline,
        tickers: item.tickers || [],
        category: item.category,
        firstSeen: nowISO,
        firstSeenDate: date,
        firstSeenState: {
          lifecycleState: item.lifecycleState, evidenceState: item.evidenceState, actionState: item.actionState,
          // The declared thesis, preserved for the grader. `sentiment` is only a directional
          // claim when the item explicitly took a side; crowding drives the contrarian grade.
          sentiment: item.sentiment || 'mixed', crowding: item.crowding || null,
          contrarianThesis: item.contrarianThesis === true, category: item.category,
        },
        firstSeenEnrichment: item.enrichment || null,
        lastSeen: nowISO,
        lastSeenDate: date,
        snapshots: [snap],
        lifecycleHistory: [{ state: item.lifecycleState, at: nowISO, date }],
        invalidated: false,
      };
      episodes.push(ep);
      transitions.push({ episodeId: ep.id, kind: 'appeared', to: item.lifecycleState, at: nowISO, date, headline: item.headline });
      continue;
    }
    // Existing episode — PRESERVE first-seen, update tail.
    const prevLc = ep.lifecycleHistory[ep.lifecycleHistory.length - 1];
    const prevEv = ep.snapshots[ep.snapshots.length - 1] && ep.snapshots[ep.snapshots.length - 1].evidenceState;
    ep.lastSeen = nowISO;
    ep.lastSeenDate = date;
    ep.canonicalTheme = ep.canonicalTheme || item.headline;
    ep.tickers = [...new Set([...(ep.tickers || []), ...(item.tickers || [])])].slice(0, 8);
    ep.snapshots = [...ep.snapshots, snap].slice(-60);   // bound history
    if (!prevLc || prevLc.state !== item.lifecycleState) {
      ep.lifecycleHistory = [...ep.lifecycleHistory, { state: item.lifecycleState, at: nowISO, date }].slice(-40);
      transitions.push({
        episodeId: ep.id, kind: 'lifecycle',
        from: prevLc ? prevLc.state : null, to: item.lifecycleState,
        at: nowISO, date, headline: ep.canonicalTheme,
      });
    }
    if (prevEv && prevEv !== item.evidenceState) {
      transitions.push({
        episodeId: ep.id, kind: 'evidence',
        from: prevEv, to: item.evidenceState, at: nowISO, date, headline: ep.canonicalTheme,
      });
    }
  }
  return { episodes: episodes.slice(-400), transitions };
}

/** Age in whole days between an episode's firstSeenDate and a reference date. Pure. */
function ageDays(firstSeenDate, refDate) {
  if (!firstSeenDate || !refDate) return 0;
  const a = Date.parse(firstSeenDate + 'T00:00:00Z');
  const b = Date.parse(refDate + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}

module.exports = {
  themeTokens, episodeKey, sameEpisode, findEpisode, makeEpisodeId,
  foldSnapshot, ageDays, LIFECYCLE_ORDER,
};

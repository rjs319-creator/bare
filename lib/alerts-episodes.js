'use strict';
// TICKER-THESIS EPISODES — immutable, deduplicated, source-role-aware.
//
// A social feed re-posts the same idea for days across many accounts. Grading each
// account/ticker/day as its own trade manufactures dependent observations and lets a
// crowded pump credit every account. An EPISODE collapses all posts about the SAME
// ticker+direction thesis into ONE record, held open until the thesis materially changes
// (direction flip), exits, invalidates, or goes stale/expires.
//
// IMMUTABLE: first-seen fields (the honest "decided at" record the grader depends on) are
// written ONCE and never rewritten by a later post. Source roles are credited separately so
// the discoverer, an independent confirmer, and a copied echo are not all treated as full
// independent evidence.
//
// Pure + injected clock. Leads are folded in a deterministic (content-sorted) order, so the
// resulting ledger is invariant to the arrival order of posts.

const ROLES = { DISCOVERER: 'DISCOVERER', CONFIRMER: 'CONFIRMER', ECHO: 'ECHO', CONTRADICTOR: 'CONTRADICTOR', COORDINATED: 'COORDINATED', UNKNOWN: 'UNKNOWN' };
const STATUS = { NEW: 'NEW', WAITING: 'WAITING', TRIGGERED: 'TRIGGERED', EXTENDED: 'EXTENDED', INVALIDATED: 'INVALIDATED', EXITED: 'EXITED', EXPIRED: 'EXPIRED' };

const MAX_GAP_DAYS = 6;      // not seen for > this ⇒ stale ⇒ EXPIRED
const MAX_EPISODES = 800;    // bounded archival cap
const MAX_POSTS = 60;        // per-episode contributing-post bound

const episodeKey = (ticker, side) => `${String(ticker || '').toUpperCase()}:${side}`;
function makeEpisodeId(key, dateISO, seq) {
  const slug = key.replace(/[^A-Za-z0-9]+/g, '').slice(0, 16).toLowerCase();
  return `aep_${String(dateISO).slice(0, 10)}_${slug || 'x'}_${seq}`;
}
function ageDays(fromDate, toDate) {
  if (!fromDate || !toDate) return 0;
  const a = Date.parse(`${fromDate}T00:00:00Z`), b = Date.parse(`${toDate}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

// Decide a source's role WITHIN an episode, given what the episode has already seen. Pure.
function roleFor(lead, episode) {
  if (!lead.identityKnown) return ROLES.UNKNOWN;
  if (lead.coordinated) return ROLES.COORDINATED;
  if (!episode) return ROLES.DISCOVERER;                      // opens the episode
  if (episode.clusterIds && episode.clusterIds.includes(lead.clusterId)) return ROLES.ECHO;  // same idea-cluster
  return ROLES.CONFIRMER;                                     // new, independent cluster
}

// A contributing-post stamp (immutable, appended once per genuinely new contribution).
function contribOf(lead, role, date, nowISO) {
  return {
    sourceKey: lead.sourceKey || null,
    handle: lead.handle || null,
    role,
    clusterId: lead.clusterId || null,
    event: lead.event || null,
    date,
    publishedAt: lead.publishedAt || null,
    coordinated: !!lead.coordinated,
    at: nowISO,
  };
}

/**
 * Fold a batch of parsed thesis leads into the episode ledger. IMMUTABLE — returns a NEW
 * ledger + transitions. Only leads with a direction AND isNewThesis open/extend episodes;
 * lifecycle updates (trim/exit/stop/target) transition an existing open episode's status but
 * never create a directional prediction.
 *
 * @param {Array} prevEpisodes
 * @param {Array} leads  each: { ticker, side:'long'|'short'|null, sourceKey, handle, identityKnown,
 *   publishedAt, collectedAt, clusterId, isOriginal, coordinated, event, isNewThesis, catalysts,
 *   levels, horizon, execRef, skillWeight, regime, priceState, liquidityState, dataQuality,
 *   modelVersion, rulesetVersion, setupClass }
 * @param {{date, now?, maxGapDays?}} ctx
 */
function foldEpisodes(prevEpisodes, leads, { date, now = () => new Date().toISOString(), maxGapDays = MAX_GAP_DAYS } = {}) {
  const nowISO = typeof now === 'function' ? now() : now;
  const episodes = (prevEpisodes || []).map(e => ({ ...e, clusterIds: [...(e.clusterIds || [])], contributors: [...(e.contributors || [])], lifecycle: [...(e.lifecycle || [])] }));
  const transitions = [];
  let seq = episodes.length;

  // Deterministic fold order: by published time then stable source key, so arrival order
  // of the raw buffer cannot change episode identity or which source becomes discoverer.
  const ordered = [...(leads || [])].filter(l => l && l.ticker).sort((a, b) => {
    const ta = Date.parse(a.publishedAt || '') || 0, tb = Date.parse(b.publishedAt || '') || 0;
    return ta - tb || String(a.sourceKey || a.clusterId || '').localeCompare(String(b.sourceKey || b.clusterId || ''));
  });

  const seenKeys = new Set();
  for (const lead of ordered) {
    const ticker = String(lead.ticker).toUpperCase();
    const side = lead.side;

    // ── Lifecycle updates (no new thesis) — transition an existing OPEN episode ──
    if (!lead.isNewThesis || !side) {
      const target = episodes.find(e => e.ticker === ticker && e.status !== STATUS.EXPIRED && e.status !== STATUS.INVALIDATED && (side ? e.side === side : true) && !e.closedDate);
      if (target) {
        const ev = lead.event;
        if (ev === 'STOP_HIT') { target.status = STATUS.INVALIDATED; target.closedDate = date; transitions.push({ episodeId: target.id, kind: 'stop_hit', date, ticker }); }
        else if (ev === 'EXIT_LONG' || ev === 'EXIT_SHORT') { target.status = STATUS.EXITED; target.closedDate = date; transitions.push({ episodeId: target.id, kind: 'exit', date, ticker }); }
        else if (ev === 'TARGET_HIT') { target.targetHit = true; transitions.push({ episodeId: target.id, kind: 'target_hit', date, ticker }); }
        target.lifecycle = [...target.lifecycle, { event: ev, date, sourceKey: lead.sourceKey || null, at: nowISO }].slice(-MAX_POSTS);
      }
      continue;
    }

    const key = episodeKey(ticker, side);
    seenKeys.add(key);

    // A DIRECTION FLIP: an OPEN opposite-side episode for this ticker is materially superseded.
    for (const e of episodes) {
      if ((e.status === STATUS.NEW || e.status === STATUS.WAITING || e.status === STATUS.TRIGGERED || e.status === STATUS.EXTENDED) &&
          e.ticker === ticker && e.side !== side && !e.closedDate) {
        e.status = STATUS.INVALIDATED; e.closedDate = date; e.closeReason = 'flip';
        transitions.push({ episodeId: e.id, kind: 'flip', from: e.side, to: side, date, ticker });
      }
    }

    let ep = episodes.find(e => e.key === key && !e.closedDate);
    const role = roleFor(lead, ep);
    if (!ep) {
      ep = {
        id: makeEpisodeId(key, date, seq++),
        key, ticker, side,
        firstSeen: nowISO,
        firstSeenDate: date,
        // ── the immutable decision record (no lookahead; grader enters NEXT open) ──
        firstSourceKey: lead.identityKnown ? (lead.sourceKey || null) : null,
        firstSourceRole: role,
        firstPublishedAt: lead.publishedAt || null,
        firstCollectedAt: lead.collectedAt || nowISO,
        execRef: lead.execRef ?? null,               // decision-time underlying; grader enters next open
        intendedHorizon: lead.horizon || null,
        horizonAssumed: !lead.horizon,
        setupClass: lead.setupClass || null,
        catalysts: [...new Set(lead.catalysts || [])],
        statedLevels: lead.levels || null,
        regimeAtInception: lead.regime ?? null,
        priceStateAtInception: lead.priceState ?? null,
        liquidityState: lead.liquidityState ?? null,
        dataQualityState: lead.dataQuality ?? null,
        modelVersion: lead.modelVersion || 'alerts-v2',
        rulesetVersion: lead.rulesetVersion || 'lifecycle-v1',
        // ── mutable tail ──
        clusterIds: lead.clusterId ? [lead.clusterId] : [],
        contributors: [contribOf(lead, role, date, nowISO)],
        lifecycle: [],
        distinctClusters: lead.clusterId ? 1 : 0,
        appearances: 1,
        lastSeen: nowISO,
        lastSeenDate: date,
        coordinatedSeen: !!lead.coordinated,
        status: STATUS.NEW,
      };
      episodes.push(ep);
      transitions.push({ episodeId: ep.id, kind: 'opened', side, role, date, ticker });
    } else {
      // Extend an existing OPEN episode. First-seen fields are preserved; only the tail grows.
      ep.lastSeen = nowISO;
      ep.lastSeenDate = date;
      ep.appearances = (ep.appearances || 1) + 1;
      const isNewCluster = lead.clusterId && !ep.clusterIds.includes(lead.clusterId);
      if (isNewCluster) { ep.clusterIds = [...ep.clusterIds, lead.clusterId]; ep.distinctClusters = ep.clusterIds.length; }
      if (lead.coordinated) ep.coordinatedSeen = true;
      // Credit a contributor stamp only for a genuinely new cluster or a new identity (echoes
      // of an already-counted cluster are recorded but flagged ECHO, never as new evidence).
      const alreadyCounted = ep.contributors.some(c => c.sourceKey && c.sourceKey === lead.sourceKey && c.clusterId === lead.clusterId);
      if (!alreadyCounted) ep.contributors = [...ep.contributors, contribOf(lead, role, date, nowISO)].slice(-MAX_POSTS);
      for (const c of (lead.catalysts || [])) if (!ep.catalysts.includes(c)) ep.catalysts.push(c);
      if (ep.status === STATUS.NEW) ep.status = STATUS.WAITING;
      transitions.push({ episodeId: ep.id, kind: 'extended', role, date, ticker });
    }
  }

  // Stale-expire: open episodes not seen recently.
  for (const e of episodes) {
    const open = e.status === STATUS.NEW || e.status === STATUS.WAITING || e.status === STATUS.TRIGGERED || e.status === STATUS.EXTENDED;
    if (!open || seenKeys.has(e.key)) continue;
    if (ageDays(e.lastSeenDate, date) > maxGapDays) {
      e.status = STATUS.EXPIRED; e.closedDate = date; e.closeReason = 'stale';
      transitions.push({ episodeId: e.id, kind: 'expired', side: e.side, date, ticker: e.ticker });
    }
  }

  return { episodes: episodes.slice(-MAX_EPISODES), transitions };
}

// Independent-evidence count for an episode: distinct NON-coordinated clusters with a known
// discoverer/confirmer. Coordinated echoes collapse to one unit and are not counted here.
function independentClusterCount(episode) {
  if (!episode || !episode.contributors) return 0;
  const clusters = new Set();
  for (const c of episode.contributors) {
    if (c.role === ROLES.CONFIRMER || c.role === ROLES.DISCOVERER) clusters.add(c.clusterId || c.sourceKey);
  }
  return clusters.size;
}

module.exports = {
  ROLES, STATUS, MAX_GAP_DAYS, MAX_EPISODES,
  episodeKey, makeEpisodeId, ageDays, roleFor, foldEpisodes, independentClusterCount,
};

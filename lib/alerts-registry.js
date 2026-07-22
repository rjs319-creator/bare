'use strict';
// CANONICAL SOURCE REGISTRY — one durable record per account (stable platform id).
//
// Keyed by the canonical account key (platform:authorId), NEVER by handle (handles change and
// get recycled). Tracks identity + alias history, first/last observed, integrity flags, feed
// coverage, and a POINTER to the evidence state (which is OWNED by the skill model — the
// registry never invents a track record). Follower count / verification badges / engagement
// are stored for INTEGRITY analysis only; they are never treated as predictive skill.
//
// Pure fold over ingested v2 records → new registry (immutable update). Unknown-identity posts
// do NOT create or share a registry record (they can seed raw activity, never account credit).

const MAX_ALIASES = 12;

// Fold a batch of normalized v2 records into the registry. IMMUTABLE.
function foldRegistry(prevRegistry, records, { now = () => new Date().toISOString() } = {}) {
  const nowISO = typeof now === 'function' ? now() : now;
  const reg = { ...(prevRegistry || {}) };
  for (const r of records || []) {
    if (!r || !r.identityKnown || !r.accountKey) continue;      // unknown identity earns no record
    const day = (r.publishedAt || r.collectedAt || nowISO).slice(0, 10);
    const prev = reg[r.accountKey];
    if (!prev) {
      reg[r.accountKey] = {
        sourceId: r.accountKey,
        platform: r.platform,
        authorId: r.authorId,
        currentHandle: r.handle || null,
        aliasHistory: r.handle ? [{ handle: r.handle, firstSeen: day, lastSeen: day }] : [],
        displayName: r.displayName || null,
        firstObserved: day,
        lastObserved: day,
        active: true,
        posts: 1,
        // integrity-only snapshots (NOT skill evidence)
        followersLast: r.followers ?? null,
        promotionalFlags: promoFlags(r),
        provenanceQuality: r.provenanceQuality,
        // evidence state is owned by the skill model; default until stamped
        evidenceState: 'UNKNOWN',
        performanceModelVersion: null,
        missedCapture: [],
      };
    } else {
      const next = { ...prev, lastObserved: day > prev.lastObserved ? day : prev.lastObserved, posts: (prev.posts || 0) + 1, followersLast: r.followers ?? prev.followersLast };
      // Alias history: a changed handle is appended (identity is the id, not the handle).
      if (r.handle && r.handle !== prev.currentHandle) {
        const aliases = [...(prev.aliasHistory || [])];
        const existing = aliases.find(a => a.handle === r.handle);
        if (existing) { existing.lastSeen = day; }
        else aliases.push({ handle: r.handle, firstSeen: day, lastSeen: day });
        next.aliasHistory = aliases.slice(-MAX_ALIASES);
        next.currentHandle = r.handle;
      }
      const pf = promoFlags(r);
      if (pf.length) next.promotionalFlags = [...new Set([...(prev.promotionalFlags || []), ...pf])].slice(0, 8);
      reg[r.accountKey] = next;
    }
  }
  return reg;
}

function promoFlags(r) {
  const flags = [];
  if (r.paidPromotion) flags.push('paid-promotion');
  if (r.positionDisclosed) flags.push('position-disclosed');
  return flags;
}

// Stamp the evidence state from the skill model onto the registry (state is skill-owned).
function stampEvidenceState(registry, skillModel, { modelVersion = 'alerts-skill-v1' } = {}) {
  const reg = { ...(registry || {}) };
  const by = (skillModel && skillModel.byAccount) || {};
  for (const key of Object.keys(reg)) {
    const s = by[key];
    reg[key] = { ...reg[key], evidenceState: s ? s.state : 'UNKNOWN', performanceModelVersion: s ? modelVersion : null };
  }
  return reg;
}

module.exports = { foldRegistry, stampEvidenceState, MAX_ALIASES };

'use strict';
// COORDINATION & SATURATING SOURCE AGGREGATION — deterministic, order-invariant.
//
// The old ranker had two defects this module fixes:
//   1. "independent sources" counted distinct accounts as independent even when they posted
//      near-identical text — a copied pump looked like broad conviction. We now collapse
//      near-identical / linked / co-timed posts into DISTINCT TEXT CLUSTERS (not "independent
//      sources") and each cluster counts as ONE evidence unit.
//   2. Confirmation grew ~QUADRATICALLY with cluster count (1 + 0.5·(k−1)), which rewards
//      noise. We replace it with a BOUNDED, SATURATING accumulation
//      confirmation = 1 − ∏(1 − cappedContribution), each source capped and the whole
//      social component capped — applied ONLY after coordinated sources are collapsed.
//
// Determinism: the partition and every score are computed from post CONTENT + timestamps,
// never arrival order. Reversing the input list yields byte-identical output. The "original"
// of a copied cluster is the earliest VALID published post (content, not arrival) with a
// deterministic tie-break — never "whichever arrived first".

const CFG = {
  copySimilarity: 0.90,      // Jaccard ≥ this ⇒ near-identical text (same cluster)
  coordWindowMs: 60 * 60 * 1000,  // 60 min proximity window for co-timed coordination
  coordMinAccounts: 3,       // a cluster spanning ≥ this many accounts ⇒ suspected coordination
  sourceCap: 0.60,           // max single-source contribution to confirmation
  socialCap: 0.85,           // max value of the whole saturating social-confirmation component
};

// Deterministic, content-derived key for a post (NEVER its array index / arrival order).
function postKey(p) {
  if (p.postId) return `id:${p.postId}`;
  const acct = p.accountKey || p.handle || 'anon';
  return `h:${acct}:${p.contentHash || ''}`;
}

// ── Text similarity (token Jaccard on normalized text) ──
function normTokens(text) {
  return new Set(String(text || '').toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/[^a-z0-9$ ]/g, ' ').split(/\s+/).filter(Boolean));
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

const tsMs = p => { const t = Date.parse(p.publishedAt || ''); return Number.isNaN(t) ? null : t; };
const sharesAny = (a = [], b = []) => a.some(x => b.includes(x));

// Are two posts part of the same idea-cluster (copy / coordinated echo)? Symmetric ⇒
// the resulting partition is order-invariant.
function areCoordinated(a, b, simCache) {
  if (a.contentHash && a.contentHash === b.contentHash) return true;         // exact copy
  const ta = simCache.get(a), tb = simCache.get(b);
  const sim = jaccard(ta, tb);
  const ma = tsMs(a), mb = tsMs(b);
  const coTimed = ma != null && mb != null && Math.abs(ma - mb) <= CFG.coordWindowMs;
  if (sim >= CFG.copySimilarity) return true;                               // near-identical text
  if (a.quotedPostId && a.quotedPostId === b.quotedPostId) return true;      // echoing the same source
  const sharedMedia = sharesAny((a.media || []).map(m => m.hash).filter(Boolean), (b.media || []).map(m => m.hash).filter(Boolean));
  if (sharedMedia) return true;                                             // same image/video
  // Shared link + co-timed + moderately similar = a link-drop ring.
  if (coTimed && sim >= 0.5 && sharesAny(a.referencedDomains, b.referencedDomains)) return true;
  return false;
}

/**
 * Partition posts into distinct text clusters. Pure + order-invariant.
 * @returns {{clusters: object[], byKey: Map<string,string>}}
 *   each cluster: { id, memberKeys[], accounts[], size, original, originalUncertain,
 *                   coordinated, distinctAccounts }
 */
function clusterPosts(posts) {
  const list = (posts || []).filter(p => p && (p.text || p.contentHash));
  const simCache = new Map();
  for (const p of list) simCache.set(p, normTokens(p.text));

  // Union-find keyed by stable postKey (not index) so representatives don't depend on order.
  const parent = new Map();
  const find = k => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  for (const p of list) parent.set(postKey(p), postKey(p));

  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (areCoordinated(list[i], list[j], simCache)) {
        const a = find(postKey(list[i])), b = find(postKey(list[j]));
        if (a !== b) { const [lo, hi] = a < b ? [a, b] : [b, a]; parent.set(hi, lo); }  // deterministic union
      }
    }
  }

  const groups = new Map();
  for (const p of list) {
    const root = find(postKey(p));
    (groups.get(root) || groups.set(root, []).get(root)).push(p);
  }

  const clusters = [];
  const byKey = new Map();
  for (const [, members] of groups) {
    // Cluster id = smallest member key (stable, order-independent).
    const memberKeys = members.map(postKey).sort();
    const id = memberKeys[0];
    // Original = earliest VALID published (content-derived); tie-break by stable key.
    // NEVER arrival order. If none is validly timestamped, mark uncertain and pick smallest key.
    const timed = members.filter(m => tsMs(m) != null);
    let original, originalUncertain;
    if (timed.length) {
      original = timed.slice().sort((x, y) => (tsMs(x) - tsMs(y)) || (postKey(x) < postKey(y) ? -1 : 1))[0];
      originalUncertain = false;
    } else {
      original = members.slice().sort((x, y) => (postKey(x) < postKey(y) ? -1 : 1))[0];
      originalUncertain = true;
    }
    const accounts = [...new Set(members.map(m => m.accountKey || m.handle).filter(Boolean))].sort();
    const cluster = {
      id,
      memberKeys,
      size: members.length,
      accounts,
      distinctAccounts: accounts.length,
      originalKey: postKey(original),
      originalUncertain,
      coordinated: accounts.length >= CFG.coordMinAccounts,
    };
    clusters.push(cluster);
    for (const m of members) byKey.set(postKey(m), id);
  }
  clusters.sort((a, b) => (a.id < b.id ? -1 : 1));   // stable output ordering
  return { clusters, byKey };
}

// Per-source capped contribution to the saturating confirmation. `skillWeight` in [0,1] is
// the account's credible track-record trust (0 for unknown/unproven). Base credit is small
// and grows with proven skill, but is hard-capped so no single loud source dominates.
function sourceContribution(skillWeight = 0, { baseCredit = 0.12, skillCredit = 0.40 } = {}) {
  const raw = baseCredit + skillCredit * Math.max(0, Math.min(1, skillWeight));
  return Math.min(CFG.sourceCap, raw);
}

/**
 * Saturating social confirmation from a set of DISTINCT clusters (already collapsed).
 * confirmation = 1 − ∏(1 − cappedContribution), then capped at socialCap. Order-invariant
 * (multiplication commutes) and bounded (adding weak sources yields diminishing returns).
 *
 * @param {Array<{skillWeight:number, coordinated?:boolean}>} clusterContribs one per cluster
 * @param {object} opts { includeCoordinated:false } — coordinated clusters are collapsed to one
 *   unit and, by default, contribute 0 to FOLLOW confirmation (kept for grading elsewhere).
 */
function saturatingConfirmation(clusterContribs, { includeCoordinated = false } = {}) {
  let prod = 1;
  let counted = 0;
  for (const c of clusterContribs || []) {
    if (c.coordinated && !includeCoordinated) continue;   // collapsed; excluded from follow credit
    const contribution = sourceContribution(c.skillWeight);
    prod *= (1 - contribution);
    counted++;
  }
  const confirmation = counted ? Math.min(CFG.socialCap, 1 - prod) : 0;
  return { confirmation: +confirmation.toFixed(4), clustersCounted: counted };
}

module.exports = {
  CFG, postKey, jaccard, normTokens, areCoordinated, clusterPosts,
  sourceContribution, saturatingConfirmation,
};

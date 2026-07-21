'use strict';
// 📡 MARKET PULSE — storage (thin layer over lib/store's Blob helpers).
//
// Separation of concerns, one authoritative writer per artifact:
//   • pulse/latest.json      — the SERVING snapshot (kept as the legacy key). Writer: gather+refine.
//   • pulse/snap/<gen>.json  — IMMUTABLE per-generation archive (write-once, never overwritten).
//   • pulse/episodes.json    — narrative EPISODE ledger. Single writer: the refine pass.
//   • pulse/outcomes.json    — grader-OWNED forward outcomes + aggregate. Single writer: op=pulsegrade.
//
// Concurrency: a REFINEMENT may only overwrite latest when it refines the SAME generation
// (guarded in pulse-routes). Grading and ingestion touch different files, so they can never
// clobber each other. persisted:true is only claimed after a read-back confirms the write.

const { readJSON, writeJSON, hasStore } = require('./store');

const LATEST_KEY = 'pulse/latest.json';
const SNAP_PREFIX = 'pulse/snap/';
const EPISODES_KEY = 'pulse/episodes.json';
const OUTCOMES_KEY = 'pulse/outcomes.json';

const readLatest = () => readJSON(LATEST_KEY, null);
const writeLatest = doc => writeJSON(LATEST_KEY, doc, 0);   // no CDN cache — freshness matters

// Write-once immutable archive. Generations are unique, so this is idempotent.
const snapKey = gen => `${SNAP_PREFIX}${String(gen).replace(/[^0-9A-Za-z_-]/g, '')}.json`;
const writeSnapshot = (gen, doc) => writeJSON(snapKey(gen), doc, 31536000);   // 1y cache — immutable
const readSnapshot = gen => readJSON(snapKey(gen), null);

const readEpisodes = () => readJSON(EPISODES_KEY, { episodes: [], transitions: [] });
const writeEpisodes = doc => writeJSON(EPISODES_KEY, doc, 0);

const readOutcomes = () => readJSON(OUTCOMES_KEY, { outcomes: [], summary: null, gradedIds: [] });
const writeOutcomes = doc => writeJSON(OUTCOMES_KEY, doc, 0);

/**
 * Write `doc` to `key` then READ IT BACK and confirm `predicate(readBack)`. Returns true only
 * when the intended content is actually persisted — so callers never report persisted:true
 * merely because a Blob store exists. Failure-tolerant (returns false, never throws).
 */
async function writeVerified(key, doc, predicate, cacheMaxAge = 0) {
  if (!hasStore()) return false;
  try {
    await writeJSON(key, doc, cacheMaxAge);
    const back = await readJSON(key, null);
    return !!(back && (predicate ? predicate(back) : true));
  } catch { return false; }
}

module.exports = {
  LATEST_KEY, SNAP_PREFIX, EPISODES_KEY, OUTCOMES_KEY,
  readLatest, writeLatest, writeSnapshot, readSnapshot, snapKey,
  readEpisodes, writeEpisodes, readOutcomes, writeOutcomes,
  writeVerified, hasStore,
};

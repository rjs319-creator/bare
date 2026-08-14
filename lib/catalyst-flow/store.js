'use strict';
// CATALYST–FLOW — VERSIONED STORAGE (thin layer over lib/store Blob helpers).
//
// One authoritative writer per artifact, keyed so a re-run overwrites ITSELF and never
// read-modify-writes a shared document:
//
//   catalystflow/v1/predictions/<date>.json   daily prediction artifact; writer: the offline trainer publish step
//   catalystflow/v1/latest.json               pointer to the newest published artifact
//   catalystflow/v1/coverage.json             data-availability report (what is measurable today)
//   catalystflow/v1/trials.json               append-only trial registry mirror (research side is authoritative)
//
// With no Blob token the helpers degrade to null/[] and the serving layer reports
// UNAVAILABLE — the app still builds and serves every other tab.

const { readJSON, writeJSON, hasStore } = require('../store');

const PREFIX = 'catalystflow/v1/';
const PREDICTION_RE = /^catalystflow\/v1\/predictions\/\d{4}-\d{2}-\d{2}\.json$/;

const KEYS = Object.freeze({
  PREDICTION_PREFIX: `${PREFIX}predictions/`,
  LATEST: `${PREFIX}latest.json`,
  COVERAGE: `${PREFIX}coverage.json`,
  TRIALS: `${PREFIX}trials.json`,
});

const predictionKey = (date) => `${KEYS.PREDICTION_PREFIX}${date}.json`;

const readPrediction = (date) => readJSON(predictionKey(date), null);
const writePrediction = (date, doc) => writeJSON(predictionKey(date), { ...doc, savedAt: new Date().toISOString() }, 0);
const readLatest = () => readJSON(KEYS.LATEST, null);
const writeLatest = (doc) => writeJSON(KEYS.LATEST, { ...doc, savedAt: new Date().toISOString() }, 0);
const readCoverage = () => readJSON(KEYS.COVERAGE, null);
const writeCoverage = (doc) => writeJSON(KEYS.COVERAGE, { ...doc, savedAt: new Date().toISOString() }, 0);
const readTrials = () => readJSON(KEYS.TRIALS, null);

// List published prediction dates, newest first. Lazily requires @vercel/blob like every
// other store helper so a token-less environment degrades to [] rather than throwing.
async function listPredictionDates(limit = 60) {
  if (!hasStore()) return [];
  try {
    const { list } = require('@vercel/blob');
    const out = [];
    let cursor;
    do {
      const page = await list({ prefix: KEYS.PREDICTION_PREFIX, cursor, limit: 1000 });
      for (const b of page.blobs || []) if (PREDICTION_RE.test(b.pathname)) out.push(b.pathname.slice(KEYS.PREDICTION_PREFIX.length, -5));
      cursor = page.hasMore ? page.cursor : null;
    } while (cursor);
    return [...new Set(out)].sort().reverse().slice(0, limit);
  } catch { return []; }
}

module.exports = {
  KEYS, PREDICTION_RE, predictionKey, hasStore,
  readPrediction, writePrediction, readLatest, writeLatest,
  readCoverage, writeCoverage, readTrials, listPredictionDates,
};

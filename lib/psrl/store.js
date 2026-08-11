'use strict';
// PSRL Blob namespace (psrl/v1/). Day docs are keyed by date so a re-run
// overwrites ITSELF — idempotent by construction, no shared read-modify-write
// doc anywhere. Freshness-sensitive singletons write with cacheMaxAge 0
// (store.readJSON additionally cache-busts reads); immutable day docs get a
// 1-year TTL.

const S = require('../store');
const { STORE } = require('./config');

const readLatest = () => S.readJSON(STORE.latest, null);
const writeLatest = (doc) => S.writeJSON(STORE.latest, doc, 0);
const readLedger = () => S.readJSON(STORE.ledger, null);
const writeLedger = (doc) => S.writeJSON(STORE.ledger, doc, 0);
const readHealth = () => S.readJSON(STORE.health, null);
const writeHealth = (doc) => S.writeJSON(STORE.health, doc, 0);
const readResearch = () => S.readJSON(STORE.research, null);
const writeResearch = (doc) => S.writeJSON(STORE.research, doc, 0);
const writeDay = (date, doc) => S.writeJSON(STORE.dayKey(date), doc, 31536000);
const readDay = (date) => S.readJSON(STORE.dayKey(date), null);
const hasStore = () => S.hasStore();

module.exports = {
  readLatest, writeLatest, readLedger, writeLedger, readHealth, writeHealth,
  readResearch, writeResearch, writeDay, readDay, hasStore, STORE,
};

'use strict';
// Step 16 — build the AUTHORITATIVE research security master (secmaster-v3).
//   node research/16-secmaster-v3.js [--from <pitdata-v3-listings-export.json>]
//
// fwd-outcome-v3 refuses to confirm a delisting from a stale price tail; it
// needs a versioned master record with a confirmed delisting date + source +
// confirmation timestamp. This script builds that record set from either:
//   (a) --from <file> : an exported pit-data-v3 listing-shard dump
//                       ({ shards: { A: {listings:{...}}, … } }), or
//   (b) the FMP /stable delisted-companies + stock-list feeds (needs FMP_API_KEY).
// Without either input it FAILS CLOSED: it writes an explicit BLOCKED artifact
// and prints the deterministic migration commands. It never fabricates records
// and never touches secmaster.json (v1) or panel-features.json (v2).

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const OUT_PATH = path.join(DATA, 'secmaster-v3.json');
const BLOCKED_PATH = path.join(DATA, 'secmaster-v3.BLOCKED.json');
const VERSION = 'pit-secmaster-v3';

// PURE: pit-data-v3 listing shards → per-symbol master records. Only listings
// with a CONFIRMED delisting interval yield status 'delisted'; active listings
// carry observedActiveThrough (their latest active knownAt); everything else is
// 'unknown' and fails closed downstream.
function recordsFromV3Shards(shards) {
  const records = {};
  for (const shard of Object.values(shards || {})) {
    for (const l of Object.values((shard && shard.listings) || {})) {
      const delistIv = (l.status || []).find((iv) => iv.value === 'delisted' && iv.confirmation && iv.effectiveFrom);
      const activeIvs = (l.status || []).filter((iv) => iv.value === 'active');
      const rec = {
        listingId: l.listingId,
        masterVersion: VERSION,
        identityConfidence: l.identityConfidence || 'low',
        status: delistIv ? 'delisted' : (activeIvs.length ? 'active' : 'unknown'),
        observedActiveThrough: activeIvs.length
          ? Math.max(...activeIvs.map((iv) => Date.parse(iv.knownAt || 0) || 0)) : null,
        delisting: delistIv ? {
          date: delistIv.effectiveFrom,
          source: (delistIv.confirmation && delistIv.confirmation.source) || delistIv.source || null,
          confirmedAt: (delistIv.confirmation && delistIv.confirmation.recordedAt) || delistIv.knownAt || null,
          sourcePublishedAt: null,
          reason: (delistIv.confirmation && delistIv.confirmation.reason) || null,
          reasonCategory: (delistIv.confirmation && delistIv.confirmation.reasonCategory) || null,
          provenance: delistIv.provenance || null,
        } : null,
      };
      for (const a of l.aliases || []) {
        const sym = String(a.value || '').toUpperCase();
        if (!sym) continue;
        // Preserve competing candidates instead of silently overwriting: a
        // ticker claimed by two listings records BOTH and marks the conflict.
        if (records[sym] && records[sym].listingId !== rec.listingId) {
          records[sym] = { ...records[sym], status: 'unknown', conflict: true,
            candidates: [...new Set([...(records[sym].candidates || [records[sym].listingId]), rec.listingId])] };
        } else if (!records[sym]) {
          records[sym] = rec;
        }
      }
    }
  }
  return records;
}

function writeBlocked(reason) {
  const blocked = {
    status: 'blocked', version: VERSION, checkedAt: new Date().toISOString(), reason,
    migration: [
      'Run the pit-data-v3 collector to completion (op=pitdata&view=v3collect via the daily warm cron, or repeatedly with CRON_SECRET), then:',
      '  1. export the listing shards:   op=pitdata&view=v3export > research/data/pitdata-v3-listings.json',
      '  2. node research/16-secmaster-v3.js --from research/data/pitdata-v3-listings.json',
      '  3. node research/15-panel-features-v3.js',
      'OR with FMP_API_KEY set locally: node research/16-secmaster-v3.js (direct feed pull).',
    ],
  };
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(BLOCKED_PATH, JSON.stringify(blocked, null, 2));
  console.log(`BLOCKED: ${reason}`);
  for (const step of blocked.migration) console.log(step);
}

async function fetchFmpRecords(apiKey) {
  const base = 'https://financialmodelingprep.com/stable';
  const get = async (p, params = {}) => {
    const u = new URL(base + p);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    u.searchParams.set('apikey', apiKey);
    const r = await fetch(u);
    if (!r.ok) throw new Error(`${p} http ${r.status} — feed unavailable, NOT empty`);
    return r.json();
  };
  const records = {};
  const nowIso = new Date().toISOString();
  for (let page = 0; page < 200; page++) {
    const rows = await get('/delisted-companies', { page, limit: 100 });
    if (!Array.isArray(rows)) throw new Error('delisted-companies: non-array response');
    for (const row of rows) {
      if (!row || !row.symbol || !row.delistedDate) continue;
      records[String(row.symbol).toUpperCase()] = {
        listingId: `fmp-delist:${String(row.symbol).toUpperCase()}|${row.ipoDate || '?'}`,
        masterVersion: VERSION, identityConfidence: row.ipoDate ? 'medium-low' : 'low',
        status: 'delisted', observedActiveThrough: null,
        delisting: {
          date: row.delistedDate, source: 'fmp-delisted-companies',
          confirmedAt: nowIso, sourcePublishedAt: null,
          reason: null, reasonCategory: null, provenance: 'historical_reconstruction',
        },
      };
    }
    if (rows.length < 100) break;
  }
  const active = await get('/stock-list');
  if (!Array.isArray(active)) throw new Error('stock-list: non-array response');
  for (const row of active) {
    if (!row || !row.symbol) continue;
    const sym = String(row.symbol).toUpperCase();
    if (records[sym]) continue;   // a confirmed delisting outranks a current-list sighting
    records[sym] = {
      listingId: `fmp-active:${sym}`, masterVersion: VERSION, identityConfidence: 'low',
      status: 'active', observedActiveThrough: Date.now(), delisting: null,
    };
  }
  return records;
}

async function main() {
  const fromIdx = process.argv.indexOf('--from');
  const fromFile = fromIdx > -1 ? process.argv[fromIdx + 1] : null;
  let records = null, source = null;
  if (fromFile) {
    if (!fs.existsSync(fromFile)) return writeBlocked(`--from file not found: ${fromFile}`);
    const dump = JSON.parse(fs.readFileSync(fromFile, 'utf8'));
    records = recordsFromV3Shards(dump.shards || dump);
    source = `pitdata-v3-export:${path.basename(fromFile)}`;
  } else if (process.env.FMP_API_KEY) {
    records = await fetchFmpRecords(process.env.FMP_API_KEY);
    source = 'fmp-stable-direct';
  } else {
    return writeBlocked('no authoritative input: pass --from <pitdata-v3 export> or set FMP_API_KEY');
  }
  const delisted = Object.values(records).filter((r) => r.status === 'delisted').length;
  const out = {
    version: VERSION, builtAt: new Date().toISOString(), source,
    counts: { symbols: Object.keys(records).length, delisted },
    records,
  };
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out));
  if (fs.existsSync(BLOCKED_PATH)) fs.unlinkSync(BLOCKED_PATH);
  console.log(`secmaster-v3 built: ${out.counts.symbols} symbols, ${delisted} confirmed delistings (source ${source}).`);
}

module.exports = { VERSION, OUT_PATH, BLOCKED_PATH, recordsFromV3Shards };
if (require.main === module) main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

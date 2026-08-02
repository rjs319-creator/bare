'use strict';
// Step 16 — build the AUTHORITATIVE research security master (secmaster-v3).
//   node research/16-secmaster-v3.js [--from <pitdata-v3-listings-export.json>]
//                                    [--probe [--build]] [--refresh] [--skip-profiles]
//                                    [--skip-edgar] [--max-profiles N]
//
// fwd-outcome-v3 refuses to confirm a delisting from a stale price tail; it
// needs a versioned master record with a confirmed delisting date + source +
// confirmation timestamp. This script builds that record set from either:
//   (a) --from <file> : an exported pit-data-v3 listing-shard dump
//                       ({ shards: { A: {listings:{...}}, … } }), or
//   (b) the FMP /stable feeds (needs FMP_API_KEY in the environment; the key is
//       never written to any output, cache file or log line).
// Without either input it FAILS CLOSED: it writes an explicit BLOCKED artifact
// and prints the deterministic migration commands. It never fabricates records
// and never touches secmaster.json (v1) or panel-features.json (v2).
//
// FMP endpoint semantics (validated by --probe on 2026-08-02):
//   /delisted-companies    paged; {symbol, companyName, exchange, ipoDate, delistedDate};
//                          NO delisting reason is provided.
//   /stock-list            the full known-symbol space INCLUDING long-delisted
//                          names (e.g. DWA, JOY). It is NOT an active list.
//   /actively-trading-list the actual actively-trading set.
//   /symbol-change         ticker renames; history is SHALLOW (~3 months).
//   /mergers-acquisitions-latest  SEC S-4-sourced announcements with
//                          targetedSymbol + transactionDate + filing link.
//   /profile?symbol=       identity: cik, isin, cusip, exchange, ipoDate,
//                          isActivelyTrading, isEtf/isAdr/isFund.
//
// Reason classification is EVIDENCE-JOINED, never inferred from prices:
//   rename      — symbol-change row for the delisted ticker near the delist date
//   acquisition — M&A row targeting the ticker inside the announcement window
//   (otherwise) — reasonCategory null, verificationState 'unverified-reason';
//                 fwd-outcome-v3 fails closed on unknown reasons by default.
// A ticker that is BOTH delisted and actively trading is a relisting or a
// recycled ticker: status follows the CURRENT listing but the historical
// delisting moves to delistingHistory (never the delisting field), identity
// confidence drops, and the ambiguity is recorded explicitly.
//
// Resumability: every feed page / profile is cached one-file-per-call under
// research/data/secmaster-v3-cache/ with its retrievedAt; a rerun only fetches
// what is missing (--refresh discards the cache). The composed output is
// DETERMINISTIC given the cache: records are sorted, and builtAt is the max
// input retrievedAt — not the wall clock.

const fs = require('fs');
const path = require('path');
const edgar = require('./lib/edgar');

const DATA = path.join(__dirname, 'data');
const OUT_PATH = path.join(DATA, 'secmaster-v3.json');
const BLOCKED_PATH = path.join(DATA, 'secmaster-v3.BLOCKED.json');
const CACHE_DIR = path.join(DATA, 'secmaster-v3-cache');
const SYMBOLS_PATH = path.join(DATA, 'symbols.json');
const DEFAULT_EXPORT_PATH = path.join(DATA, 'pitdata-v3-listings.json');
const VERSION = 'pit-secmaster-v3';
const SCHEMA_VERSION = 'secmaster-v3.1';

const FMP_BASE = 'https://financialmodelingprep.com/stable';
const REQUEST_INTERVAL_MS = 230;          // ~260/min, under the 300/min plan limit
const MAX_RETRIES = 5;
const PAGE_LIMIT = 100;
const MAX_DELISTED_PAGES = 400;
const MAX_MA_PAGES = 150;
const MA_OLDEST_NEEDED = '2020-09-01';    // delistings from 2022 need announcements ≥ ~15 months back
const RENAME_WINDOW_DAYS = 45;            // symbol-change date vs delist date
const MA_LOOKBACK_DAYS = 450;             // announcement → completion window
const MA_LOOKAHEAD_DAYS = 45;
const DAY = 86400000;

// ── pit-data-v3 shard path (unchanged contract) ───────────────────────────────
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

// ── schema validation ─────────────────────────────────────────────────────────
const STATUSES = Object.freeze(['active', 'delisted', 'unknown']);
function validateRecord(rec) {
  const errors = [];
  if (!rec || typeof rec !== 'object') return { valid: false, errors: ['not an object'] };
  if (!rec.listingId) errors.push('listingId required');
  if (rec.masterVersion !== VERSION) errors.push(`masterVersion must be ${VERSION}`);
  if (!STATUSES.includes(rec.status)) errors.push(`status must be one of ${STATUSES.join('|')}`);
  if (rec.status === 'delisted') {
    const d = rec.delisting;
    if (!d || !d.date || !d.source || !(d.confirmedAt || d.sourcePublishedAt) || !d.provenance) {
      errors.push('status delisted requires a complete delisting confirmation (date, source, confirmedAt|sourcePublishedAt, provenance)');
    }
  }
  if (rec.delisting && rec.status === 'active') errors.push('active record must keep historical delistings in delistingHistory, not delisting');
  return { valid: errors.length === 0, errors };
}

// ── FMP fetch layer: rate-limited, cached, resumable ──────────────────────────
function makeFetcher(apiKey, { refresh = false } = {}) {
  let lastCall = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const redact = (s) => String(s).split(apiKey).join('[REDACTED]');
  async function rawGet(p, params = {}) {
    const wait = lastCall + REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const u = new URL(FMP_BASE + p);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    u.searchParams.set('apikey', apiKey);
    for (let attempt = 0; ; attempt++) {
      let res;
      try { res = await fetch(u); } catch (e) {
        if (attempt >= MAX_RETRIES) throw new Error(`${p}: network failure after ${attempt} retries — ${redact(e.message)}`);
        await sleep(500 * 2 ** attempt); continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= MAX_RETRIES) throw new Error(`${p} http ${res.status} after ${attempt} retries — feed unavailable, NOT empty`);
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`${p} http ${res.status} — feed unavailable, NOT empty`);
      return res.json();
    }
  }
  // One cache file per call: { endpoint, params, retrievedAt, rows }. Resume =
  // reuse existing files; --refresh refetches everything.
  async function cached(name, p, params = {}) {
    const f = path.join(CACHE_DIR, `${name}.json`);
    if (!refresh && fs.existsSync(f)) {
      try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* refetch corrupt file */ }
    }
    const rows = await rawGet(p, params);
    const doc = { endpoint: p, params, retrievedAt: new Date().toISOString(), rows };
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(doc));
    return doc;
  }
  return { rawGet, cached };
}

// ── pure composition: validated feed snapshots → master records ───────────────
const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ' ').replace(/\b(INC|CORP|CO|LTD|PLC|SA|NV|LLC|LP|HOLDINGS?|GROUP|COMPANY|COMMON|STOCK|CLASS [A-Z]|ORDINARY|SHARES?)\b/g, '').replace(/\s+/g, ' ').trim();

function composeFmpRecords({ delistedRows = [], activeSymbols = [], knownSymbols = [], symbolChanges = [], maRows = [], profiles = {}, retrievedAt = {} }) {
  const activeSet = new Set(activeSymbols.map((s) => String(s).toUpperCase()));
  const renameByOld = new Map();
  for (const c of symbolChanges) {
    if (c && c.oldSymbol) renameByOld.set(String(c.oldSymbol).toUpperCase(), c);
  }
  const maByTarget = new Map();
  for (const m of maRows) {
    if (!m || !m.targetedSymbol) continue;
    const k = String(m.targetedSymbol).toUpperCase();
    if (!maByTarget.has(k)) maByTarget.set(k, []);
    maByTarget.get(k).push(m);
  }
  const activeRetrievedMs = Date.parse(retrievedAt.active || 0) || null;
  const symbolChangeSpan = symbolChanges.length ? {
    from: symbolChanges.reduce((a, c) => (c.date < a ? c.date : a), symbolChanges[0].date),
    to: symbolChanges.reduce((a, c) => (c.date > a ? c.date : a), symbolChanges[0].date),
  } : null;

  // Delisting-reason classification: evidence joins only, never price inference.
  function classifyReason(sym, delistedDate) {
    const delistMs = Date.parse(delistedDate);
    const rn = renameByOld.get(sym);
    if (rn && Number.isFinite(delistMs) && Math.abs(Date.parse(rn.date) - delistMs) <= RENAME_WINDOW_DAYS * DAY) {
      return { reasonCategory: 'rename', reason: `ticker change ${sym} → ${rn.newSymbol} (${rn.date})`,
        evidence: { type: 'fmp-symbol-change', newSymbol: rn.newSymbol, date: rn.date }, verificationState: 'verified-rename' };
    }
    const deals = maByTarget.get(sym) || [];
    for (const deal of deals) {
      const tMs = Date.parse(deal.transactionDate);
      if (!Number.isFinite(tMs) || !Number.isFinite(delistMs)) continue;
      if (delistMs - tMs >= -MA_LOOKAHEAD_DAYS * DAY && delistMs - tMs <= MA_LOOKBACK_DAYS * DAY) {
        return { reasonCategory: 'acquisition', reason: `acquired by ${deal.companyName || deal.symbol || 'unknown acquirer'} (S-4 ${deal.transactionDate})`,
          evidence: { type: 'sec-s4-via-fmp', acquirer: deal.symbol || null, acquirerCik: deal.cik || null, transactionDate: deal.transactionDate, link: deal.link || null },
          verificationState: 'verified-acquisition-announcement' };
      }
    }
    return { reasonCategory: null, reason: null, evidence: null, verificationState: 'unverified-reason' };
  }

  function identityFor(sym, fallbackName, fallbackExchange, fallbackIpo, { useProfile = true } = {}) {
    const pr = useProfile ? (profiles[sym] || null) : null;
    const cik = (pr && pr.cik) || null;
    const cusip = (pr && pr.cusip) || null;
    const listingId = cusip ? `fmp:cusip:${cusip}`
      : cik ? `fmp:cik:${cik}:${sym}`               // symbol suffix: share classes NEVER merge on CIK alone
        : `fmp:sym:${sym}|ipo:${(pr && pr.ipoDate) || fallbackIpo || '?'}`;
    return {
      listingId,
      issuer: { cik, companyName: (pr && pr.companyName) || fallbackName || null },
      security: pr ? { isin: pr.isin || null, cusip, isEtf: !!pr.isEtf, isAdr: !!pr.isAdr, isFund: !!pr.isFund } : null,
      exchange: (pr && pr.exchange) || fallbackExchange || null,
      listingDate: (pr && pr.ipoDate) || fallbackIpo || null,
      profile: pr,
    };
  }

  const draft = new Map();   // sym → mutable draft assembled below, emitted immutably at the end

  // 1) confirmed delistings (latest date wins; earlier ones become history)
  const byLatest = new Map();
  for (const row of delistedRows) {
    if (!row || !row.symbol || !row.delistedDate) continue;
    const sym = String(row.symbol).toUpperCase();
    const prev = byLatest.get(sym);
    if (!prev || row.delistedDate > prev.row.delistedDate) {
      byLatest.set(sym, { row, prior: prev ? [...prev.prior, prev.row] : [] });
    } else {
      byLatest.set(sym, { row: prev.row, prior: [...prev.prior, row] });
    }
  }
  for (const [sym, { row, prior }] of byLatest) {
    const cls = classifyReason(sym, row.delistedDate);
    // If the ticker is simultaneously actively trading, today's profile
    // describes the CURRENT holder of the recycled ticker — never attribute
    // its identity (name, CUSIP, CIK) to the dead listing.
    const id = identityFor(sym, row.companyName, row.exchange, row.ipoDate, { useProfile: !activeSet.has(sym) });
    draft.set(sym, {
      base: id, sym,
      status: 'delisted',
      observedActiveThrough: null,
      delisting: {
        date: row.delistedDate, source: 'fmp-delisted-companies',
        confirmedAt: retrievedAt.delisted || null, sourcePublishedAt: null,
        reason: cls.reason, reasonCategory: cls.reasonCategory,
        provenance: 'historical_reconstruction', evidence: cls.evidence,
      },
      identityConfidence: cls.reasonCategory ? 'medium' : (row.ipoDate ? 'medium-low' : 'low'),
      verificationState: cls.verificationState,
      priorDelistings: prior.length ? prior.map((p) => ({ date: p.delistedDate, exchange: p.exchange || null })) : null,
      tickerHistory: cls.reasonCategory === 'rename' && cls.evidence
        ? [{ ticker: sym, to: cls.evidence.date }, { ticker: cls.evidence.newSymbol, from: cls.evidence.date }]
        : null,
    });
  }

  // 2) actively-trading names; a symbol in BOTH sets is a relisting or a
  //    recycled ticker — the historical delisting is preserved as history but
  //    never as a live confirmation, and identity confidence drops.
  for (const sym of [...activeSet].sort()) {
    const id = identityFor(sym, null, null, null);
    const existing = draft.get(sym);
    if (existing) {
      const sameIssuer = id.issuer.companyName && existing.base.issuer.companyName
        && norm(id.issuer.companyName) === norm(existing.base.issuer.companyName);
      draft.set(sym, {
        base: id, sym,
        status: 'active',
        observedActiveThrough: activeRetrievedMs,
        delisting: null,
        delistingHistory: [existing.delisting],
        relisting: sameIssuer ? 'relisted-same-issuer' : 'ambiguous-relisting-or-ticker-reuse',
        identityConfidence: 'low',
        verificationState: sameIssuer ? 'relisting-name-matched' : 'ambiguous-recycled-ticker',
      });
    } else {
      draft.set(sym, {
        base: id, sym,
        status: 'active',
        observedActiveThrough: activeRetrievedMs,
        delisting: null,
        identityConfidence: id.issuer.cik ? 'medium' : 'low',
        verificationState: id.issuer.cik ? 'profile-verified' : 'list-membership-only',
      });
    }
  }

  // 3) known to the vendor but neither active nor delisted: an explicit vendor
  //    gap / inactive-unconfirmed record. Fails closed downstream (unknown).
  for (const symRaw of knownSymbols) {
    const sym = String(symRaw || '').toUpperCase();
    if (!sym || draft.has(sym)) continue;
    const id = identityFor(sym, null, null, null);
    draft.set(sym, {
      base: id, sym,
      status: 'unknown',
      observedActiveThrough: null,
      delisting: null,
      identityConfidence: 'low',
      verificationState: 'vendor-gap-or-inactive-unconfirmed',
    });
  }

  // 4) profile cross-checks + share-class siblings by CIK (never merged)
  const symsByCik = new Map();
  for (const [sym, d] of draft) {
    const cik = d.base.issuer.cik;
    if (!cik) continue;
    if (!symsByCik.has(cik)) symsByCik.set(cik, []);
    symsByCik.get(cik).push(sym);
  }

  const records = {};
  for (const sym of [...draft.keys()].sort()) {
    const d = draft.get(sym);
    const pr = d.base.profile;
    let status = d.status, verificationState = d.verificationState, conflict;
    if (pr && typeof pr.isActivelyTrading === 'boolean') {
      const profSaysActive = pr.isActivelyTrading;
      if (status === 'active' && !profSaysActive) { status = 'unknown'; verificationState = 'conflict:active-list-vs-profile-inactive'; conflict = true; }
      if (status === 'delisted' && profSaysActive) { status = 'unknown'; verificationState = 'conflict:delisted-vs-profile-active'; conflict = true; }
    }
    const siblings = d.base.issuer.cik ? (symsByCik.get(d.base.issuer.cik) || []).filter((s) => s !== sym) : [];
    records[sym] = {
      schemaVersion: SCHEMA_VERSION,
      listingId: d.base.listingId,
      masterVersion: VERSION,
      symbol: sym,
      issuer: d.base.issuer,
      security: d.base.security,
      exchange: d.base.exchange,
      listingDate: d.base.listingDate,
      status,
      observedActiveThrough: d.observedActiveThrough,
      delisting: status === 'delisted' ? d.delisting : null,
      ...(status !== 'delisted' && d.delisting ? { delistingHistory: [d.delisting] } : {}),
      ...(d.delistingHistory ? { delistingHistory: d.delistingHistory } : {}),
      ...(d.priorDelistings ? { priorDelistings: d.priorDelistings } : {}),
      ...(d.tickerHistory ? { tickerHistory: d.tickerHistory } : {}),
      ...(d.relisting ? { relisting: d.relisting } : {}),
      ...(siblings.length ? { shareClassSiblings: siblings } : {}),
      ...(conflict ? { conflict: true } : {}),
      identityConfidence: d.identityConfidence,
      verificationState,
    };
  }
  return { records, meta: { symbolChangeSpan, retrievedAt } };
}

// ── two-source merge: PATH A (pitdata-v3, prospective) ⊕ FMP/EDGAR (historical)
// The prospective PIT store is the higher-provenance source going FORWARD (its
// records carry knownAt timestamps and confirmed intervals) but it has only
// been collecting since 2026-08 — it is nearly empty of HISTORICAL delistings.
// The FMP+EDGAR reconstruction supplies history. Merge policy (documented,
// deterministic):
//   * a PATH-A confirmed delisting always wins (prospective confirmation);
//     FMP/EDGAR identity enrichment (issuer/security/exchange) is retained.
//   * a reconstruction delisting BEATS a PATH-A 'active' claim. Validated
//     2026-08-02: the collector's listing intervals derive from the FMP
//     stock-list, which contains long-dead names — its 'active' is membership,
//     not trading. The reconstruction's 'delisted' already encodes "absent
//     from the actively-trading list AND confirmed by delisted-feed/EDGAR
//     evidence", so it is strictly better informed. The shard's contrary claim
//     is preserved on the record (shardClaimedActive) for audit.
//   * genuine relistings are unaffected: compose() already turned
//     "delisted + actively trading now" into an active record with
//     delistingHistory before the merge sees it.
//   * where PATH A is unknown/absent, the FMP/EDGAR record stands; PATH-A
//     alias conflicts stay fail-closed.
//   * listingId prefers the PATH-A id (it joins the append-only alias index);
//     the FMP identity id is kept as fmpListingId for cross-reference.
function mergeRecords(shardRecords, fmpRecords) {
  const out = {};
  const syms = [...new Set([...Object.keys(shardRecords), ...Object.keys(fmpRecords)])].sort();
  const stats = { shardOnly: 0, fmpOnly: 0, both: 0, shardDelistWins: 0, delistOverShardActive: 0, fmpFillsUnknown: 0 };
  for (const sym of syms) {
    const a = shardRecords[sym] || null;
    const b = fmpRecords[sym] || null;
    if (a && !b) { out[sym] = a; stats.shardOnly++; continue; }
    if (!a && b) { out[sym] = b; stats.fmpOnly++; continue; }
    stats.both++;
    const identity = {
      issuer: (b.issuer && b.issuer.cik) ? b.issuer : (b.issuer || null),
      security: b.security || null,
      exchange: b.exchange || null,
      listingDate: b.listingDate || null,
      fmpListingId: b.listingId,
    };
    if (a.status === 'delisted') {
      out[sym] = { ...b, ...a, ...identity, schemaVersion: SCHEMA_VERSION, symbol: sym,
        verificationState: 'merged:pitdata-v3-confirmed-delisting' };
      stats.shardDelistWins++;
    } else if (a.status === 'active') {
      if (b.status === 'delisted') {
        // Reconstruction delisting over shard 'active' (stock-list semantics
        // defect — see merge policy above). The shard claim is auditable.
        out[sym] = { ...b, schemaVersion: SCHEMA_VERSION, symbol: sym,
          shardClaimedActive: a.observedActiveThrough || true,
          verificationState: 'merged:reconstruction-delisting-over-shard-active' };
        stats.delistOverShardActive++;
      } else {
        out[sym] = {
          ...b, schemaVersion: SCHEMA_VERSION, symbol: sym,
          listingId: a.listingId, ...identity,
          status: b.status === 'unknown' ? 'unknown' : 'active',
          observedActiveThrough: Math.max(a.observedActiveThrough || 0, b.observedActiveThrough || 0) || null,
          identityConfidence: a.identityConfidence === 'medium' || b.identityConfidence === 'medium' ? 'medium' : b.identityConfidence,
        };
      }
    } else {
      // PATH A unknown (incl. its alias conflicts) → the reconstruction stands,
      // but a PATH-A alias conflict is preserved (it fails closed downstream).
      out[sym] = a.conflict
        ? { ...b, schemaVersion: SCHEMA_VERSION, symbol: sym, status: 'unknown', conflict: true,
            candidates: a.candidates || null, verificationState: 'merged:pitdata-v3-alias-conflict' }
        : { ...b, schemaVersion: SCHEMA_VERSION, symbol: sym };
      if (b.status !== 'unknown' && !a.conflict) stats.fmpFillsUnknown++;
    }
  }
  return { records: out, stats };
}

// ── blocked artifact ──────────────────────────────────────────────────────────
function writeBlocked(reason) {
  const blocked = {
    status: 'blocked', version: VERSION, checkedAt: new Date().toISOString(), reason,
    migration: [
      'PATH A (preferred, prospective PIT source) — pit-data-v3 listing export:',
      '  1. let the daily warm cron run op=pitdata&view=v3collect to completion (or drive it with CRON_SECRET),',
      '  2. export the listing shards (trusted/cron auth required):',
      '       curl -H "authorization: Bearer $CRON_SECRET" "$APP/api/tracker?op=pitdata&view=v3export" > research/data/pitdata-v3-listings.json',
      '  3. node research/16-secmaster-v3.js --from research/data/pitdata-v3-listings.json',
      '  4. node research/15-panel-features-v3.js',
      'PATH B (historical reconstruction) — direct FMP pull:',
      '  1. put FMP_API_KEY in research/.env (never commit it),',
      '  2. node --env-file=research/.env research/16-secmaster-v3.js       # cached+resumable; rerun to resume',
      '     (add --probe first to validate endpoint semantics on a 5-row sample)',
      '  3. node research/15-panel-features-v3.js',
      'The two paths may both be run; PATH A records carry prospective provenance and win on conflicts.',
    ],
  };
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(BLOCKED_PATH, JSON.stringify(blocked, null, 2));
  console.log(`BLOCKED: ${reason}`);
  for (const step of blocked.migration) console.log(step);
}

// ── FMP orchestration ─────────────────────────────────────────────────────────
async function probeFmp(fetcher) {
  const d = await fetcher.rawGet('/delisted-companies', { page: 0, limit: 5 });
  if (!Array.isArray(d) || !d.length || !d[0].symbol || !d[0].delistedDate) {
    throw new Error('probe: /delisted-companies did not return [{symbol, delistedDate, …}]');
  }
  const a = await fetcher.rawGet('/actively-trading-list');
  if (!Array.isArray(a) || a.length < 1000) throw new Error('probe: /actively-trading-list implausibly small');
  const p = await fetcher.rawGet('/profile', { symbol: 'AAPL' });
  const prof = Array.isArray(p) ? p[0] : null;
  if (!prof || typeof prof.isActivelyTrading !== 'boolean' || !prof.cik) {
    throw new Error('probe: /profile missing isActivelyTrading/cik — identity enrichment unavailable');
  }
  console.log(`probe OK: delisted sample ${d.length} rows (${d[0].symbol} ${d[0].delistedDate}), active list ${a.length} rows, profile carries cik/cusip/isActivelyTrading.`);
  return true;
}

async function fetchFmpInputs(fetcher, { skipProfiles = false, maxProfiles = Infinity } = {}) {
  const retrievedAt = {};
  const coverageLimitations = [];
  const delistedRows = [];
  for (let page = 0; page < MAX_DELISTED_PAGES; page++) {
    let doc;
    try {
      doc = await fetcher.cached(`delisted-page-${String(page).padStart(3, '0')}`, '/delisted-companies', { page, limit: PAGE_LIMIT });
    } catch (e) {
      // Plan gate (validated 2026-08-02): /delisted-companies returns 402 for
      // page ≥ 1 on this plan — only the ~100 most-recent delistings are
      // visible. That is a COVERAGE limitation, recorded — never fatal and
      // never silently papered over. Historical delistings must come from the
      // pitdata-v3 export or the EDGAR enrichment joins.
      if (/http 402/.test(e.message)) {
        coverageLimitations.push({
          source: 'fmp-delisted-companies',
          limitation: `plan-gated at page ${page}: only pages 0..${page - 1} (~${delistedRows.length} most-recent delistings) available`,
          consequence: 'historical delistings absent from this feed; symbols delisted earlier fail closed as unknown unless confirmed by another authoritative source',
        });
        break;
      }
      throw e;
    }
    if (!Array.isArray(doc.rows)) throw new Error('delisted-companies: non-array response');
    retrievedAt.delisted = doc.retrievedAt;
    delistedRows.push(...doc.rows);
    if (doc.rows.length < PAGE_LIMIT) break;
  }
  const activeDoc = await fetcher.cached('actively-trading', '/actively-trading-list');
  if (!Array.isArray(activeDoc.rows)) throw new Error('actively-trading-list: non-array response');
  retrievedAt.active = activeDoc.retrievedAt;
  const knownDoc = await fetcher.cached('stock-list', '/stock-list');
  if (!Array.isArray(knownDoc.rows)) throw new Error('stock-list: non-array response');
  retrievedAt.known = knownDoc.retrievedAt;
  const scDoc = await fetcher.cached('symbol-change', '/symbol-change');
  retrievedAt.symbolChange = scDoc.retrievedAt;
  const maRows = [];
  for (let page = 0; page < MAX_MA_PAGES; page++) {
    const doc = await fetcher.cached(`ma-page-${String(page).padStart(3, '0')}`, '/mergers-acquisitions-latest', { page, limit: PAGE_LIMIT });
    if (!Array.isArray(doc.rows) || !doc.rows.length) break;
    retrievedAt.ma = doc.retrievedAt;
    maRows.push(...doc.rows);
    const oldest = doc.rows[doc.rows.length - 1].transactionDate || '';
    if (doc.rows.length < PAGE_LIMIT || (oldest && oldest < MA_OLDEST_NEEDED)) break;
  }
  // Identity enrichment is scoped to the research universe: profiles are one
  // call per symbol, so enriching all ~38k vendor symbols would be waste.
  const profiles = {};
  if (!skipProfiles && fs.existsSync(SYMBOLS_PATH)) {
    const universe = Object.keys(JSON.parse(fs.readFileSync(SYMBOLS_PATH, 'utf8')).symbols || {}).map((s) => s.toUpperCase()).sort();
    let fetched = 0;
    for (const sym of universe) {
      if (fetched >= maxProfiles) break;
      const safe = sym.replace(/[^A-Z0-9.-]/g, '_');
      const wasCached = fs.existsSync(path.join(CACHE_DIR, 'profiles', `${safe}.json`));
      const doc = await fetcher.cached(path.join('profiles', safe), '/profile', { symbol: sym });
      const row = Array.isArray(doc.rows) ? doc.rows[0] : null;
      if (row && row.symbol) profiles[sym] = row;
      if (!wasCached && ++fetched % 250 === 0) console.log(`  profiles: ${fetched} fetched (${sym})…`);
    }
    console.log(`profiles: ${Object.keys(profiles).length} of ${universe.length} universe symbols enriched.`);
  }
  return { delistedRows, activeSymbols: activeDoc.rows.map((r) => r.symbol), knownSymbols: knownDoc.rows.map((r) => r.symbol), symbolChanges: Array.isArray(scDoc.rows) ? scDoc.rows : [], maRows, profiles, retrievedAt, coverageLimitations };
}

// ── main ──────────────────────────────────────────────────────────────────────
function writeMaster(records, source, retrievedAt, extraMeta = {}) {
  const invalid = [];
  for (const [sym, rec] of Object.entries(records)) {
    const v = validateRecord(rec);
    if (!v.valid) invalid.push({ sym, errors: v.errors });
  }
  if (invalid.length) {
    throw new Error(`schema validation failed for ${invalid.length} records — first: ${JSON.stringify(invalid[0])}`);
  }
  const counts = {
    symbols: Object.keys(records).length,
    active: Object.values(records).filter((r) => r.status === 'active').length,
    delisted: Object.values(records).filter((r) => r.status === 'delisted').length,
    unknown: Object.values(records).filter((r) => r.status === 'unknown').length,
    delistedWithReason: Object.values(records).filter((r) => r.delisting && r.delisting.reasonCategory).length,
    acquisitions: Object.values(records).filter((r) => r.delisting && r.delisting.reasonCategory === 'acquisition').length,
    renames: Object.values(records).filter((r) => r.delisting && r.delisting.reasonCategory === 'rename').length,
    relistedOrRecycled: Object.values(records).filter((r) => r.relisting).length,
    conflicts: Object.values(records).filter((r) => r.conflict).length,
  };
  const builtAt = Object.values(retrievedAt || {}).filter(Boolean).sort().pop() || new Date().toISOString();
  const out = { version: VERSION, schemaVersion: SCHEMA_VERSION, builtAt, source, counts, meta: extraMeta, records };
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out));
  if (fs.existsSync(BLOCKED_PATH)) fs.unlinkSync(BLOCKED_PATH);
  console.log(`secmaster-v3 built: ${counts.symbols} symbols — ${counts.active} active, ${counts.delisted} delisted (${counts.delistedWithReason} with verified reason: ${counts.acquisitions} acquisitions, ${counts.renames} renames), ${counts.unknown} unknown, ${counts.relistedOrRecycled} relisted/recycled, ${counts.conflicts} conflicts (source ${source}).`);
  return out;
}

async function main() {
  const argv = process.argv;
  const fromIdx = argv.indexOf('--from');
  const fromFile = fromIdx > -1 ? argv[fromIdx + 1] : null;
  const maxProfIdx = argv.indexOf('--max-profiles');
  const opts = {
    probe: argv.includes('--probe'),
    refresh: argv.includes('--refresh'),
    skipProfiles: argv.includes('--skip-profiles'),
    skipEdgar: argv.includes('--skip-edgar'),
    maxProfiles: maxProfIdx > -1 ? Number(argv[maxProfIdx + 1]) : Infinity,
  };
  // PATH A input: an explicit --from file, or the default export location if
  // present (the daily collector's listing dump).
  const exportPath = fromFile || (fs.existsSync(DEFAULT_EXPORT_PATH) ? DEFAULT_EXPORT_PATH : null);
  if (fromFile && !fs.existsSync(fromFile)) return writeBlocked(`--from file not found: ${fromFile}`);
  let shardRecords = null, exportedAt = null;
  if (exportPath) {
    const dump = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
    shardRecords = recordsFromV3Shards(dump.shards || dump);
    exportedAt = dump.exportedAt || null;
    // Shard records are minimal (no issuer/security block) — schema-validate
    // only the fields they carry.
    for (const rec of Object.values(shardRecords)) { rec.schemaVersion = SCHEMA_VERSION; rec.symbol = rec.symbol || null; }
  }
  if (!process.env.FMP_API_KEY) {
    if (shardRecords) {
      return writeMaster(shardRecords, `pitdata-v3-export:${path.basename(exportPath)}`,
        { export: exportedAt }, { exportedAt });
    }
    return writeBlocked('no authoritative input: pass --from <pitdata-v3 export> or set FMP_API_KEY');
  }
  const fetcher = makeFetcher(process.env.FMP_API_KEY, { refresh: opts.refresh });
  if (opts.probe) { await probeFmp(fetcher); if (!argv.includes('--build')) return; }
  const inputs = await fetchFmpInputs(fetcher, opts);
  const composed = composeFmpRecords(inputs);
  let records = composed.records;
  const coverageLimitations = [...(inputs.coverageLimitations || [])];
  let edgarStats = null;
  // EDGAR enrichment closes the FMP plan gate for the research universe:
  // Form 25/25-NSE confirms historical delistings; 8-K items 1.03/2.01
  // classify bankruptcy vs acquisition. Regulatory provenance, no price
  // inference. Scoped to non-actively-trading universe symbols with a CIK.
  if (!opts.skipEdgar && fs.existsSync(SYMBOLS_PATH)) {
    const universe = Object.keys(JSON.parse(fs.readFileSync(SYMBOLS_PATH, 'utf8')).symbols || {}).map((s) => s.toUpperCase());
    const enriched = await edgar.enrichRecords(records, universe, CACHE_DIR, { refresh: opts.refresh, log: console.log });
    records = enriched.records;
    edgarStats = enriched.stats;
    if (enriched.stats.noCik) {
      coverageLimitations.push({
        source: 'sec-edgar-submissions',
        limitation: `${enriched.stats.noCik} inactive universe symbols have no CIK (no profile identity) — EDGAR lookup impossible`,
        consequence: 'those symbols stay unknown and fail closed',
      });
    }
    coverageLimitations.push({
      source: 'sec-edgar-submissions',
      limitation: 'bank registrants (FDIC-supervised, e.g. FRC) and non-SEC filers do not file Form 25 with EDGAR',
      consequence: 'their delistings stay unconfirmed (unknown, fail closed) unless another authoritative source covers them',
    });
  }
  let source = 'fmp-stable-direct+sec-edgar';
  let mergeStats = null;
  if (shardRecords) {
    const merged = mergeRecords(shardRecords, records);
    records = merged.records;
    mergeStats = merged.stats;
    source = `pitdata-v3-export:${path.basename(exportPath)}+fmp-stable-direct+sec-edgar`;
  }
  return writeMaster(records, source, inputs.retrievedAt,
    { ...composed.meta, coverageLimitations, edgarStats, mergeStats, exportedAt });
}

module.exports = {
  VERSION, SCHEMA_VERSION, OUT_PATH, BLOCKED_PATH, CACHE_DIR, DEFAULT_EXPORT_PATH,
  recordsFromV3Shards, composeFmpRecords, validateRecord, mergeRecords,
};
if (require.main === module) main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

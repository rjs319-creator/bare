// Point-in-time security master (secmaster-v1).
//
// WHY: the app resolves a ticker's sector/identity from live, MUTABLE sources
// (lib/universe.js SECTOR_OF, the expanded-universe blobs). That answers "what is
// AAPL today?" but not "was this symbol listed, and what was it, AS OF 2023-04?".
// Backtests that ignore that conflate a delisted name's gap with survivorship, and
// a reused ticker (a symbol reassigned to a different company after a delisting)
// silently merges two securities. A security master fixes identity in time.
//
// HONEST SCOPE: this is a free-data app — there are NO CUSIP/FIGI feeds, so we do
// NOT fabricate cross-vendor identifiers. The canonical id is the Yahoo symbol; what
// we add is the point-in-time metadata that actually removes bias: listing STATUS
// (active vs removed, with removal date from lib/constituents.js), FIRST/LAST-SEEN
// dates (observed from the app's own ledger, so "known since"), and sector. A symbol
// resolved for an as-of date returns its status THEN, not just now.
//
// The resolution core (buildMaster/resolveAsOf/universeAtFrom) is pure and
// unit-testable; the Blob-backed builder/reader degrade to safe defaults with no store.
const { readJSON, writeJSON } = require('./store');

const SECMASTER_VERSION = 'secmaster-v1';
const MASTER_PATH = 'secmaster/master.json';   // { v, builtAt, count, records: { SYM: {...} } }
const FAR_FUTURE = '9999-12-31';

function hasStore() { return !!process.env.BLOB_READ_WRITE_TOKEN; }

// Merge the available identity sources into a { SYM: record } map (pure).
//   sectorOf     : { SYM: sector }                         (lib/universe.js SECTOR_OF)
//   knownSymbols : string[] currently-tradeable symbols    (LARGE/SMALL/MICRO/BIOTECH ∪ expanded)
//   removed      : [{ ticker, removedDate }]               (lib/constituents.fetchRemovedConstituents)
//   observed     : { SYM: { firstSeen, lastSeen } }        (from the app's own pick ledger)
// Later a symbol can be BOTH currently-known and previously-removed (re-listed / class
// change); status reflects the removal only when it has no live listing afterward, so
// a symbol present in knownSymbols is 'active' regardless of an older removal record.
function buildMaster({ sectorOf = {}, knownSymbols = [], removed = [], observed = {} } = {}) {
  const records = {};
  const upsert = (symbol) => {
    if (!symbol) return null;
    if (!records[symbol]) {
      records[symbol] = {
        symbol,
        securityId: symbol,                 // canonical id == Yahoo symbol (no CUSIP/FIGI feed)
        sector: sectorOf[symbol] || null,
        status: 'active',
        firstSeen: null,
        lastSeen: null,
        removedDate: null,
        sources: [],
      };
    }
    return records[symbol];
  };

  for (const s of knownSymbols) { const r = upsert(s); if (r && !r.sources.includes('universe')) r.sources.push('universe'); }

  for (const { ticker, removedDate } of removed) {
    const r = upsert(ticker);
    if (!r) continue;
    if (!r.sources.includes('constituents')) r.sources.push('constituents');
    // Only mark removed if it is NOT in the live known set — a still-known symbol with
    // an old removal is a re-add, and should read active with its removal recorded.
    if (!knownSymbols.includes(ticker)) { r.status = 'removed'; r.removedDate = removedDate || null; }
    else if (!r.removedDate) { r.priorRemoval = removedDate || null; }
  }

  for (const [symbol, o] of Object.entries(observed)) {
    const r = upsert(symbol);
    if (!r || !o) continue;
    if (!r.sources.includes('ledger')) r.sources.push('ledger');
    if (o.firstSeen && (!r.firstSeen || o.firstSeen < r.firstSeen)) r.firstSeen = o.firstSeen;
    if (o.lastSeen && (!r.lastSeen || o.lastSeen > r.lastSeen)) r.lastSeen = o.lastSeen;
  }

  return records;
}

// Resolve one record's status AS OF a date (pure).
//
// ACTIVE is driven ONLY by removal (delisting): this app has no listing-inception /
// IPO feed, so firstSeen is a "known SINCE" date (first ledger appearance), NOT a
// listing date. Gating active on it would falsely drop a long-listed name (AAPL)
// from an old universe just because our ledger started recently. So active == not
// yet removed; firstSeen is reported as `knownAsOf` (did OUR record already know it),
// never used to claim a security was unlisted. This corrects DELISTING survivorship,
// and is honestly silent about late LISTINGS it has no data to detect.
function resolveAsOf(record, asOf) {
  if (!record) return { found: false, symbol: null, status: 'unknown', active: null, knownAsOf: false, reason: 'not-in-master' };
  const date = asOf || FAR_FUTURE;
  const removed = record.removedDate && date >= record.removedDate;
  const bornKnown = record.firstSeen ? date >= record.firstSeen : null;   // null = firstSeen unknown
  const active = !removed;
  return {
    found: true,
    symbol: record.symbol,
    securityId: record.securityId,
    sector: record.sector || null,
    status: removed ? 'removed' : record.status,
    active,
    knownAsOf: bornKnown === null ? null : bornKnown,
    firstSeen: record.firstSeen || null,
    lastSeen: record.lastSeen || null,
    removedDate: record.removedDate || null,
    asOf: date === FAR_FUTURE ? null : date,
  };
}

// The set of symbols that were ACTIVE (i.e. NOT yet removed) as of a date (pure).
// Corrects delisting survivorship; does not attempt to exclude late listings (no feed).
function universeAtFrom(records, date) {
  const out = [];
  for (const r of Object.values(records || {})) {
    const res = resolveAsOf(r, date);
    if (res.active) out.push(r.symbol);
  }
  return out.sort();
}

// De-survivorship augmentation (pure). A present-day static list silently DROPS names that were
// tradeable during a backtest window but have since delisted — the "survivors that died" — which
// inflates any backtest run on it. Given the master records, that static list, and an as-of date,
// return the static list UNION the securities that were ACTIVE as of `asOf` but are NO LONGER active
// today (delisted since). That is exactly `universeAtFrom(asOf) \ universeAtFrom(today)`, restricted
// to names not already in the list.
//
// HONEST LIMITS (why the caller must keep survivorshipSafe=false): this only adds back delistings
// the master actually knows (currently S&P-500, ≤5yr — lib/constituents.js), it does NOT correct
// LATE-LISTING survivorship (no IPO feed), and a re-added delisted name may have no historical
// candle data on the free feed, in which case it still cannot be traded in the backtest.
function pointInTimeAugment(records, staticList, asOf) {
  const base = [...new Set(staticList || [])];
  const inStatic = new Set(base);
  const thenActive = new Set(universeAtFrom(records || {}, asOf));
  const nowActive = new Set(universeAtFrom(records || {}, null));   // null → FAR_FUTURE → today
  const added = [...thenActive].filter((s) => !nowActive.has(s) && !inStatic.has(s)).sort();
  return {
    asOf: asOf || null,
    universe: [...base, ...added],
    added, addedCount: added.length, staticCount: base.length,
    survivorshipSafe: false,   // ALWAYS — see the honest limits above
  };
}

// ── Blob-backed builder / readers ───────────────────────────────────────────

async function loadMaster() { return readJSON(MASTER_PATH, null); }

// Assemble + persist the master from the live sources. observed{} is passed in by
// the route (it reads the pick ledger) so this module stays free of ledger coupling.
async function saveMaster({ sectorOf, knownSymbols, removed, observed }) {
  const records = buildMaster({ sectorOf, knownSymbols, removed, observed });
  const doc = { v: SECMASTER_VERSION, builtAt: new Date().toISOString(), count: Object.keys(records).length, records };
  if (hasStore()) await writeJSON(MASTER_PATH, doc, 0);
  return doc;
}

// resolveSecurityId(symbol, asOf): load the master and resolve point-in-time. Falls
// back to a minimal live record (sector only) when the master hasn't been built yet,
// clearly flagged so a caller never mistakes a fallback for a real master hit.
async function resolveSecurityId(symbol, asOf, sectorOf = {}) {
  const master = await loadMaster();
  const rec = master && master.records && master.records[symbol];
  if (rec) return { ...resolveAsOf(rec, asOf), source: 'master', builtAt: master.builtAt };
  return {
    found: false, source: 'fallback', symbol,
    securityId: symbol, sector: sectorOf[symbol] || null,
    status: 'unknown', active: null, knownAsOf: null,
    reason: master ? 'symbol-not-in-master' : 'master-not-built',
  };
}

async function universeAt(date) {
  const master = await loadMaster();
  if (!master || !master.records) return { built: false, date, symbols: [], count: 0 };
  const symbols = universeAtFrom(master.records, date);
  return { built: true, builtAt: master.builtAt, date, symbols, count: symbols.length };
}

module.exports = {
  SECMASTER_VERSION, MASTER_PATH,
  buildMaster, resolveAsOf, universeAtFrom, pointInTimeAugment,  // pure
  loadMaster, saveMaster, resolveSecurityId, universeAt,  // Blob-backed
  hasStore,
};

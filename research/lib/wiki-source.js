'use strict';
// ── WIKI-mirror source adapter (wiki-source-v1) ──────────────────────────────
// Materializes the frozen Quandl WIKI price mirror (Kaggle
// marketneutral/quandl-wiki-prices-us-equites, WIKI frozen 2018-03-27) into the
// EXACT artifact shapes the panel-v3.2 pipeline consumes — per-symbol price
// cache, per-symbol corpaction provenance, a wiki-flavored security master with
// EDGAR-Form-25-joined real-death delistings, a symbols payload, and the
// observed-session union for the calendar — so the unchanged builder, cohort
// ledger, manifest verifier and audit run against it.
//
// Honesty invariants (preregistered in PREREGISTRATION-MOMENTUM-WIKI-2026-08.md):
//  * Split adjustment is DERIVED from the raw bars + split_ratio column (WIKI's
//    own adj_* columns are split+dividend adjusted — feeding them to the TR
//    builder would double-count dividends). Every symbol's derived adjustment is
//    cross-checked against WIKI's adj_close day-over-day ratios on non-dividend
//    days; structural disagreement excludes the symbol (counted).
//  * Delistings come ONLY from the verified Form-25 real-death join
//    (delisting.reasonCategory present in secmaster-hist). A ticker whose WIKI
//    bars continue > ZOMBIE_GRACE_DAYS past a verified death is a TICKER-REUSE
//    collision (e.g. ALTR Altera→Altair) and is excluded entirely (pre-specified
//    identity rule — WIKI has no permaticker).
//  * A name whose bars end mid-era with NO verified death attaches no delisting:
//    outcome-v3 then fails closed to `unresolved` (never a fabricated label).
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

const WIKI_SOURCE_VERSION = 'wiki-source-v1';
const WIKI_FREEZE_DATE = '2018-03-27';           // last session Quandl ever wrote
const ACTIVE_THROUGH_MIN = '2018-03-20';         // last-bar ≥ this ⇒ alive at freeze
const ZOMBIE_GRACE_DAYS = 45;                    // bars > 45d past a verified death ⇒ ticker reuse
const ADJ_CROSSCHECK_REL_TOL = 2e-3;             // per-pair tolerance vs WIKI adj_close ratio
const ADJ_CROSSCHECK_MAX_MISMATCH_FRAC = 0.01;   // >1% mismatched pairs ⇒ structural exclusion
const DAY = 86400000;

// Back-adjust raw bars for splits. WIKI's split_ratio sits on the effective
// date and the bar ON that date is already post-split, so every bar strictly
// BEFORE a split date divides by the ratio (prices) and multiplies (volume).
// rows: ascending [{date, open, high, low, close, volume, exDividend, splitRatio, adjClose}]
function backAdjustForSplits(rows) {
  const out = new Array(rows.length);
  let f = 1;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const adj = (x) => (Number.isFinite(x) && x > 0 ? x / f : null);
    out[i] = {
      date: r.date,
      open: adj(r.open), high: adj(r.high), low: adj(r.low), close: adj(r.close),
      volume: Number.isFinite(r.volume) ? Math.round(r.volume * f) : null,
      splitFactor: f,
    };
    if (Number.isFinite(r.splitRatio) && r.splitRatio > 0 && r.splitRatio !== 1) f *= r.splitRatio;
  }
  return out;
}

// Corpaction records in the exact shapes research/lib/corpactions.js consumes:
// splits [{date, numerator, denominator}] and dividends [{date, dividend,
// adjDividend}] with adjDividend on the SAME split-adjusted scale as the bars.
function synthesizeCorpactions(sym, rows, adjusted) {
  const splits = [];
  const dividends = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (Number.isFinite(r.splitRatio) && r.splitRatio > 0 && r.splitRatio !== 1) {
      splits.push({ symbol: sym, date: r.date, numerator: r.splitRatio, denominator: 1, splitType: 'stock-split' });
    }
    if (Number.isFinite(r.exDividend) && r.exDividend > 0) {
      dividends.push({ symbol: sym, date: r.date, dividend: r.exDividend, adjDividend: r.exDividend / adjusted[i].splitFactor });
    }
  }
  return { splits, dividends };
}

// Cross-check the derived split adjustment against WIKI's own adj_close:
// on consecutive bars with NO dividend on the later bar, adjClose ratio must
// match the derived-adjusted close ratio (WIKI adj = split+dividend adjusted,
// so the two bases differ only across ex-dividend days).
function adjustmentCrossCheck(rows, adjusted) {
  let checked = 0, mismatched = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    if (!(a.adjClose > 0) || !(b.adjClose > 0)) continue;
    if (Number.isFinite(b.exDividend) && b.exDividend > 0) continue;
    const mineA = adjusted[i - 1].close, mineB = adjusted[i].close;
    if (!(mineA > 0) || !(mineB > 0)) continue;
    checked++;
    const wikiRatio = b.adjClose / a.adjClose;
    const mineRatio = mineB / mineA;
    if (Math.abs(wikiRatio - mineRatio) / Math.max(1e-9, Math.abs(wikiRatio)) > ADJ_CROSSCHECK_REL_TOL) mismatched++;
  }
  return { checked, mismatched, mismatchFrac: checked ? mismatched / checked : 0 };
}

// Pre-specified death join for one symbol. death = the verified Form-25
// real-death record mapped to this ticker (or null). Returns one of:
//   { kind: 'zombie' }                 — bars continue past the death: EXCLUDE
//   { kind: 'delisted', delisting }    — attach the confirmation
//   { kind: 'active' } | { kind: 'unknown' } — no verified death
function joinDeath(lastBarDate, death) {
  if (!death || !death.date) {
    return { kind: lastBarDate >= ACTIVE_THROUGH_MIN ? 'active' : 'unknown' };
  }
  const gapDays = (Date.parse(death.date) - Date.parse(lastBarDate)) / DAY;
  if (gapDays < -ZOMBIE_GRACE_DAYS) return { kind: 'zombie' };
  return {
    kind: 'delisted',
    delisting: {
      date: death.date,
      source: 'edgar-form25',
      confirmedAt: death.confirmedAt || death.date,
      reason: death.reason || null,
      reasonCategory: death.reasonCategory,
      provenance: {
        basis: death.basis || 'edgar-form25-effective',
        accessionNumber: death.accessionNumber || null,
        joinRule: `primaryTicker exact match; bars > ${ZOMBIE_GRACE_DAYS}d past death ⇒ ticker-reuse exclusion; series-end vs death-date reconciliation delegated to outcome-v3 truncation guard`,
      },
    },
  };
}

// Verified real deaths (reasonCategory present) keyed by primaryTicker, plus
// the full in-era death dates (ticker-mapped OR NOT) so the survivorship
// contract's `expected` denominator stays honest about names WIKI never held.
function loadRealDeaths(secmasterHistPath) {
  const sm = JSON.parse(fs.readFileSync(secmasterHistPath, 'utf8'));
  const byTicker = new Map();
  const allRealDeathDates = [];
  for (const cik of Object.keys(sm.records || {})) {
    const r = sm.records[cik];
    const d = r.delisting;
    if (!d || !d.reasonCategory || !d.date) continue;
    allRealDeathDates.push(d.date);
    if (!r.primaryTicker) continue;
    const ev = d.reasonEvidence || {};
    const rec = {
      cik, date: d.date, reasonCategory: d.reasonCategory, reason: d.reason || null,
      basis: d.basis || null, confirmedAt: ev.filingDate || d.date, accessionNumber: ev.accessionNumber || null,
    };
    // On ticker collision between two dead CIKs keep the EARLIER death — the
    // later one is the reused ticker and will surface as a zombie/exclusion.
    const prev = byTicker.get(r.primaryTicker);
    if (!prev || rec.date < prev.date) byTicker.set(r.primaryTicker, rec);
  }
  return { byTicker, allRealDeathDates, version: sm.version || null, contentHash: sm.contentHash || null };
}

// Optional human-readable names from the WIKI codes CSV ("WIKI/BYI","Bally
// Technologies Inc (BYI) Prices, Dividends, Splits and Trading Volume").
function loadCodesNames(codesPath) {
  const names = new Map();
  if (!codesPath || !fs.existsSync(codesPath)) return names;
  for (const line of fs.readFileSync(codesPath, 'utf8').split('\n')) {
    const m = line.match(/^WIKI\/([A-Z0-9_.]+),"?(.+?)\s*\(\1\)/);
    if (m) names.set(m[1], m[2]);
  }
  return names;
}

const num = (s) => (s === '' || s == null ? null : Number(s));

// Stream the full CSV (sorted by ticker,date), materialize all artifacts.
async function adaptWikiCsv({ csvPath, secmasterHistPath, codesPath = null, outDir, retrievedAt, sectorBySymbol = {} }) {
  const cacheDir = path.join(outDir, 'cache');
  const corpDir = path.join(outDir, 'corpactions');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(corpDir, { recursive: true });

  const deaths = loadRealDeaths(secmasterHistPath);
  const names = loadCodesNames(codesPath);
  const csvSha256 = crypto.createHash('sha256').update(fs.readFileSync(csvPath)).digest('hex');

  const sessionDates = new Set();
  const records = {};
  const symbols = {};
  const qc = {
    rowsRead: 0, badPriceRows: 0, outOfOrderRows: 0, missingOpenRows: 0,
    symbols: 0, zombiesExcluded: [], adjMismatchExcluded: [],
    deathsAttached: 0, activeAtFreeze: 0, unknownEnders: 0,
  };
  const seenTickers = new Set();

  const finalize = (sym, rows) => {
    if (!rows.length) return;
    qc.symbols++;
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const adjusted = backAdjustForSplits(rows);
    const xc = adjustmentCrossCheck(rows, adjusted);
    if (xc.mismatchFrac > ADJ_CROSSCHECK_MAX_MISMATCH_FRAC && xc.checked >= 50) {
      qc.adjMismatchExcluded.push({ sym, ...xc });
      return; // structural adjustment disagreement — fail closed, never guess
    }
    const lastBarDate = rows[rows.length - 1].date;
    const joined = joinDeath(lastBarDate, deaths.byTicker.get(sym) || null);
    if (joined.kind === 'zombie') { qc.zombiesExcluded.push({ sym, death: deaths.byTicker.get(sym).date, lastBar: lastBarDate }); return; }
    if (joined.kind === 'delisted') qc.deathsAttached++;
    else if (joined.kind === 'active') qc.activeAtFreeze++;
    else qc.unknownEnders++;

    const price = adjusted.map((b, i) => {
      if (!(b.close > 0)) { qc.badPriceRows++; return null; }
      if (!(b.open > 0)) qc.missingOpenRows++;
      sessionDates.add(b.date);
      return { symbol: sym, date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 };
    }).filter(Boolean);
    if (!price.length) return;

    const corp = synthesizeCorpactions(sym, rows, adjusted);
    fs.writeFileSync(path.join(cacheDir, `${sym}.json`), JSON.stringify({ sym, price, income: [], fetchedAt: retrievedAt }));
    fs.writeFileSync(path.join(corpDir, `${sym}.json`), JSON.stringify({
      sym, splits: corp.splits, dividends: corp.dividends, retrievedAt,
      source: 'wiki-mirror:ex-dividend+split_ratio (derived split-adjusted basis, adj_close cross-checked)',
    }));

    records[sym] = {
      schemaVersion: 'wiki-secmaster-v1',
      listingId: `wiki:${sym}`,
      masterVersion: 'wiki-secmaster-v1',
      symbol: sym,
      security: { isEtf: false, isFund: false, isAdr: false },
      exchange: '',
      listingDate: rows[0].date,
      status: joined.kind === 'delisted' ? 'delisted' : joined.kind === 'active' ? 'active' : 'unknown',
      observedActiveThrough: lastBarDate,
      delisting: joined.kind === 'delisted' ? joined.delisting : null,
      identityConfidence: joined.kind === 'delisted' ? 'form25-joined' : 'observed-only',
    };
    symbols[sym] = { source: 'wiki', name: names.get(sym) || '', exchange: '', sector: sectorBySymbol[sym] || 'Unknown' };
  };

  const rl = readline.createInterface({ input: fs.createReadStream(csvPath), crlfDelay: Infinity });
  let header = null, cur = null, rows = [];
  for await (const line of rl) {
    if (!header) { header = line; continue; }
    const c = line.split(',');
    if (c.length < 13) continue;
    qc.rowsRead++;
    const t = c[0];
    if (t !== cur) {
      if (cur !== null) finalize(cur, rows);
      if (seenTickers.has(t)) throw new Error(`wiki-source: CSV not grouped by ticker (${t} reappeared) — adapter assumes sorted input`);
      seenTickers.add(t);
      cur = t; rows = [];
    }
    rows.push({
      date: c[1], open: num(c[2]), high: num(c[3]), low: num(c[4]), close: num(c[5]),
      volume: num(c[6]), exDividend: num(c[7]), splitRatio: num(c[8]), adjClose: num(c[12]),
    });
  }
  if (cur !== null) finalize(cur, rows);

  const included = Object.keys(records);
  const master = {
    version: 'wiki-secmaster-v1',
    schemaVersion: 'secmaster-v3.1-compatible',
    builtAt: retrievedAt,
    source: `kaggle:marketneutral/quandl-wiki-prices-us-equites sha256:${csvSha256}; deaths: EDGAR Form-25 real-death join (${deaths.version || 'secmaster-hist'})`,
    counts: {
      symbols: included.length,
      delisted: included.filter((s) => records[s].status === 'delisted').length,
      active: included.filter((s) => records[s].status === 'active').length,
      unknown: included.filter((s) => records[s].status === 'unknown').length,
      zombiesExcluded: qc.zombiesExcluded.length,
      adjMismatchExcluded: qc.adjMismatchExcluded.length,
    },
    meta: {
      coverageLimitations: [
        { source: 'wiki-mirror', limitation: 'curated ~3,000-name universe assembled circa 2014; securities that died before 2014 were never included', consequence: 'pre-2014 eras are survivorship-biased at source and are OUT OF SCOPE for any study on this master' },
        { source: 'wiki-mirror', limitation: `frozen ${WIKI_FREEZE_DATE}; no observations after`, consequence: 'label windows crossing the freeze are pending/ineligible by the cohort rule' },
        { source: 'edgar-form25-join', limitation: 'delistings attach only where a Form-25 real death maps to the ticker; enders without a verified death carry status unknown', consequence: 'their windows resolve unresolved (fail closed) and are policed by the cohort coverage minimum' },
        { source: 'identity', limitation: 'WIKI has no permaticker; ticker-reuse collisions are excluded by the pre-specified zombie rule', consequence: 'excluded names are enumerated in the adapter report' },
      ],
    },
    records,
  };
  fs.writeFileSync(path.join(outDir, 'secmaster-v3.json'), JSON.stringify(master));
  fs.writeFileSync(path.join(outDir, 'symbols.json'), JSON.stringify({
    generatedAt: retrievedAt, band: 'wiki-adv-floor', counts: { symbols: included.length }, symbols,
  }));
  fs.writeFileSync(path.join(outDir, 'sessions.json'), JSON.stringify({
    schema: 'WikiObservedSessions', version: WIKI_SOURCE_VERSION,
    source: 'union of all WIKI bar dates (every session any included name traded)',
    dates: [...sessionDates].sort(),
  }));
  // All verified real deaths inside the study era (grid start → freeze),
  // regardless of ticker mapping — the honest survivorship `expected` count.
  const eraRealDeathsExpected = deaths.allRealDeathDates.filter((d) => d >= '2014-01-01' && d <= WIKI_FREEZE_DATE).length;
  const report = {
    schema: 'WikiAdapterReport', version: WIKI_SOURCE_VERSION, generatedAt: new Date().toISOString(),
    csvPath: path.basename(csvPath), csvSha256, retrievedAt, qc, eraRealDeathsExpected,
    deathsSource: { version: deaths.version, contentHash: deaths.contentHash, realDeathTickers: deaths.byTicker.size },
  };
  fs.writeFileSync(path.join(outDir, 'adapter-report.json'), JSON.stringify(report, null, 2));
  return report;
}

module.exports = {
  WIKI_SOURCE_VERSION, WIKI_FREEZE_DATE, ZOMBIE_GRACE_DAYS, ACTIVE_THROUGH_MIN,
  ADJ_CROSSCHECK_REL_TOL, ADJ_CROSSCHECK_MAX_MISMATCH_FRAC,
  backAdjustForSplits, synthesizeCorpactions, adjustmentCrossCheck, joinDeath,
  loadRealDeaths, loadCodesNames, adaptWikiCsv,
};

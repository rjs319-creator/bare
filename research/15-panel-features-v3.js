'use strict';
// Step 15 — PANEL v3.1: the feature panel rebuilt on the fwd-outcome-v3 label
// contract PLUS the identity / corporate-action / snapshot-manifest layers.
//   node research/15-panel-features-v3.js
//
// v3.1 upgrades over the first panel-v3 build (each closed a verified defect):
//   * IDENTITY — listingId is the primary key. Symbol cache files sharing one
//     listingId (ticker renames: CDAY→DAY, SCHN→RDUS, MCG→SHCO, AMSWA→LGTY)
//     are merged into ONE canonical series via research/lib/identity-v3; the
//     row's `s` is the reconstructed ticker ACTIVE on the decision date and
//     `cs` is the cache symbol backing the series. Residual duplicate
//     (lid, dt) keys HARD-FAIL the build. Conflicting/ambiguous identity is
//     quarantined, never merged.
//   * INSTRUMENT TYPE — ETFs/funds/ADRs/warrants/units/rights/preferred are
//     excluded with reason codes; unknown identity fails closed (excluded).
//   * PRICES — labels and momentum/vol features are computed on a TOTAL-RETURN
//     index (vendor-split-adjusted close reinvesting adjDividend, verified via
//     research/lib/corpactions). Raw closes still drive cap/ADV. A symbol
//     without cached corporate-action provenance is EXCLUDED (fail closed).
//     A residual split discontinuity excludes the whole series.
//   * EXTREME EVENTS (v3.2) — DECISION-TIME validation only: structural
//     evidence (unadjusted splits, duplicate/malformed bars, OHLC conflicts)
//     poisons its dates (entries skipped, labels withheld 'u'). An unexplained
//     extreme is an OBSERVED MARKET MOVE: retained whatever its future path,
//     flagged x{h}=1 so experiments can run symmetric sensitivity views
//     (include-all vs exclude-all). Persistence/reversion is a post-event
//     DIAGNOSTIC only — it can never gate a row, label or cohort.
//   * CUTOFFS + COHORTS (v3.2) — explicit featureAvailabilityCutoff /
//     lastDecisionTimestamp / labelObservationCutoff, PLUS the cohort-maturity
//     contract: a market-session calendar (research/lib/calendar) and a
//     per-(decisionDate, horizon) eligibility ledger (research/lib/cohort).
//     A decision date enters cross-sectional evaluation only when its whole
//     window elapsed, zero rows are pending and coverage ≥ 95% — three early
//     delistings can never mature a 1,700-name pending cohort.
//   * Rows carry le{h} (label-end date) so maturity is verifiable forever.
//   * PROVENANCE (v3.2) — content hashes for every source payload/partition
//     (security master, universe, corp-action + price Merkle roots, calendar,
//     cohort ledger) and full build facts (commit, dirty flag + diff hash,
//     command, deterministic params). Reproducibility class is derived, never
//     declared.
//
// DOCUMENTED LIMITATIONS (not silent):
//   * `sec` is the vendor's CURRENT sector classification — NOT point-in-time.
//   * shares outstanding are weighted-average diluted from quarterly filings —
//     an approximation, applied with filing-date availability.
//   * alias intervals are reconstructed from observed trading spans (vendor
//     rename history is only ~3 months deep).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const pit = require('./lib/pit');
const OV3 = require('./lib/outcome-v3');
const ID3 = require('./lib/identity-v3');
const CA = require('./lib/corpactions');
const MF = require('./lib/manifest');
const CAL = require('./lib/calendar');
const COHORT = require('./lib/cohort');
const SV = require('../lib/research/survivorship');

const DATA = path.join(__dirname, 'data');
const MASTER_PATH = path.join(DATA, 'secmaster-v3.json');
const OUT_PATH = path.join(DATA, 'panel-features-v3.json');
const MANIFEST_PATH = path.join(DATA, 'panel-v3-manifest.json');
const IDENTITY_REPORT_PATH = path.join(DATA, 'identity-quality-v3.json');
const EXTREMES_REPORT_PATH = path.join(DATA, 'extreme-returns-v3.json');
const COVERAGE_REPORT_PATH = path.join(DATA, 'universe-coverage-v3.json');
const CALENDAR_PATH = path.join(DATA, 'market-calendar-v1.json');
const COHORT_PATH = path.join(DATA, 'cohort-eligibility-v3.json');
const BLOCKED_PATH = path.join(DATA, 'panel-v3.BLOCKED.json');
const INVALID_PATH = path.join(DATA, 'panel-v3.INVALID.json');
const CORP_DIR = path.join(DATA, 'corpactions');
const GRID_FROM = '2022-01', GRID_TO = '2026-05';
const GRID = pit.monthEnds(GRID_FROM, GRID_TO);
const VOL_LB = 63;
const HORIZONS = [21, 63, 126];
const PANEL_VERSION = 'panel-v3.2';
const MIN_OUTCOME_COVERAGE = COHORT.DEFAULT_MIN_OUTCOME_COVERAGE;
const CALENDAR_SOURCE_SYMBOL = 'SPY';
const BUILD_COMMAND = 'node research/15-panel-features-v3.js';

const STATUS_CHAR = { mature: 'm', confirmed_delisted: 'c', pending: 'p', unresolved: 'u', no_fill: 'n' };

const NON_COMMON_NAME_RE = /\bwarrants?\b|\brights?\b|\bunits?\b|preferred|preference|depositary|depositaries|\betf\b|exchange.traded fund|\bnotes? due\b|acquisition corp|acquisition co/i;
const NON_COMMON_SUFFIX_RE = /[-.](WS|WT|W|U|R|RT)$/i;

const REIT_NAME_RE = /\bREIT\b|Realty Trust|Realty Group|Realty Income|Real Estate Investment|Properties Trust|Property Trust|Realty Investment/i;
const EQUITY_EXCHANGES = new Set(['NYSE', 'NASDAQ', 'AMEX', 'NYSE AMERICAN']);

// Instrument-type classification. Positive knowledge excludes; ABSENT knowledge
// with a suspicious symbol shape also excludes (fail closed); otherwise the
// secmaster identity (already required upstream) plus a clean name passes.
// VENDOR-FLAG CAVEAT (measured, not assumed): FMP marks exchange-listed equity
// REITs (FRT, VNO, KRG…) isFund=true. Deleting the REIT sector would be a
// systematic universe distortion, so an exchange-listed REIT-named security
// OVERRIDES the isFund flag — every override is counted and disclosed.
function classifyInstrument(sym, meta, record) {
  const secu = (record && record.security) || {};
  const name = (meta && meta.name) || '';
  const exch = String((record && record.exchange) || (meta && meta.exchange) || '').toUpperCase();
  if (secu.isEtf === true) return { include: false, reason: 'etf' };
  if (sym.length === 5 && /X$/.test(sym)) return { include: false, reason: 'mutual-fund-ticker-shape' };
  if (secu.isFund === true) {
    if (REIT_NAME_RE.test(name) && EQUITY_EXCHANGES.has(exch)) {
      return { include: true, reason: null, override: 'vendor-isFund-overridden-equity-reit' };
    }
    return { include: false, reason: 'fund' };
  }
  if (secu.isAdr === true) return { include: false, reason: 'adr' };
  if (NON_COMMON_NAME_RE.test(name)) return { include: false, reason: 'non-common-name-pattern' };
  if (NON_COMMON_SUFFIX_RE.test(sym)) return { include: false, reason: 'non-common-symbol-suffix' };
  if (sym.length >= 5 && /W$/.test(sym) && !name) return { include: false, reason: 'suspected-warrant-suffix-no-name' };
  return { include: true, reason: null };
}

// f{h}: training label (null unless label-ready — enforced by assertTrainable).
// d{h}: 1 iff a label-ready confirmed delisting; null when no label exists.
// s{h}: outcome status char. le{h}: label-end date when label-ready.
function labelFieldsV3(h, o) {
  if (o.labelReady) OV3.assertTrainable(o);
  return {
    [`f${h}`]: o.labelReady ? o.trainingLabel : null,
    [`d${h}`]: o.labelReady ? (o.status === 'confirmed_delisted' ? 1 : 0) : null,
    [`s${h}`]: STATUS_CHAR[o.status] || 'u',
    [`le${h}`]: o.labelReady ? o.actualExitDate : null,
  };
}

const sd = (a) => { if (a.length < 2) return null; const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const ratio = (ps, i, lb, sk) => { if (i - lb < 0 || i - sk < 0) return null; const a = ps[i - lb].tr, b = ps[i - sk].tr; return (a > 0 && b > 0) ? b / a - 1 : null; };
function annVol(ps, i, n) { if (i - n < 0) return null; const r = []; for (let k = i - n + 1; k <= i; k++) { const x = ps[k].tr / ps[k - 1].tr - 1; if (Number.isFinite(x)) r.push(Math.max(-0.5, Math.min(0.5, x))); } const s = sd(r); return s ? s * Math.sqrt(252) : null; }
function advN(ps, i, n) { if (i < 0) return null; let s = 0, c = 0; for (let k = Math.max(0, i - n + 1); k <= i; k++) { s += ps[k].dollar; c++; } return c ? s / c : null; }

function writeBlocked(reason) {
  const blocked = {
    status: 'blocked', panelVersion: 'panel-v3', checkedAt: new Date().toISOString(), reason,
    note: 'panel-v2 (panel-features.json) is untouched and remains the survivorship-CAVEATED artifact; its inferred-delisting labels are marked for revalidation in research/PANEL-V2-REVALIDATION.md.',
    migration: [
      '1. node --env-file=research/.env research/16-secmaster-v3.js            # FMP+EDGAR reconstruction (cached, resumable)',
      '   or: node research/16-secmaster-v3.js --from <pitdata-v3 listings export>',
      '2. node --env-file=research/.env research/54-corpactions-fetch.js       # splits+dividends provenance (cached, resumable)',
      '3. node research/15-panel-features-v3.js',
    ],
  };
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(BLOCKED_PATH, JSON.stringify(blocked, null, 2));
  console.log(`BLOCKED: ${reason}`);
  for (const step of blocked.migration) console.log(step);
}

// Merge income statements across a group's member cache files (vendor backfills
// the same filings under each alias): union deduped by period date.
function mergedIncome(cacheDir, members) {
  const byDate = new Map();
  for (const sym of members) {
    const f = path.join(cacheDir, `${sym}.json`);
    if (!fs.existsSync(f)) continue;
    let c; try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    for (const r of c.income || []) {
      if (r && r.date && !byDate.has(r.date)) byDate.set(r.date, r);
    }
  }
  return [...byDate.values()];
}

function buildPanel({ master, symbols, cacheDir, corpDir }) {
  const symsAll = Object.keys(symbols).sort();
  const exclusions = {};                       // symbol-level exclusion reason → count
  const excl = (reason) => { exclusions[reason] = (exclusions[reason] || 0) + 1; };

  // ── symbol-level funnel: cache → instrument type → identity ────────────────
  const cached = [];
  for (const sym of symsAll) {
    if (!fs.existsSync(path.join(cacheDir, `${sym}.json`))) { excl('no-price-cache'); continue; }
    cached.push(sym);
  }
  const typed = [];
  for (const sym of cached) {
    const cls = classifyInstrument(sym, symbols[sym], master.records[sym]);
    if (!cls.include) { excl(`type:${cls.reason}`); continue; }
    if (cls.override) excl(`override:${cls.override}`);   // disclosure counter, symbol still included
    typed.push(sym);
  }

  // Series loader (memoized) for spans + overlap checks + the build itself.
  const seriesMemo = new Map();
  const loadSeries = (sym) => {
    if (seriesMemo.has(sym)) return seriesMemo.get(sym);
    let out = null;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(cacheDir, `${sym}.json`), 'utf8'));
      const ps = pit.priceSeries(c.price);
      out = ps.length ? ps : null;
    } catch { out = null; }
    seriesMemo.set(sym, out);
    return out;
  };
  const spanOf = (sym) => {
    const ps = loadSeries(sym);
    if (!ps) return null;
    return { firstBar: new Date(ps[0].ms).toISOString().slice(0, 10), lastBar: new Date(ps[ps.length - 1].ms).toISOString().slice(0, 10), bars: ps.length };
  };
  const overlapCheck = (a, b) => ID3.seriesConsistent(loadSeries(a) || [], loadSeries(b) || []);

  const identity = ID3.buildIdentityIndex({ symbols: typed, records: master.records, spanOf, overlapCheck });
  for (let k = 0; k < identity.noIdentity.length; k++) excl('no-identity-fails-closed');
  for (const q of identity.quarantined) for (let k = 0; k < q.symbols.length; k++) excl('identity-quarantined');

  // ── group-level build ──────────────────────────────────────────────────────
  const out = {};
  const labelStates = { m: 0, c: 0, p: 0, u: 0, n: 0 };
  const labelStatesByH = Object.fromEntries(HORIZONS.map((h) => [h, { m: 0, c: 0, p: 0, u: 0, n: 0 }]));
  const withheldDelistings = { unverifiedReason: 0 };
  const extremeSummary = {
    symbolsAudited: 0, events: 0, byClass: {}, persistenceDiagnostics: {},
    poisonedLabels: 0, poisonedEntriesSkipped: 0, unconfirmedExtremeFlaggedLabels: 0, perSymbol: [],
    policy: 'decision-time-structural-only poisons; unconfirmed extremes retained + flagged (x{h}) for symmetric sensitivity views; persistence classes are diagnosticOnly',
  };
  const provenanceSummary = { verifiedSplitAdjusted: 0, unverifiable: 0, conflicts: 0 };
  const monthlyFunnel = {};    // ym → counters
  let kept = 0, names = 0, deadNamesIncluded = 0;
  let dataEdgeMs = 0;
  let minRetrievedAt = null, maxRetrievedAt = null;

  const groups = [...identity.groups.values()].sort((a, b) => (a.listingId < b.listingId ? -1 : 1));
  for (const g of groups) {
    const src = g.canonicalSource;
    const rawSeries = loadSeries(src);
    if (!rawSeries || rawSeries.length < 60) { excl('too-few-bars'); continue; }

    // Corporate-action provenance is REQUIRED (fail closed).
    const corpPath = path.join(corpDir, `${src}.json`);
    if (!fs.existsSync(corpPath)) { excl('no-corpaction-provenance'); continue; }
    let corp; try { corp = JSON.parse(fs.readFileSync(corpPath, 'utf8')); } catch { excl('no-corpaction-provenance'); continue; }
    if (corp.retrievedAt) {
      if (!minRetrievedAt || corp.retrievedAt < minRetrievedAt) minRetrievedAt = corp.retrievedAt;
      if (!maxRetrievedAt || corp.retrievedAt > maxRetrievedAt) maxRetrievedAt = corp.retrievedAt;
    }
    const sv = CA.verifySplitAdjustment(rawSeries, corp.splits);
    if (sv.verified === false) { excl('split-adjustment-conflict'); provenanceSummary.conflicts++; continue; }
    if (sv.verified === true) provenanceSummary.verifiedSplitAdjusted++; else provenanceSummary.unverifiable++;

    const ps = CA.withTotalReturn(rawSeries, corp.dividends);
    // DECISION-TIME validation only: structural evidence (unadjusted splits,
    // duplicate/malformed bars, OHLC inconsistency) poisons; an unexplained
    // extreme is an observed market move — retained, flagged for the
    // symmetric sensitivity views, never judged by its future path.
    const audit = CA.decisionTimeQualityAudit(rawSeries, corp);
    const diagnostics = CA.postEventPersistenceDiagnostics(rawSeries, audit.events);
    extremeSummary.symbolsAudited++;
    if (audit.events.length) {
      extremeSummary.events += audit.events.length;
      for (const e of audit.events) extremeSummary.byClass[e.class] = (extremeSummary.byClass[e.class] || 0) + 1;
      for (const d of diagnostics) extremeSummary.persistenceDiagnostics[d.persistence] = (extremeSummary.persistenceDiagnostics[d.persistence] || 0) + 1;
      if (extremeSummary.perSymbol.length < 500) extremeSummary.perSymbol.push({ sym: src, lid: g.listingId, events: audit.events, diagnostics });
    }

    const ss = pit.sharesSeries(mergedIncome(cacheDir, g.members));
    if (!ss.length) { excl('no-shares-series'); continue; }

    const meta = symbols[src] || symbols[g.members[0]] || {};
    const sec = meta.sector || 'Unknown';
    const security = master.records[src] || null;
    names++;
    if (security && security.status === 'delisted') deadNamesIncluded++;
    if (rawSeries[rawSeries.length - 1].ms > dataEdgeMs) dataEdgeMs = rawSeries[rawSeries.length - 1].ms;

    // Stash per-group work for the second pass (labels need the global data edge).
    g._work = { ps, audit, ss, sec, security };
  }

  // The label observation cutoff is DERIVED from the data: the latest bar any
  // included series carries. Every pending/unresolved decision past it is
  // honestly pending; every mature label must end at or before it (verified by
  // the manifest invariants).
  const labelObservationCutoffMs = dataEdgeMs;
  const cutoffs = {
    featureAvailabilityCutoff: new Date(dataEdgeMs).toISOString().slice(0, 10),
    labelObservationCutoff: new Date(labelObservationCutoffMs).toISOString().slice(0, 10),
    lastDecisionTimestamp: null,   // set after rows emit
  };

  for (const g of groups) {
    if (!g._work) continue;
    const { ps, audit, ss, sec, security } = g._work;
    const opts = { dataCutoffMs: labelObservationCutoffMs, securityMasterVersion: master.version, priceDataVersion: 'fmp-cache-v1+corpactions-v1-tr' };
    // Label series: TR index as the return basis (close ← tr), raw close kept
    // for entry-positivity semantics via tr>0 equivalence.
    const labelSeries = ps.map((b) => ({ ms: b.ms, close: b.tr }));
    for (const d of GRID) {
      const ym = new Date(d).toISOString().slice(0, 7);
      const fun = (monthlyFunnel[ym] ||= { candidates: 0, priced: 0, bandPass: 0, featurePass: 0, emitted: 0 });
      fun.candidates++;
      const pa = pit.asOfPriceAdv(ps, d); if (!pa || pa.stale) continue;
      const i = pa.idx;
      fun.priced++;
      const sh = pit.asOfShares(ss, d); if (!sh) continue;
      const cap = pa.close * sh; if (cap < pit.CAP_LO || cap > pit.CAP_HI || pa.adv < pit.ADV_FLOOR) continue;
      fun.bandPass++;
      const m121 = ratio(ps, i, 252, 21); if (m121 == null) continue;
      fun.featurePass++;
      if (audit.poisonedMs.has(ps[i].ms)) { extremeSummary.poisonedEntriesSkipped++; continue; }

      const outcomes = HORIZONS.map((h) => {
        const o = OV3.forwardOutcomeV3({ series: labelSeries, dateMs: d, bars: h, security, opts });
        // STRUCTURAL poison only (unadjusted split, duplicate/malformed bar,
        // OHLC conflict) — all decision-time evidence. Future persistence
        // plays no part here.
        if (o.labelReady && CA.windowPoisoned(audit.poisonedMs, ps[i].ms, Date.parse(o.actualExitDate))) {
          extremeSummary.poisonedLabels++;
          return { ...o, status: 'unresolved', labelReady: false, trainingLabel: null, reason: 'structural-data-error-in-window-fails-closed' };
        }
        return o;
      });
      // Sensitivity flag: label window (or entry bar) touches a
      // provider-unconfirmed extreme. The label is KEPT either way; the flag
      // lets experiments run include-all vs exclude-all-symmetric views.
      const extremeFlags = HORIZONS.map((h, hIdx) => {
        const o = outcomes[hIdx];
        if (!o.labelReady) return null;
        const touches = audit.extremeMs.has(ps[i].ms)
          || CA.windowExtreme(audit.extremeMs, ps[i].ms, Date.parse(o.actualExitDate));
        if (touches) extremeSummary.unconfirmedExtremeFlaggedLabels++;
        return touches ? 1 : null;
      });
      for (let hIdx = 0; hIdx < HORIZONS.length; hIdx++) {
        const o = outcomes[hIdx];
        const ch = STATUS_CHAR[o.status] || 'u';
        labelStates[ch]++;
        labelStatesByH[HORIZONS[hIdx]][ch]++;
        if (o.status === 'confirmed_delisted' && !o.labelReady) withheldDelistings.unverifiedReason++;
      }
      const m121lag = ratio(ps, i - 63, 252, 21);
      const v63 = annVol(ps, i, VOL_LB);
      const a20 = advN(ps, i, 20), a60 = advN(ps, i, 60);
      const dt = new Date(d).toISOString().slice(0, 10);
      const row = {
        s: ID3.canonicalTickerAt(g, dt) || g.canonicalSource,
        cs: g.canonicalSource,
        sec, cap, adv: pa.adv, ipo: Math.round((d - ps[0].ms) / pit.DAY),
        dt, lid: g.listingId,
        m61: ratio(ps, i, 126, 21), m91: ratio(ps, i, 189, 21), m121,
        m181: ratio(ps, i, 378, 21), m63: ratio(ps, i, 126, 63), m93: ratio(ps, i, 189, 63), m122: ratio(ps, i, 252, 42),
        acc: m121lag == null ? null : m121 - m121lag,
        r21: ratio(ps, i, 21, 0), r5: ratio(ps, i, 5, 0),
        v63, ra: v63 ? m121 / v63 : null, vs: (a20 && a60) ? a20 / a60 : null,
        ...labelFieldsV3(21, outcomes[0]), ...labelFieldsV3(63, outcomes[1]), ...labelFieldsV3(126, outcomes[2]),
      };
      // Sparse sensitivity flags (only when set — x{h}=1 ⇔ label window
      // touches a provider-unconfirmed extreme move).
      HORIZONS.forEach((h, hIdx) => { if (extremeFlags[hIdx]) row[`x${h}`] = 1; });
      fun.emitted++;
      (out[ym] || (out[ym] = [])).push(row); kept++;
      if (row.dt && (!cutoffs.lastDecisionTimestamp || row.dt > cutoffs.lastDecisionTimestamp)) cutoffs.lastDecisionTimestamp = row.dt;
    }
    delete g._work;
  }

  // HARD FAIL on residual duplicate (lid, dt) keys — identity resolution must
  // make them impossible; if one appears the build is defective.
  const seen = new Set();
  for (const ym of Object.keys(out)) {
    for (const r of out[ym]) {
      const key = `${r.lid}|${r.dt}`;
      if (seen.has(key)) throw new Error(`duplicate (listingId, decisionTs) key survived identity resolution: ${key}`);
      seen.add(key);
    }
  }

  return {
    out, labelStates, labelStatesByH, withheldDelistings, kept, names, deadNamesIncluded,
    identity, exclusions, extremeSummary, provenanceSummary, monthlyFunnel, cutoffs,
    cachedSymbols: cached,
    corpRetrievedRange: { min: minRetrievedAt, max: maxRetrievedAt },
  };
}

// HONESTLY RENAMED (was lastFullyMatureByHorizon — a misleading name): the
// last decision date carrying ANY label-ready row. A data-availability
// diagnostic only; the experiment boundary is the COHORT ledger's
// lastFullyObservedCohortDate (three early delistings do not mature a cohort).
function lastLabelReadyByHorizon(out) {
  const res = {};
  for (const h of HORIZONS) {
    let last = null;
    for (const ym of Object.keys(out)) {
      for (const r of out[ym]) {
        if (r[`f${h}`] != null && (!last || r.dt > last)) last = r.dt;   // trainable = label-ready
      }
    }
    res[String(h)] = last;
  }
  return res;
}

// ── build provenance helpers ─────────────────────────────────────────────────
const fileSha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// Merkle leaves over a set of JSON partition files. Also regex-extracts
// fetchedAt/retrievedAt stamps (without a full parse) for the retrieval range.
function hashPartitionDir(dir, files) {
  const leaves = [];
  let minStamp = null, maxStamp = null;
  for (const f of files) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    const buf = fs.readFileSync(p);
    leaves.push({ name: f, hash: crypto.createHash('sha256').update(buf).digest('hex') });
    const m = buf.toString('utf8', 0, Math.min(buf.length, 400)).match(/"(?:fetchedAt|retrievedAt)"\s*:\s*"([^"]+)"/);
    if (m) {
      if (!minStamp || m[1] < minStamp) minStamp = m[1];
      if (!maxStamp || m[1] > maxStamp) maxStamp = m[1];
    }
  }
  return { root: MF.merkleRoot(leaves), fileCount: leaves.length, minStamp, maxStamp };
}

// Git build facts. NEVER prints or stores file contents beyond the diff hash.
function gitBuildFacts(repoRoot) {
  const run = (cmd) => execSync(cmd, { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 }).toString();
  let codeCommit = null, worktreeDirty = false, dirtyDiffHash = null;
  try { codeCommit = run('git rev-parse HEAD').trim() || null; } catch { codeCommit = null; }
  try { worktreeDirty = run('git status --porcelain').trim().length > 0; } catch { worktreeDirty = true; }
  if (worktreeDirty) {
    try { dirtyDiffHash = crypto.createHash('sha256').update(run('git diff HEAD')).digest('hex'); } catch { dirtyDiffHash = null; }
  }
  return { codeCommit, worktreeDirty, dirtyDiffHash };
}

// The panel's session calendar, built from the benchmark series' observed
// trading days (no separately authoritative exchange calendar exists here).
function buildPanelCalendar(cacheDir) {
  const p = path.join(cacheDir, `${CALENDAR_SOURCE_SYMBOL}.json`);
  if (!fs.existsSync(p)) return null;
  let doc; try { doc = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  const dates = (doc.price || []).map((r) => r.date).filter(Boolean);
  if (dates.length < 250) return null;
  return CAL.buildSessionCalendar(dates, { source: `${CALENDAR_SOURCE_SYMBOL} fmp-cache-v1 observed sessions` });
}

function missingnessByFeature(out) {
  const keys = ['m61', 'm91', 'm121', 'm181', 'm63', 'm93', 'm122', 'acc', 'r21', 'r5', 'v63', 'ra', 'vs'];
  const nulls = Object.fromEntries(keys.map((k) => [k, 0]));
  let n = 0;
  for (const ym of Object.keys(out)) for (const r of out[ym]) { n++; for (const k of keys) if (r[k] == null) nulls[k]++; }
  return Object.fromEntries(keys.map((k) => [k, n ? +(nulls[k] / n).toFixed(4) : null]));
}

function main() {
  if (!fs.existsSync(MASTER_PATH)) {
    return writeBlocked('research/data/secmaster-v3.json missing — fwd-outcome-v3 requires an authoritative security master and will not label from price staleness');
  }
  if (!fs.existsSync(CORP_DIR) || !fs.readdirSync(CORP_DIR).some((f) => f.endsWith('.json'))) {
    return writeBlocked('research/data/corpactions/ empty — labels require corporate-action provenance (run research/54-corpactions-fetch.js)');
  }
  const master = JSON.parse(fs.readFileSync(MASTER_PATH, 'utf8'));
  const symbolsDoc = JSON.parse(fs.readFileSync(path.join(DATA, 'symbols.json'), 'utf8'));
  const symbols = symbolsDoc.symbols;

  // Predecessor hash (superseded-by chain) BEFORE overwriting.
  let supersedes = null;
  if (fs.existsSync(OUT_PATH)) {
    try { supersedes = MF.normalizedPanelHash(JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')).panel); } catch { supersedes = null; }
  }

  const calendar = buildPanelCalendar(pit.CACHE);
  if (!calendar) {
    return writeBlocked(`benchmark series ${CALENDAR_SOURCE_SYMBOL} missing from price cache — the market-session calendar (cohort maturity) cannot be built`);
  }

  const b = buildPanel({ master, symbols, cacheDir: pit.CACHE, corpDir: CORP_DIR });
  const months = Object.keys(b.out).sort();
  const datasetHash = MF.normalizedPanelHash(b.out);
  const generatedAt = new Date().toISOString();
  const universeRule = `PIT at decision date: cap in [${pit.CAP_LO / 1e6}M, ${pit.CAP_HI / 1e9}B], ADV ≥ ${pit.ADV_FLOOR / 1e6}M, non-stale price, shares as-of with filing lag, US common stock only (ETF/fund/ADR/warrant/unit/right/preferred excluded)`;

  // ── cohort-eligibility ledger (the experiment boundary) ────────────────────
  const ledger = COHORT.computeCohortLedger({
    panelByMonth: b.out, calendar, horizons: HORIZONS,
    labelObservationCutoff: b.cutoffs.labelObservationCutoff,
    minOutcomeCoverage: MIN_OUTCOME_COVERAGE,
  });

  // ── complete content provenance (payloads and partitions, never counts) ───
  const corpFiles = fs.readdirSync(CORP_DIR).filter((f) => f.endsWith('.json')).sort();
  const corpHash = hashPartitionDir(CORP_DIR, corpFiles);
  const priceFiles = [...new Set([...b.cachedSymbols, CALENDAR_SOURCE_SYMBOL])].sort().map((s) => `${s}.json`);
  const priceHash = hashPartitionDir(pit.CACHE, priceFiles);
  const git = gitBuildFacts(path.join(__dirname, '..'));

  // Survivorship: a MEASURED contract. The universe starts from a present-day
  // symbols payload — NOT a proven monthly historical listing universe — so
  // the status is survivorship-reduced until an authoritative source exists.
  const survivorship = SV.makeSurvivorshipContract({
    historicalListingSource: 'symbols.json (present-day FMP stock list) + secmaster-v3 delisting reconstruction (FMP+EDGAR)',
    historicalListingSourceAuthoritative: false,
    delistedSecuritiesCovered: b.deadNamesIncluded,
    delistedSecuritiesExpected: null,     // unknown: no authoritative monthly historical listing count
    totalSecurities: b.names,
    instrumentTypeCoverage: { includedNames: b.names, exclusionsBySymbol: Object.fromEntries(Object.entries(b.exclusions).filter(([k]) => k.startsWith('type:'))) },
    missingSymbolReasons: b.exclusions,
    notes: 'monthly expected listing counts unavailable on this provider plan; promotion eligibility is blocked until a proven historical listing universe with measured coverage exists',
  });

  const manifest = MF.buildSnapshotManifest({
    snapshotId: `${PANEL_VERSION}:${datasetHash.slice(0, 16)}`,
    datasetHash,
    generatedAt,
    sourceHashes: {
      securityMasterPayloadHash: MF.definitionHash(master),
      universePayloadHash: MF.definitionHash(symbolsDoc),
      corpactionsMerkleRoot: corpHash.root,
      priceCacheMerkleRoot: priceHash.root,
      marketCalendarHash: calendar.calendarHash,
      cohortEligibilityHash: ledger.ledgerHash,
    },
    build: {
      codeCommit: git.codeCommit,
      worktreeDirty: git.worktreeDirty,
      dirtyDiffHash: git.dirtyDiffHash,
      buildCommand: BUILD_COMMAND,
      generationParams: {
        grid: [GRID_FROM, GRID_TO], volLb: VOL_LB, horizons: HORIZONS,
        minOutcomeCoverage: MIN_OUTCOME_COVERAGE, unknownReasonPolicy: 'exclude',
        capLo: pit.CAP_LO, capHi: pit.CAP_HI, advFloor: pit.ADV_FLOOR,
        calendarSourceSymbol: CALENDAR_SOURCE_SYMBOL,
      },
      priceCacheRetrievalRange: {
        minFetchedAt: priceHash.minStamp, maxFetchedAt: priceHash.maxStamp,
        corpMinRetrievedAt: b.corpRetrievedRange.min, corpMaxRetrievedAt: b.corpRetrievedRange.max,
        partitions: { priceCache: priceHash.fileCount, corpactions: corpHash.fileCount },
      },
      sourceSchemaVersions: {
        'fmp-price-cache': 'fmp-cache-v1',
        corpactions: CA.CORPACTIONS_VERSION,
        secmaster: master.version,
        symbols: symbolsDoc.generatedAt || 'unknown',
        calendar: CAL.CALENDAR_VERSION,
        cohort: COHORT.COHORT_POLICY_VERSION,
        outcome: OV3.OUTCOME_POLICY_VERSION,
      },
    },
    sources: [
      { name: 'fmp-price-cache', version: 'fmp-cache-v1', retrievedAt: priceHash.maxStamp, earliestObservation: '2021-06-25', latestObservation: b.cutoffs.labelObservationCutoff },
      { name: 'secmaster-v3', version: master.version, retrievedAt: master.builtAt, earliestObservation: null, latestObservation: null },
      { name: 'fmp-corpactions', version: CA.CORPACTIONS_VERSION, retrievedAt: b.corpRetrievedRange.max, earliestObservation: null, latestObservation: null },
      { name: 'symbols-universe', version: symbolsDoc.generatedAt || 'unknown', retrievedAt: symbolsDoc.generatedAt || null, earliestObservation: null, latestObservation: null },
      { name: 'market-calendar', version: CAL.CALENDAR_VERSION, retrievedAt: null, earliestObservation: calendar.firstSession, latestObservation: calendar.lastSession },
    ],
    featureAvailabilityCutoff: b.cutoffs.featureAvailabilityCutoff,
    lastDecisionTimestamp: b.cutoffs.lastDecisionTimestamp,
    labelObservationCutoff: b.cutoffs.labelObservationCutoff,
    lastLabelReadyDecisionDateByHorizon: lastLabelReadyByHorizon(b.out),
    lastFullyObservedCohortDateByHorizon: Object.fromEntries(
      Object.entries(ledger.byHorizon).map(([h, v]) => [h, v.lastFullyObservedCohortDate]),
    ),
    cohortEligibilityByHorizon: COHORT.ledgerManifestSummary(ledger),
    cohortCoveragePolicy: { minOutcomeCoverage: MIN_OUTCOME_COVERAGE, basis: ledger.policy.basis },
    ineligibleCohortCounts: Object.fromEntries(
      Object.entries(ledger.byHorizon).map(([h, v]) => [h, v.ineligibleCounts]),
    ),
    marketCalendarVersion: CAL.CALENDAR_VERSION,
    priceAdjustmentBasis: 'vendor-split-adjusted close + total-return index (adjDividend reinvested); raw closes preserved for cap/ADV',
    corporateActionSource: 'fmp-stable:splits+dividends',
    corporateActionStatus: `verified-split-adjusted:${b.provenanceSummary.verifiedSplitAdjusted} unverifiable(no in-window splits):${b.provenanceSummary.unverifiable} conflicts-excluded:${b.provenanceSummary.conflicts}`,
    sectorClassificationBasis: 'current-vendor-classification — NOT point-in-time; disclose in any sector-conditioned result',
    survivorship,
    rowCount: b.kept,
    securityCount: new Set(Object.values(b.out).flat().map((r) => r.lid)).size,
    listingStatusCounts: { activeNames: b.names - b.deadNamesIncluded, deadNamesIncluded: b.deadNamesIncluded },
    labelStateCounts: b.labelStatesByH,
    missingnessByFeature: missingnessByFeature(b.out),
    excludedRowCounts: { ...b.exclusions, 'label:structural-poison': b.extremeSummary.poisonedLabels, 'row:entry-bar-poisoned': b.extremeSummary.poisonedEntriesSkipped },
    knownLimitations: [
      ...(master.meta && master.meta.coverageLimitations ? master.meta.coverageLimitations : []),
      { source: 'shares-outstanding', limitation: 'weightedAverageShsOut (diluted-average approximation); availability = acceptedDate > filingDate > period+45d lag', consequence: 'market caps are approximate near share-count changes' },
      { source: 'fundamental-restatements', limitation: 'vendor may serve restated statements; original-vs-restated vintages are not distinguishable on this plan', consequence: 'as-of shares may embed restated values; amended-filing timing is approximate' },
      { source: 'sector-classification', limitation: 'current-vendor, not point-in-time', consequence: 'sector-conditioned studies are advisory only' },
      { source: 'alias-intervals', limitation: 'reconstructed from observed trading spans (vendor rename history ~3 months deep)', consequence: 'rename dates approximate to the last bar under the prior symbol' },
    ],
    supersedes,
  });

  const verdict = MF.verifySnapshotManifest(manifest, b.out, { horizons: HORIZONS, calendar });
  if (!verdict.valid) {
    fs.writeFileSync(INVALID_PATH, JSON.stringify({ status: 'invalid', panelVersion: PANEL_VERSION, generatedAt, errors: verdict.errors, stats: verdict.stats }, null, 2));
    console.error('PANEL INVALID — not published. Errors:');
    for (const e of verdict.errors) console.error(`  * ${e}`);
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify({
    generatedAt,
    panelVersion: PANEL_VERSION,
    outcomePolicyVersion: OV3.OUTCOME_POLICY_VERSION,
    unknownReasonPolicy: 'exclude',
    securityMasterVersion: master.version,
    securityMasterSource: master.source || null,
    securityMasterBuiltAt: master.builtAt || null,
    coverageLimitations: (master.meta && master.meta.coverageLimitations) || null,
    dataCutoff: b.cutoffs.labelObservationCutoff,   // legacy field: now the DERIVED label cutoff
    universeRule,
    featureTimestamping: 'all features computed from bars/filings at or before each row\'s dt (decision date); shares apply pit.asOfShares filing lag; return basis = total-return index',
    sectorBasis: 'current-vendor-classification — NOT point-in-time; disclose in any sector-conditioned result',
    labelStates: b.labelStates,
    labelStatesByHorizon: b.labelStatesByH,
    withheldDelistings: b.withheldDelistings,
    months, rows: b.kept, deadNamesIncluded: b.deadNamesIncluded,
    datasetHash,
    manifest,
    panel: b.out,
  }));
  // verification.recomputedLedger duplicates the cohort artifact — strip it
  // from the manifest report file (the artifact below is the authority).
  const { recomputedLedger, ...verdictSlim } = verdict;
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify({ manifest, verification: verdictSlim }, null, 2));
  fs.writeFileSync(CALENDAR_PATH, JSON.stringify(CAL.calendarArtifact(calendar), null, 2));
  fs.writeFileSync(COHORT_PATH, JSON.stringify(ledger, null, 2));
  fs.writeFileSync(IDENTITY_REPORT_PATH, JSON.stringify({ generatedAt, ...b.identity.report }, null, 2));
  fs.writeFileSync(EXTREMES_REPORT_PATH, JSON.stringify({ generatedAt, ...b.extremeSummary }, null, 2));
  fs.writeFileSync(COVERAGE_REPORT_PATH, JSON.stringify({
    generatedAt, universeRule,
    symbolFunnel: {
      universeSymbols: Object.keys(symbols).length,
      exclusionsBySymbol: b.exclusions,
    },
    monthlyFunnel: b.monthlyFunnel,
  }, null, 2));
  if (fs.existsSync(BLOCKED_PATH)) fs.unlinkSync(BLOCKED_PATH);
  if (fs.existsSync(INVALID_PATH)) fs.unlinkSync(INVALID_PATH);
  console.log(`Panel built (${PANEL_VERSION}/${OV3.OUTCOME_POLICY_VERSION}): ${b.kept} name-months across ${months.length} months, ${b.names} names, ${b.deadNamesIncluded} confirmed-delisted names included.`);
  console.log(`datasetHash ${datasetHash.slice(0, 16)}… supersedes ${supersedes ? supersedes.slice(0, 16) + '…' : '(none)'}`);
  console.log('cutoffs:', JSON.stringify({ ...b.cutoffs }));
  console.log('label states:', JSON.stringify(b.labelStates), 'withheld delistings:', JSON.stringify(b.withheldDelistings));
  console.log('extremes:', JSON.stringify({ events: b.extremeSummary.events, byClass: b.extremeSummary.byClass, persistenceDiagnostics: b.extremeSummary.persistenceDiagnostics, structuralPoisonedLabels: b.extremeSummary.poisonedLabels, entriesSkipped: b.extremeSummary.poisonedEntriesSkipped, sensitivityFlagged: b.extremeSummary.unconfirmedExtremeFlaggedLabels }));
  console.log('identity:', JSON.stringify({ groups: b.identity.report.resolvedGroups, multiSymbol: b.identity.report.multiSymbolGroups, quarantined: b.identity.report.quarantinedGroups, noIdentity: b.identity.report.noIdentitySymbols }));
  console.log('cohorts:', JSON.stringify(Object.fromEntries(Object.entries(ledger.byHorizon).map(([h, v]) => [h, {
    lastFullyObserved: v.lastFullyObservedCohortDate, eligible: v.eligibleCohorts, ineligible: v.ineligibleCounts,
  }]))));
  console.log('build:', JSON.stringify({ codeCommit: (git.codeCommit || 'NULL').slice(0, 12), dirty: git.worktreeDirty, reproducibility: manifest.build.reproducibility }));
  console.log('survivorship:', survivorship.status);
}

module.exports = {
  labelFieldsV3, buildPanel, classifyInstrument, lastLabelReadyByHorizon,
  buildPanelCalendar, hashPartitionDir, gitBuildFacts,
  OUT_PATH, BLOCKED_PATH, INVALID_PATH, MANIFEST_PATH, CALENDAR_PATH, COHORT_PATH,
  GRID, HORIZONS, STATUS_CHAR, PANEL_VERSION, MIN_OUTCOME_COVERAGE,
};
if (require.main === module) main();

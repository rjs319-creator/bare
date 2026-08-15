'use strict';
// CATALYST–FLOW — STEP 2: FROZEN FEATURE SNAPSHOTS.
//
//   node research/89-catalyst-flow-features.js
//
// Reads the immutable event ledger and emits ONE dataset row per event, containing only
// information observable at that event's feature cutoff, plus the five-session net target
// under all three declared cost cases and the within-date relevance grade.
//
// WHAT MAKES THIS LEAKAGE-SAFE, CONCRETELY:
//   • Every bar-derived value is computed from an INDEX into an ascending series, capped
//     at the confirmation session. There is no date arithmetic that can reach forward.
//   • Pre-event momentum ends at the announcement anchor, so an event's own reaction never
//     becomes its own "prior trend".
//   • Abnormal volume is measured against the twenty sessions BEFORE the confirmation
//     session, never including it.
//   • Relevance grades are assigned WITHIN one decision date. No percentile boundary is
//     ever computed across dates.
//   • The target is benchmarked against the issuer's SECTOR ETF. There is no SPY fallback:
//     an event whose sector benchmark is unresolved is DROPPED.
//   • Family C (signed options) is emitted as explicit nulls with coverage:false. Nothing
//     is zero-filled, so a model cannot read "no data" as "balanced flow".
//
// Costs are computed from decision-time dollar volume only. Scalers, winsorisation and
// imputation are NOT applied here — they belong inside the training fold, and doing any of
// them at dataset-build time would fit them on the test period.

const fs = require('node:fs');
const path = require('node:path');
const K = require('./lib/experiment-kit');
const FEAT = require('../lib/catalyst-flow/features');
const LABELS = require('../lib/catalyst-flow/labels');
const SIGNED = require('../lib/catalyst-flow/options-signed');
const CLOCKM = require('../lib/catalyst-flow/clock');
const REGISTRY = require('../lib/catalyst-flow/registry');
const CFG = require('../lib/catalyst-flow/config');

const OUT_DIR = path.join(K.DATA_DIR, 'catalyst-flow');
const LEDGER_PATH = path.join(OUT_DIR, 'events.jsonl');
const DATASET_PATH = path.join(OUT_DIR, 'dataset.jsonl');
const DATASET_MANIFEST = path.join(OUT_DIR, 'dataset-manifest.json');

const readLedger = () => fs.readFileSync(LEDGER_PATH, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// Standardised surprise. The denominator is the issuer's OWN trailing dispersion of past
// surprises, NOT the estimate level — dividing by a near-zero EPS estimate manufactures
// enormous "surprises" for companies that happen to be near break-even, which is the
// classic way this feature becomes a low-price proxy.
//
// PIT by construction: only surprises from STRICTLY EARLIER events enter the dispersion.
function standardisedSurprise(history, i, key) {
  const prior = [];
  for (let k = Math.max(0, i - 12); k < i; k++) {
    const h = history[k];
    if (h && Number.isFinite(h[key])) prior.push(h[key]);
  }
  if (prior.length < 4) return null;
  const m = prior.reduce((s, v) => s + v, 0) / prior.length;
  const sd = Math.sqrt(prior.reduce((s, v) => s + (v - m) ** 2, 0) / (prior.length - 1));
  const cur = history[i] && history[i][key];
  if (!Number.isFinite(cur)) return null;
  // Floor the denominator on the issuer's own scale so a freak run of identical surprises
  // cannot divide by ~0. Preregistered; not tuned.
  const denom = Math.max(sd, Math.abs(m) * 0.10, 1e-3);
  return Math.max(-8, Math.min(8, (cur - m) / denom));
}

// ── FINRA short interest, made usable ONLY after publication ────────────────
// The archive is keyed by SETTLEMENT date, which is not when anyone could act on it.
// FINRA publishes roughly eight business days after settlement; we use TEN SESSIONS on the
// observed session axis, which is conservative in the safe direction. A figure is visible
// to a decision only when its derived publication session is at or before the decision.
//
// The lag is DERIVED, not a vendor timestamp, and is stamped as such — this is an
// approximation that is declared rather than one that is hidden. (FINRA daily short
// VOLUME is a different series entirely and is not used anywhere here.)
const SI_PUBLICATION_LAG_SESSIONS = 10;

function buildShortInterestIndex(sessions) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(path.join(K.DATA_DIR, 'short-interest.json'), 'utf8')); } catch { return null; }
  if (!raw || !raw.byDate) return null;
  const idxOf = (iso) => CLOCKM.sessionIndexAtOrBefore(sessions, iso);
  const vintages = Object.keys(raw.byDate).sort().map((settlement) => {
    const si = idxOf(settlement);
    const pubIdx = si >= 0 ? si + SI_PUBLICATION_LAG_SESSIONS : -1;
    return { settlement, publicationSession: pubIdx >= 0 && pubIdx < sessions.length ? sessions[pubIdx] : null, rows: raw.byDate[settlement] };
  }).filter((v) => v.publicationSession);
  return {
    vintages,
    // Latest vintage PUBLISHED at or before `decisionDate` — never the one that merely
    // settled before it.
    asOf(decisionDate, symbol) {
      let best = null;
      for (const v of vintages) {
        if (v.publicationSession > decisionDate) break;
        if (v.rows[symbol]) best = v;
      }
      if (!best) return null;
      const r = best.rows[symbol];
      return Number.isFinite(r.dtc)
        ? { daysToCover: r.dtc, publishedByCutoff: true, settlementDate: best.settlement, publicationSession: best.publicationSession, publicationTimestampBasis: 'DERIVED_LAG_10_SESSIONS' }
        : null;
    },
  };
}

function main() {
  const t0 = Date.now();
  const ledger = readLedger();
  if (!ledger.length) throw new Error(`empty ledger at ${LEDGER_PATH} — run research/88 first`);

  const spy = K.loadSeries(path.join(K.CACHE_DIR, 'SPY.json'));
  const sessions = spy.map((b) => b.date);
  const spyIdx = new Map(sessions.map((d, i) => [d, i]));

  // Benchmark series, loaded ONCE through the same loader the stocks use.
  const benchCache = new Map();
  const benchOf = (etf) => {
    if (!benchCache.has(etf)) {
      const s = K.loadSeries(path.join(K.CACHE_DIR, `${etf}.json`));
      benchCache.set(etf, s ? { candles: s, idx: new Map(s.map((b, i) => [b.date, i])) } : null);
    }
    return benchCache.get(etf);
  };
  const seriesCache = new Map();
  const seriesOf = (sym) => {
    if (!seriesCache.has(sym)) {
      const s = K.loadSeries(path.join(K.CACHE_DIR, `${sym}.json`));
      seriesCache.set(sym, s ? { candles: s, idx: new Map(s.map((b, i) => [b.date, i])) } : null);
    }
    return seriesCache.get(sym);
  };

  // Surprise history per symbol, in chronological order, so the trailing dispersion for
  // event i can only see events < i.
  const bySymbol = new Map();
  for (const e of ledger) {
    if (!bySymbol.has(e.symbol)) bySymbol.set(e.symbol, []);
    bySymbol.get(e.symbol).push(e);
  }
  for (const [, evs] of bySymbol) evs.sort((a, b) => (a.decisionDate < b.decisionDate ? -1 : 1));

  const sameDayCount = new Map();
  for (const e of ledger) sameDayCount.set(e.decisionDate, (sameDayCount.get(e.decisionDate) || 0) + 1);

  // Family C is unavailable everywhere in this build. The report is produced from the
  // interface, so the dataset cannot disagree with what the app tells a user.
  const signedCoverage = SIGNED.coverageReport(null);
  const siIndex = buildShortInterestIndex(sessions);

  const rows = [];
  const attrition = {};
  const bump = (k) => { attrition[k] = (attrition[k] || 0) + 1; };

  for (const [sym, evs] of bySymbol) {
    const s = seriesOf(sym);
    if (!s) { bump('no-price-series'); continue; }

    // Surprise history in the raw units the standardiser consumes.
    const hist = evs.map((e) => ({
      epsSurprise: (Number.isFinite(e.epsActual) && Number.isFinite(e.epsConsensusPreRelease)) ? e.epsActual - e.epsConsensusPreRelease : null,
      revSurprise: (Number.isFinite(e.revenueActual) && Number.isFinite(e.revenueConsensusPreRelease)) ? (e.revenueActual - e.revenueConsensusPreRelease) / Math.max(1, Math.abs(e.revenueConsensusPreRelease)) : null,
    }));

    evs.forEach((e, i) => {
      const dq = e.dataQuality || {};
      const bench = benchOf(dq.benchmark);
      if (!bench) { bump('no-benchmark-series'); return; }

      const confIdx = s.idx.get(dq.confirmationSession);
      const entryIdx = s.idx.get(dq.entrySession);
      const benchEntryIdx = bench.idx.get(dq.entrySession);
      const spyConfIdx = spyIdx.get(dq.confirmationSession);
      const benchConfIdx = bench.idx.get(dq.confirmationSession);
      if (confIdx == null || entryIdx == null) { bump('missing-session-bar'); return; }
      if (benchEntryIdx == null) { bump('benchmark-missing-entry-bar'); return; }

      const announcementIdx = CLOCKM.sessionIndexAtOrBefore(s.candles.map((b) => b.date), e.providerEventTimestamp.slice(0, 10));

      // ── Family A (EXPLORATORY here — the consensus is a post-release snapshot) ──
      const A = Object.fromEntries(REGISTRY.NAMES_BY_FAMILY[REGISTRY.FAMILY.A].map((n) => [n, null]));
      A.epsSurpriseStd = standardisedSurprise(hist, i, 'epsSurprise');
      A.revenueSurpriseStd = standardisedSurprise(hist, i, 'revSurprise');
      if (Number.isFinite(A.epsSurpriseStd) && Number.isFinite(A.revenueSurpriseStd)) {
        A.surpriseSignAgreement = Math.sign(A.epsSurpriseStd) === Math.sign(A.revenueSurpriseStd) ? 1 : -1;
      }
      A.fridayAnnouncement = new Date(`${e.providerEventTimestamp.slice(0, 10)}T00:00:00Z`).getUTCDay() === 5 ? 1 : 0;
      A.sameDayEventCount = sameDayCount.get(e.decisionDate) || null;
      // Guidance, analyst actions, tone, transcripts and text novelty need feeds this
      // build does not have. They stay null — the registry's `leave-missing` contract.

      // ── Family B (genuinely observable from bars) ──
      const B = FEAT.familyB({
        bars: s.candles, confIdx, announcementIdx,
        spy, spyConfIdx,
        sector: dq.sector, sectorBars: bench.candles, sectorConfIdx: benchConfIdx,
      });

      // ── Family C (absent; explicit nulls, coverage false) ──
      const C = SIGNED.missingVector();

      // ── Family D ──
      const D = FEAT.familyD({
        bars: s.candles, confIdx,
        shortInterest: siIndex ? siIndex.asOf(e.decisionDate, sym) : null,
      });

      const features = FEAT.buildFeatureRow({
        familyAValues: A, familyBValues: B, familyCValues: C, familyDValues: D,
        pitClass: e.pitClass,
      });

      // ── Targets, all three cost cases ──
      const targets = {};
      let dropped = null;
      for (const c of Object.keys(CFG.COST_CASES)) {
        const t = LABELS.netTarget({
          bars: s.candles, benchmarkBars: bench.candles,
          entryIdx, benchmarkEntryIdx: benchEntryIdx,
          dollarVolumeAtDecision: dq.dollarVolumeAtDecision,
          costCase: c,
        });
        if (t.value == null) { dropped = t.reason; break; }
        targets[c] = t.value;
        if (c === CFG.PRIMARY_COST_CASE) targets._parts = t.parts;
      }
      if (dropped) { bump(`target:${dropped}`); return; }

      rows.push({
        key: `${e.symbol}|${e.decisionDate}`,
        eventId: e.eventId,
        symbol: e.symbol,
        decisionDate: e.decisionDate,
        entrySession: dq.entrySession,
        exitSession: dq.exitSession,
        sector: dq.sector,
        benchmark: dq.benchmark,
        pitClass: e.pitClass,
        observedAfterCutoff: dq.observedAfterCutoff === true,
        dollarVolumeAtDecision: dq.dollarVolumeAtDecision,
        features,
        targets,
      });
    });
  }

  // ── One-position-per-symbol: a name in an open five-session hold cannot re-enter ──
  const clocks = rows.map((r) => ({
    symbol: r.symbol, key: r.key,
    entryIdx: spyIdx.get(r.entrySession),
    exitIdx: spyIdx.get(r.exitSession),
  })).filter((c) => c.entryIdx != null && c.exitIdx != null);
  const { admitted, rejected } = CLOCKM.admitOnePositionPerSymbol(clocks);
  const admittedKeys = new Set(admitted.map((c) => c.key));
  const overlapRejected = rejected.length;
  const finalRows = rows.filter((r) => admittedKeys.has(r.key));

  // ── Relevance grades, WITHIN each decision date ──
  const byDate = new Map();
  for (const r of finalRows) {
    if (!byDate.has(r.decisionDate)) byDate.set(r.decisionDate, []);
    byDate.get(r.decisionDate).push(r);
  }
  const gradeRules = {};
  for (const [date, cohort] of byDate) {
    const g = LABELS.gradeCohort(cohort.map((r) => ({ key: r.key, target: r.targets[CFG.PRIMARY_COST_CASE] })));
    gradeRules[g.rule] = (gradeRules[g.rule] || 0) + 1;
    const byKey = new Map(g.grades.map((x) => [x.key, x.grade]));
    for (const r of cohort) r.grade = byKey.get(r.key) ?? null;
  }

  finalRows.sort((a, b) => (a.decisionDate < b.decisionDate ? -1 : a.decisionDate > b.decisionDate ? 1 : a.symbol.localeCompare(b.symbol)));
  fs.writeFileSync(DATASET_PATH, finalRows.map((r) => JSON.stringify(r)).join('\n') + (finalRows.length ? '\n' : ''));

  // Per-feature coverage: how often is each declared column actually populated? This is
  // the table that stops a feature from being "in the model" while being null 98% of the time.
  const coverage = {};
  for (const name of Object.keys(REGISTRY.BY_NAME)) {
    const n = finalRows.filter((r) => r.features[name] !== null && r.features[name] !== undefined).length;
    coverage[name] = { populated: n, share: finalRows.length ? +(n / finalRows.length).toFixed(4) : 0, family: REGISTRY.BY_NAME[name].family };
  }
  const dates = [...new Set(finalRows.map((r) => r.decisionDate))].sort();
  const cohortSizes = [...byDate.values()].map((c) => c.length);

  const manifest = {
    version: 'catalyst-dataset-manifest-v1',
    featureRegistryVersion: REGISTRY.REGISTRY_VERSION,
    featureBuilderVersion: FEAT.FEATURE_BUILDER_VERSION,
    labelVersion: LABELS.LABEL_VERSION,
    builtAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    ledgerEvents: ledger.length,
    datasetRows: finalRows.length,
    decisionDates: dates.length,
    dateRange: { first: dates[0] || null, last: dates[dates.length - 1] || null },
    cohortSize: {
      mean: cohortSizes.length ? +(cohortSizes.reduce((a, b) => a + b, 0) / cohortSizes.length).toFixed(2) : null,
      median: cohortSizes.length ? cohortSizes.slice().sort((a, b) => a - b)[cohortSizes.length >> 1] : null,
      max: cohortSizes.length ? Math.max(...cohortSizes) : null,
    },
    gradeRules,
    overlapRejected,
    attrition,
    featureCoverage: coverage,
    signedOptions: signedCoverage,
    honesty: {
      pitClassCounts: finalRows.reduce((a, r) => { a[r.pitClass] = (a[r.pitClass] || 0) + 1; return a; }, {}),
      observedAfterCutoff: finalRows.filter((r) => r.observedAfterCutoff).length,
      scalersFitInFoldOnly: true,
      benchmarkIsSector: true,
      spyFallbackUsed: false,
      spreadIsProxy: true,
      shortInterest: siIndex
        ? { vintages: siIndex.vintages.length, publicationTimestampBasis: 'DERIVED_LAG_10_SESSIONS', settlementDateUsedDirectly: false }
        : { vintages: 0, reason: 'no short-interest archive on disk' },
    },
  };
  fs.writeFileSync(DATASET_MANIFEST, JSON.stringify(manifest, null, 2) + '\n');

  // The feature schema the offline trainer consumes. Emitted from the REGISTRY rather than
  // from the dataset's own columns, so the trainer cannot silently pick up a column the
  // registry never declared — and so E2's exclusion of family C is enforced in one place.
  const schema = {
    version: REGISTRY.REGISTRY_VERSION,
    generatedAt: new Date().toISOString(),
    primaryCostCase: CFG.PRIMARY_COST_CASE,
    costCases: Object.keys(CFG.COST_CASES),
    holdSessions: CFG.CLOCK.holdSessions,
    validation: CFG.VALIDATION,
    arms: Object.fromEntries(Object.keys(REGISTRY.ARM_FEATURE_FAMILIES).map((a) => [a, REGISTRY.featureNamesForArm(a)])),
    categorical: ['sectorId'],
    // Columns that are 100% null in this build. Reported so the trainer can state which
    // declared features it is actually able to use, instead of listing aspirations.
    emptyColumns: Object.entries(coverage).filter(([, v]) => v.populated === 0).map(([k]) => k),
  };
  fs.writeFileSync(path.join(OUT_DIR, 'feature-schema.json'), JSON.stringify(schema, null, 2) + '\n');
  process.stdout.write(`${JSON.stringify({ ...manifest, featureCoverage: '(see manifest)' }, null, 2)}\n`);
  process.stdout.write(`dataset → ${DATASET_PATH}\nmanifest → ${DATASET_MANIFEST}\n`);
}

main();

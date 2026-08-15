'use strict';
// NEGATIVE-SIGNAL OVERLAY — does the app's reliably-NEGATIVE evidence pay when used as
// subtraction (exclusion filters) or inversion (short side)?
//
//   node research/93-negative-overlay.js
//
// Motivation (recorded before running): every ranking arm ever built here, forced to hold
// names, loses −79..−84 bps/cohort (p≈0.001). The surviving findings are all AVOID-shaped
// (gap+trend template −0.21R, fade-the-loudest, DTC≥7 risk flag, momentum-chase reversion).
// This experiment asks the only two questions that evidence licenses:
//   A. EXCLUSION — does removing predeclared "reliably bad" names from a top-10 event book
//      improve the book's net sector-relative 5-session return on identical dates?
//   B. SHORT    — is the forced top-10's negative return a tradeable short after realistic
//      short-side frictions?
//
// Data: the catalyst-flow dataset (research/data/catalyst-flow/dataset.jsonl) — 5-session
// net sector-relative targets, frozen features, 1,061 decision dates. The base score and
// all filters are MODEL-FREE frozen definitions (nothing is fitted), so the full dataset
// is usable without fold restrictions; the F3 percentile is computed within each date's
// cohort only. pitClass caveat inherited from the dataset: family-A features are
// RECONSTRUCTED_EXPLORATORY, so this whole experiment is EXPLORATORY evidence.
//
// Everything in FROZEN below was declared before any outcome was computed.

const fs = require('node:fs');
const path = require('node:path');
const K = require('./lib/experiment-kit');
const CH = require('../lib/catalyst-flow/challengers');
const PORT = require('../lib/catalyst-flow/portfolio');
const S3 = require('../lib/research/stats-v3');

const DATASET = path.join(__dirname, 'data', 'catalyst-flow', 'dataset.jsonl');
const OUT_DIR = path.join(__dirname, 'data', 'negative-overlay');
const PRIMARY = 'liquidityAware';
const HOLD = 5;

const FROZEN = Object.freeze({
  id: 'negative-overlay-2026-08',
  family: 'negative-overlay',
  declaredBeforeReadingResults: true,
  base: 'forced top-10 by transparentPeadScore (no abstention, sector cap 3) — the same forced-book construction the arms study used',
  filters: {
    // F1 is the exact predeclared flag from the catalyst config. F2/F3 are ADAPTED
    // proxies of previously-published negative findings (the dataset lacks the literal
    // trend template / cap-tier fields) and are labeled adapted, not frozen-original.
    F1_DTC7: { rule: 'features.extremeCrowdingFlag === 1 (daysToCover >= 7)', provenance: 'frozen-original (catalyst-flow config, si-overlay pass)' },
    F2_GAP10: { rule: 'features.overnightGap >= 0.10', provenance: 'ADAPTED proxy of the ≥10% gap + trend-template −0.21R AVOID (trend-catalyst-vcp-smc pass)' },
    F3_MOMCHASE: { rule: 'features.preEventReturn20 >= within-date cohort 80th percentile', provenance: 'ADAPTED proxy of large-cap momentum-chase mean-reversion (fade/finviz validation)' },
  },
  short: {
    construction: 'short every base-book name at next open, 5 sessions, hedged with the sector ETF (sector-relative by construction of the target)',
    winsorisation: 'primary uses the dataset\'s winsorised return; UNWINSORISED variant reported because winsorisation clips exactly the short\'s squeeze tail',
    costs: 'stock round trip (dataset liquidity-aware costFraction) + 4bps flat sector-ETF hedge round trip + borrow at {0.5%, 2%, 8%}/yr × 7/365 per trade; primary = 2%',
  },
  primaryTests: ['EXCL_F1_REPL', 'EXCL_F2_REPL', 'EXCL_F3_REPL', 'SHORT_TOP10@borrow2'],
  multipleTesting: 'Benjamini-Hochberg across the 4 primary tests; every secondary variant recorded in the trial count',
  promisingGate: 'BH q < 0.05 AND positive after doubled trading costs AND >= 3/4 chronological blocks positive — and even then the verdict is only RESEARCH-PROMISING (exploratory PIT class blocks anything more)',
  insufficient: 'a filter that fires on < 200 base-book slots proves nothing → INSUFFICIENT_DATA for that cell',
});

// ── load ─────────────────────────────────────────────────────────────────────
const raw = fs.readFileSync(DATASET, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const rows = raw.filter((r) => r.targets && Number.isFinite(r.targets[PRIMARY]) && r.targets._parts);
const byDate = new Map();
for (const r of rows) { if (!byDate.has(r.decisionDate)) byDate.set(r.decisionDate, []); byDate.get(r.decisionDate).push(r); }
const dates = [...byDate.keys()].sort();

// within-date 80th percentile of preEventReturn20 (PIT-safe: same-cohort only)
function momChaseCut(cohort) {
  const v = cohort.map((r) => r.features.preEventReturn20).filter(Number.isFinite).sort((a, b) => a - b);
  return v.length >= 5 ? v[Math.min(v.length - 1, Math.floor(0.8 * v.length))] : null;
}
const FILTERS = {
  F1_DTC7: (r) => r.features.extremeCrowdingFlag === 1,
  F2_GAP10: (r) => Number.isFinite(r.features.overnightGap) && r.features.overnightGap >= 0.10,
  F3_MOMCHASE: (r, cut) => cut != null && Number.isFinite(r.features.preEventReturn20) && r.features.preEventReturn20 >= cut,
  UNION: (r, cut) => FILTERS.F1_DTC7(r) || FILTERS.F2_GAP10(r) || FILTERS.F3_MOMCHASE(r, cut),
};

// forced top-10 PEAD book for one cohort, optionally excluding filtered rows first
// (replacement: next-ranked eligible names fill the freed slots).
function bookFor(cohort, excludeFn, cut) {
  const cands = [];
  for (const r of cohort) {
    if (excludeFn && excludeFn(r, cut)) continue;
    const s = CH.transparentPeadScore(r.features);
    if (!s) continue;
    cands.push({ symbol: r.symbol, sector: r.sector, score: s.score, estimatedEdge: 1, estRoundTripCostPct: 0, row: r });
  }
  const book = PORT.selectBook(cands, {});
  return book.positions || [];
}
const netOf = (pos) => pos.row.targets[PRIMARY];
const meanBook = (positions, val) => positions.length ? positions.reduce((s, p) => s + val(p), 0) / positions.length : null;

const summarize = (series, label) => {
  const vals = series.map((r) => r.value).filter(Number.isFinite);
  const s = K.summarizeByDate(series, { horizonBars: HOLD });
  if (!s || !vals.length) return null;
  const { perDateCounts, ...rest } = s;
  const avgPrecise = vals.reduce((a, b) => a + b, 0) / vals.length;
  const p = (Number.isFinite(rest.se) && rest.se > 0 && !vals.every((v) => v === vals[0])) ? S3.pFromT(avgPrecise / rest.se) : null;
  return { label, ...rest, avgPrecise: +avgPrecise.toFixed(6), avgBpsPerCohort: +(avgPrecise * 10000).toFixed(1), p };
};

// ── A. exclusion overlays ────────────────────────────────────────────────────
const baseSeries = [], filterRuns = {};
for (const key of ['F1_DTC7', 'F2_GAP10', 'F3_MOMCHASE', 'UNION']) {
  filterRuns[key] = { repl: [], shrink: [], firedSlots: 0, firedRows: 0 };
}
for (const d of dates) {
  const cohort = byDate.get(d);
  const cut = momChaseCut(cohort);
  const base = bookFor(cohort, null, cut);
  if (!base.length) continue;
  const baseVal = meanBook(base, netOf);
  baseSeries.push({ date: d, value: baseVal });
  for (const key of Object.keys(filterRuns)) {
    const fn = FILTERS[key];
    filterRuns[key].firedRows += cohort.filter((r) => fn(r, cut)).length;
    const firedInBook = base.filter((p) => fn(p.row, cut));
    filterRuns[key].firedSlots += firedInBook.length;
    // replacement: rebuild the book with filtered names ineligible
    const repl = bookFor(cohort, fn, cut);
    filterRuns[key].repl.push({ date: d, value: (meanBook(repl, netOf) ?? 0) - baseVal });
    // shrink: keep the base book, excluded slots go to cash (0), divisor stays 10-ish (base size)
    const keptSum = base.filter((p) => !fn(p.row, cut)).reduce((s, p) => s + netOf(p), 0);
    filterRuns[key].shrink.push({ date: d, value: keptSum / base.length - baseVal });
  }
}

// ── A2. filter-information diagnostics ──────────────────────────────────────
// The shrink variant of ANY filter improves a negative-mean book mechanically (cash beats
// a losing slot regardless of which slot you cut). Two diagnostics separate information
// from exposure reduction:
//   (i)  within-book contrast — on dates where the base book holds both flagged and
//        unflagged names: mean(flagged) − mean(unflagged). Information ⇒ negative.
//   (ii) placebo — same date, same NUMBER of exclusions, but chosen by a seeded
//        deterministic PRNG. filterShrink − placeboShrink per date. Information ⇒ positive.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const seedOf = (s) => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const PLACEBO_DRAWS = 20;
const contrastSeries = { F1_DTC7: [], F2_GAP10: [], F3_MOMCHASE: [] };
const placeboDiff = { F1_DTC7: [], F2_GAP10: [], F3_MOMCHASE: [] };
for (const d of dates) {
  const cohort = byDate.get(d);
  const cut = momChaseCut(cohort);
  const baseBook = bookFor(cohort, null, cut);
  if (!baseBook.length) continue;
  for (const key of Object.keys(contrastSeries)) {
    const fn = FILTERS[key];
    const flagged = baseBook.filter((p) => fn(p.row, cut));
    const clean = baseBook.filter((p) => !fn(p.row, cut));
    if (flagged.length && clean.length) {
      contrastSeries[key].push({ date: d, value: meanBook(flagged, netOf) - meanBook(clean, netOf) });
    }
    if (flagged.length) {
      const actualShrink = clean.reduce((s, p) => s + netOf(p), 0) / baseBook.length;
      const rng = mulberry32(seedOf(`${key}|${d}`));
      let placeboSum = 0;
      for (let t = 0; t < PLACEBO_DRAWS; t++) {
        const idx = baseBook.map((_, i) => i);
        for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
        const dropped = new Set(idx.slice(0, flagged.length));
        placeboSum += baseBook.reduce((s, p, i) => s + (dropped.has(i) ? 0 : netOf(p)), 0) / baseBook.length;
      }
      placeboDiff[key].push({ date: d, value: actualShrink - placeboSum / PLACEBO_DRAWS });
    }
  }
}

// ── B. short the base book ───────────────────────────────────────────────────
const HEDGE_RT = 0.0004;
const borrowPerTrade = (annual) => annual * (7 / 365);
function shortVal(pos, borrowAnnual, winsorised) {
  const t = pos.row.targets._parts;
  const gross = -((winsorised ? t.winsorisedReturn : t.rawReturn) - t.benchmarkReturn);
  return gross - t.costFraction - HEDGE_RT - borrowPerTrade(borrowAnnual);
}
const shortSeries = { b05: [], b2: [], b8: [], b2unwins: [] };
for (const d of dates) {
  const base = bookFor(byDate.get(d), null, momChaseCut(byDate.get(d)));
  if (!base.length) continue;
  shortSeries.b05.push({ date: d, value: meanBook(base, (p) => shortVal(p, 0.005, true)) });
  shortSeries.b2.push({ date: d, value: meanBook(base, (p) => shortVal(p, 0.02, true)) });
  shortSeries.b8.push({ date: d, value: meanBook(base, (p) => shortVal(p, 0.08, true)) });
  shortSeries.b2unwins.push({ date: d, value: meanBook(base, (p) => shortVal(p, 0.02, false)) });
}

// ── inference + FDR over the declared primaries ──────────────────────────────
const base = summarize(baseSeries, 'BASE_TOP10_PEAD');
const results = {
  EXCL_F1_REPL: summarize(filterRuns.F1_DTC7.repl, 'EXCL_F1_REPL'),
  EXCL_F2_REPL: summarize(filterRuns.F2_GAP10.repl, 'EXCL_F2_REPL'),
  EXCL_F3_REPL: summarize(filterRuns.F3_MOMCHASE.repl, 'EXCL_F3_REPL'),
  'SHORT_TOP10@borrow2': summarize(shortSeries.b2, 'SHORT_TOP10@borrow2'),
};
const diagnostics = {};
for (const key of ['F1_DTC7', 'F2_GAP10', 'F3_MOMCHASE']) {
  diagnostics[`CONTRAST_${key}`] = summarize(contrastSeries[key], `CONTRAST_${key} (flagged − unflagged within base book)`);
  diagnostics[`PLACEBO_${key}`] = summarize(placeboDiff[key], `PLACEBO_${key} (filter shrink − random-exclusion shrink, ${PLACEBO_DRAWS} seeded draws)`);
}
const secondaries = {
  EXCL_F1_SHRINK: summarize(filterRuns.F1_DTC7.shrink, 'EXCL_F1_SHRINK'),
  EXCL_F2_SHRINK: summarize(filterRuns.F2_GAP10.shrink, 'EXCL_F2_SHRINK'),
  EXCL_F3_SHRINK: summarize(filterRuns.F3_MOMCHASE.shrink, 'EXCL_F3_SHRINK'),
  EXCL_UNION_REPL: summarize(filterRuns.UNION.repl, 'EXCL_UNION_REPL'),
  'SHORT@borrow0.5': summarize(shortSeries.b05, 'SHORT@borrow0.5'),
  'SHORT@borrow8': summarize(shortSeries.b8, 'SHORT@borrow8'),
  'SHORT@borrow2_UNWINSORISED': summarize(shortSeries.b2unwins, 'SHORT@borrow2_UNWINSORISED'),
};
const fired = Object.fromEntries(Object.entries(filterRuns).map(([k, v]) => [k, { slotsExcludedFromBooks: v.firedSlots, rowsFlaggedInCohorts: v.firedRows }]));
const insufficient = (k) => k.startsWith('EXCL_F') && fired[k.slice(5, 7) === 'F1' ? 'F1_DTC7' : k.includes('F2') ? 'F2_GAP10' : 'F3_MOMCHASE'].slotsExcludedFromBooks < 200;

const fdrItems = FROZEN.primaryTests
  .map((id) => ({ id, p: results[id] && results[id].p }))
  .filter((x) => Number.isFinite(x.p));
const fdrOut = K.fdr(fdrItems, { alpha: 0.05 });

const verdictOf = (id) => {
  const r = results[id];
  if (!r) return 'NO_SERIES';
  if (insufficient(id)) return 'INSUFFICIENT_DATA (filter fired on too few slots)';
  const q = fdrOut.find((x) => x.id === id)?.q ?? null;
  const survives = q != null && q < 0.05 && r.avgPrecise > 0;
  const stable = r.blockStability && r.blockStability.blocks >= 4 && r.blockStability.positive >= 3;
  if (survives && stable) return 'RESEARCH_PROMISING (exploratory PIT class — not promotable)';
  return r.avgPrecise > 0 ? 'POSITIVE_BUT_NOT_SIGNIFICANT' : 'NO_IMPROVEMENT';
};

const out = {
  version: 'negative-overlay-v1', ranAt: new Date().toISOString(),
  frozen: FROZEN,
  datasetSha256: K.sha ? undefined : undefined,
  cohorts: { dates: baseSeries.length, rows: rows.length },
  base, results, secondaries, diagnostics, fired, fdr: fdrOut,
  verdicts: Object.fromEntries(FROZEN.primaryTests.map((id) => [id, verdictOf(id)])),
};
const art = K.writeArtifact(OUT_DIR, 'negative-overlay-result.json', out);
K.recordExperiment({
  id: FROZEN.id, hypothesis: 'The app\'s robust NEGATIVE findings pay as subtraction (exclusion overlays on a top-10 event book) or inversion (shorting the forced book) net of realistic frictions.',
  family: FROZEN.family, frozenConfig: FROZEN,
  dataSnapshot: { dates: baseSeries.length, rows: rows.length, pitClass: 'RECONSTRUCTED_EXPLORATORY (inherited from the catalyst dataset)' },
  trialCount: FROZEN.primaryTests.length + Object.keys(secondaries).length,
  results: { base, primaries: results, secondaries, diagnostics, fired, fdr: fdrOut, verdicts: out.verdicts },
  artifact: art,
});
console.log(JSON.stringify({ base: base && { bps: base.avgBpsPerCohort, p: base.p }, verdicts: out.verdicts, fired, primaries: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v && { bps: v.avgBpsPerCohort, p: v.p, blocks: v.blockStability }])) }, null, 1));

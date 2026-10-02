'use strict';
// EXPORT the dates × variants matrices the site's overfit gates consume, as JSON, so an
// independent implementation (research/101-overfit-crosscheck.py: purgedcv + arch) can
// recompute PBO / PSR / DSR / MinBTL and run SPA / RealityCheck / StepM on the SAME inputs.
//
//   node research/lib/export-pbo-matrices.js --resolved <shadow-resolved.json> --picks <picks.json>
//   node research/lib/export-pbo-matrices.js            # with BLOB_READ_WRITE_TOKEN: reads the store
//
// Two matrices:
//   challenger.json      — one row per prediction date, one column per logged variant score,
//                          cell = that variant's Spearman rank-IC over that date's cross-section
//                          (exactly what lib/challenger-eval pboOverVariants feeds lib/research/pbo).
//   screener-family.json — one row per decision date, one column per Scoreboard section,
//                          cell = that section's mean next-open SPY-excess (%) at `bars` sessions;
//                          the benchmark (SPY) is identically zero on this basis. This is the
//                          "N screeners vs one benchmark" family SPA/StepM need.
// Plus the per-pick rows (JS reference returns) for research/103-vbt-scoreboard-parity.py.
// The JS verdict is written next to each matrix so the Python side has a target to diff.

const fs = require('node:fs');
const path = require('node:path');
const RQ = require('../../lib/rankquality');
const PBO = require('../../lib/research/pbo');
const EVAL = require('../../lib/challenger-eval');
const APEX = require('../../lib/apex-routes');
const K = require('./experiment-kit');

const EXPORT_VERSION = 'pbo-matrix-export-v1';
const DEFAULT_OUT = path.join(__dirname, '..', 'data-derived', 'pbo-matrices');
const PICK_EXPORT = path.join(K.DATA_DIR, 'pick-ledger-export.json');
const VARIANT_KEYS = ['residualScore', 'baselineProd', 'baselineOmega', 'baselineMomentum'];
const MIN_COVERAGE = 0.9;
const HORIZONS = [1, 5, 10, 20];
const MIN_PICKS_PER_CELL = 1;
const isNum = (v) => Number.isFinite(v);

// Mirrors lib/challenger-eval pboOverVariants, but RETURNS the matrix. The parity test
// locks PBO.pbo(matrix).pbo === pboOverVariants(preds).pbo.
function challengerMatrix(preds) {
  const rows = (preds || []).filter((p) => p && p.predDate && isNum(p.outcome));
  const covered = VARIANT_KEYS.filter((k) => rows.length > 0 && rows.filter((p) => isNum(p[k])).length / rows.length >= MIN_COVERAGE);
  if (covered.length < 2) return { dates: [], variants: covered, matrix: [], reason: `need ≥2 variant columns at ≥${MIN_COVERAGE * 100}% coverage` };
  const usable = rows.filter((p) => covered.every((k) => isNum(p[k])));
  const byDate = new Map();
  for (const p of usable) byDate.set(p.predDate, [...(byDate.get(p.predDate) || []), p]);
  const dates = [...byDate.keys()].sort();
  const matrix = dates.map((d) => covered.map((k) => {
    const ic = RQ.informationCoefficient(byDate.get(d).map((p) => ({ score: p[k], outcome: p.outcome }))).ic;
    return isNum(ic) ? ic : null;
  }));
  // pbo() drops rows with any non-finite cell; export the same filtered view.
  const keep = matrix.map((r) => r.every(isNum));
  return {
    dates: dates.filter((_, i) => keep[i]), variants: covered, matrix: matrix.filter((_, i) => keep[i]),
    measure: "per-date Spearman rank-IC of each variant's score over that date's own cross-section",
  };
}

// Per-pick JS reference returns (the Scoreboard's own functions) → rows for vectorbt parity.
function pickRows(picks, candlesByTicker, spyCandles) {
  const out = [];
  for (const p of picks || []) {
    if (!p || !p.ticker || !p.date || !p.section) continue;
    const candles = candlesByTicker.get(p.ticker);
    if (!candles) continue;
    const entryBasis = APEX.entryBasisForSection(p.section) || 'next-open';
    const ret = {}, spy = {}, excess = {};
    for (const h of HORIZONS) {
      ret[h] = APEX.nextOpenReturn(candles, p, h);
      spy[h] = APEX.spyForwardReturn(spyCandles, p, h, { entryBasis: 'next-open' });
      excess[h] = isNum(ret[h]) && isNum(spy[h]) ? +(ret[h] - spy[h]).toFixed(4) : null;
    }
    out.push({ ticker: p.ticker, date: p.date, section: p.section, tier: p.tier || null, short: !!(p.short || p.tier === 'StrongSell'), entryBasis, ret, spy, excess });
  }
  return out;
}

// dates × sections, cell = mean excess (%) of that section's picks decided that date.
function screenerFamilyMatrix(rows, bars) {
  const sections = [...new Set(rows.map((r) => r.section))].sort();
  const byDate = new Map();
  for (const r of rows) {
    if (!isNum(r.excess[bars])) continue;
    const cells = byDate.get(r.date) || new Map();
    cells.set(r.section, [...(cells.get(r.section) || []), r.excess[bars]]);
    byDate.set(r.date, cells);
  }
  const dates = [...byDate.keys()].sort();
  const matrix = dates.map((d) => sections.map((s) => {
    const v = byDate.get(d).get(s);
    return v && v.length >= MIN_PICKS_PER_CELL ? +K.mean(v).toFixed(4) : null;
  }));
  return { dates, variants: sections, matrix, bars, measure: `per-date mean next-open SPY-excess (%) at ${bars} sessions; benchmark SPY ≡ 0 on this basis`, nullPolicy: 'null = section had no pick that date (Python side: treat as 0 excess — no position — for SPA; drop for PBO)' };
}

function loadCandles(tickers) {
  const out = new Map();
  for (const t of new Set(tickers)) {
    const c = K.loadSeries(path.join(K.CACHE_DIR, `${t}.json`));
    if (c) out.set(t, c);
  }
  return out;
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 1) + '\n');
  return file;
}

function exportAll({ resolved, picks, outDir = DEFAULT_OUT, pickExport = PICK_EXPORT, bars = 5 }) {
  const written = [];
  if (resolved) {
    const preds = Object.values(resolved).filter((r) => r && r.predDate);
    const m = challengerMatrix(preds);
    const js = EVAL.pboOverVariants(preds);
    written.push(writeJson(path.join(outDir, 'challenger.json'), { version: EXPORT_VERSION, name: 'challenger', generatedAt: new Date().toISOString(), ...m, js }));
  }
  if (picks && picks.length) {
    const spy = K.loadSeries(path.join(K.CACHE_DIR, 'SPY.json'));
    if (!spy) throw new Error('SPY missing from the research cache — run research/104-wiki-attention.js --pull or the FMP pull first');
    const rows = pickRows(picks, loadCandles(picks.map((p) => p.ticker)), spy);
    const fam = screenerFamilyMatrix(rows, bars);
    written.push(writeJson(path.join(outDir, 'screener-family.json'), { version: EXPORT_VERSION, name: 'screener-family', generatedAt: new Date().toISOString(), ...fam, js: PBO.pbo(fam.matrix.filter((r) => r.every(isNum))) }));
    written.push(writeJson(pickExport, { version: EXPORT_VERSION, generatedAt: new Date().toISOString(), horizons: HORIZONS, cacheDir: K.CACHE_DIR, rows }));
  }
  return written;
}

async function loadInputs(argv) {
  const arg = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  let resolved = arg('--resolved') ? read(arg('--resolved')) : null;
  let picks = arg('--picks') ? read(arg('--picks')) : null;
  if (picks && !Array.isArray(picks)) picks = picks.picks || picks.rows || [];
  if (!resolved && !picks && process.env.BLOB_READ_WRITE_TOKEN) {
    const store = require('../../lib/store');
    resolved = await store.readShadowResolved();
    picks = await store.readAllPicks();
  }
  return { resolved, picks, outDir: arg('--out') || DEFAULT_OUT, bars: Number(arg('--bars')) || 5 };
}

if (require.main === module) {
  loadInputs(process.argv.slice(2)).then((inputs) => {
    if (!inputs.resolved && !inputs.picks) {
      console.error('nothing to export: pass --resolved/--picks files or set BLOB_READ_WRITE_TOKEN');
      process.exit(2);
    }
    for (const f of exportAll(inputs)) console.log('wrote', f);
  }).catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { EXPORT_VERSION, VARIANT_KEYS, HORIZONS, challengerMatrix, pickRows, screenerFamilyMatrix, exportAll, DEFAULT_OUT, PICK_EXPORT };

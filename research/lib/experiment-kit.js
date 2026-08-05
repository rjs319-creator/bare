'use strict';
// EXPERIMENT KIT — the shared, frozen plumbing every Phase-11 runner uses.
//
// One implementation of: the local price cache, point-in-time slicing, executable
// next-open outcomes, the cost model at base/doubled/stressed levels, date-clustered
// (dependence-aware) inference, FDR across the attempted family, and the append-only
// experiment registry every attempt is recorded in — winners AND losers.
//
// WHY IT EXISTS. Each previous study re-implemented these, so results were not strictly
// comparable and a rejected hypothesis left no durable record (the same idea gets
// rediscovered). Everything here is deterministic and seeded.
//
// HONESTY LIMITS carried by every runner that uses this kit:
//   • the local cache contains delisted names whose bars simply end — the freshness gate
//     excludes them per date, which REDUCES survivorship bias but does not eliminate it.
//     `survivorshipProvenSafe` is FALSE, so nothing run here can promote anything.
//   • the live macro overlay has no point-in-time series ⇒ replays run macroRiskOff:false.
//   • name-dates with a |1-day| move > 50% are excluded as suspected unadjusted corporate
//     actions, and the count is reported.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const STATS = require('../../lib/research/stats-v3');
const ES = require('../../lib/evidence-stats');
const { roundTripCostPct } = require('../../lib/costs');

const KIT_VERSION = 'experiment-kit-v1';
const DATA_DIR = process.env.RESEARCH_DATA_DIR || path.join(__dirname, '..', 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
// The registry is COMMITTED (research/data/ is gitignored): a rejected hypothesis has to
// survive in version control, or the same idea gets rediscovered next quarter.
const REGISTRY_PATH = path.join(__dirname, '..', 'experiments', 'registry.json');
const EXTREME_1D = 0.50;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const mean = (a) => (a.length ? a.reduce((x, v) => x + v, 0) / a.length : null);

// ── Data ────────────────────────────────────────────────────────────────────
function loadSeries(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = (d.price || []).slice().reverse();          // stored newest-first → ascending
    if (rows.length < 60) return null;
    return rows.map(r => ({ date: r.date, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
  } catch { return null; }
}

function advOf(candles, lookback = 60) {
  const n = candles.length;
  let s = 0, c = 0;
  for (let i = Math.max(0, n - lookback); i < n; i++) { s += (candles[i].close || 0) * (candles[i].volume || 0); c++; }
  return c ? s / c : 0;
}

// Load the universe once. Returns { dataset: Map(ticker → {candles, idx}), spy, attrition }.
function loadUniverse({ minBars = 280, minAdv = 5e6, maxNames = 4000, exclude = new Set(['SPY.json']) } = {}) {
  const spy = loadSeries(path.join(CACHE_DIR, 'SPY.json'));
  if (!spy) throw new Error('SPY missing from the research cache');
  const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json') && !exclude.has(f));
  const dataset = new Map();
  const attrition = { scanned: files.length, tooFewBars: 0, tooIlliquid: 0, unreadable: 0, admitted: 0 };
  for (const f of files) {
    if (dataset.size >= maxNames) break;
    const candles = loadSeries(path.join(CACHE_DIR, f));
    if (!candles) { attrition.unreadable++; continue; }
    if (candles.length < minBars) { attrition.tooFewBars++; continue; }
    if (advOf(candles) < minAdv) { attrition.tooIlliquid++; continue; }
    dataset.set(f.replace(/\.json$/, ''), { candles, idx: new Map(candles.map((b, i) => [b.date, i])) });
  }
  attrition.admitted = dataset.size;
  return { dataset, spy, spyIdx: new Map(spy.map((b, i) => [b.date, i])), attrition };
}

// Bars up to and including `date` (point-in-time slice).
function sliceAsOf(candles, date) {
  let hi = -1;
  for (let i = candles.length - 1; i >= 0; i--) { if (candles[i].date <= date) { hi = i; break; } }
  return hi >= 0 ? candles.slice(0, hi + 1) : [];
}

// ── Executable outcomes ─────────────────────────────────────────────────────
// NEXT-OPEN entry → close(decision + H). Returns null when unobservable (the name's
// history ends — a delisting or a truncated series) or when an extreme 1-day move suggests
// an unadjusted corporate action. `attrition` is mutated so the loss is COUNTED.
function forwardFromNextOpen(entry, decisionDate, H, attrition = null) {
  const i = entry.idx.get(decisionDate);
  if (i == null) { if (attrition) attrition.noDecisionBar++; return null; }
  if (i + H > entry.candles.length - 1) { if (attrition) attrition.truncatedHistory++; return null; }
  const e = entry.candles[i + 1], x = entry.candles[i + H];
  if (!e || !(e.open > 0) || !(x.close > 0)) { if (attrition) attrition.badPrices++; return null; }
  for (let k = i; k < i + H && k < entry.candles.length - 1; k++) {
    const a = entry.candles[k], b = entry.candles[k + 1];
    if (a.close > 0 && Math.abs(b.close / a.close - 1) > EXTREME_1D) { if (attrition) attrition.extremeMove++; return null; }
  }
  return x.close / e.open - 1;
}

function benchmarkForward(spy, spyIdx, decisionDate, H) {
  const i = spyIdx.get(decisionDate);
  if (i == null || i + H > spy.length - 1) return null;
  const e = spy[i + 1], x = spy[i + H];
  return (e && x && e.open > 0) ? x.close / e.open - 1 : null;
}

const newAttrition = () => ({ noDecisionBar: 0, truncatedHistory: 0, badPrices: 0, extremeMove: 0, noBenchmark: 0, ineligible: 0 });

// ── Costs ───────────────────────────────────────────────────────────────────
// Round-trip friction as a FRACTION, at the three stress levels the promotion policy
// requires. Tiered by dollar volume through the app's own cost model (one model, not two).
function costFractions(dollarVol) {
  const tier = !Number.isFinite(dollarVol) ? 'micro'
    : dollarVol >= 2e7 ? 'liquid' : dollarVol >= 5e6 ? 'small' : 'micro';
  const base = roundTripCostPct(tier) / 100;
  return { tier, base, doubled: base * 2, stressed: base * 3 };
}

// ── Inference ───────────────────────────────────────────────────────────────
// Date-clustered summary of a per-date series (the ONLY independence unit we accept),
// with HAC standard errors, a seeded moving-block bootstrap, an effective sample size and
// chronological block stability. Delegates to lib/evidence-stats so the research side and
// the app side compute promotion statistics identically.
function summarizeByDate(rows, { horizonBars = null, pickValue = (r) => r.value, pickDate = (r) => r.date } = {}) {
  const ded = ES.dedupeToDateSeries(rows, { pickValue, pickDate });
  const s = ES.summarizeDateSeries(ded.series, { horizonBars });
  return s ? { ...s, dates: ded.dates.length, observations: ded.observations, perDateCounts: ded.perDateCounts } : null;
}

function pValue(summary) { return ES.pValueOf(summary); }
function fdr(items, opts) { return ES.fdrAdjust(items, opts); }

// Spearman rank IC between two paired arrays.
function rankIC(scores, outcomes) {
  const n = scores.length;
  if (n < 3) return null;
  // A constant score vector has NO ordering — an IC computed from it is an artifact of the
  // input order, not information. (Caught in the tournament: the equal-weight entrant was
  // reporting the production entrant's IC.)
  if (scores.every(v => v === scores[0])) return null;
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const out = new Array(n);
    idx.forEach(([, i], r) => { out[i] = r; });
    return out;
  };
  const rs = rank(scores), ro = rank(outcomes);
  const mr = (n - 1) / 2;
  let num = 0, ds = 0, dso = 0;
  for (let i = 0; i < n; i++) { const a = rs[i] - mr, b = ro[i] - mr; num += a * b; ds += a * a; dso += b * b; }
  return (ds > 0 && dso > 0) ? +(num / Math.sqrt(ds * dso)).toFixed(5) : null;
}

// ── Experiment registry (Phase 12) ──────────────────────────────────────────
// EVERY attempt is recorded — hypothesis, frozen config, data snapshot, code version, test
// dates, variations attempted, result, corrected significance, cost stress, decision and
// the reason. Append-only: a rejected idea must stay rejected and findable.
function recordExperiment(entry) {
  const dir = path.dirname(REGISTRY_PATH);
  fs.mkdirSync(dir, { recursive: true });
  let doc = { version: 'experiment-registry-v1', experiments: [] };
  try { doc = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')); } catch { /* first write */ }
  const row = {
    recordedAt: new Date().toISOString(),
    ...entry,
    // A rejected hypothesis is preserved as documented NEGATIVE EVIDENCE, never deleted.
    immutable: true,
  };
  doc.experiments = [...(doc.experiments || []).filter(e => e.id !== row.id), row]
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(doc, null, 2) + '\n');
  return { path: REGISTRY_PATH, total: doc.experiments.length };
}

function writeArtifact(dir, name, obj) {
  fs.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(obj, null, 2) + '\n';
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return { file, sha256: sha(body), bytes: body.length };
}

module.exports = {
  KIT_VERSION, DATA_DIR, CACHE_DIR, REGISTRY_PATH, EXTREME_1D,
  sha, mean, loadSeries, advOf, loadUniverse, sliceAsOf,
  forwardFromNextOpen, benchmarkForward, newAttrition,
  costFractions, summarizeByDate, pValue, fdr, rankIC,
  recordExperiment, writeArtifact, lcg: STATS.lcg,
};

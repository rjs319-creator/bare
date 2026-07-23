#!/usr/bin/env node
'use strict';
// ATLAS-X RESEARCH CLI — build PIT labeled events from the candle cache and run the
// baseline-ladder ranker comparison, printing per-ranker rank-IC + the fail-closed
// promotion readout.
//
// USAGE (from the project root):
//   node scripts/atlasx-research.js                 # real cached data (DATA-GATED without a Blob store)
//   node scripts/atlasx-research.js --synthetic     # deterministic offline demo (LABELED SYNTHETIC)
//   node scripts/atlasx-research.js --scope=large --horizon=swing
//
// Flags:
//   --synthetic     deterministic sin/cos candle map so the pipeline runs offline. Its
//                   output is CLEARLY LABELED synthetic and is NEVER real evidence.
//   --scope=S       candle-cache scope(s), comma-separated (default large,small)
//   --horizon=H     evolve horizon: fast | swing | position (default swing)
//   --limit=N       max tickers per scope (default 60)
//   --dates=N       number of decision dates spread across the cached window (default 24)
const path = require('path');
const {
  buildEvents, runComparison, promotionReadout,
} = require(path.join(__dirname, '..', 'lib', 'atlasx-research'));

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true];
}));
const HORIZON = (args.horizon || 'swing').toLowerCase();
const SCOPES = String(args.scope || 'large,small').split(',').map((s) => s.trim()).filter(Boolean);
const LIMIT = parseInt(args.limit, 10) || 60;
const N_DATES = parseInt(args.dates, 10) || 24;

// ── deterministic synthetic data (no RNG — index-based sin/cos only) ─────────────
function weekdayDates(n, startYmd = '2023-01-02') {
  const out = [];
  const d = new Date(`${startYmd}T00:00:00Z`);
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// A deterministic OHLCV path for one series. `phase`/`trend` vary by index so names
// differ cross-sectionally; everything is a pure function of (i, phase, trend).
function syntheticSeries(dates, { base = 100, phase = 0, trend = 0, ampl = 0.06 } = {}) {
  const candles = [];
  let prevClose = base;
  for (let i = 0; i < dates.length; i++) {
    const drift = trend * i;
    const wave = ampl * Math.sin(i / 9 + phase) + 0.4 * ampl * Math.cos(i / 4 + phase * 2);
    const close = +(base * (1 + drift) * (1 + wave)).toFixed(4);
    const open = +((prevClose + close) / 2).toFixed(4);
    const hi = +(Math.max(open, close) * (1 + 0.5 * ampl * Math.abs(Math.sin(i / 3 + phase)))).toFixed(4);
    const lo = +(Math.min(open, close) * (1 - 0.5 * ampl * Math.abs(Math.cos(i / 3 + phase)))).toFixed(4);
    const vol = Math.round(1_000_000 * (1 + 0.5 * Math.abs(Math.sin(i / 5 + phase))));
    candles.push({ date: dates[i], open, high: hi, low: lo, close, volume: vol });
    prevClose = close;
  }
  return candles;
}

function buildSynthetic() {
  const N_BARS = 170;
  const dates = weekdayDates(N_BARS);
  const tickers = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH', 'III', 'JJJ'];
  const candleMap = {};
  const sectorMap = {};
  const sector = syntheticSeries(dates, { base: 80, phase: 0.5, trend: 0.0006, ampl: 0.04 });
  tickers.forEach((t, k) => {
    candleMap[t] = syntheticSeries(dates, {
      base: 50 + 12 * k, phase: 0.7 * k, trend: (k % 3 === 0 ? 0.0011 : k % 3 === 1 ? -0.0004 : 0.0002), ampl: 0.05 + 0.01 * (k % 4),
    });
    sectorMap[t] = sector;
  });
  const spyCandles = syntheticSeries(dates, { base: 400, phase: 0.2, trend: 0.0005, ampl: 0.02 });

  // Decision dates spread across the middle of the window (leave forward room to resolve).
  const window = HORIZON === 'fast' ? 5 : HORIZON === 'position' ? 63 : 21;
  const lastDecisionIdx = N_BARS - window - 2;
  const decisionDates = [];
  for (let i = 34; i <= lastDecisionIdx; i += 3) decisionDates.push(dates[i]);
  return { candleMap, spyCandles, sectorMap, decisionDates, synthetic: true };
}

// ── real cached data (self-populating candle cache; empty in dev) ────────────────
async function buildFromCache() {
  const { loadCandleCache, cacheGet } = require(path.join(__dirname, '..', 'lib', 'candle-cache'));
  const { hasStore } = require(path.join(__dirname, '..', 'lib', 'store'));
  if (!hasStore()) return { gated: 'no Blob store configured (BLOB_READ_WRITE_TOKEN missing)' };

  let universe;
  try {
    const U = require(path.join(__dirname, '..', 'lib', 'universe'));
    universe = { large: U.LARGE || [], small: U.SMALL_CAPS || [], micro: U.MICRO_CAPS || [] };
  } catch { universe = { large: [], small: [], micro: [] }; }

  const candleMap = {};
  let spyCandles = null;
  for (const scope of SCOPES) {
    const doc = await loadCandleCache(scope);
    if (!doc) continue;
    if (!spyCandles) { const spy = cacheGet(doc, 'SPY'); if (spy && spy.candles) spyCandles = spy.candles; }
    const list = (universe[scope] || []).slice(0, LIMIT);
    for (const t of list) {
      const e = cacheGet(doc, t);
      if (e && e.candles && e.candles.length) candleMap[t] = e.candles;
    }
  }
  if (!spyCandles) return { gated: 'no SPY candles in cache (cannot residualize)' };
  if (!Object.keys(candleMap).length) return { gated: 'no cached candles for the requested scope(s)' };

  // Decision dates spread across the cached window using SPY's date axis.
  const { normalizeBars } = require(path.join(__dirname, '..', 'lib', 'atlasx-research'));
  const spyBars = normalizeBars(spyCandles);
  const window = HORIZON === 'fast' ? 5 : HORIZON === 'position' ? 63 : 21;
  const usable = spyBars.slice(34, spyBars.length - window - 1);
  const step = Math.max(1, Math.floor(usable.length / N_DATES));
  const decisionDates = [];
  for (let i = 0; i < usable.length; i += step) decisionDates.push(usable[i].date);
  return { candleMap, spyCandles, sectorMap: null, decisionDates, synthetic: false };
}

// ── report ──────────────────────────────────────────────────────────────────────
function fmt(v, pad = 8) { return (v == null ? '—' : String(v)).padStart(pad); }

function printReport(input, comparison, readout) {
  const banner = input.synthetic
    ? '  *** SYNTHETIC DATA — deterministic offline demo, NOT real evidence ***'
    : '  (real cached candles — SURVIVORSHIP-UNSAFE present-day universe)';
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('  ATLAS-X RESEARCH HARNESS —', comparison.version);
  console.log(banner);
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(`  horizon=${HORIZON}  events=${comparison.events}  distinctDates=${comparison.distinctDates}`
    + `  baseRate=${comparison.baseRate}`);
  const u = comparison.uniqueness || {};
  console.log(`  uniqueness: rawN=${u.rawN} effectiveN=${u.effectiveN} ratio=${u.uniquenessRatio}`);
  console.log('----------------------------------------------------------------------');
  console.log('  ranker                meanIC   ci90            t     p@5    p@10   lift@10');
  console.log('----------------------------------------------------------------------');
  for (const name of comparison.rankers) {
    const m = comparison.perRankerMetrics[name] || {};
    const ci = m.ci90 ? `[${fmt(m.ci90[0], 6)},${fmt(m.ci90[1], 6)}]` : '—';
    const star = comparison.champion && comparison.champion.ranker === name ? ' *' : '';
    console.log(`  ${name.padEnd(20)} ${fmt(m.meanIC, 7)} ${ci.padEnd(15)} ${fmt(m.tstat, 5)} `
      + `${fmt(m.precisionAt5, 6)} ${fmt(m.precisionAt10, 6)} ${fmt(m.liftAt10, 7)}${star}`);
  }
  console.log('----------------------------------------------------------------------');
  console.log(`  IC champion: ${comparison.champion ? comparison.champion.ranker : '—'}`
    + (comparison.champion ? ` (meanIC ${comparison.champion.meanIC})` : ''));
  console.log('\n  VERDICT (fail-closed):');
  console.log(`    survivorshipSafe   : ${comparison.verdict.survivorshipSafe}`);
  console.log(`    productionEligible : ${comparison.verdict.productionEligible}`);
  console.log(`    summary            : ${comparison.verdict.summary}`);
  console.log(`    reason             : ${comparison.verdict.survivorshipReason}`);
  console.log('\n  PROMOTION READOUT (strategy-gate PROMOTION_GATE):');
  console.log(`    atlasxTopsIC=${readout.atlasxTopsIC}  beatsProductionIC=${readout.beatsProductionIC}`
    + `  eligible=${readout.eligible}`);
  const metKeys = Object.keys(readout.met);
  for (const k of metKeys) console.log(`      [${readout.met[k] ? 'x' : ' '}] ${k}`);
  console.log(`    unmet: ${readout.unmet.join(', ') || '(none)'}`);
  console.log(`    ${readout.note}`);
  console.log('══════════════════════════════════════════════════════════════════════\n');
}

(async () => {
  try {
    const input = args.synthetic ? buildSynthetic() : await buildFromCache();
    if (input.gated) {
      console.log('\n[ATLAS-X research] DATA-GATED:', input.gated);
      console.log('  Run with --synthetic for a deterministic offline demo of the pipeline.\n');
      process.exit(0);
    }
    const events = buildEvents({
      candleMap: input.candleMap, spyCandles: input.spyCandles,
      sectorMap: input.sectorMap, decisionDates: input.decisionDates, horizon: HORIZON,
    });
    if (!events.length) {
      console.log('\n[ATLAS-X research] DATA-GATED: no events survived PIT/history filters '
        + '(insufficient bars). Nothing fabricated.\n');
      process.exit(0);
    }
    const comparison = runComparison(events, { universePolicy: input.synthetic ? 'SYNTHETIC (not a real universe)' : undefined });
    const readout = promotionReadout(comparison);
    printReport(input, comparison, readout);
    process.exit(0);
  } catch (e) {
    console.error('[ATLAS-X research] ERROR:', e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();

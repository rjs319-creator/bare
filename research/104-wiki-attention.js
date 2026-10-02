'use strict';
// Step 104 — WIKIPEDIA PAGEVIEW ATTENTION REVERSAL (proposal #19, RESEARCH-ONLY).
//   node research/104-wiki-attention.js --pull     # Wikidata map + Yahoo prices + pageviews → research/data
//   node research/104-wiki-attention.js --study    # the ONE exploratory pass (writes registry + summary)
//   node research/104-wiki-attention.js --study --dry   # counts and cells only, no registry write
//
// Hypothesis (docs/GITHUB-RESOURCE-SCAN-2026-10-02.md #19, Da–Engelberg–Gao): a top-decile
// 7-day pageview z-spike on a name whose |5-session return| is still < 1 ATR is followed by
// NEGATIVE 21-session SPY-excess from the next open. Placebo = the same spikes dated +30
// calendar days. Every parameter is frozen below; the primary cell is declared before the
// run; the other cells are observations under one BH family.

const fs = require('node:fs');
const path = require('node:path');
const K = require('./lib/experiment-kit');
const CORE = require('./lib/wiki-attention-core');
const WD = require('./lib/wikidata-tickers');
const PV = require('./lib/wiki-pageviews');
const YH = require('./lib/yahoo-history');

const STUDY_ID = 'wiki-attention-reversal-2026-10';
const PAGEVIEWS_DIR = path.join(K.DATA_DIR, 'wiki-pageviews');
const MAP_FILE = path.join(K.DATA_DIR, 'wiki-ticker-map.json');
const OUT_DIR = path.join(__dirname, 'data-derived', 'wiki-attention');

const FROZEN = Object.freeze({
  study: STUDY_ID,
  attention: { window: 7, baseline: 60, decile: 0.10, minZ: 0 },
  quietFilter: { returnSessions: 5, atrSessions: 14, maxAtrMultiple: 1.0 },
  horizons: [5, 21, 63],
  primary: { variant: 'quiet', H: 21 },
  variants: ['quiet', 'all'],
  cooldownSessions: 21,
  placeboShiftDays: 30,
  universe: { minAdv: 2e6, maxNames: 2000, minBars: 280 },
  eligibility: { minPriorBars: 60, minClose: 2 },
  blocks: 4,
  fdrAlpha: 0.10,
  gates: { minEvents: 100, minDates: 40, minT: 2.0, minNegativeBlocks: 3 },
  expectedDirection: 'negative',
});

const r4 = (x) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(4));
const args = new Set(process.argv.slice(2));

// ── Universe: the app's curated lists (research/data has no FMP cache locally) ─────────
function curatedUniverse() {
  const U = require('../lib/universe');
  return [...new Set([...Object.keys(U.SECTOR_OF), ...U.THEMES, ...U.BIOTECH])].filter((t) => /^[A-Z][A-Z0-9-]{0,5}$/.test(t)).sort();
}

async function pull() {
  const symbols = curatedUniverse();
  console.log(`[pull] curated universe: ${symbols.length} names`);
  let map;
  if (fs.existsSync(MAP_FILE)) {
    map = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
    console.log(`[pull] ticker map cached: ${Object.keys(map.map).length} tickers`);
  } else {
    map = await WD.fetchTickerMap();
    fs.mkdirSync(K.DATA_DIR, { recursive: true });
    fs.writeFileSync(MAP_FILE, JSON.stringify(map));
    console.log(`[pull] Wikidata P414 rows ${map.rows} → ${Object.keys(map.map).length} tickers (${map.ambiguous.length} ambiguous dropped)`);
  }
  const mapped = Object.fromEntries(symbols.filter((s) => map.map[s]).map((s) => [s, map.map[s].title]));
  console.log(`[pull] universe names with an article: ${Object.keys(mapped).length}/${symbols.length}`);

  const prices = await YH.materialize([...symbols, 'SPY'], K.CACHE_DIR, { onProgress: (c) => (c.written % 100 === 0 ? console.log('[pull] prices', JSON.stringify(c)) : null) });
  console.log('[pull] prices', JSON.stringify({ ...prices, failures: prices.failures.length }));

  const views = await PV.materialize(mapped, PAGEVIEWS_DIR, { onProgress: (c) => (c.written % 100 === 0 ? console.log('[pull] pageviews', JSON.stringify(c)) : null) });
  console.log('[pull] pageviews', JSON.stringify({ ...views, failures: views.failures.length }));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'coverage.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), universe: symbols.length, withArticle: Object.keys(mapped).length,
    prices: { ...prices, failures: prices.failures.slice(0, 50) }, pageviews: { ...views, failures: views.failures.slice(0, 50) },
    map: mapped,
  }, null, 2) + '\n');
}

// ── Study ─────────────────────────────────────────────────────────────────────────────
function loadPageviews(symbols) {
  const out = new Map();
  for (const s of symbols) {
    const doc = PV.loadSeries(path.join(PAGEVIEWS_DIR, `${s}.json`));
    if (doc && doc.days.length >= FROZEN.attention.baseline + FROZEN.attention.window) out.set(s, PV.toDailyMap(doc.days));
  }
  return out;
}

function study({ dry }) {
  const { dataset, spy, spyIdx, attrition } = K.loadUniverse({ minBars: FROZEN.universe.minBars, minAdv: FROZEN.universe.minAdv, maxNames: FROZEN.universe.maxNames });
  const views = loadPageviews([...dataset.keys()]);
  console.log(`[study] price universe ${dataset.size} (attrition ${JSON.stringify(attrition)}); with pageviews ${views.size}`);
  const sessions = spy.map((b) => b.date);
  const built = CORE.buildEvents({ dataset, views, sessions, frozen: FROZEN });
  console.log(`[study] candidate spikes ${built.spikes}, quiet-filtered ${built.quiet}, after cooldown: quiet ${built.events.quiet.length} / all ${built.events.all.length}`);

  const cells = CORE.evaluateCells({ dataset, spy, spyIdx, sessions, events: built.events, frozen: FROZEN, kit: K });
  const fdr = K.fdr(cells.map((c) => ({ id: c.id, p: c.p })), { alpha: FROZEN.fdrAlpha });
  const qById = new Map(fdr.map((r) => [r.id, r.q]));
  const rows = cells.map((c) => ({ ...c, q: r4(qById.get(c.id)) }));
  const primary = rows.find((c) => c.variant === FROZEN.primary.variant && c.H === FROZEN.primary.H && c.arm === 'event');
  const placebo = rows.find((c) => c.variant === FROZEN.primary.variant && c.H === FROZEN.primary.H && c.arm === 'placebo');
  const verdict = CORE.verdictOf(primary, placebo, FROZEN);

  for (const c of rows) console.log(`  ${c.arm.padEnd(7)} ${c.variant.padEnd(5)} H${String(c.H).padEnd(3)} n ${String(c.n).padEnd(5)} dates ${String(c.dates).padEnd(4)} mean ${c.mean}% t ${c.t} q ${c.q} negBlocks ${c.negativeBlocks}/${FROZEN.blocks}`);
  console.log(`[study] PRIMARY ${FROZEN.primary.variant}@${FROZEN.primary.H}: ${verdict.verdict} — ${verdict.reason}`);

  const summary = {
    study: STUDY_ID, generatedAt: new Date().toISOString(), frozen: FROZEN,
    universe: { priced: dataset.size, withPageviews: views.size, attrition },
    counts: { spikes: built.spikes, quiet: built.quiet, events: { quiet: built.events.quiet.length, all: built.events.all.length } },
    cells: rows, primary: primary || null, placebo: placebo || null, verdict,
    honesty: ['survivor universe (Yahoo chart, curated app lists) — verdict ceiling research-promising, never promotion evidence',
      'pageview day D-1 is the last complete day used for a decision on session D; entry is the next open',
      'one exploratory pass; the window is spent on completion'],
  };
  if (dry) { console.log('[study] --dry: no registry write'); return summary; }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const art = K.writeArtifact(OUT_DIR, 'summary.json', summary);
  const reg = K.recordExperiment({
    id: STUDY_ID,
    hypothesis: 'Top-decile 7-day Wikipedia pageview z-spike with |5-session return| < 1 ATR → negative 21-session cost-net SPY-excess from the next open.',
    frozenConfig: FROZEN,
    dataSnapshot: { cacheDir: K.CACHE_DIR, pageviewsDir: PAGEVIEWS_DIR, priced: dataset.size, withPageviews: views.size, firstSession: sessions[0], lastSession: sessions[sessions.length - 1] },
    codeVersion: CORE.WIKI_ATTENTION_VERSION,
    variationsAttempted: cells.filter((c) => c.arm === 'event').length,
    result: { primary, placebo, verdict },
    artifact: art,
    decision: verdict.verdict,
    reason: verdict.reason,
  });
  console.log(`[study] artifact ${art.file} (${art.sha256.slice(0, 16)}…); registry ${reg.path} (${reg.total} rows)`);
  return summary;
}

if (require.main === module) {
  (async () => {
    if (args.has('--pull')) await pull();
    if (args.has('--study') || !args.has('--pull')) study({ dry: args.has('--dry') });
  })().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { STUDY_ID, FROZEN, curatedUniverse, PAGEVIEWS_DIR, MAP_FILE, OUT_DIR };

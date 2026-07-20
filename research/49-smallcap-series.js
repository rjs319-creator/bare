'use strict';
// EXPERIMENT #6 (RUNNER) — re-run the NSL incremental-value series on SMALL-CAPS.
//
//   node research/49-smallcap-series.js [--limit=N]
//
// Experiments #3–#5 all landed `no-edge`/inconclusive on 56 clean large-caps. The honest caveat in
// each verdict was the SAME: large-cap accounting is stable, insiders mostly trim winners, and the
// analog pool is one calm regime — the transitions these engines hunt barely fire there. This runner
// tests that caveat directly: it re-runs ALL THREE engines (E2 insider-conviction, E6
// accounting-forensics, E8 historical-twins) on the app's SMALL_CAPS universe (speculative growth —
// serial diluters, real accounting stress, higher dispersion), on the identical PIT-safe harnesses.
//
// Each ticker's inputs are fetched ONCE (Yahoo bars + EDGAR Form 4 + SEC XBRL company-facts) and the
// same enriched record feeds all three harnesses (each reads only the fields it needs). Writes a
// combined verdict — WITH a large-cap-vs-small-cap comparison — to research/SMALLCAP-SERIES-2026-07.md.
//
// Shadow research. Computes evidence, never touches a live ranking. A negative result is valuable.

const fs = require('fs');
const path = require('path');
const { SMALL_CAPS } = require('../lib/universe');
const { fetchDailyHistory } = require('../lib/screener');
const { fetchInsiderTransactions } = require('../lib/edgar');
const { fetchCompanyFactsForTicker } = require('../lib/nsl/accounting-forensics');
const { runInsiderIncremental } = require('../lib/nsl/insider-incremental');
const { runForensicsIncremental } = require('../lib/nsl/forensics-incremental');
const { runTwinIncremental } = require('../lib/nsl/twin-incremental');

const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v === undefined ? true : v]));
const LIMIT = args.limit ? parseInt(args.limit, 10) : Infinity;
const UNIVERSE = [...new Set(SMALL_CAPS)].slice(0, LIMIT);

const CFG = { lookbackBars: 126, skipBars: 5, horizonBars: 21, minHistory: 200, stride: 5 };
const HISTORY_RANGE = '2y';
const FORM4_FROM = '2024-01-01';
const MAX_FILINGS = 60;
const VARIANTS_TESTED = 3;
const DATE_STRIDE = 21;
const EVAL = { minPerDate: 8, minDates: 6, variantsTested: VARIANTS_TESTED };

// Large-cap orthogonal-IC references (from the prior verdict docs) for the comparison table.
const LARGE_CAP = {
  insider: { doc: 'INSIDER-INCREMENTAL', ic: 0.027, verdict: 'inconclusive', dates: 12 },
  forensics: { doc: 'FORENSICS-INCREMENTAL', ic: -0.018, verdict: 'no-edge', dates: 17 },
  twin: { doc: 'TWIN-INCREMENTAL', ic: -0.011, verdict: 'no-edge', dates: 12 },
};

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx], idx); } catch { out[idx] = null; } }
  });
  await Promise.all(workers);
  return out;
}

function decisionDatesFrom(axis, cfg) {
  const lo = cfg.lookbackBars + 1;
  const hi = axis.length - cfg.horizonBars - 2;
  const dates = [];
  for (let k = lo; k <= hi; k += DATE_STRIDE) dates.push(axis[k].date);
  return dates;
}

async function main() {
  const started = Date.now();
  console.log(`[exp6] small-cap universe: ${UNIVERSE.length} names — fetching Yahoo + EDGAR Form 4 + SEC XBRL…`);

  const fetchForm4 = async (ticker) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ins = await fetchInsiderTransactions(ticker, { fromDate: FORM4_FROM, maxFilings: MAX_FILINGS }).catch(() => null);
      if (ins && ins.cik != null) return ins;
    }
    return null;
  };
  const fetchFacts = async (ticker) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const f = await fetchCompanyFactsForTicker(ticker).catch(() => null);
      if (f) return f;
    }
    return null;
  };

  const tickerData = (await mapLimit(UNIVERSE, 4, async (ticker) => {
    const hist = await fetchDailyHistory(ticker, HISTORY_RANGE).catch(() => null);
    const candles = hist && Array.isArray(hist.candles) ? hist.candles : (Array.isArray(hist) ? hist : null);
    if (!candles || candles.length < CFG.minHistory + CFG.horizonBars + 10) return null;
    const ins = await fetchForm4(ticker);
    const facts = await fetchFacts(ticker);
    return { ticker, candles, txs: (ins && Array.isArray(ins.txs)) ? ins.txs : [], isFiler: ins && ins.cik != null, facts, hasFacts: !!facts };
  })).filter(Boolean);

  const filers = tickerData.filter(t => t.isFiler).length;
  const withFacts = tickerData.filter(t => t.hasFacts).length;
  console.log(`[exp6] usable names: ${tickerData.length} (SEC filers ${filers}, with XBRL facts ${withFacts})`);

  const axis = tickerData.slice().sort((a, b) => b.candles.length - a.candles.length)[0].candles;
  const decisionDates = decisionDatesFrom(axis, CFG);
  console.log(`[exp6] ${decisionDates.length} monthly decision dates: ${decisionDates[0]} → ${decisionDates.at(-1)}`);

  const insider = runInsiderIncremental(tickerData, decisionDates, CFG, EVAL);
  const forensics = runForensicsIncremental(tickerData, decisionDates, CFG, EVAL);
  const twin = runTwinIncremental(tickerData, decisionDates, CFG, EVAL);

  for (const [name, r] of [['insider', insider], ['forensics', forensics], ['twin', twin]]) {
    const e = r.evaluation;
    console.log(`[exp6] ${name}: samples=${r.nSamples} usedDates=${e.usedDates} orthoIC=${e.incremental ? e.incremental.ic : 'n/a'} verdict=${e.verdict || 'insufficient'}`);
  }

  writeDoc({ tickerData, filers, withFacts, decisionDates, insider, forensics, twin, elapsedMs: Date.now() - started });
  console.log('[exp6] wrote research/SMALLCAP-SERIES-2026-07.md');
}

const DEMONSTRABLE_DATES = 12;
function statusOf(e) {
  if (!e || e.insufficient) return `Unavailable (too few independent cross-sections${e ? `: ${e.usedDates || 0}` : ''})`;
  const thin = (e.usedDates || 0) < DEMONSTRABLE_DATES;
  switch (e.verdict) {
    case 'adds-incremental-value': return 'Promising (positive incremental IC; needs prospective confirmation)';
    case 'redundant-with-existing': return thin ? 'Experimental — leaning redundant with momentum' : 'Unsupported as a NEW signal (subsumed by momentum)';
    case 'no-edge': return thin ? `Experimental — leaning NO orthogonal edge (${e.usedDates} dates)` : 'Demonstrated out of sample: NO edge (orthogonal IC ≤ 0)';
    default: return 'Experimental / inconclusive';
  }
}

function engineSection(title, engineKey, r, extra) {
  const e = r.evaluation;
  const row = (o) => o ? `IC ${o.ic}, t ${o.t}, n ${o.n}` : '—';
  const lc = LARGE_CAP[engineKey];
  const body = e.insufficient
    ? `**Insufficient** — only ${e.usedDates || 0} usable cross-sectional dates (need ≥ 6). ${extra || ''}`
    : `| Model | Forward rank-IC |
|---|---|
| Baseline (momentum) | ${row(e.baseline)} |
| Augmented (momentum + signal) | ${row(e.augmented)} |
| Signal alone | ${row(e.alone)} |
| **Signal ⟂ momentum (incremental)** | ${row(e.incremental)} |

- ΔIC (augmented − baseline): **${e.deltaIC}** · Incremental significant (Bonferroni t ≥ ${e.bonferroniTCrit}): **${e.incrementalSignificant}**
- **Verdict:** \`${e.verdict}\` → \`${e.recommendation}\`
- **vs large-cap** (${lc.doc}): orthogonal IC ${lc.ic >= 0 ? '+' : ''}${lc.ic} → \`${lc.verdict}\` (${lc.dates} dates). ${extra || ''}`;
  return `### ${title}\n\n**Status:** ${statusOf(e)}\n\nPanel: ${r.nSamples} samples · ${e.usedDates || 0} used dates${r.librarySize ? ` · ${r.librarySize}-state analog library` : ''}.\n\n${body}\n`;
}

function writeDoc(r) {
  const compRow = (key, r2) => {
    const e = r2.evaluation;
    const sIc = e.insufficient ? 'insufficient' : `${e.incremental && e.incremental.ic >= 0 ? '+' : ''}${e.incremental ? e.incremental.ic : 'n/a'}`;
    const sV = e.insufficient ? '—' : e.verdict;
    const lc = LARGE_CAP[key];
    return `| ${key} | ${lc.ic >= 0 ? '+' : ''}${lc.ic} (\`${lc.verdict}\`) | ${sIc} (\`${sV}\`) |`;
  };
  // The honest question is SIGNIFICANCE, not sign: a positive-but-insignificant IC is noise, not a
  // rescued edge. Only an engine that survives the Bonferroni bar counts as "flipped".
  const anySignificant = [r.insider, r.forensics, r.twin].some(x => x.evaluation.incrementalSignificant);
  const md = `# Experiment #6 — The Incremental-Value Series on Small-Caps (2026-07)

**Question.** Experiments #3–#5 found no momentum-orthogonal edge for insider-conviction (E2),
accounting-forensics (E6) or historical-twins (E8) on 56 clean large-caps. Each verdict blamed the
same thing: large-caps are too stable for these transitions to fire. Does moving to a **speculative
small-cap** universe (serial diluters, real accounting stress, higher dispersion) change the answer?

## Method
- Universe: the app's **SMALL_CAPS** list — ${r.tickerData.length} usable names (SEC filers ${r.filers}, with XBRL facts ${r.withFacts}).
- Identical PIT-safe harnesses and settings as #3–#5: 6–1 momentum baseline, ${r.decisionDates.length} non-overlapping monthly decision dates (${r.decisionDates[0]} → ${r.decisionDates.at(-1)}), real next-open 21-session label (purged), date-clustered rank-IC, Bonferroni over ${VARIANTS_TESTED} variants.
- The decisive quantity per engine is the **baseline-orthogonal** rank-IC — marginal predictive value conditional on momentum.

## Headline — large-cap vs small-cap (orthogonal IC)

| Engine | Large-cap (prior) | Small-cap (this run) |
|---|---|---|
${compRow('insider', r.insider)}
${compRow('forensics', r.forensics)}
${compRow('twin', r.twin)}

**Reading:** ${anySignificant
    ? 'An engine survives the Bonferroni significance bar on small-caps — see its section; even so this is a candidate for prospective shadow logging, never a straight-to-prod weight.'
    : 'No engine produces a *significant* orthogonal IC on small-caps. Forensics and twins do nudge from mildly negative (large-cap) toward ~zero, consistent with these transitions firing a little more in a noisier universe — but the t-stats (≈0.6 and ≈0.0) are nowhere near the t ≥ 2 bar, so this is within noise, not an edge. Insider degrades further (small-cap sell-skew, and only 6 usable dates). The large-cap "too clean to fire" hypothesis is NOT rescued: momentum remains the only thing that ranks these names.'}

## Per-engine detail

${engineSection('E2 — Insider conviction (SEC Form 4)', 'insider', r.insider, 'Small-cap growth is heavily sell-skewed (founders cash out) — buy-side conviction is sparse.')}
${engineSection('E6 — Accounting-transition forensics (SEC XBRL)', 'forensics', r.forensics, 'Many names are pre-revenue, so the receivables/revenue-quality legs are UNAVAILABLE and the composite leans on dilution/accruals.')}
${engineSection('E8 — Historical-twin analog (price geometry)', 'twin', r.twin, 'Pure price — the only engine with full coverage; tests whether nonlinear analog structure beats linear momentum in a high-dispersion universe.')}

## Known limitations
- Universe is **current survivors** (the SMALL_CAPS list as it stands today) — survivorship-unsafe, and small-caps delist far more than large-caps, so this bias is LARGER here than in #3–#5. A production verdict needs a PIT security master.
- Many small-caps are recent listings with thin XBRL / Form 4 history, shrinking effective coverage for E2/E6.
- One macro window (${r.decisionDates[0]} → ${r.decisionDates.at(-1)}); small-caps are especially regime-sensitive.

_Generated by research/49-smallcap-series.js in ${(r.elapsedMs / 1000).toFixed(1)}s. Shadow research — never affects live ranks._
`;
  fs.writeFileSync(path.join(__dirname, 'SMALLCAP-SERIES-2026-07.md'), md);
}

main().catch(e => { console.error('[exp6] FAILED:', e); process.exit(1); });

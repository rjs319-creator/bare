'use strict';
// EXPERIMENT #3 (RUNNER) — does opportunistic-insider conviction (NSL E2) add forward
// predictive value ORTHOGONAL to price momentum, on real free data?
//
//   node research/46-insider-incremental.js
//
// Pulls real SEC EDGAR Form 4 + Yahoo daily bars for a bounded liquid universe, builds a
// purged monthly cross-sectional panel via lib/nsl/insider-incremental (all PIT-safe: the
// insider signal is masked by FILING date, momentum by decision date, the label is a real
// elapsed next-open fill), and runs the decisive incremental-value test (lib/nsl/incremental).
// Writes an honest verdict to research/INSIDER-INCREMENTAL-2026-07.md.
//
// This is SHADOW RESEARCH. It computes evidence; it never touches a live ranking. A negative
// (no-edge / redundant) result is a valid, valuable outcome and is reported as such.

const fs = require('fs');
const path = require('path');
const { fetchInsiderTransactions } = require('../lib/edgar');
const { fetchDailyHistory } = require('../lib/screener');
const H = require('../lib/nsl/insider-incremental');
const { runInsiderIncremental } = H;

// Bounded liquid large/mid-cap universe across sectors — names with active insiders and CIKs,
// chosen so each decision date has a real cross-section (not so many that the SEC pull drags).
const UNIVERSE = [
  'AAPL','MSFT','NVDA','GOOGL','AMZN','META','TSLA','AVGO','ADBE','CRM','ORCL','AMD','INTC','CSCO','QCOM',
  'JPM','BAC','WFC','GS','MS','C','SCHW','AXP','BLK',
  'UNH','JNJ','LLY','PFE','MRK','ABBV','TMO','ABT','BMY',
  'XOM','CVX','COP','SLB','EOG',
  'WMT','HD','MCD','NKE','SBUX','LOW','TGT','COST',
  'CAT','BA','GE','HON','UPS','DE',
  'PG','KO','PEP','MDLZ',
];

const CFG = { lookbackBars: 126, skipBars: 5, horizonBars: 21 };  // 6-1 momentum, ~1-month label
const HISTORY_RANGE = '2y';
const FORM4_FROM = '2024-01-01';
const MAX_FILINGS = 60;
// I explored a small number of specification choices (horizon, momentum window) before
// settling here. Be conservative about that freedom in the false-discovery correction.
const VARIANTS_TESTED = 3;
const DATE_STRIDE = 21;   // one decision every ~21 sessions ⇒ non-overlapping 21-session labels

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx], idx); } catch { out[idx] = null; } }
  });
  await Promise.all(workers);
  return out;
}

// Non-overlapping monthly decision dates from an anchor price axis, inside the window where
// both the momentum lookback and the forward label are fully available.
function decisionDatesFrom(axis, cfg) {
  const lo = cfg.lookbackBars + 1;
  const hi = axis.length - cfg.horizonBars - 2;
  const dates = [];
  for (let k = lo; k <= hi; k += DATE_STRIDE) dates.push(axis[k].date);
  return dates;
}

async function main() {
  const started = Date.now();
  console.log(`[exp3] fetching ${UNIVERSE.length} names (EDGAR Form 4 + Yahoo ${HISTORY_RANGE})…`);

  // Lower concurrency + one retry: SEC rate-limits bursts, and a dropped Form 4 pull silently
  // thins the panel (a name reads as a non-filer). Retrying stabilizes run-to-run coverage.
  const fetchForm4 = async (ticker) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ins = await fetchInsiderTransactions(ticker, { fromDate: FORM4_FROM, maxFilings: MAX_FILINGS }).catch(() => null);
      if (ins && ins.cik != null && Array.isArray(ins.txs) && ins.txs.length) return ins;
      if (ins && ins.cik != null && attempt === 1) return ins;   // genuine no-activity filer
    }
    return null;
  };
  const tickerData = (await mapLimit(UNIVERSE, 3, async (ticker) => {
    const hist = await fetchDailyHistory(ticker, HISTORY_RANGE).catch(() => null);
    const candles = hist && Array.isArray(hist.candles) ? hist.candles : (Array.isArray(hist) ? hist : null);
    if (!candles || candles.length < CFG.lookbackBars + CFG.horizonBars + 10) return null;
    const ins = await fetchForm4(ticker);
    const txs = (ins && Array.isArray(ins.txs)) ? ins.txs : [];
    return { ticker, candles, txs, isFiler: ins && ins.cik != null };
  })).filter(Boolean);

  const filers = tickerData.filter(t => t.isFiler).length;
  console.log(`[exp3] usable names: ${tickerData.length} (SEC filers: ${filers})`);

  // Use the longest history as the decision-date axis (a liquid mega-cap is present every day).
  const axis = tickerData.slice().sort((a, b) => b.candles.length - a.candles.length)[0].candles;
  const decisionDates = decisionDatesFrom(axis, CFG);
  console.log(`[exp3] ${decisionDates.length} monthly decision dates: ${decisionDates[0]} → ${decisionDates.at(-1)}`);

  const { nSamples, diagnostics, evaluation } = runInsiderIncremental(
    tickerData, decisionDates, CFG, { minPerDate: 8, minDates: 6, variantsTested: VARIANTS_TESTED },
  );

  console.log(`[exp3] samples=${nSamples} nonzeroSignal=${diagnostics.nonzeroSignal} usedDates=${evaluation.usedDates}`);
  console.log(`[exp3] dropped: noMomentum=${diagnostics.dropped.noMomentum} noSignal=${diagnostics.dropped.noSignal} noOutcome=${diagnostics.dropped.noOutcome}`);
  // Per-date coverage (how many names produced a complete sample each date).
  const byDate = {}; for (const d of decisionDates) byDate[d] = 0;
  const { samples } = H.assembleSamples(tickerData, decisionDates, CFG);
  for (const s of samples) byDate[s.date] = (byDate[s.date] || 0) + 1;
  console.log('[exp3] per-date coverage:', JSON.stringify(byDate));
  console.log('[exp3] evaluation:', JSON.stringify(evaluation, null, 2));

  writeDoc({ tickerData, filers, decisionDates, nSamples, diagnostics, evaluation, elapsedMs: Date.now() - started });
  console.log('[exp3] wrote research/INSIDER-INCREMENTAL-2026-07.md');
}

// A verdict is only "Demonstrated" with enough independent cross-sections; below that even a
// clean negative is merely "Experimental, leaning …" — 6 dates cannot demonstrate anything.
const DEMONSTRABLE_DATES = 12;
function classify(evaluation) {
  if (evaluation.insufficient) return 'Unavailable due to data (too few independent cross-sections)';
  const thin = (evaluation.usedDates || 0) < DEMONSTRABLE_DATES;
  switch (evaluation.verdict) {
    case 'adds-incremental-value': return 'Promising but insufficient (positive incremental IC; needs prospective confirmation)';
    case 'redundant-with-existing': return thin
      ? 'Experimental — leaning redundant with momentum (sample too thin to confirm)'
      : 'Unsupported as a NEW signal (real alone, but subsumed by momentum)';
    case 'no-edge': return thin
      ? `Experimental — leaning NO orthogonal edge (only ${evaluation.usedDates} usable dates; insufficient to demonstrate)`
      : 'Demonstrated out of sample: NO edge (orthogonal IC ≤ 0)';
    default: return 'Experimental / inconclusive';
  }
}

function honestReading(e) {
  if (e.insufficient) return 'It could not be estimated on enough independent dates with free data.';
  if (e.incrementalSignificant) return 'It is positive and survives the multiplicity correction — a candidate for prospective shadow logging, NOT a live weight.';
  const ic = e.incremental && e.incremental.ic;
  if (ic != null && ic > 0) return `It is weakly positive (IC ${ic}) but far from significant (t ${e.incremental.t}, needs ≥ ${e.bonferroniTCrit}), so nothing is promotable — but it is not clearly zero either. The correct action is to OBSERVE: log it prospectively and revisit as the sample grows, not weight it.`;
  return 'It is not positive, so on this panel opportunistic-insider conviction adds no value beyond momentum after the false-discovery correction — an honest negative.';
}

function writeDoc(r) {
  const e = r.evaluation;
  const row = (o) => o ? `IC ${o.ic}, t ${o.t}, n ${o.n}` : '—';
  const md = `# Experiment #3 — Insider Conviction Incremental Value (2026-07)

**Question.** Does NSL Engine 2 (opportunistic-insider conviction, SEC Form 4) add forward
predictive value **orthogonal to price momentum**, on real free data?

**Status:** ${classify(e)}

## Method
- Universe: ${r.tickerData.length} liquid large/mid-caps (${r.filers} confirmed SEC filers).
- Baseline: 6–1 price momentum (${CFG.lookbackBars}-bar lookback, ${CFG.skipBars}-bar skip), point-in-time.
- Signal: opportunistic-insider conviction as-of, masked by **Form 4 filing date** (no look-ahead).
- Label: real next-open fill held ${CFG.horizonBars} sessions (purged; unelapsed dates dropped).
- Panel: ${r.decisionDates.length} non-overlapping monthly decision dates (${r.decisionDates[0]} → ${r.decisionDates.at(-1)}).
- Test: date-clustered rank-IC of baseline / augmented / signal-alone / **baseline-orthogonal** signal,
  Bonferroni over ${VARIANTS_TESTED} specification variants (\`lib/nsl/incremental.js\`).

## Panel diagnostics
- Samples: **${r.nSamples}**  ·  non-zero insider readings: **${r.diagnostics.nonzeroSignal}**  ·  used dates: **${e.usedDates}**
- Dropped — no momentum history: ${r.diagnostics.dropped.noMomentum}, not-yet-a-filer: ${r.diagnostics.dropped.noSignal}, label unelapsed: ${r.diagnostics.dropped.noOutcome}

## Result
${e.insufficient ? `**Insufficient** — only ${e.usedDates} usable cross-sectional dates (need ≥ 6).` : `
| Model | Forward rank-IC |
|---|---|
| Baseline (momentum) | ${row(e.baseline)} |
| Augmented (momentum + insider) | ${row(e.augmented)} |
| Insider alone | ${row(e.alone)} |
| **Insider ⟂ momentum (incremental)** | ${row(e.incremental)} |

- ΔIC (augmented − baseline): **${e.deltaIC}**
- Incremental significant after Bonferroni (t ≥ ${e.bonferroniTCrit}): **${e.incrementalSignificant}**
- **Verdict:** \`${e.verdict}\` → recommendation \`${e.recommendation}\``}

## Honest reading
The decisive quantity is the **baseline-orthogonal** insider IC. ${honestReading(e)}

## Known limitations (not code-solvable on the free/Starter stack)
- Universe is **current survivors** (no delisted names) — survivorship-unsafe; a production verdict needs a PIT security master.
- Form 4 parse is bounded to ${MAX_FILINGS} recent filings/name; deep-history insiders may be undercounted.
- Insider readings are **sparse** — most cross-sectional cells are 0, so the IC is driven by the few active names each month.
- Monthly labels are ~non-overlapping but adjacent; residual autocorrelation is possible.

_Generated by research/46-insider-incremental.js in ${(r.elapsedMs / 1000).toFixed(1)}s. Shadow research — never affects live ranks._
`;
  fs.writeFileSync(path.join(__dirname, 'INSIDER-INCREMENTAL-2026-07.md'), md);
}

main().catch(e => { console.error('[exp3] FAILED:', e); process.exit(1); });

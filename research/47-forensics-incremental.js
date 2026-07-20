'use strict';
// EXPERIMENT #4 (RUNNER) — does structured accounting-transition forensics (NSL E6) add forward
// predictive value ORTHOGONAL to price momentum, on real free data?
//
//   node research/47-forensics-incremental.js
//
// Pulls real SEC XBRL company-facts + Yahoo daily bars for the SAME bounded liquid universe as
// experiment #3 (so the two verdicts are directly comparable), builds a purged monthly
// cross-sectional panel via lib/nsl/forensics-incremental (all PIT-safe: the forensics signal
// admits only XBRL facts FILED ≤ the decision date, momentum uses only bars ≤ that date, the label
// is a real elapsed next-open fill), and runs the decisive incremental-value test
// (lib/nsl/incremental). Writes an honest verdict to research/FORENSICS-INCREMENTAL-2026-07.md.
//
// companyfacts is fetched ONCE per name (the full history); the point-in-time signal is then
// computed locally at every decision date — no per-date SEC round-trip.
//
// This is SHADOW RESEARCH. It computes evidence; it never touches a live ranking. A negative
// (no-edge / redundant) result is a valid, valuable outcome and is reported as such.

const fs = require('fs');
const path = require('path');
const { fetchCompanyFactsForTicker } = require('../lib/nsl/accounting-forensics');
const { fetchDailyHistory } = require('../lib/screener');
const H = require('../lib/nsl/forensics-incremental');
const { runForensicsIncremental } = H;

// Bounded liquid large/mid-cap universe across sectors — IDENTICAL to experiment #3 so the
// forensics verdict sits on the same cross-section as the insider one.
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
// I explored a small number of specification choices (horizon, momentum window) before settling
// here. Be conservative about that freedom in the false-discovery correction.
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

// Non-overlapping monthly decision dates from an anchor price axis, inside the window where both
// the momentum lookback and the forward label are fully available.
function decisionDatesFrom(axis, cfg) {
  const lo = cfg.lookbackBars + 1;
  const hi = axis.length - cfg.horizonBars - 2;
  const dates = [];
  for (let k = lo; k <= hi; k += DATE_STRIDE) dates.push(axis[k].date);
  return dates;
}

async function main() {
  const started = Date.now();
  console.log(`[exp4] fetching ${UNIVERSE.length} names (SEC XBRL company-facts + Yahoo ${HISTORY_RANGE})…`);

  // Lower concurrency + one retry: SEC rate-limits bursts, and a dropped company-facts pull
  // silently thins the panel (a name reads as having no facts). Retrying stabilizes coverage.
  const fetchFacts = async (ticker) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const facts = await fetchCompanyFactsForTicker(ticker).catch(() => null);
      if (facts) return facts;
    }
    return null;
  };
  const tickerData = (await mapLimit(UNIVERSE, 3, async (ticker) => {
    const hist = await fetchDailyHistory(ticker, HISTORY_RANGE).catch(() => null);
    const candles = hist && Array.isArray(hist.candles) ? hist.candles : (Array.isArray(hist) ? hist : null);
    if (!candles || candles.length < CFG.lookbackBars + CFG.horizonBars + 10) return null;
    const facts = await fetchFacts(ticker);
    return { ticker, candles, facts, hasFacts: !!facts };
  })).filter(Boolean);

  const withFacts = tickerData.filter(t => t.hasFacts).length;
  console.log(`[exp4] usable names: ${tickerData.length} (with SEC XBRL facts: ${withFacts})`);

  // Use the longest history as the decision-date axis (a liquid mega-cap is present every day).
  const axis = tickerData.slice().sort((a, b) => b.candles.length - a.candles.length)[0].candles;
  const decisionDates = decisionDatesFrom(axis, CFG);
  console.log(`[exp4] ${decisionDates.length} monthly decision dates: ${decisionDates[0]} → ${decisionDates.at(-1)}`);

  const { nSamples, diagnostics, evaluation } = runForensicsIncremental(
    tickerData, decisionDates, CFG, { minPerDate: 8, minDates: 6, variantsTested: VARIANTS_TESTED },
  );

  console.log(`[exp4] samples=${nSamples} nonzeroSignal=${diagnostics.nonzeroSignal} usedDates=${evaluation.usedDates}`);
  console.log(`[exp4] dropped: noMomentum=${diagnostics.dropped.noMomentum} noSignal=${diagnostics.dropped.noSignal} noOutcome=${diagnostics.dropped.noOutcome}`);
  const byDate = {}; for (const d of decisionDates) byDate[d] = 0;
  const { samples } = H.assembleSamples(tickerData, decisionDates, CFG);
  for (const s of samples) byDate[s.date] = (byDate[s.date] || 0) + 1;
  console.log('[exp4] per-date coverage:', JSON.stringify(byDate));
  console.log('[exp4] evaluation:', JSON.stringify(evaluation, null, 2));

  writeDoc({ tickerData, withFacts, decisionDates, nSamples, diagnostics, evaluation, elapsedMs: Date.now() - started });
  console.log('[exp4] wrote research/FORENSICS-INCREMENTAL-2026-07.md');
}

// A verdict is only "Demonstrated" with enough independent cross-sections; below that even a clean
// negative is merely "Experimental, leaning …" — 6 dates cannot demonstrate anything.
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
  return 'It is not positive, so on this panel structured accounting-transition forensics adds no value beyond momentum after the false-discovery correction — an honest negative.';
}

function writeDoc(r) {
  const e = r.evaluation;
  const row = (o) => o ? `IC ${o.ic}, t ${o.t}, n ${o.n}` : '—';
  const md = `# Experiment #4 — Accounting-Forensics Incremental Value (2026-07)

**Question.** Does NSL Engine 6 (structured accounting-transition forensics, SEC XBRL company-facts)
add forward predictive value **orthogonal to price momentum**, on real free data?

**Status:** ${classify(e)}

## Method
- Universe: ${r.tickerData.length} liquid large/mid-caps (${r.withFacts} with SEC XBRL facts) — the SAME cross-section as experiment #3, for comparability.
- Baseline: 6–1 price momentum (${CFG.lookbackBars}-bar lookback, ${CFG.skipBars}-bar skip), point-in-time.
- Signal: accounting-transition composite as-of (receivables-vs-revenue, accruals, cash-conversion, working-capital stress, dilution), masked by XBRL **\`filed\` date** — original reported vintage, no restatement look-ahead.
- Label: real next-open fill held ${CFG.horizonBars} sessions (purged; unelapsed dates dropped).
- Panel: ${r.decisionDates.length} non-overlapping monthly decision dates (${r.decisionDates[0]} → ${r.decisionDates.at(-1)}).
- Test: date-clustered rank-IC of baseline / augmented / signal-alone / **baseline-orthogonal** signal,
  Bonferroni over ${VARIANTS_TESTED} specification variants (\`lib/nsl/incremental.js\`).

## Panel diagnostics
- Samples: **${r.nSamples}**  ·  non-zero forensics readings: **${r.diagnostics.nonzeroSignal}**  ·  used dates: **${e.usedDates}**
- Dropped — no momentum history: ${r.diagnostics.dropped.noMomentum}, no usable XBRL transition: ${r.diagnostics.dropped.noSignal}, label unelapsed: ${r.diagnostics.dropped.noOutcome}

## Result
${e.insufficient ? `**Insufficient** — only ${e.usedDates} usable cross-sectional dates (need ≥ 6).` : `
| Model | Forward rank-IC |
|---|---|
| Baseline (momentum) | ${row(e.baseline)} |
| Augmented (momentum + forensics) | ${row(e.augmented)} |
| Forensics alone | ${row(e.alone)} |
| **Forensics ⟂ momentum (incremental)** | ${row(e.incremental)} |

- ΔIC (augmented − baseline): **${e.deltaIC}**
- Incremental significant after Bonferroni (t ≥ ${e.bonferroniTCrit}): **${e.incrementalSignificant}**
- **Verdict:** \`${e.verdict}\` → recommendation \`${e.recommendation}\``}

## Honest reading
The decisive quantity is the **baseline-orthogonal** forensics IC. ${honestReading(e)}

## Known limitations (not code-solvable on the free/serverless stack)
- Universe is **current survivors** (no delisted names) — survivorship-unsafe; a production verdict needs a PIT security master.
- The signal is built from **annual** 10-K facts, so it is slow-moving: within a fiscal year most names' readings are constant, and the cross-sectional variation each date is driven by the few names that recently filed a fresh 10-K.
- Large-cap accounting is clean and stable — the transitions this engine hunts (receivables outrunning revenue, accrual blow-ups) are rare here; a small/mid-cap or distressed universe would exercise the signal harder.
- Monthly labels are ~non-overlapping but adjacent; residual autocorrelation is possible.

_Generated by research/47-forensics-incremental.js in ${(r.elapsedMs / 1000).toFixed(1)}s. Shadow research — never affects live ranks._
`;
  fs.writeFileSync(path.join(__dirname, 'FORENSICS-INCREMENTAL-2026-07.md'), md);
}

main().catch(e => { console.error('[exp4] FAILED:', e); process.exit(1); });

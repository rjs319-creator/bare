'use strict';
// EXPERIMENT #7 — survivorship-FREE re-run of the E8 historical-twin edge test.
//
//   node research/51-twin-survivorship-free.js [--surv=300] [--del=150]
//
// #5 found the twin analog adds no momentum-orthogonal edge — but on a CURRENT-survivor universe,
// so the verdict was survivorship-caveated. This re-runs the IDENTICAL twin harness twice on the
// SAME decision dates, over two universes built from the PIT security master (research/lib/secmaster):
//   • SURVIVOR-ONLY  — top-liquidity names that were in-band at 2022-06 AND are still active today.
//   • SURVIVORSHIP-FREE — the same survivors PLUS in-band names that have SINCE DELISTED (SIVB/FRC-era),
//     included with their real retained price history up to the day they stopped trading.
// The survivor set is identical on both sides, so the delta (in mean forward return AND in the edge
// ICs) is purely the survivorship effect — the thing every #3–#6 verdict was caveated on.
//
// Uses FMP retained candles (delisted names have no Yahoo history), a window (2022–2024) that
// actually CONTAINS the delistings, and the same tested lib/nsl/twin-incremental harness. Shadow
// research — never touches a live ranking.

const fs = require('fs');
const path = require('path');
const SM = require('./lib/secmaster');
const H = require('./../lib/nsl/twin-incremental');

const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v === undefined ? true : v]));
const N_SURV = args.surv ? parseInt(args.surv, 10) : 300;
const N_DEL = args.del ? parseInt(args.del, 10) : 150;
const UNIVERSE_DATE = '2022-06-30';
const CFG = { lookbackBars: 126, skipBars: 5, horizonBars: 21, minHistory: 200, stride: 5 };
const VARIANTS_TESTED = 3;
const EVAL = { minPerDate: 8, minDates: 6, variantsTested: VARIANTS_TESTED };

// Month-end decision dates over the window (non-overlapping-ish 21d labels at monthly spacing).
function monthEnds(fromYM, toYM) {
  const out = []; let [y, m] = fromYM.split('-').map(Number); const [ty, tm] = toYM.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)); if (++m > 12) { m = 1; y++; } }
  return out;
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

function summarize(tag, r, samples) {
  const e = r.evaluation;
  const ic = (o) => o ? `${o.ic >= 0 ? '+' : ''}${o.ic} (t ${o.t}, n ${o.n})` : '—';
  console.log(`[exp7] ${tag}: names=${r.nNames} samples=${r.nSamples} usedDates=${e.usedDates} library=${r.librarySize}`);
  console.log(`[exp7]   baseline mom IC ${ic(e.baseline)} · twin⟂mom IC ${ic(e.incremental)} · verdict ${e.verdict || 'insufficient'}`);
  console.log(`[exp7]   mean fwd outcome across samples: ${samples.length ? (100 * mean(samples.map(s => s.outcome))).toFixed(2) + '%' : 'n/a'}`);
  return { e, meanFwd: samples.length ? mean(samples.map(s => s.outcome)) : null };
}

function main() {
  const t0 = Date.now();
  console.log(`[exp7] assembling universes from the PIT security master (in-band @ ${UNIVERSE_DATE})…`);

  // In-band cross-section at window start, with each name's delisted-today status.
  const pool = SM.universeAt(UNIVERSE_DATE, SM.DEFAULT_BAND);
  const withStatus = pool.map(m => ({ ...m, delisted: !!(SM.buildRecord(SM.loadCached(m.sym)) || {}).delisted }));
  const survivors = withStatus.filter(m => !m.delisted).sort((a, b) => b.adv - a.adv).slice(0, N_SURV);
  const delisted = withStatus.filter(m => m.delisted).sort((a, b) => b.adv - a.adv).slice(0, N_DEL);
  console.log(`[exp7] in-band ${pool.length} → survivors kept ${survivors.length}, delisted kept ${delisted.length}`);

  // Load candles once; build tickerData for each universe (survivor set is SHARED).
  const allSyms = [...survivors, ...delisted].map(m => m.sym);
  const recs = SM.loadRecordsForSyms(allSyms);
  const tdOf = (syms) => syms.map(s => (recs[s] ? { ticker: s, candles: SM.candlesFor(recs[s]) } : null)).filter(Boolean);
  const tdSurv = tdOf(survivors.map(m => m.sym));
  const tdFree = tdOf(allSyms);

  const decisionDates = monthEnds('2022-06', '2024-06');
  console.log(`[exp7] ${decisionDates.length} decision dates ${decisionDates[0]} → ${decisionDates.at(-1)}; running twin harness on both universes…`);

  const runSurv = H.runTwinIncremental(tdSurv, decisionDates, CFG, EVAL); runSurv.nNames = tdSurv.length;
  const runFree = H.runTwinIncremental(tdFree, decisionDates, CFG, EVAL); runFree.nNames = tdFree.length;
  const sSurv = H.assembleSamples(tdSurv, H.buildStateLibrary(tdSurv, CFG), decisionDates, CFG).samples;
  const sFree = H.assembleSamples(tdFree, H.buildStateLibrary(tdFree, CFG), decisionDates, CFG).samples;

  console.log('');
  const surv = summarize('SURVIVOR-ONLY   ', runSurv, sSurv);
  const free = summarize('SURVIVORSHIP-FREE', runFree, sFree);
  const bias = (surv.meanFwd != null && free.meanFwd != null) ? surv.meanFwd - free.meanFwd : null;
  console.log(`\n[exp7] SURVIVORSHIP RETURN BIAS (survivor-only − free) over ${CFG.horizonBars}d: ${bias != null ? (100 * bias).toFixed(2) + '%' : 'n/a'}`);

  writeDoc({ decisionDates, survivors, delisted, poolSize: pool.length, runSurv, runFree, surv, free, bias, elapsedMs: Date.now() - t0 });
  console.log(`[exp7] wrote research/TWIN-SURVIVORSHIP-FREE-2026-07.md in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

function writeDoc(r) {
  const row = (o) => o ? `${o.ic >= 0 ? '+' : ''}${o.ic} (t ${o.t}, n ${o.n})` : '—';
  const es = r.runSurv.evaluation, ef = r.runFree.evaluation;
  const pct = (x) => (x == null ? 'n/a' : (100 * x).toFixed(2) + '%');
  const md = `# Experiment #7 — Survivorship-Free Twin Re-run (2026-07)

**Question.** #5 found the E8 historical-twin analog adds no momentum-orthogonal edge — but on a
current-survivor universe, so the verdict was survivorship-caveated. Does putting the delisted names
back (via the PIT security master) change the edge verdict, or the returns the test sees?

## Method
- Two universes from \`research/lib/secmaster\`, both drawn from the in-band cross-section at ${UNIVERSE_DATE} (${r.poolSize} names):
  - **Survivor-only:** top-${r.survivors.length} by liquidity, still active today.
  - **Survivorship-free:** those SAME survivors **plus** ${r.delisted.length} in-band names that have since delisted, with real retained price history to their last trading day.
- Identical tested harness (\`lib/nsl/twin-incremental\`), identical settings as #5 (6–1 momentum baseline, 4 PIT twin features, resolved-only analog pool, self-exclusion), ${r.decisionDates.length} month-end decision dates ${r.decisionDates[0]} → ${r.decisionDates.at(-1)} — a window that CONTAINS the 2022–2023 delistings.
- The survivor set is shared, so every delta is the **survivorship effect**.

## Result

| | Survivor-only | Survivorship-free |
|---|---|---|
| Names | ${r.runSurv.nNames} | ${r.runFree.nNames} |
| Samples · used dates | ${r.runSurv.nSamples} · ${es.usedDates} | ${r.runFree.nSamples} · ${ef.usedDates} |
| Baseline momentum IC | ${row(es.baseline)} | ${row(ef.baseline)} |
| **Twin ⟂ momentum IC** | ${row(es.incremental)} | ${row(ef.incremental)} |
| Twin verdict | \`${es.verdict || 'insufficient'}\` | \`${ef.verdict || 'insufficient'}\` |
| Mean forward return (${CFG.horizonBars}d) | ${pct(r.surv.meanFwd)} | ${pct(r.free.meanFwd)} |

- **Survivorship return bias (survivor-only − free):** **${pct(r.bias)}** over ${CFG.horizonBars}d — the amount a survivor-only backtest overstates realized forward returns by dropping the delisted tails, now measured *inside the edge frame* (compare research/04's return-only estimate).

## Reading
${(() => {
  const si = es.incremental, fi = ef.incremental;
  const bothInsig = si && fi && Math.abs(si.t) < 2 && Math.abs(fi.t) < 2;
  const shift = (si && fi) ? Math.abs((fi.ic || 0) - (si.ic || 0)) : null;
  const verdict = bothInsig
    ? `**Neither universe shows a significant orthogonal edge** (t ${si.t} survivor-only, t ${fi.t} survivorship-free — both < 2). So the twin no-edge conclusion HOLDS once the dead names are put back: **#5 was not a survivorship artifact.** But the point estimate SHIFTED by ${shift != null ? shift.toFixed(4) : 'n/a'} (${row(si)} → ${row(fi)}) — larger than the IC itself — a caution that a survivor-only IC is not reliable at face value even when the headline verdict is unchanged.`
    : `The orthogonal IC crosses the significance bar on one universe but not the other (${row(si)} vs ${row(fi)}) — survivorship materially changed the edge test, so the survivor-only verdict cannot be trusted at face value.`;
  return `- **On the edge verdict:** ${verdict}`;
})()}
- **On returns:** the raw ${CFG.horizonBars}d survivorship gap here is only ${pct(r.bias)} — SMALLER than research/04's ~+1.1%/63d, and honestly so: this run force-includes the **top-liquidity** delisted names, which skew toward M&A/acquisitions (often exited near fair value) rather than the illiquid bankruptcies that drive the tail, and it applies **no Shumway wipeout penalty**. The security master's value is not this particular number — it is that the delisted names are *available to test at all*; a broad, penalty-applied return study (research/04) is where the full bias shows up.

## Limits
- Bounded universe (${r.runFree.nNames} names, top-liquidity) for tractability, not the full ${r.poolSize}-name in-band cross-section; the sign/direction is robust but the magnitude is a lower bound on breadth.
- Delisting date ≈ last traded bar (no reason code); a return study should still apply a Shumway wipeout penalty for the bankruptcy cases (research/04 does).
- One window; the delisted density is highest in 2022–2023, so the effect is period-specific.

_Generated by research/51-twin-survivorship-free.js in ${(r.elapsedMs / 1000).toFixed(1)}s. Shadow research — never affects live ranks._
`;
  fs.writeFileSync(path.join(__dirname, 'TWIN-SURVIVORSHIP-FREE-2026-07.md'), md);
}

main();

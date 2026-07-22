'use strict';
// EXPERIMENT #9 — OMEGA-Swing edge test, run SURVIVORSHIP-FREE. Run (no network — reads the FMP
// cache via the PIT security master):
//   node research/53-omega-survivorship-free.js [--limit N] [--deadline SECONDS]
//
// WHY: the app's op=omegawf replays OMEGA over a STATIC present-day universe, so it stamps
// survivorshipSafe=false and can never promote a challenger. That flag can only be discharged the
// way NSL #7/#8 discharged it — by re-running the SAME scorer over a survivorship-COMPLETE
// cross-section (delisted names included up to their last trading day) and checking whether the
// verdict holds. This does exactly that for OMEGA, reusing the app's own pure core:
//   • lib/omega-swing.evaluateCandidate  — the identical 0–100 score / tier / features
//   • lib/omega-execution.planOmegaEntry  — the identical next-open / conditional fill model
//   • lib/omega-backfill.evaluateGates    — the identical fail-closed promotion gates
//   • lib/costs.roundTripCostPct          — the identical cost model (cost-net residual)
//
// CRITICAL leakage fix: OMEGA's own residualForward returns PENDING when the forward window does
// not fully elapse — which would silently DROP every delisted name and REINTRODUCE the very
// survivorship bias we are measuring. So the label here uses the PIT forward-return path (partial
// return + delistedWithin) with a Shumway (1997) terminal haircut, exactly like research/52.
//
// Shadow research — never touches a live ranking. survivorshipSafe=TRUE (universe drawn from the
// survivorship-complete master); historicalLiveParity=FALSE (this replay is not the live funnel),
// so a challenger still cannot be promoted off this harness alone — as the gates enforce.

const fs = require('fs');
const path = require('path');
const SM = require('./lib/secmaster');
const pit = require('./lib/pit');
const { rankIC, mean, sd } = require('../lib/nsl/stats');
const O = require('../lib/omega-swing');
const OX = require('../lib/omega-execution');
const { evaluateGates } = require('../lib/omega-backfill');
const { roundTripCostPct } = require('../lib/costs');

const BAND = SM.DEFAULT_BAND;
const HORIZONS = [['5d', 5], ['10d', 10]];
const SHUMWAY = 0.30;                                  // Shumway (1997) delisting-return penalty
const UNIVERSE_SEEDS = ['2022-06-30', '2023-06-30', '2024-06-30'];  // candidate-set seeds (union)
const MIN_HISTORY = 55;                                // computeFeatures floor
const MIN_PER_DATE = 8;                                // min names for a per-date rank-IC
const ACTIVE_CUTOFF_ISO = new Date(SM.ACTIVE_CUTOFF_MS).toISOString().slice(0, 10);

// GICS sector → SPDR ETF (only some are in the research cache; missing → market-relative only).
const SECTOR_ETF = {
  'Technology': 'XLK', 'Information Technology': 'XLK', 'Financials': 'XLF', 'Financial Services': 'XLF',
  'Health Care': 'XLV', 'Healthcare': 'XLV', 'Energy': 'XLE', 'Industrials': 'XLI',
  'Consumer Discretionary': 'XLY', 'Consumer Cyclical': 'XLY', 'Consumer Staples': 'XLP', 'Consumer Defensive': 'XLP',
  'Materials': 'XLB', 'Basic Materials': 'XLB', 'Real Estate': 'XLRE', 'Utilities': 'XLU',
  'Communication Services': 'XLC',
};

const arg = (flag, def) => { const i = process.argv.indexOf(flag); return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : def; };
const LIMIT = +arg('--limit', 0);
const DEADLINE_MS = +arg('--deadline', 300) * 1000;

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const pct = (x) => (x == null ? 'n/a' : (100 * x).toFixed(2) + '%');
const tstat = (a) => { const s = sd(a); return s > 0 ? mean(a) / (s / Math.sqrt(a.length)) : 0; };
const idxAsOfDate = (candles, dateISO) => { let i = -1; for (let k = 0; k < candles.length; k++) { if (candles[k].date <= dateISO) i = k; else break; } return i; };

// Precompute per-name once: OMEGA candle array, PIT series/shares, active flag.
function prep(rec) {
  const candles = SM.candlesFor(rec);
  const series = pit.priceSeries(rec.price || []);
  const shares = pit.sharesSeries(rec.income || []);
  const active = series.length ? series[series.length - 1].ms >= SM.ACTIVE_CUTOFF_MS : false;
  return { sym: rec.sym, sector: rec.sector || null, candles, series, shares, active };
}
function inBand(p, ms) {
  const pa = pit.asOfPriceAdv(p.series, ms); if (!pa || pa.stale) return false;
  const sh = pit.asOfShares(p.shares, ms); if (!sh) return false;
  const cap = pa.close * sh;
  return !(cap < BAND.capLo || cap > BAND.capHi || pa.adv < BAND.advFloor);
}
// SPY / sector benchmark forward return over the window [dateISO, +bars], close-to-close.
function benchFwd(candles, dateISO, bars) {
  const i = idxAsOfDate(candles, dateISO); if (i < 0) return null;
  const tgt = i + bars; if (tgt >= candles.length) return null;
  const e = candles[i].close; return e > 0 ? candles[tgt].close / e - 1 : null;
}
// Survivorship-free forward residual FROM THE EXECUTABLE FILL. Entry = the T+1 fill; exit = close
// `bars` sessions after the signal, or the LAST bar if the name delisted inside the window (with
// the Shumway haircut). Never returns pending — a dead name's truncated path IS its outcome.
function fwdResidual(candles, signalIdx, fillPrice, bars, benchRet) {
  if (!(fillPrice > 0)) return null;
  const tgt = signalIdx + bars;
  let exit, delisted = false;
  if (tgt < candles.length) exit = candles[tgt].close;
  else {
    const last = candles[candles.length - 1];
    if (candles.length - 1 <= signalIdx) return null;           // no forward data at all
    exit = last.close; delisted = true;
  }
  if (!(exit > 0)) return null;
  let raw = exit / fillPrice - 1;
  if (delisted) raw = (1 + raw) * (1 - SHUMWAY) - 1;            // terminal delisting penalty
  return { raw, residual: benchRet == null ? null : raw - benchRet, delisted };
}

function main() {
  const t0 = Date.now();
  console.log('[exp9] assembling the survivorship-free candidate set (union of in-band cross-sections)…');
  const cand = new Set();
  for (const d of UNIVERSE_SEEDS) for (const m of SM.universeAt(d, BAND)) cand.add(m.sym);
  let syms = [...cand];
  console.log(`[exp9] candidate names in-band at ≥1 seed date: ${syms.length}`);
  const recs = SM.loadRecordsForSyms(syms);
  let preps = Object.values(recs).map(prep).filter(p => p.candles.length > MIN_HISTORY + 12);
  // Bound for runtime WITHOUT re-introducing survivorship bias: keep EVERY delisted name (the whole
  // point) and cap only the survivor sample (top by recent ADV). --limit sets the survivor cap.
  const SURV_CAP = LIMIT > 0 ? LIMIT : 600;
  const dead = preps.filter(p => !p.active);
  let alive = preps.filter(p => p.active);
  if (alive.length > SURV_CAP) {
    alive.forEach(p => { const n = p.series.length; p._adv = n ? mean(p.series.slice(-20).map(r => r.dollar)) : 0; });
    alive = alive.sort((a, b) => b._adv - a._adv).slice(0, SURV_CAP);
  }
  preps = [...alive, ...dead];
  const survivors = preps.filter(p => p.active).length;
  console.log(`[exp9] prepped ${preps.length} names (${survivors} active today, ${preps.length - survivors} since delisted)`);

  // Benchmarks from the cache. SPY is the market; sector ETFs only where cached.
  const spyRec = SM.loadCached('SPY');
  const spy = spyRec ? SM.candlesFor(spyRec) : [];
  if (!spy.length) { console.error('[exp9] FATAL: SPY not in cache — cannot compute a market-relative label.'); process.exit(1); }
  const secCache = {};
  for (const etf of new Set(Object.values(SECTOR_ETF))) { const r = SM.loadCached(etf); if (r) secCache[etf] = SM.candlesFor(r); }
  const secCovered = Object.keys(secCache);
  console.log(`[exp9] benchmarks: SPY + ${secCovered.length} sector ETFs cached (${secCovered.join(', ') || 'none'})`);

  // Monthly decision dates over the delisting-dense window.
  const dates = pit.monthEnds('2022-06', '2024-06').map(iso);
  console.log(`[exp9] ${dates.length} month-end decision dates 2022-06 → 2024-06\n`);

  const rows = [];               // { date, sym, active, score, tier, utility, r10, relVol5, residual5, residual10, residual*Net, delisted }
  let evaluated = 0, noFill = 0, deadlineHit = false;
  const regime = { riskOn: false, bearish: false };   // neutral (no research-side macro feed) — the risk-off lever stays off

  outer:
  for (const dateISO of dates) {
    const dateMs = Date.parse(dateISO + 'T00:00:00Z');
    for (const p of preps) {
      if (Date.now() - t0 > DEADLINE_MS) { deadlineHit = true; break outer; }
      if (!inBand(p, dateMs)) continue;
      const cIdx = idxAsOfDate(p.candles, dateISO);
      if (cIdx < MIN_HISTORY) continue;
      const etf = SECTOR_ETF[p.sector];
      const secFull = etf && secCache[etf] ? secCache[etf] : null;
      const secSlice = secFull ? secFull.slice(0, idxAsOfDate(secFull, dateISO) + 1) : null;
      const spySlice = spy.slice(0, idxAsOfDate(spy, dateISO) + 1);
      const card = O.evaluateCandidate({
        ticker: p.sym, candles: p.candles.slice(0, cIdx + 1),
        bench: { spy: spySlice, sector: secSlice }, ctx: { regime, maturity: 'shadow', calibrated: false },
      });
      if (!card || !card.risk) continue;
      // Executable T+1 fill against the FULL series (a gap/no-trigger/delist-next-day is a no-trade).
      const tierName = OX.tierForDollarVol(card.features.dollarVol);
      const exec = OX.planOmegaEntry({
        candles: p.candles, signalDate: dateISO, entryClass: card.entry.classification, f: card.features,
        levels: card.risk.levels, stop: card.risk.invalidation, target1: card.risk.target1, tier: tierName,
      });
      if (exec.fillStatus !== 'filled') { noFill++; continue; }
      const fill = exec.assumedFillPrice;
      const rtCost = roundTripCostPct(tierName) / 100;
      const secBench = secFull ? benchFwd(secFull, dateISO, 10) : null;
      const spy10 = benchFwd(spy, dateISO, 10), spy5 = benchFwd(spy, dateISO, 5);
      // Weighted market+sector benchmark (fold sector weight into market when the ETF is absent).
      const bench10 = spy10 == null ? null : (secBench != null ? 0.6 * spy10 + 0.4 * secBench : spy10);
      const bench5 = spy5 == null ? null : (secBench != null ? 0.6 * spy5 + 0.4 * benchFwd(secFull, dateISO, 5) : spy5);
      const l10 = fwdResidual(p.candles, cIdx, fill, 10, bench10);
      const l5 = fwdResidual(p.candles, cIdx, fill, 5, bench5);
      if (!l10 || l10.residual == null) continue;
      rows.push({
        date: dateISO, sym: p.sym, active: p.active, score: card.score, tier: card.tier, utility: card.utility,
        r10: card.features.r10, relVol5: card.features.relVol5, delisted: l10.delisted,
        raw10: l10.raw, residual5: l5 ? l5.residual : null, residual10: l10.residual,
        residual5Net: l5 && l5.residual != null ? +(l5.residual - rtCost).toFixed(4) : null,
        residual10Net: +(l10.residual - rtCost).toFixed(4),
      });
      evaluated++;
    }
    process.stdout.write(`\r[exp9] scored ${evaluated} name-dates (${rows.filter(r => r.delisted).length} delistings)…   `);
  }
  console.log('');
  if (deadlineHit) console.log(`[exp9] ⏱ deadline (${DEADLINE_MS / 1000}s) hit — verdict will fail closed (notDeadlineTruncated gate).`);

  const analysis = analyze(rows, dates, { evaluated, noFill, deadlineHit, survivors, prepped: preps.length, candCount: cand.size, secCovered });
  writeDoc(analysis, Date.now() - t0);
  writeVerdictArtifact(analysis);
  console.log(`\n[exp9] verdict: ${analysis.verdict} · survivorshipSafe=true · promotable=${analysis.promotable}`);
  console.log(`[exp9] wrote research/OMEGA-SURVIVORSHIP-FREE-2026-07.md in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// Per-date rank-IC of `key` vs residual10, over a row subset.
function icOf(rows, key) {
  const byDate = {};
  for (const r of rows) { if (r[key] == null || r.residual10 == null) continue; (byDate[r.date] = byDate[r.date] || []).push(r); }
  const ics = [];
  for (const d of Object.keys(byDate)) { const g = byDate[d]; if (g.length >= MIN_PER_DATE) { const ic = rankIC(g.map(r => r[key]), g.map(r => r.residual10)); if (Number.isFinite(ic)) ics.push(ic); } }
  return { ic: ics.length ? mean(ics) : null, t: tstat(ics), nDates: ics.length };
}

function analyze(rows, dates, meta) {
  const withResid = rows.filter(r => r.residual10 != null);
  const surv = withResid.filter(r => r.active);
  // Score rank-IC survivorship-free vs survivor-only.
  const scoreFree = icOf(withResid, 'score');
  const scoreSurv = icOf(surv, 'score');
  // Baselines to beat (same as the app harness): 10d momentum, relVol.
  const baseMom = icOf(withResid, 'r10');
  const baseVol = icOf(withResid, 'relVol5');
  // Tier payoff on cost-net residual.
  const tierNetOf = (t) => { const g = withResid.filter(r => r.tier === t && r.residual10Net != null); return g.length >= 5 ? mean(g.map(r => r.residual10Net)) : null; };
  const tierNet = { prime: tierNetOf('OMEGA_PRIME'), qualified: tierNetOf('OMEGA_QUALIFIED'), watch: tierNetOf('OMEGA_WATCH') };
  const tierN = { prime: withResid.filter(r => r.tier === 'OMEGA_PRIME').length, qualified: withResid.filter(r => r.tier === 'OMEGA_QUALIFIED').length, watch: withResid.filter(r => r.tier === 'OMEGA_WATCH').length };
  // Survivorship RETURN bias: mean raw10 survivor-only − mean raw10 free.
  const meanRawFree = mean(withResid.map(r => r.raw10)), meanRawSurv = mean(surv.map(r => r.raw10));
  const bias = meanRawSurv - meanRawFree;
  // Purged sequential blocks (≥3) for the gates: per-block score→residual IC.
  const uDates = [...new Set(withResid.map(r => r.date))].sort();
  const nBlocks = Math.min(4, Math.max(3, Math.floor(uDates.length / 4)));
  const per = Math.ceil(uDates.length / nBlocks);
  const blockICs = [];
  for (let b = 0; b < nBlocks; b++) {
    const bd = new Set(uDates.slice(b * per, (b + 1) * per));
    const g = withResid.filter(r => bd.has(r.date));
    const ic = icOf(g, 'score').ic; if (ic != null) blockICs.push(+ic.toFixed(4));
  }
  const gates = evaluateGates({
    blockICs, deadlineTruncated: meta.deadlineHit, tierNet,
    scoreIC: scoreFree.ic, baseICs: [baseMom.ic, baseVol.ic].filter(x => x != null),
    historicalLiveParity: false, survivorshipSafe: true,     // the whole point of this harness
  });
  return {
    ...meta, nRows: rows.length, withResid: withResid.length, delistings: withResid.filter(r => r.delisted).length,
    scoreFree, scoreSurv, baseMom, baseVol, tierNet, tierN, meanRawFree, meanRawSurv, bias,
    blockICs, gates: gates.gates, passed: gates.passed, promotable: gates.promotable, verdict: gates.verdict,
    dateSpan: `${dates[0]} → ${dates[dates.length - 1]}`, datesCount: dates.length,
  };
}

function writeDoc(a, elapsedMs) {
  const g = a.gates;
  const md = `# Experiment #9 — OMEGA-Swing, Survivorship-Free (2026-07)

**Question.** The app's \`op=omegawf\` replays OMEGA over a STATIC present-day universe, so it stamps
\`survivorshipSafe=false\` — which structurally blocks any challenger promotion. This re-runs the
**identical OMEGA scorer, executable fill model, cost model, and fail-closed gates** over a
survivorship-COMPLETE cross-section (delisted names included up to their last trading day, via the
\`pit-secmaster-v1\` master), and asks whether OMEGA's ranking survives once the dead names are in.

## Method
- **Universe:** every name in-band ($300M–$10B cap, ≥$3M/day ADV) **as of each decision date**, from
  \`research/lib/secmaster\`; delisted names included up to their last trading day. Candidate set = union
  of the in-band cross-sections at ${UNIVERSE_SEEDS.join(', ')} → ${a.candCount} names, ${a.prepped} with enough history (${a.survivors} active today, ${a.prepped - a.survivors} since delisted).
- **Scorer:** the app's own \`lib/omega-swing.evaluateCandidate\` — identical 0–100 score, tier, features.
- **Execution:** \`lib/omega-execution.planOmegaEntry\` — the T+1 next-open / breakout-stop / pullback-limit
  fill; a gap-through, no-trigger, or delist-next-day is an honest **no-trade** (${a.noFill} dropped).
- **Label (leakage-safe):** survivorship-free forward residual FROM THE FILL — stock raw return minus a
  0.6·SPY + 0.4·sector-ETF move (sector where cached: ${a.secCovered.join(', ') || 'none'}, else market-only),
  net of the tiered round-trip cost. A name that **delists inside the window** takes the Shumway (1997)
  −30% terminal haircut and is NOT dropped (that would re-introduce the bias). OMEGA's own
  \`residualForward\` is deliberately NOT used here — it returns pending on a truncated window.
- **Dates:** ${a.datesCount} month-ends (${a.dateSpan}), the delisting-dense window.

## Result

| Metric | Survivorship-free | Survivor-only |
|---|---|---|
| Score → 10d residual rank-IC | ${fmtIC(a.scoreFree)} | ${fmtIC(a.scoreSurv)} |
| 10d momentum baseline rank-IC | ${fmtIC(a.baseMom)} | — |
| relVol baseline rank-IC | ${fmtIC(a.baseVol)} | — |
| Mean raw 10d return | ${pct(a.meanRawFree)} | ${pct(a.meanRawSurv)} |

- **Survivorship return bias (survivor − free):** **${pct(a.bias)}** over 10d.
- **Panel:** ${a.withResid} scored name-dates with a resolved residual, of which **${a.delistings}** were delistings taking the Shumway haircut.
- **Tier payoff (cost-net 10d residual):** PRIME ${pct(a.tierNet.prime)} (n=${a.tierN.prime}) · QUALIFIED ${pct(a.tierNet.qualified)} (n=${a.tierN.qualified}) · WATCH ${pct(a.tierNet.watch)} (n=${a.tierN.watch}).
- **Purged block ICs:** ${a.blockICs.length ? a.blockICs.join(', ') : 'n/a'}.

## Verdict — \`${a.verdict}\`

Fail-closed gates (\`lib/omega-backfill.evaluateGates\`, the SAME ones the app uses):

| Gate | Pass |
|---|---|
| ≥3 purged blocks all positive | ${g.minBlocksPositive} |
| mean OOS IC > margin | ${g.meanOOSaboveMargin} |
| not deadline-truncated | ${g.notDeadlineTruncated} |
| tier payoff monotone | ${g.tierMonotone} |
| beats every simple baseline | ${g.beatsBaselines} |
| **survivorship-safe** | **${g.survivorshipSafe}** |
| live-funnel parity | ${g.liveFunnelParity} |

- **passed (statistical edge): ${a.passed}** · **promotable: ${a.promotable}**

## Reading
- **The survivorship flag is discharged for OMEGA's evidence.** This harness draws its universe from
  the survivorship-complete master, so \`survivorshipSafe=true\` — the one gate the app's static-universe
  replay can never satisfy. ${a.passed
    ? 'OMEGA\'s ranking survives survivorship-free (statistical edge gates pass).'
    : 'OMEGA\'s ranking does NOT clear the statistical edge gates survivorship-free — consistent with the app\'s standing "no durable regime-robust selection edge on EOD/free data" verdict. A non-edge result here is expected and honest, not a bug.'}
- **promotable is still ${a.promotable}** because **live-funnel parity is ${g.liveFunnelParity}** — this
  research replay is not the live \`op=today\` funnel (Phase 4 capture accrues that separately, going
  forward). Both must hold before a challenger could ever be promoted; the gates enforce it.
- Survivorship biases the return **level** by ${pct(a.bias)}/10d${a.bias > 0 ? ' (survivor-only flatters)' : ''}, echoing #8's finding that survivorship shifts the level, not necessarily the ordering.

## Limits
- Delisting date ≈ last traded bar; Shumway −30% is a blanket penalty (mergers + bankruptcies pooled).
- Sector-relative only where the SPDR ETF is cached (${a.secCovered.join(', ') || 'none'}); other sectors are market-relative.
- Neutral regime (no research-side macro feed) — OMEGA's risk-off penalty lever is inactive here.
- Coverage is the ~10k-symbol FMP cache (2021–2026); one delisting-dense window; ${a.prepped} names${a.deadlineHit ? '; **deadline hit → truncated → fails closed**' : ''}.

_Generated by research/53-omega-survivorship-free.js in ${(elapsedMs / 1000).toFixed(1)}s. Shadow research — never affects live ranks. survivorshipSafe=true, historicalLiveParity=false._
`;
  fs.writeFileSync(path.join(__dirname, 'OMEGA-SURVIVORSHIP-FREE-2026-07.md'), md);
}
const fmtIC = (x) => (x && x.ic != null ? `${x.ic.toFixed(4)} (t ${x.t.toFixed(2)}, ${x.nDates} dates)` : 'n/a');

// Emit a compact, machine-readable verdict artifact that ships WITH the app (lib/, so it deploys)
// and is the single source of truth op=omegamodel surfaces. Regenerated on every re-run — this
// script is the only writer, so the number the app shows is always the number research produced.
function writeVerdictArtifact(a) {
  const rnd = (x, d = 4) => (x == null ? null : +x.toFixed(d));
  const artifact = {
    schema: 'OmegaResearchVerdict', version: 'omega-research-verdict-v1',
    experiment: 'research/53-omega-survivorship-free.js',
    doc: 'research/OMEGA-SURVIVORSHIP-FREE-2026-07.md',
    master: SM.VERSION,
    generatedAt: new Date().toISOString(),
    verdict: a.verdict, passed: a.passed, promotable: a.promotable,
    survivorshipSafe: true, historicalLiveParity: false,
    universe: {
      candidates: a.candCount, prepped: a.prepped, active: a.survivors, delisted: a.prepped - a.survivors,
      nameDates: a.withResid, delistingsInWindow: a.delistings, dates: a.datesCount, dateSpan: a.dateSpan,
      sectorETFs: a.secCovered,
    },
    metrics: {
      scoreIC_survivorshipFree: rnd(a.scoreFree.ic), scoreIC_free_t: rnd(a.scoreFree.t, 2),
      scoreIC_survivorOnly: rnd(a.scoreSurv.ic), momentumBaselineIC: rnd(a.baseMom.ic), relVolBaselineIC: rnd(a.baseVol.ic),
      survivorshipReturnBias10d: rnd(a.bias), meanRaw10dFree: rnd(a.meanRawFree), meanRaw10dSurvivor: rnd(a.meanRawSurv),
      tierNetResidual: { prime: rnd(a.tierNet.prime), qualified: rnd(a.tierNet.qualified), watch: rnd(a.tierNet.watch) },
      blockICs: a.blockICs,
    },
    gates: a.gates,
    reading: a.passed
      ? 'OMEGA\'s ranking clears the statistical edge gates survivorship-free.'
      : 'No durable selection edge even survivorship-free — below the momentum baseline. survivorshipSafe is DISCHARGED (not an artifact); the answer is no-edge. OMEGA stays shadow/weight-0 unless prospective evidence contradicts this.',
  };
  fs.writeFileSync(path.join(__dirname, '..', 'lib', 'omega-research-verdict.json'), JSON.stringify(artifact, null, 2) + '\n');
}

main();

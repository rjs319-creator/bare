'use strict';
// DILUTION / OFFERING EVENTS — do 424B5 prospectus supplements (follow-ons, ATMs, shelf
// takedowns) predict negative forward excess return? An AVOID-shaped hypothesis, tested
// on the one event source in this whole program with genuinely immutable point-in-time
// timestamps: EDGAR filing dates are public record and never restated.
//
//   RESEARCH_DATA_DIR=~/dev/market-news-app/research/data node research/95-dilution-events.js
//
// Declared caveats:
//  • Form-level classification only: 424B5 also covers selling-holder secondaries and
//    debt takedowns; no content parsing. Noise dilutes (pun intended) any true effect
//    toward zero — a null here is weaker evidence than a null on a parsed sample.
//  • Entry uses the filing DATE, not the acceptance timestamp: entry is the NEXT session's
//    open after the filed date, which is executable whether the filing hit at 9am or 9pm.
//    Conservative by construction (a real desk could sometimes act same-day).
//  • Outcome is SPY-relative (no sector map for the full EDGAR universe) minus one tiered
//    round-trip cost — matching how an avoid/short overlay would actually be judged.

const fs = require('node:fs');
const path = require('node:path');
const K = require('./lib/experiment-kit');
const S3 = require('../lib/research/stats-v3');

const OUT_DIR = path.join(__dirname, 'data', 'dilution-events');
const HITS = path.join(OUT_DIR, 'hits.jsonl');
const UA = 'market-news-research rjs319@gmail.com';

const FROZEN = Object.freeze({
  id: 'dilution-events-2026-08',
  family: 'dilution-events',
  declaredBeforeReadingResults: true,
  source: 'EDGAR full-text search, forms=424B5, biweekly windows over the bars-cache span',
  eligibility: 'ticker resolvable from the filing, present in the bars cache, trailing 60-session ADV >= $5M at the event',
  dedupe: 'first filing per ticker; subsequent filings within 30 sessions suppressed (ATM programs re-file constantly)',
  entry: 'next session OPEN after the filed date; exit close(entry+H)',
  horizons: [5, 21, 63],
  outcome: 'stock forward − SPY forward − one tiered round-trip cost',
  hypothesis: 'NEGATIVE mean (dilution/supply events are an avoid signal)',
  primaryCells: ['DIL_5', 'DIL_21', 'DIL_63'],
  multipleTesting: 'Benjamini-Hochberg across the 3 cells',
  promisingGate: 'mean < 0 with q < 0.05 AND >= 3/4 chronological blocks negative — then RESEARCH_PROMISING as an AVOID flag only',
  insufficient: 'fewer than 100 eligible events in a cell → INSUFFICIENT_DATA',
  pitClass: 'EDGAR filing dates are immutable public record — the event CLOCK is genuine PIT; prices are the shared research cache',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchAllHits(firstBar, lastBar) {
  if (fs.existsSync(HITS)) return fs.readFileSync(HITS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = [];
  let start = new Date(firstBar);
  const end = new Date(lastBar);
  while (start < end) {
    const stop = new Date(Math.min(end.getTime(), start.getTime() + 13 * 864e5));
    const sd = start.toISOString().slice(0, 10), ed = stop.toISOString().slice(0, 10);
    for (let from = 0; from < 10000; from += 100) {
      const url = `https://efts.sec.gov/LATEST/search-index?q=&forms=424B5&dateRange=custom&startdt=${sd}&enddt=${ed}&from=${from}&size=100`;
      let j = null;
      for (let attempt = 0; attempt < 3 && !j; attempt++) {
        try { const r = await fetch(url, { headers: { 'user-agent': UA } }); if (r.ok) j = await r.json(); else await sleep(1000 * (attempt + 1)); }
        catch { await sleep(1000 * (attempt + 1)); }
      }
      if (!j) throw new Error(`EDGAR window ${sd}..${ed} failed after retries`);
      const hits = (j.hits && j.hits.hits) || [];
      for (const h of hits) {
        const s = h._source || {};
        const m = /\(([A-Z][A-Z.\-]{0,7})\)\s*\(CIK/.exec((s.display_names || [])[0] || '');
        out.push({ ticker: m ? m[1].replace(/\./g, '-') : null, cik: (s.ciks || [])[0] || null, fileDate: s.file_date, adsh: s.adsh });
      }
      if (hits.length < 100) break;
      await sleep(150);
    }
    process.stdout.write(`  ${sd} cumulative ${out.length}\n`);
    start = new Date(stop.getTime() + 864e5);
    await sleep(150);
  }
  fs.writeFileSync(HITS, out.map((x) => JSON.stringify(x)).join('\n') + '\n');
  return out;
}

const summarize = (rows, label) => {
  const vals = rows.map((r) => r.value).filter(Number.isFinite);
  const s = K.summarizeByDate(rows, { horizonBars: 21 });
  if (!s || !vals.length) return null;
  const { perDateCounts, ...rest } = s;
  const avgPrecise = vals.reduce((a, b) => a + b, 0) / vals.length;
  const p = (Number.isFinite(rest.se) && rest.se > 0 && !vals.every((v) => v === vals[0])) ? S3.pFromT(avgPrecise / rest.se) : null;
  return { label, ...rest, avgPrecise: +avgPrecise.toFixed(6), avgBpsPerEvent: +(avgPrecise * 10000).toFixed(1), p };
};

(async () => {
  const spyRaw = K.loadSeries(path.join(K.CACHE_DIR, 'SPY.json'));
  if (!spyRaw) throw new Error('SPY series missing');
  const spy = { candles: spyRaw, idx: new Map(spyRaw.map((r, i) => [r.date, i])) };
  const firstBar = spyRaw[25].date, lastBar = spyRaw[spyRaw.length - 1].date;

  const hits = await fetchAllHits(firstBar, lastBar);
  const attrition = { noTicker: 0, noSeries: 0, illiquid: 0, dedupedAtm: 0, noDecisionBar: 0, truncated: { 5: 0, 21: 0, 63: 0 } };

  // one event per ticker per 30 sessions, oldest first
  const byTicker = new Map();
  const seriesCache = new Map();
  const loadT = (t) => {
    if (!seriesCache.has(t)) {
      const c = K.loadSeries(path.join(K.CACHE_DIR, `${t}.json`));
      seriesCache.set(t, c ? { candles: c, idx: new Map(c.map((r, i) => [r.date, i])) } : null);
    }
    return seriesCache.get(t);
  };

  const events = [];
  for (const h of hits.sort((a, b) => (a.fileDate < b.fileDate ? -1 : 1))) {
    if (!h.ticker) { attrition.noTicker++; continue; }
    const entry = loadT(h.ticker);
    if (!entry) { attrition.noSeries++; continue; }
    // decision session = last bar ≤ fileDate (entry happens NEXT session)
    let decIdx = -1;
    for (let i = entry.candles.length - 1; i >= 0; i--) { if (entry.candles[i].date <= h.fileDate) { decIdx = i; break; } }
    if (decIdx < 25) { attrition.noDecisionBar++; continue; }
    const dec = entry.candles[decIdx].date;
    const last = byTicker.get(h.ticker);
    if (last != null && decIdx - last < 30) { attrition.dedupedAtm++; continue; }
    const adv = K.advOf(entry.candles.slice(0, decIdx + 1));
    if (adv < 5e6) { attrition.illiquid++; continue; }
    byTicker.set(h.ticker, decIdx);
    events.push({ ticker: h.ticker, dec, entry, cost: K.costFractions(adv) });
  }

  const cells = { DIL_5: [], DIL_21: [], DIL_63: [] };
  // Adversarial controls, declared with the design:
  //  • GROSS lanes — an AVOID flag is judged on the untraded drift; subtracting a round
  //    trip you never pay overstates the negative.
  //  • PLACEBO — same ticker, 126 sessions BEFORE the filing, same horizon: if these
  //    names drift down unconditionally (size/beta, not the event), event ≈ placebo and
  //    the flag is a characteristic screen, not event timing. Reported as the paired
  //    per-date diff (event − placebo) on events where the placebo window exists.
  const gross = { DIL_5: [], DIL_21: [], DIL_63: [] };
  const evMinusPlacebo = { DIL_5: [], DIL_21: [], DIL_63: [] };
  const PLACEBO_BACK = 126;
  for (const ev of events) {
    const decIdx = ev.entry.idx.get(ev.dec);
    const plaIdx = decIdx != null ? decIdx - PLACEBO_BACK : null;
    const pla = plaIdx != null && plaIdx >= 25 ? ev.entry.candles[plaIdx].date : null;
    for (const H of FROZEN.horizons) {
      const fwd = K.forwardFromNextOpen(ev.entry, ev.dec, H);
      const bench = K.benchmarkForward(spy.candles, spy.idx, ev.dec, H);
      if (fwd == null || bench == null) { attrition.truncated[H]++; continue; }
      cells[`DIL_${H}`].push({ date: ev.dec, value: fwd - bench - ev.cost.base, ticker: ev.ticker });
      gross[`DIL_${H}`].push({ date: ev.dec, value: fwd - bench, ticker: ev.ticker });
      if (pla && spy.idx.has(pla)) {
        const pFwd = K.forwardFromNextOpen(ev.entry, pla, H);
        const pBench = K.benchmarkForward(spy.candles, spy.idx, pla, H);
        if (pFwd != null && pBench != null) {
          evMinusPlacebo[`DIL_${H}`].push({ date: ev.dec, value: (fwd - bench) - (pFwd - pBench), ticker: ev.ticker });
        }
      }
    }
  }

  const results = {}, verdicts = {};
  for (const c of FROZEN.primaryCells) {
    results[c] = cells[c].length < 100
      ? { label: c, n: cells[c].length, verdict: 'INSUFFICIENT_DATA' }
      : summarize(cells[c], c);
  }
  const fdrOut = K.fdr(FROZEN.primaryCells.map((c) => ({ id: c, p: results[c] && results[c].p })).filter((x) => Number.isFinite(x.p)), { alpha: 0.05 });
  for (const c of FROZEN.primaryCells) {
    const r = results[c];
    if (!r || r.verdict === 'INSUFFICIENT_DATA') { verdicts[c] = 'INSUFFICIENT_DATA'; continue; }
    const q = fdrOut.find((x) => x.id === c)?.q ?? null;
    const negStable = r.blockStability && r.blockStability.blocks >= 4 && (r.blockStability.blocks - r.blockStability.positive) >= 3;
    verdicts[c] = (q != null && q < 0.05 && r.avgPrecise < 0 && negStable)
      ? 'RESEARCH_PROMISING_AVOID_FLAG'
      : r.avgPrecise < 0 ? 'NEGATIVE_BUT_NOT_SIGNIFICANT' : 'NO_AVOID_SIGNAL';
  }

  const controls = {};
  for (const c of FROZEN.primaryCells) {
    controls[`${c}_GROSS`] = summarize(gross[c], `${c}_GROSS (no cost haircut — the avoid-flag lane)`);
    controls[`${c}_VS_PLACEBO`] = summarize(evMinusPlacebo[c], `${c}_VS_PLACEBO (event − same-ticker 126-sessions-earlier drift)`);
  }
  // Concentration/skew robustness on the GROSS lane: an avoid flag carried by a handful
  // of collapses is a lottery-avoidance anecdote, not a signal.
  const robustness = {};
  for (const c of FROZEN.primaryCells) {
    const vals = gross[c].map((r) => r.value).filter(Number.isFinite).sort((a, b) => a - b);
    if (!vals.length) continue;
    const median = vals[Math.floor(vals.length / 2)];
    const shareNegative = vals.filter((v) => v < 0).length / vals.length;
    const trimmed = vals.slice(10);   // drop the 10 WORST events (most negative)
    const trimmedMean = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
    robustness[c] = {
      medianBps: +(median * 10000).toFixed(1),
      shareNegative: +shareNegative.toFixed(3),
      meanBpsAfterDropping10Worst: +(trimmedMean * 10000).toFixed(1),
      events: vals.length,
    };
  }
  const out = {
    version: 'dilution-events-v1', ranAt: new Date().toISOString(), frozen: FROZEN,
    filingsFetched: hits.length, eligibleEvents: events.length, attrition,
    counts: Object.fromEntries(FROZEN.primaryCells.map((c) => [c, cells[c].length])),
    results, controls, robustness, fdr: fdrOut, verdicts,
  };
  const art = K.writeArtifact(OUT_DIR, 'dilution-events-result.json', out);
  K.recordExperiment({
    id: FROZEN.id, hypothesis: FROZEN.hypothesis + ' — 424B5 supply events carry negative forward SPY-excess, usable only as an AVOID flag.',
    family: FROZEN.family, frozenConfig: FROZEN,
    dataSnapshot: { filingsFetched: hits.length, eligibleEvents: events.length, attrition, counts: out.counts },
    trialCount: FROZEN.primaryCells.length,
    results: { results, controls, robustness, fdr: fdrOut, verdicts },
    artifact: art,
  });
  const brief = (v) => v && { n: v.n ?? v.dates, bps: v.avgBpsPerEvent, p: v.p, blocks: v.blockStability && `${v.blockStability.positive}+/${v.blockStability.blocks}` };
  console.log(JSON.stringify({ filings: hits.length, events: events.length, attrition, counts: out.counts, verdicts, cells: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, brief(v)])), controls: Object.fromEntries(Object.entries(controls).map(([k, v]) => [k, brief(v)])) }, null, 1));
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

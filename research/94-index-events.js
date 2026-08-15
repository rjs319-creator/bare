'use strict';
// INDEX FORCED-FLOW EVENTS — S&P 500 additions and deletions, 2021-08 → bars-cache end.
//
//   RESEARCH_DATA_DIR=~/dev/market-news-app/research/data node research/94-index-events.js
//
// Hypothesis (recorded before running): index membership changes create MECHANICAL,
// non-informational flow (trackers must buy adds / sell deletes), and the classic
// literature finding is a post-deletion REBOUND in the deleted name once the forced
// selling clears — one of the few structural effects a capacity-unconstrained solo
// operator could hold. The additions side is measured as the paired cell; post-2010s
// literature expects it near zero.
//
// PIT caveats, declared up front:
//  • Wikipedia's changes table records the EFFECTIVE date; the announcement (where much
//    of the historical effect concentrates) is typically ~5 sessions earlier and is not
//    captured here. This design measures the POST-EFFECTIVE window only — entry at the
//    next session's open after the effective-date session. That is the only version of
//    the trade an EOD operator could actually take, so it is the honest one to test.
//  • Membership list scraped today could in principle differ from history as written
//    then; dates/reasons on this table are stable public record, class = EXPLORATORY.
//  • Deleted names that stop trading (acquisitions, bankruptcies with no bars) are
//    excluded and COUNTED — the rebound hypothesis only concerns names that keep trading.

const fs = require('node:fs');
const path = require('node:path');
const K = require('./lib/experiment-kit');
const S3 = require('../lib/research/stats-v3');

const OUT_DIR = path.join(__dirname, 'data', 'index-events');
// 2026-08-11: Wikipedia moved the changes table off List_of_S%26P_500_companies into a
// dedicated article. (Side effect worth knowing: lib/constituents.js still scrapes the
// old page and now silently gets ZERO removals — its best-effort fallback masks this.)
const WIKI = 'https://en.wikipedia.org/wiki/Historical_components_of_the_S%26P_500';
const HTML_CACHE = path.join(OUT_DIR, 'wiki-changes.html');

const FROZEN = Object.freeze({
  id: 'index-events-2026-08',
  family: 'index-events',
  declaredBeforeReadingResults: true,
  events: 'S&P 500 changes table (Wikipedia), effective dates within the bars cache window',
  exclusions: 'deletions with reason matching /acquir|merg|taken private|purchas|bought|combin/i (no tradeable post-event security); names without a decision bar within 7 calendar days of the effective date (renamed/halted/delisted)',
  entry: 'next session OPEN after the last session ≤ effective date; exit at close(entry+H)',
  horizons: [5, 21, 63],
  outcome: 'stock forward return − SPY forward return − one tiered round-trip cost (kit costFractions on trailing ADV)',
  primaryCells: ['DEL_5', 'DEL_21', 'DEL_63', 'ADD_5', 'ADD_21', 'ADD_63'],
  multipleTesting: 'Benjamini-Hochberg across the 6 cells',
  insufficient: 'a cell with fewer than 30 events is INSUFFICIENT_DATA regardless of its point estimate',
  promisingGate: 'q < 0.05 AND ≥3/4 chronological blocks agree AND positive after doubled costs — still EXPLORATORY (effective-date-only capture, scraped source)',
});

async function fetchHtml() {
  if (fs.existsSync(HTML_CACHE)) return fs.readFileSync(HTML_CACHE, 'utf8');
  const res = await fetch(WIKI, { headers: { 'user-agent': 'market-news-research/1.0 (index-change study; contact: repo owner)' } });
  if (!res.ok) throw new Error(`wikipedia ${res.status}`);
  const html = await res.text();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(HTML_CACHE, html);
  return html;
}

// Parse the "Selected changes" wikitable → [{date, add, del, reason}]. Same attribute-
// tolerant row regex as lib/constituents.js (a strict <tr> matched zero rows there).
function parseChanges(html) {
  const tables = [...html.matchAll(/<table[^>]*class="[^"]*wikitable[^"]*"[\s\S]*?<\/table>/g)].map((m) => m[0]);
  const changes = tables.find((t) => /Removed/.test(t) && /Date/.test(t) && /Reason/i.test(t));
  if (!changes) throw new Error('changes table not found');
  const out = [];
  for (const rowMatch of changes.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...rowMatch[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
      .map((c) => c[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim());
    if (cells.length < 6) continue;                    // Date | +Ticker | +Name | −Ticker | −Name | Reason
    const d = new Date(cells[0]);
    if (isNaN(d)) continue;
    const norm = (t) => (t || '').replace(/\./g, '-').trim();
    const tick = (t) => (/^[A-Z][A-Z\-]{0,5}$/.test(norm(t)) ? norm(t) : null);
    out.push({ date: d.toISOString().slice(0, 10), add: tick(cells[1]), del: tick(cells[3]), reason: cells[5] || '' });
  }
  return out;
}

const seriesFor = (sym) => {
  const c = K.loadSeries(path.join(K.CACHE_DIR, `${sym}.json`));
  if (!c) return null;
  return { candles: c, idx: new Map(c.map((r, i) => [r.date, i])) };
};

function decisionSessionFor(entry, eventDate) {
  // last session ≤ effective date, but not more than 7 calendar days stale
  for (let i = entry.candles.length - 1; i >= 0; i--) {
    const d = entry.candles[i].date;
    if (d <= eventDate) {
      return (Date.parse(eventDate) - Date.parse(d)) <= 7 * 864e5 ? d : null;
    }
  }
  return null;
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
  if (!spyRaw) throw new Error('SPY series missing from cache');
  const spy = { candles: spyRaw, idx: new Map(spyRaw.map((r, i) => [r.date, i])) };
  const firstBar = spyRaw[0].date, lastBar = spyRaw[spyRaw.length - 1].date;

  const changes = parseChanges(await fetchHtml());
  const windowed = changes.filter((c) => c.date >= firstBar && c.date <= lastBar);
  const MNA = /acquir|merg|taken private|purchas|bought|combin/i;

  const attrition = { mnaDeletions: 0, noSeries: 0, noDecisionBar: 0, truncated: { 5: 0, 21: 0, 63: 0 }, other: 0 };
  const cells = {};
  for (const c of FROZEN.primaryCells) cells[c] = [];
  const eventLog = [];

  for (const ch of windowed) {
    const legs = [];
    if (ch.add) legs.push({ side: 'ADD', sym: ch.add });
    if (ch.del) {
      if (MNA.test(ch.reason)) attrition.mnaDeletions++;
      else legs.push({ side: 'DEL', sym: ch.del });
    }
    for (const leg of legs) {
      const entry = seriesFor(leg.sym);
      if (!entry) { attrition.noSeries++; continue; }
      const dec = decisionSessionFor(entry, ch.date);
      if (!dec || !spy.idx.has(dec)) { attrition.noDecisionBar++; continue; }
      const adv = K.advOf(entry.candles.slice(0, (entry.idx.get(dec) ?? 0) + 1));
      const cost = K.costFractions(adv);
      for (const H of FROZEN.horizons) {
        const fwd = K.forwardFromNextOpen(entry, dec, H);
        const bench = K.benchmarkForward(spy.candles, spy.idx, dec, H);
        if (fwd == null || bench == null) { attrition.truncated[H]++; continue; }
        const value = fwd - bench - cost.base;
        cells[`${leg.side}_${H}`].push({ date: dec, value, sym: leg.sym });
        if (H === 21) eventLog.push({ side: leg.side, sym: leg.sym, effective: ch.date, decision: dec, excess21net: +value.toFixed(4), reason: ch.reason.slice(0, 60), costTier: cost.tier });
      }
    }
  }

  const results = {};
  for (const c of FROZEN.primaryCells) {
    const n = cells[c].length;
    results[c] = n < 30
      ? { label: c, n, verdict: 'INSUFFICIENT_DATA', note: `${n} events < 30 floor` }
      : summarize(cells[c], c);
  }
  const fdrOut = K.fdr(FROZEN.primaryCells.map((c) => ({ id: c, p: results[c] && results[c].p })).filter((x) => Number.isFinite(x.p)), { alpha: 0.05 });
  const verdicts = {};
  for (const c of FROZEN.primaryCells) {
    const r = results[c];
    if (!r || r.verdict === 'INSUFFICIENT_DATA') { verdicts[c] = 'INSUFFICIENT_DATA'; continue; }
    const q = fdrOut.find((x) => x.id === c)?.q ?? null;
    const stable = r.blockStability && r.blockStability.blocks >= 4 && r.blockStability.positive >= 3;
    verdicts[c] = (q != null && q < 0.05 && r.avgPrecise > 0 && stable)
      ? 'RESEARCH_PROMISING (exploratory — effective-date-only capture)'
      : r.avgPrecise > 0 ? 'POSITIVE_BUT_NOT_SIGNIFICANT' : 'NO_EDGE';
  }

  const out = {
    version: 'index-events-v1', ranAt: new Date().toISOString(), frozen: FROZEN,
    barsWindow: { firstBar, lastBar },
    eventsParsed: changes.length, eventsInWindow: windowed.length,
    attrition, counts: Object.fromEntries(FROZEN.primaryCells.map((c) => [c, cells[c].length])),
    results, fdr: fdrOut, verdicts, eventLog,
  };
  const art = K.writeArtifact(OUT_DIR, 'index-events-result.json', out);
  K.recordExperiment({
    id: FROZEN.id,
    hypothesis: 'S&P 500 deletions rebound (positive net SPY-excess) after forced selling clears; additions are the paired control cell expected ≈ 0.',
    family: FROZEN.family, frozenConfig: FROZEN,
    dataSnapshot: { eventsInWindow: windowed.length, counts: out.counts, attrition },
    trialCount: FROZEN.primaryCells.length,
    results: { results, fdr: fdrOut, verdicts },
    artifact: art,
  });
  console.log(JSON.stringify({ counts: out.counts, attrition, verdicts, cells: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v && { n: v.n ?? v.dates, bps: v.avgBpsPerEvent, p: v.p, blocks: v.blockStability && `${v.blockStability.positive}/${v.blockStability.blocks}` }])) }, null, 1));
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });

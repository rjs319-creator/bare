'use strict';
// Phase-0 step 04 — QUANTIFY SURVIVORSHIP BIAS. Run (after the 03 full pull):
//   node --env-file=research/.env research/04-survivorship-bias.js [delistedSample]  (default 800)
//
// Compares forward returns of in-band SURVIVORS vs in-band names that later
// DELISTED. The survivor-only panel omits the delisted tails entirely; the gap
// between the two = the survivorship bias a naive small-cap backtest inherits.
//
// Honesty rules:
//  • A name is "inactive/delisted" only if its last bar predates ACTIVE_CUTOFF;
//    otherwise a partial forward window just means the horizon hasn't elapsed —
//    those months are EXCLUDED (not counted as delistings).
//  • For real delistings inside the forward window we report two variants:
//    A = return to the last traded bar (understates the wipeout);
//    B = Shumway (1997) −30% delisting penalty applied to the terminal value.
//
//   node research/04-survivorship-bias.js --sp500-pit
// runs the INDEX-LEVEL twin instead: at every month-end, the cross-section a naive
// backtest uses (TODAY's S&P 500 list, back-filled) vs the point-in-time membership
// (research/lib/sp500-pit, vendored fja05680/sp500), both over the cached series via
// secmaster.universeFrom({ membership }). The gap in mean forward return is the
// survivorship bias of back-filling the current index list. Cache coverage of PIT
// member-months is reported — a member with no cached series is a stated hole.

const fs = require('fs');
const path = require('path');
const pit = require('./lib/pit');
const SM = require('./lib/secmaster');

const DATA = path.join(__dirname, 'data');
const ACTIVE_CUTOFF = Date.UTC(2026, 3, 1);        // last bar ≥ Apr-2026 ⇒ still active
const HORIZONS = [['21d', 21], ['63d', 63]];
const SHUMWAY = 0.30;
const GRID = pit.monthEnds('2021-07', '2026-06');

function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

// For one symbol's cached data, emit in-band name-months with forward returns.
function nameMonths(rec) {
  const ps = pit.priceSeries(rec.price), ss = pit.sharesSeries(rec.income);
  if (ps.length < 30 || !ss.length) return null;
  const lastMs = ps[ps.length - 1].ms;
  const active = lastMs >= ACTIVE_CUTOFF;
  const rows = [];
  for (const d of GRID) {
    const pa = pit.asOfPriceAdv(ps, d); const sh = pit.asOfShares(ss, d);
    if (!pa || pa.stale || !sh) continue;
    const cap = pa.close * sh;
    if (cap < pit.CAP_LO || cap > pit.CAP_HI || pa.adv < pit.ADV_FLOOR) continue; // in-band only
    const row = { d };
    for (const [hk, bars] of HORIZONS) {
      const fr = pit.fwdReturn(ps, d, bars);
      if (!fr) continue;
      if (fr.delistedWithin && active) continue;     // active name: window just hasn't elapsed → skip
      row[hk + 'A'] = fr.ret;
      row[hk + 'B'] = fr.delistedWithin ? (1 + fr.ret) * (1 - SHUMWAY) - 1 : fr.ret;
      row[hk + 'Del'] = fr.delistedWithin;
    }
    rows.push(row);
  }
  return { active, rows };
}

function aggregate(records) {
  const acc = {}; for (const [hk] of HORIZONS) acc[hk] = { A: [], B: [], delN: 0, n: 0 };
  let names = 0, nameMonthsN = 0;
  for (const r of records) {
    const nm = nameMonths(r); if (!nm || !nm.rows.length) continue;
    names++;
    for (const row of nm.rows) {
      for (const [hk] of HORIZONS) {
        if (row[hk + 'A'] == null) continue;
        acc[hk].A.push(row[hk + 'A']); acc[hk].B.push(row[hk + 'B']);
        if (row[hk + 'Del']) acc[hk].delN++; acc[hk].n++; nameMonthsN++;
      }
    }
  }
  return { names, nameMonthsN, acc };
}

// Forward returns (A / B variants) for one cross-section at month-end d.
function collectForward(acc, xs, recsBySym, d) {
  for (const row of xs) {
    const ps = pit.priceSeries(recsBySym[row.sym].price);
    const active = ps[ps.length - 1].ms >= ACTIVE_CUTOFF;
    for (const [hk, bars] of HORIZONS) {
      const fr = pit.fwdReturn(ps, d, bars);
      if (!fr || (fr.delistedWithin && active)) continue;
      acc[hk].A.push(fr.ret);
      acc[hk].B.push(fr.delistedWithin ? (1 + fr.ret) * (1 - SHUMWAY) - 1 : fr.ret);
      if (fr.delistedWithin) acc[hk].delN++;
    }
  }
}
const newAcc = () => Object.fromEntries(HORIZONS.map(([hk]) => [hk, { A: [], B: [], delN: 0 }]));

async function sp500PitComparison() {
  const SP = require('./lib/sp500-pit').loadVendored();
  const current = SP.currentMembers();
  const recs = {}; const missingCache = [];
  for (const sym of SP.tickers) {
    const f = path.join(pit.CACHE, `${sym}.json`);
    if (!fs.existsSync(f)) { missingCache.push(sym); continue; }
    try { recs[sym] = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { missingCache.push(sym); }
  }
  const acc = { current: newAcc(), pit: newAcc() };
  let months = 0, pitMemberMonths = 0, pitMemberMonthsCached = 0, xsCur = 0, xsPit = 0;
  for (const d of GRID) {
    const members = SP.membersAt(d);
    if (!members) continue;
    months++;
    pitMemberMonths += members.size;
    pitMemberMonthsCached += [...members].filter((s) => recs[s]).length;
    const cur = SM.universeFrom(recs, d, null, { membership: current });   // today's list, back-filled
    const pitXs = SM.universeFrom(recs, d, null, { membership: members }); // what was actually in the index
    xsCur += cur.length; xsPit += pitXs.length;
    collectForward(acc.current, cur, recs, d);
    collectForward(acc.pit, pitXs, recs, d);
  }
  const pct = (x) => (x == null ? 'n/a' : (x * 100).toFixed(2) + '%');
  console.log('\n=== S&P 500 INDEX-LEVEL SURVIVORSHIP BIAS (current list back-filled vs PIT membership) ===');
  console.log(`months ${months} (${new Date(GRID[0]).toISOString().slice(0, 7)} → ${new Date(GRID[GRID.length - 1]).toISOString().slice(0, 7)}) | avg cross-section: current-list ${Math.round(xsCur / months)}, PIT ${Math.round(xsPit / months)}`);
  console.log(`PIT member-months with a cached series: ${pitMemberMonthsCached}/${pitMemberMonths} (${(100 * pitMemberMonthsCached / pitMemberMonths).toFixed(1)}%) | ever-members without any cache: ${missingCache.length}/${SP.tickers.length}`);
  const out = { generatedAt: new Date().toISOString(), mode: 'sp500-pit', months, coverage: { pitMemberMonths, pitMemberMonthsCached, everMembersMissingCache: missingCache.length, everMembers: SP.tickers.length }, horizons: {} };
  for (const [hk] of HORIZONS) {
    const c = acc.current[hk], p = acc.pit[hk];
    const row = { currentA: mean(c.A), currentB: mean(c.B), pitA: mean(p.A), pitB: mean(p.B), nCurrent: c.A.length, nPit: p.A.length, delistedWithinPit: p.delN, delistedWithinCurrent: c.delN };
    row.biasA = row.currentA - row.pitA; row.biasB = row.currentB - row.pitB;
    out.horizons[hk] = row;
    console.log(`\n[${hk}]`);
    console.log(`  current-list mean fwd (A/B): ${pct(row.currentA)} / ${pct(row.currentB)}   n=${row.nCurrent}  delisted-within ${row.delistedWithinCurrent}`);
    console.log(`  PIT-members  mean fwd (A/B): ${pct(row.pitA)} / ${pct(row.pitB)}   n=${row.nPit}  delisted-within ${row.delistedWithinPit}`);
    console.log(`  INDEX SURVIVORSHIP BIAS (A): ${pct(row.biasA)}   (B, Shumway): ${pct(row.biasB)}   ← current-list minus PIT`);
  }
  fs.writeFileSync(path.join(DATA, 'survivorship-bias-sp500.json'), JSON.stringify(out));
  console.log('\nsaved → research/data/survivorship-bias-sp500.json');
}

(async () => {
  if (process.argv.includes('--sp500-pit')) return sp500PitComparison();
  const sampleN = parseInt(process.argv[2] || '800', 10);
  const survivors = Object.keys(JSON.parse(fs.readFileSync(path.join(DATA, 'symbols.json'), 'utf8')).symbols);
  const survSet = new Set(survivors);
  const allCommon = JSON.parse(fs.readFileSync(path.join(DATA, 'all-symbols.json'), 'utf8')).common;

  // Deterministic sample of non-survivor symbols (the delisted/inactive candidates).
  const cands = allCommon.filter(s => !survSet.has(s));
  let seed = 12345; const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const sample = [...cands].sort(() => rand() - 0.5).slice(0, sampleN);

  console.log(`Survivors: ${survivors.length} (from cache)  |  delisted-candidate sample: ${sample.length} (pulling)…`);

  // Survivors: read from cache only (no FMP). Delisted sample: fetch (cached).
  const survRecs = []; for (const s of survivors) { const f = path.join(pit.CACHE, `${s}.json`); if (fs.existsSync(f)) { try { survRecs.push(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch {} } }
  const delRecs = []; let i = 0; for (const s of sample) { delRecs.push(await pit.fetchSymbol(s)); if (++i % 100 === 0) process.stdout.write(`  pulled ${i}/${sample.length}\n`); }

  const surv = aggregate(survRecs);
  const del = aggregate(delRecs.filter(r => { const ps = pit.priceSeries(r.price); return ps.length && ps[ps.length - 1].ms < ACTIVE_CUTOFF; })); // inactive only
  // Inverse-probability weight: the delisted sample stands in for the whole
  // non-survivor population, so each delisted name-month represents ~cands/sample.
  const delWeight = cands.length / sample.length;

  console.log('\n=== SURVIVORSHIP BIAS ===');
  console.log(`survivors in-band: ${surv.names} names, ${surv.nameMonthsN} name-months`);
  console.log(`delisted in-band:  ${del.names} names, ${del.nameMonthsN} name-months`);
  for (const [hk] of HORIZONS) {
    const s = surv.acc[hk], d = del.acc[hk];
    const sMeanA = mean(s.A), dMeanA = mean(d.A), dMeanB = mean(d.B);
    // Inverse-probability-weighted blend: survivors weight 1, delisted weight delWeight.
    const wSum = (sv, dv) => (sv.reduce((a, b) => a + b, 0) * 1 + dv.reduce((a, b) => a + b, 0) * delWeight);
    const wN = (sv, dv) => sv.length + dv.length * delWeight;
    const ipBlendA = wN(s.A, d.A) ? wSum(s.A, d.A) / wN(s.A, d.A) : null;
    const ipBlendB = wN(s.B, d.B) ? wSum(s.B, d.B) / wN(s.B, d.B) : null;
    const pct = x => x == null ? 'n/a' : (x * 100).toFixed(2) + '%';
    console.log(`\n[${hk}]`);
    console.log(`  survivor mean fwd:        ${pct(sMeanA)}  (median ${pct(median(s.A))})`);
    console.log(`  delisted mean fwd  (A):   ${pct(dMeanA)}   (to last bar)`);
    console.log(`  delisted mean fwd  (B):   ${pct(dMeanB)}   (Shumway −30% on delisting)`);
    console.log(`  delisting danger months:  ${d.delN}/${d.n} (${(100 * d.delN / (d.n || 1)).toFixed(1)}% of delisted name-months delist within ${hk})`);
    console.log(`  IP-weighted delisted share: ${(100 * d.n * delWeight / (s.n + d.n * delWeight)).toFixed(1)}% of universe name-months (weight ×${delWeight.toFixed(0)})`);
    console.log(`  SURVIVORSHIP BIAS (A, IP-weighted): ${pct(sMeanA - ipBlendA)}`);
    console.log(`  SURVIVORSHIP BIAS (B, IP-weighted): ${pct(sMeanA - ipBlendB)}   ← the honest number`);
  }
  fs.writeFileSync(path.join(DATA, 'survivorship-bias.json'), JSON.stringify({ generatedAt: new Date().toISOString(), sampleN, survivors: surv, delisted: del }, null, 0));
  console.log('\nsaved → research/data/survivorship-bias.json');
})();

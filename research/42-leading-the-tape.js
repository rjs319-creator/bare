// LEADING-THE-TAPE validation — does same-day relative strength on a RED market
// day predict TRADEABLE forward excess vs SPY?
//
// The down-day long thesis: on a red tape, names that hold up / trade green while
// SPY falls have institutional support and lead when the tape turns. RS>SPY +
// established-uptrend already showed +4.96%/21d (mover-audit 2026-07-09) — but that
// was a swing horizon. Here we test the SHORT (1-3 session) horizon a day/momentum
// trader actually uses, AND — critically — at the TRADEABLE next-open entry, not the
// un-tradeable close-to-close leg that flattered pcarry/daytrade-continuation.
//
// Method (PIT, keyless Yahoo):
//   • Red day D = SPY same-day return <= RED_THRESH.
//   • On each red day, for every liquid name with data:
//       relToday = nameRet_D - spyRet_D        (same-day relative strength)
//       gates: green today, above 50 & 200 SMA, trailing-21d RS>SPY
//   • Forward EXCESS vs SPY over h={1,2,3} sessions at TWO entries:
//       c2c   = enter close_D           (NOT tradeable at signal time)
//       open  = enter open_{D+1}        (TRADEABLE)
//   • Report gated-candidate excess vs the rest, and a cross-sectional decile
//     sweep by relToday. If `open` excess ~0 while `c2c` is positive → not
//     tradeable (same trap). If `open` excess is positive → real edge → ship.

const fs = require('fs');
const { fetchUniverseSources, mechanicalFilter } = require('../lib/universe-expand');
const { fetchDailyHistory } = require('../lib/screener');

const RED_THRESHES = [-0.5, -1.0];   // % SPY same-day; report both
const HORIZONS = [1, 2, 3];
const PRICE_FLOOR = 5, DVOL_FLOOR = 25e6;

const sma = (cl, p, i) => { if (i + 1 < p) return null; let s = 0; for (let k = i - p + 1; k <= i; k++) s += cl[k]; return s / p; };
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const pct = (a, q) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(q * (s.length - 1))]; };

async function mapLimit(items, limit, fn) {
  const out = []; let i = 0;
  async function w() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); if (idx % 400 === 0) process.stderr.write(`  ..${idx}/${items.length}\n`); } }
  await Promise.all(Array.from({ length: limit }, w));
  return out;
}

(async () => {
  const rows = await fetchUniverseSources();
  const { kept } = mechanicalFilter(rows);
  const syms = kept.map(k => k.symbol);
  process.stderr.write(`universe ${syms.length}; fetching SPY + names (2y)...\n`);

  const spy = await fetchDailyHistory('SPY', '2y');
  const spyC = spy.candles;
  const spyIdx = {}; spyC.forEach((x, i) => { spyIdx[x.date] = i; });
  const spyRet = (i) => i > 0 ? spyC[i].close / spyC[i - 1].close - 1 : null;

  // records: one per (name, red-day) with signal + forward excess at both entries
  const recs = [];
  await mapLimit(syms, 24, async (sym) => {
    let h; try { h = await fetchDailyHistory(sym, '2y'); } catch { return; }
    if (!h || h.candles.length < 220) return;
    const c = h.candles, cl = c.map(x => x.close);
    for (let i = 210; i < c.length - Math.max(...HORIZONS) - 1; i++) {
      const si = spyIdx[c[i].date]; if (si == null || si < 1) continue;
      const sr = spyRet(si); if (sr == null) continue;                 // SPY same-day
      const px = cl[i]; if (px < PRICE_FLOOR) continue;
      let dv = 0; for (let k = i - 19; k <= i; k++) dv += c[k].close * c[k].volume;
      if (dv / 20 < DVOL_FLOOR) continue;
      const nr = cl[i] / cl[i - 1] - 1;                                // name same-day
      const s50 = sma(cl, 50, i), s200 = sma(cl, 200, i);
      if (s50 == null || s200 == null) continue;
      // trailing-21d RS vs SPY
      const sThen = spyC[si - 21]; const rs21 = (sThen && cl[i - 21] > 0)
        ? (cl[i] / cl[i - 21] - 1) - (spyC[si].close / sThen.close - 1) : null;
      // forward excess vs SPY at both entries, per horizon
      const fwd = {};
      let ok = true;
      for (const hh of HORIZONS) {
        const sfi = spyIdx[c[i + hh] && c[i + hh].date];
        const soi = spyIdx[c[i + 1] && c[i + 1].date];
        if (c[i + hh] == null || c[i + 1] == null || sfi == null || soi == null) { ok = false; break; }
        const c2c = (cl[i + hh] / cl[i] - 1) - (spyC[sfi].close / spyC[si].close - 1);
        const opn = (cl[i + hh] / c[i + 1].open - 1) - (spyC[sfi].close / spyC[soi].open - 1);
        fwd[hh] = { c2c: c2c * 100, opn: opn * 100 };
      }
      if (!ok) continue;
      recs.push({
        sym, date: c[i].date, year: c[i].date.slice(0, 4),
        spyRet: sr * 100, nameRet: nr * 100, relToday: (nr - sr) * 100,
        green: nr > 0, above50: px > s50, above200: px > s200,
        rs21: rs21 == null ? null : rs21 * 100, fwd,
      });
    }
  });
  process.stderr.write(`\nrecords: ${recs.length}\n`);

  const summarize = (arr, hh, key) => {
    const v = arr.map(r => r.fwd[hh][key]);
    return { n: v.length, mean: +mean(v).toFixed(3), median: +(pct(v, 0.5) || 0).toFixed(3), win: +(100 * v.filter(x => x > 0).length / v.length).toFixed(1) };
  };

  const out = { generatedAt: new Date().toISOString(), universe: syms.length, records: recs.length, byThresh: {} };

  for (const RT of RED_THRESHES) {
    const red = recs.filter(r => r.spyRet <= RT);
    const cand = red.filter(r => r.green && r.above50 && r.above200 && r.rs21 > 0);   // Leading-the-Tape gate
    const rest = red.filter(r => !(r.green && r.above50 && r.above200 && r.rs21 > 0));
    const block = { redDayRecords: red.length, candidates: cand.length, horizons: {} };
    for (const hh of HORIZONS) {
      block.horizons[hh] = {
        candidate: { c2c: summarize(cand, hh, 'c2c'), open: summarize(cand, hh, 'opn') },
        rest:      { c2c: summarize(rest, hh, 'c2c'), open: summarize(rest, hh, 'opn') },
      };
    }
    // cross-sectional decile by relToday (per red day), forward OPEN excess at h=1
    const byDay = {};
    red.forEach(r => { (byDay[r.date] = byDay[r.date] || []).push(r); });
    const deciles = Array.from({ length: 10 }, () => []);
    Object.values(byDay).forEach(day => {
      if (day.length < 10) return;
      const sorted = [...day].sort((a, b) => a.relToday - b.relToday);
      sorted.forEach((r, idx) => { const d = Math.min(9, Math.floor(idx / sorted.length * 10)); deciles[d].push(r.fwd[1].opn); });
    });
    block.decileOpenExcessH1 = deciles.map(d => ({ n: d.length, mean: +mean(d).toFixed(3) }));
    // by-year robustness for the candidate set, open h=1
    const yrs = {};
    cand.forEach(r => { (yrs[r.year] = yrs[r.year] || []).push(r.fwd[1].opn); });
    block.candidateByYearOpenH1 = Object.fromEntries(Object.entries(yrs).map(([y, v]) => [y, { n: v.length, mean: +mean(v).toFixed(3) }]));
    out.byThresh[RT] = block;
  }

  fs.writeFileSync('research/data/leading-the-tape.json', JSON.stringify(out, null, 2));

  // ---- console report ----
  for (const RT of RED_THRESHES) {
    const b = out.byThresh[RT];
    console.log(`\n================ SPY red-day threshold: ${RT}% ================`);
    console.log(`red-day records: ${b.redDayRecords}  |  Leading-the-Tape candidates: ${b.candidates}`);
    console.log(`\n  horizon | set        | CLOSE→CLOSE (not tradeable) | NEXT-OPEN (tradeable)`);
    console.log(`  --------|------------|-----------------------------|----------------------`);
    for (const hh of HORIZONS) {
      const H = b.horizons[hh];
      const f = (s) => `${s.mean >= 0 ? '+' : ''}${s.mean}% win ${s.win}% (n${s.n})`;
      console.log(`  h=${hh}     | candidate  | ${f(H.candidate.c2c).padEnd(27)} | ${f(H.candidate.open)}`);
      console.log(`  h=${hh}     | rest       | ${f(H.rest.c2c).padEnd(27)} | ${f(H.rest.open)}`);
    }
    console.log(`\n  decile by same-day relStrength → NEXT-OPEN excess h=1 (monotone up = signal):`);
    console.log('   ' + b.decileOpenExcessH1.map((d, i) => `D${i}:${d.mean >= 0 ? '+' : ''}${d.mean}`).join('  '));
    console.log(`  candidate NEXT-OPEN h=1 by year: ` + Object.entries(b.candidateByYearOpenH1).map(([y, v]) => `${y}:${v.mean >= 0 ? '+' : ''}${v.mean}(n${v.n})`).join('  '));
  }
  console.log('\nwrote research/data/leading-the-tape.json');
})();

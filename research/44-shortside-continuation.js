// PHASE 3 — SHORT-SIDE day-trade edge. Does a bearish setup CONTINUE lower (short
// pays) at the TRADEABLE next-open entry, or do beaten-down names BOUNCE (short
// loses)? Two hypotheses, same 2y PIT rig as research/42-43, keyless Yahoo, entry
// at next-day OPEN, forward return as SHORT excess vs SPY = −(nameRet − spyRet)
// (positive = the name underperformed = the short paid).
//
//   H1 GAP-DOWN CONTINUATION — the mirror of the validated Gap & Go long: an
//      unscheduled overnight gap-DOWN (open ≤ −G% vs prior close) on a liquid name.
//      Gap & Go found gap-UPS continue (dose-response, monotone to +5%). Does the
//      DOWN side continue too, or bounce? Dose-response by gap size (3/5/7%).
//   H2 BREAKDOWN — close breaks below the prior 20-day low, on ≥1.5× volume, below
//      the 50-SMA (trend already down). Classic momentum breakdown short.
//
// Prior (research/42): on red days the WEAKEST names bounce most at the next open →
// strong prior that gap-downs mean-revert. This is the honest test of that.

const fs = require('fs');
const { fetchUniverseSources, mechanicalFilter } = require('../lib/universe-expand');
const { fetchDailyHistory } = require('../lib/screener');

const GAPS = [3, 5, 7];        // gap-down thresholds (%)
const HORIZONS = [1, 3, 5];
const PRICE_FLOOR = 5, DVOL_FLOOR = 25e6;

const sma = (cl, p, i) => { if (i + 1 < p) return null; let s = 0; for (let k = i - p + 1; k <= i; k++) s += cl[k]; return s / p; };
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(0.5 * (s.length - 1))]; };

async function mapLimit(items, limit, fn) {
  let i = 0;
  async function w() { while (i < items.length) { const idx = i++; await fn(items[idx]); if (idx % 400 === 0) process.stderr.write(`  ..${idx}/${items.length}\n`); } }
  await Promise.all(Array.from({ length: limit }, w));
}

(async () => {
  const rows = await fetchUniverseSources();
  const { kept } = mechanicalFilter(rows);
  const syms = kept.map(k => k.symbol);
  process.stderr.write(`universe ${syms.length}; SPY + short-signal replay (2y)...\n`);

  const spy = await fetchDailyHistory('SPY', '2y');
  const spyC = spy.candles, spyIdx = {}; spyC.forEach((x, i) => { spyIdx[x.date] = i; });

  // SHORT forward excess vs SPY at next-open entry (positive = short paid).
  function shortFwd(cl, c, i, si) {
    const soi = spyIdx[c[i + 1] && c[i + 1].date]; if (c[i + 1] == null || soi == null) return null;
    const out = {};
    for (const hh of HORIZONS) {
      const sfi = spyIdx[c[i + hh] && c[i + hh].date];
      if (c[i + hh] == null || sfi == null) return null;
      const nameRet = cl[i + hh] / c[i + 1].open - 1;
      const spyRet = spyC[sfi].close / spyC[soi].open - 1;
      out[hh] = -(nameRet - spyRet) * 100;   // SHORT excess
    }
    return out;
  }

  const gapRecs = [], brkRecs = [];
  await mapLimit(syms, 24, async (sym) => {
    let h; try { h = await fetchDailyHistory(sym, '2y'); } catch { return; }
    if (!h || h.candles.length < 120) return;
    const c = h.candles, cl = c.map(x => x.close);
    for (let i = 60; i < c.length - Math.max(...HORIZONS) - 1; i++) {
      const si = spyIdx[c[i].date]; if (si == null || si < 1) continue;
      if (cl[i] < PRICE_FLOOR) continue;
      let dv = 0; for (let k = i - 19; k <= i; k++) dv += c[k].close * c[k].volume;
      if (dv / 20 < DVOL_FLOOR) continue;
      const year = c[i].date.slice(0, 4);
      const spyDown = (spyC[si].close / spyC[si - 1].close - 1) * 100 <= -0.5;

      // H1 gap-down
      const gapPct = c[i - 1].close > 0 ? (c[i].open / c[i - 1].close - 1) * 100 : 0;
      if (gapPct <= -GAPS[0]) {
        const fwd = shortFwd(cl, c, i, si);
        if (fwd) gapRecs.push({ sym, year, gapPct, spyDown, fwd });
      }
      // H2 breakdown: close < prior 20d low, vol >= 1.5x 20d avg, below 50-SMA
      let lo20 = Infinity, vsum = 0; for (let k = i - 20; k < i; k++) { if (c[k].low < lo20) lo20 = c[k].low; vsum += c[k].volume; }
      const vavg = vsum / 20, s50 = sma(cl, 50, i);
      if (s50 != null && cl[i] < lo20 && c[i].volume >= 1.5 * vavg && cl[i] < s50) {
        const fwd = shortFwd(cl, c, i, si);
        if (fwd) brkRecs.push({ sym, year, spyDown, fwd });
      }
    }
  });
  process.stderr.write(`\ngap-down signals: ${gapRecs.length} · breakdown signals: ${brkRecs.length}\n`);

  const summ = (arr, hh) => { const v = arr.map(r => r.fwd[hh]); return { n: v.length, mean: +mean(v).toFixed(3), median: +median(v).toFixed(3), win: v.length ? +(100 * v.filter(x => x > 0).length / v.length).toFixed(1) : 0 }; };
  const line = (lbl, arr) => { const p = HORIZONS.map(hh => { const s = summ(arr, hh); return `h${hh}:${s.mean >= 0 ? '+' : ''}${s.mean}%/w${s.win}`; }); console.log(`  ${lbl.padEnd(28)} n=${String(arr.length).padEnd(6)} ${p.join('  ')}`); };

  console.log('\n=== H1 GAP-DOWN CONTINUATION (SHORT excess vs SPY, +=short paid, next-open entry) ===');
  console.log('  dose-response by gap-down size:');
  for (const g of GAPS) line(`gap ≤ −${g}%`, gapRecs.filter(r => r.gapPct <= -g));
  console.log('  gap ≤ −5% split by tape:');
  line('  on SPY-red days', gapRecs.filter(r => r.gapPct <= -5 && r.spyDown));
  line('  on non-red days', gapRecs.filter(r => r.gapPct <= -5 && !r.spyDown));
  console.log('  gap ≤ −5% by year (h=3):');
  { const yrs = {}; gapRecs.filter(r => r.gapPct <= -5).forEach(r => { (yrs[r.year] = yrs[r.year] || []).push(r.fwd[3]); }); console.log('   ' + Object.entries(yrs).map(([y, v]) => `${y}:${mean(v) >= 0 ? '+' : ''}${mean(v).toFixed(3)}(n${v.length})`).join('  ')); }

  console.log('\n=== H2 BREAKDOWN (20d-low break + 1.5× vol + below 50-SMA; SHORT excess) ===');
  line('breakdown', brkRecs);
  line('  on SPY-red days', brkRecs.filter(r => r.spyDown));
  line('  on non-red days', brkRecs.filter(r => !r.spyDown));
  { const yrs = {}; brkRecs.forEach(r => { (yrs[r.year] = yrs[r.year] || []).push(r.fwd[3]); }); console.log('  by year (h=3): ' + Object.entries(yrs).map(([y, v]) => `${y}:${mean(v) >= 0 ? '+' : ''}${mean(v).toFixed(3)}(n${v.length})`).join('  ')); }

  fs.writeFileSync('research/data/shortside-continuation.json', JSON.stringify({ generatedAt: new Date().toISOString(), universe: syms.length, gapSignals: gapRecs.length, breakdownSignals: brkRecs.length }, null, 2));
  console.log('\nInterpretation: +short excess = continues lower (short edge). −short excess = BOUNCES (reject the short, confirms the reversion prior).');
  console.log('wrote research/data/shortside-continuation.json');
})();

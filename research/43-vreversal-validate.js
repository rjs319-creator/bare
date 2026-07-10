// V-REVERSAL tier validation — does analyzeVReversal earn a Down-Day-Mode tab?
//
// The decile sweep in 42-leading-the-tape showed the DOWN-day tradeable edge is
// REVERSION (hardest-hit names bounce next open). V-Reversal targets a specific
// capitulation→turn geometry. Before surfacing it we confirm its tiers
// (CONFIRMED/EMERGING/WATCH) carry positive TRADEABLE (next-open) forward excess
// vs SPY. We evaluate on RED days (SPY same-day <= thresh) since that's when
// Down-Day Mode surfaces it — and on ALL days as a control.
//
// Entry = next-day OPEN (tradeable). Horizons 1/3/5 sessions, excess vs SPY.

const fs = require('fs');
const { fetchUniverseSources, mechanicalFilter } = require('../lib/universe-expand');
const { fetchDailyHistory } = require('../lib/screener');
const { analyzeVReversal } = require('../lib/vreversal');

const HORIZONS = [1, 3, 5];
const PRICE_FLOOR = 5, DVOL_FLOOR = 25e6;
const RED_THRESH = -0.5;

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
  process.stderr.write(`universe ${syms.length}; SPY + scoring V-reversal per red day...\n`);

  const spy = await fetchDailyHistory('SPY', '2y');
  const spyC = spy.candles, spyIdx = {}; spyC.forEach((x, i) => { spyIdx[x.date] = i; });

  // recs: one per (name, day) where analyzeVReversal fired, with tier + fwd excess
  const recs = [];
  await mapLimit(syms, 24, async (sym) => {
    let h; try { h = await fetchDailyHistory(sym, '2y'); } catch { return; }
    if (!h || h.candles.length < 220) return;
    const c = h.candles, cl = c.map(x => x.close);
    for (let i = 200; i < c.length - Math.max(...HORIZONS) - 1; i++) {
      const si = spyIdx[c[i].date]; if (si == null || si < 1) continue;
      if (cl[i] < PRICE_FLOOR) continue;
      let dv = 0; for (let k = i - 19; k <= i; k++) dv += c[k].close * c[k].volume;
      if (dv / 20 < DVOL_FLOOR) continue;
      const spyRet = (spyC[si].close / spyC[si - 1].close - 1) * 100;
      // only score the pattern where it matters (bound runtime): red days + a light net
      const isRed = spyRet <= RED_THRESH;
      const v = analyzeVReversal(c.slice(0, i + 1));
      if (!v || v.signals.expired) continue;
      // forward next-open excess vs SPY
      const soi = spyIdx[c[i + 1] && c[i + 1].date]; if (c[i + 1] == null || soi == null) continue;
      const fwd = {}; let ok = true;
      for (const hh of HORIZONS) {
        const sfi = spyIdx[c[i + hh] && c[i + hh].date];
        if (c[i + hh] == null || sfi == null) { ok = false; break; }
        fwd[hh] = ((cl[i + hh] / c[i + 1].open - 1) - (spyC[sfi].close / spyC[soi].open - 1)) * 100;
      }
      if (!ok) continue;
      recs.push({ sym, date: c[i].date, year: c[i].date.slice(0, 4), tier: v.tier, score: v.score, isRed, fwd });
    }
  });
  process.stderr.write(`\nfired records: ${recs.length}\n`);

  const summarize = (arr, hh) => {
    const v = arr.map(r => r.fwd[hh]);
    return { n: v.length, mean: +mean(v).toFixed(3), median: +median(v).toFixed(3), win: v.length ? +(100 * v.filter(x => x > 0).length / v.length).toFixed(1) : 0 };
  };
  const report = (label, arr) => {
    console.log(`\n--- ${label} (n=${arr.length}) ---`);
    for (const tier of ['CONFIRMED', 'EMERGING', 'WATCH', 'ALL']) {
      const set = tier === 'ALL' ? arr : arr.filter(r => r.tier === tier);
      if (!set.length) { console.log(`  ${tier.padEnd(10)} n=0`); continue; }
      const parts = HORIZONS.map(hh => { const s = summarize(set, hh); return `h${hh}:${s.mean >= 0 ? '+' : ''}${s.mean}%/w${s.win}`; });
      console.log(`  ${tier.padEnd(10)} n=${String(set.length).padEnd(6)} ${parts.join('  ')}`);
    }
  };

  const red = recs.filter(r => r.isRed);
  report('RED days (SPY<=-0.5%) — where Down-Day Mode surfaces it', red);
  report('ALL days (control)', recs);

  // by-year for CONFIRMED+EMERGING on red days, h=3
  const ce = red.filter(r => r.tier === 'CONFIRMED' || r.tier === 'EMERGING');
  const yrs = {}; ce.forEach(r => { (yrs[r.year] = yrs[r.year] || []).push(r.fwd[3]); });
  console.log('\nCONFIRMED+EMERGING red-day h=3 by year: ' + Object.entries(yrs).map(([y, v]) => `${y}:${mean(v) >= 0 ? '+' : ''}${mean(v).toFixed(3)}(n${v.length})`).join('  '));

  fs.writeFileSync('research/data/vreversal-validate.json', JSON.stringify({ generatedAt: new Date().toISOString(), universe: syms.length, fired: recs.length, redThresh: RED_THRESH }, null, 2));
  console.log('\nwrote research/data/vreversal-validate.json');
})();

// PHASE 3 rigor — does the H1 gap-down-continuation SHORT edge survive the tests that
// broke Gap & Go's "liquid-only half"? For gap ≤ −5% (the validated tier), at the
// tradeable next-open entry, h=3 SHORT excess vs SPY:
//   (a) LIQUIDITY TILT — split by 20d $-vol tier. Gap & Go's edge concentrated in
//       speculative names; does the SHORT survive in liquid names you can actually
//       borrow/fill?
//   (b) SLIPPAGE + BORROW — shorts pay spread both legs + borrow. Subtract a
//       round-trip cost (0.4% / 0.8%) and see if the edge holds.
//   (c) LUMPINESS — median, winsorized mean, and the top-5 trades' share of total
//       P&L (Gap & Go's long was carried by a few runners).

const fs = require('fs');
const { fetchUniverseSources, mechanicalFilter } = require('../lib/universe-expand');
const { fetchDailyHistory } = require('../lib/screener');

const GAP = 5, H = 3, PRICE_FLOOR = 5, DVOL_FLOOR = 25e6;
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(0.5 * (s.length - 1))]; };
const winsor = (a, p = 0.05) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const lo = s[Math.floor(p * (s.length - 1))], hi = s[Math.floor((1 - p) * (s.length - 1))]; return mean(s.map(x => Math.max(lo, Math.min(hi, x)))); };

async function mapLimit(items, limit, fn) { let i = 0; async function w() { while (i < items.length) { const idx = i++; await fn(items[idx]); if (idx % 400 === 0) process.stderr.write(`  ..${idx}/${items.length}\n`); } } await Promise.all(Array.from({ length: limit }, w)); }

(async () => {
  const { kept } = mechanicalFilter(await fetchUniverseSources());
  const syms = kept.map(k => k.symbol);
  process.stderr.write(`universe ${syms.length}; gap-down rigor (2y)...\n`);
  const spy = await fetchDailyHistory('SPY', '2y');
  const spyC = spy.candles, spyIdx = {}; spyC.forEach((x, i) => { spyIdx[x.date] = i; });

  const recs = [];
  await mapLimit(syms, 24, async (sym) => {
    let h; try { h = await fetchDailyHistory(sym, '2y'); } catch { return; }
    if (!h || h.candles.length < 120) return;
    const c = h.candles, cl = c.map(x => x.close);
    for (let i = 60; i < c.length - H - 1; i++) {
      const si = spyIdx[c[i].date]; if (si == null) continue;
      if (cl[i] < PRICE_FLOOR) continue;
      let dv = 0; for (let k = i - 19; k <= i; k++) dv += c[k].close * c[k].volume; dv /= 20;
      if (dv < DVOL_FLOOR) continue;
      const gapPct = c[i - 1].close > 0 ? (c[i].open / c[i - 1].close - 1) * 100 : 0;
      if (gapPct > -GAP) continue;
      const soi = spyIdx[c[i + 1] && c[i + 1].date], sfi = spyIdx[c[i + H] && c[i + H].date];
      if (c[i + 1] == null || c[i + H] == null || soi == null || sfi == null) continue;
      const shortExc = -((cl[i + H] / c[i + 1].open - 1) - (spyC[sfi].close / spyC[soi].open - 1)) * 100;
      recs.push({ dv, shortExc });
    }
  });
  const all = recs.map(r => r.shortExc);
  process.stderr.write(`\ngap≤−${GAP}% signals: ${recs.length}\n`);

  console.log(`\n=== gap ≤ −${GAP}% · h=${H} · SHORT excess vs SPY (next-open entry) · n=${recs.length} ===`);
  console.log('\n(a) LIQUIDITY TILT — by 20d $-vol tier:');
  const tiers = [['$25–50M', 25e6, 50e6], ['$50–150M', 50e6, 150e6], ['$150M+', 150e6, Infinity]];
  for (const [lbl, lo, hi] of tiers) { const v = recs.filter(r => r.dv >= lo && r.dv < hi).map(r => r.shortExc); console.log(`  ${lbl.padEnd(9)} n=${String(v.length).padEnd(6)} mean ${mean(v) >= 0 ? '+' : ''}${mean(v).toFixed(3)}%  win ${v.length ? (100 * v.filter(x => x > 0).length / v.length).toFixed(1) : 0}%`); }

  console.log('\n(b) SLIPPAGE + BORROW (round-trip cost subtracted from short excess):');
  for (const cost of [0, 0.4, 0.8]) { const v = all.map(x => x - cost); console.log(`  cost ${cost}% → net mean ${mean(v) >= 0 ? '+' : ''}${mean(v).toFixed(3)}%  win ${(100 * v.filter(x => x > 0).length / v.length).toFixed(1)}%`); }

  console.log('\n(c) LUMPINESS:');
  const sorted = [...all].sort((a, b) => b - a);
  const total = all.reduce((s, x) => s + x, 0);
  const top5 = sorted.slice(0, 5).reduce((s, x) => s + x, 0);
  console.log(`  raw mean ${mean(all).toFixed(3)}%  ·  median ${median(all).toFixed(3)}%  ·  winsorized-5% mean ${winsor(all).toFixed(3)}%`);
  console.log(`  top-5 trades = ${total ? (100 * top5 / total).toFixed(1) : 0}% of total P&L (n=${all.length})`);

  fs.writeFileSync('research/data/gapdown-rigor.json', JSON.stringify({ generatedAt: new Date().toISOString(), n: recs.length }, null, 2));
  console.log('\nwrote research/data/gapdown-rigor.json');
})();

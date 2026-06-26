'use strict';
// Rank-movement harness — proves the live re-ranking logic works by running the ACTUAL
// app engine (lib/stablecore.js buildBook) against two real point-in-time cross-sections
// from the research panel, then diffing the ranks. No waiting for tomorrow's tape.
//   node research/22-rank-harness.js [T1 T2]      (defaults 2026-02 vs 2026-05)
//
// It feeds the same sector-neutral 12-1 + vol-filter + rank-buffer engine the prod book uses,
// with T1's book as the "held" set for T2, so rankChange / status (new/held/watch) are exactly
// what the live tab would compute when the as-of date advances.

const fs = require('fs');
const path = require('path');
const core = require('../lib/stablecore');   // the SAME engine prod uses

const T1 = process.argv[2] || '2026-02';
const T2 = process.argv[3] || '2026-05';
const DATA = path.join(__dirname, 'data');

// map a research-panel row → the feature shape buildBook expects
const toFeat = r => ({ symbol: r.s, sector: r.sec, marketCap: r.cap, m121: r.m121, vol63: r.v63, adv20: r.adv, price: 10 });

(async () => {
  const P = JSON.parse(fs.readFileSync(path.join(DATA, 'panel-features.json'), 'utf8'));
  const rowsAt = ym => (P.panel[ym] || []).map(toFeat);
  if (!P.panel[T1] || !P.panel[T2]) { console.error(`missing month(s): ${T1} / ${T2}. available ${P.months[0]}..${P.months.at(-1)}`); process.exit(1); }

  // T1 book (fresh), then T2 book using T1's names as the held set (rank-buffer transition)
  const b1 = core.buildBook(rowsAt(T1), new Set());
  const held = new Set(b1.book.map(x => x.ticker));
  const b2 = core.buildBook(rowsAt(T2), held);

  const rank1 = new Map(b1.book.map(x => [x.ticker, x.rank]));
  // annotate T2 with rankChange vs T1 (mirrors the prod route)
  b2.book.forEach(x => { const p = rank1.get(x.ticker); x.prevRank = p || null; x.rankChange = p ? p - x.rank : null; });

  const held2 = b2.book.filter(x => x.status === 'held').length;
  const watch2 = b2.book.filter(x => x.status === 'watch').length;
  const newl = b2.book.filter(x => x.status === 'new').length;
  const dropped = b1.book.filter(x => !b2.book.find(y => y.ticker === x.ticker));
  const moved = b2.book.filter(x => x.rankChange != null && x.rankChange !== 0).length;
  const inBoth = b2.book.filter(x => x.prevRank != null);
  const avgAbsMove = inBoth.length ? inBoth.reduce((s, x) => s + Math.abs(x.rankChange), 0) / inBoth.length : 0;

  console.log(`=== RANK-MOVEMENT HARNESS  ${T1} → ${T2}  (live engine, real PIT data) ===\n`);
  console.log(`book size: ${b1.book.length} (${T1}) → ${b2.book.length} (${T2})`);
  console.log(`carried over (in both): ${inBoth.length}   new: ${newl}   dropped: ${dropped.length}`);
  console.log(`status @ ${T2}: ● held ${held2} · ⚠️ watch ${watch2} · 🟢 new ${newl}`);
  console.log(`ranks that MOVED among carry-overs: ${moved}/${inBoth.length}   avg |rank move|: ${avgAbsMove.toFixed(1)} places\n`);

  const fmt = x => `${(x.prevRank + '→' + x.rank).padStart(9)}  ${(x.rankChange > 0 ? '▲' + x.rankChange : '▼' + (-x.rankChange)).padStart(4)}  ${x.ticker.padEnd(6)} ${x.sector.slice(0, 14)}`;
  const up = [...inBoth].filter(x => x.rankChange > 0).sort((a, b) => b.rankChange - a.rankChange).slice(0, 8);
  const dn = [...inBoth].filter(x => x.rankChange < 0).sort((a, b) => a.rankChange - b.rankChange).slice(0, 8);
  console.log('biggest RISERS:'); up.forEach(x => console.log('  ' + fmt(x)));
  console.log('\nbiggest FALLERS:'); dn.forEach(x => console.log('  ' + fmt(x)));
  console.log(`\nNEW entries @ ${T2} (top 8 by rank): ${b2.book.filter(x => x.status === 'new').slice(0, 8).map(x => `#${x.rank} ${x.ticker}`).join('  ')}`);
  console.log(`DROPPED since ${T1} (top 8 by old rank): ${dropped.slice(0, 8).map(x => `#${x.rank} ${x.ticker}`).join('  ')}`);

  // sanity assertions
  const okMove = moved > 0, okBuffer = watch2 >= 0 && held2 > 0, okNew = newl > 0;
  console.log(`\nVALIDATION: ranks re-ranked ${okMove ? '✅' : '❌'} · held/buffer working ${okBuffer ? '✅' : '❌'} · new entries appear ${okNew ? '✅' : '❌'}`);
})();

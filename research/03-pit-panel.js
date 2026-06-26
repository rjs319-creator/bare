'use strict';
// Phase-0 step 03 — POINT-IN-TIME monthly panel. Run:
//   node --env-file=research/.env research/03-pit-panel.js [sliceSize|all]   (default 200)
//
// For each month-end in the window and each symbol: PIT market cap = close ×
// weightedAverageShsOut (most recent quarter FILED ≤ date), liquidity = trailing
// 20-day avg $-volume. Membership = $300M–$10B cap AND ≥$3M/day. Per-symbol pulls
// are cached to research/data/cache/ so the full run reuses the slice's fetches.

const fs = require('fs');
const path = require('path');
const fmp = require('./lib/fmp');

const DATA = path.join(__dirname, 'data');
const CACHE = path.join(DATA, 'cache');
const DAY = 86400000, LAG = 45 * DAY;             // report-availability lag for statements
const CAP_LO = 300e6, CAP_HI = 10e9, ADV_FLOOR = 3e6;
const CONCURRENCY = 1;                            // stay under FMP Starter ~5 req/s (220ms throttle ≈ 4.5/s)

// ── per-symbol fetch (cached) ────────────────────────────────────────────────
async function fetchSymbol(sym) {
  const f = path.join(CACHE, `${sym}.json`);
  if (fs.existsSync(f)) {
    try { const c = JSON.parse(fs.readFileSync(f, 'utf8')); if (c.price?.length || c.income?.length) return c; } catch { /* refetch */ }
  }
  const out = { sym, price: null, income: null, fetchedAt: new Date().toISOString() };
  try { out.price = await fmp.priceHistory(sym); } catch (e) { out.error = `price:${String(e?.message || e).slice(0, 60)}`; }
  try { out.income = await fmp.incomeQuarterly(sym, 60); } catch (e) { out.error = (out.error || '') + ` inc:${String(e?.message || e).slice(0, 60)}`; }
  // Only cache real data — never persist a total failure (so it retries next run).
  if (out.price?.length || out.income?.length) { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(f, JSON.stringify(out)); }
  return out;
}

async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ── PIT helpers ──────────────────────────────────────────────────────────────
// Statement effective date = filing/accepted date if present, else period end + lag.
function sharesSeries(income) {
  return (income || [])
    .map(r => ({ eff: Date.parse(r.filingDate || r.acceptedDate || r.date) + (r.filingDate || r.acceptedDate ? 0 : LAG),
                 shares: r.weightedAverageShsOut ?? r.weightedAverageShsOutDil ?? null }))
    .filter(r => Number.isFinite(r.eff) && r.shares > 0)
    .sort((a, b) => a.eff - b.eff);
}
function asOfShares(series, dateMs) { let s = null; for (const r of series) { if (r.eff <= dateMs) s = r.shares; else break; } return s; }

// Ascending [{ms,close,dollar}] from FMP price rows (newest-first).
function priceSeries(price) {
  return (price || []).map(r => ({ ms: Date.parse(r.date), close: r.close, dollar: (r.close || 0) * (r.volume || 0) }))
    .filter(r => Number.isFinite(r.ms) && r.close > 0).sort((a, b) => a.ms - b.ms);
}
function asOfPriceAdv(series, dateMs) {
  let idx = -1; for (let k = 0; k < series.length; k++) { if (series[k].ms <= dateMs) idx = k; else break; }
  if (idx < 0) return null;
  let sum = 0, c = 0; for (let k = Math.max(0, idx - 19); k <= idx; k++) { sum += series[k].dollar; c++; }
  return { close: series[idx].close, adv: c ? sum / c : 0, stale: (dateMs - series[idx].ms) > 10 * DAY };
}

// Month-end calendar grid (last day of each month) over the window.
function monthEnds(fromYM, toYM) {
  const out = []; let [y, m] = fromYM.split('-').map(Number);
  const [ty, tm] = toYM.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(Date.UTC(y, m, 0)); if (++m > 12) { m = 1; y++; } }
  return out;
}

(async () => {
  const arg = process.argv[2] || '200';
  const all = JSON.parse(fs.readFileSync(path.join(DATA, 'symbols.json'), 'utf8')).symbols;
  let syms = Object.keys(all).sort();
  if (arg !== 'all') syms = syms.slice(0, parseInt(arg, 10) || 200);
  console.log(`Fetching ${syms.length} symbols (concurrency ${CONCURRENCY}, cached)…`);

  const t0 = Date.now();
  let done = 0;
  const fetched = await mapLimit(syms, CONCURRENCY, async (s) => { const r = await fetchSymbol(s); if (++done % 50 === 0) process.stdout.write(`  ${done}/${syms.length}\n`); return r; });
  console.log(`fetched in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  const grid = monthEnds('2021-07', '2026-06');
  const panel = [];                                // {date, sym, cap, adv}
  let withData = 0, withShares = 0;
  const everMember = new Set();
  for (const r of fetched) {
    const ps = priceSeries(r.price), ss = sharesSeries(r.income);
    if (ps.length) withData++; if (ss.length) withShares++;
    if (!ps.length || !ss.length) continue;
    for (const d of grid) {
      const pa = asOfPriceAdv(ps, d); const sh = asOfShares(ss, d);
      if (!pa || pa.stale || !sh) continue;
      const cap = pa.close * sh;
      const member = cap >= CAP_LO && cap <= CAP_HI && pa.adv >= ADV_FLOOR;
      if (member) { panel.push({ date: new Date(d).toISOString().slice(0, 10), sym: r.sym, cap: Math.round(cap), adv: Math.round(pa.adv) }); everMember.add(r.sym); }
    }
  }

  // per-month membership counts
  const byMonth = {}; for (const row of panel) byMonth[row.date.slice(0, 7)] = (byMonth[row.date.slice(0, 7)] || 0) + 1;
  const months = Object.keys(byMonth).sort();
  fs.writeFileSync(path.join(DATA, `panel-${arg}.json`), JSON.stringify({ generatedAt: new Date().toISOString(), params: { CAP_LO, CAP_HI, ADV_FLOOR }, rows: panel.length, byMonth, panel: arg === 'all' ? undefined : panel }, null, 0));

  console.log('\n=== PIT panel validation ===');
  console.log(`  symbols fetched:        ${fetched.length}`);
  console.log(`  with price data:        ${withData}`);
  console.log(`  with shares (income):   ${withShares}`);
  console.log(`  distinct names ever in-band: ${everMember.size}`);
  console.log(`  panel rows (name-months in band): ${panel.length}`);
  if (months.length) {
    console.log(`  membership first month ${months[0]}=${byMonth[months[0]]}  …  last ${months.at(-1)}=${byMonth[months.at(-1)]}`);
    const vals = Object.values(byMonth); console.log(`  members/month: min ${Math.min(...vals)} / max ${Math.max(...vals)} / avg ${Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)}`);
  }
  // sanity: show a few sample in-band names + their latest cap
  const sample = [...everMember].slice(0, 8).map(s => { const last = panel.filter(p => p.sym === s).at(-1); return `${s} $${(last.cap / 1e9).toFixed(2)}B`; });
  console.log(`  sample in-band names: ${sample.join(', ')}`);
  console.log(`saved → research/data/panel-${arg}.json`);
})();

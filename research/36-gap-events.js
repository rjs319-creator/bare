'use strict';
// Step 36 — Gap-and-Go event backtest on the SURVIVORSHIP-CORRECTED rig (OHLC +
// earnings + delisted names). Committed port of the 2026-07-01 scratchpad
// `gap-backtest.js` that produced the 19,326-event set behind the shipped
// continuationScore / Kelly sizing (research/GAP-METALABEL-2026-07.md). Reproduces
// the exp08 event/trade on daily bars (= what the live app can see), prints tier
// stats, and writes the per-event set to research/data/gap-events.json — the input
// to steps 37 (interaction model vs shipped heuristic) and 38 (gap-cause join).
//   node --env-file=research/.env research/36-gap-events.js
const fs = require('fs');
const path = require('path');
const APP = path.resolve(__dirname, '..');
const pit = require('./lib/pit');
const { buildMacroLookup } = require(APP + '/lib/macro');
const DATA = path.join(__dirname, 'data');

const GAP_MIN = 3.0, GAP_STRONG = 5.0, ADV_FLOOR = 10e6, ATR_MULT = 2.5, RR = 2, HOLD = 3;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

const series = price => (price || []).map(r => ({ ms: Date.parse(r.date), d: r.date, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume })).filter(r => r.c > 0 && r.o > 0).sort((a, b) => a.ms - b.ms);
function atrAt(s, i, p = 14) { if (i < p) return null; let sum = 0; for (let k = i - p + 1; k <= i; k++) { const tr = Math.max(s[k].h - s[k].l, Math.abs(s[k].h - s[k - 1].c), Math.abs(s[k].l - s[k - 1].c)); sum += tr; } return sum / p; }
function sma(s, i, p) { if (i < p - 1) return null; let sum = 0; for (let k = i - p + 1; k <= i; k++) sum += s[k].c; return sum / p; }

// ORB trade from gap day index i. Returns realized R-multiple or null (never triggered).
function orbTrade(s, i, atr) {
  const trigger = s[i].h, risk = ATR_MULT * atr;
  if (!(risk > 0)) return null;
  const stop = trigger - risk, target = trigger + RR * risk;
  let entered = false;
  for (let k = 1; k <= HOLD && i + k < s.length; k++) {
    const b = s[i + k];
    if (!entered) { if (b.h >= trigger) { entered = true; /* entry this bar; check rest of bar */ if (b.l <= stop) return -1; if (b.h >= target) return RR; } continue; }
    if (b.l <= stop) return -1;            // conservative: stop first if both
    if (b.h >= target) return RR;
  }
  if (!entered) return null;
  // time exit at last held bar close
  const j = Math.min(i + HOLD, s.length - 1);
  return (s[j].c - trigger) / risk;
}

(async () => {
  const macro = await buildMacroLookup('5y').catch(() => null);
  const symbols = Object.keys(JSON.parse(fs.readFileSync(path.join(DATA, 'symbols.json'), 'utf8')).symbols);
  const events = [];
  let scanned = 0;
  for (const sym of symbols) {
    const f = path.join(pit.CACHE, `${sym}.json`); if (!fs.existsSync(f)) continue;
    let c; try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const s = series(c.price); if (s.length < 80) continue;
    // earnings date set (±1 calendar day guard)
    let earn = new Set();
    const ef = path.join(DATA, 'earnings', `${sym}.json`);
    if (fs.existsSync(ef)) { try { JSON.parse(fs.readFileSync(ef, 'utf8')).forEach(e => { if (e.date) earn.add(e.date); }); } catch {} }
    const nearEarn = dstr => { const t = Date.parse(dstr); for (let dd = -2; dd <= 2; dd++) { const q = new Date(t + dd * 864e5).toISOString().slice(0, 10); if (earn.has(q)) return true; } return false; };
    for (let i = 60; i < s.length - 1; i++) {
      scanned++;
      const gap = (s[i].o - s[i - 1].c) / s[i - 1].c * 100;
      if (gap < GAP_MIN) continue;
      let advSum = 0; for (let k = i - 19; k <= i; k++) advSum += s[k].c * s[k].v; const adv = advSum / 20;
      if (adv < ADV_FLOOR) continue;
      if (nearEarn(s[i].d)) continue;                       // skip earnings gaps
      const atr = atrAt(s, i); if (!atr) continue;
      const R = orbTrade(s, i, atr); if (R == null) continue; // never triggered
      const sma50 = sma(s, i - 1, 50);
      const ext = sma50 ? (s[i - 1].c / sma50 - 1) * 100 : null;
      const relVol = s[i].v / (advSum / 20 / s[i].c);        // vol vs 20d avg share vol
      const avg20vol = (() => { let v = 0; for (let k = i - 19; k <= i; k++) v += s[k].v; return v / 20; })();
      const rv = s[i].v / avg20vol;
      const mac = macro ? macro.at(s[i].d) : null;
      const reg = mac ? (mac.riskOff ? 'off' : mac.riskOn ? 'on' : 'neu') : 'neu';
      events.push({ sym, date: s[i].d, year: s[i].d.slice(0, 4), gap, R, win: R > 0, ext, rv, atrPct: atr / s[i].c * 100, reg });
    }
  }
  console.log(`Scanned ${scanned} name-days → ${events.length} gap-and-go events (>=${GAP_MIN}% gap, liquid, non-earnings, ORB-triggered).\n`);
  global.__events = events;

  // ── #2 TIER STATS (for Kelly) ─────────────────────────────────────────────
  const stat = evs => { const n = evs.length; if (!n) return { n: 0 }; const W = evs.filter(e => e.win).length / n; const wins = evs.filter(e => e.R > 0).map(e => e.R), losses = evs.filter(e => e.R <= 0).map(e => e.R); const aw = mean(wins) || 0, al = Math.abs(mean(losses) || 0); const gW = wins.reduce((a, b) => a + b, 0), gL = Math.abs(losses.reduce((a, b) => a + b, 0)); const exp = mean(evs.map(e => e.R)); const b = al > 0 ? aw / al : 0; const kelly = b > 0 ? W - (1 - W) / b : 0; return { n, W: +W.toFixed(3), avgWinR: +aw.toFixed(2), avgLossR: +al.toFixed(2), payoff: +b.toFixed(2), PF: gL > 0 ? +(gW / gL).toFixed(2) : 99, expR: +exp.toFixed(3), kelly: +kelly.toFixed(3) }; };
  const tiers = { 'ALL >=3%': events, 'MODERATE 3-5%': events.filter(e => e.gap < GAP_STRONG), 'STRONG >=5%': events.filter(e => e.gap >= GAP_STRONG) };
  console.log('=== #2 TIER STATS (Kelly f* = W - (1-W)/payoff; use FRACTIONAL 0.25x) ===');
  console.log('tier'.padEnd(16), 'n'.padStart(5), 'W'.padStart(6), 'avgWinR'.padStart(8), 'avgLossR'.padStart(9), 'payoff'.padStart(7), 'PF'.padStart(5), 'expR'.padStart(6), 'fullKelly'.padStart(10));
  for (const [k, evs] of Object.entries(tiers)) { const t = stat(evs); if (!t.n) continue; console.log(k.padEnd(16), String(t.n).padStart(5), String(t.W).padStart(6), String(t.avgWinR).padStart(8), String(t.avgLossR).padStart(9), String(t.payoff).padStart(7), String(t.PF).padStart(5), String(t.expR).padStart(6), String(t.kelly).padStart(10)); }
  // by year (STRONG tier — robustness)
  console.log('\nSTRONG >=5% by year:');
  [...new Set(events.map(e => e.year))].sort().forEach(y => { const t = stat(events.filter(e => e.gap >= GAP_STRONG && e.year === y)); if (t.n) console.log(`  ${y}: n=${t.n} W=${t.W} expR=${t.expR} PF=${t.PF}`); });
  fs.writeFileSync(path.join(DATA, 'gap-events.json'), JSON.stringify(events));
  console.log(`\nsaved ${events.length} events → research/data/gap-events.json`);
})().catch(e => { console.error('ERR', e.message, e.stack); process.exit(1); });

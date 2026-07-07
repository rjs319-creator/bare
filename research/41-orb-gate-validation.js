'use strict';
// Step 41 — Opening-Range-gate vs naive prior-day-high trigger, on real 5-min bars.
//   node research/41-orb-gate-validation.js
// (no --env-file needed: reads only the local intra5 + daily caches, no network.)
//
// THE LIVE LEAK UNDER TEST (lib/timing.js). triggerScore(price, trigger) returns the
// GREEN "fresh break — prime" light as soon as price >= trigger*0.99, and for Day-Trade
// picks `trigger` = lib/daytrade orbLevels() = the PRIOR SESSION'S HIGH. So on a gap-up
// open above the prior-day high the timing light flashes green at 09:30 ≈ green-lighting
// BUYING THE GAP AT THE OPEN. The project's intraday research says buying the open/gap is
// the LEAK; the OOS-positive fix is to wait ~30 min for the OPENING RANGE, then enter only
// on a break of the OPENING-RANGE HIGH (frequently ABOVE the prior-day high).
//
// HYPOTHESIS (H): an opening-range-gated entry beats the naive prior-day-high trigger on
// realized single-day intraday outcome (per-trade R / PF) AND on fade avoidance (MAE).
//
// PRE-REGISTERED DESIGN (written before looking at outcomes):
// One intra5 file = one (name, gap-day) event: regular-session 5-min bars. Prior-day HIGH
// (the live trigger) + ATR(14) come from the daily cache as-of the PRIOR bar — exactly what
// orbLevels() saw when the pick fired EOD the day before. Risk unit = 2.5xATR(daily prior)
// = the shipped ORB stop distance; stop = entry - risk, target = entry + 2xrisk (1:2). All
// realized on the day's remaining 5-min bars (stop-first-if-both; else exit at last bar).
//
// ENTRY RULES:
//  • Rule A_open  (coordinator's literal "gap chase") — enter at the OPEN (bar-1 open),
//    every event. Models "buy the open on the green light."
//  • Rule A_trig  (FAITHFUL to the live triggerScore) — enter at the first 5-min bar whose
//    price reaches the prior-day-high trigger (entry = open if it gaps above, else the
//    trigger level intraday). If price never reaches the trigger → NO TRADE (light never
//    greens). This is the CURRENT live behavior the change would replace.
//  • Rule B  (OR gate = the proposed fix) — OR = bars 1..6 (~first 30 min); ORhigh = max
//    high of bars 1..6. Effective trigger = max(prior-day-high, ORhigh). Enter the first
//    bar k>=7 whose high >= effTrig (fill at effTrig). If it never breaks → NO TRADE.
//
// METRICS per entry: realized R, entry->close %, MAE in R (=(entry-minLowFromEntry)/risk),
// stop-out rate. Reported (1) on the subset where Rule B triggers (head-to-head), and
// (2) across ALL events with no-trade = 0R / no exposure (the "trade-only-on-OR-break,
// skip the rest" aggregate). Split fader vs runner (day closed below/above its open).
//
// PASS BAR (pre-registered): SHIP the timing change ONLY if Rule B beats the CURRENT live
// rule (A_trig) on realized R AND profit factor AND on lower MAE (fade avoidance), with
// adequate n. "Fewer trades / same per-trade" still PASSES iff it avoids losers (higher PF
// / lower MAE). Otherwise NO-SHIP.
// SINGLE-WINDOW CAVEAT: intra5 is ~2024-2025 only — this validates the MECHANISM, not
// multi-regime robustness.

const fs = require('fs');
const path = require('path');
const INTRA = path.join(__dirname, 'data', 'intra5');
const CACHE = path.join(__dirname, 'data', 'cache');
const OUT = path.join(__dirname, 'data', 'orb-gate-validation.json');
const OR_BARS = 6;            // ~30 min opening range
const ATR_MULT = 2.5, RR = 2; // shipped ORB stop / target
const GREEN_TOL = 0.99;       // triggerScore greens at price >= trigger*0.99

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const round = (x, d = 3) => x == null ? null : +x.toFixed(d);

function atr14(s, i) { // ATR(14) ending at daily index i
  if (i < 14) return null;
  let sum = 0;
  for (let k = i - 13; k <= i; k++) { const tr = Math.max(s[k].h - s[k].l, Math.abs(s[k].h - s[k - 1].c), Math.abs(s[k].l - s[k - 1].c)); sum += tr; }
  return sum / 14;
}

// Walk 5-min bars from `startBar` (inclusive) given entry/stop/target/risk. Returns realized
// R, entry->close %, MAE in R, stop-out flag. Conservative: stop before target if both hit.
function realize(bars, startBar, entry, risk) {
  const stop = entry - risk, target = entry + RR * risk;
  let minLow = entry, R = null, stopOut = false;
  for (let k = startBar; k < bars.length; k++) {
    const b = bars[k];
    if (b.low < minLow) minLow = b.low;
    if (R == null) {
      if (b.low <= stop) { R = -1; stopOut = true; break; }
      if (b.high >= target) { R = RR; break; }
    }
  }
  const lastClose = bars[bars.length - 1].close;
  if (R == null) R = (lastClose - entry) / risk;   // time exit at day's last bar
  return { R, entryClosePct: (lastClose - entry) / entry * 100, maeR: (entry - minLow) / risk, stopOut };
}

function build() {
  const files = fs.readdirSync(INTRA).filter(f => f.endsWith('.json'));
  const events = [];
  let skipped = 0;
  for (const f of files) {
    const m = f.match(/^(.+)_(\d{4}-\d{2}-\d{2})\.json$/); if (!m) { skipped++; continue; }
    const sym = m[1], date = m[2];
    const cf = path.join(CACHE, sym + '.json'); if (!fs.existsSync(cf)) { skipped++; continue; }
    let c; try { c = JSON.parse(fs.readFileSync(cf, 'utf8')); } catch { skipped++; continue; }
    const s = (c.price || []).filter(r => r.close > 0 && r.open > 0)
      .map(r => ({ d: r.date, o: r.open, h: r.high, l: r.low, c: r.close })).sort((a, b) => (a.d < b.d ? -1 : 1));
    const idx = s.findIndex(r => r.d === date); if (idx < 15) { skipped++; continue; }
    const bars = JSON.parse(fs.readFileSync(path.join(INTRA, f), 'utf8'));
    if (!Array.isArray(bars) || bars.length < OR_BARS + 3) { skipped++; continue; }

    const trigger = s[idx - 1].h;                 // prior-day HIGH = the live pick trigger
    const atr = atr14(s, idx - 1);                // ATR as-of the prior daily bar
    if (!(atr > 0) || !(trigger > 0)) { skipped++; continue; }
    const risk = ATR_MULT * atr;
    const prevClose = s[idx - 1].c;
    const open = bars[0].open, dayLast = bars[bars.length - 1].close;
    const dayHigh = Math.max(...bars.map(b => b.high)), dayLow = Math.min(...bars.map(b => b.low));
    const gapPct = (open - prevClose) / prevClose * 100;
    const runner = dayLast >= open;               // day closed at/above its open

    // OR (bars 1..OR_BARS) → ORhigh; effective trigger = max(prior-day high, ORhigh)
    const orHigh = Math.max(...bars.slice(0, OR_BARS).map(b => b.high));
    const effTrig = Math.max(trigger, orHigh);

    // Rule A_open — enter at bar-1 open, always
    const A_open = realize(bars, 0, open, risk);

    // Rule A_trig — first bar reaching the prior-day-high trigger (live green light)
    let aTrigEntry = null, aTrigBar = null;
    if (open >= trigger * GREEN_TOL) { aTrigEntry = open; aTrigBar = 0; }
    else { for (let k = 0; k < bars.length; k++) { if (bars[k].high >= trigger) { aTrigEntry = trigger; aTrigBar = k; break; } } }
    const A_trig = aTrigEntry != null ? realize(bars, aTrigBar, aTrigEntry, risk) : null;

    // Rule B — first bar k>=OR_BARS breaking effTrig (fill at effTrig)
    let bEntry = null, bBar = null;
    for (let k = OR_BARS; k < bars.length; k++) { if (bars[k].high >= effTrig) { bEntry = effTrig; bBar = k; break; } }
    const B = bEntry != null ? realize(bars, bBar, bEntry, risk) : null;

    events.push({
      sym, date, year: date.slice(0, 4), gapPct: round(gapPct, 2), runner,
      trigger: round(trigger, 2), orHigh: round(orHigh, 2), effTrig: round(effTrig, 2),
      atr: round(atr, 3), openAboveTrig: open >= trigger * GREEN_TOL,
      A_open: { R: round(A_open.R), entryClosePct: round(A_open.entryClosePct, 2), maeR: round(A_open.maeR), stopOut: A_open.stopOut },
      A_trig: A_trig && { traded: true, R: round(A_trig.R), entryClosePct: round(A_trig.entryClosePct, 2), maeR: round(A_trig.maeR), stopOut: A_trig.stopOut } || { traded: false },
      B: B && { traded: true, R: round(B.R), entryClosePct: round(B.entryClosePct, 2), maeR: round(B.maeR), stopOut: B.stopOut } || { traded: false },
    });
  }
  return { events, skipped };
}

// Aggregate stats over a list of {R, entryClosePct, maeR, stopOut}.
function agg(list) {
  const n = list.length; if (!n) return { n: 0 };
  const R = list.map(x => x.R), ec = list.map(x => x.entryClosePct), mae = list.map(x => x.maeR);
  const wins = R.filter(v => v > 0), losses = R.filter(v => v <= 0);
  const gW = wins.reduce((a, b) => a + b, 0), gL = Math.abs(losses.reduce((a, b) => a + b, 0));
  return {
    n, meanR: round(mean(R)), medianR: round(median(R)), winRate: round(wins.length / n),
    PF: gL > 0 ? round(gW / gL, 2) : 99, meanEntryClosePct: round(mean(ec), 2),
    meanMaeR: round(mean(mae)), medianMaeR: round(median(mae)), stopOutRate: round(list.filter(x => x.stopOut).length / n),
  };
}

function main() {
  const { events, skipped } = build();
  console.log(`Built ${events.length} events (skipped ${skipped}).  Years:`,
    Object.entries(events.reduce((a, e) => (a[e.year] = (a[e.year] || 0) + 1, a), {})));
  const out = { generatedAt: new Date().toISOString(), n: events.length, skipped, caveat: 'intra5 is ~2024-2025 single-window; validates the MECHANISM, not multi-regime robustness.' };

  const aTrigTraded = events.filter(e => e.A_trig.traded).length;
  const bTraded = events.filter(e => e.B.traded).length;
  const openGreen = events.filter(e => e.openAboveTrig).length;
  console.log(`gap-open above prior-day-high (green at 09:30): ${openGreen}/${events.length} | A_trig trades: ${aTrigTraded} | B trades: ${bTraded}\n`);
  out.counts = { total: events.length, openGreenAtOpen: openGreen, aTrigTraded, bTraded };

  // ── (1) HEAD-TO-HEAD on the subset where Rule B triggers ──────────────────────
  const bSub = events.filter(e => e.B.traded);
  const h2h = {
    A_open: agg(bSub.map(e => e.A_open)),
    A_trig: agg(bSub.filter(e => e.A_trig.traded).map(e => e.A_trig)),
    B: agg(bSub.map(e => e.B)),
  };
  console.log('=== (1) HEAD-TO-HEAD on events where Rule B triggers (n=' + bSub.length + ') ===');
  for (const [k, v] of Object.entries(h2h)) console.log(`  ${k.padEnd(7)}`, JSON.stringify(v));
  out.headToHead = h2h;

  // ── (2) ACROSS ALL EVENTS — no-trade = 0R, no exposure ────────────────────────
  const zero = { R: 0, entryClosePct: 0, maeR: 0, stopOut: false };
  const allA_open = events.map(e => e.A_open);
  const allA_trig = events.map(e => e.A_trig.traded ? e.A_trig : zero);
  const allB = events.map(e => e.B.traded ? e.B : zero);
  const across = { A_open: agg(allA_open), A_trig: agg(allA_trig), B: agg(allB) };
  console.log('\n=== (2) ACROSS ALL EVENTS (no-trade = 0R / no exposure; n=' + events.length + ') ===');
  for (const [k, v] of Object.entries(across)) console.log(`  ${k.padEnd(7)}`, JSON.stringify(v));
  out.acrossAll = across;

  // ── Fader vs runner split (head-to-head subset) ───────────────────────────────
  console.log('\n=== fader vs runner (Rule-B-triggered subset) ===');
  out.split = {};
  for (const grp of ['runner', 'fader']) {
    const sub = bSub.filter(e => (grp === 'runner' ? e.runner : !e.runner));
    if (!sub.length) continue;
    const g = { n: sub.length, A_trig: agg(sub.filter(e => e.A_trig.traded).map(e => e.A_trig)), B: agg(sub.map(e => e.B)) };
    console.log(`  ${grp} (n=${sub.length}): A_trig`, JSON.stringify(g.A_trig), '| B', JSON.stringify(g.B));
    out.split[grp] = g;
  }

  // ── VERDICT vs the pre-registered bar (Rule B vs the CURRENT live rule A_trig) ─
  const bAll = across.B, aAll = across.A_trig;
  const beatsR = bAll.meanR > aAll.meanR;
  const beatsPF = bAll.PF > aAll.PF;
  const lowerMAE = bAll.meanMaeR < aAll.meanMaeR;         // less fade / adverse excursion
  const adequateN = bTraded >= 50;
  const pass = beatsR && beatsPF && lowerMAE && adequateN;
  out.bar = { beatsR, beatsPF, lowerMAE, adequateN, ruleB: bAll, currentLive_Atrig: aAll };
  out.verdict = pass
    ? 'PASS: OR-gate (Rule B) beats the current live prior-day-high trigger on meanR AND PF AND MAE with adequate n.'
    : `NO-SHIP: bar failed vs current-live A_trig — beatsR=${beatsR}, beatsPF=${beatsPF}, lowerMAE=${lowerMAE}, adequateN=${adequateN}.`;
  console.log('\nVERDICT: ' + out.verdict);

  out.events = events;
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`\nsaved ${events.length} events + summary → research/data/orb-gate-validation.json`);
}

main();

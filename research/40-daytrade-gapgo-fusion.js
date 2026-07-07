'use strict';
// Step 40 — Day-Trade × Gap-and-Go FUSION test on the survivorship-corrected rig.
//   node --env-file=research/.env research/40-daytrade-gapgo-fusion.js
//
// HYPOTHESIS (H): among Day-Trade screener candidates (lib/daytrade SCANS, the live
// serve definitions), the subset that ALSO qualifies as a Gap-and-Go setup the SAME
// day (unscheduled non-earnings gap-up >=5%, ADV >= $10M, ORB triggered — the step-36
// event definition) has MATERIALLY higher forward performance than candidates that
// do not overlap. Rationale: the tradeable next-open day-trade label is a coin flip
// (step 33, OOS AUC 0.47-0.50); Gap & Go is the one deflation-surviving continuation
// event — the intersection may concentrate the picks onto real continuation.
//
// PRE-REGISTERED DESIGN (written before any results were computed):
// • Panel: step-33's candidate panel rebuilt in JS over ALL cached names (delisted-
//   inclusive), 2021-2026, using the SHIPPED lib/daytrade dayMetrics + passesScan on
//   the three live SCANS (momentum_liquid / explosive_small / momentum_building —
//   note: building is the live widened 1.15x/2.5%, vs step 33's 1.2x/3.0%). One row
//   per name-day (scan tag priority: liquid > explosive > building). Step-33 earnings
//   exclusion applied (skip if an income filingDate falls inside the hold window).
// • Label (a): step-33's tradeable Y — 3-session excess over SPY entered at the NEXT
//   session's OPEN, raw fwd winsorized to [-90%, +300%] before the SPY subtraction.
// • Label (b): step-36's realized ORB R-multiple (trigger = signal-day high, stop =
//   2.5xATR, 1:2 target, HOLD=3, stop-first-if-both), null if never triggered.
// • Overlap flag, decomposed EXACTLY per step 36: gapOk (open gap >= 5.0), liqOk
//   (20d ADV incl. gap day >= $10M), nonEarn (no earnings date within ±2 calendar
//   days, research/data/earnings), orbOk (ORB triggered within HOLD).
//   LOOK-AHEAD HONESTY (pre-registered): orbOk resolves DURING the forward window,
//   so for label (a) — entered at next open, before the trigger is known — the full
//   overlap flag leaks forward information. Therefore the HEADLINE excess test uses
//   the KNOWABLE flag = gapOk && liqOk && nonEarn (fully known at the next open);
//   the full flag on label (a) is reported only as a leak-flagged diagnostic. For
//   label (b) the comparison conditions BOTH groups on triggering (entry at the
//   trigger price), so the full qualification is fair there.
// • Robustness: split by YEAR (2021H2..2026, cache window) and REGIME (lib/macro
//   buildMacroLookup, as step 36).
// • Controls (must add lift over existing knobs): (1) nested means gap<5 vs gap>=5
//   vs knowable — if plain gap>=5 explains it, the flag is gap size re-expressed;
//   (2) within-gap-bucket ([5,7),[7,10),[10,inf)) knowable-vs-not diffs; (3) rank
//   ICs of gapPct / relVol / continuationScore vs excess, and within-quintile-of-
//   continuationScore flag diffs; (4) decompose non-knowable gap>=5 by reason.
//
// PASS BAR (pre-registered): SHIP only if the knowable-overlap group beats
// non-overlap on label (a) by a margin that is (i) significant (Welch t>=2 or
// one-sided permutation p<0.05), (ii) positive-diff in the majority of years
// INCLUDING 2022, and (iii) adds incremental lift over gap-size /
// continuationScore alone (within-bucket diffs must not collapse to ~0).
// Otherwise NO-SHIP.

const fs = require('fs');
const path = require('path');
const APP = path.resolve(__dirname, '..');
const pit = require('./lib/pit');
const { SCANS, dayMetrics, passesScan } = require(APP + '/lib/daytrade');
const { GAP_STRONG, MIN_DOLLAR_VOL, continuationScore } = require(APP + '/lib/gapgo');
const { buildMacroLookup } = require(APP + '/lib/macro');

const DATA = path.join(__dirname, 'data');
const OUT = path.join(DATA, 'daytrade-gapgo-fusion.json');
const HOLD = 3;                      // step-33 / step-36 hold
const WINS_LO = -0.9, WINS_HI = 3.0; // step-33 winsorization of the raw fwd return
const ATR_MULT = 2.5, RR = 2;        // step-36 ORB trade
const EARN_GUARD_DAYS = 2;           // step-36 ±2 calendar-day earnings guard
const N_PERM = 2000;
const SCAN_PRIORITY = ['momentum_liquid', 'explosive_small', 'momentum_building'];

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const variance = a => { if (a.length < 2) return null; const m = mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1); };
const clip = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function welchT(a, b) {
  if (a.length < 2 || b.length < 2) return null;
  const va = variance(a) / a.length, vb = variance(b) / b.length;
  const den = Math.sqrt(va + vb);
  return den > 0 ? (mean(a) - mean(b)) / den : null;
}

// One-sided permutation p for mean(T) - mean(F) >= observed, shuffling group labels.
function permP(valsT, valsF, nPerm) {
  const all = valsT.concat(valsF), nT = valsT.length, obs = mean(valsT) - mean(valsF);
  let ge = 0;
  for (let p = 0; p < nPerm; p++) {
    for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = all[i]; all[i] = all[j]; all[j] = t; }
    let sT = 0; for (let i = 0; i < nT; i++) sT += all[i];
    let sF = 0; for (let i = nT; i < all.length; i++) sF += all[i];
    if (sT / nT - sF / (all.length - nT) >= obs) ge++;
  }
  return ge / nPerm;
}

function spearman(a, b) {
  const n = a.length; if (n < 3) return null;
  const rank = v => {
    const idx = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(n);
    let i = 0;
    while (i < n) { let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; }
    return r;
  };
  const ra = rank(a), rb = rank(b), ma = mean(ra), mb = mean(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null;
}

// Group stats on the excess label (fractional units).
function excStat(evs) {
  const x = evs.map(e => e.excess), n = x.length;
  if (!n) return { n: 0 };
  return { n, meanPct: +(mean(x) * 100).toFixed(2), medianPct: +(median(x) * 100).toFixed(2), winRate: +(x.filter(v => v > 0).length / n).toFixed(3) };
}

// Group stats on the realized ORB R label (triggered rows only).
function rStat(evs) {
  const r = evs.filter(e => e.R != null).map(e => e.R), n = r.length;
  if (!n) return { n: 0 };
  const wins = r.filter(v => v > 0), losses = r.filter(v => v <= 0);
  const gW = wins.reduce((a, b) => a + b, 0), gL = Math.abs(losses.reduce((a, b) => a + b, 0));
  return { n, meanR: +mean(r).toFixed(3), medianR: +median(r).toFixed(3), winRate: +(wins.length / n).toFixed(3), PF: gL > 0 ? +(gW / gL).toFixed(2) : 99 };
}

// ── step-36 primitives, copied verbatim (event-definition fidelity) ─────────────
const series = price => (price || []).map(r => ({ ms: Date.parse(r.date), d: r.date, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume })).filter(r => r.c > 0 && r.o > 0).sort((a, b) => a.ms - b.ms);
function atrAt(s, i, p = 14) { if (i < p) return null; let sum = 0; for (let k = i - p + 1; k <= i; k++) { const tr = Math.max(s[k].h - s[k].l, Math.abs(s[k].h - s[k - 1].c), Math.abs(s[k].l - s[k - 1].c)); sum += tr; } return sum / p; }
function orbTrade(s, i, atr) {
  const trigger = s[i].h, risk = ATR_MULT * atr;
  if (!(risk > 0)) return null;
  const stop = trigger - risk, target = trigger + RR * risk;
  let entered = false;
  for (let k = 1; k <= HOLD && i + k < s.length; k++) {
    const b = s[i + k];
    if (!entered) { if (b.h >= trigger) { entered = true; if (b.l <= stop) return -1; if (b.h >= target) return RR; } continue; }
    if (b.l <= stop) return -1;
    if (b.h >= target) return RR;
  }
  if (!entered) return null;
  const j = Math.min(i + HOLD, s.length - 1);
  return (s[j].c - trigger) / risk;
}

(async () => {
  // SPY (open + close) for the tradeable next-open excess label — pit disk cache.
  const spyRaw = await pit.fetchSymbol('SPY');
  const spy = series(spyRaw.price);
  if (spy.length < 300) { console.error('SPY series unavailable'); process.exit(1); }
  const spyIdx = {}; spy.forEach((b, i) => { spyIdx[b.d] = i; });

  const macro = await buildMacroLookup('5y').catch(() => null);

  const files = fs.readdirSync(pit.CACHE).filter(f => f.endsWith('.json'));
  const rows = [];
  let namesScanned = 0;

  for (const f of files) {
    const sym = f.slice(0, -5);
    if (sym === 'SPY') continue;
    let c; try { c = JSON.parse(fs.readFileSync(path.join(pit.CACHE, f), 'utf8')); } catch { continue; }
    const s = series(c.price);
    if (s.length < 60) continue;
    namesScanned++;

    // step-33 day-trade-side earnings exclusion: income filingDate in the hold window
    const filings = [];
    for (const r of (c.income || [])) { const fd = (r.filingDate || r.date || '').slice(0, 10); if (fd) filings.push(fd); }

    // step-36 gap-side earnings set (announcement dates, ±2 calendar days)
    const earn = new Set();
    const ef = path.join(DATA, 'earnings', `${sym}.json`);
    if (fs.existsSync(ef)) { try { JSON.parse(fs.readFileSync(ef, 'utf8')).forEach(e => { if (e.date) earn.add(e.date); }); } catch { /* keep empty */ } }
    const nearEarn = dstr => { const t = Date.parse(dstr); for (let dd = -EARN_GUARD_DAYS; dd <= EARN_GUARD_DAYS; dd++) { if (earn.has(new Date(t + dd * 864e5).toISOString().slice(0, 10))) return true; } return false; };

    // rolling prior-20d volume sum for a cheap prefilter (authoritative check = lib dayMetrics)
    let vol20 = 0;
    for (let i = 30; i <= s.length - 1 - HOLD; i++) {
      if (i === 30) { for (let k = i - 20; k < i; k++) vol20 += s[k].v; }
      else { vol20 += s[i - 1].v - s[i - 21].v; }
      const prev = s[i - 1].c;
      if (!(prev > 0) || !(s[i].v > 0)) continue;
      const pct = (s[i].c - prev) / prev * 100;
      const relVolPre = vol20 > 0 ? s[i].v / (vol20 / 20) : 0;
      if (pct < 2.49 || relVolPre < 1.14 || s[i].c < 1 || s[i].c > 50) continue;   // superset of all scan gates

      // authoritative: the SHIPPED dayMetrics + passesScan (incl. split-artifact guard)
      const slice = s.slice(i - 30, i + 1).map(b => ({ date: b.d, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
      const m = dayMetrics(slice, null);
      if (!m) continue;
      let scan = null;
      for (const k of SCAN_PRIORITY) { if (passesScan(m, SCANS[k])) { scan = k; break; } }
      if (!scan) continue;

      // step-33 earnings exclusion over the hold window
      const d0 = s[i].d, dH = s[i + HOLD].d;
      if (filings.some(fd => fd > d0 && fd <= dH)) continue;

      // label (a): tradeable next-open 3-session excess over SPY
      const entry = s[i + 1].o;
      if (!(entry > 0)) continue;
      const di = spyIdx[d0];
      if (di == null || di + HOLD >= spy.length || !(spy[di + 1].o > 0)) continue;
      const fwd = clip(s[i + HOLD].c / entry - 1, WINS_LO, WINS_HI);
      const excess = fwd - (spy[di + HOLD].c / spy[di + 1].o - 1);

      // label (b): step-36 realized ORB R
      const atr = atrAt(s, i);
      const R = atr ? orbTrade(s, i, atr) : null;

      // overlap flag components (step-36 event definition)
      const gap = (s[i].o - prev) / prev * 100;
      let advSum = 0; for (let k = i - 19; k <= i; k++) advSum += s[k].c * s[k].v;
      const gapOk = gap >= GAP_STRONG;
      const liqOk = advSum / 20 >= MIN_DOLLAR_VOL;
      const nonEarn = !nearEarn(d0);
      const orbOk = R != null;

      const mac = macro ? macro.at(d0) : null;
      const reg = mac ? (mac.riskOff ? 'off' : mac.riskOn ? 'on' : 'neu') : 'neu';

      rows.push({
        sym, date: d0, year: d0.slice(0, 4), scan, reg,
        pct: +pct.toFixed(2), gap: +gap.toFixed(2), relVol: m.relVol,
        excess: +excess.toFixed(5), R: R != null ? +R.toFixed(4) : null,
        gapOk, liqOk, nonEarn, orbOk,
        knowable: gapOk && liqOk && nonEarn,            // fully known at next open
        overlap: gapOk && liqOk && nonEarn && orbOk,     // full step-36 event (leaks for label a)
        score: continuationScore(gap, m.relVol, mac ? mac.regime : 'neutral'),
      });
    }
  }

  console.log(`Scanned ${namesScanned} names → ${rows.length} day-trade candidate-days (live SCANS, step-33 label conventions).`);
  const byScan = {}; rows.forEach(r => { byScan[r.scan] = (byScan[r.scan] || 0) + 1; });
  console.log('by scan:', byScan);
  const nKnow = rows.filter(r => r.knowable).length, nOver = rows.filter(r => r.overlap).length;
  console.log(`knowable overlap (gap>=5 & liquid & non-earnings): ${nKnow} | full overlap (+ORB triggered): ${nOver}\n`);

  const out = { generatedAt: new Date().toISOString(), n: rows.length, byScan };

  // ── 1. HEADLINE: knowable flag on the tradeable excess label ─────────────────
  const T = rows.filter(r => r.knowable), F = rows.filter(r => !r.knowable);
  const xT = T.map(r => r.excess), xF = F.map(r => r.excess);
  const t = welchT(xT, xF), p = permP(xT.slice(), xF.slice(), N_PERM);
  const diff = (mean(xT) - mean(xF)) * 100;
  console.log('=== 1. HEADLINE — KNOWABLE overlap vs rest, tradeable 3d next-open excess vs SPY ===');
  console.log('  overlap:', JSON.stringify(excStat(T)));
  console.log('  rest:   ', JSON.stringify(excStat(F)));
  console.log(`  diff ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}pp | Welch t ${t?.toFixed(2)} | perm p(one-sided, ${N_PERM}) ${p.toFixed(4)}\n`);
  out.headlineExcess = { overlap: excStat(T), rest: excStat(F), diffPct: +diff.toFixed(3), welchT: +t.toFixed(2), permP: p };

  // ── 2. Diagnostic: FULL overlap flag on excess (LEAKS — orbOk resolves in-window) ─
  const Tf = rows.filter(r => r.overlap), Ff = rows.filter(r => !r.overlap);
  const tf = welchT(Tf.map(r => r.excess), Ff.map(r => r.excess));
  console.log('=== 2. DIAGNOSTIC (look-ahead: orbOk is NOT knowable at next-open entry) ===');
  console.log('  full overlap:', JSON.stringify(excStat(Tf)), '| rest:', JSON.stringify(excStat(Ff)), `| t ${tf?.toFixed(2)}\n`);
  out.diagnosticFullOverlapExcess = { overlap: excStat(Tf), rest: excStat(Ff), welchT: tf != null ? +tf.toFixed(2) : null, leak: 'orbOk resolves during the fwd window' };

  // ── 3. ORB R label among TRIGGERED candidates (fair: both sides enter at trigger) ─
  const trig = rows.filter(r => r.R != null);
  const qT = trig.filter(r => r.knowable), qF = trig.filter(r => !r.knowable);
  const tR = welchT(qT.map(r => r.R), qF.map(r => r.R));
  console.log('=== 3. ORB R (2.5xATR / 1:2 / HOLD 3) among triggered candidates ===');
  console.log('  gap&go-qualified:', JSON.stringify(rStat(qT)));
  console.log('  not qualified:  ', JSON.stringify(rStat(qF)), `| Welch t on R ${tR?.toFixed(2)}\n`);
  out.orbR = { qualified: rStat(qT), rest: rStat(qF), welchT: tR != null ? +tR.toFixed(2) : null };

  // ── 4. Robustness: YEAR and REGIME splits of the headline diff ────────────────
  console.log('=== 4. ROBUSTNESS — knowable-overlap diff by year / regime (excess pp; R diff) ===');
  out.byYear = {}; out.byRegime = {};
  for (const y of [...new Set(rows.map(r => r.year))].sort()) {
    const a = rows.filter(r => r.year === y && r.knowable), b = rows.filter(r => r.year === y && !r.knowable);
    if (!a.length || !b.length) continue;
    const d = (mean(a.map(r => r.excess)) - mean(b.map(r => r.excess))) * 100;
    const ra = a.filter(r => r.R != null).map(r => r.R), rb = b.filter(r => r.R != null).map(r => r.R);
    const dR = ra.length && rb.length ? mean(ra) - mean(rb) : null;
    console.log(`  ${y}: nOv=${a.length} nRest=${b.length} excessDiff ${d >= 0 ? '+' : ''}${d.toFixed(2)}pp | ovMean ${(mean(a.map(r => r.excess)) * 100).toFixed(2)}% | R-diff ${dR != null ? dR.toFixed(3) : 'n/a'}`);
    out.byYear[y] = { nOverlap: a.length, nRest: b.length, diffPct: +d.toFixed(3), overlapMeanPct: +(mean(a.map(r => r.excess)) * 100).toFixed(2), rDiff: dR != null ? +dR.toFixed(3) : null };
  }
  for (const g of ['on', 'neu', 'off']) {
    const a = rows.filter(r => r.reg === g && r.knowable), b = rows.filter(r => r.reg === g && !r.knowable);
    if (!a.length || !b.length) continue;
    const d = (mean(a.map(r => r.excess)) - mean(b.map(r => r.excess))) * 100;
    console.log(`  regime ${g}: nOv=${a.length} nRest=${b.length} excessDiff ${d >= 0 ? '+' : ''}${d.toFixed(2)}pp | ovMean ${(mean(a.map(r => r.excess)) * 100).toFixed(2)}%`);
    out.byRegime[g] = { nOverlap: a.length, nRest: b.length, diffPct: +d.toFixed(3), overlapMeanPct: +(mean(a.map(r => r.excess)) * 100).toFixed(2) };
  }

  // ── 5. CONTROLS — is the flag just gap size / continuationScore re-expressed? ──
  console.log('\n=== 5. CONTROLS ===');
  const nested = {
    'gap<5 (no overlap possible)': rows.filter(r => !r.gapOk),
    'gap>=5 ALL': rows.filter(r => r.gapOk),
    'gap>=5 NOT knowable (earn/illiquid)': rows.filter(r => r.gapOk && !r.knowable),
    'gap>=5 knowable (headline group)': rows.filter(r => r.knowable),
  };
  out.nested = {};
  for (const [k, evs] of Object.entries(nested)) { const st = excStat(evs); console.log(`  ${k.padEnd(38)} ${JSON.stringify(st)}`); out.nested[k] = st; }
  // reason decomposition for gap>=5 non-knowable
  const nk = rows.filter(r => r.gapOk && !r.knowable);
  out.nonKnowableReasons = {
    earningsNear: excStat(nk.filter(r => !r.nonEarn)),
    illiquid: excStat(nk.filter(r => r.nonEarn && !r.liqOk)),
  };
  console.log('  gap>=5 non-knowable by reason: earningsNear', JSON.stringify(out.nonKnowableReasons.earningsNear), '| illiquid', JSON.stringify(out.nonKnowableReasons.illiquid));

  // within-gap-bucket: does knowable (earnings+liquidity screen) add lift over gap size?
  console.log('  within-gap-bucket knowable-vs-not (excess pp):');
  out.gapBuckets = {};
  for (const [lo, hi, name] of [[5, 7, 'gap 5-7'], [7, 10, 'gap 7-10'], [10, 1e9, 'gap >=10']]) {
    const bucket = rows.filter(r => r.gap >= lo && r.gap < hi);
    const a = bucket.filter(r => r.knowable), b = bucket.filter(r => !r.knowable);
    if (a.length < 20 || b.length < 20) { console.log(`    ${name}: insufficient n (${a.length}/${b.length})`); continue; }
    const d = (mean(a.map(r => r.excess)) - mean(b.map(r => r.excess))) * 100;
    const tt = welchT(a.map(r => r.excess), b.map(r => r.excess));
    console.log(`    ${name}: nOv=${a.length} nRest=${b.length} diff ${d >= 0 ? '+' : ''}${d.toFixed(2)}pp t=${tt?.toFixed(2)}`);
    out.gapBuckets[name] = { nOverlap: a.length, nRest: b.length, diffPct: +d.toFixed(3), welchT: tt != null ? +tt.toFixed(2) : null };
  }

  // rank ICs vs the tradeable excess (are the existing knobs already this signal?)
  const exc = rows.map(r => r.excess);
  out.ics = {
    gap: +spearman(rows.map(r => r.gap), exc).toFixed(4),
    relVol: +spearman(rows.map(r => r.relVol), exc).toFixed(4),
    contScore: +spearman(rows.map(r => r.score), exc).toFixed(4),
    knowableFlag: +spearman(rows.map(r => r.knowable ? 1 : 0), exc).toFixed(4),
  };
  console.log('  rank IC vs tradeable excess:', JSON.stringify(out.ics));

  // within continuationScore-quintile flag diff
  const sorted = [...rows].sort((a, b) => a.score - b.score);
  console.log('  within-contScore-quintile knowable-vs-not (excess pp):');
  out.scoreQuintiles = {};
  for (let q = 0; q < 5; q++) {
    const qs = sorted.slice(Math.floor(q * rows.length / 5), Math.floor((q + 1) * rows.length / 5));
    const a = qs.filter(r => r.knowable), b = qs.filter(r => !r.knowable);
    if (a.length < 20 || b.length < 20) { console.log(`    Q${q + 1}: insufficient n (${a.length}/${b.length})`); continue; }
    const d = (mean(a.map(r => r.excess)) - mean(b.map(r => r.excess))) * 100;
    console.log(`    Q${q + 1} (score ${qs[0].score}-${qs[qs.length - 1].score}): nOv=${a.length} nRest=${b.length} diff ${d >= 0 ? '+' : ''}${d.toFixed(2)}pp`);
    out.scoreQuintiles[`Q${q + 1}`] = { nOverlap: a.length, nRest: b.length, diffPct: +d.toFixed(3) };
  }

  // ── 6. VERDICT vs the pre-registered bar ───────────────────────────────────────
  const years = Object.entries(out.byYear);
  const posYears = years.filter(([, v]) => v.diffPct > 0);
  const has2022Pos = out.byYear['2022'] ? out.byYear['2022'].diffPct > 0 : false;
  const sig = (t != null && t >= 2) || p < 0.05;
  const majority = posYears.length > years.length / 2 && has2022Pos;
  const bucketDiffs = Object.values(out.gapBuckets).map(b => b.diffPct);
  const incremental = bucketDiffs.length > 0 && bucketDiffs.filter(d => d > 0).length > bucketDiffs.length / 2 && mean(bucketDiffs) > 0.15;
  const pass = sig && diff > 0 && majority && incremental;
  out.bar = { significant: sig, diffPositive: diff > 0, majorityYearsIncl2022: majority, incrementalOverGapSize: incremental };
  out.verdict = pass
    ? 'PASS: knowable gap&go overlap beats the rest significantly, in the majority of years incl 2022, with within-gap-bucket incremental lift.'
    : `NO-SHIP: bar failed — significant=${sig}, diff>0=${diff > 0}, majorityYearsIncl2022=${majority}, incrementalOverGapSize=${incremental}.`;
  console.log('\nVERDICT: ' + out.verdict);

  out.rows = rows;
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`\nsaved ${rows.length} rows + summary → research/data/daytrade-gapgo-fusion.json`);
})().catch(e => { console.error('ERR', e.message, e.stack); process.exit(1); });

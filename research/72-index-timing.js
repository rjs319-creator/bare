'use strict';
// Step 72 — INDEX-TIMING OVERLAYS (exploratory, registered 2026-08-06).
//   node research/72-index-timing.js               (network: Yahoo daily bars)
//
// The ONE preregistered exploratory pass for hypothesis `index-timing-overlays`
// (family regime) — the orthogonal "WHEN does the index pay exposure?" axis.
// THREE frozen sub-signals, all verdicts recorded together (no cherry-picking):
//   TOM        — long only the last session of each month through the first 3 of
//                the next (mechanical contribution/reinvestment flows)
//   CREDDIV    — divergence state = trailing-21s HYG return < 0 AND trailing-21s
//                SPY return > 0 (credit leads; state expected to precede weakness)
//   VIXSLOPE   — inversion state = ^VIX close > ^VIX3M close (stress persistence)
//
// FROZEN per-signal LEAD criterion: state-vs-complement forward-return
// difference with Newey-West t (lag 4) ≥ 2 in the expected direction AND the
// naive long-only overlay's Sharpe > SPY buy-and-hold Sharpe on the identical
// window (guards against relabeling risk-avoidance as alpha). Anything else is
// null. The 2021-2026 window is SPENT for all three on completion.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const EL = require('../lib/research/evidence-log');
const REG = require('../lib/research/hypothesis-registry');
const { fetchDailyHistory } = require('../lib/screener');

const DATA = path.join(__dirname, 'data');
const HYP_ID = 'index-timing-overlays';
const FWD = 5;                                  // forward window (sessions) for state tests
const NW_LAG = 4;                               // overlapping 5-session forwards
const SWITCH_COST = 0.0002;                     // 2bps per state-change switch (net overlay read)

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const r4 = (x) => (x == null ? null : +x.toFixed(4));

// Newey-West t for the mean of a (possibly autocorrelated) series.
function nwT(series, lag = NW_LAG) {
  const n = series.length;
  if (n < 20) return null;
  const m = mean(series);
  const e = series.map((x) => x - m);
  let s0 = mean(e.map((x) => x * x));
  for (let l = 1; l <= lag; l++) {
    let g = 0;
    for (let i = l; i < n; i++) g += e[i] * e[i - l];
    g /= n;
    s0 += 2 * (1 - l / (lag + 1)) * g;
  }
  const se = Math.sqrt(s0 / n);
  return se > 0 ? m / se : null;
}

// Two-state comparison: NW t of the per-day difference series constructed by
// state indicator × forward return demeaned against the complement.
function stateDiffT(fwdRets, states) {
  const a = [], b = [];
  for (let i = 0; i < fwdRets.length; i++) {
    if (fwdRets[i] == null || states[i] == null) continue;
    (states[i] ? a : b).push(fwdRets[i]);
  }
  if (a.length < 20 || b.length < 20) return { t: null, a: a.length, b: b.length, meanA: null, meanB: null };
  // NW t on the pooled "state-centered" series: x_i − mean(complement) for state
  // rows; robust to the overlap and keeps one series for the HAC estimator.
  const mB = mean(b);
  const centered = a.map((x) => x - mB);
  return { t: r4(nwT(centered)), a: a.length, b: b.length, meanA: r4(mean(a)), meanB: r4(mB) };
}

// Overlay equity curve: in-market on state days, cash otherwise; per-switch cost.
function overlayStats(dailyRets, inMarket) {
  let eq = 1, peak = 1, maxDD = 0, switches = 0;
  const per = [];
  for (let i = 0; i < dailyRets.length; i++) {
    if (i > 0 && inMarket[i] !== inMarket[i - 1]) switches++;
    const r = inMarket[i] ? dailyRets[i] : 0;
    per.push(r);
    eq *= 1 + r;
    peak = Math.max(peak, eq);
    maxDD = Math.min(maxDD, eq / peak - 1);
  }
  const eqNet = eq * Math.pow(1 - SWITCH_COST, switches);
  const sh = sd(per) > 0 ? (mean(per) / sd(per)) * Math.sqrt(252) : null;
  return { totalPct: r4((eq - 1) * 100), totalNetPct: r4((eqNet - 1) * 100), sharpe: r4(sh), maxDDPct: r4(maxDD * 100), switches, daysIn: inMarket.filter(Boolean).length };
}

async function main() {
  const hyp = REG.find(HYP_ID);
  if (!hyp) { console.log(`BLOCKED: ${HYP_ID} not registered`); process.exitCode = 1; return; }
  console.log(`registered exploratory pass — familyTrials(${hyp.familyId}) = ${REG.familyTrials(hyp.familyId)}`);

  const [spyD, hygD, vixD, vix3D] = await Promise.all(['SPY', 'HYG', '^VIX', '^VIX3M'].map((s) => fetchDailyHistory(s, '5y')));
  for (const [n, d] of [['SPY', spyD], ['HYG', hygD], ['^VIX', vixD], ['^VIX3M', vix3D]]) {
    if (!d || !d.candles || d.candles.length < 800) { console.log(`BLOCKED: ${n} bars unavailable`); process.exitCode = 1; return; }
  }
  const spy = spyD.candles;
  const closeMap = (candles) => { const m = new Map(); for (const b of candles) m.set(b.date, b.close); return m; };
  const hygC = closeMap(hygD.candles), vixC = closeMap(vixD.candles), vix3C = closeMap(vix3D.candles);

  const dailyRets = spy.map((b, i) => (i > 0 ? b.close / spy[i - 1].close - 1 : 0));
  const fwdRets = spy.map((b, i) => (i + FWD < spy.length ? spy[i + FWD].close / b.close - 1 : null));
  const ret21 = (candles, m, i) => { const d0 = spy[i - 21] && m.get(spy[i - 21].date), d1 = m.get(spy[i].date); return (d0 > 0 && d1 > 0) ? d1 / d0 - 1 : null; };

  // ── frozen state constructions on the SPY session axis ──
  const monthOf = (d) => d.slice(0, 7);
  const tomState = spy.map((b, i) => {
    const next = spy[i + 1];
    if (next && monthOf(next.date) !== monthOf(b.date)) return true;             // last session of month
    for (let k = 1; k <= 3; k++) { const p = spy[i - k]; if (p && monthOf(p.date) !== monthOf(b.date)) return true; }  // first 3 of month
    return false;
  });
  const credState = spy.map((b, i) => {
    if (i < 21) return null;
    const h = ret21(hygD.candles && spy, hygC, i);
    const s = spy[i].close / spy[i - 21].close - 1;
    return (h == null) ? null : (h < 0 && s > 0);
  });
  const slopeState = spy.map((b) => {
    const v = vixC.get(b.date), v3 = vix3C.get(b.date);
    return (v > 0 && v3 > 0) ? v > v3 : null;
  });

  const bh = overlayStats(dailyRets, dailyRets.map(() => true));
  console.log(`SPY buy-and-hold: total ${bh.totalPct}% sharpe ${bh.sharpe} maxDD ${bh.maxDDPct}% (${spy.length} sessions)`);

  const judge = (name, state, expectStateWorse, overlayInMarket) => {
    const diff = stateDiffT(fwdRets, state);
    const ov = overlayStats(dailyRets, overlayInMarket);
    const directionOk = diff.meanA != null && (expectStateWorse ? diff.meanA < diff.meanB : diff.meanA > diff.meanB);
    const tOk = diff.t != null && Math.abs(diff.t) >= 2 && directionOk;
    const sharpeOk = ov.sharpe != null && bh.sharpe != null && ov.sharpe > bh.sharpe;
    const lead = tOk && sharpeOk;
    console.log(`${name}: state n ${diff.a} vs ${diff.b} | fwd${FWD} ${diff.meanA} vs ${diff.meanB} | NW-t ${diff.t} | overlay total ${ov.totalPct}% (net ${ov.totalNetPct}%) sharpe ${ov.sharpe} maxDD ${ov.maxDDPct}% switches ${ov.switches} ⇒ ${lead ? 'LEAD' : 'null'}`);
    return { diff, overlay: ov, directionOk, lead };
  };

  const results = {
    buyHold: bh,
    // TOM: expected direction is IN-window BETTER; overlay = long only in window.
    tom: judge('TOM', tomState, false, tomState),
    // CREDDIV: divergence expected WORSE; overlay = long except divergence days.
    creddiv: judge('CREDDIV', credState, true, credState.map((s) => s !== true)),
    // VIXSLOPE: inversion expected WORSE; overlay = long only in contango.
    vixslope: judge('VIXSLOPE', slopeState, true, slopeState.map((s) => s === false)),
  };
  const leads = ['tom', 'creddiv', 'vixslope'].filter((k) => results[k].lead);
  const verdict = leads.length ? 'pass-provisional' : 'not-confirmed';
  console.log(`FROZEN CRITERION → leads: [${leads.join(', ') || 'none'}] ⇒ VERDICT ${verdict.toUpperCase()}`);

  let codeVersion = 'git:unknown';
  try { codeVersion = `git:${execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim()}`; } catch { /* recorded as unknown */ }
  try { if (execSync('git status --porcelain', { cwd: __dirname }).toString().trim().length > 0) codeVersion += '+dirty'; } catch { codeVersion += '+dirty'; }
  const deps = {
    readJSON: async (p, dflt) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, p.replace(/^research\//, '')), 'utf8')); } catch { return dflt; } },
    writeJSON: async (p, obj) => {
      const f = path.join(DATA, p.replace(/^research\//, ''));
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(obj, null, 2));
    },
  };
  const metrics = JSON.parse(JSON.stringify(results));
  const rec = EL.makeEvidenceRecord({
    hypothesisId: HYP_ID,
    datasetHash: `yahoo-index-timing-5y:${crypto.createHash('sha256').update(JSON.stringify(metrics)).digest('hex').slice(0, 16)}`,
    periodStart: spy[0].date, periodEnd: spy[spy.length - 1].date,
    horizon: `${FWD}d`,
    codeVersion,
    manifestHash: crypto.createHash('sha256').update(JSON.stringify(metrics)).digest('hex').slice(0, 16),
    metrics,
    verdict,
    mode: 'exploratory',
    generatedAt: new Date().toISOString(),
    note: `The ONE registered exploratory pass (window now SPENT for ${HYP_ID}). All three sub-signal verdicts recorded together per the no-cherry-picking rule. 5y single window; TOM power-limited at ~60 months by construction.`,
  });
  if (!rec.ok) { console.error('evidence record invalid:', rec.errors); process.exitCode = 1; return; }
  await EL.appendEvidence(deps, rec.record).then((r) => console.log(`evidence: ${r.reason} (${r.recordId}) → research/data/evidence/${HYP_ID}/`));
}

if (require.main === module) main();
module.exports = { nwT, stateDiffT, overlayStats, HYP_ID };

'use strict';
// Step 71 — VRP OVERLAY, SYNTHETIC (exploratory, registered 2026-08-05).
//   node research/71-vrp-overlay.js        (live — Yahoo daily bars, 5y)
//
// The ONE registered exploratory pass for hypothesis `vrp-overlay-synthetic`
// (family volatility-structure): does a regime-gated systematic SPY put-write
// (sell 30d ATM cash-secured puts, hold to expiry) earn the variance risk
// premium with a better risk-adjusted profile than SPY buy-and-hold?
//
// FROZEN DESIGN (the registry entry + PREREGISTRATION-COMPOSITE-BOOK §3 are the
// authority — no strike/tenor/variant search):
//   * entry grid: every 21 sessions over SPY 5y daily bars; first entry = first
//     index with same-day ^VIX data AND 21 prior sessions; last entry must have
//     ≥21 sessions of subsequent data.
//   * per entry: sell ONE 30-calendar-day ATM put, strike K = entry close,
//     premium = Black-Scholes put with S=K=entry close, σ = VIX close/100 that
//     day, r = 4%, T = 30/365. Expiry = first bar ≥30 calendar days after entry
//     (its close = S_T). P&L = premium − max(0, K − S_T); collateral = K;
//     period return = P&L / K (cash-secured, collateral earns nothing).
//   * variants (exactly three): ungated / macroGated (skip risk-off entries,
//     lib/macro regime) / ivRvGated (enter only when VIX/100 > 1.1 × trailing
//     21-session realized vol, annualized √252). Gated variants hold cash (0%)
//     on skipped grid periods so every series shares the SPY timeline.
//   * costs scenario: gross, and net of $1 + one tick ($0.05 × 100 shares) per
//     contract side × 2 sides on a 1-contract basis, relative to collateral.
//   * FROZEN lead criterion: 'promising-lead' iff ANY gated variant's (gross)
//     Sharpe > SPY buy-and-hold Sharpe AND that variant's worst period > −25%.
// Recorded biases: synthetic BS with no smile UNDERSTATES real put premium
// (conservative); hold-to-expiry on daily closes has NO gap-risk realism.
// The 2021-2026 window is SPENT for this hypothesis when the run completes.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const EL = require('../lib/research/evidence-log');
const REG = require('../lib/research/hypothesis-registry');
const { fetchDailyHistory } = require('../lib/screener');
const { buildMacroLookup } = require('../lib/macro');

const DATA = path.join(__dirname, 'data');
const HYP_ID = 'vrp-overlay-synthetic';
const RANGE = '5y';
const GRID = 21;                    // sessions between entries
const RV_WINDOW = 21;               // trailing sessions for realized vol
const TENOR_DAYS = 30;              // calendar days to expiry
const RATE = 0.04;                  // risk-free rate (frozen)
const IVRV_RATIO = 1.1;             // ivRvGated entry threshold
const COMMISSION = 1;               // $ per contract side
const TICK = 0.05;                  // $ per share, one tick per side
const SHARES = 100;                 // shares per contract
const WORST_FLOOR = -0.25;          // frozen lead criterion: worst period > −25%
const ANN = Math.sqrt(252 / GRID);  // period → annual Sharpe factor
const DAY_MS = 86400 * 1000;

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(2)}%`);
const r4 = (x) => (x == null ? null : +x.toFixed(4));

// Standard normal CDF via Abramowitz-Stegun erf approximation (|ε| < 1.5e-7).
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

// Black-Scholes European put. Degenerate σ/T collapses to discounted intrinsic.
function blackScholesPut(S, K, sigma, r, T) {
  if (!(S > 0) || !(K > 0) || !(T > 0)) return null;
  if (!(sigma > 0)) return Math.max(0, K * Math.exp(-r * T) - S);
  const sqT = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / sqT;
  const d2 = d1 - sqT;
  return K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}

// Trailing realized vol from a window of closes (log returns, sample sd, √252).
function realizedVol(closes) {
  if (!closes || closes.length < 3) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    if (!(closes[i] > 0) || !(closes[i - 1] > 0)) return null;
    rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  return sd(rets) * Math.sqrt(252);
}

function maxDrawdown(returns) {
  let curve = 1, peak = 1, dd = 0;
  for (const r of returns) { curve *= 1 + r; peak = Math.max(peak, curve); dd = Math.min(dd, curve / peak - 1); }
  return dd;
}

// Stats over a full-grid period-return series (0 = cash on gated-out periods).
function statsOf(series, enteredCount) {
  const total = series.reduce((c, r) => c * (1 + r), 1) - 1;
  const sessions = series.length * GRID;
  const s = sd(series);
  const entered = series.filter((r) => r !== 0);
  return {
    nPeriods: enteredCount, gridPeriods: series.length,
    totalPct: r4(total * 100),
    annPct: r4((Math.pow(1 + total, 252 / sessions) - 1) * 100),
    sharpe: s > 0 ? r4((mean(series) / s) * ANN) : null,
    maxDDPct: r4(maxDrawdown(series) * 100),
    worstPct: r4(Math.min(0, ...series) * 100),
    pctPositive: entered.length ? r4((entered.filter((r) => r > 0).length / entered.length) * 100) : null,
  };
}

async function fetchVix() {
  for (const sym of ['^VIX', 'VIX', '^VIX']) {
    const hist = await fetchDailyHistory(sym, RANGE);
    if (hist && hist.candles && hist.candles.length) { console.log(`VIX source: ${sym} (${hist.candles.length} bars)`); return hist; }
  }
  return null;
}

// Build the frozen 21-session entry grid of period records.
function buildPeriods(bars, vixByDate) {
  let first = -1;
  for (let i = RV_WINDOW; i < bars.length; i++) if (vixByDate.has(bars[i].date)) { first = i; break; }
  if (first < 0) return { periods: [], skippedNoVix: 0, skippedNoExpiry: 0 };
  const periods = [];
  let skippedNoVix = 0, skippedNoExpiry = 0;
  for (let i = first; i + GRID <= bars.length - 1; i += GRID) {
    const entry = bars[i];
    const vixClose = vixByDate.get(entry.date);
    if (vixClose == null) { skippedNoVix++; continue; }         // grid keeps stepping; period unusable
    const entryMs = Date.parse(entry.date);
    let j = -1;
    for (let k = i + 1; k < bars.length; k++) if (Date.parse(bars[k].date) >= entryMs + TENOR_DAYS * DAY_MS) { j = k; break; }
    if (j < 0) { skippedNoExpiry++; continue; }
    const K = entry.close;
    const iv = vixClose / 100;
    const premium = blackScholesPut(K, K, iv, RATE, TENOR_DAYS / 365);
    const pnl = premium - Math.max(0, K - bars[j].close);
    const rv = realizedVol(bars.slice(i - RV_WINDOW, i + 1).map((b) => b.close));
    periods.push({
      entryIdx: i, date: entry.date, exitDate: bars[j].date, K,
      iv: r4(iv), rv: r4(rv), premium: r4(premium),
      ret: pnl / K,
      retNet: pnl / K - (2 * (COMMISSION + TICK * SHARES)) / (K * SHARES),
      ivrvOk: rv != null && iv > IVRV_RATIO * rv,
    });
  }
  return { periods, skippedNoVix, skippedNoExpiry };
}

function variantSeries(periods, isEntered, useNet) {
  let entered = 0;
  const series = periods.map((p) => {
    if (!isEntered(p)) return 0;
    entered++;
    return useNet ? p.retNet : p.ret;
  });
  return statsOf(series, entered);
}

function printStats(label, s) {
  console.log(`  ${label.padEnd(18)} n ${String(s.nPeriods).padStart(3)}/${s.gridPeriods}  total ${pct(s.totalPct / 100)}  ann ${pct(s.annPct / 100)}  sharpe ${s.sharpe}  maxDD ${pct(s.maxDDPct / 100)}  worst ${pct(s.worstPct / 100)}  %pos ${s.pctPositive}`);
}

async function main() {
  const hyp = REG.find(HYP_ID);
  if (!hyp) { console.log(`BLOCKED: ${HYP_ID} not registered`); process.exitCode = 1; return; }
  console.log(`registered exploratory pass — familyTrials(${hyp.familyId}) = ${REG.familyTrials(hyp.familyId)}`);

  const [spy, vix, macro] = await Promise.all([fetchDailyHistory('SPY', RANGE), fetchVix(), buildMacroLookup(RANGE)]);
  if (!spy || !spy.candles || !spy.candles.length) { console.log('BLOCKED: SPY daily history unavailable'); process.exitCode = 1; return; }
  if (!vix) { console.log('BLOCKED: ^VIX/VIX daily history unavailable'); process.exitCode = 1; return; }
  if (!macro) console.log('WARN: buildMacroLookup returned null — macroGated variant unavailable');

  // Shape verification (frozen contract check before relying on the candles).
  console.log(`SPY bar[0]: ${JSON.stringify(spy.candles[0])}`);
  console.log(`VIX bar[0]: ${JSON.stringify(vix.candles[0])}`);

  const vixByDate = new Map(vix.candles.map((c) => [c.date, c.close]));
  const { periods, skippedNoVix, skippedNoExpiry } = buildPeriods(spy.candles, vixByDate);
  if (periods.length < 10) { console.log(`BLOCKED: only ${periods.length} usable grid periods`); process.exitCode = 1; return; }

  // Macro regime at each entry (lib/macro regime strings: risk-off|risk-on|neutral).
  let macroNull = 0;
  for (const p of periods) {
    const m = macro ? macro.at(p.date) : null;
    if (macro && !m) macroNull++;
    p.regime = m ? m.regime : null;
    p.riskOff = m ? m.regime === 'risk-off' : false;
  }
  console.log(`grid: ${periods.length} periods ${periods[0].date} → ${periods[periods.length - 1].exitDate} (skipped: ${skippedNoVix} no-VIX, ${skippedNoExpiry} no-expiry; macro null at ${macroNull} entries)`);
  console.log(`gates: ${periods.filter((p) => p.riskOff).length} risk-off entries skipped by macroGated; ${periods.filter((p) => p.ivrvOk).length}/${periods.length} entries pass IV>1.1×RV`);

  // SPY buy-and-hold over the identical grid window + per-21-session series.
  const i0 = periods[0].entryIdx;
  const closes = spy.candles.map((b) => b.close);
  const spySeries = periods.map((p, k) => closes[i0 + (k + 1) * GRID] / closes[i0 + k * GRID] - 1);
  const spyStats = statsOf(spySeries, spySeries.length);

  const variants = {
    ungated: { gate: () => true },
    macroGated: { gate: (p) => !p.riskOff, gated: true, available: !!macro },
    ivRvGated: { gate: (p) => p.ivrvOk, gated: true, available: true },
  };
  const results = {};
  for (const [name, v] of Object.entries(variants)) {
    if (v.available === false) { results[name] = { unavailable: true }; continue; }
    results[name] = { gross: variantSeries(periods, v.gate, false), net: variantSeries(periods, v.gate, true) };
  }

  console.log('— per-variant stats (gross | net of $12/contract round-trip haircut) —');
  for (const [name, r] of Object.entries(results)) {
    if (r.unavailable) { console.log(`  ${name.padEnd(18)} UNAVAILABLE (macro layer null)`); continue; }
    printStats(`${name} gross`, r.gross);
    printStats(`${name} net`, r.net);
  }
  printStats('SPY buy-and-hold', spyStats);

  // FROZEN lead criterion: ANY gated variant (gross) Sharpe > SPY Sharpe AND
  // that variant's worst period > −25% of collateral.
  const gatedNames = ['macroGated', 'ivRvGated'];
  const leads = gatedNames.filter((n) => {
    const g = results[n] && results[n].gross;
    return g && g.sharpe != null && spyStats.sharpe != null && g.sharpe > spyStats.sharpe && g.worstPct / 100 > WORST_FLOOR;
  });
  const promising = leads.length > 0;
  console.log(`FROZEN CRITERION → gated Sharpe > SPY Sharpe (${spyStats.sharpe}) with worst period > −25%: [${leads.join(', ') || 'none'}] ⇒ VERDICT ${promising ? 'promising-lead' : 'not-confirmed'}`);

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
  const metrics = { variants: results, spy: spyStats, leads, gridPeriods: periods.length, skippedNoVix, skippedNoExpiry, macroNull };
  const rec = EL.makeEvidenceRecord({
    hypothesisId: HYP_ID,
    datasetHash: `yahoo-spy-vix-${RANGE}:${crypto.createHash('sha256').update(JSON.stringify(periods)).digest('hex').slice(0, 16)}`,
    periodStart: periods[0].date, periodEnd: periods[periods.length - 1].exitDate,
    horizon: '30d',
    codeVersion,
    manifestHash: crypto.createHash('sha256').update(JSON.stringify(metrics)).digest('hex').slice(0, 16),
    metrics,
    verdict: promising ? 'pass-provisional' : 'not-confirmed',
    mode: 'exploratory',
    generatedAt: new Date().toISOString(),
    note: `The ONE registered exploratory pass (window now SPENT for ${HYP_ID}). Premiums are SYNTHETIC Black-Scholes with σ = VIX (no smile) — this UNDERSTATES real ATM-put premium, a conservative bias on the seller's take; but hold-to-expiry on daily closes has NO gap-risk realism, so left-tail severity is likewise understated. Risk-premium characterization, not an alpha claim; any confirmatory claim needs real option marks.`,
  });
  if (!rec.ok) { console.error('evidence record invalid:', rec.errors); process.exitCode = 1; return; }
  await EL.appendEvidence(deps, rec.record).then((r) => console.log(`evidence: ${r.reason} (${r.recordId}) → research/data/evidence/${HYP_ID}/`));
}

if (require.main === module) main();
module.exports = { blackScholesPut, realizedVol, normCdf, HYP_ID };

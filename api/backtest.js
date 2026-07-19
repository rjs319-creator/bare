// Strategy backtest — replays the elite screen across history and measures
// REALISTIC trade outcomes: ATR stop/target exits, return vs SPY (alpha),
// market-regime split, and walk-forward (in-sample vs out-of-sample) edge
// validation so the auto-derived High-Conviction combo isn't curve-fit.
const { fetchDailyHistory, evalSetupAt, smaAt, rsHighArray } = require('../lib/screener');
const { calcRSI, calcATR } = require('../lib/signal');
const { LARGE, SMALL_CAPS, MICRO_CAPS } = require('../lib/universe');
const { runGhostBacktest } = require('../lib/ghost-backtest');
const { planFill, POLICIES, EXECUTION_POLICY_VERSION } = require('../lib/execution-policy');
const { averageRanks } = require('../lib/rankquality');
const SM = require('../lib/security-master');

// Resolve the backtest universe. Default (pit off) is byte-identical to the legacy static list.
// With ?pit=1 the present-day list is AUGMENTED with delisted names the point-in-time security
// master knows were active at the window start — a PARTIAL de-survivorship. The result is STILL
// survivorship-unsafe (no late-listing/IPO feed, S&P-only delisting coverage), which the returned
// `pit` block states explicitly. `asOf` is a coarse calendar boundary at the window start (the
// master's delisting dates are calendar dates), not a purge — precision there is unnecessary.
async function resolvePitUniverse(baseList, months, enabled, scope) {
  const list = [...new Set(baseList)];
  if (!enabled) return { list, pit: { enabled: false } };
  // The ONLY point-in-time delisting source is the S&P-500 removal scrape (all large-cap), and the
  // security master carries no cap-tier field — so a died-since name cannot be attributed to a cap
  // band. Augmenting small/micro would inject large-cap names that were never in the band, making
  // the backtest LESS representative. Restrict de-survivorship to scope=large; other bands report
  // honestly that no cap-appropriate delisting coverage exists (universe left as the static list).
  if (scope !== 'large') {
    return { list, pit: { enabled: true, applied: false, scope, survivorshipSafe: false,
      note: `No point-in-time delisting coverage for the ${scope}-cap band — the only source is the `
        + `S&P-500 (large-cap) removal scrape and the security master has no cap-tier field, so `
        + `augmenting would inject large-cap names that were never ${scope}-cap. Universe left as the `
        + `present-day static list (survivorship-unsafe).` } };
  }
  const asOf = new Date(Date.now() - Math.round(months * 30.44 * 86400000)).toISOString().slice(0, 10);
  let master = null;
  try { master = await SM.loadMaster(); } catch { master = null; }
  if (!master || !master.records) {
    return { list, pit: { enabled: true, applied: false, built: false, asOf, survivorshipSafe: false,
      note: 'security master not built — universe fell back to the present-day static list (survivorship-unsafe)' } };
  }
  const aug = SM.pointInTimeAugment(master.records, list, asOf);
  return {
    list: aug.universe,
    pit: {
      enabled: true, applied: true, built: true, asOf, scope,
      securityMasterVersion: master.v, builtAt: master.builtAt,
      staticCount: aug.staticCount, addedDelisted: aug.addedCount,
      added: aug.added.slice(0, 50), addedFull: aug.added,   // addedFull for coverage counting (stripped from response)
      survivorshipSafe: false,
      note: 'Added back delisted names the security master knows were active at the window start '
        + '(S&P-500, large-cap, ≤5yr). Does NOT correct late-listing survivorship or non-S&P delistings — result remains survivorship-unsafe.',
    },
  };
}

const STEP = 5;          // sample every 5 trading days
const STOP_ATR = 1.5;    // stop = entry − 1.5·ATR
const TGT_ATR = 3.0;     // target = entry + 3·ATR  (1:2 reward:risk)
const MAX_HOLD = 20;     // time-stop after 20 trading days
const TIERS = ['Breakout', 'Setup', 'Early'];
// v2: entries fill at the NEXT session's open (+ entry-side slippage) instead of the
// signal-day close — the signal is only known after that close. Reported numbers moved with
// this bump; the execution policy is echoed in every response.
const BACKTEST_VERSION = 'backtest-exec-v2';
const tierForScope = (scope) => scope === 'micro' ? 'micro' : scope === 'small' ? 'small' : 'liquid';

// Simulate one long ATR stop/target trade with a realistic NEXT-OPEN entry. The signal is
// known at c[i].close; the fill is the next session's open (+ slippage). Barriers are scanned
// from the fill bar's OWN range onward (you hold from that open), stop checked before target
// on the same bar (conservative). Returns null when the trade cannot fill (e.g. the signal is
// on the last available bar) — a real backtest drops it rather than inventing a same-close fill.
function simAtrTrade(c, closes, highs, lows, atr, i, tier) {
  const fill = planFill(c, c[i].date, { policy: POLICIES.NEXT_OPEN_PLUS_SLIPPAGE, side: 'long', tier });
  if (!fill.filled || fill.fillIdx == null) return null;
  const fi = fill.fillIdx, last = c.length - 1;
  const entry = fill.fillPrice;
  const stop = entry - STOP_ATR * atr, target = entry + TGT_ATR * atr;
  let r = null, exitDate = null, hold = 0, won = false;
  for (let h = 0; h < MAX_HOLD && fi + h <= last; h++) {
    const j = fi + h; hold = h + 1;
    if (lows[j] <= stop) { r = (stop - entry) / entry; exitDate = c[j].date; won = false; break; }   // stop first (conservative)
    if (highs[j] >= target) { r = (target - entry) / entry; exitDate = c[j].date; won = true; break; }
  }
  if (r == null) { const j = Math.min(fi + MAX_HOLD - 1, last); r = (closes[j] - entry) / entry; exitDate = c[j].date; hold = j - fi + 1; won = r > 0; }
  return { fillDate: c[fi].date, entry, stop, target, r, exitDate, hold, won };
}

// One position's return on day D (prev day P), from close map cm. The fix for audit #6:
//   • fill day  (D == entryDate): from the MODELED fill price (open+slippage) to that day's close —
//     the fill-day open→close P&L the old close/prevClose MTM silently dropped.
//   • exit day  (D == exitDate):  from the prior close to the BARRIER exit price (entry·(1+r)), not
//     the day's close — so a stop/target that triggered intraday is realized at the barrier.
//   • middle days: close→close.
// These telescope: compounded over [entryDate, exitDate] they equal exactly the trade's realized r.
function positionDailyReturn(p, D, P, cm) {
  const cD = cm[D], cP = cm[P];
  const exitPrice = p.entry * (1 + p.r);
  const isEntry = D === p.entryDate, isExit = D === p.exitDate;
  if (isEntry && isExit) return p.entry > 0 ? exitPrice / p.entry - 1 : 0;   // same-bar fill+exit → r
  if (isEntry) return (p.entry > 0 && cD > 0) ? cD / p.entry - 1 : 0;        // fill open→close
  if (isExit) return cP > 0 ? exitPrice / cP - 1 : 0;                        // prevClose→barrier
  return (cD > 0 && cP > 0) ? cD / cP - 1 : 0;                               // close→close
}

// Daily-rebalanced equal-weight (1/maxPos) portfolio over accepted trades, with correct fill-day and
// barrier-exit accounting. Also self-reconciles: each fully-in-window position's standalone
// compounded daily path must equal its realized r (telescoping), reported as reconciliation.maxAbsError.
function simulatePortfolio(accepted, axis, closeMaps, maxPos) {
  let eq = 1, peak = 1, mdd = 0, exposSum = 0; const curve = [], dr = [];
  for (let k = 1; k < axis.length; k++) {
    const D = axis[k], P = axis[k - 1];
    const held = accepted.filter(p => p.entryDate <= D && p.exitDate >= D);   // include the FILL day
    let ret = 0;
    held.forEach(p => { const cm = closeMaps[p.name]; if (cm) ret += (1 / maxPos) * positionDailyReturn(p, D, P, cm); });
    eq *= (1 + ret); peak = Math.max(peak, eq); mdd = Math.min(mdd, (eq - peak) / peak);
    curve.push({ date: D, v: +eq.toFixed(4) }); dr.push(ret); exposSum += held.length / maxPos;
  }
  // Reconciliation: for positions whose whole span sits inside the axis, the compounded per-day path
  // must equal the trade-level realized r. Positions open past the window end are excluded (they are
  // honestly marked to the last close, not a future barrier).
  const axisSet = new Set(axis), first = axis[0];
  let maxAbsError = 0, checked = 0;
  for (const p of accepted) {
    const cm = closeMaps[p.name];
    if (!cm || !Number.isFinite(p.r) || p.entryDate === first || !axisSet.has(p.entryDate) || !axisSet.has(p.exitDate)) continue;
    let pe = 1;
    for (let k = 1; k < axis.length; k++) {
      const D = axis[k]; if (p.entryDate <= D && p.exitDate >= D) pe *= (1 + positionDailyReturn(p, D, axis[k - 1], cm));
    }
    maxAbsError = Math.max(maxAbsError, Math.abs((pe - 1) - p.r)); checked++;
  }
  return { eq, mdd, curve, dr, exposSum, reconciliation: { checked, maxAbsError: +maxAbsError.toExponential(2) } };
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  async function worker() { while (i < items.length) { const idx = i++; await fn(items[idx]); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const std = a => { const m = mean(a); return Math.sqrt(a.length ? a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length : 0); };
const optsFor = scope => scope === 'micro'
  ? { baseMax: 0.60, setupBelow: 0.18, earlyAbove: 0.15, moveMax: 0.70, setupHighGate: 0.55, setupMaGate: 0.88 }
  : scope === 'small'
  ? { baseMax: 0.45, setupBelow: 0.10, earlyAbove: 0.12, moveMax: 0.60, setupHighGate: 0.35, setupMaGate: 0.93 }
  : {};

async function fetchSPY() {
  const d = await fetchDailyHistory('SPY');
  if (!d) return null;
  const c = d.candles, closes = c.map(x => x.close), byDate = {};
  c.forEach((x, i) => { byDate[x.date] = { close: x.close, sma200: smaAt(closes, 200, i) }; });
  return { byDate };
}

// Realistic per-trade outcome stats for a set of trades.
function agg(ts) {
  const n = ts.length;
  if (!n) return { n: 0 };
  const wins = ts.filter(x => x.won), losses = ts.filter(x => !x.won);
  const sumWin = wins.reduce((a, x) => a + x.r, 0), sumLoss = Math.abs(losses.reduce((a, x) => a + x.r, 0));
  let eq = 1, peak = 1, mdd = 0;
  [...ts].sort((a, b) => a.date < b.date ? -1 : 1).forEach(x => { eq *= (1 + x.r); peak = Math.max(peak, eq); mdd = Math.min(mdd, (eq - peak) / peak); });
  return {
    n,
    winRate: Math.round((wins.length / n) * 100),
    avgReturn: +(mean(ts.map(x => x.r)) * 100).toFixed(2),
    avgAlpha: +(mean(ts.map(x => x.excess)) * 100).toFixed(2),
    profitFactor: sumLoss > 0 ? +(sumWin / sumLoss).toFixed(2) : (sumWin > 0 ? 99 : 0),
    avgWin: +(mean(wins.map(x => x.r)) * 100).toFixed(2),
    avgLoss: +(mean(losses.map(x => x.r)) * 100).toFixed(2),
    avgHold: +mean(ts.map(x => x.hold)).toFixed(1),
    maxDD: +(mdd * 100).toFixed(1),
  };
}

const FEATURES = [
  ['breakout', 'Confirmed breakout', x => x.tier === 'Breakout'],
  ['vcp',      'VCP contraction',    x => x.feat && x.feat.vcp],
  ['multi',    '2+ contractions',    x => x.feat && x.feat.contractions >= 2],
  ['pocket',   'Pocket pivot',       x => x.feat && x.feat.pocketPivot],
  ['obv',      'OBV rising',         x => x.feat && x.feat.obvRising],
  ['vdu',      'Volume dry-up',      x => x.feat && x.feat.volDryUp],
  ['ud',       'Up/Down vol ≥1.3',   x => x.feat && x.feat.udStrong],
  ['trend',    'Above 200-day MA',   x => x.feat && x.feat.trendUp],
  ['rs',       'RS line new high',   x => x.feat && x.feat.rsHigh],
  ['longbase', '7+ week base',       x => x.feat && x.feat.longBase],
];

// ── Regularized logistic regression (learns factor weights from history) ──
const MODEL_KEYS = ['breakout', 'rs', 'trend', 'obv', 'vcp', 'pocket', 'vdu', 'ud', 'longbase'];
const featVec = t => { const f = t.feat || {}; return [t.tier === 'Breakout' ? 1 : 0, f.rsHigh ? 1 : 0, f.trendUp ? 1 : 0, f.obvRising ? 1 : 0, f.vcp ? 1 : 0, f.pocketPivot ? 1 : 0, f.volDryUp ? 1 : 0, f.udStrong ? 1 : 0, f.longBase ? 1 : 0]; };
function trainLogistic(samples, { lr = 0.3, lam = 0.02, iters = 500 } = {}) {
  const D = MODEL_KEYS.length, N = samples.length || 1;
  let w = new Array(D).fill(0), b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(D).fill(0); let gb = 0;
    for (const s of samples) {
      let z = b; for (let j = 0; j < D; j++) z += w[j] * s.x[j];
      const p = 1 / (1 + Math.exp(-z)), e = p - s.y;
      for (let j = 0; j < D; j++) gw[j] += e * s.x[j];
      gb += e;
    }
    for (let j = 0; j < D; j++) w[j] -= lr * (gw[j] / N + lam * w[j]);
    b -= lr * (gb / N);
  }
  return { w, b };
}
// AUC via the Mann-Whitney U statistic with TIE CORRECTION: tied predictions must share the
// AVERAGE of their ranks, else many identical scores (common with binary-flag models) bias the
// AUC. Reuses lib/rankquality.averageRanks so there is one tie-handling implementation.
function aucRank(scored) {
  const np = scored.filter(s => s.y === 1).length;
  const nn = scored.length - np;
  if (!np || !nn) return 0.5;
  const ranks = averageRanks(scored.map(s => s.p));   // 1-based, tie-averaged
  let rankSum = 0;
  for (let i = 0; i < scored.length; i++) if (scored[i].y === 1) rankSum += ranks[i];
  return +(((rankSum - np * (np + 1) / 2) / (np * nn))).toFixed(3);
}

async function backtestMode(req, res) {
  const scope = (req.query.scope || 'large').toLowerCase();
  // Up to 54mo (matches walkforwardMode) so the window spans multiple regimes (audit #2) AND the
  // ?pit=1 as-of date reaches back into the security master's ≤5yr S&P delisting window, letting
  // real delisted names surface. Default stays 6mo, so normal traffic is unchanged.
  const months = Math.min(54, Math.max(3, parseInt(req.query.months, 10) || 6));
  const baseList = scope === 'micro' ? MICRO_CAPS : scope === 'small' ? SMALL_CAPS : LARGE;
  const { list, pit } = await resolvePitUniverse(baseList, months, req.query.pit === '1', scope);
  const opts = optsFor(scope);

  try {
    const spy = await fetchSPY();
    const spyClose = {}; if (spy) for (const d in spy.byDate) spyClose[d] = spy.byDate[d].close;
    const trades = [];   // { tier, date, r, excess, won, hold, regime, feat }
    let names = 0, instances = 0;
    // Data coverage of the re-added delisted names — quantifies the survivorship gap honestly
    // (a delisted name with no free candle data still cannot be traded, so we count it).
    const addedSet = new Set((pit && pit.addedFull) || []);
    let addedWithData = 0, addedNoData = 0;

    await mapLimit([...new Set(list)], 16, async (t) => {
      const data = await fetchDailyHistory(t);
      if (addedSet.has(t)) { if (data && data.candles && data.candles.length) addedWithData++; else addedNoData++; }
      if (!data) return;
      const c = data.candles, n = c.length;
      if (n < 180) return;
      const closes = c.map(x => x.close), highs = c.map(x => x.high), lows = c.map(x => x.low), vols = c.map(x => x.volume);
      const obv = new Array(n).fill(0);
      for (let k = 1; k < n; k++) obv[k] = obv[k - 1] + (closes[k] > closes[k - 1] ? vols[k] : closes[k] < closes[k - 1] ? -vols[k] : 0);
      const rsiArr = calcRSI(closes, 14);
      const atrArr = calcATR(c, 14);
      const nameOpts = { ...opts, rsHighArr: rsHighArray(closes, c.map(x => x.date), spyClose) };
      const last = n - 1;
      const startI = Math.max(60, last - Math.round(months * 21));
      let any = false;
      for (let i = startI; i <= last - 1; i += STEP) {
        const e = evalSetupAt(closes, highs, lows, vols, obv, rsiArr, i, nameOpts);
        if (!e.status) continue;
        const atr = atrArr[i];
        if (!atr || atr <= 0 || closes[i] <= 0) continue;

        // ── Simulate the trade with a realistic next-open entry (+ slippage) ──
        const sim = simAtrTrade(c, closes, highs, lows, atr, i, tierForScope(scope));
        if (!sim) continue;   // could not fill (signal on the last bar) — not a trade
        instances++; any = true;
        const { r, exitDate, hold, won, fillDate } = sim;

        // ── Benchmark (SPY from the FILL date over the holding window) → alpha ──
        let excess = r;
        const sE = spy && spy.byDate[fillDate], sX = spy && spy.byDate[exitDate];
        if (sE && sX && sE.close > 0) excess = r - (sX.close / sE.close - 1);
        // ── Regime at entry (SPY above/below its 200-DMA on the fill date) ──
        let regime = 'unknown';
        if (sE && sE.sma200 != null) regime = sE.close > sE.sma200 ? 'on' : 'off';

        trades.push({ tier: e.status, date: c[i].date, r, excess, won, hold, regime, feat: e.feat });
      }
      if (any) names++;
    });

    const summary = {};
    TIERS.forEach(t => { summary[t] = agg(trades.filter(x => x.tier === t)); });
    const overall = agg(trades);
    const regimeSplit = {
      on: agg(trades.filter(x => x.regime === 'on')),
      off: agg(trades.filter(x => x.regime === 'off')),
    };

    // ── Walk-forward edge validation (alpha lift, in-sample → out-of-sample) ──
    const sorted = [...trades].sort((a, b) => a.date < b.date ? -1 : 1);
    const cut = Math.floor(sorted.length * 0.6);
    const IS = sorted.slice(0, cut), OOS = sorted.slice(cut);
    const baseIS = mean(IS.map(x => x.excess)), baseOOS = mean(OOS.map(x => x.excess));
    const efficacy = {
      metric: 'alpha',
      baseline: { is: +(baseIS * 100).toFixed(2), oos: +(baseOOS * 100).toFixed(2), n: trades.length, isN: IS.length, oosN: OOS.length },
      splitDate: OOS.length ? OOS[0].date : null,
      features: FEATURES.map(([key, label, fn]) => {
        const isS = IS.filter(fn), oosS = OOS.filter(fn);
        const isLift = +((mean(isS.map(x => x.excess)) - baseIS) * 100).toFixed(2);
        const oosLift = +((mean(oosS.map(x => x.excess)) - baseOOS) * 100).toFixed(2);
        const oosWin = oosS.length ? Math.round((oosS.filter(x => x.won).length / oosS.length) * 100) : 0;
        return { key, label, isN: isS.length, oosN: oosS.length, isLift, oosLift, oosWin, robust: isLift > 0 && oosLift > 0 && oosS.length >= 30 };
      }).filter(f => f.isN >= 30).sort((a, b) => b.oosLift - a.oosLift),
    };

    // ── Learned factor model: train on in-sample, validate out-of-sample ──
    let model = null;
    if (IS.length >= 100 && OOS.length >= 50) {
      const isS = IS.map(t => ({ x: featVec(t), y: t.excess > 0 ? 1 : 0 }));
      const oosS = OOS.map(t => ({ x: featVec(t), y: t.excess > 0 ? 1 : 0, excess: t.excess }));
      const lr = trainLogistic(isS);
      const predict = x => { let z = lr.b; for (let j = 0; j < x.length; j++) z += lr.w[j] * x[j]; return 1 / (1 + Math.exp(-z)); };
      const scored = oosS.map(s => ({ p: predict(s.x), y: s.y, excess: s.excess })).sort((a, b) => b.p - a.p);
      const half = Math.floor(scored.length / 2);
      model = {
        features: MODEL_KEYS,
        weights: lr.w.map(v => +v.toFixed(3)),
        bias: +lr.b.toFixed(3),
        oosAUC: aucRank(scored),
        oosTopAlpha: +(mean(scored.slice(0, half).map(s => s.excess)) * 100).toFixed(2),
        oosBotAlpha: +(mean(scored.slice(half).map(s => s.excess)) * 100).toFixed(2),
        n: isS.length, oosN: oosS.length,
      };
    }

    // Finalize the point-in-time universe report with delisted-name data coverage.
    let pitOut = pit;
    if (pit && pit.enabled) {
      const { addedFull, ...rest } = pit;   // strip the internal full list from the response
      pitOut = pit.built ? { ...rest, addedWithData, addedNoData } : rest;
    }

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.json({
      scope, months, names, instances,
      universe: { source: pit && pit.applied ? 'point-in-time (augmented)' : 'present-day static', size: [...new Set(list)].length, survivorshipSafe: false },
      pit: pitOut,
      exits: { stopATR: STOP_ATR, targetATR: TGT_ATR, maxHold: MAX_HOLD },
      execution: { policy: POLICIES.NEXT_OPEN_PLUS_SLIPPAGE, entry: 'next-open+slippage', tier: tierForScope(scope), policyVersion: EXECUTION_POLICY_VERSION },
      version: BACKTEST_VERSION,
      summary, overall, regimeSplit, efficacy, model,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(502).json({ error: 'Backtest failed: ' + e.message });
  }
}

// Portfolio simulation — top-N concurrent equal-weight positions, daily MTM, vs SPY.
async function portfolioMode(req, res) {
  const scope = (req.query.scope || 'large').toLowerCase();
  const months = Math.min(54, Math.max(3, parseInt(req.query.months, 10) || 6));   // see backtestMode
  const baseList = scope === 'micro' ? MICRO_CAPS : scope === 'small' ? SMALL_CAPS : LARGE;
  const { list, pit } = await resolvePitUniverse(baseList, months, req.query.pit === '1', scope);
  const opts = optsFor(scope);
  const maxPos = scope === 'large' ? 10 : 6;
  const TIER_RANK = { Breakout: 0, Setup: 1, Early: 2 };

  try {
    const spy = await fetchDailyHistory('SPY');
    if (!spy) return res.status(502).json({ error: 'Benchmark unavailable' });
    const spyC = spy.candles, spyClose = {};
    spyC.forEach(x => { spyClose[x.date] = x.close; });
    const sLast = spyC.length - 1, sStart = Math.max(1, sLast - Math.round(months * 21));
    const axis = spyC.slice(sStart).map(x => x.date);
    const startDate = axis[0];

    const entries = [], closeMaps = {};
    await mapLimit([...new Set(list)], 16, async (t) => {
      const data = await fetchDailyHistory(t);
      if (!data) return;
      const c = data.candles, n = c.length;
      if (n < 180) return;
      const closes = c.map(x => x.close), highs = c.map(x => x.high), lows = c.map(x => x.low), vols = c.map(x => x.volume);
      const obv = new Array(n).fill(0);
      for (let k = 1; k < n; k++) obv[k] = obv[k - 1] + (closes[k] > closes[k - 1] ? vols[k] : closes[k] < closes[k - 1] ? -vols[k] : 0);
      const rsiArr = calcRSI(closes, 14), atrArr = calcATR(c, 14);
      const nlast = n - 1, s0 = Math.max(60, nlast - Math.round(months * 21));
      const cm = {}; c.forEach(x => { cm[x.date] = x.close; }); closeMaps[t] = cm;
      for (let i = s0; i <= nlast - 1; i += STEP) {
        if (c[i].date < startDate) continue;
        const e = evalSetupAt(closes, highs, lows, vols, obv, rsiArr, i, opts);
        if (!e.status) continue;
        const atr = atrArr[i];
        if (!atr || atr <= 0 || closes[i] <= 0) continue;
        // Next-open entry: the position is HELD from the fill date (day after the signal), and
        // its exit date comes from the same ATR stop/target scan off the realistic entry.
        const sim = simAtrTrade(c, closes, highs, lows, atr, i, tierForScope(scope));
        if (!sim) continue;
        entries.push({ name: t, entryDate: sim.fillDate, exitDate: sim.exitDate, tier: e.status, entry: sim.entry, r: sim.r });
      }
    });

    entries.sort((a, b) => a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : (TIER_RANK[a.tier] - TIER_RANK[b.tier]));
    const accepted = [];
    for (const e of entries) { if (accepted.filter(p => p.exitDate > e.entryDate).length < maxPos) accepted.push(e); }

    const port = simulatePortfolio(accepted, axis, closeMaps, maxPos);
    const { eq, mdd, curve, dr, exposSum } = port;
    let seq = 1, speak = 1, smdd = 0; const scurve = [], sdr = [];
    for (let k = 1; k < axis.length; k++) {
      const D = axis[k], P = axis[k - 1], cD = spyClose[D], cP = spyClose[P];
      const r = (cD > 0 && cP > 0) ? cD / cP - 1 : 0;
      seq *= (1 + r); speak = Math.max(speak, seq); smdd = Math.min(smdd, (seq - speak) / speak);
      scurve.push({ date: D, v: +seq.toFixed(4) }); sdr.push(r);
    }

    const ann = 252, nDays = dr.length || 1;
    const sharpe = a => { const s = std(a); return s > 0 ? +(mean(a) / s * Math.sqrt(ann)).toFixed(2) : 0; };
    const cagr = eqv => +((Math.pow(Math.max(0.01, eqv), ann / nDays) - 1) * 100).toFixed(1);
    const sample = arr => { const step = Math.max(1, Math.ceil(arr.length / 120)); return arr.filter((_, i) => i % step === 0 || i === arr.length - 1); };

    const pitOut = pit && pit.enabled ? (({ addedFull, ...rest }) => rest)(pit) : pit;
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.json({
      scope, months, maxPos, trades: accepted.length, signals: entries.length,
      universe: { source: pit && pit.applied ? 'point-in-time (augmented)' : 'present-day static', size: [...new Set(list)].length, survivorshipSafe: false },
      pit: pitOut,
      execution: { policy: POLICIES.NEXT_OPEN_PLUS_SLIPPAGE, entry: 'next-open+slippage', tier: tierForScope(scope), policyVersion: EXECUTION_POLICY_VERSION },
      version: BACKTEST_VERSION,
      stats: {
        totalReturn: +((eq - 1) * 100).toFixed(1), cagr: cagr(eq), sharpe: sharpe(dr), maxDD: +(mdd * 100).toFixed(1), exposure: +(exposSum / nDays * 100).toFixed(0),
        spyReturn: +((seq - 1) * 100).toFixed(1), spyCagr: cagr(seq), spySharpe: sharpe(sdr), spyMaxDD: +(smdd * 100).toFixed(1),
      },
      accounting: { entry: 'fill-day open→close included; barrier exits realized at the stop/target price (not the close)', reconciliation: port.reconciliation },
      curve: sample(curve), spyCurve: sample(scurve),
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(502).json({ error: 'Portfolio failed: ' + e.message });
  }
}

// Purged walk-forward harness — validates GAI's price-pillar core (rank-IC, OOS).
// ?insider=1 loads the cached EDGAR history so the IN pillar is tested too;
// ?limit=N restricts to the first N names (used for the insider pilot universe).
async function walkforwardMode(req, res) {
  const scope = (req.query.scope || 'large').toLowerCase();
  // Up to 54mo (5y history) so a multi-year window spans risk-off regimes (2022)
  // and the regime gate can actually be tested; defaults to 12 for the quick run.
  const months = Math.min(54, Math.max(3, parseInt(req.query.months, 10) || 12));
  const step = Math.min(21, Math.max(5, parseInt(req.query.step, 10) || 10));
  const limit = Math.max(0, parseInt(req.query.limit, 10) || 0);
  let insiderData = null, fundamentalsData = null;
  if (req.query.insider === '1') {
    try { const doc = await require('../lib/store').readInsider(); insiderData = (doc && doc.tickers && Object.keys(doc.tickers).length) ? doc.tickers : null; } catch {}
  }
  if (req.query.fundamentals === '1') {
    try { const doc = await require('../lib/store').readFundamentals(); fundamentalsData = (doc && doc.tickers && Object.keys(doc.tickers).length) ? doc.tickers : null; } catch {}
  }
  try {
    const out = await runGhostBacktest({ scope, months, step, limit, insiderData, fundamentalsData });
    res.setHeader('Cache-Control', (insiderData || fundamentalsData) ? 'no-store' : 's-maxage=3600, stale-while-revalidate=86400');
    return res.json(out);
  } catch (e) {
    return res.status(502).json({ error: 'Walk-forward failed: ' + e.message });
  }
}

module.exports = function handler(req, res) {
  if (req.query.mode === 'walkforward') return walkforwardMode(req, res);
  return (req.query.mode === 'portfolio') ? portfolioMode(req, res) : backtestMode(req, res);
};
// Exposed for tests — the next-open trade simulator and version marker.
module.exports.simAtrTrade = simAtrTrade;
module.exports.resolvePitUniverse = resolvePitUniverse;
module.exports.simulatePortfolio = simulatePortfolio;
module.exports.positionDailyReturn = positionDailyReturn;
module.exports.BACKTEST_VERSION = BACKTEST_VERSION;
module.exports.STOP_ATR = STOP_ATR;
module.exports.TGT_ATR = TGT_ATR;

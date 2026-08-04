'use strict';
// SCREENER REPLAY v3 — date-first historical replay of the EXACT production
// swing selection (lib/swing-screener-engine.js), with executable next-open
// economics. This is the production-parity harness the legacy /api/backtest
// (stamped historicalLiveParity:false) could never be.
//
// REPLAY ORDER (per decision date):
//   1. resolve point-in-time membership: tickers whose history reaches the date
//   2. choose the common historical decision session (a benchmark bar date)
//   3. slice every series to bars ≤ that session (nothing later is observable)
//   4. build the ENTIRE contemporaneous cohort (selected + rejected + near-miss
//      + deterministic controls)
//   5. call the SHARED production feature engine (lib/screener.screenTicker)
//   6-8. apply the SHARED production missingness/freshness/liquidity/gate/regime
//      rules, same-date same-scope percentiles, score + buffer cap + dedup —
//      all inside lib/swing-screener-engine.selectCandidates
//   9. preserve candidate-set hashes + rejection counts
//  10. enter ONLY at the next session's open through the execution engine
//      (lib/execution-policy NEXT_OPEN_PLUS_SLIPPAGE — the signal-day close is
//      never an executable fill)
//  11. model gap-through stops (stop checked before target on the fill bar,
//      conservative), slippage/spread/commission and participation limits via
//      lib/research/execution (base, doubled-cost and stressed-liquidity nets)
//  12. grade raw + SPY-excess, hit rate, target-before-stop, MAE, MFE and
//      cost-net at 5/10/21/63 sessions
//
// KNOWN REPLAY LIMITATION (stated, never imputed): the live macro overlay
// (VIX/credit risk-off) has no point-in-time history here, so replay runs with
// `macroRiskOff:false` unless the caller supplies a PIT series. The regime gate
// (SPY 200-DMA + breadth) IS replayed exactly. Any parity comparison against a
// live run must feed both sides the same macro input.

const { screenTicker } = require('./screener');
const ENGINE = require('./swing-screener-engine');
const { candidateId, candidateSetHash, makeObservation, REJECT } = require('./swing-candidate-schema');
const { planFill, POLICIES, EXECUTION_POLICY_VERSION } = require('./execution-policy');
const EXEC = require('./research/execution');

const REPLAY_VERSION = 'swing-replay-v3';
const HORIZONS = [5, 10, 21, 63];
const STRATEGY_ID = 'screener';
const SCORING_VERSION = 'screener-v1';
const CONTROL_EVERY = 7;   // deterministic control sample: every 7th non-admitted cohort name

const tierForScope = (scope) => scope === 'micro' ? 'micro' : (scope === 'small' || scope === 'expanded') ? 'small' : scope === 'biotech' ? 'biotech' : 'liquid';

// Ascending-bars helper (candles must be oldest→newest for the engine).
function sliceAsOf(candles, decisionDate) {
  let hi = -1;
  for (let i = candles.length - 1; i >= 0; i--) { if (candles[i].date <= decisionDate) { hi = i; break; } }
  return hi >= 0 ? candles.slice(0, hi + 1) : [];
}

// 20-session average dollar volume at the decision bar (for participation limits).
function advAt(candles) {
  const n = candles.length;
  let s = 0, c = 0;
  for (let i = Math.max(0, n - 20); i < n; i++) { s += (candles[i].close || 0) * (candles[i].volume || 0); c++; }
  return c ? s / c : 0;
}

// Plan-path grading from the FILL bar: stop-before-target on the same bar
// (conservative), MAE/MFE relative to the fill over the horizon window.
function planPath(candles, fillIdx, fillPrice, stop, target, horizon) {
  const last = candles.length - 1;
  let mae = 0, mfe = 0, targetBeforeStop = null, exit = null;
  for (let h = 0; h <= horizon && fillIdx + h <= last; h++) {
    const b = candles[fillIdx + h];
    mae = Math.min(mae, b.low / fillPrice - 1);
    mfe = Math.max(mfe, b.high / fillPrice - 1);
    if (exit == null) {
      if (stop != null && b.low <= stop) { targetBeforeStop = false; exit = { idx: fillIdx + h, price: stop, kind: 'stop' }; }
      else if (target != null && b.high >= target) { targetBeforeStop = true; exit = { idx: fillIdx + h, price: target, kind: 'target' }; }
    }
  }
  return { mae: +mae.toFixed(4), mfe: +mfe.toFixed(4), targetBeforeStop, exit };
}

// Replay ONE decision session for ONE scope. dataset: Map ticker→{candles asc, meta};
// spyCandles: ascending benchmark bars covering the window.
function replayDate({ dataset, spyCandles, decisionDate, scope = 'large', macroRiskOff = false, weights } = {}) {
  const spySlice = sliceAsOf(spyCandles, decisionDate);
  if (!spySlice.length || spySlice[spySlice.length - 1].date !== decisionDate) {
    return { ok: false, decisionDate, error: 'decision date is not a benchmark session' };
  }
  const spyByDate = {};
  spySlice.forEach(x => { spyByDate[x.date] = x.close; });
  const cfg = ENGINE.SCOPE_CONFIG[scope] || ENGINE.SCOPE_CONFIG.large;
  const baseOpts = { gate: 'relaxed', ...cfg.screenOpts, spyByDate };

  // 3-5. Point-in-time snapshot of every member whose history reaches the date.
  const rows = [];
  const membership = { evaluated: 0, insufficientHistory: 0 };
  for (const [ticker, v] of dataset) {
    const pit = sliceAsOf(v.candles, decisionDate);
    if (pit.length < 60) { membership.insufficientHistory++; continue; }
    const r = screenTicker(pit, { ...(v.meta || {}), symbol: ticker }, baseOpts);
    if (!r) { membership.insufficientHistory++; continue; }
    if (!r.ticker) r.ticker = ticker;
    r.lastBarDate = pit[pit.length - 1].date;
    r._pitLen = pit.length;
    rows.push(r);
    membership.evaluated++;
  }

  // 6-8. The SHARED selection. `now` = the evening after the decision session's
  // close, so the freshness gate resolves that session as authoritative.
  const now = new Date(decisionDate + 'T23:59:00Z');
  const sel = ENGINE.selectCandidates({ rows, scope, spyCandles: spySlice, macroRiskOff, now, ...(weights ? { weights } : {}) });

  // 9. Observations + candidate-set hash. Buffer names beyond the display cap are
  // near-misses; a deterministic 1-in-N sample of non-admitted names is the control.
  const idOf = (t) => candidateId({ strategyId: STRATEGY_ID, scoringVersion: SCORING_VERSION, universeScope: scope, ticker: t, decisionCutoff: decisionDate });
  const observations = [];
  const obsCommon = (c) => ({
    strategyId: STRATEGY_ID, scoringVersion: SCORING_VERSION, universeScope: scope,
    ticker: c.ticker, decisionCutoff: decisionDate,
    decisionPrice: c.price, sector: c.sector || null,
    features: { pct: c.pct || null, quant: c.quant || null, factors: c.factors || null, metrics: c.metrics ? { accumRatio: c.metrics.accumRatio, udVol: c.metrics.udVol, pivot: c.metrics.pivot } : null },
    missing: [
      ...(c.metrics && c.metrics.rsVsSpy63 != null ? [] : ['rsVsSpy63']),
      ...(c.factors && c.factors.dollarVol != null ? [] : ['dollarVol']),
    ],
    plan: c.levels ? { entry: c.levels.entry, stop: c.levels.stop, target: c.levels.target, rr: c.levels.rr } : null,
    rankScore: c.quant ? c.quant.score : null,
    regime: sel.regime ? (sel.regime.bearish ? 'risk-off' : sel.regime.riskOn ? 'risk-on' : 'neutral') : null,
    sourceFreshness: { lastBarDate: c.lastBarDate, class: 'current' },
    modelVersions: { engineVersion: ENGINE.ENGINE_VERSION, replayVersion: REPLAY_VERSION, executionPolicyVersion: EXECUTION_POLICY_VERSION },
  });
  sel.candidates.forEach((c, i) => {
    observations.push(makeObservation({ ...obsCommon(c), status: i < sel.cap ? 'selected' : 'near-miss', displayed: i < sel.cap, displayRank: i + 1 }));
  });
  const selectedTickers = new Set(sel.candidates.map(c => c.ticker));
  const rejByTicker = new Map(sel.rejections.filter(r => r.ticker).map(r => [r.ticker, r]));
  let ci = 0;
  for (const c of sel.cohort) {
    if (selectedTickers.has(c.ticker)) continue;
    const rej = rejByTicker.get(c.ticker);
    observations.push(makeObservation({ ...obsCommon(c), status: 'rejected', rejectionCode: (rej && rej.reason) || REJECT.NO_QUALIFYING_SETUP }));
    if ((ci++ % CONTROL_EVERY) === 0) observations.push(makeObservation({ ...obsCommon(c), status: 'control', evidenceClass: 'RESEARCH' }));
  }

  // 10-12. Executable next-open economics for the DISPLAYED candidates.
  const trades = [];
  for (const c of sel.candidates.slice(0, sel.cap)) {
    const v = dataset.get(c.ticker);
    if (!v) continue;
    const bars = v.candles;   // FULL series — outcomes may look forward; features never did
    const dIdx = bars.findIndex(b => b.date === decisionDate);
    if (dIdx < 0) continue;
    const fill = planFill(bars, decisionDate, { policy: POLICIES.NEXT_OPEN_PLUS_SLIPPAGE, side: 'long', tier: tierForScope(scope) });
    if (!fill.filled || fill.fillIdx == null) {
      trades.push({ ticker: c.ticker, candidateId: idOf(c.ticker), filled: false, reason: fill.reason || 'no-fill' });
      continue;
    }
    const adv = advAt(bars.slice(0, dIdx + 1));
    // The research execution engine keys sessions off epoch ms — derive once.
    const barsMs = bars.map(b => ({ ...b, ms: Date.parse(b.date + 'T00:00:00Z') }));
    const horizons = {};
    for (const H of HORIZONS) {
      const spyD = spyByDateForward(spyCandles, decisionDate, H);
      const eo = EXEC.executableOutcome({ bars: barsMs, decisionIdx: dIdx, horizonSessions: H, adv });
      const path = planPath(bars, fill.fillIdx, fill.fillPrice, c.levels ? c.levels.stop : null, c.levels ? c.levels.target : null, H);
      // Engine convention: horizon counts from the DECISION session (entry at the
      // open of d+1, exit at the close of d+H) — mirrored for raw/excess.
      const exitIdx = dIdx + H <= bars.length - 1 ? dIdx + H : null;
      const raw = exitIdx != null ? bars[exitIdx].close / fill.fillPrice - 1 : null;
      horizons[H] = {
        status: eo.status,
        raw: raw != null ? +raw.toFixed(4) : null,
        excess: (raw != null && spyD != null) ? +(raw - spyD).toFixed(4) : null,
        netBase: eo.netBase ?? null, netDoubled: eo.netDoubled ?? null, netStressed: eo.netStressed ?? null,
        mae: path.mae, mfe: path.mfe, targetBeforeStop: path.targetBeforeStop,
      };
    }
    trades.push({
      ticker: c.ticker, candidateId: idOf(c.ticker), filled: true,
      fillDate: bars[fill.fillIdx] ? bars[fill.fillIdx].date : null,
      fillPrice: fill.fillPrice, fillReason: fill.fillReason || null,
      rankScore: c.quant.score, horizons,
    });
  }

  return {
    ok: true, version: REPLAY_VERSION, engineVersion: ENGINE.ENGINE_VERSION,
    decisionDate, scope,
    membership,
    counts: {
      cohort: sel.cohort.length, selected: Math.min(sel.cap, sel.candidates.length),
      nearMiss: Math.max(0, sel.candidates.length - sel.cap),
      rejected: sel.rejections.filter(r => r.ticker).length,
      controls: observations.filter(o => o.status === 'control').length,
    },
    rejectionCounts: sel.rejections.reduce((m, r) => { m[r.reason] = (m[r.reason] || 0) + 1; return m; }, {}),
    regime: sel.regime,
    candidateIds: sel.candidates.slice(0, sel.cap).map(c => idOf(c.ticker)),
    candidateSetHash: candidateSetHash(sel.candidates.slice(0, sel.cap).map(c => idOf(c.ticker))),
    freshness: sel.freshness,
    observations, trades,
  };
}

// SPY benchmark leg under the SAME entry basis: open of the session after the
// decision date → close of decision+H (mirrors executableOutcome's convention).
function spyByDateForward(spyCandles, decisionDate, H) {
  const i = spyCandles.findIndex(b => b.date === decisionDate);
  if (i < 0 || i + H > spyCandles.length - 1 || !spyCandles[i + 1]) return null;
  const a = spyCandles[i + 1], b = spyCandles[i + H];
  return (a && b && a.open > 0) ? b.close / a.open - 1 : null;
}

// Date-first multi-session replay.
function runReplay({ dataset, spyCandles, decisionDates = [], scope = 'large', macroRiskOff = false, weights } = {}) {
  const sessions = [];
  for (const d of decisionDates) {
    sessions.push(replayDate({ dataset, spyCandles, decisionDate: d, scope, macroRiskOff, weights }));
  }
  return { version: REPLAY_VERSION, scope, sessions };
}

module.exports = { REPLAY_VERSION, HORIZONS, STRATEGY_ID, SCORING_VERSION, sliceAsOf, replayDate, runReplay, planPath };

'use strict';
// EVOLVE — OMEGA EVIDENCE VIEW-MODEL  (§20 / §16 evidence panel)
//
// Pure, dependency-light summarizer that turns the heavy op=evolveomegawf walk-forward
// payload into a small, render-ready view model: overall verdict, champion-vs-challenger,
// per-horizon rank-IC, sample-independence (uniqueness), the deflated-Sharpe / multiple-
// testing grid, calibration, and the PRE-REGISTERED promotion decision.
//
// The frontend (public/js/evolve-evidence.js) renders this object verbatim — it holds no
// summarization logic of its own, so the "does the challenger beat the champion?" decision
// lives in ONE place and is unit-tested here (not re-derived in the browser).
//
// Honest by construction: the promotion decision is the walk-forward's own pre-registered
// ship criterion (≥3 OOS blocks, all positive, mean OOS IC > margin). A failing or
// insufficient run reports "incumbent retained" plainly — never a manufactured pass.

const HORIZONS = ['fast', 'swing', 'position'];
const HORIZON_LABEL = { fast: 'Fast · 5d', swing: 'Swing · 21d', position: 'Position · 63d' };

const CHAMPION = 'evolve-core-v1';
const CHALLENGER = 'evolve-omega-v2';

// Overall-verdict presentation. Codes come straight from evolve-walkforward.verdictOf.
const VERDICT_META = {
  'edge-holds-oos': { tone: 'pass', label: 'Edge holds out-of-sample',
    plain: 'The challenger clears the pre-registered purged/embargoed ship criterion. Promotion is justified — pending the same read on the live ledger.' },
  'no-edge': { tone: 'fail', label: 'No durable edge',
    plain: 'Purged out-of-sample mean rank-IC is ≤ 0. The selection signal does not survive a full-cycle, leakage-controlled test. Incumbent retained — abstention is the correct output.' },
  'inconclusive': { tone: 'warn', label: 'Inconclusive',
    plain: 'A weak positive that does not clear the ship margin across enough blocks. Not promotable on this evidence; keep accruing.' },
  'insufficient': { tone: 'muted', label: 'Insufficient sample',
    plain: 'Too few distinct, resolved prediction dates to run a defensible purged walk-forward yet. No claim either way.' },
};

const round4 = (x) => (x == null ? null : +Number(x).toFixed(4));
const ratioPlain = (r) => {
  if (r == null) return 'sample independence not yet measurable';
  if (r >= 0.97) return 'labels barely overlap — the sample is nearly fully independent';
  return `only ~${Math.round(r * 100)}% of the raw labels are independent (the rest is temporal double-counting)`;
};

// One horizon's row. `wf` is byHorizon[h].purged; `u` is byHorizon[h].uniqueness.
function horizonRow(h, block) {
  const wf = (block && block.purged) || {};
  const u = (block && block.uniqueness) || {};
  return {
    horizon: h,
    label: HORIZON_LABEL[h] || h,
    n: block ? block.n : 0,
    meanOOS: round4(wf.meanOOS),
    testedBlocks: wf.testedBlocks ?? 0,
    positiveBlocks: wf.positiveBlocks ?? 0,
    brier: round4(wf.brier),
    passed: !!wf.passed,
    verdict: block ? block.verdict : 'insufficient',
    effectiveN: u.effectiveN ?? null,
    rawN: u.rawN ?? null,
  };
}

// The champion-vs-challenger block. The "challenger" IS the purged/embargoed EVOLVE read;
// the "leaky" run is the naive un-purged baseline, shown so the leakage the rigor removes is
// a measured number, not an assertion. Promotion follows the walk-forward's own `passed`.
function championChallenger(payload) {
  const pooled = payload.pooled || {};
  const purged = pooled.purged || {};
  const leaky = pooled.leaky || {};
  const promote = !!purged.passed;
  return {
    champion: CHAMPION,
    challenger: CHALLENGER,
    purgedMeanIC: round4(purged.meanOOS),
    leakyMeanIC: round4(leaky.meanOOS),
    leakageInflation: round4(pooled.leakageInflation),
    testedBlocks: purged.testedBlocks ?? 0,
    positiveBlocks: purged.positiveBlocks ?? 0,
    brier: round4(purged.brier),
    promote,
    decision: promote
      ? `${CHALLENGER} clears the frozen criterion — promotion over ${CHAMPION} is justified.`
      : `${CHALLENGER} does not clear the frozen criterion — ${CHAMPION} retained as champion.`,
  };
}

// The deflated-Sharpe / multiple-testing summary. The best cell is the highest raw per-trade
// Sharpe (grid rows arrive sorted desc); it is judged against E[max Sharpe | null] across all
// trials, so "best of many tried" is not mistaken for skill.
function dsrSummary(payload) {
  const g = payload.deflatedSharpe || {};
  const cells = Array.isArray(g.cells) ? g.cells : [];
  const best = cells[0] || null;
  return {
    trials: g.trials ?? 0,
    expectedMaxNull: round4(g.expectedMaxSharpeNull),
    passing: g.passing ?? 0,
    survivors: g.survivors || [],
    verdict: g.verdict || 'insufficient-grid',
    passDSR: g.passDSR ?? null,
    bestCell: best
      ? { specialist: best.specialist, regime: best.regime, horizon: best.horizon, sr: best.sr, n: best.n, dsr: best.dsr ?? null, pass: !!best.pass }
      : null,
    plain: (g.passing ?? 0) > 0
      ? `${g.passing} of ${g.trials ?? 0} specialist×regime×horizon cells survive the multiple-testing bar (DSR ≥ ${g.passDSR}). Only these are TRADE-eligible.`
      : `0 of ${g.trials ?? 0} cells survive multiple-testing. The best cell's Sharpe (${best ? best.sr : '–'}) sits below what the max of ${g.trials ?? 0} random trials would produce (${round4(g.expectedMaxSharpeNull)}). No cell earns a live TRADE weight.`,
  };
}

// Build the full render-ready evidence view from an op=evolveomegawf payload.
// `payload` is the object returned by runEvolveOmegaWalkForward (already spread under ok:true).
function buildEvidenceView(payload) {
  if (!payload || payload.ok === false) {
    return { available: false, note: (payload && payload.note) || 'Walk-forward evidence unavailable.' };
  }
  const code = payload.verdict || 'insufficient';
  const vmeta = VERDICT_META[code] || VERDICT_META.insufficient;
  const uni = payload.uniqueness || {};
  const byHorizon = payload.byHorizon || {};
  const cc = championChallenger(payload);

  return {
    available: true,
    version: payload.version || null,
    verdict: { code, label: vmeta.label, tone: vmeta.tone, plain: vmeta.plain },
    championChallenger: cc,
    horizons: HORIZONS.map((h) => horizonRow(h, byHorizon[h])),
    uniqueness: {
      rawN: uni.rawN ?? null,
      effectiveN: uni.effectiveN ?? null,
      ratio: uni.uniquenessRatio ?? null,
      plain: ratioPlain(uni.uniquenessRatio),
    },
    dsr: dsrSummary(payload),
    calibration: { brier: round4((payload.pooled && payload.pooled.purged && payload.pooled.purged.brier)) },
    promotion: {
      criterion: `≥3 out-of-sample blocks, ALL positive, mean OOS rank-IC > ${round4(payload.margin) ?? 0.02} (pre-registered, same bar as ghost-backtest).`,
      promote: cc.promote,
      decision: cc.decision,
    },
    meta: {
      range: payload.range || null,
      embargo: payload.embargo ?? null,
      weighted: !!payload.weighted,
      events: payload.events ?? 0,
      generatedAt: payload.generatedAt || null,
      regimeComposition: payload.regimeComposition || {},
      scope: payload.scope || null,
    },
  };
}

module.exports = { buildEvidenceView, HORIZONS, HORIZON_LABEL, CHAMPION, CHALLENGER, VERDICT_META };

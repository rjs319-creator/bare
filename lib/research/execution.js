'use strict';
// EXECUTION ENGINE (exec-engine-v1) — the common executable-economics layer.
//
// THE DEFECT THIS CLOSES: economic viability was previously arguable from the
// signal-day CLOSE (not tradable: the signal forms after that close) and
// costEvidenceCheck accepted ANY caller-supplied positive numbers as
// "measured". This engine defines the executable label and produces
// SELF-VERIFIABLE cost-evidence artifacts (content-hashed) that the harness
// can check — arbitrary numbers without an engine artifact can never pass.
//
// Executable label contract:
//   * signal is formed after the decision session's close;
//   * entry at the NEXT tradable session's OPEN (gap-through recorded);
//   * exit at the close of the session `horizon` sessions after the decision bar
//     (same horizon end as the statistical label, different entry);
//   * raw open/high/low/close preserved on the result;
//   * spread + slippage by liquidity (ADV) tier, market-impact participation
//     guard, commissions;
//   * no_fill when no next session exists (or the next bar is malformed);
//   * gross and net stored separately; base-cost, doubled-cost and
//     stressed-liquidity variants all recorded.
//
// The statistical close-to-close label remains valid for rank-IC when clearly
// labeled; PROMOTION/economic gates must consume THIS label.
//
// Pure module: no network, no clock, no fs.

const crypto = require('crypto');

const EXEC_ENGINE_VERSION = 'exec-engine-v1';
const ENTRY_BASIS = 'next-session-open';
const DEFAULT_COMMISSION_BPS = 1;      // per side
const DEFAULT_NOTIONAL_USD = 10000;
const MAX_PARTICIPATION = 0.02;        // of ADV per session

// Liquidity tiers (ADV in USD): half-spread and slippage in bps, per side.
const LIQUIDITY_TIERS = Object.freeze([
  { minAdv: 50e6, name: 'large', halfSpreadBps: 2, slippageBps: 3 },
  { minAdv: 10e6, name: 'mid', halfSpreadBps: 5, slippageBps: 8 },
  { minAdv: 3e6, name: 'small', halfSpreadBps: 12, slippageBps: 18 },
  { minAdv: 0, name: 'micro', halfSpreadBps: 30, slippageBps: 45 },
]);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const canonicalJson = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
};

function liquidityTier(adv) {
  for (const t of LIQUIDITY_TIERS) if (adv >= t.minAdv) return t;
  return LIQUIDITY_TIERS[LIQUIDITY_TIERS.length - 1];
}
// Stressed liquidity = one tier worse than measured.
function stressedTier(adv) {
  const i = LIQUIDITY_TIERS.findIndex((t) => adv >= t.minAdv);
  return LIQUIDITY_TIERS[Math.min(LIQUIDITY_TIERS.length - 1, (i < 0 ? LIQUIDITY_TIERS.length - 1 : i) + 1)];
}

// Round-trip cost in bps for a tier (entry + exit sides).
const roundTripCostBps = (tier, commissionBps) => 2 * (tier.halfSpreadBps + tier.slippageBps + commissionBps);

// executableOutcome({ bars, decisionIdx, horizonSessions, adv, notionalUsd, commissionBps })
//   bars — RAW vendor bars ascending: { ms, open, high, low, close, volume }.
// Returns a frozen result; never mutates inputs.
function executableOutcome({ bars, decisionIdx, horizonSessions, adv, notionalUsd = DEFAULT_NOTIONAL_USD, commissionBps = DEFAULT_COMMISSION_BPS }) {
  const base = {
    engine: EXEC_ENGINE_VERSION, entryBasis: ENTRY_BASIS,
    status: 'unresolved', horizonSessions,
    decisionSession: null, entrySession: null, exitSession: null,
    decisionClose: null, entryOpen: null, exitClose: null,
    gapThroughPct: null, gross: null,
    netBase: null, netDoubled: null, netStressed: null,
    costs: null, participation: null, noFillReason: null,
    raw: null,
  };
  if (!Array.isArray(bars) || decisionIdx == null || decisionIdx < 0 || decisionIdx >= bars.length) {
    return Object.freeze({ ...base, noFillReason: 'invalid-input' });
  }
  const dBar = bars[decisionIdx];
  const decisionSession = new Date(dBar.ms).toISOString().slice(0, 10);
  const entryBar = bars[decisionIdx + 1];
  if (!entryBar) return Object.freeze({ ...base, status: 'no_fill', decisionSession, decisionClose: dBar.close, noFillReason: 'no-next-session-bar' });
  if (!(entryBar.open > 0)) return Object.freeze({ ...base, status: 'no_fill', decisionSession, decisionClose: dBar.close, noFillReason: 'non-positive-or-missing-open' });

  // Market-impact / participation guard: a fill larger than MAX_PARTICIPATION
  // of ADV cannot be assumed at the open.
  const participation = adv > 0 ? notionalUsd / adv : null;
  if (participation != null && participation > MAX_PARTICIPATION) {
    return Object.freeze({
      ...base, status: 'no_fill', decisionSession, decisionClose: dBar.close,
      participation: +participation.toFixed(6), noFillReason: `participation ${(participation * 100).toFixed(2)}% of ADV exceeds ${(MAX_PARTICIPATION * 100).toFixed(0)}% cap`,
    });
  }

  const exitIdx = decisionIdx + horizonSessions;
  const exitBar = bars[exitIdx];
  const gap = dBar.close > 0 ? entryBar.open / dBar.close - 1 : null;
  const common = {
    ...base, decisionSession,
    entrySession: new Date(entryBar.ms).toISOString().slice(0, 10),
    decisionClose: dBar.close, entryOpen: entryBar.open,
    gapThroughPct: gap == null ? null : +gap.toFixed(6),
    participation: participation == null ? null : +participation.toFixed(6),
    raw: {
      entry: { open: entryBar.open, high: entryBar.high ?? null, low: entryBar.low ?? null, close: entryBar.close },
      exit: exitBar ? { open: exitBar.open ?? null, high: exitBar.high ?? null, low: exitBar.low ?? null, close: exitBar.close } : null,
    },
  };
  if (!exitBar || !(exitBar.close > 0)) {
    return Object.freeze({ ...common, status: 'not_mature', noFillReason: exitBar ? 'non-positive-exit-close' : 'exit-session-not-observed' });
  }

  const gross = exitBar.close / entryBar.open - 1;
  const tier = liquidityTier(adv);
  const sTier = stressedTier(adv);
  const baseCostBps = roundTripCostBps(tier, commissionBps);
  const stressedCostBps = roundTripCostBps(sTier, commissionBps) * 1.5;   // worse tier AND wider
  const costs = {
    liquidityTier: tier.name, adv: adv ?? null, commissionBpsPerSide: commissionBps,
    baseCostBps, doubledCostBps: baseCostBps * 2, stressedCostBps: +stressedCostBps.toFixed(2),
    stressedTier: sTier.name,
  };
  return Object.freeze({
    ...common,
    status: 'filled',
    exitSession: new Date(exitBar.ms).toISOString().slice(0, 10),
    exitClose: exitBar.close,
    gross: +gross.toFixed(6),
    netBase: +(gross - baseCostBps / 1e4).toFixed(6),
    netDoubled: +(gross - (baseCostBps * 2) / 1e4).toFixed(6),
    netStressed: +(gross - stressedCostBps / 1e4).toFixed(6),
    costs,
  });
}

// Aggregate per-fill executable outcomes into a SELF-VERIFIABLE cost-evidence
// artifact. `fills` are executableOutcome results (status filled). The
// artifactHash covers the full payload, so the harness can verify that the
// numbers came from this engine and were not hand-invented.
function buildCostEvidence({ fills, strategyId, datasetHash, horizonSessions, generatedAt = null }) {
  const filled = (fills || []).filter((f) => f && f.status === 'filled' && f.engine === EXEC_ENGINE_VERSION);
  const noFills = (fills || []).filter((f) => f && f.status === 'no_fill').length;
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const r6 = (v) => (v == null ? null : +v.toFixed(6));
  const payload = {
    schema: 'ExecutionCostEvidence',
    engine: EXEC_ENGINE_VERSION,
    entryBasis: ENTRY_BASIS,
    strategyId: strategyId || null,
    datasetHash: datasetHash || null,
    horizonSessions: horizonSessions ?? null,
    fills: filled.length,
    noFills,
    grossMean: r6(mean(filled.map((f) => f.gross))),
    net: r6(mean(filled.map((f) => f.netBase))),
    doubledCostNet: r6(mean(filled.map((f) => f.netDoubled))),
    stressedLiquidityNet: r6(mean(filled.map((f) => f.netStressed))),
    inputsDigest: sha256(canonicalJson(filled.map((f) => [f.decisionSession, f.entrySession, f.exitSession, f.entryOpen, f.exitClose, f.costs && f.costs.baseCostBps]))),
    generatedAt,
  };
  return Object.freeze({ ...payload, artifactHash: sha256(canonicalJson(payload)) });
}

// Verify a cost-evidence artifact: engine identity, next-open entry basis, and
// the content hash must all check out. Plain numbers can never pass here.
function verifyCostEvidence(ev) {
  if (!ev || typeof ev !== 'object') return { valid: false, reason: 'no evidence object' };
  if (ev.schema !== 'ExecutionCostEvidence' || ev.engine !== EXEC_ENGINE_VERSION) {
    return { valid: false, reason: 'not produced by the execution engine' };
  }
  if (ev.entryBasis !== ENTRY_BASIS) {
    return { valid: false, reason: `entry basis '${ev.entryBasis}' is not executable — the signal-day close is never an executable entry` };
  }
  const { artifactHash, ...payload } = ev;
  const recomputed = sha256(canonicalJson(payload));
  if (artifactHash !== recomputed) return { valid: false, reason: 'artifactHash does not recompute — evidence payload was altered or hand-built' };
  if (!(ev.fills > 0)) return { valid: false, reason: 'no filled executions behind the evidence' };
  return { valid: true, reason: 'engine artifact verified' };
}

module.exports = {
  EXEC_ENGINE_VERSION, ENTRY_BASIS, LIQUIDITY_TIERS, MAX_PARTICIPATION,
  DEFAULT_COMMISSION_BPS, DEFAULT_NOTIONAL_USD,
  liquidityTier, stressedTier, roundTripCostBps,
  executableOutcome, buildCostEvidence, verifyCostEvidence,
};

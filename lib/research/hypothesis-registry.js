'use strict';
// HYPOTHESIS REGISTRY + NEGATIVE-RESULTS GRAVEYARD (hypothesis-registry-v1)
//
// One committed, code-reviewed record of every research hypothesis the app has tested
// or is testing: what was claimed, what metric decides it, what the stopping rule is,
// and what happened. Three problems this solves:
//
//   1. FAILED IDEAS GET REINTRODUCED. The graveyard (status 'no-edge') makes every
//      rejected hypothesis findable BEFORE someone re-runs it as if new.
//   2. TRIALS GO UNCOUNTED. familyTrials()/totalTrials() give the multiple-testing
//      denominator; benjaminiHochberg() is the standard FDR correction that was
//      documented as required (docs/validation-protocol.md) but never implemented.
//   3. EXPLORATORY RESULTS MASQUERADE AS CONFIRMATORY. Every entry declares its mode;
//      only a 'confirmatory' pass can support status 'confirmed'.
//
// The registry lives in code (not Blob) DELIBERATELY: preregistration should be a
// reviewed, versioned diff, and a hypothesis edited after its outcome was seen shows
// up in git history. Entries are grandfathered honestly: work done before this file
// existed carries stoppingRule 'retrospective — not preregistered (grandfathered)'.
//
// Statuses: open | confirmed | provisional | no-edge | invalid-data | retired
// Pure module: no network, no clock, no store.

const REGISTRY_VERSION = 'hypothesis-registry-v1';

const STATUSES = Object.freeze(['open', 'confirmed', 'provisional', 'no-edge', 'invalid-data', 'retired']);
const MODES = Object.freeze(['exploratory', 'confirmatory']);

const GRANDFATHERED = 'retrospective — not preregistered (grandfathered)';

// NOTE: statuses below summarize the cited evidence artifact — change one only with a
// newer artifact, and record the old row's supersession in the note (never delete).
const HYPOTHESES = Object.freeze([
  {
    id: 'momentum-12-1-swing', familyId: 'swing-ranking', mode: 'confirmatory', status: 'no-edge',
    hypothesis: '12-1 momentum ranks the app universe for 21/63-session forward excess return.',
    mechanism: 'cross-sectional continuation (Jegadeesh-Titman)',
    primaryMetric: 'per-date rank IC, survivorship-free', baseline: 'random control',
    universe: 'small/mid band incl. 2,573 delisted (PIT master)', costs: 'cost-net tiers',
    expectedDirection: 'positive IC', stoppingRule: GRANDFATHERED,
    evidence: 'research/MOMENTUM-SURVIVORSHIP-FREE-2026-07.md',
    note: 'rank-IC ≈ 0 on BOTH survivor and survivorship-free universes; retained as the transparent BENCHMARK yardstick, never a live edge claim.',
  },
  {
    id: 'omega-swing-selection', familyId: 'swing-ranking', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'OMEGA utility-ranked continuation beats the momentum baseline on 5/10d residual return.',
    mechanism: 'multi-expert continuation ensemble', primaryMetric: 'survivorship-free rank IC vs baseline',
    baseline: '12-1 momentum', universe: 'PIT master incl. delisted', costs: 'cost-net',
    expectedDirection: 'positive incremental IC', stoppingRule: GRANDFATHERED,
    evidence: 'research/OMEGA-SURVIVORSHIP-FREE-2026-07.md + lib/omega-research-verdict.json',
    note: 'rank-IC −0.027 vs baseline +0.029; verdict no-edge, promotable=false.',
  },
  {
    id: 'unscheduled-gap-orb', familyId: 'intraday-gap', mode: 'confirmatory', status: 'provisional',
    hypothesis: 'Unscheduled ≥5% gap-ups on liquid names continue after a 30-min ORB break (2.5 ATR stop, 2R target, ≤3 sessions).',
    mechanism: 'underreaction to unscheduled catalysts', primaryMetric: 'OOS cost-net expectancy/trade + DSR',
    baseline: 'no-trade', universe: '51-name intraday rig 2022-2025H1 (survivorship-free)', costs: '5bps slip/fill + 2bps comm/leg',
    expectedDirection: 'positive expectancy', stoppingRule: 'pre-registered split 2023-10-23; variants declared in script header',
    evidence: 'research/intraday/data/unscheduled_gap.json (gap5_PRIMARY) + research/intraday/FINDINGS.md',
    note: 'OOS n≈227, +1.89%/trade, PF 1.47 under stop-through-trigger fills; date-clustered inference below t=2 → SHADOW/paper only, promotion gated on prospective evidence.',
  },
  {
    id: 'gap-metalabel', familyId: 'intraday-gap', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'A purged walk-forward meta-label filter improves the gap-ORB book over ranking by gap size.',
    mechanism: 'precision filter on entry-time features', primaryMetric: 'OOS expectancy vs gap-size ranking',
    baseline: 'gap-size rank', universe: '750 gap-ORB trades 2022-2025H1', costs: 'as rig',
    expectedDirection: 'higher expectancy, lower lumpiness', stoppingRule: GRANDFATHERED,
    evidence: 'research/intraday/FINDINGS.md (exp 11) + research/GAP-METALABEL-2026-07.md',
    note: 'meta rank-IC 0.007; no ranker clears bootstrap significance; filtering CONCENTRATES tail risk.',
  },
  {
    id: 'orb-gate-vs-prior-high', familyId: 'intraday-gap', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'Waiting for the opening-range break beats the live prior-day-high trigger on realized R.',
    mechanism: 'gap-fade avoidance', primaryMetric: 'meanR AND PF AND MAE vs live rule',
    baseline: 'live triggerScore rule', universe: '374 intra5 events', costs: 'as rig',
    expectedDirection: 'B beats A_trig on all three', stoppingRule: 'pre-registered in script header before outcomes',
    evidence: 'research/ORB-GATE-VALIDATION-2026-07.md',
    note: 'NO-SHIP: halves MAE/stop-outs but sacrifices net R and PF on this runner-heavy window.',
  },
  {
    id: 'pead-sue', familyId: 'event-drift', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'Analyst-SUE post-earnings drift predicts 21/63d SPY-excess return.',
    mechanism: 'post-earnings underreaction', primaryMetric: 'signed IC + decile spread, multi-year multi-regime',
    baseline: 'zero drift', universe: 'large+small+micro 2021-2026 paired-estimate history', costs: 'excess-vs-SPY',
    expectedDirection: 'positive drift', stoppingRule: GRANDFATHERED,
    evidence: 'research/data/sue.json (panel-v2 rerun) + sue-v3.json (fwd-outcome-v3 rerun) + apex/pead.json (surprise mode) + research/data/evidence/pead-sue/',
    note: 'clean-panel rerun: pooled IC 0.006, t 1.76 < 2, adding SUE to the composite REDUCES IC (delta −0.009). Large-cap shows mild REVERSAL. 2026-08-02 fwd-outcome-v3 rerun (authoritative delistings only): IC 0.0041, t 1.49, delta −0.0112 — the negative is label-robust.',
  },
  {
    id: 'congress-flow', familyId: 'alt-signals', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'Net congressional buying (as-of DISCLOSURE date) predicts forward excess return.',
    mechanism: 'informed-trader imitation', primaryMetric: 'signed drift t-stat by quintile',
    baseline: 'zero', universe: 'large-cap 150, 2021-2026', costs: 'excess-vs-SPY',
    expectedDirection: 'positive', stoppingRule: GRANDFATHERED,
    evidence: 'apex/congress.json (op=congress)', note: 'signed t 1.24 over 4,067 events — not confirmed.',
  },
  {
    id: 'analyst-revisions', familyId: 'alt-signals', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'Analyst consensus-revision momentum predicts forward excess return.',
    mechanism: 'sluggish price response to revisions', primaryMetric: 'signed drift t-stat by quintile',
    baseline: 'zero', universe: 'large-cap 150, 2021-2026', costs: 'excess-vs-SPY',
    expectedDirection: 'positive', stoppingRule: GRANDFATHERED,
    evidence: 'apex/revisions.json (op=revisions)', note: 'signed t 0.6 over 2,574 events — not confirmed.',
  },
  {
    id: 'quiet-accumulation-standalone', familyId: 'swing-ranking', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'The Ghost quiet-accumulation composite ranks better than momentum as a standalone selector.',
    mechanism: 'institutional accumulation footprint', primaryMetric: 'walk-forward composite rank-IC, all blocks positive',
    baseline: '12-1 momentum / price core', universe: 'full S&P + small-cap scans', costs: 'gross (study-era)',
    expectedDirection: 'positive incremental IC', stoppingRule: 'pre-declared ship criterion (margin 0.02, ≥3 folds positive)',
    evidence: 'lib/ghost-backtest.js verdict + redundancy model (ghost×screener return corr ≈0.96)',
    note: 'edge is ~all momentum/RM; failed all-blocks-positive; broad-IC information without top-pick lift → SUPPORTING EVIDENCE / shadow tie-break candidate only, weight 0 as standalone.',
  },
  {
    id: 'rlt-leadership-transition', familyId: 'swing-ranking', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'Sector×band peer-rank leadership transitions predict 5/10/21d residual return.',
    mechanism: 'leadership rotation', primaryMetric: 'cost-net residual IC, both cap bands',
    baseline: 'simple baselines + momentum', universe: 'top-150 sample walk-forward', costs: 'cost-net',
    expectedDirection: 'positive', stoppingRule: GRANDFATHERED,
    evidence: 'PR #215 walk-forward record (rlt-lab payloads)', note: 'first real-data walk-forward rejected on both bands.',
  },
  {
    id: 'orbit-residual-drift', familyId: 'swing-ranking', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'ORBIT residual-drift screener ranks forward residual returns.',
    mechanism: 'residual drift persistence', primaryMetric: 'OOS rank IC', baseline: 'random + momentum',
    universe: 'app universe', costs: 'cost-aware', expectedDirection: 'positive', stoppingRule: GRANDFATHERED,
    evidence: 'docs/orbit-validation.md + orbit lab payloads', note: 'honest ~0 OOS (grade C); never deployed.',
  },
  {
    id: 'orbit-ml-ranknet', familyId: 'swing-ranking', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'A RankNet learner beats the transparent baselines on the same folds.',
    mechanism: 'nonlinear feature interactions', primaryMetric: 'OOS rank IC vs baselines',
    baseline: 'ridge + momentum', universe: 'app universe', costs: 'cost-aware',
    expectedDirection: 'positive incremental IC', stoppingRule: GRANDFATHERED,
    evidence: 'docs/orbit-ml-validation.md', note: 'rank-IC ~0; more complexity ≠ improvement.',
  },
  {
    id: 'nonlinear-ml-panel', familyId: 'swing-ranking', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'GBM over the clean panel-v2 features earns live promotion over Ridge and momentum.',
    mechanism: 'nonlinear interactions', primaryMetric: 'walk-forward Deflated Sharpe ≥ 0.95 + incremental IC',
    baseline: 'ridge + 12-1 momentum', universe: 'panel-v2 (fwd-outcome-v2 labels)', costs: 'cost-net',
    expectedDirection: 'positive', stoppingRule: 'DSR ≥ 0.95 bar declared before rerun',
    evidence: 'commit a862e83 (28-mlrank rerun on panel-v2) + research/data/evidence/nonlinear-ml-panel/ (panel-v3 rerun)',
    note: 'GBM>Ridge IC delta significant but WF DSR 0.51 < 0.95 → research-only, no live ML. 2026-08-02 panel-v3 rerun (honest labels): delta shrinks +0.0198→+0.0118 (t 4.92→2.63, PBO 18%→43%) — much of the v2 significance was the 3,297 fabricated delisting haircuts; WF DSR 0.50 still fails the pre-declared 0.95 bar.',
  },
  {
    id: 'peer-propagation', familyId: 'graph-signals', mode: 'confirmatory', status: 'no-edge',
    hypothesis: 'Sector-peer graph propagation of moves predicts laggard catch-up.',
    mechanism: 'intra-sector information diffusion', primaryMetric: 'prospective walk-forward incremental lift',
    baseline: 'momentum + sector', universe: 'app universe', costs: 'cost-net',
    expectedDirection: 'positive', stoppingRule: 'falsification harness declared at build time',
    evidence: 'peerprop live walk-forward (PRs #226/#229 record)',
    note: 'live WF shows no incremental lift on a small window; stays shadow (test/peerprop-isolation.test.js enforces).',
  },
  {
    id: 'nsl-novel-engines', familyId: 'novel-signal-lab', mode: 'exploratory', status: 'retired',
    hypothesis: 'Nine novel engines (residual momentum, sector twins, forensics, insider-incremental, …) add edge over momentum.',
    mechanism: 'various', primaryMetric: 'incremental IC vs momentum on shared harness',
    baseline: '12-1 momentum', universe: 'app universe', costs: 'cost-aware',
    expectedDirection: 'positive', stoppingRule: GRANDFATHERED,
    evidence: 'research/NSL-INCREMENTAL-SERIES-SUMMARY-2026-07.md (PRs #158-#162)',
    note: 'ALL experiments no-edge; arc closed — the family is retired, engines remain shadow diagnostics.',
  },
  {
    id: 'expectation-gap-regime', familyId: 'regime', mode: 'confirmatory', status: 'open',
    hypothesis: 'Objective-vs-priced expectation gaps identify RISK_REDUCE windows that beat static exposure.',
    mechanism: 'variance-risk-premium + breadth divergence', primaryMetric: 'graded SPY-short episodes on the Scoreboard',
    baseline: 'static exposure 1.0', universe: 'index-level', costs: 'cost-net',
    expectedDirection: 'RISK_REDUCE days underperform', stoppingRule: '≥20 resolved RISK_REDUCE episodes before any promotion decision',
    evidence: 'lib/expectation-gap.js + expgap/<date>.json ledger (PR #230)',
    note: 'reduce-only by construction (no RISK_ADD state exists); accruing prospectively.',
  },
  {
    id: 'target-comparison', familyId: 'label-design', mode: 'confirmatory', status: 'open',
    hypothesis: 'Alternative training targets rank the SAME economic metric better than the current label.',
    mechanism: 'label design', primaryMetric: 'cost-adjusted sector-residual rank-IC on identical purged folds',
    baseline: 'current label + shuffled-label control', universe: 'research/horizon-outcomes vectors',
    costs: 'cost-adjusted', expectedDirection: 'a variant beats champion AND the control loses',
    stoppingRule: 'fail-closed <8 dates/<150 rows; shuffled control winning ⇒ verdict NOISE',
    evidence: 'lib/research/target-compare.js (PRs #230-#233)',
    note: 'INSUFFICIENT_DATA until labels mature (~2026-08-09 for bars=5); the control is built in.',
  },
  {
    id: 'downday-v-reversal', familyId: 'mean-reversion', mode: 'confirmatory', status: 'provisional',
    hypothesis: 'On broad red-tape days, V-reversal candidates mean-revert over the following sessions.',
    mechanism: 'liquidity-driven overshoot', primaryMetric: 'forward excess vs SPY of graded picks',
    baseline: 'no-trade', universe: 'app universe on qualifying down days', costs: 'cost-aware',
    expectedDirection: 'positive', stoppingRule: GRANDFATHERED,
    evidence: 'research/DOWNDAY-MODE-2026-07.md',
    note: 'validated in study; prospective ledger still thin — provisional until the live record matures.',
  },
  {
    id: 'coil-compression', familyId: 'volatility-structure', mode: 'confirmatory', status: 'provisional',
    hypothesis: 'Volatility compression concentrates ABNORMAL (vol-normalized) upside breaks.',
    mechanism: 'coiled-spring volatility clustering', primaryMetric: 'decile lift of abnormal-break rate',
    baseline: 'universe base rate', universe: 'present-day universe ~2y (SURVIVORSHIP-UNSAFE)', costs: 'n/a (event rate)',
    expectedDirection: 'top decile > base', stoppingRule: GRANDFATHERED,
    evidence: 'research/COIL-RADAR.md + lib/coil.js frozen table',
    note: 'decile lift ~1.9× is real in-study but the table is a frozen present-universe artifact with no per-decile n — display relabeled to "empirical decile base rate", never a calibrated probability.',
  },
]);

// ── Multiple-testing correction ────────────────────────────────────────────────
// Benjamini-Hochberg step-up FDR: items = [{id, p}] → [{id, p, q, rank}] with the
// standard monotone adjusted q-values. Null/invalid p-values are excluded from the
// correction (returned with q:null) — a missing p must not shrink the denominator.
function benjaminiHochberg(items) {
  const rows = (items || []).map((it) => ({ id: it.id, p: Number.isFinite(it.p) && it.p >= 0 && it.p <= 1 ? it.p : null }));
  const valid = rows.filter((r) => r.p != null).sort((a, b) => a.p - b.p);
  const n = valid.length;
  let runningMin = 1;
  const qById = new Map();
  for (let i = n - 1; i >= 0; i--) {
    const raw = (valid[i].p * n) / (i + 1);
    runningMin = Math.min(runningMin, raw);
    qById.set(valid[i].id, Math.min(1, runningMin));
  }
  return rows.map((r, idx) => ({
    ...r,
    q: r.p == null ? null : qById.get(r.id),
    rank: r.p == null ? null : valid.findIndex((v) => v.id === r.id) + 1,
    index: idx,
  }));
}

// ── Trial accounting ───────────────────────────────────────────────────────────
function familyTrials(familyId) {
  return HYPOTHESES.filter((h) => h.familyId === familyId).length;
}
function totalTrials() { return HYPOTHESES.length; }

function byStatus(status) { return HYPOTHESES.filter((h) => h.status === status); }
function graveyard() { return HYPOTHESES.filter((h) => h.status === 'no-edge' || h.status === 'retired'); }
function find(id) { return HYPOTHESES.find((h) => h.id === id) || null; }

// ── Sealed-holdout ledger ──────────────────────────────────────────────────────
// Rule: an opened holdout can NEVER be called untouched again. There is currently no
// sealed test era in the repo (the harness is expanding-window walk-forward); this
// ledger exists so that the FIRST sealed era is registered before it is created, and
// its opening is a recorded, irreversible event (openedAt set via a reviewed diff).
const HOLDOUTS = Object.freeze([
  // { id, description, sealedAt, openedAt: null | 'YYYY-MM-DD', openedBy }
]);
function untouchedHoldouts() { return HOLDOUTS.filter((h) => !h.openedAt); }

// ── Validation ─────────────────────────────────────────────────────────────────
function validateHypothesis(h) {
  const errors = [];
  if (!h || typeof h !== 'object') return { valid: false, errors: ['not an object'] };
  for (const k of ['id', 'familyId', 'hypothesis', 'mechanism', 'primaryMetric', 'baseline', 'universe', 'expectedDirection', 'stoppingRule', 'evidence']) {
    if (typeof h[k] !== 'string' || !h[k].length) errors.push(`${k} is required`);
  }
  if (!MODES.includes(h.mode)) errors.push(`mode must be one of ${MODES.join('|')}`);
  if (!STATUSES.includes(h.status)) errors.push(`status must be one of ${STATUSES.join('|')}`);
  // Only a confirmatory test can confirm.
  if (h.status === 'confirmed' && h.mode !== 'confirmatory') errors.push('status confirmed requires mode confirmatory');
  return { valid: errors.length === 0, errors };
}

module.exports = {
  REGISTRY_VERSION, STATUSES, MODES, HYPOTHESES, HOLDOUTS,
  benjaminiHochberg, familyTrials, totalTrials, byStatus, graveyard, find,
  untouchedHoldouts, validateHypothesis,
};

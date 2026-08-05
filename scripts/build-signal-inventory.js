'use strict';
// GENERATE THE NON-DAY-TRADE SIGNAL INVENTORY (redesign Phase 1).
//
// The Phase-1 matrix must be AUDITABLE and RE-DERIVABLE, not a hand-maintained table that
// drifts from the code the day after it is written. This script reads the registry, the
// outcome contracts, the presentation roles and the eligibility rules, and emits
// docs/non-daytrade-signal-inventory.md.
//
// Usage: node scripts/build-signal-inventory.js

const fs = require('node:fs');
const path = require('node:path');
const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');
const SC = require('../lib/strategy-contracts');
const SP = require('../lib/strategy-presentation');
const EI = require('../lib/evidence-identity');
const M = require('../lib/maturity');

const OUT = path.join(__dirname, '..', 'docs', 'non-daytrade-signal-inventory.md');

// Sources the Today board can normalize (lib/decision-normalizers) — i.e. those that can
// reach the ranked board at all.
const BOARD_SOURCES = new Set(['screener', 'emergingleader', 'ghost', 'gapgo', 'daytrade', 'coil',
  'gapdown', 'biotech', 'coremo', 'downday', 'optionsflow', 'readthrough', 'anomaly', 'secondwave',
  'crossasset', 'toneshift']);

const esc = (v) => String(v == null ? '—' : v).replace(/\|/g, '\\|').replace(/\n/g, ' ');

function row(e) {
  const c = SC.contractFor(e.id);
  const p = SP.presentationFor(e.id, { registryEntry: e, contract: c });
  const identity = EI.identityForStrategy(e, { contract: c });
  const leadOnly = !!(c && c.fillPolicy === 'lead-only');
  const canOriginate = e.maturity === 'production' && !leadOnly && !!c && c.fillPolicy !== 'lead-only';
  return {
    id: e.id,
    label: e.label,
    kind: e.kind,
    scoringVersion: e.scoringVersion || '—',
    side: (c && c.side) || '—',
    horizon: (c && c.horizon) || e.horizon || '—',
    metric: (c && c.metric) || '—',
    policyTiers: Array.isArray(e.policyTiers) ? e.policyTiers.join(' / ') : '(all non-research tiers)',
    decisionBasis: (c && c.decisionBasis) || 'EOD close of the signal session',
    infoCutoff: (c && c.decisionBasis) ? 'declared in contract' : 'signal session close',
    entry: (c && c.fillPolicy) || '—',
    exits: c ? `${c.stopPolicy || 'none'} / ${c.targetPolicy || 'none'} / ${c.timeExitSessions ?? '—'}s` : '—',
    benchmark: c && Array.isArray(c.benchmark) ? c.benchmark.join('+') : '—',
    fillVerified: SC.fillVerifiedFor(e.id).fillVerified ? 'YES (derived)' : 'no (derived — fails closed)',
    staticStatus: e.maturity,
    displayLane: e.maturity === 'production' ? 'executable (if plan + liquidity + fresh data)' : (leadOnly ? 'qualified lead / research' : 'research'),
    canOriginate: canOriginate ? 'yes (subject to governance + data gates)' : 'NO',
    canSize: canOriginate && !leadOnly ? 'yes (subject to plan + liquidity)' : 'NO',
    onBoard: BOARD_SOURCES.has(e.id) ? 'yes' : 'no (own tab only)',
    role: p.roleLabel,
    identityClass: EI.classifyIdentity(identity),
    evidenceSource: e.section ? `Scoreboard section \`${e.section}\`` : 'own ledger / not in the Scoreboard',
  };
}

function main() {
  const signals = STRATEGY_REGISTRY.filter(e => e.kind === 'signal');
  const rows = signals.map(row);
  const nonDt = rows.filter(r => r.id !== 'daytrade');

  const head = (cols) => `| ${cols.join(' | ')} |\n|${cols.map(() => '---').join('|')}|`;
  const line = (vals) => `| ${vals.map(esc).join(' | ')} |`;

  let md = `# Non-Day-Trade Signal Inventory (generated)

> **Generated** by \`node scripts/build-signal-inventory.js\` from the registry, the outcome
> contracts, the presentation roles and the eligibility rules. Do not hand-edit — regenerate.
> Day Trade appears once for completeness and is FROZEN (excluded from the redesign).

Signal strategies: **${signals.length}** (non-Day-Trade: **${nonDt.length}**).
Static production: **${rows.filter(r => r.staticStatus === 'production').length}**
(non-Day-Trade: **${nonDt.filter(r => r.staticStatus === 'production').length}**) ·
shadow/research: **${rows.filter(r => r.staticStatus !== 'production').length}**.
Formal outcome contracts: **${Object.keys(SC.CONTRACTS).length}**.
Pipelines with DERIVED verified fills: **${rows.filter(r => r.fillVerified.startsWith('YES')).length}**.

## 1. Identity, contract and execution

${head(['id', 'scoring version', 'side', 'horizon', 'metric', 'policy cohort', 'decision basis', 'entry contract', 'stop / target / time exit', 'benchmark'])}
${rows.map(r => line([r.id, r.scoringVersion, r.side, r.horizon, r.metric, r.policyTiers, r.decisionBasis, r.entry, r.exits, r.benchmark])).join('\n')}

## 2. Evidence, status and reach

${head(['id', 'evidence source', 'fill verification', 'static status', 'identity class', 'display lane', 'may originate?', 'may size?', 'on the Today board?', 'presentation role'])}
${rows.map(r => line([r.id, r.evidenceSource, r.fillVerified, r.staticStatus, r.identityClass, r.displayLane, r.canOriginate, r.canSize, r.onBoard, r.role])).join('\n')}

## 3. Central control points (no strategy may bypass these)

| Stage | Module | What it enforces |
|---|---|---|
| source data → freshness | \`lib/data-gates.js\` | required bar, information cutoff, universe coverage, reference feeds, liquidity coverage — BEFORE ranking |
| score comparability | \`lib/score-normalize.js\` | within-source percentile / neutral shrink; frozen source priors; dependence-discounted, capped merge |
| eligibility | \`lib/eligibility.js\` | three-class taxonomy, borrow gate, conditional-context gate, lead-only, reduce-only, sizing discipline |
| ranking | \`lib/decision.js\` | cost-net expectancy tilt, regime fit, execution quality, evidence breadth, score decomposition |
| sizing set | \`lib/decision-routes.js\` + \`lib/decision-portfolio.js\` | portfolio, Book and opportunity density are built from ACTIONABLE + sizing-eligible rows ONLY |
| evidence identity | \`lib/evidence-identity.js\` | 11-axis canonical key; incomplete identity ⇒ LEGACY_CONTEXT (cannot govern) |
| statistics | \`lib/evidence-stats.js\` | one deduplicated date series, HAC, block bootstrap, effective sample size, block stability, FDR |
| grade | \`lib/maturity.js\` | cost-net + sector + sample + effective-sample + block gates; derived fill verification |
| clearance | \`lib/governance.js\` + \`lib/promotion-artifact.js\` | semantic artifact validation, identity binding, grandfather reduce-only + expiry |
| episodes | \`lib/episode-ledger.js\` | one executable-episode schema, attrition by reason, leakage refusal, reconciliation |
| learning | \`lib/champion-challenger.js\` | automatic demotion allowed; automatic promotion structurally impossible |

## 4. Known bypass risks (checked)

- **Own-tab books** (Trend Rider, Dual Confirmed, Confluence, and every shadow engine) keep their
  own ledgers. They are registered, contracted and weight-0; they cannot reach the Today board
  (\`onBoard: no\`), so they cannot originate or size a live position.
- **Day Trade** is pinned in \`lib/eligibility.js\` and \`lib/score-normalize.js\` by user directive:
  static production status only, scores passed through untouched, excluded from the data gate.
- **Informational surfaces** (sectors, rotation, news, pulse, game plan, forecast) are \`kind:
  'informational'\` — never graded, never sized, never in the lab.

## 5. Maturity gate constants (single source)

| Gate | Value |
|---|---|
| resolved episodes for Validated | ${M.MIN_VALIDATED_EPISODES} |
| independent decision dates | ${M.MIN_VALIDATED_DATES} |
| EFFECTIVE (autocorrelation-adjusted) dates | ${M.MIN_EFFECTIVE_DATES} |
| positive chronological blocks (of 4) | ${M.MIN_POSITIVE_BLOCKS} |
| sample for a protective Disabled verdict | ${M.MIN_VERDICT} |
`;

  fs.writeFileSync(OUT, md);
  process.stdout.write(`wrote ${OUT} (${signals.length} signal strategies)\n`);
}

if (require.main === module) main();
module.exports = { main, row };

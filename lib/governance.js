// MODEL GOVERNANCE — turns the EARNED evidence grade (lib/maturity) into an ACTIONABLE
// lifecycle STATUS that controls how much a model/tier is allowed to drive real sizing.
//
// The maturity grade answers "how much should I trust this?" (Validated → Disabled).
// Governance answers the operational question the Scoreboard should control: "what is
// this model cleared to DO right now?" — full size, reduced size, on probation, paper
// only, disabled, or retired. Status changes follow PRE-DEFINED rules gated on sample
// size; they never flip on noise, and — critically — a model's track record is NEVER
// merged across materially different SCORING VERSIONS (a version change resets the clock).
//
// Pure + deterministic (grade + prior status in, status out) → fully unit-testable.

const { MIN_VERDICT, MIN_PROMISING } = require('./maturity');
const PA = require('./promotion-artifact');

const GOVERNANCE_VERSION = 'gov-v3';

// GRANDFATHERING (gov-v3, redesign Phase 3 item 5). A strategy that is live because it
// always has been — but whose evidence does not clear the current gates — is not simply
// left alone (that is the fail-open the redesign removes) and not simply killed (that
// would strand real positions). It becomes REDUCE-ONLY for a bounded window:
//   • may not originate new positions (sizingWeight 0 through eligibility's plan/size path)
//   • holds at 'reduced' clearance so existing exposure can be managed down
//   • expires automatically to 'paper' at the end of the window unless renewed evidence
//     (a valid artifact) arrives — no human action is needed for the SAFE outcome.
const GRANDFATHER_WINDOW_DAYS = 90;

// PROMOTION ARTIFACT (gov-v2.1) — an earned Validated grade is NECESSARY but no longer
// SUFFICIENT for live Production clearance. The final step is a reviewable, human-made
// promotion artifact (governance/promotion-artifacts.json: { strategies: { <id>: {...} } })
// carrying the COMPLETE schema docs/model-promotion-policy.md requires. gov-v2 verified
// only { approve, version } — an approval with no dataset hashes, no validation record,
// no approver and no expiry satisfied it. Now every field is verified, fail closed:
// missing/incomplete/mismatched/expired/revoked ⇒ paper/probation, never production.
const REQUIRED_ARTIFACT_FIELDS = Object.freeze([
  'version',              // strategy/model scoring version — must equal the CURRENT version
  'approve',              // explicit true
  'approvedAt',           // ISO timestamp of the human approval
  'approvedBy',           // approval identity
  'codeCommit',           // commit the validation ran at
  'datasetHash', 'universeHash', 'featureHash',
  'trainingCutoff', 'foldDefinition', 'primaryMetric',
  'validationResults', 'costStress', 'survivorshipStatus', 'calibration', 'tailRisk',
  'prospectiveEvidence', 'limitations',
  'evidenceHash',         // hash of the Scoreboard evidence the approval was judged on
  'expiresAt',            // approvals age out; renewal is an explicit re-review
]);

// Every reason the artifact fails, or [] when it is valid.
//
// gov-v3 delegates to lib/promotion-artifact.js, which validates the VALUES rather than
// the presence of the keys: `validationResults.passed === true`, `costStress.passed`,
// `survivorshipStatus.safe`, calibration when probabilities are shown, prospective
// evidence, sample/effective-sample/block-stability floors, multiple-testing correction,
// identity match on every known version axis, evidence-hash binding, freshness, and no
// unresolved data-quality blocker. Returned as human strings here (the callers and the
// stored governance doc have always carried strings); the structured codes are available
// via promotionArtifactFindings().
function promotionArtifactFindings(artifact, version, { nowMs = Date.now(), evidenceHash = null, identity = null, requiresProbability = false, requiresProspective = true } = {}) {
  return PA.validateArtifact(artifact, { version, ...(identity || {}) }, { nowMs, evidenceHash, requiresProbability, requiresProspective });
}

function promotionArtifactProblems(artifact, version, opts = {}) {
  return promotionArtifactFindings(artifact, version, opts).map(p => `[${p.code}] ${p.detail}`);
}

function validPromotionArtifact(artifact, version, opts = {}) {
  return promotionArtifactFindings(artifact, version, opts).length === 0;
}

// Is a previously-live strategy still inside its grandfather window? `since` is when it
// first failed to qualify (persisted on the governance record; absent ⇒ starts now).
function grandfatherState(prev, nowMs) {
  const since = (prev && prev.grandfatheredSince) ? Date.parse(prev.grandfatheredSince) : null;
  const start = Number.isFinite(since) ? since : nowMs;
  const expiresMs = start + GRANDFATHER_WINDOW_DAYS * 86400_000;
  return {
    grandfatheredSince: new Date(start).toISOString(),
    grandfatherExpiresAt: new Date(expiresMs).toISOString(),
    expired: nowMs >= expiresMs,
    daysLeft: Math.max(0, Math.round((expiresMs - nowMs) / 86400_000)),
  };
}

// The status ladder. `weight` = the fraction of a model's nominal position size it is
// cleared to drive (governance is what makes the Scoreboard *control* the app, not just
// report on it). rank orders strongest → weakest for sorting.
const STATUS_META = {
  production: { label: 'Production',   icon: '🟢', weight: 1.0,  rank: 7, newPositions: true,  blurb: 'Proven vs benchmark over a full sample — cleared for full size.' },
  reduced:    { label: 'Reduced',      icon: '🔵', weight: 0.5,  rank: 6, newPositions: true,  blurb: 'Was proven but the recent record is weakening — size cut while it re-proves.' },
  // gov-v3: the grandfather lane. Live by history, NOT by current evidence.
  'reduce-only': { label: 'Reduce-only (grandfathered)', icon: '🟤', weight: 0.25, rank: 5, newPositions: false, blurb: 'Operationally live but its evidence does not clear the current gates — manage existing exposure down only. Cannot originate a new position, and expires automatically without renewed evidence.' },
  probation:  { label: 'Probation',    icon: '🟠', weight: 0.25, rank: 4, newPositions: true,  blurb: 'Fell from a live status; on a short leash pending its next resolved picks.' },
  paper:      { label: 'Paper-only',   icon: '⚪', weight: 0.0,  rank: 3, newPositions: false, blurb: 'Not yet proven (or context-only) — logged and tracked, never sized.' },
  disabled:   { label: 'Disabled',     icon: '⛔', weight: 0.0,  rank: 2, newPositions: false, blurb: 'Resolved record significantly underperforms its benchmark — turned off.' },
  retired:    { label: 'Retired',      icon: '🗄️', weight: 0.0,  rank: 1, newPositions: false, blurb: 'Superseded or withdrawn from service — kept for the record only.' },
};
const STATUSES = Object.keys(STATUS_META);

function weightFor(status) { return (STATUS_META[status] || STATUS_META.paper).weight; }
function newPositionsAllowed(status) { return (STATUS_META[status] || STATUS_META.paper).newPositions === true; }

// A model's realized edge is "materially weakening" when — over a real sample — its
// average excess has slipped meaningfully AND its beat-rate lower bound no longer clears
// the coin-flip line. Both conditions (not either) so a single soft quarter doesn't cut size.
function isWeakening(stats, prev) {
  if (!stats || !Number.isFinite(stats.excessN) || stats.excessN < MIN_VERDICT) return false;
  const prevAvg = prev && Number.isFinite(prev.avgExcess) ? prev.avgExcess : null;
  const slipped = prevAvg != null ? (stats.avgExcess ?? 0) < prevAvg - 1 : (stats.avgExcess ?? 0) <= 0;
  const beatLo = Number.isFinite(stats.beatLo) ? stats.beatLo : 100;
  return slipped && beatLo < 50;
}

// Govern ONE graded strategy. `graded` = a lib/maturity gradeStrategy() result
// ({ id, grade, stats, kind, core, section, horizon, version? }). `prev` = this id's
// governance record from the previous run (for trend + the version guard), or null.
// `artifact` = this id's reviewable promotion artifact (or null — fail closed).
// Returns { id, status, weight, reason, versionReset, stats, grade, version }.
function governStrategy(graded, prev, artifact = null, opts = {}) {
  const g = graded || {};
  const grade = g.grade || 'experimental';
  const stats = g.stats || null;
  const version = g.version || g.scoringVersion || null;
  const base = { id: g.id, label: g.label, section: g.section || null, grade, version, stats };

  // Explicit retirement always wins (a withdrawn/superseded model is never re-sized).
  if (g.retired) return { ...base, status: 'retired', weight: 0, newPositions: false, reason: g.note || 'Withdrawn from service.', versionReset: false };

  // Context-only classes are never sized, regardless of grade.
  if (g.kind === 'informational' || grade === 'informational') {
    return { ...base, status: 'paper', weight: 0, newPositions: false, reason: 'Context / awareness signal — informative, never sized.', versionReset: false };
  }

  // VERSION GUARD — never merge a track record across materially different scoring
  // versions. If the version changed since we last governed this model, the prior
  // sample no longer describes the CURRENT model: reset to a re-proving state.
  if (prev && prev.version && version && prev.version !== version) {
    const wasLive = prev.status === 'production' || prev.status === 'reduced';
    return {
      ...base,
      status: wasLive ? 'probation' : 'paper',
      weight: weightFor(wasLive ? 'probation' : 'paper'),
      newPositions: newPositionsAllowed(wasLive ? 'probation' : 'paper'),
      reason: `Scoring version changed (${prev.version} → ${version}) — prior track record not merged; re-proving from scratch.`,
      versionReset: true,
    };
  }

  const n = stats && Number.isFinite(stats.excessN) ? stats.excessN : 0;
  const wasLive = prev && (prev.status === 'production' || prev.status === 'reduced' || prev.status === 'probation' || prev.status === 'reduce-only');
  const nowMs = opts.nowMs ?? Date.now();

  // GRANDFATHER LANDING (gov-v3). A strategy that WAS live and no longer qualifies goes
  // reduce-only for a bounded window, then expires to paper automatically. `demote`
  // centralises that so every non-qualifying branch lands the same way.
  const demote = (reason, extra = {}) => {
    if (!wasLive) return { ...base, status: 'paper', weight: 0, newPositions: false, reason, versionReset: false, ...extra };
    const gf = grandfatherState(prev, nowMs);
    if (gf.expired) {
      return {
        ...base, status: 'paper', weight: 0, newPositions: false, versionReset: false,
        reason: `${reason} The grandfather window expired on ${gf.grandfatherExpiresAt} with no renewed evidence — clearance has lapsed to paper automatically.`,
        grandfathered: false, grandfatheredSince: gf.grandfatheredSince, grandfatherExpiresAt: gf.grandfatherExpiresAt, grandfatherExpired: true,
        ...extra,
      };
    }
    return {
      ...base, status: 'reduce-only', weight: weightFor('reduce-only'), newPositions: false, versionReset: false,
      reason: `${reason} Grandfathered REDUCE-ONLY for ${gf.daysLeft} more day(s) (expires ${gf.grandfatherExpiresAt}): manage existing exposure only — it cannot originate a new position, and clearance lapses automatically without renewed evidence.`,
      grandfathered: true, grandfatheredSince: gf.grandfatheredSince, grandfatherExpiresAt: gf.grandfatherExpiresAt, grandfatherExpired: false,
      ...extra,
    };
  };

  if (grade === 'disabled') {
    return { ...base, status: 'disabled', weight: 0, newPositions: false, reason: g.reason || 'Significantly underperforms its benchmark.', versionReset: false };
  }
  if (grade === 'validated' && n >= MIN_VERDICT) {
    // The earned grade converts to LIVE clearance only through a reviewable, semantically
    // valid, version-matched promotion artifact. An evidence grade is an INPUT to
    // promotion, never the promotion itself.
    // IDENTITY-BOUND APPROVAL (Phase 4): the artifact must match EVERY axis of the
    // strategy's canonical evidence identity — scoring, label, execution policy and
    // benchmark versions. Old evidence cannot validate a changed algorithm.
    const identity = g.identity ? {
      labelVersion: g.identity.labelVersion,
      executionPolicyVersion: g.identity.executionPolicyVersion,
      benchmarkVersion: g.identity.benchmarkVersion,
    } : null;
    // An identity we cannot fully establish is LEGACY_CONTEXT — it may be displayed as
    // history, but it can never promote anything (fail closed).
    if (g.mayGovern === false) {
      return demote(
        `Evidence identity is incomplete (${(g.identityMissingAxes || []).join(', ') || 'unknown axes'}) — this record is LEGACY CONTEXT and cannot govern, calibrate or promote a current strategy.`,
        { identityClass: 'LEGACY_CONTEXT', lifecycleClass: PA.LIFECYCLE_CLASS.LEGACY_OPERATIONAL });
    }
    const findings = promotionArtifactFindings(artifact, version, { ...opts, identity, requiresProbability: !!g.displaysProbability });
    if (findings.length) {
      const shown = findings.slice(0, 3).map(f => `[${f.code}] ${f.detail}`).join('; ') + (findings.length > 3 ? ` (+${findings.length - 3} more)` : '');
      return demote(
        `Validated grade earned, but the promotion artifact fails closed: ${shown}. Promotion requires a complete, semantically valid, version-matched, unexpired approval record (governance/promotion-artifacts.json per docs/model-promotion-policy.md).`,
        { awaitingPromotionArtifact: true, artifactProblems: findings.map(f => `[${f.code}] ${f.detail}`), artifactFindings: findings, lifecycleClass: PA.LIFECYCLE_CLASS.LEGACY_OPERATIONAL });
    }
    if (isWeakening(stats, prev)) {
      return { ...base, status: 'reduced', weight: weightFor('reduced'), newPositions: true, lifecycleClass: PA.LIFECYCLE_CLASS.VALIDATED_EXECUTABLE, reason: 'Proven, but the recent resolved record is weakening — size cut until it re-proves.', versionReset: false };
    }
    return { ...base, status: 'production', weight: 1, newPositions: true, lifecycleClass: PA.LIFECYCLE_CLASS.VALIDATED_EXECUTABLE, reason: g.reason || 'Beats its benchmark over a full sample (complete, current promotion artifact on record).', versionReset: false };
  }
  if (grade === 'promising') {
    return demote(`Positive but unproven (${n} resolved) — the promotion gates are not met.`,
      { lifecycleClass: wasLive ? PA.LIFECYCLE_CLASS.LEGACY_OPERATIONAL : PA.LIFECYCLE_CLASS.RESEARCH_PROMISING });
  }
  // experimental / accruing → paper (or the grandfather lane if it was live).
  return demote(n >= MIN_PROMISING ? 'Mixed record — no verdict.' : `Accruing (${n} resolved) — no verdict yet.`,
    { lifecycleClass: wasLive ? PA.LIFECYCLE_CLASS.LEGACY_OPERATIONAL : PA.LIFECYCLE_CLASS.RESEARCH_PROMISING });
}

// Govern a whole classified registry. `classified` = lib/maturity classifyStrategies()
// result. `prevMap` = Map(id → prior governance record). Returns the governed list
// (strongest status first) + a per-status tally + the total cleared weight budget.
function governRegistry(classified, prevMap, artifacts, opts = {}) {
  const strategies = (classified && classified.strategies) || [];
  const prev = prevMap instanceof Map ? prevMap : new Map(Object.entries(prevMap || {}));
  // STRICT artifacts-doc shape: only { strategies: { <id>: artifact } } (or a Map) is
  // accepted. gov-v2 fell back to treating the WHOLE doc as the id→artifact map, so a
  // malformed doc was coerced instead of rejected — fail closed now.
  const arts = artifacts instanceof Map ? artifacts
    : new Map(Object.entries((artifacts && typeof artifacts === 'object' && artifacts.strategies && typeof artifacts.strategies === 'object') ? artifacts.strategies : {}));
  const governed = strategies.map(s => governStrategy(s, prev.get(s.id) || null, arts.get(s.id) || null, opts));
  governed.sort((a, b) => (STATUS_META[b.status].rank - STATUS_META[a.status].rank)
    || ((b.stats?.excessN || 0) - (a.stats?.excessN || 0))
    || String(a.label || a.id).localeCompare(String(b.label || b.id)));
  const counts = {};
  for (const st of STATUSES) counts[st] = governed.filter(x => x.status === st).length;
  return {
    version: GOVERNANCE_VERSION,
    generatedAt: (classified && classified.generatedAt) || null,
    counts,
    clearedWeight: +governed.reduce((a, x) => a + weightFor(x.status), 0).toFixed(2),
    production: governed.filter(x => x.status === 'production').map(x => x.id),
    // Strategies live by history rather than by evidence — reduce-only and time-limited.
    grandfathered: governed.filter(x => x.grandfathered).map(x => ({ id: x.id, expiresAt: x.grandfatherExpiresAt })),
    strategies: governed,
  };
}

module.exports = {
  GOVERNANCE_VERSION, STATUS_META, STATUSES, GRANDFATHER_WINDOW_DAYS,
  weightFor, newPositionsAllowed, isWeakening,
  REQUIRED_ARTIFACT_FIELDS, promotionArtifactProblems, promotionArtifactFindings,
  validPromotionArtifact, grandfatherState,
  governStrategy, governRegistry,
};

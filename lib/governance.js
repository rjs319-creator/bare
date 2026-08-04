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

const GOVERNANCE_VERSION = 'gov-v2.1';

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

// Every reason the artifact fails, or [] when it is valid. `evidenceHash` (when the
// caller knows the CURRENT Scoreboard evidence hash) must match the artifact's — a
// fresh governance rewrite must not resurrect an approval judged on other evidence.
function promotionArtifactProblems(artifact, version, { nowMs = Date.now(), evidenceHash = null } = {}) {
  if (!artifact) return ['no promotion artifact on record'];
  const problems = [];
  if (artifact.revoked === true) problems.push('artifact is REVOKED');
  for (const f of REQUIRED_ARTIFACT_FIELDS) {
    const v = artifact[f];
    if (v === undefined || v === null || v === '') problems.push(`missing required field '${f}'`);
  }
  if (artifact.approve !== undefined && artifact.approve !== true) problems.push('approve is not true');
  if (artifact.version && (!version || artifact.version !== version)) problems.push(`scoring-version mismatch (artifact ${artifact.version} vs current ${version || '?'})`);
  if (artifact.approvedAt && !Number.isFinite(Date.parse(artifact.approvedAt))) problems.push('approvedAt is not a parseable timestamp');
  if (artifact.expiresAt) {
    const exp = Date.parse(artifact.expiresAt);
    if (!Number.isFinite(exp)) problems.push('expiresAt is not a parseable timestamp');
    else if (exp <= nowMs) problems.push(`artifact EXPIRED at ${artifact.expiresAt}`);
  }
  if (evidenceHash && artifact.evidenceHash && artifact.evidenceHash !== evidenceHash) {
    problems.push('evidenceHash does not match the current Scoreboard evidence — approval was judged on different evidence');
  }
  return problems;
}

function validPromotionArtifact(artifact, version, opts = {}) {
  return promotionArtifactProblems(artifact, version, opts).length === 0;
}

// The status ladder. `weight` = the fraction of a model's nominal position size it is
// cleared to drive (governance is what makes the Scoreboard *control* the app, not just
// report on it). rank orders strongest → weakest for sorting.
const STATUS_META = {
  production: { label: 'Production',   icon: '🟢', weight: 1.0,  rank: 6, blurb: 'Proven vs benchmark over a full sample — cleared for full size.' },
  reduced:    { label: 'Reduced',      icon: '🔵', weight: 0.5,  rank: 5, blurb: 'Was proven but the recent record is weakening — size cut while it re-proves.' },
  probation:  { label: 'Probation',    icon: '🟠', weight: 0.25, rank: 4, blurb: 'Fell from a live status; on a short leash pending its next resolved picks.' },
  paper:      { label: 'Paper-only',   icon: '⚪', weight: 0.0,  rank: 3, blurb: 'Not yet proven (or context-only) — logged and tracked, never sized.' },
  disabled:   { label: 'Disabled',     icon: '⛔', weight: 0.0,  rank: 2, blurb: 'Resolved record significantly underperforms its benchmark — turned off.' },
  retired:    { label: 'Retired',      icon: '🗄️', weight: 0.0,  rank: 1, blurb: 'Superseded or withdrawn from service — kept for the record only.' },
};
const STATUSES = Object.keys(STATUS_META);

function weightFor(status) { return (STATUS_META[status] || STATUS_META.paper).weight; }

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
  if (g.retired) return { ...base, status: 'retired', weight: 0, reason: g.note || 'Withdrawn from service.', versionReset: false };

  // Context-only classes are never sized, regardless of grade.
  if (g.kind === 'informational' || grade === 'informational') {
    return { ...base, status: 'paper', weight: 0, reason: 'Context / awareness signal — informative, never sized.', versionReset: false };
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
      reason: `Scoring version changed (${prev.version} → ${version}) — prior track record not merged; re-proving from scratch.`,
      versionReset: true,
    };
  }

  const n = stats && Number.isFinite(stats.excessN) ? stats.excessN : 0;
  const wasLive = prev && (prev.status === 'production' || prev.status === 'reduced' || prev.status === 'probation');

  if (grade === 'disabled') {
    return { ...base, status: 'disabled', weight: 0, reason: g.reason || 'Significantly underperforms its benchmark.', versionReset: false };
  }
  if (grade === 'validated' && n >= MIN_VERDICT) {
    // gov-v2: the earned grade converts to LIVE clearance only through a reviewable,
    // version-matched promotion artifact. Without one the strategy holds at paper
    // (or probation if it was live) — an evidence grade is an input to promotion,
    // never the promotion itself.
    const artifactProblems = promotionArtifactProblems(artifact, version, opts);
    if (artifactProblems.length) {
      const st = wasLive ? 'probation' : 'paper';
      const shown = artifactProblems.slice(0, 3).join('; ') + (artifactProblems.length > 3 ? ` (+${artifactProblems.length - 3} more)` : '');
      return {
        ...base, status: st, weight: weightFor(st),
        reason: `Validated grade earned, but the promotion artifact fails closed: ${shown}. Promotion requires a complete, version-matched, unexpired approval record (governance/promotion-artifacts.json per docs/model-promotion-policy.md).`,
        versionReset: false, awaitingPromotionArtifact: true, artifactProblems,
      };
    }
    if (isWeakening(stats, prev)) {
      return { ...base, status: 'reduced', weight: weightFor('reduced'), reason: 'Proven, but the recent resolved record is weakening — size cut until it re-proves.', versionReset: false };
    }
    return { ...base, status: 'production', weight: 1, reason: g.reason || 'Beats its benchmark over a full sample (promotion artifact on record).', versionReset: false };
  }
  if (grade === 'promising') {
    // A demotion from a live status lands on probation; a fresh promising model is paper.
    return wasLive
      ? { ...base, status: 'probation', weight: weightFor('probation'), reason: 'Slipped from a live status to merely promising — on probation pending confirmation.', versionReset: false }
      : { ...base, status: 'paper', weight: 0, reason: `Positive but unproven (${n} resolved) — paper-only until it earns Production.`, versionReset: false };
  }
  // experimental / accruing → paper.
  return { ...base, status: 'paper', weight: 0, reason: n >= MIN_PROMISING ? 'Mixed record — paper-only, no verdict.' : `Accruing (${n} resolved) — paper-only.`, versionReset: false };
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
    strategies: governed,
  };
}

module.exports = {
  GOVERNANCE_VERSION, STATUS_META, STATUSES, weightFor, isWeakening,
  REQUIRED_ARTIFACT_FIELDS, promotionArtifactProblems, validPromotionArtifact,
  governStrategy, governRegistry,
};

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

const GOVERNANCE_VERSION = 'gov-v1';

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
// Returns { id, status, weight, reason, versionReset, stats, grade, version }.
function governStrategy(graded, prev) {
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
    if (isWeakening(stats, prev)) {
      return { ...base, status: 'reduced', weight: weightFor('reduced'), reason: 'Proven, but the recent resolved record is weakening — size cut until it re-proves.', versionReset: false };
    }
    return { ...base, status: 'production', weight: 1, reason: g.reason || 'Beats its benchmark over a full sample.', versionReset: false };
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
function governRegistry(classified, prevMap) {
  const strategies = (classified && classified.strategies) || [];
  const prev = prevMap instanceof Map ? prevMap : new Map(Object.entries(prevMap || {}));
  const governed = strategies.map(s => governStrategy(s, prev.get(s.id) || null));
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
  governStrategy, governRegistry,
};

'use strict';
// OMEGA-SWING CANDIDATE-FUNNEL SNAPSHOT (omega-funnel-v1) — Phase 4.
//
// THE PROBLEM THIS SOLVES: OMEGA re-ranks the LIVE op=today candidate funnel, but the historical
// walk-forward scans a STATIC present-day universe. So the replay answers a DIFFERENT question
// than live OMEGA, and the honesty flags stamp historicalLiveParity=false / survivorshipSafe=false
// — which structurally blocks any challenger promotion (see lib/omega-backfill.evaluateGates).
//
// The only way to earn live-funnel parity is to CAPTURE the exact candidate funnel prospectively,
// point-in-time, every day, so that a future replay can reproduce it. This module builds that
// immutable, versioned snapshot: the complete op=today candidate set OMEGA saw, each candidate's
// SOURCE strategy + raw score + WITHIN-STRATEGY normalized rank, the eligibility filter + cap that
// were applied, and what OMEGA ultimately selected/ranked — plus the regime and universe id.
//
// Cross-strategy comparability (§4): raw scores from unrelated screeners are NOT comparable, so we
// normalize WITHIN strategy-and-date (percentile) before the union is OMEGA-ranked.
//
// Pure & deterministic (no network/clock/store). The caller supplies the date, the op=today
// payload, and the OMEGA cards. Nothing here fabricates a candidate or a timestamp.

const OMEGA_FUNNEL_VERSION = 'omega-funnel-v1';

// The momentum-relevant families OMEGA-SWING considers (mirrors omega-swing-routes). Exported so
// there is ONE definition of the eligibility rule that the snapshot records.
const MOMENTUM_FAMILIES = Object.freeze(['trend', 'earlyMomentum', 'event', 'intraday']);
const DEFAULT_SHORTLIST_MAX = 60;

const finite = (x) => Number.isFinite(x);
const orNull = (v) => (v === undefined ? null : v);

// Average-rank percentile (0-100) of each value within its group; higher score → higher percentile.
function percentileRank(values) {
  const present = values.map((v, i) => [v, i]).filter(x => finite(x[0]));
  const out = values.map(() => null);
  const n = present.length;
  if (n === 0) return out;
  if (n === 1) { out[present[0][1]] = 100; return out; }
  present.sort((a, b) => a[0] - b[0]);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && present[j + 1][0] === present[i][0]) j++;
    const p = Math.round(((i + j) / 2 / (n - 1)) * 100);
    for (let k = i; k <= j; k++) out[present[k][1]] = p;
    i = j + 1;
  }
  return out;
}

// Normalize source scores WITHIN each strategy family (§4). Adds sourceRankInStrategy (1 = best)
// and sourcePercentileInStrategy so a union of candidates from unrelated screeners can be OMEGA-
// ranked without comparing raw scores that live on different scales.
function normalizeWithinStrategy(candidates) {
  const byFam = new Map();
  candidates.forEach((c, i) => {
    const fam = c.sourceStrategy || 'unknown';
    if (!byFam.has(fam)) byFam.set(fam, []);
    byFam.get(fam).push(i);
  });
  const out = candidates.map(c => ({ ...c }));
  for (const idxs of byFam.values()) {
    const scores = idxs.map(i => (finite(candidates[i].sourceRawScore) ? candidates[i].sourceRawScore : null));
    const pcts = percentileRank(scores);
    // rank within family: 1 = highest score (nulls last, stable).
    const ordered = idxs.slice().sort((a, b) => (candidates[b].sourceRawScore ?? -Infinity) - (candidates[a].sourceRawScore ?? -Infinity));
    ordered.forEach((gi, r) => { out[gi].sourceRankInStrategy = r + 1; });
    idxs.forEach((gi, k) => { out[gi].sourcePercentileInStrategy = pcts[k]; });
  }
  return out;
}

// Collect the COMPLETE op=today candidate set OMEGA considered. Dedup by ticker (keeping the
// highest-scoring source), tagging each with its winning source family, horizon and eligibility.
// `familyFilter` decides eligibility; everything is captured (eligible AND ineligible) so a future
// learner sees the names OMEGA's funnel turned down, not only the ones it kept.
function collectCandidates(today, { familyFilter = MOMENTUM_FAMILIES } = {}) {
  const famSet = new Set(familyFilter);
  const horizons = (today && today.horizons) || {};
  const byTicker = new Map();
  for (const [h, arr] of Object.entries(horizons)) {
    for (const s of arr || []) {
      if (!s || !s.ticker) continue;
      const fam = s.strategyFamily || null;
      const eligible = fam ? famSet.has(fam) : ['intraday', 'swing', 'position'].includes(h);
      const cand = {
        ticker: s.ticker, sourceStrategy: fam || h, sourceRawScore: finite(s.score) ? +s.score : null,
        sourceRankInFunnel: finite(s.rank) ? s.rank : null, horizon: s.horizon || h,
        sector: s.sector || null, eligible,
      };
      const cur = byTicker.get(s.ticker);
      if (!cur || (cand.sourceRawScore ?? -Infinity) > (cur.sourceRawScore ?? -Infinity)) byTicker.set(s.ticker, cand);
    }
  }
  return [...byTicker.values()];
}

// Deterministic snapshot id from (version, date, candidate-set fingerprint) — no clock/random.
function snapshotId(date, candidates) {
  const fp = candidates.map(c => c.ticker).sort().join(',');
  let h = 0; for (let i = 0; i < fp.length; i++) { h = ((h << 5) - h + fp.charCodeAt(i)) | 0; }
  return `${OMEGA_FUNNEL_VERSION}:${date || 'nodate'}:${(h >>> 0).toString(36)}:${candidates.length}`;
}

// Build the immutable funnel snapshot. `omegaCards` are OMEGA's ranked output (sorted best→worst)
// so we can record what OMEGA SELECTED and its OMEGA rank/tier per candidate.
function buildFunnelSnapshot({ date, today, omegaCards = [], meta = {} } = {}) {
  const familyFilter = meta.familyFilter || MOMENTUM_FAMILIES;
  const cap = finite(meta.candidateCap) ? meta.candidateCap : DEFAULT_SHORTLIST_MAX;
  const raw = collectCandidates(today, { familyFilter });
  const normalized = normalizeWithinStrategy(raw);

  // OMEGA's selection + rank per ticker (cards are already utility-sorted).
  const omegaByTicker = new Map();
  omegaCards.forEach((c, i) => omegaByTicker.set(c.ticker, { omegaRank: i + 1, omegaTier: c.tier, omegaScore: c.score }));
  // The capped, eligible shortlist OMEGA actually scored (eligible names by source score, capped).
  const eligibleSorted = normalized.filter(c => c.eligible).sort((a, b) => (b.sourceRawScore ?? -Infinity) - (a.sourceRawScore ?? -Infinity));
  const selectedSet = new Set(eligibleSorted.slice(0, cap).map(c => c.ticker));

  const candidates = normalized.map(c => {
    const om = omegaByTicker.get(c.ticker) || null;
    return Object.freeze({
      ticker: c.ticker, sourceStrategy: c.sourceStrategy,
      sourceStrategyVersion: meta.sourceStrategyVersion || null,   // op=today schema version (coarse)
      sourceRawScore: c.sourceRawScore, sourceRankInFunnel: c.sourceRankInFunnel,
      sourceRankInStrategy: orNull(c.sourceRankInStrategy), sourcePercentileInStrategy: orNull(c.sourcePercentileInStrategy),
      horizon: c.horizon, sector: c.sector, eligible: c.eligible,
      selected: selectedSet.has(c.ticker),
      omegaRank: om ? om.omegaRank : null, omegaTier: om ? om.omegaTier : null, omegaScore: om ? om.omegaScore : null,
    });
  });

  // Per-strategy roster (count + version) — the "strategy family and version" the spec asks for.
  const strategies = {};
  for (const c of candidates) {
    const k = c.sourceStrategy;
    (strategies[k] = strategies[k] || { count: 0, eligible: 0, version: c.sourceStrategyVersion });
    strategies[k].count++; if (c.eligible) strategies[k].eligible++;
  }

  const regime = (today && today.regime) || meta.regime || null;
  return Object.freeze({
    schema: 'OmegaFunnelSnapshot', version: OMEGA_FUNNEL_VERSION,
    snapshotId: snapshotId(date, candidates), date: orNull(date),
    generatedAt: orNull(meta.generatedAt),          // caller supplies the timestamp (no clock here)
    provenance: 'prospective_live',
    regime: regime ? { label: regime.label || (regime.bearish ? 'risk-off' : regime.riskOn ? 'risk-on' : 'neutral'), riskOn: regime.riskOn === true, bearish: regime.bearish === true } : null,
    universeSnapshotId: orNull(meta.universeSnapshotId),
    eligibilityVersion: OMEGA_FUNNEL_VERSION, familyFilter: [...familyFilter], candidateCap: cap,
    strategies,
    counts: {
      total: candidates.length,
      eligible: candidates.filter(c => c.eligible).length,
      selected: candidates.filter(c => c.selected).length,
      ranked: candidates.filter(c => c.omegaRank != null).length,
    },
    candidates,
  });
}

function validateFunnelSnapshot(s) {
  const errors = [];
  const req = (ok, msg) => { if (!ok) errors.push(msg); };
  req(s && s.schema === 'OmegaFunnelSnapshot', 'wrong schema');
  req(typeof (s && s.date) === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.date), 'date (YYYY-MM-DD) required');
  req(Array.isArray(s && s.candidates), 'candidates array required');
  req(s && s.provenance === 'prospective_live', 'a captured funnel must be prospective_live');
  return { valid: errors.length === 0, errors };
}

// Assess live-funnel parity for a set of cohort dates against captured snapshot dates. Parity is
// TRUE only when EVERY cohort date has a captured funnel snapshot (fail closed).
function assessFunnelParity(cohortDates = [], snapshotDates = []) {
  const snaps = new Set(snapshotDates);
  const cohorts = [...new Set(cohortDates)];
  const parityDates = cohorts.filter(d => snaps.has(d));
  const coveragePct = cohorts.length ? +(100 * parityDates.length / cohorts.length).toFixed(1) : 0;
  return {
    historicalLiveParity: cohorts.length > 0 && parityDates.length === cohorts.length,
    coveragePct, coveredDates: parityDates.length, cohortDates: cohorts.length,
    capturedSnapshots: snaps.size,
  };
}

module.exports = {
  OMEGA_FUNNEL_VERSION, MOMENTUM_FAMILIES, DEFAULT_SHORTLIST_MAX,
  percentileRank, normalizeWithinStrategy, collectCandidates, snapshotId,
  buildFunnelSnapshot, validateFunnelSnapshot, assessFunnelParity,
};

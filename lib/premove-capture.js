'use strict';
// PRE-MOVE FULL-CANDIDATE OBSERVATION (premove-ghost-obs-v1) — Phase 1 of the
// pre-move transition redesign (docs/premove-transition-v2.md).
//
// The screener computes `ghostTop` over the FULL scanned cross-section, but the
// decision + learning paths historically consumed only `results` (the breakout
// buffer). That stranded every standalone quiet-accumulation candidate and made
// the Ghost ledger grade a later, breakout-filtered population. This module is
// the repair's capture half: a PURE builder that turns the day's per-scope
// screener payloads into ONE immutable full-candidate observation record —
// selected standalone candidates, rejected/low-tier candidates, near-threshold
// candidates — with complete point-in-time provenance, so a future Stage-A
// learner can train on selected AND rejected rows without selection bias.
//
// Honesty rules:
//   - SHADOW ONLY. Nothing here touches production ranks; the record is written
//     to its own Blob prefix (ghostobs/) and consumed by the shadow pre-move
//     inventory. Standalone Ghost stays weight-zero until independently validated.
//   - FAIL CLOSED. A row with unknown price or unknown dollar-volume liquidity is
//     never admitted as a candidate — it lands in `excluded` with a reason.
//   - MISSING IS MISSING. Absent fields get explicit `missing` markers, never
//     imputed bullish values.
//   - Trigger/no-trigger state starts 'unresolved'; resolution happens later
//     against real forward candles, never at capture time.
//
// Pure & dependency-free: JSON in, frozen record out. No network, no clock —
// dates are supplied by the caller.

const PREMOVE_OBS_VERSION = 'premove-ghost-obs-v1';

// Deterministic scope preference for cross-scope dedup: when the same ticker is
// observed in several universe scopes, the primary row comes from the scope with
// the higher Ghost score; ties break by this fixed order (never by Map iteration).
const SCOPE_PRIORITY = Object.freeze(['large', 'small', 'micro', 'expanded', 'biotech']);

// Tiers that count as a standalone quiet-accumulation SELECTION vs. observation.
const SELECTED_TIERS = Object.freeze(['GHOST', 'STALKING']);
// A WATCH row within this many Ghost-score points of the day's lowest selected
// score is "near-threshold" — the counterfactual band calibration needs.
const NEAR_THRESHOLD_MARGIN = 5;

const num = (v) => (Number.isFinite(v) ? v : null);
const scopeRank = (s) => {
  const i = SCOPE_PRIORITY.indexOf(String(s || '').toLowerCase());
  return i === -1 ? SCOPE_PRIORITY.length : i;
};

// Normalize one ghostTop row from one scope into the observation shape.
// Returns { row } or { excluded } — unknown price/liquidity fails closed.
function normalizeRow(raw, scope, scopeMeta = {}) {
  if (!raw || !raw.ticker || !raw.ghost) return { excluded: { ticker: raw && raw.ticker || null, scope, reason: 'malformed-row' } };
  const price = num(raw.decisionPrice != null ? raw.decisionPrice : raw.price);
  const dollarVol = num(raw.dollarVol != null ? raw.dollarVol : (raw.factors && raw.factors.dollarVol));
  if (price == null || price <= 0) return { excluded: { ticker: raw.ticker, scope, reason: 'missing-decision-price' } };
  if (dollarVol == null) return { excluded: { ticker: raw.ticker, scope, reason: 'missing-liquidity' } };

  const lv = raw.levels || null;
  const trigger = lv ? num(lv.entry) : null;
  const invalidation = lv ? num(lv.stop) : null;
  const missing = [];
  if (!lv) missing.push('levels');
  if (lv && trigger == null) missing.push('trigger-level');
  if (lv && invalidation == null) missing.push('invalidation');
  if (!raw.fundamentals) missing.push('fundamentals');
  if (!raw.insider) missing.push('insider');
  if (raw.featureSnapshot == null && raw.pct == null) missing.push('feature-snapshot');

  const fd = raw.fundamentals || null;
  return {
    row: {
      ticker: raw.ticker,
      company: raw.company || null,
      sector: raw.sector || null,
      scope,
      tier: raw.ghost.tier,
      score: num(raw.ghost.score),
      pillars: raw.ghost.pillars || null,
      strongPillars: raw.ghost.strongPillars || [],
      decisionPrice: price,
      dollarVol,
      liqTier: raw.liqTier || scopeMeta.liqTier || null,
      status: raw.status || null,                    // breakout-base status when one exists
      triggerLevel: trigger,
      invalidation,
      target: lv ? num(lv.target) : null,
      inBreakoutResults: !!raw.inBreakoutResults,
      featureSnapshot: raw.featureSnapshot || (raw.pct ? { pct: raw.pct, quant: raw.quant || null } : null),
      // Timestamped catalyst metadata ONLY when genuinely present — never inferred.
      catalyst: fd && (fd.earningsDate || fd.earningsInDays != null)
        ? { type: 'earnings', date: fd.earningsDate || null, inDays: num(fd.earningsInDays) }
        : null,
      missing,
      dataCutoff: raw.dataCutoff || scopeMeta.dataCutoff || null,
    },
  };
}

// Deterministically merge the same ticker seen in multiple scopes: keep the
// highest-score row (tie → SCOPE_PRIORITY order), retain full scope provenance.
function dedupeAcrossScopes(rows) {
  const byTicker = new Map();
  const sorted = rows.slice().sort((a, b) =>
    (b.score ?? -1) - (a.score ?? -1) || scopeRank(a.scope) - scopeRank(b.scope) || (a.ticker < b.ticker ? -1 : 1));
  for (const r of sorted) {
    const prev = byTicker.get(r.ticker);
    if (!prev) {
      byTicker.set(r.ticker, { ...r, scopes: [{ scope: r.scope, tier: r.tier, score: r.score }] });
    } else {
      byTicker.set(r.ticker, { ...prev, scopes: [...prev.scopes, { scope: r.scope, tier: r.tier, score: r.score }] });
    }
  }
  return [...byTicker.values()].map(r => ({
    ...r,
    scopes: r.scopes.slice().sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope)),
  }));
}

// Build the day's immutable full-candidate observation record.
//   input: {
//     date,                      // decision date (ET trading day)
//     eligibleEntryDate,         // earliest executable session (NEXT session, caller-computed)
//     scopes: [{ scope, ghostTop:[...], resultsTickers:[...], scannedCount, dataCutoff, generatedAt }],
//   }
function buildGhostObservation(input = {}) {
  const { date = null, eligibleEntryDate = null } = input;
  const scopes = Array.isArray(input.scopes) ? input.scopes : [];

  const normalized = [];
  const excluded = [];
  for (const sc of scopes) {
    const scope = String(sc.scope || '').toLowerCase();
    const inResults = new Set((sc.resultsTickers || []).filter(Boolean));
    for (const raw of sc.ghostTop || []) {
      const marked = raw && raw.ticker ? { ...raw, inBreakoutResults: inResults.has(raw.ticker) } : raw;
      const { row, excluded: ex } = normalizeRow(marked, scope, { dataCutoff: sc.dataCutoff || null });
      if (ex) excluded.push(ex);
      else normalized.push(row);
    }
  }

  const deduped = dedupeAcrossScopes(normalized);

  // Selected = standalone quiet accumulation (GHOST/STALKING, not already a
  // breakout-results row — those are represented by the screener adapter and
  // must not be double-counted as independent confirmation of themselves).
  const selected = deduped.filter(r => SELECTED_TIERS.includes(r.tier) && !r.inBreakoutResults);
  const alsoInBreakout = deduped.filter(r => SELECTED_TIERS.includes(r.tier) && r.inBreakoutResults);
  const lowTier = deduped.filter(r => !SELECTED_TIERS.includes(r.tier));
  const minSelectedScore = selected.length ? Math.min(...selected.map(r => r.score ?? Infinity)) : null;
  const nearThreshold = minSelectedScore == null ? [] :
    lowTier.filter(r => r.score != null && r.score >= minSelectedScore - NEAR_THRESHOLD_MARGIN);
  const nearSet = new Set(nearThreshold.map(r => r.ticker));
  const rejected = lowTier.filter(r => !nearSet.has(r.ticker));

  const universeSnapshotId = 'ghostobs:' + (date || 'undated') + ':' +
    scopes.map(sc => `${String(sc.scope || '?').toLowerCase()}#${sc.scannedCount ?? '?'}`)
      .sort().join('|');

  const stampOutcome = (r) => Object.freeze({
    ...r,
    // Eventual trigger/no-trigger state — resolved LATER against forward candles.
    outcome: { state: 'unresolved', resolvedAt: null },
  });

  return Object.freeze({
    schema: 'GhostFullObservation',
    version: PREMOVE_OBS_VERSION,
    date,
    decisionDate: date,
    eligibleEntryDate,
    featureVersion: PREMOVE_OBS_VERSION,
    universeSnapshotId,
    scopesSeen: scopes.map(sc => ({
      scope: String(sc.scope || '?').toLowerCase(),
      scannedCount: sc.scannedCount ?? null,
      dataCutoff: sc.dataCutoff || null,
      generatedAt: sc.generatedAt || null,
    })),
    counts: {
      observed: deduped.length,
      selected: selected.length,
      alsoInBreakout: alsoInBreakout.length,
      rejected: rejected.length,
      nearThreshold: nearThreshold.length,
      excluded: excluded.length,
    },
    selected: Object.freeze(selected.map(stampOutcome)),
    alsoInBreakout: Object.freeze(alsoInBreakout.map(stampOutcome)),
    nearThreshold: Object.freeze(nearThreshold.map(stampOutcome)),
    rejected: Object.freeze(rejected.map(stampOutcome)),
    excluded: Object.freeze(excluded),
  });
}

module.exports = {
  PREMOVE_OBS_VERSION, SCOPE_PRIORITY, SELECTED_TIERS, NEAR_THRESHOLD_MARGIN,
  buildGhostObservation, dedupeAcrossScopes, normalizeRow,
};

// DAILY NO-TRADE / OPPORTUNITY-DENSITY MODEL (spec §6)
//
// The board always produced a ranked list — even on a day when nothing is worth trading. This
// answers the question that comes BEFORE "which name?": is the opportunity set strong enough to
// trade at all? It scores the day from the actual quality of today's candidates (best net edge,
// how many names have real edge left, how fresh they are, evidence breadth, and their classes'
// realized track record) and returns one decision: normal / selective / reduced / no-trade,
// plus a recommended max exposure and per-horizon availability.
//
// DISCIPLINE (spec §6): "a bullish market regime alone must not force a positive trading
// recommendation." Regime is only ever a PENALTY here (risk-off pulls the score down and caps
// exposure) — never a booster. A risk-on tape with weak candidates scores low and lands on
// selective/reduced, exactly as it should. And the model CAN return no-trade (zero qualifying
// names ⇒ no-trade regardless of score). Pure: enriched active signals + regime in → decision
// out. The route persists it BEFORE outcomes are known (the §6 storage rule).

'use strict';

const OPPORTUNITY_VERSION = 'opportunity-v1';

const CONFIG = {
  TOP_K: 8,                 // how many top-ranked names define "the opportunity set"
  EDGE_FULL_PCT: 10,        // net edge (%) that maxes the best-edge component
  DEPTH_FULL: 6,            // qualifying-name count that maxes the depth component
  BREADTH_FULL: 3,          // independent-evidence families that maxes the breadth component
  // Component weights (sum to 1). Edge + depth + freshness dominate; track record and breadth
  // corroborate; raw quality is a light tiebreak.
  W: { bestEdge: 0.24, depth: 0.20, freshness: 0.18, track: 0.16, breadth: 0.12, quality: 0.10 },
  // Decision thresholds on the regime-GATED score.
  NORMAL_AT: 62, SELECTIVE_AT: 45, REDUCED_AT: 28,
  // Recommended max exposure per decision (%). Risk-off additionally caps at RISK_OFF_CAP.
  EXPOSURE: { normal: 100, selective: 66, reduced: 33, 'no-trade': 0 },
  RISK_OFF_MULT: 0.5,       // risk-off halves the score (longs stand down — the validated lever)
  RISK_OFF_CAP: 33,         // and caps exposure regardless of decision
  // Same-day TAPE gate (fixes the "Normal/100% on a red choppy day" inconsistency): the breadth-
  // based regime is a slow read; the day's actual tape can be red/choppy while regime still says
  // risk-on. A red or choppy tape penalizes the score + caps exposure the same way — never boosts.
  RED_TAPE_SPY: -0.4,       // SPY same-day % at/below which the tape is "red" (matches the UI banner)
  RED_TAPE_MULT: 0.5,       // red tape halves the score — momentum longs don't work on a down day
  RED_TAPE_CAP: 33,
  CHOPPY_EFF: 0.22,         // trend-efficiency below this = choppy (breakouts fail more)
  CHOPPY_MULT: 0.75,
  CHOPPY_CAP: 66,
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const median = (a) => {
  const x = a.filter(Number.isFinite).sort((p, q) => p - q);
  if (!x.length) return null;
  const m = Math.floor(x.length / 2);
  return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2;
};

// The net edge (%) still available on a signal from HERE, after costs. Prefers the remaining-
// edge read (measured from the origin); falls back to the trade's full net target move when no
// origin has accrued yet (day 1); null for a lead with no levels — which cannot qualify.
function netEdgeOf(sig) {
  const re = sig.remainingEdge;
  if (re && re.rated && Number.isFinite(re.netRemainingPct)) return re.netRemainingPct;
  if (sig.cost && sig.cost.known && Number.isFinite(sig.cost.netMovePct)) return sig.cost.netMovePct;
  return null;
}

// Is this signal a genuinely tradeable opportunity right now — real net edge left AND not
// already consumed/extended? (The active pool already excludes failed/expired/resolved.)
function isQualifying(sig) {
  const edge = netEdgeOf(sig);
  if (!(edge > 0)) return false;
  const re = sig.remainingEdge;
  if (re && re.rated && ['partially-consumed', 'late', 'expired'].includes(re.freshness)) return false;
  if (sig.state === 'extended') return false;
  return true;
}

// signals: the ACTIVE enriched signals from rankSignals (actionable only). regime: live regime.
function computeOpportunityDensity(signals, { regime = {}, tape = null, config = {} } = {}) {
  const cfg = { ...CONFIG, ...config, W: { ...CONFIG.W, ...(config.W || {}) }, EXPOSURE: { ...CONFIG.EXPOSURE, ...(config.EXPOSURE || {}) } };
  const active = (signals || []).filter(Boolean);
  const riskOff = regime.bearish === true || regime.riskOn === false || regime.killSwitch === true;
  // Same-day tape read (op=tape), independent of the slow breadth regime.
  const t = tape || {};
  const redTape = (Number.isFinite(t.spyChangePct) && t.spyChangePct <= cfg.RED_TAPE_SPY) || t.regime === 'risk-off' || t.condition === 'riskoff';
  const choppyTape = t.condition === 'choppy' || (Number.isFinite(t.efficiency) && t.efficiency < cfg.CHOPPY_EFF);

  const qualifying = active.filter(isQualifying);
  const qualifyingCount = qualifying.length;
  const top = active.slice(0, cfg.TOP_K); // already rank-ordered upstream

  // Per-horizon availability (answers "strategy availability by horizon").
  const byHorizon = {};
  for (const h of ['intraday', 'swing', 'position', 'portfolio']) {
    const q = qualifying.filter(s => s.horizon === h).length;
    byHorizon[h] = { qualifying: q, availability: q >= 2 ? 'available' : q === 1 ? 'thin' : 'none' };
  }

  // ── Components (each 0..1), all read from what the board already computed ──────────────
  // "Best-pick edge" is the edge on the top-RANKED qualifying name — the pick you'd actually
  // take — NOT the global max, which a single far-target moonshot would dominate and mislead.
  const bestEdge = qualifying.length ? (netEdgeOf(qualifying[0]) || 0) : 0;
  const cBestEdge = clamp01(bestEdge / cfg.EDGE_FULL_PCT);
  const cDepth = clamp01(qualifyingCount / cfg.DEPTH_FULL);
  // Freshness: share of the active board NOT already consumed/extended (spec's "% extended", inverted).
  const consumed = active.filter(s => {
    const re = s.remainingEdge;
    return (re && re.rated && ['partially-consumed', 'late', 'expired'].includes(re.freshness)) || s.state === 'extended';
  }).length;
  const cFresh = active.length ? clamp01(1 - consumed / active.length) : 0;
  // Breadth: median independent-evidence families across the top set (2+ = corroborated).
  const medFam = median(top.map(s => (s.evidence && s.evidence.familyCount) || 1)) || 1;
  const cBreadth = clamp01((medFam - 1) / (cfg.BREADTH_FULL - 1));
  // Track record (recent calibration / false-breakout proxy): median realized expectancy tilt of
  // the top set, mapped from [0.7,1.3] → [0,1]. Unknown record → 0.5 (neutral, never a boost).
  const tilts = top.map(s => (Number.isFinite(s.expectancyTilt) ? s.expectancyTilt : 1));
  const medTilt = median(tilts) ?? 1;
  const cTrack = clamp01((medTilt - 0.7) / 0.6);
  // Raw quality: median composite score of the top set.
  const cQuality = clamp01((median(top.map(s => s.score || 0)) || 0) / 100);

  const components = {
    bestEdge: +cBestEdge.toFixed(3), depth: +cDepth.toFixed(3), freshness: +cFresh.toFixed(3),
    track: +cTrack.toFixed(3), breadth: +cBreadth.toFixed(3), quality: +cQuality.toFixed(3),
  };
  const rawScore = +(100 * (
    cfg.W.bestEdge * cBestEdge + cfg.W.depth * cDepth + cfg.W.freshness * cFresh
    + cfg.W.track * cTrack + cfg.W.breadth * cBreadth + cfg.W.quality * cQuality
  )).toFixed(1);
  // Regime + tape are PENALTIES only — they halve/trim; nothing here boosts (§6 discipline). A
  // bull breadth-regime on a red or choppy DAY is still penalized, so the banner can't say
  // "Normal/100%" while the same tape read says "momentum longs won't work today".
  let gateMult = 1, exposureCap = 100;
  if (riskOff) { gateMult *= cfg.RISK_OFF_MULT; exposureCap = Math.min(exposureCap, cfg.RISK_OFF_CAP); }
  if (redTape) { gateMult *= cfg.RED_TAPE_MULT; exposureCap = Math.min(exposureCap, cfg.RED_TAPE_CAP); }
  else if (choppyTape) { gateMult *= cfg.CHOPPY_MULT; exposureCap = Math.min(exposureCap, cfg.CHOPPY_CAP); }
  const score = +(rawScore * gateMult).toFixed(1);

  // ── Decision ──────────────────────────────────────────────────────────────────────────
  let decision;
  if (qualifyingCount === 0) decision = 'no-trade';         // capable of returning no trades
  else if (score >= cfg.NORMAL_AT) decision = 'normal';
  else if (score >= cfg.SELECTIVE_AT) decision = 'selective';
  else if (score >= cfg.REDUCED_AT) decision = 'reduced';
  else decision = 'no-trade';
  const maxExposurePct = Math.min(cfg.EXPOSURE[decision], exposureCap);

  const reasons = buildReasons({ qualifyingCount, bestEdge, medTilt, riskOff, redTape, choppyTape, spyChangePct: t.spyChangePct ?? null, cFresh, consumed, activeN: active.length, decision });
  const LABEL = { normal: 'Normal opportunity', selective: 'Selective', reduced: 'Reduced exposure', 'no-trade': 'No trade' };
  const gateLabel = redTape ? 'Red tape — momentum longs stand down'
    : riskOff ? 'Risk-off — longs stand down'
      : choppyTape ? 'Choppy tape — breakouts fail more'
        : (regime.riskOn ? 'Risk-on' : 'Neutral');
  return {
    version: OPPORTUNITY_VERSION,
    decision, decisionLabel: LABEL[decision],
    score, rawScore, maxExposurePct,
    expectedBestEdgeAfterCostsPct: +bestEdge.toFixed(2),
    qualifyingCount, activeCount: active.length,
    byHorizon, components,
    regimeGate: { riskOff, redTape, choppyTape, spyChangePct: t.spyChangePct ?? null, applied: +gateMult.toFixed(2), label: gateLabel },
    reasons,
  };
}

function buildReasons({ qualifyingCount, bestEdge, medTilt, riskOff, redTape, choppyTape, spyChangePct, cFresh, consumed, activeN, decision }) {
  const r = [];
  if (qualifyingCount === 0) r.push('No name has net edge left after costs — nothing qualifies to trade today.');
  else r.push(`${qualifyingCount} name${qualifyingCount === 1 ? '' : 's'} with real net edge after costs (best ~${bestEdge.toFixed(1)}%).`);
  if (redTape) r.push(`Red tape today${Number.isFinite(spyChangePct) ? ` (SPY ${spyChangePct >= 0 ? '+' : ''}${spyChangePct}%)` : ''} — momentum longs typically don't work on a down day; score halved and exposure capped.`);
  else if (choppyTape) r.push('Choppy / ranging tape — breakouts fail more here; be selective, exposure trimmed.');
  if (riskOff) r.push('Risk-off tape — longs stand down (the one validated lever); score halved and exposure capped.');
  if (medTilt < 0.95) r.push('The top names come from classes with a below-market realized track record.');
  else if (medTilt > 1.05) r.push('The top names come from classes that have beaten the market.');
  if (activeN && consumed / activeN > 0.4) r.push(`${Math.round(consumed / activeN * 100)}% of the board has already run (consumed/extended).`);
  if (decision === 'no-trade' && qualifyingCount > 0) r.push('The opportunity set is too thin/low-edge to justify normal sizing today.');
  return r;
}

module.exports = { OPPORTUNITY_VERSION, CONFIG, netEdgeOf, isQualifying, computeOpportunityDensity };

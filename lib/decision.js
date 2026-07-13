// UNIFIED DECISION ENGINE — the canonical Signal schema + pure ranking layer that
// every screener normalizes into, so the app presents ONE validated, ranked table
// instead of many competing lists. No network, no state → fully unit-testable and
// zero-risk to the running app. Source adapters live in lib/decision-normalizers.js;
// the HTTP op + data fetch lives in lib/decision-routes.js.
//
// Design axioms (from the app's own multi-session research):
//   • Rank by VALIDATED expectancy × confidence × regime-fit × execution × independent
//     evidence — NOT a sum of screener scores.
//   • Correlated indicators off the same price series are ONE confirmation, not many
//     (generalizes lib/confluence.js family-v1 across the whole app).
//   • The one durable lever is regime avoidance — longs stand down in risk-off.

'use strict';

const SCHEMA_VERSION = 'decision-v1';

// ── Horizons (#2 — never mix these) ─────────────────────────────────────────
const HORIZONS = ['intraday', 'swing', 'position', 'portfolio'];
const HORIZON_LABEL = {
  intraday: 'Intraday', swing: 'Swing (days–weeks)',
  position: 'Position (1–6mo)', portfolio: 'Portfolio (factor/regime)',
};
// Which scoreboard horizon key measures each trading horizon's outcome.
const HORIZON_METRIC = { intraday: '1d', swing: '5d', position: '1m', portfolio: '3m' };
// Plain-English expected HOLDING period per horizon — surfaced per-signal so the card
// answers "how long do I hold this?" without the reader having to decode the bucket.
const HOLD_WINDOW = {
  intraday: 'Same session — exit by close',
  swing: 'Days to ~2 weeks',
  position: '~1–6 months',
  portfolio: 'Multi-month — quarterly rebalance',
};

// ── Independent evidence families (#3) ──────────────────────────────────────
// The 9 families a signal's supporting evidence can come from. Two screeners that
// both read the same family are ONE independent confirmation, not two.
const EVIDENCE_FAMILIES = [
  'priceTrend', 'volumeAccum', 'fundamentalsRevisions', 'insider',
  'catalystForcedFlow', 'sentimentAttention', 'optionsPositioning',
  'sectorRegime', 'crossAsset',
];
const FAMILY_LABEL = {
  priceTrend: 'Price / trend', volumeAccum: 'Volume / accumulation',
  fundamentalsRevisions: 'Fundamentals / revisions', insider: 'Insider activity',
  catalystForcedFlow: 'Catalyst / forced flow', sentimentAttention: 'Sentiment / attention',
  optionsPositioning: 'Options positioning', sectorRegime: 'Sector / market regime',
  crossAsset: 'Cross-asset',
};
// Each screener maps to the evidence family it PRIMARILY reads. Used to translate a
// raw screener-count into an independent-family count.
const SOURCE_FAMILY = {
  screener: 'priceTrend', momentum: 'priceTrend', daytrade: 'priceTrend',
  gapgo: 'priceTrend', coil: 'priceTrend', confluence: 'priceTrend',
  ghost: 'volumeAccum', anomaly: 'volumeAccum', stealth: 'volumeAccum',
  tone: 'fundamentalsRevisions', toneshift: 'fundamentalsRevisions', biotech: 'catalystForcedFlow',
  insider: 'insider', cern: 'catalystForcedFlow', gapdown: 'catalystForcedFlow',
  attention: 'sentimentAttention', pulse: 'sentimentAttention', alerts: 'sentimentAttention',
  optionsflow: 'optionsPositioning', putsell: 'optionsPositioning',
  crossasset: 'crossAsset', readthrough: 'crossAsset', secondwave: 'crossAsset',
};

// The within-family correlation discount (mirrors confluence.js CORR_DISCOUNT): the
// first source in a family counts full; each additional agreeing source in the SAME
// family is worth far less (correlated evidence, not independent).
const CORR_DISCOUNT = 0.3;

// ── Signal-domain breadth (#2) ──────────────────────────────────────────────
// The 8 distinct information DOMAINS a real edge can be corroborated across. This is
// a coarser, more legible view than the 9 evidence families: it answers "how many
// genuinely different KINDS of evidence agree?" (price is one kind; a price-and-volume
// confirmation is broader than two price factors). Each family maps to exactly one
// domain; two families that share a domain still only light it once — the honest
// breadth, never double-counted.
const DOMAINS = ['price', 'volume', 'fundamentals', 'news', 'options', 'insiders', 'sentiment', 'regime'];
const DOMAIN_LABEL = {
  price: 'Price', volume: 'Volume', fundamentals: 'Fundamentals', news: 'News / catalyst',
  options: 'Options', insiders: 'Insiders', sentiment: 'Sentiment', regime: 'Regime',
};
// 9 evidence families → 8 signal domains (sectorRegime + crossAsset both = regime).
const FAMILY_DOMAIN = {
  priceTrend: 'price', volumeAccum: 'volume', fundamentalsRevisions: 'fundamentals',
  insider: 'insiders', catalystForcedFlow: 'news', sentimentAttention: 'sentiment',
  optionsPositioning: 'options', sectorRegime: 'regime', crossAsset: 'regime',
};

// Given the families backing a signal, return which of the 8 domains are lit + a count.
// Deliberately domain-deduped: a name confirmed by two price factors lights ONE domain.
function domainBreadth(families) {
  const lit = new Set();
  for (const f of families || []) { const d = FAMILY_DOMAIN[f]; if (d) lit.add(d); }
  return {
    litCount: lit.size,
    of: DOMAINS.length,
    lit: [...lit],
    domains: DOMAINS.map(key => ({ key, label: DOMAIN_LABEL[key], lit: lit.has(key) })),
  };
}

// Given the list of families each supporting signal belongs to, return the honest
// independent-evidence view: how many DISTINCT families agree + a discounted score
// that rewards breadth-of-family over piling votes onto one factor.
function independentEvidence(families) {
  const counts = {};
  for (const f of families || []) if (f) counts[f] = (counts[f] || 0) + 1;
  const distinct = Object.keys(counts);
  let score = 0;
  for (const f of distinct) for (let i = 0; i < counts[f]; i++) score += i === 0 ? 1 : CORR_DISCOUNT;
  return {
    familyCount: distinct.length,
    families: distinct,
    screenerCount: (families || []).filter(Boolean).length,
    score: +score.toFixed(2),
    // The misleading case: several screeners agree but they're all the same factor.
    singleFamily: distinct.length < 2 && (families || []).filter(Boolean).length >= 2,
  };
}

// ── Lifecycle state machine (#6) ────────────────────────────────────────────
const STATES = ['detected', 'early', 'ready', 'triggered', 'extended', 'failed', 'expired', 'resolved'];
// How many bars past detection before an un-triggered setup is considered stale/expired,
// per horizon (a day-trade setup dies same-session; a position setup has weeks).
const MAX_AGE_BARS = { intraday: 1, swing: 10, position: 40, portfolio: 63 };
// How far past the entry trigger (in R multiples) a long is "extended" (chased, poor R:R left).
const EXTENDED_R = 1.0;

// Derive the live lifecycle state from first-detection prices + current price + age.
// `price` is the current price; entry/stop/target are the ORIGINAL logged plan.
function lifecycleState({ price, entry, stop, target, ageBars = 0, horizon = 'swing', hint }) {
  if (hint === 'resolved') return 'resolved';
  const maxAge = MAX_AGE_BARS[horizon] ?? 10;
  const long = target == null || entry == null || target >= entry;
  const hasLevels = entry > 0 && stop > 0 && Number.isFinite(price) && price > 0;
  if (!hasLevels) return ageBars > maxAge ? 'expired' : 'detected';

  const risk = Math.abs(entry - stop);
  // Stop hit → failed.
  if (long ? price <= stop : price >= stop) return 'failed';
  // Target hit → resolved (played out).
  if (target > 0 && (long ? price >= target : price <= target)) return 'resolved';
  const triggered = long ? price >= entry : price <= entry;
  if (triggered) {
    const beyond = long ? (price - entry) : (entry - price);
    if (risk > 0 && beyond >= EXTENDED_R * risk) return 'extended'; // chased past a clean entry
    return 'triggered';
  }
  // Not yet triggered.
  if (ageBars > maxAge) return 'expired';
  // Close to the trigger → ready; further away → early; brand new → detected.
  const distR = risk > 0 ? Math.abs(price - entry) / risk : 1;
  if (ageBars === 0) return 'detected';
  if (distR <= 0.5) return 'ready';
  return 'early';
}
// States that should not be surfaced as actionable "buy now" ideas.
const INACTIVE_STATES = new Set(['failed', 'expired', 'resolved', 'extended']);

// ── Execution realism (#7) — keep untradeable theory below liquid setups ────
const LIQ = { minDollarVol: 2e6, goodDollarVol: 2e7, maxSpreadPct: 1.5 };
// 0..1 execution multiplier + the list of frictions penalizing it. Thin/illiquid/
// wide-spread/halt-prone names get pushed DOWN the ranking, never up.
function executionQuality({ dollarVol, price, spreadPct, haltRisk, eventGapRisk, hardToBorrow, poorOptionLiq } = {}) {
  let q = 1;
  const penalties = [];
  // Only score liquidity when we actually KNOW the dollar-volume — a missing feed is
  // "unknown" (neutral), not "thin" (which would unfairly bury liquid names lacking the field).
  const dv = Number.isFinite(dollarVol) ? dollarVol : null;
  if (dv != null) {
    if (dv < LIQ.minDollarVol) { q *= 0.4; penalties.push('thin dollar-volume'); }
    else if (dv < LIQ.goodDollarVol) { q *= 0.75 + 0.25 * ((dv - LIQ.minDollarVol) / (LIQ.goodDollarVol - LIQ.minDollarVol)); }
  }
  if (price != null && price < 3) { q *= 0.7; penalties.push('sub-$3 (spread/slippage)'); }
  if (spreadPct != null && spreadPct > LIQ.maxSpreadPct) { q *= 0.7; penalties.push('wide bid-ask'); }
  if (haltRisk) { q *= 0.6; penalties.push('halt risk'); }
  if (eventGapRisk) { q *= 0.8; penalties.push('event-gap risk'); }
  if (hardToBorrow) { q *= 0.8; penalties.push('hard-to-borrow'); }
  if (poorOptionLiq) { q *= 0.85; penalties.push('poor option liquidity'); }
  return { quality: +Math.max(0.1, Math.min(1, q)).toFixed(3), penalties };
}

// ── Regime fit (#1 input; the one validated lever) ──────────────────────────
// Longs stand down in risk-off (the app's single durable finding); shorts get the
// mirror treatment. 0..1.
function regimeFit(side, regime) {
  const r = regime || {};
  const riskOff = r.bearish === true || r.riskOn === false || r.killSwitch === true;
  const isShort = side === 'short';
  if (riskOff) return isShort ? 1 : 0.45;
  if (r.riskOn === true) return isShort ? 0.6 : 1;
  return isShort ? 0.8 : 0.85; // neutral
}

// ── Expectancy from the live Scoreboard (#4/#5 feed the rank) ────────────────
const SHRINK_K = 8; // small-sample shrinkage toward neutral (matches opportunities.js n<8 rule)
// Look up a section:tier's realized track record at this horizon from scoreboard/summary.json.
function expectancyFor(section, tier, horizon, summary) {
  const groups = (summary && summary.groups) || [];
  const g = groups.find(x => x.section === section && x.tier === tier);
  if (!g) return { avgExcess: null, winRate: null, n: 0, known: false };
  const key = HORIZON_METRIC[horizon] || '1m';
  const h = (g.horizons && (g.horizons[key] || g.horizons['1m'] || g.horizons['5d'])) || null;
  if (!h) return { avgExcess: null, winRate: null, n: 0, known: false };
  return { avgExcess: h.avgExcess ?? null, winRate: h.winRate ?? null, n: h.n || 0, known: true };
}
// Convert realized excess-vs-market into a bidirectional rank tilt in [0.7, 1.3],
// shrunk by sample size so a handful of picks barely moves it. Beating the market
// boosts; losing to it trims — this is what makes the rank "validated", not a score sum.
function expectancyTilt(exp) {
  if (!exp || !exp.known || !exp.n) return { tilt: 1, shrink: 0 };
  const shrink = exp.n / (exp.n + SHRINK_K);
  const avg = exp.avgExcess || 0;
  const wr = (exp.winRate != null ? exp.winRate : 50) - 50;
  const raw = avg * 0.03 + wr * 0.006;                 // excess% + win-rate edge
  const tilt = 1 + Math.max(-0.3, Math.min(0.3, raw)) * shrink;
  return { tilt: +tilt.toFixed(3), shrink: +shrink.toFixed(2) };
}

// ── Confidence (#1 input) ───────────────────────────────────────────────────
// Blend the signal's own conviction (0..100) with how much independent evidence backs
// it and how well-sampled its track record is. Returns 0..100.
function confidenceScore({ rawConfidence = 50, evidence, exp }) {
  const evMult = 1 + Math.min(0.25, ((evidence && evidence.familyCount) || 1) - 1) * 0.12; // +12%/extra family, capped
  const sampleTrust = exp && exp.known ? 0.9 + 0.1 * (exp.n / (exp.n + SHRINK_K)) : 0.9;
  return +Math.max(0, Math.min(100, rawConfidence * evMult * sampleTrust)).toFixed(1);
}

// ── Evidence breadth multiplier for the final rank ──────────────────────────
function evidenceMultiplier(evidence) {
  const fc = (evidence && evidence.familyCount) || 1;
  return +Math.min(1.25, 1 + (fc - 1) * 0.09).toFixed(3); // diminishing; 4+ families ≈ cap
}

// ── The composite rank (#1) ─────────────────────────────────────────────────
// score = confidence × regimeFit × execution × expectancyTilt × evidenceMultiplier.
// Deliberately multiplicative, not additive: a fatal factor (risk-off long, untradeable
// name, proven-losing tier) collapses the score instead of being averaged away.
function compositeScore({ confidence, regimeFit: rf, execution, tilt, evidenceMult }) {
  const s = (confidence || 0) * (rf || 0) * (execution || 0) * (tilt || 1) * (evidenceMult || 1);
  return +Math.max(0, Math.min(100, s)).toFixed(1);
}

// ── Canonical Signal factory + runtime validation (#11) ─────────────────────
// Fill defaults, coerce types, compute derived fields. Returns {signal, errors}.
// Never throws — a bad source record degrades to a low-ranked, flagged signal rather
// than corrupting the table.
function makeSignal(input = {}) {
  const errors = [];
  const req = (k) => { if (input[k] == null || input[k] === '') errors.push(`missing ${k}`); };
  ['ticker', 'source', 'horizon'].forEach(req);
  const horizon = HORIZONS.includes(input.horizon) ? input.horizon : (errors.push('bad horizon'), 'swing');
  const side = input.side === 'short' ? 'short' : 'long';
  const num = (v) => (Number.isFinite(+v) ? +v : null);
  const entry = num(input.entry), stop = num(input.stop), target = num(input.target), price = num(input.price);
  const rr = (entry != null && stop != null && target != null && Math.abs(entry - stop) > 0)
    ? +(Math.abs(target - entry) / Math.abs(entry - stop)).toFixed(2) : (num(input.rr));
  const family = input.family || SOURCE_FAMILY[input.source] || 'priceTrend';
  const evidenceFamilies = (Array.isArray(input.evidenceFamilies) && input.evidenceFamilies.length)
    ? input.evidenceFamilies.filter(Boolean) : [family];
  return {
    signal: {
      schemaVersion: SCHEMA_VERSION,
      id: input.id || `${input.source}:${horizon}:${String(input.ticker || '').toUpperCase()}`,
      ticker: String(input.ticker || '').toUpperCase(),
      company: input.company || null,
      source: input.source || null,
      sources: input.sources || (input.source ? [input.source] : []),
      section: input.section || input.source || null,
      tier: input.tier || input.setup || null,
      scoringVersion: input.scoringVersion || null,
      horizon, side,
      setup: input.setup || null,
      detectedAt: input.detectedAt || null,
      ageBars: num(input.ageBars) || 0,
      price, entry, stop, target, rr,
      family, evidenceFamilies,
      rawConfidence: num(input.rawConfidence) ?? 50,
      sector: input.sector || null,
      sectorStrength: input.sectorStrength ?? null,
      catalyst: input.catalyst || null,
      percentile: Number.isFinite(input.percentile) ? input.percentile : null, // universe rank %, honest relative order (not a probability)
      note: input.note || null,
      event: input.event || null,       // {type, inDays, kind:'catalyst'|'binary'|'passed'|'priced-in'}
      liquidity: input.liquidity || null, // {dollarVol, spreadPct, ...}
      stateHint: input.stateHint || null,
      valid: errors.length === 0,
      errors,
    },
    errors,
  };
}

// Merge duplicate signals for the SAME (ticker, horizon) across sources into one — the
// cross-source confluence that makes the independent-evidence count honest (#3). The
// most-complete/confident member is the base; the rest contribute their evidence
// families, sources, and any catalyst/event it lacked. Pure (new objects).
function mergeSignals(signals) {
  const groups = new Map();
  for (const s of signals || []) {
    if (!s || !s.ticker) continue;
    const key = `${s.ticker}|${s.horizon}`;
    (groups.get(key) || groups.set(key, []).get(key)).push(s);
  }
  const out = [];
  for (const members of groups.values()) {
    if (members.length === 1) { out.push(members[0]); continue; }
    // Base = has levels first, then highest raw confidence.
    const base = members.slice().sort((a, b) =>
      (b.entry > 0 ? 1 : 0) - (a.entry > 0 ? 1 : 0) || (b.rawConfidence || 0) - (a.rawConfidence || 0))[0];
    const evidenceFamilies = [...new Set(members.flatMap(m => m.evidenceFamilies || [m.family]))];
    const sources = [...new Set(members.flatMap(m => m.sources && m.sources.length ? m.sources : [m.source]).filter(Boolean))];
    out.push({
      ...base,
      evidenceFamilies,
      sources,
      rawConfidence: Math.max(...members.map(m => m.rawConfidence || 0)),
      catalyst: base.catalyst || members.map(m => m.catalyst).find(Boolean) || null,
      event: base.event || members.map(m => m.event).find(Boolean) || null,
      mergedFrom: members.length,
    });
  }
  return out;
}

// ── Rank a batch of canonical signals against live regime + scoreboard ───────
// Enriches each signal with lifecycle state, execution quality, expectancy, confidence,
// composite score; sorts; assigns rank. Pure (regime + summary injected). Returns the
// enriched, ranked array (immutable — new objects).
function rankSignals(signals, { regime, scoreboard, includeInactive = false } = {}) {
  const enriched = (signals || []).map((sig) => {
    const state = lifecycleState({
      price: sig.price, entry: sig.entry, stop: sig.stop, target: sig.target,
      ageBars: sig.ageBars, horizon: sig.horizon, hint: sig.stateHint,
    });
    const evidence = independentEvidence(sig.evidenceFamilies || [sig.family]);
    const breadth = domainBreadth(sig.evidenceFamilies || [sig.family]);
    const exp = expectancyFor(sig.section || sig.source, sig.tier || sig.setup, sig.horizon, scoreboard);
    const { tilt } = expectancyTilt(exp);
    const exq = executionQuality(sig.liquidity || {});
    const rf = regimeFit(sig.side, regime);
    const confidence = confidenceScore({ rawConfidence: sig.rawConfidence, evidence, exp });
    const evidenceMult = evidenceMultiplier(evidence);
    const score = compositeScore({ confidence, regimeFit: rf, execution: exq.quality, tilt, evidenceMult });
    return {
      ...sig, state, evidence, breadth, expectancy: exp, expectancyTilt: tilt,
      execution: exq, regimeFit: rf, confidence, evidenceMult, score,
      holdWindow: HOLD_WINDOW[sig.horizon] || null,
      actionable: !INACTIVE_STATES.has(state),
    };
  });
  const pool = includeInactive ? enriched : enriched.filter(s => s.actionable);
  // Primary: composite score. Tiebreakers (scores saturate near 100 in a strong tape):
  // more independent evidence → better realized expectancy → higher raw confidence.
  const ranked = pool.slice().sort((a, b) =>
    b.score - a.score
    || (b.evidence?.familyCount || 0) - (a.evidence?.familyCount || 0)
    || (b.expectancyTilt || 1) - (a.expectancyTilt || 1)
    || (b.rawConfidence || 0) - (a.rawConfidence || 0));
  return ranked.map((s, i) => ({ ...s, rank: i + 1 }));
}

module.exports = {
  SCHEMA_VERSION, HORIZONS, HORIZON_LABEL, HORIZON_METRIC, HOLD_WINDOW,
  EVIDENCE_FAMILIES, FAMILY_LABEL, SOURCE_FAMILY, CORR_DISCOUNT, independentEvidence,
  DOMAINS, DOMAIN_LABEL, FAMILY_DOMAIN, domainBreadth,
  STATES, MAX_AGE_BARS, lifecycleState, INACTIVE_STATES,
  LIQ, executionQuality, regimeFit,
  expectancyFor, expectancyTilt, confidenceScore, evidenceMultiplier, compositeScore,
  makeSignal, mergeSignals, rankSignals,
};

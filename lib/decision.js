// UNIFIED DECISION ENGINE — the canonical Signal schema + pure ranking layer that
// every screener normalizes into, so the app presents ONE validated, ranked table
// instead of many competing lists. No network, no state → fully unit-testable and
// zero-risk to the running app. Source adapters live in lib/decision-normalizers.js;
// the HTTP op + data fetch lives in lib/decision-routes.js.
//
// Design axioms (from the app's own multi-session research):
//   • Rank by VALIDATED expectancy × confidence × regime-fit × execution × independent
//     evidence × transaction cost — NOT a sum of screener scores.
//   • Correlated indicators off the same price series are ONE confirmation, not many
//     (generalizes lib/confluence.js family-v1 across the whole app).
//   • The one durable lever is regime avoidance — longs stand down in risk-off.

'use strict';

const DC = require('./decision-costs');
const RE = require('./remaining-edge');

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
  'priceTrend', 'meanReversion', 'volumeAccum', 'fundamentalsRevisions', 'insider',
  'catalystForcedFlow', 'sentimentAttention', 'optionsPositioning',
  'sectorRegime', 'crossAsset',
];
const FAMILY_LABEL = {
  priceTrend: 'Price / trend', meanReversion: 'Mean reversion', volumeAccum: 'Volume / accumulation',
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
  // The trend-continuation engines all re-read the SAME price/trend domain — mapping them
  // here is what stops "Apex + Ignition + Trend Rider agree" from counting as 3 independent
  // confirmations (they are one). See lib/trend-core.js for the consolidated read.
  apex: 'priceTrend', ignition: 'priceTrend', trendrider: 'priceTrend', coremo: 'priceTrend',
  downday: 'meanReversion', vreversal: 'meanReversion', fade: 'meanReversion',
  ghost: 'volumeAccum', anomaly: 'volumeAccum', stealth: 'volumeAccum',
  tone: 'fundamentalsRevisions', toneshift: 'fundamentalsRevisions', biotech: 'catalystForcedFlow',
  insider: 'insider', cern: 'catalystForcedFlow', gapdown: 'catalystForcedFlow',
  attention: 'sentimentAttention', pulse: 'sentimentAttention', alerts: 'sentimentAttention',
  optionsflow: 'optionsPositioning', putsell: 'optionsPositioning',
  crossasset: 'crossAsset', readthrough: 'crossAsset', secondwave: 'crossAsset',
};

// ── Strategy families (#2) ──────────────────────────────────────────────────
// A coarser, product-facing grouping than the 9 evidence families: it answers "what
// KIND of trade is this?" so overlapping screeners consolidate into five archetypes
// (the review's ask). Distinct axis from evidence-domains (how the edge is corroborated)
// and horizon (how long it's held) — a name can be, e.g., an Event-driven swing.
const STRATEGY_FAMILIES = ['trend', 'earlyMomentum', 'event', 'intraday', 'context'];
const STRATEGY_FAMILY_META = {
  trend:         { icon: '📈', label: 'Trend continuation', blurb: 'Established uptrends / breakouts continuing.' },
  earlyMomentum: { icon: '🌱', label: 'Early momentum',     blurb: 'Quiet accumulation / pre-breakout — before the obvious move.' },
  event:         { icon: '⚡', label: 'Event-driven',       blurb: 'Gaps, catalysts, read-throughs, forced flow.' },
  intraday:      { icon: '⏱', label: 'Intraday',            blurb: 'Same-session setups — VWAP/ORB, day-trade pace.' },
  context:       { icon: '🧭', label: 'Context / sentiment', blurb: 'Cross-asset, tone, attention — regime & sentiment reads.' },
};
// Each screener/source → its strategy archetype. Consolidates the app's many screeners
// into the five review families (the models that contributed stay visible via `sources`).
const STRATEGY_FAMILY = {
  screener: 'trend', momentum: 'trend', coremo: 'trend', coil: 'trend', confluence: 'trend', trendrider: 'trend', custom: 'trend',
  apex: 'trend', ignition: 'trend',
  ghost: 'earlyMomentum', anomaly: 'earlyMomentum', stealth: 'earlyMomentum', opportunities: 'earlyMomentum',
  gapgo: 'event', gapdown: 'event', biotech: 'event', cern: 'event', readthrough: 'event', secondwave: 'event', fade: 'event', putsell: 'event',
  daytrade: 'intraday',
  toneshift: 'context', tone: 'context', crossasset: 'context', attention: 'context', pulse: 'context', alerts: 'context',
};
const familyForSource = (src) => STRATEGY_FAMILY[src] || 'trend';

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
  priceTrend: 'price', meanReversion: 'price', volumeAccum: 'volume', fundamentalsRevisions: 'fundamentals',
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
  // Pass through the distribution stats the Scoreboard already computes so a card can
  // show mean AND median forward return + a confidence interval + sample size (#3) —
  // instead of a lone conviction number the reader can mistake for a probability.
  return {
    avgExcess: h.avgExcess ?? null,
    // Scale-guarded at the boundary: an out-of-contract win rate becomes null (shown as
    // "building" rather than a wrong number) instead of silently inverting the rank.
    winRate: normalizeWinRate(h.winRate ?? null, { section, tier, horizon: key }),
    avg: h.avg ?? null, median: h.median ?? null, ci: h.avgCI ?? null,
    n: h.n || 0, horizonKey: key, known: true,
  };
}
// ── Win-rate scale guard ────────────────────────────────────────────────────
// CONTRACT: winRate is an INTEGER PERCENT on a 0..100 scale — which is exactly what the
// Scoreboard emits (`apex-routes.js` summarizeReturns → `Math.round((wins/n)*100)`).
//
// WHY THIS EXISTS: expectancyTilt reads `winRate - 50`. Hand a 0..1 FRACTION to it and the
// arithmetic does not fail — it silently inverts. 0.7 becomes 0.7-50 = -49.3, which pins
// the tilt to its 0.7 floor and RANKS A 70%-WINNING STRATEGY AS IF IT WERE LOSING. Nothing
// enforced the scale, so the failure was invisible: no throw, no NaN, just a quietly
// wrong ranking. (Caught while writing a test — the code was right, the fixture was
// wrong, but only luck made it visible.)
//
// The ambiguity is real and we do NOT guess through it: on a 0..100 scale `1` legitimately
// means a 1% win rate, while on a 0..1 scale it means 100%. So we only reject what is
// UNAMBIGUOUSLY wrong — a non-integer inside (0,1), which the integer-percent contract can
// never produce — plus anything outside [0,100]. A rejected value degrades to "unknown"
// (the tilt then rides on avgExcess alone) and is logged, rather than inverting the rank.
// We deliberately do NOT auto-scale 0.7 → 70: that would paper over a caller's bug.
function normalizeWinRate(winRate, ctx) {
  if (winRate == null) return null;
  const bad = (why) => {
    try { require('./log').logWarn('decision.winRate', why, { winRate, ...(ctx || {}) }); } catch { /* logging must never break ranking */ }
    return null;
  };
  if (typeof winRate !== 'number' || !Number.isFinite(winRate)) return bad('non-finite win rate — expected an integer percent 0..100');
  if (winRate < 0 || winRate > 100) return bad('win rate outside the 0..100 contract');
  if (winRate > 0 && winRate < 1 && !Number.isInteger(winRate)) {
    return bad('win rate looks like a 0..1 fraction, not the required 0..100 integer percent — refusing it (it would invert the tilt)');
  }
  return winRate;
}

// Convert realized excess-vs-market into a bidirectional rank tilt in [0.7, 1.3],
// shrunk by sample size so a handful of picks barely moves it. Beating the market
// boosts; losing to it trims — this is what makes the rank "validated", not a score sum.
function expectancyTilt(exp) {
  if (!exp || !exp.known || !exp.n) return { tilt: 1, shrink: 0 };
  const shrink = exp.n / (exp.n + SHRINK_K);
  const avg = Number.isFinite(exp.avgExcess) ? exp.avgExcess : 0;
  // Guard here too: expectancyTilt is exported and can be called with an `exp` that never
  // went through expectancyFor. An untrusted win rate contributes 0, never a sign flip.
  const safeWr = normalizeWinRate(exp.winRate, { where: 'expectancyTilt' });
  const wr = (safeWr != null ? safeWr : 50) - 50;
  const raw = avg * 0.03 + wr * 0.006;                 // excess% + win-rate edge
  const tilt = 1 + Math.max(-0.3, Math.min(0.3, raw)) * shrink;
  return { tilt: +tilt.toFixed(3), shrink: +shrink.toFixed(2) };
}

// ── Confidence (#1 input) ───────────────────────────────────────────────────
// Blend the signal's own conviction (0..100) with how much independent evidence backs
// it and how well-sampled its track record is. Returns 0..100.
function confidenceScore({ rawConfidence = 50, evidence, exp }) {
  // effectiveCount = measured independent-evidence UNITS (engines, discounted by their
  // observed correlation). Falls back to the raw family count when nothing is measured,
  // so this is identical to the previous behaviour until the ledgers earn a change.
  const fc = evidenceUnits(evidence);
  const evMult = 1 + Math.min(0.25, fc - 1) * 0.12; // +12%/extra independent unit, capped
  const sampleTrust = exp && exp.known ? 0.9 + 0.1 * (exp.n / (exp.n + SHRINK_K)) : 0.9;
  return +Math.max(0, Math.min(100, rawConfidence * evMult * sampleTrust)).toFixed(1);
}

// ── Evidence breadth multiplier for the final rank ──────────────────────────
function evidenceMultiplier(evidence) {
  const fc = evidenceUnits(evidence);
  return +Math.min(1.25, 1 + (fc - 1) * 0.09).toFixed(3); // diminishing; 4+ units ≈ cap
}

// How many INDEPENDENT units of evidence a signal really has. Measured => the sum of
// per-engine credits (two 0.96-correlated engines ≈ 1.36 units, not 2). Unmeasured =>
// the declared family count, i.e. exactly what this always did.
function evidenceUnits(evidence) {
  if (!evidence) return 1;
  if (evidence.measured && Number.isFinite(evidence.effectiveCount)) return Math.max(1, evidence.effectiveCount);
  return evidence.familyCount || 1;
}

// The same read, for the SORT tiebreaker. Separate from evidenceUnits() on purpose: the
// multiplier floors at 1 (a signal always has itself as evidence), but the tiebreaker must
// keep the original `|| 0` fallback so an unmeasured signal's ordering is byte-identical
// to what it was before measurement existed.
function evidenceRankUnits(evidence) {
  if (!evidence) return 0;
  if (evidence.measured && Number.isFinite(evidence.effectiveCount)) return evidence.effectiveCount;
  return evidence.familyCount || 0;
}

// ── The composite rank (#1) ─────────────────────────────────────────────────
// score = confidence × regimeFit × execution × expectancyTilt × evidenceMultiplier.
// Deliberately multiplicative, not additive: a fatal factor (risk-off long, untradeable
// name, proven-losing tier) collapses the score instead of being averaged away.
// `costPenalty` (spec §7) is the round-trip friction charged against the trade's own
// target move — see lib/decision-costs.js. It defaults to 1, so a signal with no target
// to charge against (or a caller that predates this factor) scores exactly as before.
//
// Cost enters the product ONCE, here. `tilt` deliberately stays gross: it measures a
// section:tier's realized GROUP track record, which is a different quantity from this
// setup's cost geometry, and charging both would double-count the same friction.
// `remainingMult` (spec §3) is the fraction of the originally-advertised move still ahead,
// trimmed for extension/decay — see lib/remaining-edge.js. It defaults to 1, so a fresh
// signal (or a caller that predates this factor / passes no origins) scores exactly as
// before; a consumed one is demoted smoothly BEFORE the lifecycle's extended cliff.
function compositeScore({ confidence, regimeFit: rf, execution, tilt, evidenceMult, costPenalty, remainingMult }) {
  const s = (confidence || 0) * (rf || 0) * (execution || 0) * (tilt || 1)
    * (evidenceMult || 1) * (costPenalty == null ? 1 : costPenalty)
    * (remainingMult == null ? 1 : remainingMult);
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
      strategyFamily: input.strategyFamily || familyForSource(input.source),
      setup: input.setup || null,
      detectedAt: input.detectedAt || null,
      ageBars: num(input.ageBars) || 0,
      price, entry, stop, target, rr,
      family, evidenceFamilies,
      // family -> the ENGINE that produced it. Lets the redundancy model charge
      // cross-engine evidence that rides on a single adapter (e.g. Ghost's accumulation
      // read on a screener row). Null => evidence is credited by `sources` alone.
      evidenceOrigins: (input.evidenceOrigins && typeof input.evidenceOrigins === 'object')
        ? { ...input.evidenceOrigins } : null,
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
    // SIDE IS PART OF THE IDENTITY. Without it a long and a short on the same name at the
    // same horizon merge into ONE row: the base wins the side, and the loser's evidence is
    // UNIONED onto it — so a bearish options read becomes "confirming" evidence for a long
    // and evidenceMultiplier BOOSTS the long for the bet against it.
    //
    // This was latent while every swing source was long-only and the only shorts (gapdown)
    // lived alone at intraday — an implicit contract held by luck, exactly like the winRate
    // scale landmine. Adding downday (bounces long + fades short) and optionsflow (bullish
    // + bearish) at swing made it reachable. A disagreement between two engines must stay
    // TWO rows that compete on the board, never one row that silently absorbs its opposite.
    const key = `${s.ticker}|${s.horizon}|${s.side === 'short' ? 'short' : 'long'}`;
    (groups.get(key) || groups.set(key, []).get(key)).push(s);
  }
  const out = [];
  for (const members of groups.values()) {
    if (members.length === 1) { out.push(members[0]); continue; }
    // Base = has levels first, then highest raw confidence.
    const base = members.slice().sort((a, b) =>
      (b.entry > 0 ? 1 : 0) - (a.entry > 0 ? 1 : 0) || (b.rawConfidence || 0) - (a.rawConfidence || 0))[0];
    const evidenceFamilies = [...new Set(members.flatMap(m => m.evidenceFamilies || [m.family]))];
    const evidenceOrigins = Object.assign({}, ...members.map(m => m.evidenceOrigins || {}));
    const sources = [...new Set(members.flatMap(m => m.sources && m.sources.length ? m.sources : [m.source]).filter(Boolean))];
    out.push({
      ...base,
      evidenceFamilies,
      evidenceOrigins: Object.keys(evidenceOrigins).length ? evidenceOrigins : null,
      sources,
      rawConfidence: Math.max(...members.map(m => m.rawConfidence || 0)),
      catalyst: base.catalyst || members.map(m => m.catalyst).find(Boolean) || null,
      event: base.event || members.map(m => m.event).find(Boolean) || null,
      mergedFrom: members.length,
    });
  }
  return out;
}

// ── Evidence, measured when the ledgers allow it ─────────────────────────────
// Returns the SAME shape independentEvidence() always returned (familyCount, families,
// screenerCount, score, singleFamily) so every downstream consumer — evidenceMultiplier,
// confidenceScore, the tiebreakers, the UI chip — keeps working untouched. The only
// difference is `score`, which is earned rather than asserted when a measured model is
// supplied, plus additive `measured`/`credits` fields for the explainability panel.
//
// Why keep familyCount on the static map: it answers a different, still-honest question
// ("how many KINDS of evidence?"). Redundancy answers "how much is the 2nd vote WORTH?".
// Conflating them would silently change the breadth chip's meaning.
function evidenceFor(sig, redundancy) {
  const families = sig.evidenceFamilies || [sig.family];
  const base = independentEvidence(families);
  if (!redundancy) return base;

  // The unit of redundancy is the ENGINE that produced the evidence, not the adapter that
  // emitted the signal. A screener row carrying Ghost's accumulation read is TWO engines
  // on one source — and measurement says those two are near-duplicates, so crediting them
  // as two independent families is exactly the inflation this is here to correct.
  const adapters = (sig.sources && sig.sources.length ? sig.sources : [sig.source]).filter(Boolean);
  const origins = sig.evidenceOrigins ? Object.values(sig.evidenceOrigins).filter(Boolean) : [];
  const engines = [...new Set([...adapters, ...origins])];
  if (engines.length < 2) return base;

  const RD = require('./redundancy');
  const eff = RD.effectiveEvidence(engines, {
    model: redundancy,
    priorCredit: CORR_DISCOUNT,
    familyOf: (s) => SOURCE_FAMILY[s] || null,
  });
  if (eff.method !== 'measured') return base;
  return {
    ...base,
    score: eff.score,
    effectiveCount: eff.score,
    measured: true,
    credits: eff.credits,
    redundantAgreement: eff.redundantAgreement,
    priorScore: base.score,
  };
}

// ── Rank a batch of canonical signals against live regime + scoreboard ───────
// Enriches each signal with lifecycle state, execution quality, expectancy, confidence,
// composite score; sorts; assigns rank. Pure (regime + summary injected). Returns the
// enriched, ranked array (immutable — new objects).
// `redundancy` (optional) is a measured model from lib/redundancy.js. When supplied, a
// signal's evidence is credited from OBSERVED overlap + return correlation between the
// contributing algorithms instead of the hand-assigned family map. When absent — or for
// any pair below its sample gates — this falls back to exactly the family rule below, so
// the ranking is unchanged until the ledgers earn a change.
function rankSignals(signals, { regime, scoreboard, includeInactive = false, redundancy = null, origins = null } = {}) {
  const riskOff = !!(regime && (regime.bearish === true || regime.riskOn === false || regime.killSwitch === true));
  const enriched = (signals || []).map((sig) => {
    const state = lifecycleState({
      price: sig.price, entry: sig.entry, stop: sig.stop, target: sig.target,
      ageBars: sig.ageBars, horizon: sig.horizon, hint: sig.stateHint,
    });
    const evidence = evidenceFor(sig, redundancy);
    const breadth = domainBreadth(sig.evidenceFamilies || [sig.family]);
    const exp = expectancyFor(sig.section || sig.source, sig.tier || sig.setup, sig.horizon, scoreboard);
    const { tilt } = expectancyTilt(exp);
    const exq = executionQuality(sig.liquidity || {});
    const rf = regimeFit(sig.side, regime);
    const confidence = confidenceScore({ rawConfidence: sig.rawConfidence, evidence, exp });
    const evidenceMult = evidenceMultiplier(evidence);
    // Round-trip friction charged against this trade's own target move (#7). Unknown ⇒
    // penalty 1 ⇒ the score is bit-for-bit what it was before costs bound.
    const cost = DC.costModel(sig);
    // Remaining-edge (spec §3): how much of the advertised move is still ahead at the current
    // price, from an IMMUTABLE origin snapshot. The multiplier binds ONLY when `origins` is
    // supplied — feature-off (no origins) forces mult 1, so the ranking is byte-identical to
    // before until the caller starts persisting origins. A signal with no stored origin is its
    // own origin (fresh ⇒ mult 1). See lib/remaining-edge.js.
    const origin = origins ? (origins[sig.id] || null) : null;
    const remaining = RE.computeRemainingEdge({
      ...sig, costPct: cost.roundTripPct, regimeDeteriorated: riskOff && sig.side !== 'short', state,
    }, origin);
    const remainingMult = origins ? remaining.mult : 1;
    const score = compositeScore({
      confidence, regimeFit: rf, execution: exq.quality, tilt, evidenceMult,
      costPenalty: cost.penalty, remainingMult,
    });
    // Strategy family (#2): the archetype this trade belongs to + the distinct families
    // the contributing screeners span (so "which models contributed" stays honest across a merge).
    const famKeys = [...new Set((sig.sources && sig.sources.length ? sig.sources : [sig.source]).map(familyForSource).filter(Boolean))];
    const strategyFamily = sig.strategyFamily || famKeys[0] || 'trend';
    return {
      ...sig, state, evidence, breadth, expectancy: exp, expectancyTilt: tilt,
      execution: exq, regimeFit: rf, confidence, evidenceMult, cost, score,
      // Attached only when the remaining-edge factor was actually applied (origins present),
      // so a consumer never mistakes the always-fresh self-origin fallback for a real read.
      remainingEdge: origins ? remaining : null,
      holdWindow: HOLD_WINDOW[sig.horizon] || null,
      strategyFamily, strategyFamilies: famKeys,
      actionable: !INACTIVE_STATES.has(state),
    };
  });
  const pool = includeInactive ? enriched : enriched.filter(s => s.actionable);
  // Primary: composite score. Tiebreakers (scores saturate near 100 in a strong tape):
  // more independent evidence → better realized expectancy → higher raw confidence.
  //
  // The evidence tiebreaker uses MEASURED units where they exist, so two names tied at a
  // saturated 100 are separated by how independent their evidence actually is rather than
  // by a raw family count that measurement has shown to be inflated. This matters
  // precisely at the top of the board, where the composite can no longer discriminate.
  // It is consistent with evidenceMultiplier(), which already discounts measured
  // redundancy — a measured-redundant name should not out-rank an unmeasured peer here
  // after being (correctly) marked down there.
  const ranked = pool.slice().sort((a, b) =>
    b.score - a.score
    || evidenceRankUnits(b.evidence) - evidenceRankUnits(a.evidence)
    || (b.expectancyTilt || 1) - (a.expectancyTilt || 1)
    || (b.rawConfidence || 0) - (a.rawConfidence || 0));
  return ranked.map((s, i) => ({ ...s, rank: i + 1 }));
}

module.exports = {
  SCHEMA_VERSION, HORIZONS, HORIZON_LABEL, HORIZON_METRIC, HOLD_WINDOW,
  EVIDENCE_FAMILIES, FAMILY_LABEL, SOURCE_FAMILY, CORR_DISCOUNT, independentEvidence, evidenceFor,
  STRATEGY_FAMILIES, STRATEGY_FAMILY, STRATEGY_FAMILY_META, familyForSource,
  DOMAINS, DOMAIN_LABEL, FAMILY_DOMAIN, domainBreadth,
  STATES, MAX_AGE_BARS, lifecycleState, INACTIVE_STATES,
  LIQ, executionQuality, regimeFit,
  expectancyFor, expectancyTilt, normalizeWinRate, confidenceScore, evidenceMultiplier, compositeScore,
  makeSignal, mergeSignals, rankSignals,
};

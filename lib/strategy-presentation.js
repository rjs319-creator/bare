'use strict';
// HOW EACH STRATEGY MAY BE PRESENTED (non-daytrade redesign 2026-08, Phase 10).
//
// THE DEFECT THIS CLOSES. Presentation drifted from evidence tab by tab: Breakout read as
// a validated buy list, Ghost as a standalone signal, Coil's expansion probability as a
// probability of profit, Down-Day without its conditional cohort, Gap & Go as a "validated
// event edge". A UI string is the last place a strategy's status should be decided.
//
// THE CONTRACT. One source of truth for the ROLE, the headline noun and the one-line
// caveat every surface must use. Derived from the registry maturity and the outcome
// contract wherever possible, so a promotion (a data change) updates the wording and a
// wording edit can never imply a promotion. `test/ui-claims.test.js` locks the vocabulary.
//
// Pure data + accessors. No network, no state.

const PRESENTATION_VERSION = 'presentation-v1';

// role: what the strategy IS on the page.
//   candidate-generation — a prioritized watchlist, not a validated ranking
//   overlay             — an annotation on another strategy's rows (never standalone)
//   watchlist-detector  — detects a CONDITION, not a trade
//   conditional-sleeve  — only valid inside a specific declared context
//   research-challenger — prospective, unproven, tracked on its own ledger
//   baseline            — an interpretable comparison, not a claim of edge
const ROLE_LABEL = Object.freeze({
  'candidate-generation': 'Candidate prioritization / watchlist',
  overlay: 'Overlay (annotation on another strategy)',
  'watchlist-detector': 'Watchlist detector',
  'conditional-sleeve': 'Conditional sleeve',
  'research-challenger': 'Research challenger (prospective)',
  baseline: 'Baseline / research',
  lead: 'Lead (information, not a trade plan)',
});

const PRESENTATION = Object.freeze({
  screener: {
    role: 'candidate-generation',
    headline: 'Breakout — candidate prioritization',
    caveat: 'Useful for generating and ordering candidates. Durable ranking alpha is NOT demonstrated: the production selection is positive gross, roughly break-even after base costs and negative under doubled/stressed costs.',
  },
  ghost: {
    role: 'overlay',
    headline: 'Ghost — accumulation overlay on the Breakout cross-section',
    caveat: 'Highly correlated with the Breakout score it rides. Only its INCREMENTAL value over that score on identical candidate dates counts as evidence; standalone performance does not.',
  },
  coil: {
    role: 'watchlist-detector',
    headline: 'Coil — abnormal-expansion watchlist',
    caveat: 'The expansion likelihood is P(a big move happens), NOT a probability of profit and NOT a direction. Trade readiness is a separate, unproven model (Stage B).',
  },
  downday: {
    role: 'conditional-sleeve',
    headline: 'Down-Day Bounce — red-tape 3-session sleeve',
    caveat: 'Evidence covers oversold-bounce longs on RED tape sessions over a 3-session hold. Off that tape the same rows are research controls, not signals.',
  },
  gapgo: {
    role: 'research-challenger',
    headline: 'Gap & Go — research (next-session ORB contract, unproven)',
    caveat: 'The current contract (gapgo-orb-verify-v2) enters on the NEXT session\'s opening range. It has no qualified record yet and inherits nothing from the earlier same-day proxy.',
  },
  omega: {
    role: 'baseline',
    headline: 'OMEGA-Swing — interpretable baseline (research)',
    caveat: 'No reliable market-relative edge has been demonstrated. Bands are transparent baseline outputs, never calibrated probabilities.',
  },
  coremo: {
    role: 'baseline',
    headline: 'Core Momentum — 12-1 book (research)',
    caveat: 'Momentum evidence in this app differs by universe and horizon and has not been validated survivorship-safe with turnover costs for this book.',
  },
  momentum: {
    role: 'baseline',
    headline: 'Momentum — intraday technical read (research)',
    caveat: 'Rebuilt on a price/volume-discovered universe; the v2 contract has no earned record yet and inherits nothing from v1.',
  },
  biotech: { role: 'lead', headline: 'Biotech Radar — catalyst leads', caveat: 'Leads benchmarked vs XBI. No published trade plan; promotion is judged only on the executable episode lane.' },
  optionsflow: { role: 'lead', headline: 'Unusual Options Activity — positioning read', caveat: 'Delayed chains cannot establish opening vs closing, bought vs sold, or hedge vs directional intent. Confirmation only.' },
  chartpattern: { role: 'lead', headline: 'Pattern Radar — structural setups (research)', caveat: 'A family becomes actionable only on its OWN leakage-safe walk-forward record.' },
  readthrough: { role: 'lead', headline: 'Read-Through — second-order leads', caveat: 'AI-generated leads with no levels; incremental value over a price/setup baseline is unproven.' },
});

// One presentation record for a strategy, with the registry/contract facts that must be
// shown next to it. `registryEntry`/`contract` are injected so this stays pure.
function presentationFor(id, { registryEntry = null, contract = null } = {}) {
  const p = PRESENTATION[id] || null;
  const entry = registryEntry || (require('./strategy-registry').STRATEGY_REGISTRY.find(e => e.id === id) || null);
  const c = contract || require('./strategy-contracts').contractFor(id);
  const maturity = (entry && entry.maturity) || 'shadow';
  return {
    version: PRESENTATION_VERSION,
    id,
    role: p ? p.role : (c && c.fillPolicy === 'lead-only' ? 'lead' : 'baseline'),
    roleLabel: ROLE_LABEL[(p && p.role) || 'baseline'],
    headline: p ? p.headline : ((entry && entry.label) || id),
    caveat: p ? p.caveat : 'Unproven — shown, tracked and graded, never a cleared recommendation.',
    maturity,
    // The single sentence a surface may use about status. Derived, never hand-written.
    statusLine: maturity === 'production'
      ? 'Cleared for live use by the registry; its earned evidence grade and governance clearance are shown separately.'
      : 'Research / shadow — weight-0 on the board and never a cleared recommendation.',
    horizon: (c && c.horizon) || (entry && entry.horizon) || null,
    metric: (c && c.metric) || null,
    twoStage: (c && c.twoStage) || null,
    incrementalOver: (c && c.incrementalOver) || null,
    leadOnly: !!(c && c.fillPolicy === 'lead-only'),
  };
}

module.exports = { PRESENTATION_VERSION, ROLE_LABEL, PRESENTATION, presentationFor };

'use strict';
// CATALYST–FLOW — VERSIONED FEATURE REGISTRY.
//
// Every feature DECLARES itself before it may appear in a dataset: source, what moment it
// observes, the moment it becomes AVAILABLE, its transformation, its missing-value
// behaviour and its hypothesised direction. A feature the registry does not know is
// rejected by the feature builder — that is the whole point, and it is what stops a
// feature zoo from accumulating one convenient column at a time.
//
// MISSING IS NOT ZERO. `missing: 'leave-missing'` means the column is emitted as null and
// the model must handle it as absent. Zero-filling an unavailable signed-options field
// would silently assert "balanced flow" — a measurement we did not make.
//
// `availability` is the honest gate: 'confirmation-close' means the value is known once
// the confirmation session has closed; 'overnight-eod' means it needs an end-of-day file
// that lands after that close and is therefore usable for the FOLLOWING morning's
// decision only. Anything whose availability cannot be established is `unavailable`.
//
// Pure module: declarations only, no computation.

const REGISTRY_VERSION = 'catalyst-feature-registry-v1';

const FAMILY = Object.freeze({
  A: 'A_FUNDAMENTAL_CATALYST',
  B: 'B_FIRST_SESSION_CONFIRMATION',
  C: 'C_SIGNED_OPTION_CONFIRMATION',
  D: 'D_RISK_CONTEXT',
});

const f = (name, family, source, observes, availability, transform, missing, direction, notes = null) =>
  Object.freeze({ name, family, source, observes, availability, transform, missing, direction, notes });

// ── A. Fundamental catalyst ─────────────────────────────────────────────────
// Every member of this family depends on a PRE-RELEASE consensus. With a vendor
// today-snapshot archive that consensus is post-release, so these are emitted with the
// event's pitClass and are EXPLORATORY unless a genuine estimates vintage feed is wired.
const FAMILY_A = [
  f('epsSurpriseStd', FAMILY.A, 'estimates-vintage', 'pre-release consensus vs actual', 'confirmation-close',
    'robust standardisation of (actual − consensus) by the issuer\'s own trailing surprise dispersion; scaler fit INSIDE the training fold only',
    'leave-missing', 'positive',
    'Never divide by a near-zero EPS estimate — the trailing-dispersion denominator is floored and the raw ratio is not used.'),
  f('revenueSurpriseStd', FAMILY.A, 'estimates-vintage', 'pre-release revenue consensus vs actual', 'confirmation-close',
    'same robust standardisation as epsSurpriseStd', 'leave-missing', 'positive'),
  f('surpriseSignAgreement', FAMILY.A, 'estimates-vintage', 'sign(eps surprise) == sign(revenue surprise)', 'confirmation-close',
    'ternary −1/0/+1; null when either side is missing', 'leave-missing', 'positive'),
  f('guidanceVsPrevious', FAMILY.A, 'guidance-feed', 'new guidance midpoint vs previous guidance midpoint', 'confirmation-close',
    'relative change, winsorised in-fold', 'leave-missing', 'positive'),
  f('guidanceVsConsensus', FAMILY.A, 'guidance-feed+estimates-vintage', 'new guidance midpoint vs frozen pre-event consensus', 'confirmation-close',
    'relative change, winsorised in-fold', 'leave-missing', 'positive'),
  f('revisionUpgradeCount', FAMILY.A, 'analyst-actions', 'upgrades/downgrades OBSERVED by the cutoff', 'confirmation-close',
    'net count of actions dated at or before the cutoff', 'leave-missing', 'positive',
    'Actions after the cutoff are invisible; the count is not backfilled.'),
  f('priceTargetChangePct', FAMILY.A, 'analyst-actions', 'mean price-target change observed by the cutoff', 'confirmation-close',
    'mean relative change, winsorised in-fold', 'leave-missing', 'positive'),
  f('revisionBreadthIndependent', FAMILY.A, 'analyst-actions', 'share of DISTINCT firms revising up, observed by the cutoff', 'confirmation-close',
    'up-firms / revising-firms; breadth, never level', 'leave-missing', 'positive',
    'Independent FIRM count — one house issuing five notes is one firm.'),
  f('releaseTone', FAMILY.A, 'earnings-text', 'financial-domain tone of the release / call', 'confirmation-close',
    'domain lexicon score, standardised in-fold', 'leave-missing', 'positive'),
  f('qaEvasiveness', FAMILY.A, 'transcript', 'Q&A non-answer rate', 'confirmation-close',
    'evasive-response share', 'leave-missing', 'negative',
    'Requires point-in-time transcripts. Absent ⇒ missing, never imputed from the release text.'),
  f('textNoveltyVsPrior', FAMILY.A, 'earnings-text', 'cosine distance vs the ISSUER\'S own prior event text', 'confirmation-close',
    '1 − cosine similarity on the prior release only', 'leave-missing', 'positive'),
  f('fridayAnnouncement', FAMILY.A, 'exchange-calendar', 'announcement weekday', 'confirmation-close',
    'binary; Friday = 1', 'leave-missing', 'negative'),
  f('sameDayEventCount', FAMILY.A, 'event-ledger', 'other announcements on the same date (distraction proxy)', 'confirmation-close',
    'count of eligible events sharing the announcement date', 'leave-missing', 'positive'),
];

// ── B. First-session underreaction / confirmation ───────────────────────────
// This family is genuinely point-in-time from observed bars: a printed bar is an
// observation, not a vendor opinion that gets revised.
const FAMILY_B = [
  f('overnightGap', FAMILY.B, 'daily-bars', 'confirmation open vs prior close', 'confirmation-close', 'relative change', 'leave-missing', 'positive'),
  f('firstSessionReturn', FAMILY.B, 'daily-bars', 'confirmation session open→close', 'confirmation-close', 'relative change', 'leave-missing', 'positive'),
  f('firstSessionVsSpy', FAMILY.B, 'daily-bars', 'confirmation session return − SPY return', 'confirmation-close', 'difference', 'leave-missing', 'positive'),
  f('firstSessionVsSector', FAMILY.B, 'daily-bars+sector-map', 'confirmation session return − sector ETF return', 'confirmation-close', 'difference', 'leave-missing', 'positive'),
  f('gapRetention', FAMILY.B, 'daily-bars', 'how much of the gap survived to the close', 'confirmation-close', '(close − priorClose) / (open − priorClose), clipped', 'leave-missing', 'positive'),
  f('closeLocationValue', FAMILY.B, 'daily-bars', 'where the close sat in the session range', 'confirmation-close', '(2·close − high − low)/(high − low)', 'leave-missing', 'positive'),
  f('intradayReversal', FAMILY.B, 'daily-bars', 'close vs the session high', 'confirmation-close', '(close − high)/high', 'leave-missing', 'positive'),
  f('abnormalShareVolume', FAMILY.B, 'daily-bars', 'confirmation volume vs its trailing median', 'confirmation-close', 'log ratio to the 20-session median', 'leave-missing', 'positive'),
  f('abnormalDollarVolume', FAMILY.B, 'daily-bars', 'confirmation dollar volume vs trailing median', 'confirmation-close', 'log ratio to the 20-session median', 'leave-missing', 'positive'),
  f('preEventReturn5', FAMILY.B, 'daily-bars', 'return over the 5 sessions BEFORE the announcement', 'confirmation-close', 'relative change', 'leave-missing', 'ambiguous'),
  f('preEventReturn20', FAMILY.B, 'daily-bars', 'return over the 20 sessions BEFORE the announcement', 'confirmation-close', 'relative change', 'leave-missing', 'ambiguous'),
  f('distanceFromSma20', FAMILY.B, 'daily-bars', 'confirmation close vs its 20-session mean', 'confirmation-close', 'relative distance', 'leave-missing', 'ambiguous'),
  f('distanceFrom20dHigh', FAMILY.B, 'daily-bars', 'confirmation close vs the trailing 20-session high', 'confirmation-close', 'relative distance', 'leave-missing', 'positive'),
  f('realizedVol20', FAMILY.B, 'daily-bars', 'trailing 20-session realised volatility', 'confirmation-close', 'stdev of daily log returns, annualised', 'leave-missing', 'negative'),
  f('idiosyncraticVol20', FAMILY.B, 'daily-bars', 'residual vol after removing SPY beta', 'confirmation-close', 'stdev of market-model residuals', 'leave-missing', 'negative'),
  f('spreadProxyBps', FAMILY.B, 'daily-bars', 'liquidity quality proxy', 'confirmation-close', 'Corwin-Schultz style high/low proxy; a PROXY, not an NBBO quote', 'leave-missing', 'negative',
    'The app has no NBBO feed (docs/blocked-on-data.md §1). This is declared a PROXY and is flagged as such in the artifact.'),
  f('advDollar20', FAMILY.B, 'daily-bars', 'trailing 20-session mean dollar volume', 'confirmation-close', 'log10', 'leave-missing', 'positive'),
  f('marketVolRegime', FAMILY.B, 'daily-bars', 'SPY trailing 20-session realised vol', 'confirmation-close', 'standardised in-fold', 'leave-missing', 'negative'),
  f('sectorId', FAMILY.B, 'sector-map', 'issuer sector', 'confirmation-close', 'categorical', 'leave-missing', 'ambiguous',
    'Sector classification is a CURRENT-state vendor read, not a point-in-time one; flagged sectorPitVerified:false.'),
];

// ── C. Signed option confirmation ───────────────────────────────────────────
// Requires a feed that identifies PARTICIPANT, BUY/SELL and OPEN/CLOSE (Cboe Open-Close or
// a genuinely equivalent licensed feed). The free Yahoo chain cannot determine any of the
// three, so it may NEVER populate these. Absent feed ⇒ every member stays null and the
// arm reports INSUFFICIENT_DATA rather than a verdict.
const FAMILY_C = [
  f('custBuyToOpenCallUsd', FAMILY.C, 'signed-options-feed', 'customer buy-to-open call dollar volume', 'overnight-eod', 'sum over the confirmation session', 'leave-missing', 'positive'),
  f('custBuyToOpenPutUsd', FAMILY.C, 'signed-options-feed', 'customer buy-to-open put dollar volume', 'overnight-eod', 'sum over the confirmation session', 'leave-missing', 'negative'),
  f('openingImbalanceNorm', FAMILY.C, 'signed-options-feed', 'normalised call−put opening imbalance', 'overnight-eod', '(call − put)/(call + put)', 'leave-missing', 'positive'),
  f('proCustBuyToOpenImbalance', FAMILY.C, 'signed-options-feed', 'professional-customer opening imbalance', 'overnight-eod', '(call − put)/(call + put)', 'leave-missing', 'positive'),
  f('leveragedOtmImbalance', FAMILY.C, 'signed-options-feed', 'opening imbalance restricted to OTM strikes', 'overnight-eod', '(call − put)/(call + put) over |delta| < 0.35', 'leave-missing', 'positive'),
  f('smallLotShare', FAMILY.C, 'signed-options-feed', 'contract-size bucket mix', 'overnight-eod', 'share of opening volume in ≤10-lot trades', 'leave-missing', 'ambiguous'),
  f('largeLotShare', FAMILY.C, 'signed-options-feed', 'contract-size bucket mix', 'overnight-eod', 'share of opening volume in ≥100-lot trades', 'leave-missing', 'ambiguous'),
  f('optionToStockVolume', FAMILY.C, 'signed-options-feed+daily-bars', 'option volume relative to share volume', 'overnight-eod', 'contracts×100 / share volume', 'leave-missing', 'positive'),
  f('matchedStrikeIvSpread', FAMILY.C, 'options-surface', 'call IV − put IV at matched strike/expiry', 'overnight-eod', 'difference in vol points', 'leave-missing', 'positive'),
  f('skew25Delta', FAMILY.C, 'options-surface', '25-delta put IV − 25-delta call IV', 'overnight-eod', 'difference in vol points', 'leave-missing', 'negative'),
  f('skew25DeltaChange', FAMILY.C, 'options-surface', 'change in 25-delta skew across the confirmation session', 'overnight-eod', 'difference of differences', 'leave-missing', 'negative'),
  f('optionsLiquidityScore', FAMILY.C, 'signed-options-feed', 'option-market liquidity quality', 'overnight-eod', 'composite of open interest and quote width', 'leave-missing', 'positive'),
  f('exchangeCoverageMask', FAMILY.C, 'signed-options-feed', 'WHICH Cboe exchanges contributed', 'overnight-eod', 'bitmask; C1 history is longer than the other exchanges and must not be conflated with full-market', 'leave-missing', 'ambiguous'),
];

// ── D. Risk / context ───────────────────────────────────────────────────────
const FAMILY_D = [
  f('daysToCover', FAMILY.D, 'finra-short-interest', 'short interest ÷ ADV at its PUBLICATION time', 'publication-lagged', 'continuous, winsorised in-fold', 'leave-missing', 'ambiguous',
    'FINRA short interest is usable only AFTER publication, never on its settlement date. FINRA daily short VOLUME is a different series and is not used here.'),
  f('extremeCrowdingFlag', FAMILY.D, 'finra-short-interest', 'daysToCover ≥ 7', 'publication-lagged', 'binary', 'leave-missing', 'ambiguous'),
  f('dilutionEventFlag', FAMILY.D, 'filings', 'offering / ATM / shelf takedown observed by the cutoff', 'confirmation-close', 'binary', 'leave-missing', 'negative'),
  f('borrowAvailable', FAMILY.D, 'borrow-feed', 'short availability at the cutoff', 'unavailable', 'binary', 'leave-missing', 'ambiguous',
    'No neutral borrow vendor is wired (docs/blocked-on-data.md §2). Declared unavailable rather than assumed available.'),
  f('estRoundTripCostPct', FAMILY.D, 'cost-model', 'estimated round-trip friction at the cutoff', 'confirmation-close', 'liquidity-tiered cost model', 'leave-missing', 'negative'),
  f('missingFeatureShare', FAMILY.D, 'derived', 'share of declared features that are missing for this row', 'confirmation-close', 'ratio', 'never-missing', 'negative'),
  f('sourceQualityScore', FAMILY.D, 'derived', 'weakest provenance among the row\'s populated sources', 'confirmation-close', 'ordinal', 'never-missing', 'positive'),
];

const FEATURES = Object.freeze([...FAMILY_A, ...FAMILY_B, ...FAMILY_C, ...FAMILY_D]);
const BY_NAME = Object.freeze(Object.fromEntries(FEATURES.map((x) => [x.name, x])));
const NAMES_BY_FAMILY = Object.freeze(Object.fromEntries(
  Object.values(FAMILY).map((fam) => [fam, Object.freeze(FEATURES.filter((x) => x.family === fam).map((x) => x.name))])
));

// The feature sets each locked arm is allowed to see. E2 excludes family C ENTIRELY —
// not "sets it to zero"; the column is not present.
const ARM_FEATURE_FAMILIES = Object.freeze({
  E2_CATALYST_RANKER: Object.freeze([FAMILY.A, FAMILY.B, FAMILY.D]),
  E3_CATALYST_FLOW_RANKER: Object.freeze([FAMILY.A, FAMILY.B, FAMILY.C, FAMILY.D]),
});

const featureNamesForArm = (arm) =>
  (ARM_FEATURE_FAMILIES[arm] || []).flatMap((fam) => NAMES_BY_FAMILY[fam] || []);

// A dataset column that no declaration covers is a defect, not a bonus feature.
function validateColumns(columns) {
  const unknown = (columns || []).filter((c) => !BY_NAME[c]);
  return { ok: unknown.length === 0, unknown };
}

module.exports = {
  REGISTRY_VERSION, FAMILY, FEATURES, BY_NAME, NAMES_BY_FAMILY,
  ARM_FEATURE_FAMILIES, featureNamesForArm, validateColumns,
};

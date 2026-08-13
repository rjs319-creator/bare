'use strict';
// P0 REGRESSION LOCKS — one test group per defect named in the redesign mission.
// Each group first pins the *defective* behavior's absence, then pins the replacement.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const paa = require('../lib/alerts-price-at-alert');
const fr = require('../lib/alerts-freshness');
const ex = require('../lib/alerts-execution');
const rg = require('../lib/alerts-regime');
const sc = require('../lib/alerts-score');
const pipeline = require('../lib/alerts-pipeline');
const episodes = require('../lib/alerts-episodes');

const NOW = Date.parse('2026-08-13T18:00:00Z');
const iso = msAgo => new Date(NOW - msAgo).toISOString();
const H = 3_600_000;

const goodSetup = { direction: 'long', valid: true, quality: 0.8, spot: 100, atr: 2, rsi: 55, sma20: 98, support: 95, resistance: 105, trigger: 106, invalidation: 94, target: 118, rr: 2.0 };
const ep = (o = {}) => ({ id: 'e1', ticker: 'AAA', side: 'long', status: 'WAITING', catalysts: ['breakout'], firstSeen: iso(3 * H), lastSeen: iso(3 * H), ...o });
const fresh = (o = {}) => fr.assessFreshness({ firstSeenAt: iso(3 * H), lastSeenAt: iso(3 * H), priceAsOf: iso(2 * H), now: NOW, ...o });
const liquidExec = () => ex.assessExecution({ side: 'long', advUsd: 50e6, spreadBps: 8 });

// ─────────────────────────────────────────────────────────────────────────────
// P0-1  Immutable price-at-alert with quote timestamp, session, and source
// ─────────────────────────────────────────────────────────────────────────────

test('P0-1: a captured alert price carries price, provider timestamp, session, and source', () => {
  const r = paa.capturePriceAtAlert({
    ticker: 'AAA',
    quote: { price: 101.25, asOf: iso(60_000) },
    source: 'yahoo-quote',
    sessionInfo: { marketSession: 'regular' },
    now: NOW,
  });
  assert.equal(r.state, paa.STATE.CAPTURED);
  assert.equal(r.price, 101.25);
  assert.equal(r.marketSession, 'regular');
  assert.equal(r.source, 'yahoo-quote');
  assert.equal(r.quoteAsOf, iso(60_000));
  assert.ok(r.quoteAgeSec >= 0 && r.quoteAgeSec <= 120);
});

test('P0-1: a quote WITHOUT a provider timestamp is never stamped with server time', () => {
  const r = paa.capturePriceAtAlert({ ticker: 'AAA', quote: { price: 101.25, asOf: null }, source: 'yahoo-quote', sessionInfo: { marketSession: 'regular' }, now: NOW });
  assert.equal(r.state, paa.STATE.UNAVAILABLE);
  assert.equal(r.price, null);
  assert.equal(r.quoteAsOf, null);
  assert.match(r.reason, /no timestamp/i);
});

test('P0-1: a stale quote is not recorded as the alert price', () => {
  const r = paa.capturePriceAtAlert({ ticker: 'AAA', quote: { price: 101.25, asOf: iso(4 * H) }, source: 'yahoo-quote', sessionInfo: { marketSession: 'regular' }, now: NOW });
  assert.equal(r.state, paa.STATE.UNAVAILABLE);
  assert.match(r.reason, /min old/);
});

test('P0-1: a missing session or source blocks capture (provenance is not optional)', () => {
  const noSession = paa.capturePriceAtAlert({ ticker: 'AAA', quote: { price: 1, asOf: iso(0) }, source: 'yahoo-quote', sessionInfo: null, now: NOW });
  const noSource = paa.capturePriceAtAlert({ ticker: 'AAA', quote: { price: 1, asOf: iso(0) }, source: null, sessionInfo: { marketSession: 'regular' }, now: NOW });
  assert.equal(noSession.state, paa.STATE.UNAVAILABLE);
  assert.equal(noSource.state, paa.STATE.UNAVAILABLE);
});

test('P0-1: a CAPTURED record is immutable — a later capture cannot overwrite it', () => {
  const first = paa.capturePriceAtAlert({ ticker: 'AAA', quote: { price: 10, asOf: iso(0) }, source: 'yahoo-quote', sessionInfo: { marketSession: 'regular' }, now: NOW });
  const later = paa.capturePriceAtAlert({ ticker: 'AAA', quote: { price: 99, asOf: iso(0) }, source: 'yahoo-quote', sessionInfo: { marketSession: 'regular' }, now: NOW });
  assert.equal(paa.mergePriceAtAlert(first, later).price, 10);
});

test('P0-1: legacy episodes are reported LEGACY_NOT_CAPTURED and are NOT backfilled', () => {
  const r = paa.readPriceAtAlert({ id: 'old', ticker: 'AAA' });     // no priceAtAlert, no execRef
  assert.equal(r.state, paa.STATE.LEGACY_NOT_CAPTURED);
  assert.equal(r.price, null);
  assert.match(r.reason, /NOT backfilled/i);
  const m = paa.moveSinceAlert(r, 120, 'long');
  assert.equal(m.available, false);
  assert.equal(m.movePct, null);
});

test('P0-1: a legacy bare execRef surfaces WITHOUT provenance rather than posing as a capture', () => {
  const r = paa.readPriceAtAlert({ id: 'old', ticker: 'AAA', execRef: 50 });
  assert.equal(r.state, paa.STATE.LEGACY_NOT_CAPTURED);
  assert.equal(r.price, 50);
  assert.equal(r.quoteAsOf, null);
  const m = paa.moveSinceAlert(r, 55, 'long');
  assert.equal(m.available, true);
  assert.equal(m.verified, undefined === m.verified ? m.verified : false);   // never "verified"
  assert.ok(!m.verified);
});

test('P0-1: move-since-alert is SIDE-SIGNED — a short profits when price falls', () => {
  const cap = { state: paa.STATE.CAPTURED, price: 100 };
  assert.equal(paa.moveSinceAlert(cap, 90, 'short').consumedPct, 10);
  assert.equal(paa.moveSinceAlert(cap, 90, 'long').consumedPct, -10);
});

test('P0-1: buildLeads stamps an immutable capture; foldEpisodes persists it once', () => {
  const records = [{ text: 'Long $AAA breakout above 100', accountKey: 'a1', handle: 'a1', identityKnown: true, publishedAt: iso(H), collectedAt: iso(H) }];
  const { leads } = pipeline.buildLeads(records, {
    quoteByTicker: new Map([['AAA', { ticker: 'AAA', price: 100, asOf: iso(30_000) }]]),
    quoteSource: 'yahoo-quote', sessionInfo: { marketSession: 'regular' }, now: NOW,
  });
  assert.ok(leads.length >= 1);
  assert.equal(leads[0].priceAtAlert.state, paa.STATE.CAPTURED);
  assert.equal(leads[0].execRef, 100);

  const { episodes: fold1 } = episodes.foldEpisodes([], leads, { date: '2026-08-13', now: () => iso(0) });
  assert.equal(fold1[0].priceAtAlert.price, 100);

  // A later post about the same thesis must NOT restamp the original decision price.
  const { leads: leads2 } = pipeline.buildLeads(records.map(r => ({ ...r, text: 'Still long $AAA, adding' })), {
    quoteByTicker: new Map([['AAA', { ticker: 'AAA', price: 130, asOf: iso(30_000) }]]),
    quoteSource: 'yahoo-quote', sessionInfo: { marketSession: 'regular' }, now: NOW,
  });
  const { episodes: fold2 } = episodes.foldEpisodes(fold1, leads2, { date: '2026-08-14', now: () => iso(0) });
  assert.equal(fold2[0].priceAtAlert.price, 100, 'the alert price must stay the ORIGINAL decision price');
});

test('P0-1: a quote-provider failure yields UNAVAILABLE captures, never a fabricated price', () => {
  const records = [{ text: 'Long $AAA breakout', accountKey: 'a1', handle: 'a1', identityKnown: true, publishedAt: iso(H), collectedAt: iso(H) }];
  const { leads } = pipeline.buildLeads(records, { quoteByTicker: new Map(), quoteSource: null, sessionInfo: null, now: NOW });
  assert.equal(leads[0].priceAtAlert.state, paa.STATE.UNAVAILABLE);
  assert.equal(leads[0].execRef, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// P0-2  Visible alert age + TTL enforced on EVERY decision build
// ─────────────────────────────────────────────────────────────────────────────

test('P0-2: every freshness read exposes a visible age label and an expiry', () => {
  const f = fresh();
  assert.equal(f.state, fr.STATE.FRESH);
  assert.equal(f.ageLabel, '3h old');
  assert.ok(f.expiresAt);
  assert.ok(f.hoursToExpiry > 0);
  assert.equal(f.corroborationAgeHours, 3);
});

test('P0-2: TTL scales with the intended horizon', () => {
  const at = iso(30 * H);
  assert.equal(fr.assessFreshness({ firstSeenAt: at, lastSeenAt: at, priceAsOf: iso(H), horizon: 'day trade', now: NOW }).state, fr.STATE.EXPIRED);
  assert.equal(fr.assessFreshness({ firstSeenAt: at, lastSeenAt: at, priceAsOf: iso(H), horizon: 'swing', now: NOW }).state, fr.STATE.AGING);
  assert.equal(fr.assessFreshness({ firstSeenAt: at, lastSeenAt: at, priceAsOf: iso(H), horizon: 'long term', now: NOW }).state, fr.STATE.FRESH);
});

test('P0-2: no usable timestamp fails CLOSED (UNKNOWN, not actionable)', () => {
  const f = fr.assessFreshness({ firstSeenAt: null, lastSeenAt: null, priceAsOf: null, now: NOW });
  assert.equal(f.state, fr.STATE.UNKNOWN);
  assert.equal(f.actionable, false);
});

test('P0-2: a STALE alert cannot be actionable at decision-build time', () => {
  const d = sc.scoreEpisode(ep({ firstSeen: iso(120 * H), lastSeen: iso(120 * H) }), {
    setup: goodSetup, skill: { state: 'PROVEN', accountPoints: 20 },
    catalyst: { status: 'VERIFIED_PRIMARY' }, social: { confirmation: 0.8, independentClusters: 5 },
    market: { priceNow: 100 }, regime: { supportive: true },
    execution: liquidExec(), freshness: fresh({ firstSeenAt: iso(120 * H), lastSeenAt: iso(120 * H) }), now: NOW,
  });
  assert.equal(d.freshness.state, fr.STATE.STALE);
  assert.notEqual(d.action, 'REVIEW');
  assert.equal(d.researchPriority.band, 'P3');
});

test('P0-2: an EXPIRED alert routes to reassess and can never be actionable', () => {
  const at = iso(400 * H);
  const d = sc.scoreEpisode(ep({ firstSeen: at, lastSeen: at }), {
    setup: goodSetup, skill: {}, catalyst: { status: 'VERIFIED_PRIMARY' }, social: {},
    market: { priceNow: 100 }, regime: { supportive: true },
    execution: liquidExec(), freshness: fresh({ firstSeenAt: at, lastSeenAt: at }), now: NOW,
  });
  assert.equal(d.freshness.state, fr.STATE.EXPIRED);
  assert.equal(d.action, 'EXIT/REASSESS');
  assert.equal(d.researchPriority.band, 'P4');
});

test('P0-2: a stale DECISION PRICE also blocks actionability', () => {
  const d = sc.scoreEpisode(ep(), {
    setup: goodSetup, skill: {}, catalyst: { status: 'VERIFIED_PRIMARY' }, social: {},
    market: { priceNow: 100 }, regime: { supportive: true }, execution: liquidExec(),
    freshness: fresh({ priceAsOf: iso(200 * H) }), now: NOW,
  });
  assert.equal(d.freshness.priceState, fr.STATE.STALE);
  assert.notEqual(d.action, 'REVIEW');
});

test('P0-2: the pipeline recomputes freshness per decision — it is not only a fold-time check', () => {
  const stale = { id: 'e9', ticker: 'AAA', side: 'long', status: 'WAITING', key: 'AAA:long', firstSeen: iso(150 * H), lastSeen: iso(150 * H), firstSeenDate: '2026-08-05', lastSeenDate: '2026-08-07', contributors: [] };
  const { decisions } = pipeline.buildDecisions([stale], { now: NOW });
  assert.equal(decisions.length, 1);
  assert.ok(decisions[0].freshness, 'the decision must carry a freshness record');
  assert.notEqual(decisions[0].action, 'REVIEW');
  assert.ok(decisions[0].freshness.ageLabel);
});

// ─────────────────────────────────────────────────────────────────────────────
// P0-3  No favorable default execution credit
// ─────────────────────────────────────────────────────────────────────────────

test('P0-3: THE DEFECT — absent liquidity evidence no longer earns 0.7 of the execution weight', () => {
  const e = ex.assessExecution({ side: 'long' });        // nothing supplied at all
  assert.equal(e.state, ex.STATE.UNKNOWN);
  assert.equal(e.creditFraction, 0);
  assert.equal(e.coverage, 0);
  assert.deepEqual(e.missingRequired, ['liquidity', 'spread']);
  assert.match(e.unavailableReason, /UNKNOWN, not as acceptable/);
});

test('P0-3: credit can never exceed evidence coverage', () => {
  const half = ex.assessExecution({ side: 'long', advUsd: 100e6 });   // liquidity only
  assert.equal(half.coverage, 0.5);
  assert.ok(half.creditFraction <= 0.5 + 1e-9);
  const full = ex.assessExecution({ side: 'long', advUsd: 100e6, spreadBps: 5 });
  assert.equal(full.coverage, 1);
  assert.ok(full.creditFraction > half.creditFraction);
});

test('P0-3: UNKNOWN execution forces WAIT, never an actionable card', () => {
  const d = sc.scoreEpisode(ep(), {
    setup: goodSetup, skill: { state: 'PROVEN', accountPoints: 20 },
    catalyst: { status: 'VERIFIED_PRIMARY' }, social: { confirmation: 0.9, independentClusters: 6 },
    market: { priceNow: 100 }, regime: { supportive: true }, freshness: fresh(), now: NOW,
    execution: ex.assessExecution({ side: 'long' }),
  });
  assert.equal(d.action, 'WAIT');
  assert.equal(d.components.execution, 0);
  assert.match(d.reasons.join(' '), /Execution evidence incomplete/);
});

test('P0-3: a short with NO borrow evidence cannot be actionable', () => {
  const e = ex.assessExecution({ side: 'short', advUsd: 100e6, spreadBps: 5 });
  assert.equal(e.components.borrow.state, ex.COMPONENT_STATE.MISSING);
  assert.ok(e.coverage < 1);
  assert.deepEqual(e.missingRequired, ['borrow']);
  const withBorrow = ex.assessExecution({ side: 'short', advUsd: 100e6, spreadBps: 5, borrow: { available: true, feePct: 0.5, source: 'test' } });
  assert.equal(withBorrow.coverage, 1);
  assert.equal(withBorrow.state, ex.STATE.OK);
});

test('P0-3: a long is NOT penalised for borrow — the component is NOT_APPLICABLE', () => {
  const e = ex.assessExecution({ side: 'long', advUsd: 100e6, spreadBps: 5 });
  assert.equal(e.components.borrow.state, ex.COMPONENT_STATE.NOT_APPLICABLE);
  assert.equal(e.coverage, 1);
});

test('P0-3: measured-and-disqualifying evidence BLOCKS rather than merely discounting', () => {
  assert.equal(ex.assessExecution({ side: 'long', advUsd: 1e6, spreadBps: 5 }).state, ex.STATE.BLOCKED);
  assert.equal(ex.assessExecution({ side: 'short', advUsd: 100e6, spreadBps: 5, borrow: { available: false } }).state, ex.STATE.BLOCKED);
  assert.equal(ex.assessExecution({ side: 'long', advUsd: 10e6, spreadBps: 5, orderNotionalUsd: 5e6 }).state, ex.STATE.BLOCKED);
});

test('P0-3: impact needs BOTH a size and an ADV — one alone stays unmeasured', () => {
  assert.equal(ex.assessExecution({ side: 'long', advUsd: 100e6 }).components.impact.state, ex.COMPONENT_STATE.MISSING);
  assert.equal(ex.assessExecution({ side: 'long', orderNotionalUsd: 1e4 }).components.impact.state, ex.COMPONENT_STATE.MISSING);
  assert.equal(ex.assessExecution({ side: 'long', advUsd: 100e6, orderNotionalUsd: 1e4 }).components.impact.state, ex.COMPONENT_STATE.MEASURED);
});

test('P0-3: every missing component states WHY it is missing', () => {
  const e = ex.assessExecution({ side: 'short' });
  for (const [, c] of Object.entries(e.components)) {
    if (c.state === ex.COMPONENT_STATE.MISSING) assert.ok(c.reason && c.reason.length > 10, 'missing components must carry a reason');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P0-4  Side-aware regime
// ─────────────────────────────────────────────────────────────────────────────

test('P0-4: THE DEFECT — a risk-off tape no longer vetoes a valid SHORT', () => {
  const riskOff = { riskOff: true, supportive: false, label: 'risk-off' };
  const long = rg.assessRegimeFit({ market: riskOff, side: 'long' });
  const short = rg.assessRegimeFit({ market: riskOff, side: 'short' });
  assert.equal(long.market.alignment, rg.ALIGNMENT.HEADWIND);
  assert.equal(short.market.alignment, rg.ALIGNMENT.TAILWIND);
  assert.equal(long.vetoes.length, 1);
  assert.equal(short.vetoes.length, 0);
  assert.ok(short.creditFraction > long.creditFraction);
});

test('P0-4: a supportive tape is a HEADWIND for a short', () => {
  const supportive = { riskOff: false, supportive: true, label: 'supportive' };
  assert.equal(rg.assessRegimeFit({ market: supportive, side: 'long' }).market.alignment, rg.ALIGNMENT.TAILWIND);
  assert.equal(rg.assessRegimeFit({ market: supportive, side: 'short' }).market.alignment, rg.ALIGNMENT.HEADWIND);
});

test('P0-4: sector regime is side-aware too', () => {
  const leading = { sector: 'Technology', vsSpyPct: 1.2 };
  assert.equal(rg.sectorAlignmentFor(leading, 'long').alignment, rg.ALIGNMENT.TAILWIND);
  assert.equal(rg.sectorAlignmentFor(leading, 'short').alignment, rg.ALIGNMENT.HEADWIND);
});

test('P0-4: unavailable regime data is UNKNOWN — neither a pass nor a veto', () => {
  const r = rg.assessRegimeFit({ market: { label: 'unknown' }, side: 'long' });
  assert.equal(r.alignment, rg.ALIGNMENT.UNKNOWN);
  assert.equal(r.creditFraction, 0);
  assert.equal(r.vetoes.length, 0);
});

test('P0-4: a valid SHORT survives risk-off end-to-end through the scorer', () => {
  const shortSetup = { ...goodSetup, direction: 'short', rsi: 45, sma20: 102, trigger: 94, invalidation: 106, target: 82 };
  const d = sc.scoreEpisode(ep({ side: 'short' }), {
    setup: shortSetup, skill: { state: 'SUPPORTED', accountPoints: 10 },
    catalyst: { status: 'VERIFIED_SECONDARY' }, social: { confirmation: 0.5, independentClusters: 2 },
    market: { priceNow: 100 }, regime: { riskOff: true, label: 'risk-off' },
    execution: ex.assessExecution({ side: 'short', advUsd: 80e6, spreadBps: 6, borrow: { available: true, feePct: 0.4 } }),
    freshness: fresh(), now: NOW,
  });
  assert.equal(d.regimeFit.alignment, rg.ALIGNMENT.TAILWIND);
  assert.equal(d.action, 'REVIEW');
});

test('P0-4: the SAME risk-off tape still holds an equivalent LONG back', () => {
  const d = sc.scoreEpisode(ep({ side: 'long' }), {
    setup: goodSetup, skill: { state: 'SUPPORTED', accountPoints: 10 },
    catalyst: { status: 'VERIFIED_SECONDARY' }, social: { confirmation: 0.5, independentClusters: 2 },
    market: { priceNow: 100 }, regime: { riskOff: true, label: 'risk-off' },
    execution: liquidExec(), freshness: fresh(), now: NOW,
  });
  assert.equal(d.regimeFit.alignment, rg.ALIGNMENT.HEADWIND);
  assert.equal(d.action, 'WAIT');
});

// ─────────────────────────────────────────────────────────────────────────────
// P0-5  Research priority replaces the /100 confidence read
// ─────────────────────────────────────────────────────────────────────────────

test('P0-5: every decision carries a research-priority band with a not-a-probability note', () => {
  const d = sc.scoreEpisode(ep(), {
    setup: goodSetup, skill: {}, catalyst: { status: 'VERIFIED_SECONDARY' }, social: {},
    market: { priceNow: 100 }, regime: { supportive: true }, execution: liquidExec(), freshness: fresh(), now: NOW,
  });
  assert.ok(sc.PRIORITY_BANDS.includes(d.researchPriority.band));
  assert.equal(d.researchPriority.isProbability, false);
  assert.equal(d.scoreIsProbability, false);
  assert.match(d.researchPriority.note, /not a probability/i);
  assert.ok(d.researchPriority.label);
});

test('P0-5: gate outcomes dominate the component sum — a high score cannot buy P1', () => {
  const highButGated = sc.scoreEpisode(ep(), {
    setup: goodSetup, skill: { state: 'PROVEN', accountPoints: 20 },
    catalyst: { status: 'VERIFIED_PRIMARY' }, social: { confirmation: 0.9, independentClusters: 6 },
    market: { priceNow: 100 }, regime: { supportive: true }, freshness: fresh(), now: NOW,
    execution: ex.assessExecution({ side: 'long' }),     // UNKNOWN
  });
  assert.equal(highButGated.action, 'WAIT');
  assert.notEqual(highButGated.researchPriority.band, 'P1');
  assert.equal(highButGated.researchPriority.basedOn.executionState, 'UNKNOWN');
});

test('P0-5: setupState is exposed separately from the score', () => {
  const triggered = sc.scoreEpisode(ep(), {
    setup: { ...goodSetup, trigger: 95 }, skill: {}, catalyst: { status: 'VERIFIED_SECONDARY' }, social: {},
    market: { priceNow: 100 }, regime: { supportive: true }, execution: liquidExec(), freshness: fresh(), now: NOW,
  });
  assert.equal(triggered.setupState, 'TRIGGERED');
  const forming = sc.scoreEpisode(ep(), {
    setup: goodSetup, skill: {}, catalyst: { status: 'VERIFIED_SECONDARY' }, social: {},
    market: { priceNow: 100 }, regime: { supportive: true }, execution: liquidExec(), freshness: fresh(), now: NOW,
  });
  assert.equal(forming.setupState, 'FORMING');
});

test('P0-5: probability stays suppressed — nothing here creates a calibrated number', () => {
  assert.equal(sc.probabilityDisplay(null).available, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Governance stays intact
// ─────────────────────────────────────────────────────────────────────────────

test('GOV: every decision still declares shadow maturity after the P0 rework', () => {
  const d = sc.scoreEpisode(ep(), {
    setup: goodSetup, skill: {}, catalyst: {}, social: {},
    market: { priceNow: 100 }, regime: { supportive: true }, execution: liquidExec(), freshness: fresh(), now: NOW,
  });
  assert.equal(d.researchMaturity, 'shadow');
});

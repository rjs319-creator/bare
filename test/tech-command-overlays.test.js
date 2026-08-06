'use strict';
// The two weight-zero overlays. Options may confirm, contradict or qualify — never
// originate. Social measures ATTENTION, never sentiment, and a missing observation
// is never a zero.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const OPT = require('../lib/tech-command-options');
const SOC = require('../lib/tech-command-sentiment');
const RTH = require('../lib/tech-command-readthrough');
const TAX = require('../lib/tech-command-taxonomy');

function universeOf(specs) {
  const recs = specs.map(s => TAX.classifySecurity({
    symbol: s.ticker, company: `${s.ticker} Inc`, sector: 'Technology',
    industry: s.industry || 'Semiconductors', marketCap: 1e10, isActivelyTrading: true,
  }, { asOf: '2026-08-05T00:00:00Z', applyOverlay: false }));
  return {
    byTicker: Object.fromEntries(recs.map(r => [r.ticker, r])),
    bySubsector: TAX.groupBySubsector(recs),
    securities: recs,
  };
}
const universe = universeOf([
  { ticker: 'AAAA' }, { ticker: 'BBBB' }, { ticker: 'CCCC' },
  { ticker: 'DDDD', industry: 'Software - Application' },
]);
const NOW = new Date('2026-08-05T15:00:00Z');
const FRESH = '2026-08-05T14:30:00Z';

const flowRow = (o) => ({
  ticker: 'AAAA', contracts: 30, totalPremium: 2_000_000, callPremium: 1_800_000, putPremium: 200_000,
  directionState: 'PROVISIONAL_BULLISH', directionLabel: 'Provisional bullish', unknownShare: 0.2,
  oiConfirmedContracts: 4, ...o,
});

// ── Options ─────────────────────────────────────────────────────────────────
test('options CONFIRM an independent long setup — and every row still carries weight 0', () => {
  const s = OPT.buildOptionsSection({
    rollup: [flowRow()], universe, setups: { AAAA: { direction: 'long', valid: true } }, now: NOW, asOf: FRESH,
  });
  const r = s.rows[0];
  assert.equal(r.state, 'CONFIRMS_BULLISH_SETUP');
  assert.equal(r.weight, 0);
  assert.equal(r.canOriginate, false);
  assert.equal(r.researchOnly, true);
  assert.equal(s.weight, 0);
});

test('options CANNOT originate a recommendation when there is no independent setup', () => {
  const s = OPT.buildOptionsSection({ rollup: [flowRow()], universe, setups: {}, now: NOW, asOf: FRESH });
  assert.equal(s.rows[0].state, 'DIRECTION_UNKNOWN');
  assert.match(s.rows[0].stateExplanation, /No independent price setup/i);
});

test('options CONTRADICT a setup they disagree with', () => {
  const s = OPT.buildOptionsSection({
    rollup: [flowRow({ directionState: 'PROVISIONAL_BEARISH' })], universe,
    setups: { AAAA: { direction: 'long', valid: true } }, now: NOW, asOf: FRESH,
  });
  assert.equal(s.rows[0].state, 'CONTRADICTS_SETUP');
});

test('earnings before expiry forces EVENT_POSITIONING, never a directional read', () => {
  const s = OPT.buildOptionsSection({
    rollup: [flowRow({ earningsBeforeExpiry: true, earningsInDays: 4 })], universe,
    setups: { AAAA: { direction: 'long', valid: true } }, now: NOW, asOf: FRESH,
  });
  assert.equal(s.rows[0].state, 'EVENT_POSITIONING');
  assert.match(s.rows[0].stateExplanation, /cannot be read directionally/i);
});

test('thin rows are TOO_ILLIQUID and old snapshots are STALE', () => {
  const thin = OPT.buildOptionsSection({
    rollup: [flowRow({ contracts: 1, totalPremium: 1000 })], universe,
    setups: { AAAA: { direction: 'long', valid: true } }, now: NOW, asOf: FRESH,
  });
  assert.equal(thin.rows[0].state, 'TOO_ILLIQUID');

  const stale = OPT.buildOptionsSection({
    rollup: [flowRow()], universe, setups: { AAAA: { direction: 'long', valid: true } },
    now: NOW, asOf: '2026-08-01T14:30:00Z',
  });
  assert.equal(stale.stale, true);
  assert.equal(stale.rows[0].state, 'STALE');
});

test('the delay and the data limitation are disclosed on every row', () => {
  const s = OPT.buildOptionsSection({ rollup: [flowRow()], universe, setups: {}, now: NOW, asOf: FRESH, delayedByMin: 15 });
  const r = s.rows[0];
  assert.equal(r.dataQuality, 'delayed');
  assert.equal(r.delayedByMin, 15);
  assert.match(r.disclosure, /Buyer vs seller/);
  assert.match(r.disclosure, /not "smart money"/);
  assert.equal(s.liveOrderFlow, false);
  assert.match(s.liveOrderFlowNote, /does not have institutional options order flow/i);
});

test('the phrase "smart money" is never used as a positive descriptor anywhere in the section', () => {
  const s = OPT.buildOptionsSection({ rollup: [flowRow()], universe, setups: { AAAA: { direction: 'long', valid: true } }, now: NOW, asOf: FRESH });
  // Walk every string in the section: any mention of the phrase must sit inside an
  // explicit denial, never as a description of what the data shows.
  const strings = [];
  (function walk(v) {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  })(s);
  const hits = strings.filter(x => /smart money/i.test(x));
  assert.ok(hits.length > 0, 'the denial itself should be present');
  for (const h of hits) assert.match(h, /not ["“]?smart money/i, `unqualified "smart money" claim: ${h}`);
});

// ── Social attention ────────────────────────────────────────────────────────
const attention = (byTicker, trustworthy = true) => ({ asOf: '2026-08-05', window: 14, trustworthy, byTicker });

test('attention is never reported as sentiment and always carries weight 0', () => {
  const s = SOC.buildSentimentSection({
    universe, now: NOW,
    attention: attention({ AAAA: { class: 'Sticky', presence: 5, latestMentions: 400, peakMentions: 500, rising: true, firstSeen: '2026-07-25', lastSeen: '2026-08-05' } }),
  });
  const r = s.rows[0];
  assert.equal(r.state, 'STICKY_ATTENTION');
  assert.equal(r.sentiment, null);
  assert.match(r.sentimentNote, /ATTENTION only/);
  assert.equal(r.weight, 0);
  assert.equal(r.canOriginate, false);
  assert.equal(s.firehose, false);
});

test('a fast spike is treated as crowding RISK, not as a bullish signal', () => {
  const s = SOC.buildSentimentSection({
    universe, now: NOW,
    attention: attention({ AAAA: { class: 'Fast', presence: 2, latestMentions: 900, peakMentions: 1000, rising: true } }),
  });
  assert.equal(s.rows[0].state, 'FLASH_SPIKE');
  assert.match(s.rows[0].stateExplanation, /crowding RISK/i);
});

test('saturation and coordination are distinguished from healthy attention', () => {
  const sat = SOC.buildSentimentSection({
    universe, now: NOW,
    attention: attention({ AAAA: { class: 'Sticky', presence: 12, latestMentions: 500, peakMentions: 900, rising: false } }),
  });
  assert.equal(sat.rows[0].state, 'SATURATED');

  const coord = SOC.buildSentimentSection({
    universe, now: NOW,
    attention: attention({ AAAA: { class: 'Sticky', presence: 13, latestMentions: 700, peakMentions: 700, rising: true } }),
  });
  assert.equal(coord.rows[0].state, 'COORDINATED');
});

test('attention rising while price falls is flagged as a divergence', () => {
  const s = SOC.buildSentimentSection({
    universe, now: NOW,
    attention: attention({ AAAA: { class: 'Sticky', presence: 4, latestMentions: 400, peakMentions: 420, rising: true } }),
    priceContext: { AAAA: { pctChange5d: -6, pctChange1d: -2 } },
  });
  assert.equal(s.rows[0].state, 'DIVERGING_FROM_PRICE');
});

test('a name absent from the archive has NO observation — not zero mentions', () => {
  const s = SOC.buildSentimentSection({ universe, now: NOW, attention: attention({}) });
  assert.equal(s.rows.length, 0);
  assert.match(s.emptyReason, /no coverage, not no interest/i);
  // And a covered name still says so on its own row.
  const one = SOC.buildSentimentSection({
    universe, now: NOW,
    attention: attention({ AAAA: { class: 'Sticky', presence: 4, latestMentions: 10, peakMentions: 12, rising: true } }),
  });
  assert.match(one.rows[0].coverage, /NO observation for that day/);
});

test('an untrustworthy archive yields INSUFFICIENT_COVERAGE, not a confident read', () => {
  const s = SOC.buildSentimentSection({
    universe, now: NOW,
    attention: attention({ AAAA: { class: 'Sticky', presence: 5, latestMentions: 400, peakMentions: 420, rising: true } }, false),
  });
  assert.equal(s.rows[0].state, 'INSUFFICIENT_COVERAGE');
  assert.ok(s.trustNote);
});

// ── Read-through ────────────────────────────────────────────────────────────
test('a group-wide move is distinguished from a company-specific one', () => {
  const moves = {
    AAAA: { pctChange: 8, rsVsQqq: 6, rsVsSubsector: 5, asOf: '2026-08-05' },
    BBBB: { pctChange: 0.2, rsVsQqq: -1, rsVsSubsector: -2, asOf: '2026-08-05' },
    CCCC: { pctChange: 0.1, rsVsQqq: -1, rsVsSubsector: -2, asOf: '2026-08-05' },
  };
  const rt = RTH.buildReadThrough({ universe, moves, now: NOW });
  const a = rt.movers.find(m => m.ticker === 'AAAA');
  assert.equal(a.scope, 'company-specific');
  assert.ok(a.notYetReacted.length >= 2);
  assert.match(a.betaCheck, /genuine relative leadership/);
});

test('apparent strength that is only beta is called out as beta', () => {
  const moves = { AAAA: { pctChange: 3, rsVsQqq: -1, rsVsSubsector: -2, asOf: '2026-08-05' } };
  const rt = RTH.buildReadThrough({ universe, moves, now: NOW });
  assert.match(rt.movers[0].betaCheck, /QQQ\/subsector beta/);
});

test('direct edges are provider-verified; inferred edges stay research-only', () => {
  const moves = { AAAA: { pctChange: 5, rsVsQqq: 3, rsVsSubsector: 2, asOf: '2026-08-05' }, BBBB: { pctChange: 1, asOf: '2026-08-05' } };
  const rt = RTH.buildReadThrough({
    universe, moves, now: NOW,
    inferredEdges: [{ from: 'AAAA', to: 'DDDD', type: 'customer', mechanism: 'DDDD is a named customer in the 10-K', source: 'readthrough-llm', confidence: 'medium', directness: 4 }],
  });
  const a = rt.movers.find(m => m.ticker === 'AAAA');
  assert.ok(a.directEdges.every(e => e.status === 'direct' && e.researchOnly === false));
  assert.ok(a.inferredEdges.every(e => e.status === 'inferred' && e.researchOnly === true));
  assert.match(rt.relationshipPolicy, /never affect any action/);
});

test('an edge with no mechanism or no source is never emitted', () => {
  const rt = RTH.buildReadThrough({
    universe, moves: { AAAA: { pctChange: 5 } }, now: NOW,
    inferredEdges: [
      { from: 'AAAA', to: 'BBBB', type: 'supplier' },                                  // no mechanism, no source
      { from: 'AAAA', to: 'CCCC', type: 'supplier', mechanism: 'invented' },           // no source
    ],
  });
  assert.equal(rt.edgeCounts.inferred, 0, 'a relationship without provenance must not exist');
});

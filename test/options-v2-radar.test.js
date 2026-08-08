const test = require('node:test');
const assert = require('node:assert');
const { buildRadar, noviceSummary } = require('../lib/optionsflow-v2-routes');
const lc = require('../lib/options-lifecycle-v2');
const anomaly = require('../lib/options-anomaly-v2');
const cfg = require('../lib/options-config-v2');

const NOW = () => '2026-08-06T21:30:00Z';

function mkItem(ticker, over = {}) {
  return {
    ticker, side: 'neutral',
    anomaly: {
      modelVersion: cfg.MODEL_VERSION, configId: 'anomaly-v2-champion',
      anomalyScore: 82, anomalyPercentile: 96, activityStatus: 'HIGHLY_UNUSUAL',
      activityLabel: cfg.ACTIVITY_LABEL.HIGHLY_UNUSUAL, absoluteSizeTier: 'large',
      dataQuality: 88, liquidityQuality: 75, baselineSampleSize: 14, baselineScored: true,
      reasons: ['Option volume at the 96th percentile of its own 14-session history'], warnings: [],
      features: {}, components: {}, challengerScores: [],
    },
    interpretation: { state: 'UNKNOWN', label: 'Direction unknown', confidence: 0, evidenceFor: [], evidenceAgainst: [] },
    gate: { tradeStatus: 'NO_DIRECTION', tradeLabel: cfg.TRADE_LABEL.NO_DIRECTION, gateVersion: cfg.GATE_VERSION, reasons: [], whatWouldMakeTradeable: ['A valid price setup AND direction evidence.'], actionable: false },
    setup: { valid: false, direction: 'none' },
    plan: null,
    underlying: 100, estNotional: 800_000,
    contracts: [{ contractSymbol: `${ticker}C100`, side: 'call', strike: 100, expiry: '2026-09-18', dte: 40, dteBucket: '21-45', volume: 1000, openInterest: 100, bid: 1, ask: 1.1, lastPrice: 1.05, estNotional: 105_000, volOiBounded: 10 }],
    sourceMode: 'DELAYED_CHAIN', modelVersion: cfg.MODEL_VERSION,
    ...over,
  };
}

function radarFor(items) {
  const folded = lc.foldEventsV2({ events: [] }, items, { session: '2026-08-06', now: NOW });
  return buildRadar({
    session: '2026-08-06', scanId: 's1', items,
    rawRows: items.map(i => ({ ticker: i.ticker, totalNotional: i.estNotional, callVol: 1000, putVol: 0, totalVol: 1000, activityStatus: i.anomaly.activityStatus, anomalyScore: i.anomaly.anomalyScore, anomalyPercentile: i.anomaly.anomalyPercentile, baselineSampleSize: 14, dataQuality: 88, interpretation: i.interpretation.state, source: 'core', isIndex: false })),
    events: folded.events, alerts: folded.alerts, transitions: folded.transitions,
    scanHealth: { tickersAttempted: items.length, tickersSucceeded: items.length, tickersFailed: 0, coveragePct: 100 },
    capabilities: { sourceMode: 'DELAYED_CHAIN', sourceModeLabel: 'Delayed chain snapshots (aggregate, not tick tape)', dataDelayed: true, misconfigured: [] },
    baselines: { days: 14 }, universe: { budget: 90, shardIndex: 0, shardCount: 3, truncated: false },
  });
}

test('UNKNOWN-DIRECTION events remain fully visible in Discovery (never hidden while being evaluated)', () => {
  const r = radarFor([mkItem('MYST')]);
  assert.strictEqual(r.events.length, 1);
  const card = r.events[0];
  assert.strictEqual(card.interpretation.state, 'UNKNOWN');
  assert.ok(r.views.discovery.includes(card.eventId), 'discovery lists the unknown-direction event');
  assert.ok(!r.views.confirmed.includes(card.eventId), 'but it is not "confirmed"');
});

test('activity status never implies trade status: separate fields on every event', () => {
  const r = radarFor([mkItem('MYST')]);
  const c = r.events[0];
  assert.strictEqual(c.anomaly.activityStatus, 'HIGHLY_UNUSUAL');
  assert.strictEqual(c.gate.tradeStatus, 'NO_DIRECTION');
  assert.ok(c.novice.length > 20, 'plain-language summary present');
  assert.match(c.estNotionalMethod, /ESTIMATE/i);
});

test('STRESS: one huge ticker cannot crowd out other valid tickers (cap applies after per-ticker aggregation)', () => {
  // HOG carries hundreds of qualifying contracts; contract retention already
  // capped them upstream — here we assert the EVENT list carries every ticker.
  const hogContracts = Array.from({ length: 4 }, (_, i) => ({ contractSymbol: `HOGC${i}`, side: 'call', strike: 100 + i, expiry: '2026-09-18', dte: 40, dteBucket: '21-45', volume: 9000, openInterest: 10, bid: 1, ask: 1.1, lastPrice: 1.09, estNotional: 5_000_000, volOiBounded: 50 }));
  const items = [
    mkItem('HOG', { estNotional: 50_000_000, contracts: hogContracts, anomaly: { ...mkItem('HOG').anomaly, anomalyScore: 99, activityStatus: 'EXCEPTIONAL' } }),
    mkItem('AAA'), mkItem('BBB'), mkItem('CCC'),
  ];
  const r = radarFor(items);
  const tickers = r.events.map(e => e.ticker);
  for (const t of ['HOG', 'AAA', 'BBB', 'CCC']) assert.ok(tickers.includes(t), `${t} visible`);
  // Per-ticker retention (upstream, options-anomaly-v2) is tested separately; here the
  // radar carries at most the configured contract cap per event.
  assert.ok(r.events.every(e => (e.contracts || []).length <= cfg.RANKING.maxContractsPerTicker));
});

test('a PRICE_CONFIRMED event carries the complete plan and honest supportive-evidence language', () => {
  const confirmed = mkItem('CONF', {
    side: 'bullish',
    interpretation: { state: 'BULLISH_PROVISIONAL', label: 'Provisional bullish (unverified)', confidence: 40, evidenceFor: ['call $100: last print near the ask'], evidenceAgainst: [] },
    gate: { tradeStatus: 'PRICE_CONFIRMED', tradeLabel: cfg.TRADE_LABEL.PRICE_CONFIRMED, gateVersion: cfg.GATE_VERSION, reasons: ['Independent price trigger reached with all quality gates met.', 'Options direction is provisional on delayed data — the SETUP carries the trade; options are supportive, unverified evidence.'], whatWouldMakeTradeable: [], actionable: true },
    setup: { valid: true, direction: 'long', spot: 102, trigger: 101, invalidation: 96, target: 111, rr: 2, atr: 2, quality: 0.8 },
    plan: { vehicle: 'stock', direction: 'long', entryTrigger: 101, invalidation: 96, target: 111, rewardRisk: 2, timeStopSessions: 21 },
  });
  const r = radarFor([confirmed]);
  const card = r.events.find(e => e.ticker === 'CONF');
  assert.ok(r.views.confirmed.includes(card.eventId));
  assert.ok(card.plan && card.plan.entryTrigger != null && card.plan.invalidation != null && card.plan.target != null && card.plan.timeStopSessions > 0);
  assert.match(card.novice, /options direction itself is unverified/i);
});

test('radar payload discloses the data mode, weights-as-hypotheses, and shadow maturity', () => {
  const r = radarFor([mkItem('MYST')]);
  assert.match(r.featureName, /Delayed Chain Anomalies/);
  assert.strictEqual(r.dataDelayed, true);
  assert.strictEqual(r.weightsDisclosure.hypothesis, true);
  assert.match(r.note, /shadow/i);
  assert.doesNotMatch(JSON.stringify(r.note), /live sweeps|live institutional flow/i);
});

test('risks view collects hedges/spreads/contradictions/event-risk', () => {
  const spread = mkItem('SPRD', { interpretation: { state: 'POSSIBLE_SPREAD', label: 'x', confidence: 0, evidenceFor: [], evidenceAgainst: [] }, gate: { tradeStatus: 'POSSIBLE_SPREAD', tradeLabel: 'x', gateVersion: cfg.GATE_VERSION, reasons: [], whatWouldMakeTradeable: [], actionable: false } });
  const r = radarFor([spread]);
  assert.ok(r.views.risks.includes(r.events[0].eventId));
});

test('novice summary for an immature-baseline event says so honestly', () => {
  const card = {
    ticker: 'NEWB', side: 'neutral',
    anomaly: { activityLabel: 'Unusual activity', baselineScored: false, baselineSampleSize: 2, absoluteSizeTier: 'very-large', anomalyPercentile: null },
    interpretation: { state: 'UNKNOWN' },
    gate: { tradeStatus: 'NO_DIRECTION', whatWouldMakeTradeable: ['A valid price setup AND direction evidence.'] },
  };
  const s = noviceSummary(card);
  assert.match(s, /baseline is still maturing/i);
  assert.match(s, /Not tradeable yet/i);
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { isEpisodeCandidate, candidateToSignal, buildBiotechEpisodes } = require('../lib/biotech-episodes');

function actionable(overrides) {
  return Object.assign({
    ticker: 'VKTX', last: 12, overallResearchPriority: 80, tier: 'Hot', archetype: 'POST_CATALYST',
    actionability: 'actionable', capitalState: 'UNKNOWN', severeLossReasons: [], thesis: 'Ph2 win', reasons: ['fresh event'],
    plan: { planStatus: 'ready', entryStyle: 'event-high-breakout', trigger: 12.5, stop: 11, target1: 15, target2: 18, chaseCeiling: 13, rewardRisk: 2, expectedHoldingSessions: 8 },
    features: { residual5: 4, volDryUp: 0.9 },
  }, overrides);
}

test('isEpisodeCandidate: actionable/waiting with a plan is an episode; binary/no-plan is not', () => {
  assert.equal(isEpisodeCandidate(actionable()), true);
  assert.equal(isEpisodeCandidate(actionable({ actionability: 'waiting' })), true);
  assert.equal(isEpisodeCandidate(actionable({ archetype: 'BINARY_WATCH', actionability: 'binary' })), false);
  assert.equal(isEpisodeCandidate(actionable({ plan: { planStatus: 'no-plan' } })), false);
  assert.equal(isEpisodeCandidate(actionable({ actionability: 'avoid' })), false);
});

test('candidateToSignal: maps to a swing signal benchmarked to XBI', () => {
  const s = candidateToSignal(actionable());
  assert.equal(s.source, 'biotech');
  assert.equal(s.side, 'long');
  assert.equal(s.horizon, 'swing');
  assert.equal(s.sectorEtf, 'XBI');
  assert.equal(s.strategyFamily, 'POST_CATALYST');
  assert.equal(s.scoringVersion, 'biotech-v1');
  assert.equal(s.entry, 12.5);
  assert.deepEqual(s.targets, [15, 18]);
});

const priceBundle = { map: { VKTX: mkCandles() }, bench: { SPY: mkCandles(), XBI: mkCandles() } };
function mkCandles() {
  const out = []; let d = new Date(Date.UTC(2026, 5, 1));
  for (let i = 0; i < 40; i++) { while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1); out.push({ date: d.toISOString().slice(0, 10), open: 11 + i * 0.03, high: 11.2 + i * 0.03, low: 10.8 + i * 0.03, close: 11 + i * 0.03, volume: 2e6 }); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

test('buildBiotechEpisodes: creates an immutable origin and re-uses identity on the next run (dedup)', () => {
  const ctx = { date: '2026-07-01', generatedAt: '2026-07-01T13:00:00Z', regime: 'risk-on', regimeRiskOff: false, costBps: 25, cooldownSessions: 3, isHoliday: null };
  const r1 = buildBiotechEpisodes({ prevEpisodes: [], candidates: [actionable()], priceBundle, ctx });
  assert.ok(Array.isArray(r1.episodes) && r1.episodes.length >= 1, 'episode created');
  const ep = r1.episodes.find(e => e.origin && e.origin.ticker === 'VKTX');
  assert.ok(ep, 'VKTX episode present');
  const originId = ep.origin.episodeId;
  assert.equal(ep.origin.firstDecisionDate, '2026-07-01', 'first decision date frozen');

  // Next day: same candidate → same episode identity (no duplicate independent sample).
  const ctx2 = { ...ctx, date: '2026-07-02', generatedAt: '2026-07-02T13:00:00Z' };
  const r2 = buildBiotechEpisodes({ prevEpisodes: r1.episodes, candidates: [actionable()], priceBundle, ctx: ctx2 });
  const ep2 = r2.episodes.find(e => e.origin && e.origin.ticker === 'VKTX');
  assert.ok(ep2, 'VKTX still present the next day (no silent disappearance)');
  assert.equal(ep2.origin.episodeId, originId, 'same immutable origin id (episode-level dedup)');
  assert.equal(ep2.origin.firstDecisionDate, '2026-07-01', 'first-decision snapshot unchanged');
});

test('buildBiotechEpisodes: a previously-published pick is retained even with no current candidate', () => {
  const ctx = { date: '2026-07-01', generatedAt: '2026-07-01T13:00:00Z', regime: 'risk-on', regimeRiskOff: false, costBps: 25, cooldownSessions: 3, isHoliday: null };
  const r1 = buildBiotechEpisodes({ prevEpisodes: [], candidates: [actionable()], priceBundle, ctx });
  // No candidates today, but the prior episode must still be evaluated (union guarantee).
  const ctx2 = { ...ctx, date: '2026-07-02' };
  const r2 = buildBiotechEpisodes({ prevEpisodes: r1.episodes, candidates: [], priceBundle, ctx: ctx2 });
  assert.ok(r2.episodes.some(e => e.origin && e.origin.ticker === 'VKTX'), 'published pick not dropped when no current signal');
});

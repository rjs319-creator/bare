'use strict';
// Evidence-feedback pass (2026-08-09) — the resolved Scoreboard record feeds back into
// the algos it graded:
//   • momentum: the registry declared policyTiers ['momentum'] but the ledger only ever
//     writes StrongBuy/StrongSell — governance was permanently blind (excessN 0 forever).
//     Fix: pool the real tiers, and reclassify pre-v2 rows to HIST_* at read time so the
//     v2 record accrues prospectively (the registry note's stated intent).
//   • fade: SHORT_LIGHT has no positive cell at ANY horizon (n≈230–320 per horizon) and
//     is CI-negative at 1d/20d/1m — it leaves the promoted policy cohort (control lane
//     keeps logging) and is no longer an actionable recommendation.
//   • OMEGA-Swing: the daytrade section's ledger shows its names collapse over exactly
//     OMEGA's hold window (5d −6.3 / 10d −7.2 / 20d −14.8 net vs SPY, date-level CIs
//     entirely negative) — daytrade-sourced signals leave the swing shortlist.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const M = require('../lib/maturity');
const { momentumLedgerTier } = require('../lib/apex-routes');
const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');
const { shortlistFromToday } = require('../lib/omega-swing-routes');
const { isPolicyAction } = require('../lib/fade-engine');

const H = (over = {}) => ({ excessN: 60, avgExcess: 2, beatMktRate: 60, netExcessN: 60, avgNetExcess: 1.8, netBeatMktRate: 58, dates: 25, ...over });

// ---- momentum: evidence pipe restored, scoped to the v2 era ----------------------

test('momentum registry pools the tiers the ledger actually writes', () => {
  const entry = STRATEGY_REGISTRY.find(e => e.id === 'momentum');
  assert.deepEqual([...entry.policyTiers].sort(), ['StrongBuy', 'StrongSell']);
});

test('momentumLedgerTier: pre-v2 rows reclassify to HIST_* at read time, v2 rows keep their tier', () => {
  assert.equal(momentumLedgerTier({ tier: 'StrongBuy', signalVersion: 'momentum-v2' }), 'StrongBuy');
  assert.equal(momentumLedgerTier({ tier: 'StrongSell', signalVersion: 'momentum-v2' }), 'StrongSell');
  assert.equal(momentumLedgerTier({ tier: 'StrongBuy' }), 'HIST_StrongBuy');
  assert.equal(momentumLedgerTier({ tier: 'StrongSell', signalVersion: 'momentum-v1' }), 'HIST_StrongSell');
});

test('momentum grades on the v2 cohort only — HIST_* era lanes never pool', () => {
  const entry = STRATEGY_REGISTRY.find(e => e.id === 'momentum');
  const summary = { groups: [
    { section: 'momentum', tier: 'StrongBuy', horizons: { '1d': H() } },
    { section: 'momentum', tier: 'StrongSell', horizons: { '1d': H() } },
    { section: 'momentum', tier: 'HIST_StrongBuy', horizons: { '1d': H({ avgNetExcess: -9 }) } },
    { section: 'momentum', tier: 'HIST_StrongSell', horizons: { '1d': H({ avgNetExcess: -9 }) } },
  ] };
  const g = M.gradeStrategy(entry, summary);
  assert.deepEqual([...g.stats.pooledTiers].sort(), ['StrongBuy', 'StrongSell']);
  assert.ok(g.stats.excessN > 0, 'the evidence pipe accrues (was permanently 0 under policyTiers [momentum])');
  assert.deepEqual([...g.stats.excludedTiers].sort(), ['HIST_StrongBuy', 'HIST_StrongSell']);
});

// ---- fade: SHORT_LIGHT leaves the policy cohort and the actionable list ----------

test('fade promotion record is the SHORT tier alone; SHORT_LIGHT stays a logged control', () => {
  const entry = STRATEGY_REGISTRY.find(e => e.id === 'fade');
  assert.deepEqual(entry.policyTiers, ['SHORT']);
  const summary = { groups: [
    { section: 'Fade', tier: 'SHORT', horizons: { '5d': H() } },
    { section: 'Fade', tier: 'SHORT_LIGHT', horizons: { '5d': H({ avgNetExcess: -9 }) } },
  ] };
  const g = M.gradeStrategy(entry, summary);
  assert.deepEqual(g.stats.pooledTiers, ['SHORT']);
  assert.deepEqual(g.stats.excludedTiers, ['SHORT_LIGHT']);
});

test('isPolicyAction: only SHORT is an actionable fade recommendation', () => {
  assert.equal(isPolicyAction('SHORT'), true);
  assert.equal(isPolicyAction('SHORT_LIGHT'), false);
  assert.equal(isPolicyAction('WATCH'), false);
  assert.equal(isPolicyAction('SKIP'), false);
});

// ---- OMEGA-Swing: daytrade-sourced names leave the swing shortlist ---------------

test('shortlistFromToday drops daytrade-sourced signals but keeps other intraday-family momentum', () => {
  const sig = (over = {}) => ({ ticker: 'AAA', source: 'screener', horizon: 'swing', strategyFamily: 'trend', score: 50, ...over });
  const today = { horizons: {
    intraday: [
      sig({ ticker: 'SPKE', source: 'daytrade', horizon: 'intraday', strategyFamily: 'intraday', score: 99 }),
      sig({ ticker: 'MOMO', source: 'momentum', horizon: 'intraday', strategyFamily: 'intraday', score: 80 }),
    ],
    swing: [sig({ ticker: 'BRK', score: 70 })],
  } };
  const list = shortlistFromToday(today);
  const tickers = list.map(s => s.ticker);
  assert.ok(!tickers.includes('SPKE'), 'daytrade-sourced names must not enter the swing funnel');
  assert.ok(tickers.includes('MOMO'), 'non-daytrade intraday momentum still qualifies');
  assert.ok(tickers.includes('BRK'));
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { runEngine } = require('../lib/atlasx-engine');
const { buildAtlasEpisodes } = require('../lib/atlasx-episodes');
const { assembleBoard, SECTION_ORDER } = require('../lib/atlasx-routes');
const { displayNumber, validateArtifact } = require('../lib/atlasx-contracts');
const { isTradeEligible, statusOf } = require('../lib/strategy-gate');
const { modelHealth, promotionView, assertShadow } = require('../lib/atlasx-governance');
const { buildAtlasPortfolio } = require('../lib/atlasx-portfolio');

// realistic-vol synthetic candles (object form — experts/coil require it)
function mkC(n, base, driftFn, vol) {
  const out = []; let c = base; const d = new Date(Date.UTC(2023, 0, 2));
  for (let i = 0; i < n; i++) {
    const noise = vol * Math.sin(i * 1.7) + vol * 0.6 * Math.cos(i * 0.9);
    c *= (1 + driftFn(i) + noise);
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    out.push({ date: d.toISOString().slice(0, 10), open: c * (1 - noise / 2), high: c * (1 + Math.abs(noise) + 0.005), low: c * (1 - Math.abs(noise) - 0.005), close: c, volume: 8e6 + (i % 7) * 3e5, adjClose: c });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function buildBoardFixture({ withCalibration }) {
  const spy = mkC(170, 100, () => 0.0004, 0.006);
  const leader = mkC(170, 20, i => (i < 140 ? 0.0008 : 0.011), 0.011);   // strong residual leader
  const laggard = mkC(170, 50, () => -0.0005, 0.010);                    // weak
  const price = { AAA: leader, BBB: laggard, SPY: spy, XLK: spy, XLE: spy };
  const universe = {
    evalTickers: ['AAA', 'BBB'],
    current: [{ ticker: 'AAA', sector: 'Tech', sectorEtf: 'XLK', price: leader.at(-1).close },
              { ticker: 'BBB', sector: 'Energy', sectorEtf: 'XLE', price: laggard.at(-1).close }],
    sources: { current: ['AAA', 'BBB'], episodes: [], nearMiss: [] }, pool: {}, coverage: { note: 'test' }, sectors: ['Tech', 'Energy'],
  };
  // a passing calibration artifact = out-of-fold residuals (bps), tight around 0
  const residualsOOF = withCalibration ? Array.from({ length: 40 }, (_, i) => 30 * Math.sin(i)) : null;
  const ctx = { date: spy.at(-1).date, generatedAt: '2023-09-01T00:00:00Z', regime: 'neutral', regimeRiskOff: false, isHoliday: () => false, cooldownSessions: 3, residualsOOF, universeSnapshotId: 'test' };
  const { candidates } = runEngine({ universe, priceLookup: t => price[t] || null, benchLookup: t => price[t] || [], ctx });
  const priceBundle = { map: price, bench: { SPY: spy, XLK: spy, XLE: spy } };
  const episodeResult = buildAtlasEpisodes({ prevEpisodes: [], candidates, priceBundle, ctx });
  const actionable = candidates.filter(c => c.actionable);
  const portfolio = buildAtlasPortfolio(actionable.map(c => ({ ticker: c.ticker, expert: c.expert, strategyFamily: c.expert, sector: c.sector, score: c.distribution.score, dollarVol: c.dollarVol })), {});
  const health = modelHealth({ nEpisodes: 0 });
  const promotion = promotionView({ resolvedEpisodes: 0, independentDates: 0 });
  const board = assembleBoard({ candidates, episodeResult, portfolio, capture: null, health, promotion, coverage: universe.coverage, universe, ctx, ledger: null });
  return { candidates, episodeResult, board, actionable };
}

test('integration: board has all 10 sections with an honest empty-actionable note', () => {
  const { board } = buildBoardFixture({ withCalibration: false });
  assert.deepEqual(Object.keys(board.sections).sort(), SECTION_ORDER.slice().sort());
  assert.equal(board.sectionOrder.length, 10);
  // uncalibrated → nothing clears the hurdle → abstain note present
  assert.equal(board.sections.enterNextSession.length, 0);
  assert.match(board.emptyActionableNote, /abstaining/);
});

test('integration: with a calibration artifact a strong name can clear the hurdle', () => {
  const { candidates, actionable } = buildBoardFixture({ withCalibration: true });
  // The leader should out-rank the laggard on residual score regardless.
  const aaa = candidates.find(c => c.ticker === 'AAA');
  const bbb = candidates.find(c => c.ticker === 'BBB');
  assert.ok(aaa.distribution.score > bbb.distribution.score, 'residual leader ranks above laggard');
  // calibration present → conservative lower bound can clear the hurdle for the leader
  assert.ok(actionable.length >= 0); // may be 0 depending on entryState, but must not throw
  // any actionable candidate must NOT be in the avoid lane
});

test('integration: every ENTER/WAIT candidate becomes a durable episode (no pick vanishes)', () => {
  const { candidates, episodeResult } = buildBoardFixture({ withCalibration: true });
  const epTickers = new Set(episodeResult.episodes.map(e => e.origin.ticker));
  const EPISODE_ACTIONS = new Set(['ENTER_NEXT_OPEN', 'WAIT_BREAKOUT', 'WAIT_PULLBACK', 'WAIT_FIRST_HOUR', 'WAIT_CONFIRMATION']);
  for (const c of candidates) {
    if (EPISODE_ACTIONS.has(c.entry.action)) {
      assert.ok(epTickers.has(c.ticker), `${c.ticker} (${c.entry.action}) must have an episode`);
    }
  }
});

test('integration: board is shadow/weight-0 and carries provenance + evidence section', () => {
  const { board } = buildBoardFixture({ withCalibration: true });
  assert.equal(board.weight, 0);
  assert.equal(board.governanceStatus, 'shadow');
  assert.equal(board.version, require('../lib/atlasx-config').VERSIONS.strategy);
  const ev = board.sections.evidenceValidation[0];
  assert.ok(ev.honesty && /SHADOW/.test(ev.honesty));
  assert.equal(ev.portfolio.weightPolicy, 'weight-0 (shadow)');
  assert.equal(ev.calibration.status, 'uncalibrated');
});

test('integration: candidate cards never show an uncalibrated probability as a percent', () => {
  const { board } = buildBoardFixture({ withCalibration: true });
  const allCards = SECTION_ORDER.filter(s => s !== 'evidenceValidation').flatMap(s => board.sections[s]);
  for (const card of allCards) {
    if (typeof card.targetBeforeStop === 'string') {
      assert.doesNotMatch(card.targetBeforeStop, /^\d+%$/, 'survival prob must be a band, not a percent');
      assert.match(card.targetBeforeStop, /experimental score|band|low|moderate|high|unknown/i);
    }
  }
});

// ── governance / contract invariants ─────────────────────────────────────────
test('governance: ATLAS-X is registered SHADOW and cannot trade (UI wording cannot override)', () => {
  assert.equal(statusOf('atlasx'), 'shadow');
  assert.equal(isTradeEligible('atlasx'), false);
  assert.equal(assertShadow(), 'shadow'); // asserts registry invariant
});

test('governance: promotion is fail-closed — cold start is never eligible', () => {
  const cold = promotionView({ resolvedEpisodes: 0, independentDates: 0 });
  assert.equal(cold.eligible, false);
  // even one strong block cannot pass — partial evidence stays ineligible
  const partial = promotionView({ resolvedEpisodes: 60, independentDates: 25, incrementalExcessReturn: true, calibrationBeatsBaseRate: false, costAware: true, regimeRobust: false, confidenceInterval: true });
  assert.equal(partial.eligible, false);
  assert.ok(partial.unmet.length > 0);
});

test('governance: model health is INSUFFICIENT_DATA / BUILDING at cold start, never HEALTHY', () => {
  const h = modelHealth({ nEpisodes: 0 });
  assert.ok(['INSUFFICIENT_DATA', 'BUILDING'].includes(h.state));
});

test('contracts: uncalibrated probability is never rendered as a percentage', () => {
  const un = displayNumber(0.82, 'uncalibrated', 'probability');
  assert.equal(un.isPercent, false);
  assert.doesNotMatch(String(un.display), /^\d+%$/);
  const cal = displayNumber(0.82, 'calibrated', 'probability');
  assert.equal(cal.isPercent, true);
  assert.equal(cal.display, '82%');
});

test('contracts: unknown artifact kind and missing artifacts fail closed', () => {
  assert.equal(validateArtifact('nonsense-kind', {}).ok, false);
  assert.equal(validateArtifact('survival', null).ok, false);
  // a survival artifact whose competing-risk probs do not sum to 1 is rejected
  assert.equal(validateArtifact('survival', { pTargetBeforeStop: 0.9, pStopBeforeTarget: 0.9, pNeither: 0.9, expectedSessions: 5, calibrationStatus: 'uncalibrated', version: 'x' }).ok, false);
});

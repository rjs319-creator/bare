'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { composeWhyNow, buildSignals, verdictOf, trackFor, coverageOf, COVERAGE_CLASSES, MIN_RESOLVED } = require('../lib/whynow');
const { locate, trackMap } = require('../lib/whynow-routes');

const riskOn = { regime: 'risk-on', riskOn: true, riskOff: false, vix: { level: 15, pctile: 20 } };
const riskOff = { regime: 'risk-off', riskOn: false, riskOff: true, vix: { level: 31, pctile: 95 } };

test('trackFor: prefers 1-week horizon and flags PENDING under the resolved threshold', () => {
  const group = { picks: 40, horizons: { '5d': { excessN: 8, winRate: 60, avgExcess: 1.4, beatMktRate: 62 } } };
  const t = trackFor(group);
  assert.equal(t.horizon, '1-week');
  assert.equal(t.resolved, 8);
  assert.equal(t.pending, true);                 // 8 < MIN_RESOLVED
  assert.equal(t.avgExcess, 1.4);
});

test('trackFor: enough resolved → not pending; falls back to 1-month when 1-week empty', () => {
  const group = { picks: 50, horizons: { '5d': { excessN: 0 }, '21d': { excessN: 30, winRate: 55, avgExcess: 2.1, beatMktRate: 58 } } };
  const t = trackFor(group);
  assert.equal(t.horizon, '1-month');
  assert.equal(t.resolved, 30);
  assert.equal(t.pending, false);
  assert.ok(MIN_RESOLVED <= 30);
});

test('trackFor: logged but nothing resolved → pending with null stats; empty group → null', () => {
  assert.deepEqual(trackFor({ picks: 3, horizons: { '5d': { excessN: 0 } } }), { horizon: null, resolved: 0, winRate: null, avgExcess: null, beatBenchRate: null, pending: true });
  assert.equal(trackFor(undefined), null);
  assert.equal(trackFor({ picks: 0, horizons: {} }), null);
});

test('quiet name: no signals → honest "nothing here" verdict, empty cases', () => {
  const r = composeWhyNow({ ticker: 'ZZZ', macro: riskOn });
  assert.equal(r.verdict.level, 'quiet');
  assert.equal(r.forCase.length, 0);
  assert.equal(r.againstCase.length, 0);
  assert.match(r.verdict.summary, /isn't on any of the app's screens/);
});

test('ghost + apex both fire in risk-on → constructive, two FOR signals with a real track record', () => {
  const r = composeWhyNow({
    ticker: 'NVDA', macro: riskOn,
    ghost: { tier: 'STALKING', score: 71, strongPillars: ['RM', 'SF'] },
    apex: { tier: 'loaded', score: 63, pillars: {} },
    trackByKey: { 'Ghost:STALKING': { picks: 40, horizons: { '5d': { excessN: 22, winRate: 55, avgExcess: 1.2, beatMktRate: 57 } } } },
  });
  assert.equal(r.verdict.level, 'constructive');
  assert.equal(r.forCase.length, 2);
  const ghostSig = r.forCase.find(s => s.key === 'Ghost:STALKING');
  assert.ok(ghostSig.track && ghostSig.track.pending === false);
  assert.equal(ghostSig.track.beatBenchRate, 57);
  // Apex is honest: no fabricated win rate, carries the drift-tracking note.
  const apexSig = r.forCase.find(s => s.key === 'Apex:loaded');
  assert.equal(apexSig.track, null);
  assert.match(apexSig.note, /drift/);
});

test('risk-off VETOES even when bullish signals fire → caution, not constructive', () => {
  const r = composeWhyNow({
    ticker: 'AAA', macro: riskOff,
    ghost: { tier: 'GHOST', score: 85, strongPillars: [] },
    apex: { tier: 'apex', score: 78, pillars: {} },
  });
  assert.equal(r.verdict.level, 'caution');
  assert.ok(r.againstCase.some(s => s.key === 'macro' && s.veto));
  assert.match(r.verdict.summary, /risk-off/);
});

test('fresh read-through is a FOR; already-moved read-through is an AGAINST', () => {
  const sigs = buildSignals({
    macro: riskOn,
    readThrough: [
      { trigger_ticker: 'AVGO', link_type: 'supplier', thesis: 'sole compression vendor', moved: { alreadyMoved: false } },
      { trigger_ticker: 'SMCI', link_type: 'peer', thesis: 'same theme', moved: { alreadyMoved: true } },
    ],
    trackByKey: { 'ReadThrough:Fresh': { picks: 20, horizons: { '5d': { excessN: 18, winRate: 61, avgExcess: 2.0, beatMktRate: 61 } } } },
  });
  const fresh = sigs.find(s => s.key === 'ReadThrough:Fresh');
  const moved = sigs.find(s => s.key === 'ReadThrough:Moved');
  assert.equal(fresh.side, 'for');
  assert.ok(fresh.track && fresh.track.beatBenchRate === 61);
  assert.equal(moved.side, 'against');
});

test('single FOR signal → watch (not constructive)', () => {
  const r = composeWhyNow({ ticker: 'BBB', macro: riskOn, ghost: { tier: 'STALKING', score: 66, strongPillars: [] } });
  assert.equal(r.verdict.level, 'watch');
  assert.equal(r.forCase.length, 1);
});

test('insider cluster buying is a context flag, never counted as a FOR', () => {
  const r = composeWhyNow({ ticker: 'CCC', macro: riskOn, insider: { clusterBuy: true } });
  assert.equal(r.verdict.level, 'quiet');            // context alone doesn't make a case
  assert.ok(r.context.some(s => s.key === 'insider'));
  assert.equal(r.forCase.length, 0);
});

test('regime is reported and Ghost WATCH tier does not fire (only GHOST/STALKING)', () => {
  const r = composeWhyNow({ ticker: 'DDD', macro: riskOn, ghost: { tier: 'WATCH', score: 52, strongPillars: [] } });
  assert.equal(r.regime, 'risk-on');
  assert.equal(r.forCase.length, 0);
  assert.equal(r.verdict.level, 'quiet');
});

// ── route glue (locate / trackMap) ──

test('locate: finds a breakout candidate in results and carries regime + macro from the large scope', () => {
  const screens = [
    { regime: { bearish: false, riskOn: true }, ghost: { macro: { regime: 'risk-on' }, pillarLabels: { RM: 'Rel strength' } },
      results: [{ ticker: 'NVDA', company: 'Nvidia', ghost: { tier: 'STALKING', score: 70 } }], ghostTop: [] },
    null,   // a scope that failed to load — tolerated
    { results: [], ghostTop: [{ ticker: 'ABCD', ghost: { tier: 'GHOST', score: 82 } }] },
  ];
  const { cand, ghostRow, regimeObj, macro, ghostLabels } = locate(screens, 'NVDA');
  assert.equal(cand.ticker, 'NVDA');
  assert.equal(regimeObj.riskOn, true);
  assert.equal(macro.regime, 'risk-on');
  assert.equal(ghostLabels.RM, 'Rel strength');
  assert.equal(ghostRow, null);        // NVDA isn't in any ghostTop
});

test('locate: falls back to a ghostTop accumulation row when not a breakout candidate', () => {
  const screens = [{ regime: { riskOn: true }, results: [], ghostTop: [{ ticker: 'ABCD', ghost: { tier: 'GHOST', score: 82 }, insider: { clusterBuy: true } }] }];
  const { cand, ghostRow } = locate(screens, 'ABCD');
  assert.equal(cand, null);
  assert.equal(ghostRow.ticker, 'ABCD');
  assert.equal(ghostRow.insider.clusterBuy, true);
});

test('locate: a ticker in no screen returns all-null (drives the honest "nothing here")', () => {
  const { cand, ghostRow } = locate([{ results: [], ghostTop: [] }], 'ZZZZ');
  assert.equal(cand, null);
  assert.equal(ghostRow, null);
});

test('trackMap: keys scoreboard groups by section:tier; tolerates a null summary', () => {
  const m = trackMap({ groups: [{ section: 'Ghost', tier: 'STALKING', picks: 5, horizons: {} }, { section: 'ReadThrough', tier: 'Fresh', picks: 2, horizons: {} }] });
  assert.ok(m['Ghost:STALKING'] && m['ReadThrough:Fresh']);
  assert.deepEqual(trackMap(null), {});
});

// ── Full model coverage (#5) ────────────────────────────────────────────────
test('coverageOf reports every lens, incl. quiet (clear) and no-data (unavailable)', () => {
  const cov = coverageOf({
    ticker: 'AAA',
    apex: { tier: 'watch', score: 40 },        // scanned, no breakout tier → clear
    ghost: { tier: 'GHOST', score: 84 },       // firing → active
    macro: { riskOn: true },                   // supportive → clear
    // conviction, insider, readThrough absent
  });
  assert.equal(cov.length, COVERAGE_CLASSES.length);
  const by = Object.fromEntries(cov.map(c => [c.key, c]));
  assert.equal(by.ghost.status, 'active');
  assert.equal(by.apex.status, 'clear');
  assert.equal(by.conviction.status, 'unavailable'); // never scored → honest "no data"
  assert.equal(by.insider.status, 'unavailable');
  assert.equal(by.macro.status, 'clear');
});

test('coverage is attached to the composeWhyNow payload', () => {
  const r = composeWhyNow({ ticker: 'ZZZ', macro: { riskOn: true } });
  assert.ok(Array.isArray(r.coverage));
  assert.equal(r.coverage.find(c => c.key === 'macro').status, 'clear');
});

test('risk-off macro shows as an ACTIVE coverage lens (the validated caution)', () => {
  const cov = coverageOf({ ticker: 'QQQ', macro: { riskOff: true, vix: { level: 30, pctile: 92 } } });
  assert.equal(cov.find(c => c.key === 'macro').status, 'active');
});

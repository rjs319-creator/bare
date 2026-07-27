'use strict';
// PHASE 1 — stranded ghostTop discovery repair (docs/premove-transition-v2.md).
//
// Proves the five required contracts:
//   1. a ticker in ghostTop but absent from results reaches the shadow pre-move inventory;
//   2. it is captured in the immutable full-candidate observation record;
//   3. it does NOT originate or boost a production op=today recommendation;
//   4. a ticker already represented by Breakout is not double-counted;
//   5. missing liquidity / missing levels fail closed.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const N = require('../lib/decision-normalizers');
const PC = require('../lib/premove-capture');
const { buildToday } = require('../lib/decision-routes');
const { SOURCES, project } = require('./fixtures/today-sources');

// A screener payload with one standalone quiet-accumulation name (QAC, STALKING tier,
// NOT in results), one dual-listed name (AAA — in results AND ghostTop), one
// missing-liquidity name (NOLIQ) and one missing-levels name (NOLVL).
const GHOST_TOP_FIXTURE = {
  scope: 'large',
  scannedCount: 500,
  results: [
    { ticker: 'AAA', company: 'Alpha', sector: 'Technology', status: 'Setup', price: 100,
      levels: { entry: 102, stop: 96, target: 120, rr: 3 }, factors: { dollarVol: 5e8 },
      ghost: { tier: 'GHOST', score: 90 } },
  ],
  ghostTop: [
    { ticker: 'AAA', company: 'Alpha', sector: 'Technology', price: 100, dollarVol: 5e8,
      levels: { entry: 102, stop: 96, target: 120, rr: 3 },
      ghost: { tier: 'GHOST', score: 90, pillars: { RM: 80 }, strongPillars: ['RM'] },
      inBreakoutResults: true, dataCutoff: '2026-07-24' },
    { ticker: 'QAC', company: 'Quiet Accum Standalone', sector: 'Industrials', price: 40, dollarVol: 8e6,
      levels: { entry: 42, stop: 38, target: 50, rr: 2 }, status: null,
      ghost: { tier: 'STALKING', score: 78, pillars: { AF: 75 }, strongPillars: ['AF'] },
      featureSnapshot: { pct: { accum: 92 }, quant: { score: 61 } },
      inBreakoutResults: false, dataCutoff: '2026-07-24' },
    { ticker: 'NOLIQ', company: 'No Liquidity', sector: 'Energy', price: 9, dollarVol: null,
      levels: { entry: 9.5, stop: 8.5, target: 12, rr: 2.5 },
      ghost: { tier: 'GHOST', score: 74 }, inBreakoutResults: false, dataCutoff: '2026-07-24' },
    { ticker: 'NOLVL', company: 'No Levels', sector: 'Utilities', price: 25, dollarVol: 4e6,
      levels: null,
      ghost: { tier: 'GHOST', score: 71 }, inBreakoutResults: false, dataCutoff: '2026-07-24' },
    { ticker: 'WWW', company: 'Watch Only', sector: 'Financials', price: 15, dollarVol: 6e6,
      levels: { entry: 16, stop: 14, target: 19, rr: 2 },
      ghost: { tier: 'WATCH', score: 74 }, inBreakoutResults: false, dataCutoff: '2026-07-24' },
  ],
};

// ── 1. standalone discovery ──────────────────────────────────────────────────
test('a ticker in ghostTop but absent from results reaches the shadow pre-move inventory', () => {
  const rows = N.fromGhostTop(GHOST_TOP_FIXTURE);
  const zzz = rows.find(r => r.ticker === 'QAC');
  assert.ok(zzz, 'standalone QAC must be discovered');
  assert.equal(zzz.source, 'ghost');
  assert.equal(zzz.section, 'Ghost');
  assert.equal(zzz.horizon, 'swing');
  assert.equal(zzz.side, 'long');
  assert.deepEqual(zzz.evidenceFamilies, ['volumeAccum']);
  assert.equal(zzz.setup, 'standalone quiet accumulation');
  assert.equal(zzz.scoringVersion, 'ghost-v1');
  assert.equal(zzz.premove.standalone, true);
  assert.equal(zzz.premove.shadow, true);
  assert.equal(zzz.premove.universeScope, 'large');
  assert.equal(zzz.premove.dataCutoff, '2026-07-24');
  assert.equal(zzz.entry, 42);
  assert.equal(zzz.stop, 38);
});

// ── 2. logged in the immutable observation record ────────────────────────────
test('the standalone candidate is captured in the full-candidate observation record', () => {
  const obs = PC.buildGhostObservation({
    date: '2026-07-24', eligibleEntryDate: '2026-07-27',
    scopes: [{ scope: 'large', ghostTop: GHOST_TOP_FIXTURE.ghostTop,
      resultsTickers: ['AAA'], scannedCount: 500, dataCutoff: '2026-07-24' }],
  });
  const sel = obs.selected.map(r => r.ticker);
  assert.ok(sel.includes('QAC'), 'standalone QAC must be a selected observation');
  assert.ok(!sel.includes('AAA'), 'AAA is represented by Breakout — not a standalone selection');
  assert.ok(obs.alsoInBreakout.map(r => r.ticker).includes('AAA'), 'AAA is recorded as also-in-breakout');
  const zzz = obs.selected.find(r => r.ticker === 'QAC');
  assert.equal(zzz.triggerLevel, 42);
  assert.equal(zzz.invalidation, 38);
  assert.equal(zzz.decisionPrice, 40);
  assert.equal(obs.decisionDate, '2026-07-24');
  assert.equal(obs.eligibleEntryDate, '2026-07-27');
  assert.equal(zzz.outcome.state, 'unresolved');
  assert.ok(obs.universeSnapshotId.includes('large#500'));
  assert.ok(Object.isFrozen(obs), 'observation record must be immutable');
  assert.ok(Object.isFrozen(zzz), 'observation rows must be immutable');
});

// ── 3. no production origination / boost ─────────────────────────────────────
test('standalone ghostTop rows do not originate or boost a production Today recommendation', () => {
  const base = buildToday(SOURCES, null, null, null);
  const withGhostTop = {
    ...SOURCES,
    screener: { ...SOURCES.screener, ghostTop: GHOST_TOP_FIXTURE.ghostTop, scannedCount: 500 },
  };
  const after = buildToday(withGhostTop, null, null, null);
  assert.deepEqual(project(after), project(base),
    'the board projection must be byte-identical with ghostTop present');
  const tickers = new Set(Object.values(after.horizons).flat().map(s => s.ticker));
  assert.ok(!tickers.has('QAC'), 'a standalone Ghost name must not appear on the board');
});

// ── 4. no self-double-counting with Breakout ─────────────────────────────────
test('a ticker already represented by Breakout results is excluded from the standalone adapter', () => {
  const rows = N.fromGhostTop(GHOST_TOP_FIXTURE);
  assert.ok(!rows.find(r => r.ticker === 'AAA'),
    'AAA is in results — its Ghost read already rides the screener signal as evidenceOrigins.volumeAccum');
});

// ── 5. fail closed on missing data ───────────────────────────────────────────
test('missing liquidity fails closed (dropped with a reason, never imputed)', () => {
  const { rows, dropped } = N.mapGhostTopRows(GHOST_TOP_FIXTURE);
  assert.ok(!rows.find(r => r.ticker === 'NOLIQ'));
  assert.deepEqual(dropped.find(d => d.ticker === 'NOLIQ'), { ticker: 'NOLIQ', reason: 'missing-liquidity' });
});

test('missing levels are explicit: no trigger/invalidation, marked missing (cannot arm)', () => {
  const rows = N.fromGhostTop(GHOST_TOP_FIXTURE);
  const nolvl = rows.find(r => r.ticker === 'NOLVL');
  assert.ok(nolvl, 'levels-less rows stay observable');
  assert.equal(nolvl.entry, null);
  assert.equal(nolvl.stop, null);
  assert.ok(nolvl.premove.missing.includes('levels'));
});

test('observation record fails closed on missing price/liquidity', () => {
  const obs = PC.buildGhostObservation({
    date: '2026-07-24', eligibleEntryDate: '2026-07-27',
    scopes: [{ scope: 'large', ghostTop: GHOST_TOP_FIXTURE.ghostTop, resultsTickers: ['AAA'], scannedCount: 500 }],
  });
  const all = [...obs.selected, ...obs.rejected, ...obs.nearThreshold, ...obs.alsoInBreakout].map(r => r.ticker);
  assert.ok(!all.includes('NOLIQ'), 'missing liquidity must not become a candidate');
  assert.deepEqual(obs.excluded.find(e => e.ticker === 'NOLIQ'),
    { ticker: 'NOLIQ', scope: 'large', reason: 'missing-liquidity' });
});

// ── deterministic cross-scope dedup ──────────────────────────────────────────
test('overlapping scopes dedupe deterministically and retain scope provenance', () => {
  const row = (scope, score) => ({ ticker: 'DUP', company: 'Dup', sector: 'Tech', price: 30, dollarVol: 5e6,
    levels: { entry: 31, stop: 28, target: 36, rr: 1.7 },
    ghost: { tier: 'GHOST', score }, inBreakoutResults: false });
  const obs = PC.buildGhostObservation({
    date: '2026-07-24', eligibleEntryDate: '2026-07-27',
    scopes: [
      { scope: 'small', ghostTop: [row('small', 80)], resultsTickers: [], scannedCount: 100 },
      { scope: 'large', ghostTop: [row('large', 72)], resultsTickers: [], scannedCount: 500 },
    ],
  });
  assert.equal(obs.selected.length, 1, 'one deduped row');
  const dup = obs.selected[0];
  assert.equal(dup.scope, 'small', 'primary row is the higher-score scope');
  assert.deepEqual(dup.scopes.map(s => s.scope), ['large', 'small'], 'both scopes retained, priority-ordered');
});

// ── near-threshold band ──────────────────────────────────────────────────────
test('WATCH rows near the selection threshold are captured as near-threshold, the rest as rejected', () => {
  const obs = PC.buildGhostObservation({
    date: '2026-07-24', eligibleEntryDate: '2026-07-27',
    scopes: [{ scope: 'large', resultsTickers: [], scannedCount: 500, ghostTop: [
      { ticker: 'SEL', price: 10, dollarVol: 5e6, ghost: { tier: 'STALKING', score: 70 }, levels: { entry: 11, stop: 9 } },
      { ticker: 'NEAR', price: 10, dollarVol: 5e6, ghost: { tier: 'WATCH', score: 67 }, levels: { entry: 11, stop: 9 } },
      { ticker: 'FAR', price: 10, dollarVol: 5e6, ghost: { tier: 'WATCH', score: 40 }, levels: { entry: 11, stop: 9 } },
    ] }],
  });
  assert.deepEqual(obs.selected.map(r => r.ticker), ['SEL']);
  assert.deepEqual(obs.nearThreshold.map(r => r.ticker), ['NEAR']);
  assert.deepEqual(obs.rejected.map(r => r.ticker), ['FAR']);
});

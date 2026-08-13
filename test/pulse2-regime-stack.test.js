'use strict';
// THREE-LAYER REGIME STACK + CROSS-ASSET CONFIRMATION MATRIX.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rs = require('../lib/pulse2-regime-stack');
const ca = require('../lib/pulse2-cross-asset');

const NOW = new Date('2026-08-13T18:00:00Z');

// Deterministic synthetic bars: `drift` is the total fractional move across the series.
const bars = (n, start, drift = 0) => Array.from({ length: n }, (_, i) => ({ date: `2026-06-${String((i % 28) + 1).padStart(2, '0')}`, close: start * (1 + (drift * i) / (n - 1)) }));

const upTape = {
  indexes: {
    SPY: { available: true, dayReturnPct: 0.9, aboveVWAP: true, rangeExpansion: 1.1 },
    QQQ: { available: true, dayReturnPct: 1.2, aboveVWAP: true, rangeExpansion: 1.2 },
    IWM: { available: true, dayReturnPct: -0.4, aboveVWAP: false, rangeExpansion: 1.0 },
    RSP: { available: true, dayReturnPct: 0.3, aboveVWAP: true },
  },
  breadth: { available: true, pctAbove50dma: 41 },
  participation: { equalVsCapPct: -0.6, smallVsLargePct: -1.3 },
  sectors: { available: true },
};

// ── The stack refuses to compress horizons ──────────────────────────────────

test('STACK: there is NO composite regime score — the horizons stay separate', () => {
  const s = rs.buildRegimeStack({ marketState: upTape, now: NOW });
  assert.equal(s.compositeScore, null);
  assert.match(s.compositeNote, /no composite regime score/i);
  assert.deepEqual(s.layerOrder, ['intraday', 'tactical', 'strategic']);
});

test('STACK: each layer reports state, previous, transition, persistence, and a flip condition', () => {
  const s = rs.buildRegimeStack({ marketState: upTape, now: NOW });
  const l = s.layers.intraday;
  assert.ok(l.state);
  assert.ok('previousState' in l);
  assert.ok('transitionAt' in l);
  assert.ok(l.persistence && l.persistence.observations >= 1);
  assert.ok(Array.isArray(l.whatWouldFlipIt) && l.whatWouldFlipIt.length, 'a layer must say in advance what would change its mind');
  assert.ok(l.coverage && l.coverage.possible > 0);
});

// ── Contradictions are preserved, never netted ──────────────────────────────

test('STACK: a trending-up intraday layer KEEPS its contradicting observations', () => {
  const s = rs.buildRegimeStack({ marketState: upTape, now: NOW });
  const l = s.layers.intraday;
  assert.equal(l.state, 'TRENDING_UP');
  assert.ok(l.contradicting.length >= 2, 'lagging small caps + weak breadth must both survive');
  assert.equal(l.contested, true);
  const text = l.contradicting.map(o => o.text).join(' ');
  assert.match(text, /Small caps/i);
  assert.match(text, /50DMA/i);
});

test('STACK: every observation carries the value that produced it', () => {
  const s = rs.buildRegimeStack({ marketState: upTape, now: NOW });
  for (const o of [...s.layers.intraday.supporting, ...s.layers.intraday.contradicting]) {
    assert.ok(o.text, 'observation needs text');
    assert.ok('value' in o, 'observation must expose the measured value it came from');
  }
});

// ── Unavailability is explicit, never neutral ───────────────────────────────

test('STACK: no SPY read makes the intraday layer UNAVAILABLE, not neutral', () => {
  const s = rs.buildRegimeStack({ marketState: { indexes: { SPY: { available: false } } }, now: NOW });
  assert.equal(s.layers.intraday.state, 'UNAVAILABLE');
  assert.equal(s.layers.intraday.available, false);
  assert.match(s.layers.intraday.unavailableReason, /no SPY/i);
});

test('STACK: with no macro provider the strategic layer says so instead of guessing from price', () => {
  const s = rs.buildRegimeStack({ marketState: upTape, macroInputs: null, now: NOW });
  assert.equal(s.layers.strategic.state, 'UNAVAILABLE');
  assert.match(s.layers.strategic.unavailableReason, /NOT wired to a provider/i);
  assert.equal(s.coverage.degraded, true);
  assert.ok(s.coverage.unavailable.some(u => u.layer === 'strategic'));
});

test('STACK: the tactical layer needs two independent legs before it reports a state', () => {
  const thin = rs.buildRegimeStack({ marketState: { indexes: { SPY: { available: true, dayReturnPct: 0.5 } } }, crossAsset: null, now: NOW });
  assert.equal(thin.layers.tactical.state, 'UNAVAILABLE');
  assert.match(thin.layers.tactical.unavailableReason, /at least two independent legs/i);
});

test('STACK: a strategic layer WITH inputs produces a state and keeps its contradictions', () => {
  const s = rs.buildRegimeStack({
    marketState: upTape,
    macroInputs: {
      growth: { trend: 'up', value: 2.1, source: 'test' },
      inflation: { trend: 'up', value: 3.4, source: 'test' },
      liquidity: { trend: 'down', value: -1, source: 'test' },
      earningsRevisions: { trend: 'down', value: -0.4, source: 'test' },
    },
    now: NOW,
  });
  assert.equal(s.layers.strategic.available, true);
  assert.equal(s.layers.strategic.state, 'SLOWDOWN');
  assert.ok(s.layers.strategic.contradicting.length >= 1, 'the expansionary growth leg must survive as a contradiction');
});

// ── Persistence and transitions ─────────────────────────────────────────────

test('STACK: an unchanged layer accumulates persistence; a changed one resets it', () => {
  const first = rs.buildRegimeStack({ marketState: upTape, now: NOW });
  const second = rs.buildRegimeStack({ marketState: upTape, prevStack: first, now: new Date('2026-08-13T18:05:00Z') });
  assert.equal(second.layers.intraday.changed, false);
  assert.equal(second.layers.intraday.persistence.observations, 2);
  assert.equal(second.layers.intraday.persistence.sinceISO, first.layers.intraday.persistence.sinceISO);

  const downTape = { ...upTape, indexes: { ...upTape.indexes, SPY: { available: true, dayReturnPct: -0.9, aboveVWAP: false }, QQQ: { available: true, dayReturnPct: -1.1, aboveVWAP: false } } };
  const third = rs.buildRegimeStack({ marketState: downTape, prevStack: second, now: new Date('2026-08-13T18:10:00Z') });
  assert.equal(third.layers.intraday.changed, true);
  assert.equal(third.layers.intraday.previousState, 'TRENDING_UP');
  assert.equal(third.layers.intraday.state, 'TRENDING_DOWN');
  assert.equal(third.layers.intraday.persistence.observations, 1);
  assert.equal(third.layers.intraday.transitionAt, '2026-08-13T18:10:00.000Z');
});

// ── Side-aware fit ──────────────────────────────────────────────────────────

test('FIT: a risk-averse tactical regime is a headwind for a long and a TAILWIND for a short', () => {
  const stack = { layers: { tactical: { available: true, state: 'RISK_AVERSE', contested: false, contradicting: [] } } };
  assert.equal(rs.regimeFitFor(stack, { side: 'long' }).alignment, 'HEADWIND');
  assert.equal(rs.regimeFitFor(stack, { side: 'short' }).alignment, 'TAILWIND');
});

test('FIT: the horizon selects the layer — an intraday trade reads the intraday layer', () => {
  const stack = rs.buildRegimeStack({ marketState: upTape, now: NOW });
  assert.equal(rs.regimeFitFor(stack, { side: 'long', horizon: 'intraday' }).layer, 'intraday');
  assert.equal(rs.regimeFitFor(stack, { side: 'long', horizon: 'swing' }).layer, 'tactical');
  assert.equal(rs.regimeFitFor(stack, { side: 'long', horizon: 'investor' }).layer, 'strategic');
});

test('FIT: an unavailable layer yields UNKNOWN with a reason, never a neutral pass', () => {
  const stack = rs.buildRegimeStack({ marketState: upTape, now: NOW });
  const f = rs.regimeFitFor(stack, { side: 'long', horizon: 'investor' });
  assert.equal(f.alignment, 'UNKNOWN');
  assert.equal(f.fit, null);
  assert.ok(f.reason);
});

test('FIT: a contested layer says so in its reason', () => {
  const stack = rs.buildRegimeStack({ marketState: upTape, now: NOW });
  const f = rs.regimeFitFor(stack, { side: 'long', horizon: 'intraday' });
  assert.match(f.reason, /contested/i);
});

// ── Horizon conflicts are surfaced, not resolved ────────────────────────────

test('STACK: a horizon conflict is reported explicitly', () => {
  const s = rs.buildRegimeStack({
    marketState: upTape,
    crossAsset: { rows: {
      credit: { available: true, changePct: -0.8, source: 'HYG vs LQD' },
      volCurve: { available: true, contango: false, slope: -2, source: '^VIX vs ^VIX3M' },
      dollar: { available: true, changePct: 0.9, source: 'UUP' },
      rates2y: { available: true, changePct: 0.4, source: 'SHY' },
    } },
    now: NOW,
  });
  assert.equal(s.layers.intraday.state, 'TRENDING_UP');
  assert.equal(s.layers.tactical.state, 'RISK_AVERSE');
  assert.ok(s.horizonConflicts.length >= 1);
  assert.match(s.horizonConflicts[0], /fighting the tactical horizon/i);
  assert.equal(s.contested, true);
});

// ── Cross-asset matrix ──────────────────────────────────────────────────────

const fullDaily = () => ({
  SPY: bars(60, 500, 0.03), IWM: bars(60, 200, 0.04), RSP: bars(60, 170, 0.03),
  SHY: bars(60, 82, -0.002), IEF: bars(60, 95, -0.01), TLT: bars(60, 90, -0.02),
  TIP: bars(60, 108, -0.005), UUP: bars(60, 28, -0.01),
  HYG: bars(60, 78, 0.02), LQD: bars(60, 110, 0.005),
  USO: bars(60, 70, 0.03), CPER: bars(60, 26, 0.02), GLD: bars(60, 240, -0.02),
  '^VIX': bars(60, 20, -0.3), '^VIX3M': bars(60, 22, -0.2), '^SKEW': bars(60, 140, 0.01),
});

test('MATRIX: every leg names the PROXY it actually used', () => {
  const m = ca.buildCrossAssetMatrix({ dailyByTicker: fullDaily(), equityChangePct: 0.8, vix: { level: 14, level3m: 17 } });
  for (const [key, row] of Object.entries(m.rows)) {
    if (!row.available) continue;
    assert.ok(row.underlying, `${key} must name the underlying an expert wants`);
    assert.ok(row.proxy, `${key} must name the proxy actually measured`);
  }
  assert.equal(m.rows.rates2y.proxy, 'SHY');
  assert.match(m.rows.rates2y.proxyNote, /INVERSELY/);
  assert.match(m.proxyDisclosure, /ETF PROXIES, not through a rates\/FX\/commodity terminal/);
});

test('MATRIX: the curve row states it is NOT a basis-point spread', () => {
  const m = ca.buildCrossAssetMatrix({ dailyByTicker: fullDaily(), equityChangePct: 0.8 });
  assert.match(m.rows.curve.proxyNote, /NOT a basis-point spread/i);
});

test('MATRIX: a missing leg is UNAVAILABLE with a reason and is EXCLUDED from the ratio', () => {
  const partial = { SPY: bars(60, 500, 0.03), HYG: bars(60, 78, 0.02), LQD: bars(60, 110, 0.005) };
  const m = ca.buildCrossAssetMatrix({ dailyByTicker: partial, equityChangePct: 0.8 });
  assert.equal(m.rows.oil.available, false);
  assert.equal(m.rows.oil.verdict, 'UNAVAILABLE');
  assert.match(m.rows.oil.reason, /NOT counted as neutral/i);
  assert.ok(m.summary.legsMeasured < m.summary.legsPossible);
  assert.equal(m.summary.neutral + m.summary.confirming + m.summary.contradicting, m.summary.legsMeasured);
});

test('MATRIX: the confirmation ratio exposes its denominator honestly', () => {
  const partial = { SPY: bars(60, 500, 0.03), HYG: bars(60, 78, 0.02), LQD: bars(60, 110, 0.005) };
  const m = ca.buildCrossAssetMatrix({ dailyByTicker: partial, equityChangePct: 0.8 });
  assert.match(m.summary.confirmationRatioNote, /of \d+ MEASURED legs/);
  assert.match(m.summary.confirmationRatioNote, /could not be measured and are excluded from the ratio/);
});

test('MATRIX: rates legs are read with the correct INVERSE sign', () => {
  // Treasury ETFs rallying = falling yields = risk-off-consistent. Against a rising
  // equity tape that is a CONTRADICTION, not a confirmation.
  const d = { SPY: bars(60, 500, 0.03), IEF: bars(60, 95, 0.05), SHY: bars(60, 82, 0.02) };
  const m = ca.buildCrossAssetMatrix({ dailyByTicker: d, equityChangePct: 0.8, lookback: 20 });
  assert.equal(m.rows.rates10y.verdict, 'CONTRADICTS');
  assert.equal(m.rows.rates2y.verdict, 'CONTRADICTS');
});

test('MATRIX: gold is the risk-OFF leg — a gold rally contradicts an equity rally', () => {
  const d = { SPY: bars(60, 500, 0.03), GLD: bars(60, 240, 0.06) };
  const m = ca.buildCrossAssetMatrix({ dailyByTicker: d, equityChangePct: 0.8, lookback: 20 });
  assert.equal(m.rows.gold.verdict, 'CONTRADICTS');
});

test('MATRIX: a stronger dollar contradicts an equity rally', () => {
  const d = { SPY: bars(60, 500, 0.03), UUP: bars(60, 28, 0.05) };
  const m = ca.buildCrossAssetMatrix({ dailyByTicker: d, equityChangePct: 0.8, lookback: 20 });
  assert.equal(m.rows.dollar.verdict, 'CONTRADICTS');
});

test('MATRIX: real yields / breakevens are NOT approximated from nominal rates alone', () => {
  const d = { SPY: bars(60, 500, 0.03), IEF: bars(60, 95, -0.01) };   // no TIP
  const m = ca.buildCrossAssetMatrix({ dailyByTicker: d, equityChangePct: 0.8 });
  assert.equal(m.rows.realYields.available, false);
  assert.match(m.rows.realYields.reason, /NOT approximated from nominal rates/i);
});

test('MATRIX: vol term structure needs BOTH VIX legs; skew is never estimated', () => {
  const m = ca.buildCrossAssetMatrix({ dailyByTicker: { SPY: bars(60, 500, 0.03), '^VIX': bars(60, 15, 0) }, equityChangePct: 0.8 });
  assert.equal(m.rows.volCurve.available, false);
  assert.match(m.rows.volCurve.reason, /term structure/i);
  assert.equal(m.rows.skew.available, false);
  assert.match(m.rows.skew.reason, /NOT estimated/i);
});

test('MATRIX: realized-vs-implied is computed only when both legs exist', () => {
  const withBoth = ca.buildCrossAssetMatrix({ dailyByTicker: fullDaily(), equityChangePct: 0.8, vix: { level: 18, level3m: 20 } });
  assert.equal(withBoth.rows.rvIv.available, true);
  assert.ok(withBoth.rows.rvIv.realizedVol20d != null);
  assert.ok(withBoth.rows.rvIv.spread != null);
  const withoutVix = ca.buildCrossAssetMatrix({ dailyByTicker: { SPY: bars(60, 500, 0.03) }, equityChangePct: 0.8 });
  assert.equal(withoutVix.rows.rvIv.available, false);
});

test('MATRIX: a total provider failure is DEGRADED, never a confirming market', () => {
  const m = ca.buildCrossAssetMatrix({ dailyByTicker: {}, equityChangePct: 0.8 });
  assert.equal(m.available, false);
  assert.equal(m.summary.legsMeasured, 0);
  assert.equal(m.summary.confirmationRatio, null);
  assert.equal(m.coverage.degraded, true);
  assert.equal(m.coverage.unavailable.length, m.summary.legsPossible);
});

test('MATRIX: contradicting legs are listed by name so they cannot be buried', () => {
  const d = { SPY: bars(60, 500, 0.03), GLD: bars(60, 240, 0.06), UUP: bars(60, 28, 0.05) };
  const m = ca.buildCrossAssetMatrix({ dailyByTicker: d, equityChangePct: 0.8, lookback: 20 });
  assert.equal(m.summary.contradicting, 2);
  assert.match(m.summary.contradictingLegs.join(' '), /gold/i);
  assert.match(m.summary.contradictingLegs.join(' '), /dollar/i);
});

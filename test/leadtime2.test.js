'use strict';
// LEAD-TIME v2 contracts (Phase 2, docs/premove-transition-v2.md):
//   - right-censored signals are never counted as failures;
//   - the future trigger/entry price is never the detection price;
//   - recurring episodes re-enter after the contract cooldown;
//   - market/sector moves are residualized (a beta rally is not an event);
//   - same-bar target/stop ambiguity resolves conservatively (stop first);
//   - no-trigger and trigger-no-fill are distinct outcomes;
//   - features (trailing vol) use only candles at or before the decision cutoff.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const LT2 = require('../lib/leadtime2');
const { episodePicks } = require('../lib/leadtime2-routes');

// Deterministic candle builder: closes given, OHLC derived unless overridden.
function bars(closes, overrides = {}) {
  return closes.map((c, i) => {
    const o = overrides[i] || {};
    const d = new Date(Date.UTC(2026, 0, 5 + Math.floor(i / 5) * 7 + (i % 5)));  // weekdays
    return {
      date: d.toISOString().slice(0, 10),
      open: o.open ?? c, high: o.high ?? c * 1.005, low: o.low ?? c * 0.995,
      close: c, volume: 1e6,
    };
  });
}
// 30 flat-ish bars with tiny alternating noise so trailing vol is small but positive.
const flat30 = (px = 100) => Array.from({ length: 30 }, (_, i) => px * (1 + (i % 2 ? 0.002 : -0.002)));

const PICK_DATE_IDX = 29;                     // decide on the last of the 30 history bars
const pickAt = (candles, extra = {}) => ({ date: candles[PICK_DATE_IDX].date, ticker: 'TST', section: 'Test', tier: 'A', ...extra });

// ── censoring ────────────────────────────────────────────────────────────────
test('a horizon whose window has not elapsed is censored, never a resolved negative', () => {
  const candles = bars(flat30());              // no forward bars at all beyond the decision
  const r = LT2.episodeLeadTime(pickAt(candles), candles);
  for (const H of [5, 10, 21]) {
    assert.equal(r.horizons[H].outcome, 'censored', `H=${H} must be censored`);
  }
  // Aggregation: a censored episode contributes to `censored`, not to any rate.
  const agg = LT2.aggregateHorizon([{ ...r, band: null, rejected: false }], 5);
  assert.equal(agg.n, 0);
  assert.equal(agg.censored, 1);
  assert.equal(agg.triggerConversionRate, null);
  assert.equal(agg.falseEarlyRate, null);
});

test('a filled episode whose EXIT window is still open is censored (not a timeout)', () => {
  const closes = [...flat30(), 103, 104];      // trigger fires, then data ends
  const candles = bars(closes, { 30: { high: 106, open: 100.5 } });
  const r = LT2.episodeLeadTime(pickAt(candles, { entry: 105, stop: 95 }), candles);
  assert.equal(r.horizons[5].outcome, 'censored');
  assert.match(r.horizons[5].reason, /exit-window-open/);
});

// ── detection price ──────────────────────────────────────────────────────────
test('the future trigger/entry price is never used as the detection price', () => {
  const candles = bars([...flat30(100), 100, 100, 100, 100, 100]);
  const r = LT2.episodeLeadTime(pickAt(candles, { entry: 120 }), candles);
  // v1 would have anchored at entry=120; v2 anchors at the decision close (~100).
  assert.ok(Math.abs(r.detect - candles[PICK_DATE_IDX].close) < 1e-9,
    `detect ${r.detect} must equal the decision close`);
  assert.ok(r.detect < 110, 'never the future entry');
  // The plan entry is still respected as the TRIGGER BARRIER (known at decision).
  assert.equal(r.horizons[5].trigger, 120);
});

// ── feature cutoff ───────────────────────────────────────────────────────────
test('trailing volatility uses only candles at or before the decision cutoff', () => {
  const calm = bars([...flat30(), 100, 100, 100, 100, 100]);
  const wild = bars([...flat30(), 200, 50, 300, 20, 400]);   // insane FUTURE bars
  const rCalm = LT2.episodeLeadTime(pickAt(calm), calm);
  const rWild = LT2.episodeLeadTime(pickAt(wild), wild);
  assert.equal(rCalm.dailyVol, rWild.dailyVol,
    'future candles must not leak into the decision-time volatility');
});

// ── residualization ──────────────────────────────────────────────────────────
test('a move fully explained by the market/sector is residualized away', () => {
  // Stock +20% over the window — but the sector ETF also +20%: residual ≈ 0.
  const up = Array.from({ length: 10 }, (_, i) => 100 * (1 + 0.02 * (i + 1)));
  const closes = [...flat30(), ...up];
  const candles = bars(closes);
  const sector = bars(closes.map(c => c / 2));               // identical path, half price
  const rWith = LT2.episodeLeadTime(pickAt(candles), candles, { sectorCandles: sector });
  const rWithout = LT2.episodeLeadTime(pickAt(candles), candles, {});
  const hWith = rWith.horizons[10], hWithout = rWithout.horizons[10];
  assert.equal(hWith.residualized, true);
  assert.equal(hWith.benchKind, 'sector');
  assert.equal(hWithout.residualized, false, 'no benchmark ⇒ LABELED unresidualized, not pretended');
  // The Coil abnormal-break marker must NOT fire when the whole move is beta.
  assert.equal(hWith.abnormalBreak, false, 'a pure beta rally is not an abnormal residual break');
  assert.equal(hWithout.abnormalBreak, true, 'the raw path alone would have (wrongly) looked abnormal');
});

// ── conservative same-bar ordering ───────────────────────────────────────────
test('same-bar target/stop ambiguity after the fill resolves to the stop', () => {
  // Clean trigger fill on bar 30, then bar 31 spans BOTH the target and the stop.
  const closes = [...flat30(), 105, 100, 100, 100, 100, 100];
  const candles = bars(closes, {
    30: { open: 104, high: 106, low: 103 },     // touches entry 105, nowhere near stop
    31: { open: 100, high: 140, low: 80 },      // spans target 130 AND stop 95
  });
  const r = LT2.episodeLeadTime(pickAt(candles, { entry: 105, stop: 95, target: 130 }), candles);
  assert.equal(r.horizons[5].outcome, 'stop-before-target');
});

test('Stage A same-bar trigger+invalidation resolves to downside-first', () => {
  const closes = [...flat30(), 100];
  const candles = bars(closes, { 30: { open: 100, high: 140, low: 80 } });
  // stop=95 touched AND entry=105 touched on the same bar → downside-first.
  const r = LT2.episodeLeadTime(pickAt(candles, { entry: 105, stop: 95 }), candles);
  assert.equal(r.horizons[5].outcome, 'downside-first');
});

// ── no-trigger vs trigger-no-fill ────────────────────────────────────────────
test('no-trigger and trigger-no-fill are distinct outcomes', () => {
  // Case 1: complete flat window, trigger never touched.
  const flatFull = bars([...flat30(), 100, 100, 100, 100, 100, 100]);
  const r1 = LT2.episodeLeadTime(pickAt(flatFull, { entry: 110, stop: 90 }), flatFull);
  assert.equal(r1.horizons[5].outcome, 'no-trigger');

  // Case 2: trigger touched but only via a gap far beyond MAX_GAP → no executable fill.
  const gapped = bars([...flat30(), 100, 130, 130, 130, 130, 130],
    { 31: { open: 128, high: 132, low: 126 } });
  const r2 = LT2.episodeLeadTime(pickAt(gapped, { entry: 110, stop: 90 }), gapped);
  assert.equal(r2.horizons[5].outcome, 'trigger-no-fill');
  assert.equal(r2.horizons[5].fillReason, 'gap-beyond-max-entry');
});

test('gap-through within tolerance fills at the WORSE open, not the trigger', () => {
  const closes = [...flat30(), 100, 113, 118, 119, 120, 121];
  const candles = bars(closes, { 31: { open: 112, high: 114, low: 111 } });
  const r = LT2.episodeLeadTime(pickAt(candles, { entry: 110, stop: 95, target: 118 }), candles);
  const h = r.horizons[5];
  assert.equal(h.fillPrice, 112, 'gap-through fills at the open (worse), never the trigger');
  assert.equal(h.outcome, 'target-before-stop');
  assert.ok(h.netR != null && h.netR < h.grossR, 'net R must be charged costs');
});

// ── recurring episodes after cooldown ────────────────────────────────────────
test('recurring setups re-enter after the contract cooldown; inside it they are one episode', () => {
  const mk = (date) => ({ date, ticker: 'REC', section: 'Ghost', tier: 'GHOST' });
  // Ghost contract cooldown = 21 sessions (calendar-gap engine from scoreboard-episodes).
  const picks = [mk('2026-01-05'), mk('2026-01-12'), mk('2026-04-01')];
  const eps = episodePicks(picks);
  const recEps = eps.filter(p => p.ticker === 'REC');
  assert.equal(recEps.length, 2, 'two episodes: the Jan cluster (one) + the April re-entry');
  assert.deepEqual(recEps.map(p => p.date), ['2026-01-05', '2026-04-01']);
});

// ── aggregation honesty ──────────────────────────────────────────────────────
test('aggregate separates selected vs rejected and never scores censored rows', () => {
  const closes = [...flat30(), 100, 113, 118, 119, 120, 121];
  const candles = bars(closes, { 31: { open: 112, high: 114, low: 111 } });
  const win = LT2.episodeLeadTime(pickAt(candles, { entry: 110, stop: 95, target: 118 }), candles);
  const cens = LT2.episodeLeadTime(pickAt(bars(flat30())), bars(flat30()));
  const rows = [
    { ...win, band: 'high', rejected: false },
    { ...win, band: 'high', rejected: true },
    { ...cens, band: null, rejected: false },
  ];
  const agg = LT2.aggregateHorizon(rows, 5);
  assert.equal(agg.n, 2);
  assert.equal(agg.censored, 1);
  assert.equal(agg.selectedVsRejected.selected.n, 1);
  assert.equal(agg.selectedVsRejected.rejected.n, 1);
  assert.ok(agg.calibrationByBand.high, 'band calibration present when bands exist');
  assert.equal(agg.calibrationByBand.high.n, 2);
});

// ── barrier versioning ───────────────────────────────────────────────────────
test('alternative barrier definitions are versioned and change the fallback barriers', () => {
  const candles = bars([...flat30(), 100, 100, 100, 100, 100, 100]);
  const base = LT2.episodeLeadTime(pickAt(candles), candles, { cfg: { barrierVersion: 'lt2-coilsigma-v1' } });
  const tight = LT2.episodeLeadTime(pickAt(candles), candles, { cfg: { barrierVersion: 'lt2-tight-v1' } });
  assert.ok(tight.horizons[5].trigger < base.horizons[5].trigger, 'tighter barrier ⇒ lower trigger');
  assert.equal(base.barrierVersion, 'lt2-coilsigma-v1');
  assert.equal(tight.barrierVersion, 'lt2-tight-v1');
  assert.deepEqual(Object.keys(LT2.BARRIERS).sort(),
    ['lt2-coilsigma-v1', 'lt2-tight-v1', 'lt2-wide-v1'], 'the preregistered sensitivity set');
});

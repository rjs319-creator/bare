const test = require('node:test');
const assert = require('node:assert');
const { sessionPaceFraction, dayMetrics, AVG_VOL_WINDOW } = require('../lib/daytrade');

// July → America/New_York is EDT (UTC-4). RTH 09:30–16:00 ET = 13:30–20:00 UTC.

test('sessionPaceFraction: mid-session prorates by fraction elapsed', () => {
  // 2026-07-07 14:00 UTC = 10:00 ET = 30 min into a 390-min session.
  const f = sessionPaceFraction(new Date('2026-07-07T14:00:00Z'));
  assert.ok(Math.abs(f - 30 / 390) < 1e-6, `expected ~0.077, got ${f}`);
});

test('sessionPaceFraction: pre-open returns 1 (no pacing)', () => {
  // 08:00 ET
  assert.equal(sessionPaceFraction(new Date('2026-07-07T12:00:00Z')), 1);
});

test('sessionPaceFraction: post-close returns 1 (no pacing)', () => {
  // 17:00 ET
  assert.equal(sessionPaceFraction(new Date('2026-07-07T21:00:00Z')), 1);
});

test('sessionPaceFraction: weekend returns 1', () => {
  // 2026-07-11 is a Saturday; 10:00 ET
  assert.equal(sessionPaceFraction(new Date('2026-07-11T14:00:00Z')), 1);
});

test('sessionPaceFraction: floored at 0.05 in the first minutes', () => {
  // 09:31 ET = 1 min in → raw 1/390 ≈ 0.0026, floored to 0.05
  assert.equal(sessionPaceFraction(new Date('2026-07-07T13:31:00Z')), 0.05);
});

// Helper: flat 20-day base at volume `base`, then a final `lastVol` bar dated `lastDate`.
function series(lastDate, lastVol, base = 1_000_000) {
  const candles = [];
  for (let i = 0; i < AVG_VOL_WINDOW; i++) candles.push({ date: `2026-06-${String(i + 1).padStart(2, '0')}`, open: 10, high: 10.2, low: 9.8, close: 10, volume: base });
  candles.push({ date: lastDate, open: 10, high: 10.7, low: 10, close: 10.6, volume: lastVol });
  return candles;
}

test('dayMetrics: a FRESH current-session bar (todayEt matches) is paced', () => {
  // +6% day on only 100k volume (partial bar), bar dated today AND todayEt=today.
  const candles = series('2026-07-07', 100_000);

  const unpaced = dayMetrics(candles, null);
  assert.equal(unpaced.rawRelVol, 0.1);          // 100k / 1M
  assert.equal(unpaced.relVol, 0.1);             // no pacing without todayEt
  assert.equal(unpaced.paced, false);
  assert.equal(unpaced.barIsToday, false);       // no todayEt supplied ⇒ can't prove freshness

  const paced = dayMetrics(candles, null, undefined, 0.1, '2026-07-07');   // 10% elapsed, bar IS today
  assert.equal(paced.rawRelVol, 0.1);            // raw unchanged
  assert.equal(paced.relVol, 1);                 // 0.1 / 0.1 projected to full day
  assert.equal(paced.paced, true);
  assert.equal(paced.barIsToday, true);
  assert.equal(paced.candidateDate, '2026-07-07');
  assert.equal(paced.pctChange, unpaced.pctChange);   // price move is NOT paced
});

// ── REGRESSION: the stale-candle / partial-session pacing defect ─────────────
// A completed prior-session bar must NEVER be intraday-paced, no matter how small the
// pace fraction. This is the exact leak that turned a red/stagnant name into a phantom
// high-relVol event: SPY carries today's partial bar → a clock/SPY pace fraction → applied
// to a ticker whose newest cached bar is YESTERDAY's completed full-day bar.
test('REGRESSION: a stale prior-session bar cannot be intraday-paced', () => {
  // Bar dated 2026-07-07, but the current ET session is 2026-07-08 (dates DIFFER).
  const candles = series('2026-07-07', 100_000);
  const m = dayMetrics(candles, null, undefined, 0.1, '2026-07-08');   // pace passed, but bar is stale
  assert.equal(m.rawRelVol, 0.1);
  assert.equal(m.relVol, 0.1);            // pacing REFUSED — stays at the honest full-day reading
  assert.equal(m.paced, false);
  assert.equal(m.barIsToday, false);
  assert.equal(m.candidateDate, '2026-07-07');
});

test('REGRESSION: a completed 1.0x prior-day volume bar cannot become an apparent 10x', () => {
  // Last bar volume == 20-day average ⇒ a TRUE full-day relVol of exactly 1.0×.
  const stale = series('2026-07-07', 1_000_000);
  const paceEarly = 0.1;   // ~09:50, only 10% of the session elapsed

  // Stale bar (todayEt is a LATER session): the 1.0× must stay 1.0×, not blow up to 10×.
  const staleM = dayMetrics(stale, null, undefined, paceEarly, '2026-07-08');
  assert.equal(staleM.rawRelVol, 1);
  assert.equal(staleM.relVol, 1);         // NOT 10 — the defect is closed
  assert.equal(staleM.paced, false);
  assert.equal(staleM.barIsToday, false);

  // Contrast: a genuinely fresh partial bar (bar IS today) legitimately projects to 10×.
  const fresh = series('2026-07-08', 1_000_000);
  const freshM = dayMetrics(fresh, null, undefined, paceEarly, '2026-07-08');
  assert.equal(freshM.relVol, 10);        // 1.0 / 0.1 — correct for a real 10%-elapsed partial bar
  assert.equal(freshM.paced, true);
  assert.equal(freshM.barIsToday, true);
});

test('REGRESSION: pace is refused when todayEt is omitted (safe default)', () => {
  const candles = series('2026-07-07', 100_000);
  const m = dayMetrics(candles, null, undefined, 0.1);   // caller forgot todayEt
  assert.equal(m.relVol, 0.1);            // no pacing — never inflate on an unproven bar
  assert.equal(m.paced, false);
  assert.equal(m.barIsToday, false);
});

const test = require('node:test');
const assert = require('node:assert');
const { pbo, combinations } = require('../lib/research/pbo');

// Deterministic pseudo-random (mulberry32) — Math.random would make the noise
// calibration test flaky.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test('combinations enumerates n-choose-k exactly', () => {
  assert.strictEqual(combinations(8, 4).length, 70);
  assert.deepStrictEqual(combinations(3, 2), [[0, 1], [0, 2], [1, 2]]);
});

test('pure noise variants → PBO near 0.5 on average (one draw is high-variance: the 70 splits share blocks)', () => {
  // Arrange/Act — 20 independent 96×10 noise matrices; average their PBOs.
  let sum = 0;
  const N = 20;
  for (let seed = 1; seed <= N; seed++) {
    const r = rng(seed * 1000 + 7);
    const matrix = Array.from({ length: 96 }, () => Array.from({ length: 10 }, () => r() - 0.5));
    sum += pbo(matrix).pbo;
  }

  // Assert
  const mean = sum / N;
  assert.ok(mean > 0.38 && mean < 0.62, `mean noise PBO should straddle 0.5, got ${mean.toFixed(3)}`);
});

test('a genuinely dominant variant → PBO near 0 (the IS winner keeps winning OOS)', () => {
  // Arrange — variant 0 carries a real edge every date; the rest are noise.
  const r = rng(7);
  const matrix = Array.from({ length: 96 }, () => {
    const row = Array.from({ length: 10 }, () => r() - 0.5);
    row[0] = 0.6 + (r() - 0.5) * 0.2;
    return row;
  });

  // Act / Assert
  const out = pbo(matrix);
  assert.ok(out.pbo <= 0.1, `dominant-variant PBO should be ~0, got ${out.pbo}`);
});

test('anti-persistent variants (IS winner systematically inverts OOS) → high PBO', () => {
  // Arrange — two variants whose sign alternates by 12-date block PARITY, exactly out
  // of phase: whichever wins the in-sample block mix loses the complementary mix.
  const dates = 96, per = 12;
  const matrix = Array.from({ length: dates }, (_, d) =>
    Array.from({ length: 2 }, (_, v) => (((Math.floor(d / per) + v) % 2 === 0) ? 1 : -1)));

  // Act / Assert
  const out = pbo(matrix);
  assert.ok(out.pbo >= 0.6, `anti-persistent PBO should be high, got ${out.pbo}`);
});

test('fails closed on insufficient data — a null verdict, never a fabricated 0', () => {
  assert.strictEqual(pbo([[1, 2]]).pbo, null);
  assert.strictEqual(pbo([]).pbo, null);
  assert.match(pbo([[1, 2]]).reason, /too few dates/);
});

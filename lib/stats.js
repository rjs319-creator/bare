// Shared statistics helpers used across trackers and validation summaries.

// Wilson score interval for a binomial proportion — a conservative lower/upper
// bound on a win rate that accounts for sample size (so a lucky 3/3 doesn't read
// as "100%"). z=1.645 ≈ 90% one-sided. Returns { lo, hi } in [0,1].
function wilson(wins, n, z = 1.645) {
  if (!n) return { lo: 0, hi: 0 };
  const p = wins / n, z2 = z * z, denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

module.exports = { wilson };

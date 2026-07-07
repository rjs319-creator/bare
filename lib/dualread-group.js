// BEHAVIOR GROUPING for per-group weight adaptation.
//
// The self-tuner can learn a different long-term weight set for different KINDS of
// stocks — but only if the grouping is (a) meaningful for which trend factors
// predict and (b) never goes stale. Realized volatility fits both: it's computed
// from each stock's OWN price history (no maintained cap/sector lists — the app's
// memory notes those rot with delistings), and it directly separates smooth
// trenders (where trend/RS factors carry) from choppy names (where they don't).
//
// Pure: candles in → bucket out. Keep the thresholds here so the tuner, the live
// read, and the logger all bucket a stock identically (train/serve consistency).

const VOL_LOW = 0.35;    // annualized daily-return stdev below this = a calm, low-vol name
const VOL_HIGH = 0.65;   // above this = a high-volatility / speculative name
const GROUPS = ['lowvol', 'midvol', 'highvol'];
const LOOKBACK = 126;    // ~6 months of daily returns for the vol estimate

// Annualized realized volatility from the last ~126 daily returns, or null if thin.
function annualizedVol(candles) {
  if (!candles || candles.length < 30) return null;
  const closes = candles.map(c => c.close).filter(c => c > 0);
  const rets = [];
  for (let i = Math.max(1, closes.length - LOOKBACK); i < closes.length; i++) {
    const r = Math.log(closes[i] / closes[i - 1]);
    if (Number.isFinite(r)) rets.push(r);
  }
  if (rets.length < 20) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance) * Math.sqrt(252);
}

// The behavior bucket a stock belongs to. 'other' when history is too thin to judge
// (those names just ride the global weights).
function groupOf(candles) {
  const v = annualizedVol(candles);
  if (v == null) return 'other';
  return v < VOL_LOW ? 'lowvol' : v > VOL_HIGH ? 'highvol' : 'midvol';
}

module.exports = { groupOf, annualizedVol, GROUPS, VOL_LOW, VOL_HIGH };

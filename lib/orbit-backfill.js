// ORBIT historical reconstruction (orbit-backfill).
//
// Rebuilds point-in-time ORBIT samples (features + executable labels) by replaying
// the SAME orbit-features / orbit-labels code paths as-of each historical bar — so
// train and serve are identical. The per-ticker builder is PURE (candles in →
// samples out) and unit-tested; runBackfill() is the thin network wrapper that
// fetches candles + factor proxies and calls it.
//
// SURVIVORSHIP: the universe is enumerated from the CURRENT lists (see
// docs/orbit-audit §3-6). This is survivorship-biased and is flagged as such on
// every result — no production-grade claim is made from a backfill alone.

const { orbitFeatures, alignByDate } = require('./orbit-features');
const { orbitLabels } = require('./orbit-labels');
const FM = require('./orbit-factor-model');
const { SECTOR_OF } = require('./universe');

const BACKFILL_VERSION = 'orbit-backfill-v1';

// Trailing ATR% (mean high-low range / close) at index i — drives barrier widths.
function atrPctAt(candles, i, period = 14) {
  const s = Math.max(1, i - period + 1);
  let sum = 0, n = 0;
  for (let k = s; k <= i; k++) { const rng = candles[k].high - candles[k].low; if (candles[k].close > 0) { sum += rng / candles[k].close; n++; } }
  return n ? sum / n : null;
}

// PURE builder — one ticker's samples from its candles + raw factor candle arrays.
//   input: { ticker, tier, sector, candles, factorCandles:{market,sector,small,vol} }
//   opts:  { step=5, minBars=160, side='long' }
function buildTickerSamples(input, opts = {}) {
  const { ticker, tier = 'liquid', sector = null, candles, factorCandles = {} } = input;
  if (!candles || candles.length < (opts.minBars || 160)) return [];
  const step = opts.step || 5;
  const minBars = opts.minBars || 160;
  const dates = candles.map(c => c.date);
  const marketCloses = alignByDate(dates, factorCandles.market);
  const sectorCloses = alignByDate(dates, factorCandles.sector);
  const smallCloses = alignByDate(dates, factorCandles.small);
  const volCloses = alignByDate(dates, factorCandles.vol);
  const factorClosesAll = { marketCloses, sectorCloses, smallCloses, volCloses };

  // Optional feature function (e.g. orbit-ml-features.orbitMlFeatures for the
  // specialist-augmented set). Defaults to the base ORBIT feature engine.
  const featureFn = opts.featureFn || orbitFeatures;
  const samples = [];
  // Stop early enough that at least the 5-day label can resolve for the last point.
  for (let i = minBars; i < candles.length - 6; i += step) {
    const snap = featureFn(candles, factorClosesAll, { asOfIdx: i });
    if (!snap || !snap.sufficient) continue;
    const signalDate = candles[i].date;
    const labels = orbitLabels(candles, signalDate, {
      tier, side: opts.side || 'long', atrPct: atrPctAt(candles, i),
      marketCandles: factorCandles.market, sectorCandles: factorCandles.sector,
      exposures: snap.factor.exposures,
    });
    if (!labels.resolvable) continue;
    samples.push({
      ticker, decisionDate: signalDate, tier, sector,
      features: snap.features,
      factor: { exposures: snap.factor.exposures, r2: snap.factor.r2 },
      fill: labels.fill, horizons: labels.horizons,
    });
  }
  return samples;
}

const SCOPE_TIER = { micro: 'micro', small: 'small', large: 'liquid' };

// NETWORK wrapper — fetch candles + factor proxies for a universe and build samples.
// fetchHistory is injectable for tests; defaults to lib/screener fetchDailyHistory.
async function runBackfill(opts = {}) {
  const fetchHistory = opts.fetchHistory || require('./screener').fetchDailyHistory;
  const universe = opts.universe || [];
  const scope = opts.scope || 'large';
  const tier = SCOPE_TIER[scope] || 'liquid';
  const range = opts.range || '3y';
  const limit = opts.limit || universe.length;
  const names = universe.slice(0, limit);

  // Shared factor proxies (fetch once).
  const [spy, iwm, vix] = await Promise.all([fetchHistory('SPY', range), fetchHistory('IWM', range), fetchHistory('^VIX', range)]);
  const sectorCache = new Map();
  const getSector = async (etf) => {
    if (!etf) return null;
    if (!sectorCache.has(etf)) sectorCache.set(etf, (await fetchHistory(etf, range))?.candles || null);
    return sectorCache.get(etf);
  };

  const allSamples = [];
  let built = 0, skipped = 0;
  for (const ticker of names) {
    let hist;
    try { hist = await fetchHistory(ticker, range); } catch { hist = null; }
    if (!hist || !hist.candles) { skipped++; continue; }
    const sector = SECTOR_OF[ticker] || null;
    const sectorEtf = FM.sectorEtfFor(sector);
    const factorCandles = { market: spy?.candles || null, sector: await getSector(sectorEtf), small: iwm?.candles || null, vol: vix?.candles || null };
    const s = buildTickerSamples({ ticker, tier, sector, candles: hist.candles, factorCandles }, opts);
    if (s.length) { allSamples.push(...s); built++; } else skipped++;
  }

  return {
    version: BACKFILL_VERSION, scope, range, tier,
    nTickers: names.length, built, skipped, nSamples: allSamples.length,
    samples: allSamples,
    researchValidity: { productionGrade: false, survivorshipSafe: false, pointInTimeUniverse: false, pointInTimeSafe: false, limitations: ['Universe enumerated from current survivor lists; delisted names absent.', 'Sector membership is current, not point-in-time.'], reason: 'Universe enumerated from current survivor lists; delisted names absent.' },
  };
}

module.exports = { BACKFILL_VERSION, buildTickerSamples, runBackfill, atrPctAt, SCOPE_TIER };

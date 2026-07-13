// EVOLVE — SOFT REGIME VECTOR + SIMILARITY
//
// The app already has a regime LABEL (risk-on/neutral/risk-off from lib/macro.js). That
// hard label is kept for display, but EVOLVE needs a soft, multi-dimensional market-STATE
// vector so it can (a) weight specialists by how they perform in *comparable* conditions
// and (b) find historical periods most similar to today for training/validation.
//
// Each dimension is normalized to roughly [0,1] with a `known` flag. We NEVER fabricate a
// dimension we can't measure from free EOD data — an unmeasurable axis is `known:false`
// and is simply skipped by the similarity function (comparing only shared, known axes).
// Several axes are honestly labeled PROXIES (e.g. VIX term-structure approximated by
// SPY realized-vol term structure, since VIX3M/VIX9D aren't in the free feed).

'use strict';

const REGIME_VERSION = 'evolve-regime-v1';
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const stdev = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2)));
};

// The ordered regime dimensions. `weight` is the similarity importance; `proxy:true`
// marks an axis we approximate rather than measure directly (kept honest in the UI).
const REGIME_DIMS = [
  { key: 'spyTrend',        label: 'SPY trend',            weight: 1.2 },
  { key: 'qqqTrend',        label: 'QQQ trend',            weight: 1.0 },
  { key: 'iwmTrend',        label: 'IWM (small-cap) trend', weight: 1.0 },
  { key: 'breadth',         label: 'Sector breadth',        weight: 1.1 },
  { key: 'volLevel',        label: 'Volatility level',      weight: 1.2 },
  { key: 'volTerm',         label: 'Vol term structure',    weight: 0.8, proxy: true },
  { key: 'dispersion',      label: 'Cross-sectional dispersion', weight: 0.9 },
  { key: 'correlation',     label: 'Sector correlation',    weight: 0.8, proxy: true },
  { key: 'concentration',   label: 'Sector concentration',  weight: 0.7 },
  { key: 'sizeLeadership',  label: 'Small vs large leadership', weight: 0.9 },
  { key: 'styleLeadership', label: 'Growth vs value leadership', weight: 0.9, proxy: true },
  { key: 'creditStress',    label: 'Credit stress',         weight: 1.1 },
  { key: 'riskAppetite',    label: 'Risk appetite',         weight: 1.0 },
];
const DIM_KEYS = REGIME_DIMS.map(d => d.key);

// Compute simple, point-in-time-safe trend features from a candle series (caller passes
// the series as-of the prediction date). Pure. Returns null when too few bars.
function indexFeatures(candles) {
  const c = (candles || []).filter(x => x && Number.isFinite(x.close));
  const n = c.length;
  if (n < 60) return null;
  const closes = c.map(x => x.close);
  const last = closes[n - 1];
  const sma = (w) => mean(closes.slice(Math.max(0, n - w)));
  const rets = [];
  for (let i = 1; i < n; i++) rets.push(closes[i] / closes[i - 1] - 1);
  const rv = (w) => stdev(rets.slice(Math.max(0, rets.length - w))) * Math.sqrt(252); // annualized
  const mom = (w) => (n > w ? last / closes[n - 1 - w] - 1 : null);
  return {
    aboveSma50: last > sma(50), aboveSma200: last > sma(200),
    distSma50: +(last / sma(50) - 1).toFixed(4),
    mom21: mom(21), mom63: mom(63),
    rv5: +rv(5).toFixed(4), rv21: +rv(21).toFixed(4), rv63: +rv(63).toFixed(4),
    last,
  };
}

// Turn one index's features into a 0..1 "trend health" score (above MAs + positive
// momentum). Higher = healthier uptrend.
function trendScore(f) {
  if (!f) return { value: 0.5, known: false };
  let s = 0.5;
  s += f.aboveSma50 ? 0.15 : -0.15;
  s += f.aboveSma200 ? 0.15 : -0.15;
  s += clamp01(0.5 + (f.mom63 || 0) * 2) - 0.5;   // ±0.5 from 63d momentum
  return { value: +clamp01(s).toFixed(3), known: true };
}

// Build the full soft regime vector. Inputs are all optional; each missing input just
// leaves its dimensions `known:false` (skipped in similarity). Nothing is invented.
//   macro   : lib/macro.js stateAt() output (vix, credit, macroRisk, regime) — optional
//   indices : { SPY, QQQ, IWM } each = indexFeatures() output — optional
//   sectors : [{ name, changePct }] daily sector performance — optional
function buildRegimeVector({ macro = null, indices = {}, sectors = null, asOf = null } = {}) {
  const dims = {};
  const set = (k, value, known = true) => { dims[k] = { value: known ? +clamp01(value).toFixed(3) : null, known }; };

  const spy = indices.SPY || null, qqq = indices.QQQ || null, iwm = indices.IWM || null;
  const spyT = trendScore(spy), qqqT = trendScore(qqq), iwmT = trendScore(iwm);
  set('spyTrend', spyT.value, spyT.known);
  set('qqqTrend', qqqT.value, qqqT.known);
  set('iwmTrend', iwmT.value, iwmT.known);

  // Breadth + dispersion + concentration from sector daily returns.
  if (Array.isArray(sectors) && sectors.length) {
    const chg = sectors.map(s => Number(s.changePct)).filter(Number.isFinite);
    if (chg.length) {
      const posFrac = chg.filter(x => x > 0).length / chg.length;
      set('breadth', posFrac, true);
      const disp = stdev(chg);                       // spread of sector returns (%)
      set('dispersion', clamp01(disp / 3), true);    // ~3% spread → high dispersion
      // Sector correlation PROXY: low dispersion relative to average |move| ⇒ things move
      // together (high correlation). 1 − normalized dispersion.
      const avgAbs = mean(chg.map(Math.abs)) || 1;
      set('correlation', clamp01(1 - disp / (avgAbs * 2 + 1e-6)), true);
      // Concentration: how much of the day's absolute move is in the top sector (HHI-ish).
      const absSum = chg.reduce((s, x) => s + Math.abs(x), 0) || 1;
      const top = Math.max(...chg.map(Math.abs));
      set('concentration', clamp01(top / absSum * chg.length / 4), true);
    } else { ['breadth', 'dispersion', 'correlation', 'concentration'].forEach(k => set(k, 0.5, false)); }
  } else { ['breadth', 'dispersion', 'correlation', 'concentration'].forEach(k => set(k, 0.5, false)); }

  // Volatility level + term structure. Prefer VIX (macro); fall back to SPY realized vol.
  if (macro && macro.vix && Number.isFinite(macro.vix.pctile)) {
    set('volLevel', macro.vix.pctile / 100, true);
  } else if (spy && Number.isFinite(spy.rv21)) {
    set('volLevel', clamp01(spy.rv21 / 0.4), true);  // ~40% annualized rv = extreme
  } else set('volLevel', 0.5, false);
  // Term structure PROXY: short realized vol vs longer realized vol (backwardation =
  // stress). >1 ⇒ near-term vol elevated ⇒ risk-off tilt.
  if (spy && Number.isFinite(spy.rv5) && Number.isFinite(spy.rv63) && spy.rv63 > 0) {
    set('volTerm', clamp01(spy.rv5 / spy.rv63 / 2), true);
  } else set('volTerm', 0.5, false);

  // Size + style leadership (relative momentum). IWM vs SPY = small/large; QQQ vs SPY =
  // growth/value proxy. 0.5 = neutral; >0.5 = the risk-on side leading.
  const relMom = (a, b, w = 'mom21') => (a && b && a[w] != null && b[w] != null)
    ? clamp01(0.5 + (a[w] - b[w]) * 3) : null;
  const sz = relMom(iwm, spy);
  set('sizeLeadership', sz == null ? 0.5 : sz, sz != null);
  const st = relMom(qqq, spy);
  set('styleLeadership', st == null ? 0.5 : st, st != null);

  // Credit stress + risk appetite (macro). creditStress 0..100; risk appetite is the
  // inverse of blended macro risk.
  if (macro && Number.isFinite(macro.macroRisk)) {
    const credit = macro.credit && macro.credit.belowSma
      ? clamp01((macro.credit.sma50 - macro.credit.ratio) / macro.credit.sma50 * 20) : 0;
    set('creditStress', credit, true);
    set('riskAppetite', 1 - macro.macroRisk / 100, true);
  } else { set('creditStress', 0, false); set('riskAppetite', 0.5, false); }

  const knownCount = DIM_KEYS.filter(k => dims[k] && dims[k].known).length;
  // A coarse display label consistent with the app's existing regime vocabulary.
  const label = macro && macro.regime ? macro.regime
    : spyT.known ? (spyT.value > 0.6 ? 'risk-on' : spyT.value < 0.4 ? 'risk-off' : 'neutral') : 'unknown';
  return {
    version: REGIME_VERSION, asOf: asOf || (macro && macro.asOf) || null,
    label, dims, vec: DIM_KEYS.map(k => (dims[k] && dims[k].known ? dims[k].value : null)),
    knownCount, of: DIM_KEYS.length,
  };
}

// Weighted similarity of two regime vectors over the axes BOTH know. Gaussian kernel on
// per-axis distance → [0,1] (1 = identical). Ignores axes either side is missing, so a
// sparse historical snapshot still compares fairly on what it does have.
function regimeSimilarity(a, b, { bandwidth = 0.35 } = {}) {
  if (!a || !b || !a.dims || !b.dims) return null;
  let wsum = 0, dsum = 0, shared = 0;
  for (const d of REGIME_DIMS) {
    const da = a.dims[d.key], db = b.dims[d.key];
    if (!da || !db || !da.known || !db.known) continue;
    shared++;
    const diff = da.value - db.value;
    wsum += d.weight;
    dsum += d.weight * diff * diff;
  }
  if (!shared || !wsum) return null;
  const rms = Math.sqrt(dsum / wsum);              // weighted RMS distance
  const sim = Math.exp(-(rms * rms) / (2 * bandwidth * bandwidth));
  return { similarity: +sim.toFixed(3), sharedDims: shared };
}

// Combined similarity × recency weights for a set of historical regime snapshots,
// normalized to sum to 1. Recent + similar periods dominate training/validation; ancient
// or dissimilar periods still contribute a little (floor) rather than being erased.
//   history: [{ asOf, vector, ageDays }]
function similarityWeights(current, history, { halflifeDays = 180, floor = 0.02 } = {}) {
  const out = (history || []).map(h => {
    const sim = regimeSimilarity(current, h.vector);
    const s = sim ? sim.similarity : 0;
    const recency = Math.pow(0.5, (h.ageDays || 0) / halflifeDays);
    const w = Math.max(floor, s) * recency;
    return { asOf: h.asOf, similarity: s, recency: +recency.toFixed(3), weight: w };
  });
  const total = out.reduce((s, x) => s + x.weight, 0) || 1;
  return out.map(x => ({ ...x, weight: +(x.weight / total).toFixed(4) }));
}

module.exports = {
  REGIME_VERSION, REGIME_DIMS, DIM_KEYS,
  indexFeatures, trendScore, buildRegimeVector, regimeSimilarity, similarityWeights,
};

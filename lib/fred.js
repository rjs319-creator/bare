'use strict';
// FRED — Federal Reserve Economic Data adapter.
//
// Supplies the macro legs the strategic (1–6 month) regime layer needs. Free, keyed,
// rate-limited. One series per call; the caller batches with bounded concurrency.
//
// HONESTY CONSTRAINTS BAKED IN:
//
//   • No key ⇒ every series returns UNAVAILABLE with a reason. The strategic layer then
//     stays UNAVAILABLE rather than being inferred from price, which is the whole point.
//   • FRED serves the LATEST VINTAGE. Macro series are revised, sometimes materially, so
//     today's value for a past date is NOT what was known at that date. That makes this a
//     LIVE read only. `backtestSafe: false` rides on every observation, and nothing here
//     may be fed into the research harness without switching to ALFRED vintage endpoints.
//   • Release lag is real: `GDPC1` is quarterly and lands ~4 weeks after quarter end.
//     Each series declares `staleAfterDays`, and an observation past it reports STALE
//     instead of pretending to be current.
//   • Trends come from the series' own history, never from a hardcoded prior.
//
// Pure apart from the injected fetch.

const { fetchWithTimeout } = require('./http');

const FRED_VERSION = 'fred-v1';
const BASE = 'https://api.stlouisfed.org/fred/series/observations';
const KEY_ENV = 'FRED_API_KEY';

// The series each strategic leg is built from. `invert` marks series where UP is
// risk-NEGATIVE (a rising unemployment rate is not growth).
const SERIES = Object.freeze({
  // growth
  INDPRO: { leg: 'growth', label: 'Industrial Production', freq: 'monthly', staleAfterDays: 75, invert: false },
  GDPC1: { leg: 'growth', label: 'Real GDP', freq: 'quarterly', staleAfterDays: 190, invert: false },
  // inflation
  CPIAUCSL: { leg: 'inflation', label: 'CPI (all urban)', freq: 'monthly', staleAfterDays: 75, invert: false },
  PCEPILFE: { leg: 'inflation', label: 'Core PCE', freq: 'monthly', staleAfterDays: 75, invert: false },
  // liquidity — Fed balance sheet less the drains (RRP + Treasury General Account)
  WALCL: { leg: 'liquidity', label: 'Fed total assets', freq: 'weekly', staleAfterDays: 21, invert: false },
  RRPONTSYD: { leg: 'liquidity', label: 'Overnight reverse repo', freq: 'daily', staleAfterDays: 10, invert: true },
  WTREGEN: { leg: 'liquidity', label: 'Treasury General Account', freq: 'weekly', staleAfterDays: 21, invert: true },
  // valuation input — the risk-free leg of an equity-risk-premium read
  DGS10: { leg: 'valuation', label: '10-year Treasury yield', freq: 'daily', staleAfterDays: 10, invert: true },
});

const unavailable = reason => ({ available: false, reason: String(reason) });
const isNum = v => v != null && Number.isFinite(+v);
const round = (n, d = 4) => (isNum(n) ? +(+n).toFixed(d) : null);

function hasKey(key = process.env[KEY_ENV]) { return !!(key && String(key).trim()); }

/**
 * Fetch one FRED series. Returns { available, id, observations:[{date,value}], ... }
 * or an explicit unavailable. Never throws.
 */
async function fetchSeries(id, { key = process.env[KEY_ENV], limit = 400, fetchImpl = fetchWithTimeout, now = Date.now() } = {}) {
  if (!hasKey(key)) {
    return { ...unavailable(`${KEY_ENV} is not set — FRED macro series cannot be fetched, so the strategic regime layer stays UNAVAILABLE rather than being guessed from price`), id };
  }
  const meta = SERIES[id];
  if (!meta) return { ...unavailable(`unknown FRED series "${id}"`), id };
  const url = `${BASE}?series_id=${encodeURIComponent(id)}&api_key=${encodeURIComponent(key)}`
    + `&file_type=json&sort_order=desc&limit=${limit}`;
  try {
    const r = await fetchImpl(url, { timeoutMs: 15_000 });
    if (!r || !r.ok) return { ...unavailable(`FRED returned HTTP ${r ? r.status : '(no response)'} for ${id}`), id };
    const j = await r.json();
    const raw = Array.isArray(j && j.observations) ? j.observations : null;
    if (!raw) return { ...unavailable(`FRED response for ${id} had no observations array`), id };
    // FRED encodes missing values as "."; drop them rather than coercing to 0.
    const obs = raw
      .filter(o => o && o.date && o.value !== '.' && isNum(o.value))
      .map(o => ({ date: o.date, value: +o.value }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    if (!obs.length) return { ...unavailable(`FRED returned no usable observations for ${id} (all values missing)`), id };

    const last = obs[obs.length - 1];
    const ageDays = Math.floor((now - Date.parse(`${last.date}T00:00:00Z`)) / 86_400_000);
    const stale = ageDays > meta.staleAfterDays;
    return {
      available: true,
      id, leg: meta.leg, label: meta.label, frequency: meta.freq, invert: meta.invert,
      observations: obs,
      latest: { date: last.date, value: last.value },
      ageDays,
      stale,
      staleAfterDays: meta.staleAfterDays,
      staleReason: stale ? `latest observation is ${ageDays}d old (expected within ${meta.staleAfterDays}d for a ${meta.freq} series) — release delayed or the series was discontinued` : null,
      // See header: FRED serves the latest vintage, so this is a LIVE read only.
      backtestSafe: false,
      vintageNote: 'FRED serves the latest revision. Values for past dates are NOT what was known at those dates — use ALFRED vintage endpoints before any backtest.',
      source: 'FRED',
      fetchedAt: new Date(now).toISOString(),
    };
  } catch (e) {
    return { ...unavailable(`FRED fetch failed for ${id}: ${String((e && e.message) || e).slice(0, 120)}`), id };
  }
}

/**
 * Direction of travel for a series, from its OWN history. Pure.
 *
 * Compares the latest value against the mean of the prior `lookback` observations,
 * scaled by that window's own standard deviation, so "up" means "up relative to how
 * much this series normally moves" rather than any absolute threshold.
 */
function trendOf(series, { lookback = 12, zFlat = 0.5 } = {}) {
  if (!series || !series.available) return unavailable(series ? series.reason : 'no series');
  const obs = series.observations || [];
  if (obs.length < lookback + 1) {
    return unavailable(`only ${obs.length} observations for ${series.id} (need ${lookback + 1}) — no trend can be established`);
  }
  const vals = obs.map(o => o.value);
  const latest = vals[vals.length - 1];
  const window = vals.slice(-(lookback + 1), -1);
  const mean = window.reduce((s, v) => s + v, 0) / window.length;
  const sd = Math.sqrt(window.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, window.length - 1));
  // NOISE FLOOR. Dividing by a near-zero SD turns float jitter into a huge z-score, so a
  // series that is essentially flat would report a confident trend. Require the window's
  // dispersion to be a meaningful fraction of its own level before trusting the ratio.
  const scale = Math.abs(mean);
  const meaningful = sd > 0 && (scale === 0 || sd / scale >= 1e-4);
  const z = meaningful ? (latest - mean) / sd : 0;
  const eff = series.invert ? -z : z;
  const trend = eff >= zFlat ? 'up' : eff <= -zFlat ? 'down' : 'flat';
  return {
    available: true,
    trend,
    value: round(latest),
    z: round(eff, 2),
    rawZ: round(z, 2),
    // True when the window's dispersion was too small to trust a ratio against.
    belowNoiseFloor: !meaningful,
    inverted: !!series.invert,
    lookback,
    asOf: series.latest.date,
    stale: series.stale,
    source: `FRED:${series.id}`,
    label: series.label,
  };
}

/** Fetch several series with bounded concurrency. Never throws. */
async function fetchSeriesSet(ids, opts = {}) {
  const out = {};
  const list = [...new Set(ids || [])];
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const id = list[i++];
      out[id] = await fetchSeries(id, opts);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, list.length || 1) }, worker));
  return out;
}

module.exports = { FRED_VERSION, SERIES, KEY_ENV, hasKey, fetchSeries, fetchSeriesSet, trendOf };

'use strict';
// NOVEL SIGNAL LAB — Engine 4: real-time operating-activity nowcast (operating-nowcast-v1).
//
// Job-posting counts, app-store rankings, web-traffic and review velocity can update an
// operating picture faster than filings (job-postings resilience: NBER w28588). ALL of these
// are LICENSED alt-data panels (Revelio/LinkUp, data.ai/Sensor Tower, Similarweb). This
// deployment holds no such licence, so this engine is a clean provider interface that emits
// UNAVAILABLE — never a scraped or fabricated value, and never a neutral zero. The moment a
// provider key is configured, `provider.fetch` is called and the pure normalizer below runs.

const { unavailable, makeEnvelope, STATUS, DIRECTION, clamp01 } = require('./registry');
const { resolveSignal } = require('./providers');
const { signalMeta } = require('./registry');

// PURE. Normalize a provider's operating series into the nowcast signals. `series` = a list of
// { obsTs, pubTs, metric, value } already latency-correct. Kept here so a future licensed feed
// plugs in without touching callers. Returns null if too sparse.
function assessOperating(series, asOf) {
  if (!Array.isArray(series) || series.length < 6) return null;
  const pit = series.filter(p => p.pubTs && p.pubTs <= asOf && Number.isFinite(p.value)).sort((a, b) => (a.obsTs < b.obsTs ? -1 : 1));
  if (pit.length < 6) return null;
  const recent = pit.slice(-3).map(p => p.value), base = pit.slice(-6, -3).map(p => p.value);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const accel = mean(base) !== 0 ? mean(recent) / mean(base) - 1 : null; // change in trajectory, not level
  const latest = pit.at(-1);
  return { operatingAcceleration: accel, latestPubTs: latest.pubTs, n: pit.length };
}

function computeOperatingNowcast(ticker, { asOf, securityId = null, providerData = null } = {}) {
  const meta = signalMeta(4);
  const { anyAvailable } = resolveSignal(meta);
  if (!anyAvailable || !providerData) {
    return unavailable('operating_nowcast', { engine: 4, ticker, securityId, asOf,
      reason: 'operating alt-data (job postings / app rankings / web traffic) requires a licensed panel; none configured',
      provider: 'jobs_feed', restrictions: 'licensed alt-data — not held by this deployment' });
  }
  const a = assessOperating(providerData, asOf);
  if (!a) return unavailable('operating_nowcast', { engine: 4, ticker, securityId, asOf, reason: 'insufficient operating history', provider: 'jobs_feed' });
  const daysBetween = (x, y) => Math.round((Date.parse(x) - Date.parse(y)) / 86400000);
  return makeEnvelope({
    engine: 4, signal: 'operating_nowcast', signalVersion: 'operating-nowcast-v1', ticker, securityId, asOf,
    status: STATUS.EXPERIMENTAL, // even when data appears, incremental value is unproven
    score: a.operatingAcceleration != null ? +Math.max(-1, Math.min(1, a.operatingAcceleration)).toFixed(4) : null,
    direction: a.operatingAcceleration == null ? DIRECTION.NEUTRAL : (a.operatingAcceleration > 0 ? DIRECTION.LONG : DIRECTION.SHORT),
    confidence: clamp01(0.3), coverage: 1,
    staleness: { ageDays: daysBetween(asOf, a.latestPubTs), publishedTs: a.latestPubTs },
    warnings: ['experimental — coverage/methodology breaks not yet modelled'],
  });
}

module.exports = { assessOperating, computeOperatingNowcast };

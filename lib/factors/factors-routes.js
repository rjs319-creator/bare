'use strict';
// FACTOR DATA — route handlers (proposal #18, factor-adjusted Scoreboard).
//
//   op=factors         public read  — French cache status (coverage, publication lag, stale
//                                     flag) + the ETF proxy definitions. No rows (the table is
//                                     a research input, not a display).
//   op=factorsrefresh  PRIVILEGED   — weekly Ken French refresh; `force=1` overrides the
//                                     cadence. Rides the nightly `maturity` chain. Fails closed:
//                                     a vendor/parse error leaves the previous doc in place and
//                                     returns 502 so op=health counts the failed step.
const STORE = require('../store');
const KF = require('./ken-french');
const EP = require('./etf-proxies');

const STATUS_CACHE_S = 1800;
const noStore = (res) => res.setHeader('Cache-Control', 'no-store');
const cached = (res, s = STATUS_CACHE_S) => res.setHeader('Cache-Control', `s-maxage=${s}, stale-while-revalidate=600`);

const proxyLegs = () => Object.fromEntries(EP.PROXY_KEYS.map(k => [k, EP.PROXY_FACTORS[k]]));

async function runFactors(req, res) {
  if (!STORE.hasStore()) { noStore(res); return res.status(200).json({ ok: false, configured: false, error: 'Blob storage not configured.' }); }
  const doc = await KF.loadFactorTable(STORE);
  if (!doc) {
    noStore(res);   // never CDN-cache the empty state
    return res.status(200).json({ ok: true, configured: true, cached: false, path: KF.FACTOR_CACHE_PATH, proxies: proxyLegs(), note: 'no French cache yet — op=factorsrefresh (bearer) builds it; the Scoreboard factorAlpha block runs on ETF proxies until then' });
  }
  cached(res);
  return res.status(200).json({
    ok: true, configured: true, cached: true, path: KF.FACTOR_CACHE_PATH,
    version: doc.version, source: doc.source, units: doc.units, fetchedAt: doc.fetchedAt,
    firstDate: doc.firstDate, lastDate: doc.lastDate, lagDays: doc.lagDays, stale: doc.stale, expectedLagDays: doc.expectedLagDays,
    rows: doc.rows.length, factors: doc.factors, refreshIntervalDays: KF.REFRESH_INTERVAL_DAYS, proxies: proxyLegs(),
    disclosure: 'Research input for the SHADOW factorAlpha block (weight 0). French factors lag ~1 month; windows past lastDate are carried by the ETF proxies and labelled source:proxy.',
  });
}

async function runFactorsRefresh(req, res) {
  noStore(res);
  if (!STORE.hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  const force = String((req.query && req.query.force) || '') === '1';
  const r = await KF.refreshFactorCache({ store: STORE, force });
  return res.status(r.error ? 502 : 200).json({ ok: !r.error, ...r });
}

module.exports = { runFactors, runFactorsRefresh };

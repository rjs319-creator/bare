'use strict';
// ⚡ GRIDLOCK — primary-source adapters for the PJM vertical slice.
//
// Three adapters, all server-side, all through lib/http.js fetchWithTimeout:
//   • PJM Data Miner 2  — needs PJM_API_KEY (free registration). Load, forecast,
//     generation outages.
//   • EIA v2 API        — needs EIA_API_KEY (free). Hourly region demand /
//     net generation / interchange + generation by fuel for respondent=PJM.
//   • NWS api.weather.gov — keyless (User-Agent etiquette like lib/edgar.js).
//     Active alerts for the PJM footprint states.
//
// HONESTY CONTRACT: a missing key or failed fetch returns { ok:false, reason }
// and the region state marks those fields missing/stale. No adapter ever
// fabricates a value, and nothing here throws (safe-provider-failure rule,
// same as lib/govdemand-collect.js).

const { fetchWithTimeout } = require('./http');

const SOURCES_VERSION = 'gridlock-sources-v1';
const FETCH_TIMEOUT_MS = 12000;
const RETRIES = 1;                       // one retry w/ backoff on 429/5xx/timeouts
const UA = process.env.SEC_USER_AGENT || 'market-news-app (contact: rjs319@gmail.com)';

const PJM_BASE = 'https://api.pjm.com/api/v1';
const EIA_BASE = 'https://api.eia.gov/v2';
const NWS_ALERTS = 'https://api.weather.gov/alerts/active';
const PJM_FOOTPRINT_STATES = 'PA,NJ,MD,VA,WV,OH,DE,IL,KY,NC,DC,IN,MI,TN';

function manifest(sourceId, publisher, url, ok, reason) {
  return {
    sourceId, sourceFamily: sourceId.startsWith('nws') ? 'weather-service' : 'iso-market-data',
    publisher, sourceUrl: url, retrievedAt: new Date().toISOString(),
    primaryOrSecondary: 'primary', parserVersion: SOURCES_VERSION,
    ok, reason: reason || null,
  };
}

async function getJson(url, headers) {
  const r = await fetchWithTimeout(url, { headers, timeoutMs: FETCH_TIMEOUT_MS, retries: RETRIES })
    .catch(e => ({ ok: false, status: 0, _err: String((e && e.message) || e) }));
  if (!r || !r.ok) return { ok: false, reason: r && r._err ? r._err : `http ${r && r.status}` };
  try { return { ok: true, json: await r.json() }; }
  catch (e) { return { ok: false, reason: `bad json: ${String((e && e.message) || e)}` }; }
}

// ── PJM Data Miner 2 ─────────────────────────────────────────────────────────
async function fetchPjm() {
  const key = process.env.PJM_API_KEY;
  const url = `${PJM_BASE}/inst_load`;
  if (!key) return { ok: false, reason: 'PJM_API_KEY not configured', manifest: manifest('pjm:dataminer', 'PJM Interconnection', PJM_BASE, false, 'PJM_API_KEY not configured') };
  const H = { 'Ocp-Apim-Subscription-Key': key, Accept: 'application/json' };
  const q = (ep, params) => getJson(`${PJM_BASE}/${ep}?${params}`, H);

  const [load, frcst, outages] = await Promise.all([
    q('inst_load', 'rowCount=1&sort=datetime_beginning_ept&order=desc&fields=datetime_beginning_ept,instantaneous_load'),
    q('load_frcstd_7_day', 'rowCount=24&sort=forecast_datetime_beginning_ept&order=asc&fields=forecast_datetime_beginning_ept,forecast_load_mw,forecast_area'),
    q('gen_outages_by_type', 'rowCount=8&sort=forecast_execution_date_ept&order=desc&fields=forecast_execution_date_ept,region,planned_outages_mw,maintenance_outages_mw,forced_outages_mw,total_outages_mw'),
  ]);

  const rows = (r) => (r.ok && r.json && (r.json.items || r.json)) || null;
  const loadRow = Array.isArray(rows(load)) ? rows(load)[0] : null;
  const frcstRows = Array.isArray(rows(frcst)) ? rows(frcst) : null;
  // RTO-level forecast for the next few hours (Data Miner mixes areas; keep RTO rows).
  const rtoFrcst = frcstRows ? frcstRows.filter(r => /rto/i.test(String(r.forecast_area || ''))) : null;
  const outRows = Array.isArray(rows(outages)) ? rows(outages) : null;
  const rtoOut = outRows ? outRows.find(r => /rto/i.test(String(r.region || ''))) : null;

  const anyOk = load.ok || frcst.ok || outages.ok;
  return {
    ok: anyOk,
    reason: anyOk ? null : (load.reason || frcst.reason || outages.reason),
    currentLoadMW: loadRow && Number.isFinite(+loadRow.instantaneous_load) ? +loadRow.instantaneous_load : null,
    loadAsOf: loadRow ? loadRow.datetime_beginning_ept : null,
    forecastLoadMW: rtoFrcst && rtoFrcst.length ? Math.max(...rtoFrcst.map(r => +r.forecast_load_mw).filter(Number.isFinite)) : null,
    outageCapacityMW: rtoOut && Number.isFinite(+rtoOut.total_outages_mw) ? +rtoOut.total_outages_mw : null,
    // PJM installed capacity is a published planning figure, not in these feeds:
    // routes pass a disclosed assumption (REGION_NORMS) — never presented as observed.
    installedCapacityMW: null,
    dayAheadPrice: null, realTimePrice: null, zonalPrices: null,   // LMP feeds: later slice
    manifest: manifest('pjm:dataminer', 'PJM Interconnection', PJM_BASE, anyOk, anyOk ? null : 'all endpoints failed'),
  };
}

// ── EIA v2 ──────────────────────────────────────────────────────────────────
async function fetchEia(respondent = 'PJM') {
  const key = process.env.EIA_API_KEY;
  if (!key) return { ok: false, reason: 'EIA_API_KEY not configured', manifest: manifest('eia:rto', 'US EIA', EIA_BASE, false, 'EIA_API_KEY not configured') };
  const series = (type) =>
    `${EIA_BASE}/electricity/rto/region-data/data/?api_key=${key}&frequency=hourly&data[0]=value` +
    `&facets[respondent][]=${respondent}&facets[type][]=${type}&sort[0][column]=period&sort[0][direction]=desc&length=1`;
  const fuelUrl =
    `${EIA_BASE}/electricity/rto/fuel-type-data/data/?api_key=${key}&frequency=hourly&data[0]=value` +
    `&facets[respondent][]=${respondent}&sort[0][column]=period&sort[0][direction]=desc&length=12`;

  const [d, ng, ti, fuel] = await Promise.all([
    getJson(series('D')), getJson(series('NG')), getJson(series('TI')), getJson(fuelUrl),
  ]);
  const val = (r) => {
    const rows = r.ok && r.json && r.json.response && r.json.response.data;
    return Array.isArray(rows) && rows[0] && Number.isFinite(+rows[0].value) ? +rows[0].value : null;
  };
  const generationByFuel = (() => {
    const rows = fuel.ok && fuel.json && fuel.json.response && fuel.json.response.data;
    if (!Array.isArray(rows) || !rows.length) return null;
    const latest = rows[0].period;
    const out = {};
    for (const r of rows) if (r.period === latest && Number.isFinite(+r.value)) out[r['type-name'] || r.fueltype] = +r.value;
    return Object.keys(out).length ? out : null;
  })();

  const anyOk = d.ok || ng.ok || ti.ok || fuel.ok;
  return {
    ok: anyOk, reason: anyOk ? null : (d.reason || ng.reason),
    demandMW: val(d), netGenerationMW: val(ng), interchangeMW: val(ti), generationByFuel,
    manifest: manifest('eia:rto', 'US EIA', EIA_BASE, anyOk, anyOk ? null : 'all series failed'),
  };
}

// ── NWS active alerts (keyless) ─────────────────────────────────────────────
async function fetchNwsAlerts(area = PJM_FOOTPRINT_STATES) {
  const url = `${NWS_ALERTS}?area=${encodeURIComponent(area)}`;
  const r = await getJson(url, { 'User-Agent': UA, Accept: 'application/geo+json' });
  if (!r.ok) return { ok: false, reason: r.reason, activeAlerts: null, manifest: manifest('nws:alerts', 'National Weather Service', url, false, r.reason) };
  const feats = Array.isArray(r.json && r.json.features) ? r.json.features : [];
  const activeAlerts = feats.map(f => f && f.properties ? {
    event: f.properties.event || null, severity: f.properties.severity || null,
    areaDesc: String(f.properties.areaDesc || '').slice(0, 160),
    onset: f.properties.onset || null, ends: f.properties.ends || null,
  } : null).filter(Boolean).slice(0, 200);
  return { ok: true, activeAlerts, manifest: manifest('nws:alerts', 'National Weather Service', url, true) };
}

// ── Composite fetch for one region (bounded; every branch fail-soft) ────────
async function fetchRegionInputs({ isoRegion = 'PJM' } = {}) {
  const [pjm, eia, nws] = await Promise.all([
    isoRegion === 'PJM' ? fetchPjm() : Promise.resolve({ ok: false, reason: `no ISO adapter for ${isoRegion}`, manifest: manifest('iso:none', isoRegion, null, false, 'unsupported') }),
    fetchEia(isoRegion),
    fetchNwsAlerts(),
  ]);
  return {
    pjm: pjm.ok ? pjm : null,
    eia: eia.ok ? eia : null,
    nws: nws.ok ? nws : null,
    sourceManifest: [pjm.manifest, eia.manifest, nws.manifest].filter(Boolean),
    failures: [pjm, eia, nws].filter(x => !x.ok).map(x => x.reason),
  };
}

module.exports = {
  SOURCES_VERSION, PJM_FOOTPRINT_STATES,
  fetchPjm, fetchEia, fetchNwsAlerts, fetchRegionInputs,
};

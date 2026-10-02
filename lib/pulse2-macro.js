'use strict';
// 📡 STRATEGIC MACRO INPUTS — FRED series → the `macroInputs` shape the regime stack takes.
//
// `lib/pulse2-regime-stack.js` has always accepted
//   { growth, inflation, liquidity, earningsRevisions, valuation }
// with each leg `{ trend: 'up'|'down'|'flat', value, source }`, and has always been passed
// `null` — which is why the strategic layer reported UNAVAILABLE. This builds that object.
//
// What each leg means here, stated plainly because the SIGN is the load-bearing part:
//
//   growth      INDPRO (monthly, responsive) with GDPC1 as the slower confirm.
//   inflation   Core PCE preferred (the Fed's target measure); CPI is the fallback.
//   liquidity   NET Fed liquidity = WALCL − RRP − TGA. The balance sheet alone is the
//               wrong read: reserves drained into reverse repo or the Treasury's account
//               are not in the system. Both drains are marked `invert` in lib/fred.
//   valuation   Equity risk premium proxy = earnings yield − 10y real-ish yield. A RISING
//               ERP means equities are CHEAPER vs bonds, so the leg is oriented so that
//               `trend:'down'` = richer = a headwind, matching how the regime stack reads it.
//
// earningsRevisions is deliberately absent — it needs an estimates vendor (see
// docs/blocked-on-data.md §4). The strategic layer needs only two legs, so four is plenty.
//
// Pure apart from the injected fetcher.

const fred = require('./fred');
const treasury = require('./treasury-curve');
const bls = require('./bls');

// v2 (2026-10-02): the 10-year leg and the 2s10s curve read come from the Treasury par
// yield CSV FIRST (keyless, same-day, never revised) with FRED DGS10/DGS2 as the fallback;
// BLS CPI-U is the keyless third attempt for the inflation leg. The regime stack still
// receives the same four legs — `curve` is reported as a diagnostic beside them.
const MACRO_VERSION = 'pulse2-macro-v2';
// Keyless BLS corroboration/fallback appended after the FRED inflation series.
const INFLATION_FALLBACK = Object.freeze(['CUUR0000SA0']);
const BP_PER_PCT = 100;

const unavailable = reason => ({ available: false, reason: String(reason) });
const isNum = v => v != null && Number.isFinite(+v);
const round = (n, d = 2) => (isNum(n) ? +(+n).toFixed(d) : null);

// Preferred series per leg, in order. The first that yields a usable trend wins; the
// others are reported as corroboration rather than silently dropped.
const LEG_SERIES = Object.freeze({
  growth: ['INDPRO', 'GDPC1'],
  inflation: ['PCEPILFE', 'CPIAUCSL'],
});

function legFrom(ids, seriesById, { lookback }) {
  const attempts = [];
  let chosen = null;
  for (const id of ids) {
    const s = seriesById[id];
    if (!s || !s.available) { attempts.push({ id, ok: false, reason: (s && s.reason) || 'not fetched' }); continue; }
    const t = fred.trendOf(s, { lookback });
    if (!t.available) { attempts.push({ id, ok: false, reason: t.reason }); continue; }
    attempts.push({ id, ok: true, trend: t.trend, z: t.z, asOf: t.asOf, stale: t.stale });
    // trendOf labels every series FRED:<id>; a non-FRED provider (BLS, Treasury) keeps its own name.
    if (!chosen) chosen = { ...t, id, source: s.source && s.source !== 'FRED' ? `${s.source}:${id}` : t.source };
  }
  if (!chosen) return { ...unavailable(`no usable series for this leg (${attempts.map(a => `${a.id}: ${a.reason}`).join('; ')})`), attempts };
  return {
    available: true,
    trend: chosen.trend, value: chosen.value, z: chosen.z,
    source: chosen.source, label: chosen.label, asOf: chosen.asOf, stale: chosen.stale,
    // Every attempt is retained on BOTH paths, so a leg that fell back to its second
    // series shows which one failed and why rather than looking like a clean first pick.
    attempts,
    // Corroboration is exposed, not merged: a second series disagreeing is information.
    corroboration: attempts.filter(a => a.ok && a.id !== chosen.id),
  };
}

/**
 * 2s10s curve read — Treasury par yields FIRST (same-day, unrevised), FRED DGS10−DGS2 as
 * the fallback. Reported as a DIAGNOSTIC beside the strategic legs: the regime stack has
 * no curve leg, so this never changes a regime read on its own.
 */
function curveLeg({ curve = null, seriesById = {}, lookback }) {
  const attempts = [];
  let series = null;
  const t = treasury.twoTenSeries(curve);
  if (t.available) series = t;
  else attempts.push({ id: 'TREASURY_2S10S', ok: false, reason: t.reason });
  if (!series) {
    const a = seriesById.DGS10, b = seriesById.DGS2;
    if (a && a.available && b && b.available) {
      const twoYr = new Map(b.observations.map(o => [o.date, o.value]));
      const rows = a.observations.filter(o => twoYr.has(o.date)).map(o => ({ date: o.date, value: round((o.value - twoYr.get(o.date)) * BP_PER_PCT, 1) }));
      if (rows.length) series = { available: true, id: 'FRED_2S10S', label: '2s10s Treasury spread (bp)', invert: false, observations: rows, latest: rows[rows.length - 1], stale: !!(a.stale || b.stale), source: 'FRED' };
      else attempts.push({ id: 'FRED:DGS10−DGS2', ok: false, reason: 'no overlapping dates' });
    } else {
      attempts.push({ id: 'FRED:DGS10−DGS2', ok: false, reason: `DGS10 ${(a && (a.available ? 'ok' : a.reason)) || 'not fetched'}; DGS2 ${(b && (b.available ? 'ok' : b.reason)) || 'not fetched'}` });
    }
  }
  if (!series) return { ...unavailable(`no 2s10s source (${attempts.map(a => `${a.id}: ${a.reason}`).join('; ')})`), attempts };
  attempts.push({ id: series.id, ok: true });
  const tr = fred.trendOf(series, { lookback });
  return {
    available: true,
    source: series.source === 'treasury' ? 'TREASURY:2s10s' : 'FRED:DGS10−DGS2',
    twoTenBp: series.latest.value, inverted: series.latest.value < 0,
    trend: tr.available ? tr.trend : null, z: tr.available ? tr.z : null,
    asOf: series.latest.date, stale: series.stale, backtestSafe: series.source === 'treasury', attempts,
    note: 'Diagnostic beside the strategic legs; the regime stack has no curve leg.',
  };
}

/**
 * NET Fed liquidity: WALCL − RRPONTSYD − WTREGEN, then trended as one composite series.
 * Requires all three — a partial net is worse than none, because the sign can flip.
 */
function liquidityLeg(seriesById, { lookback }) {
  const need = ['WALCL', 'RRPONTSYD', 'WTREGEN'];
  const missing = need.filter(id => !seriesById[id] || !seriesById[id].available);
  if (missing.length) {
    return unavailable(`net liquidity needs all of ${need.join(', ')}; missing ${missing.join(', ')}. A partial net is NOT computed — dropping a drain flips the sign.`);
  }
  // Align on dates present in the weekly balance-sheet series (the slowest leg), taking
  // the most recent drain observation at or before each balance-sheet date.
  const asOf = id => seriesById[id].observations;
  const at = (obs, date) => {
    let v = null;
    for (const o of obs) { if (o.date <= date) v = o.value; else break; }
    return v;
  };
  const rows = [];
  for (const w of asOf('WALCL')) {
    const rrp = at(asOf('RRPONTSYD'), w.date);
    const tga = at(asOf('WTREGEN'), w.date);
    if (rrp == null || tga == null) continue;
    // FRED units: WALCL and WTREGEN in $M, RRPONTSYD in $B. Normalize to $B.
    rows.push({ date: w.date, value: w.value / 1000 - rrp - tga / 1000 });
  }
  if (rows.length < lookback + 1) {
    return unavailable(`only ${rows.length} aligned net-liquidity observations (need ${lookback + 1})`);
  }
  const synthetic = {
    available: true, id: 'NET_LIQUIDITY', label: 'Net Fed liquidity (WALCL − RRP − TGA)',
    invert: false, observations: rows,
    latest: rows[rows.length - 1], stale: seriesById.WALCL.stale,
  };
  const t = fred.trendOf(synthetic, { lookback });
  if (!t.available) return unavailable(t.reason);
  return {
    available: true,
    trend: t.trend, value: round(t.value), z: t.z,
    source: 'FRED:WALCL−RRPONTSYD−WTREGEN', label: synthetic.label,
    asOf: t.asOf, stale: synthetic.stale,
    unitsNote: 'Billions USD. WALCL/WTREGEN are reported in millions and are converted; RRP is already billions.',
  };
}

/**
 * Valuation as an equity-risk-premium proxy: earnings yield − 10y yield.
 * `earningsYieldPct` must be supplied by the caller (it is an equity input, not a FRED
 * series). Without it this leg is UNAVAILABLE rather than substituting a constant.
 */
function valuationLeg(seriesById, { earningsYieldPct = null, lookback, tenYear = null }) {
  // Treasury's own 10-year par yield first (same-day, unrevised); FRED DGS10 is the fallback.
  const dgs = tenYear && tenYear.available ? tenYear : seriesById.DGS10;
  if (!dgs || !dgs.available) {
    return unavailable(`10-year yield unavailable (treasury: ${(tenYear && tenYear.reason) || 'not fetched'}; FRED DGS10: ${(seriesById.DGS10 && seriesById.DGS10.reason) || 'not fetched'}) — no risk-free leg for an equity risk premium`);
  }
  const riskFreeSource = dgs.source === 'treasury' ? 'TREASURY:10Y' : 'FRED:DGS10';
  if (!isNum(earningsYieldPct)) {
    return unavailable('no index earnings yield supplied — an equity risk premium cannot be computed, and a constant is NOT substituted');
  }
  const rows = dgs.observations.map(o => ({ date: o.date, value: earningsYieldPct - o.value }));
  if (rows.length < lookback + 1) return unavailable(`only ${rows.length} ${riskFreeSource} observations (need ${lookback + 1})`);
  // NOTE the orientation: ERP up = equities cheaper vs bonds = supportive. The regime
  // stack treats `valuation.trend === 'down'` as expansionary (richer/less attractive is
  // a headwind), so the series is inverted here to keep that reading correct.
  const synthetic = {
    available: true, id: 'ERP_PROXY', label: 'Equity risk premium proxy (earnings yield − 10y)',
    invert: true, observations: rows, latest: rows[rows.length - 1], stale: dgs.stale,
  };
  const t = fred.trendOf(synthetic, { lookback });
  if (!t.available) return unavailable(t.reason);
  return {
    available: true,
    trend: t.trend, value: round(t.value), z: t.z,
    source: `${riskFreeSource} + index earnings yield`, label: synthetic.label,
    asOf: t.asOf, stale: dgs.stale,
    orientationNote: 'Oriented so trend "down" = equities richer vs bonds = a headwind, matching how the regime stack reads the valuation leg.',
  };
}

/**
 * Build the strategic macro inputs. Pure apart from the injected fetcher.
 *
 * Returns `{ inputs, diagnostics }`. `inputs` is null when nothing usable was produced,
 * so the caller passes null through and the strategic layer reports UNAVAILABLE with its
 * own reason — no fabricated legs, ever.
 */
async function buildMacroInputs({ earningsYieldPct = null, lookback = 12, fetchImpl, key, now = Date.now(), fetchCurve = treasury.fetchTreasuryCurve, fetchBls = bls.fetchBlsSeries } = {}) {
  // Keyless reads first: they are the same whether or not FRED is configured. An injected
  // fetchImpl (the test seam) is handed to EVERY provider so no test can reach the network.
  const net = fetchImpl ? { fetchImpl } : {};
  const safe = async (fn, label) => { try { return await fn(); } catch (e) { return unavailable(`${label} threw: ${String((e && e.message) || e).slice(0, 100)}`); } };
  const curve = await safe(() => fetchCurve({ now, ...net }), 'treasury');
  if (!fred.hasKey(key)) {
    return {
      inputs: null,
      diagnostics: {
        version: MACRO_VERSION, available: false,
        reason: `${fred.KEY_ENV} is not set. Add a free key (fredaccount.stlouisfed.org) to enable the strategic regime layer; until then it stays honestly UNAVAILABLE.`,
        legs: {},
        // The curve needs no key, so it is still reported — as a diagnostic, never as a leg.
        curve: curveLeg({ curve, lookback }),
      },
    };
  }

  const ids = [...new Set([...LEG_SERIES.growth, ...LEG_SERIES.inflation, 'WALCL', 'RRPONTSYD', 'WTREGEN', 'DGS10', 'DGS2'])];
  const [fredSeries, cpi] = await Promise.all([
    fred.fetchSeriesSet(ids, { fetchImpl, key, now }),
    safe(() => fetchBls(INFLATION_FALLBACK[0], { now, ...net }), 'bls'),
  ]);
  const seriesById = { ...fredSeries, [INFLATION_FALLBACK[0]]: { ...cpi, id: INFLATION_FALLBACK[0] } };
  const tenYear = treasury.tenYearSeries(curve);

  const legs = {
    growth: legFrom(LEG_SERIES.growth, seriesById, { lookback }),
    inflation: legFrom([...LEG_SERIES.inflation, ...INFLATION_FALLBACK], seriesById, { lookback }),
    liquidity: liquidityLeg(seriesById, { lookback }),
    valuation: valuationLeg(seriesById, { earningsYieldPct, lookback, tenYear }),
  };
  const curveDiag = curveLeg({ curve, seriesById, lookback });

  const usable = Object.entries(legs).filter(([, l]) => l.available);
  const inputs = usable.length
    ? Object.fromEntries(usable.map(([k, l]) => [k, { trend: l.trend, value: l.value, source: l.source }]))
    : null;

  return {
    inputs,
    diagnostics: {
      version: MACRO_VERSION,
      available: usable.length > 0,
      legsAvailable: usable.length,
      legsPossible: Object.keys(legs).length,
      // earningsRevisions is a KNOWN gap, named so it is not mistaken for a failure.
      knownGap: 'earningsRevisions requires an estimates vendor (docs/blocked-on-data.md §4) and is not attempted here.',
      legs,
      curve: curveDiag,
      sources: { tenYear: tenYear.available ? 'treasury' : (seriesById.DGS10 && seriesById.DGS10.available ? 'FRED' : null), curve: curveDiag.available ? curveDiag.source : null },
      stale: usable.filter(([, l]) => l.stale).map(([k]) => k),
      backtestSafe: false,
      vintageNote: 'FRED serves the latest revision — this is a LIVE read only and must not be fed to the research harness without ALFRED vintage data.',
      reason: usable.length ? null : 'no macro leg could be built; see per-leg reasons',
    },
  };
}

module.exports = { MACRO_VERSION, LEG_SERIES, INFLATION_FALLBACK, buildMacroInputs, legFrom, liquidityLeg, valuationLeg, curveLeg };

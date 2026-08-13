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

const MACRO_VERSION = 'pulse2-macro-v1';

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
    if (!chosen) chosen = t;
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
    corroboration: attempts.filter(a => a.ok && a.id !== chosen.source.split(':')[1]),
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
function valuationLeg(seriesById, { earningsYieldPct = null, lookback }) {
  const dgs = seriesById.DGS10;
  if (!dgs || !dgs.available) return unavailable(`DGS10 unavailable (${(dgs && dgs.reason) || 'not fetched'}) — no risk-free leg for an equity risk premium`);
  if (!isNum(earningsYieldPct)) {
    return unavailable('no index earnings yield supplied — an equity risk premium cannot be computed, and a constant is NOT substituted');
  }
  const rows = dgs.observations.map(o => ({ date: o.date, value: earningsYieldPct - o.value }));
  if (rows.length < lookback + 1) return unavailable(`only ${rows.length} DGS10 observations (need ${lookback + 1})`);
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
    source: 'FRED:DGS10 + index earnings yield', label: synthetic.label,
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
async function buildMacroInputs({ earningsYieldPct = null, lookback = 12, fetchImpl, key, now = Date.now() } = {}) {
  if (!fred.hasKey(key)) {
    return {
      inputs: null,
      diagnostics: {
        version: MACRO_VERSION, available: false,
        reason: `${fred.KEY_ENV} is not set. Add a free key (fredaccount.stlouisfed.org) to enable the strategic regime layer; until then it stays honestly UNAVAILABLE.`,
        legs: {},
      },
    };
  }

  const ids = [...new Set([...LEG_SERIES.growth, ...LEG_SERIES.inflation, 'WALCL', 'RRPONTSYD', 'WTREGEN', 'DGS10'])];
  const seriesById = await fred.fetchSeriesSet(ids, { fetchImpl, key, now });

  const legs = {
    growth: legFrom(LEG_SERIES.growth, seriesById, { lookback }),
    inflation: legFrom(LEG_SERIES.inflation, seriesById, { lookback }),
    liquidity: liquidityLeg(seriesById, { lookback }),
    valuation: valuationLeg(seriesById, { earningsYieldPct, lookback }),
  };

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
      stale: usable.filter(([, l]) => l.stale).map(([k]) => k),
      backtestSafe: false,
      vintageNote: 'FRED serves the latest revision — this is a LIVE read only and must not be fed to the research harness without ALFRED vintage data.',
      reason: usable.length ? null : 'no macro leg could be built; see per-leg reasons',
    },
  };
}

module.exports = { MACRO_VERSION, LEG_SERIES, buildMacroInputs, legFrom, liquidityLeg, valuationLeg };

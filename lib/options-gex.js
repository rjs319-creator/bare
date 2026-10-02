'use strict';
// DEALER GAMMA EXPOSURE (GEX) / GAMMA-FLIP / MAX-PAIN — pure overlay math.
//
// Per strike:  GEX = Γ × OI × 100 × S² × 0.01   (the dollar gamma dealers re-hedge per 1% move)
// Sign:        calls +, puts −  under the "dealers are long the calls customers sold and
//              short the puts customers bought" convention. That is an ASSUMPTION recorded
//              with the output (`signConvention`), not data — it is wrong for some names and
//              periods, which the registry's negative control exists to catch.
// Gamma-flip:  the spot level where the chain's net GEX changes sign. Computed by re-pricing
//              every contract's Black-Scholes gamma (from its quoted IV) over a grid of
//              hypothetical spot levels and interpolating the zero crossing nearest to spot.
// Max-pain:    the strike at which option holders' aggregate intrinsic payout is smallest,
//              on the NEAREST expiry (the conventional expiry-pinning read).
//
// FULL-CHAIN RULE. Every figure here needs every listed strike with its open interest — the
// same rule `strikeConcentration` enforces. A result whose `chainComplete` flag is false
// (a Yahoo nearest-expiry view, a truncated fetch) yields `available:false` with a reason.
// Weight 0 everywhere: this is a regime READ for the intraday lane, never a score input.
//
// Formula re-derived from first principles (the public GEX repos surveyed are unlicensed).
// Pure; no I/O; the clock is injected.

const { greeksFromQuotedIV, usableIv, dteFromExpiration, DEFAULT_RATE } = require('./options-greeks');

const GEX_VERSION = 'options-gex-v1';
const CONTRACT_MULTIPLIER = 100;
const PCT_MOVE = 0.01;
const STRIKE_BAND = 0.33;            // strikes within ±33% of spot (far wings carry junk IV, ~0 gamma)
const PROFILE_HALF_WIDTH = 0.15;     // flip search window: spot × (1 ± 15%)
const PROFILE_STEPS = 60;            // 0.5% spot increments across the window
const PERSIST_BAND = 0.10;           // per-strike rows persisted: within ±10% of spot …
const PERSIST_MAX_ROWS = 80;         // … and at most this many (largest |netGex| first)
const SIGN_CONVENTION = 'calls + / puts −: dealers assumed long the calls customers sold and short the puts customers bought (net = Σcall − Σput). An assumption, not data.';
const FLIP_METHOD = 'net GEX re-priced at hypothetical spot levels (Black-Scholes gamma from each contract\'s quoted IV); zero crossing nearest spot, linearly interpolated';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (n, d = 2) => (isNum(n) ? +n.toFixed(d) : null);
const unavailable = (reason) => ({ available: false, version: GEX_VERSION, reason: String(reason) });

/** Dollar gamma for one contract line. Pure. */
function contractGex({ gamma, openInterest, spot }) {
  if (!isNum(gamma) || !isNum(openInterest) || !isNum(spot) || openInterest <= 0 || spot <= 0) return 0;
  return gamma * openInterest * CONTRACT_MULTIPLIER * spot * spot * PCT_MOVE;
}

// Flatten a normalized chain result ({ options: [{ expirationDate, calls, puts }] }) into
// contract rows within the strike band. Each row keeps its vendor gamma (if any) and IV.
function flattenChain(result, { nowMs, spot } = {}) {
  const rows = [];
  for (const chain of (result && result.options) || []) {
    if (!chain) continue;
    for (const [side, list] of [['call', chain.calls || []], ['put', chain.puts || []]]) {
      for (const c of list) {
        if (!c || !isNum(c.strike) || c.strike <= 0) continue;
        if (isNum(spot) && Math.abs(c.strike - spot) / spot > STRIKE_BAND) continue;
        const expiration = isNum(c.expiration) ? c.expiration : chain.expirationDate;
        const dte = dteFromExpiration(expiration, nowMs);
        // A contract whose settlement has passed is worthless whatever gamma the vendor
        // still prints for it (chains list the day's expiry until the next morning).
        if (!(dte > 0)) continue;
        rows.push({
          side, strike: c.strike, expiration, dte,
          openInterest: isNum(c.openInterest) && c.openInterest > 0 ? c.openInterest : 0,
          iv: isNum(c.impliedVolatility) ? c.impliedVolatility : null,
          gamma: isNum(c.gamma) ? c.gamma : null,
        });
      }
    }
  }
  return rows;
}

// Gamma for a row at an arbitrary spot level: vendor gamma only applies at the quoted spot,
// so any re-pricing uses the model. Returns null when neither route is possible.
function gammaAt(row, level, { r, useVendor }) {
  if (useVendor && isNum(row.gamma)) return { gamma: row.gamma, source: 'vendor' };
  if (!usableIv(row.iv) || !(row.dte > 0)) return null;
  const g = greeksFromQuotedIV({ spot: level, strike: row.strike, dte: row.dte, r, iv: row.iv, type: row.side });
  return g ? { gamma: g.gamma, source: 'model' } : null;
}

/** Per-strike GEX at the current spot (vendor gamma where supplied, model otherwise). Pure. */
function perStrikeGex(rows, { spot, r = DEFAULT_RATE } = {}) {
  const byStrike = new Map();
  const sources = { vendor: 0, model: 0, skipped: 0 };
  for (const row of rows || []) {
    if (!(row.openInterest > 0)) continue;
    const g = gammaAt(row, spot, { r, useVendor: true });
    if (!g) { sources.skipped++; continue; }
    sources[g.source]++;
    const gex = contractGex({ gamma: g.gamma, openInterest: row.openInterest, spot });
    const cur = byStrike.get(row.strike) || { strike: row.strike, callOI: 0, putOI: 0, callGex: 0, putGex: 0, netGex: 0 };
    const next = row.side === 'call'
      ? { ...cur, callOI: cur.callOI + row.openInterest, callGex: cur.callGex + gex, netGex: cur.netGex + gex }
      : { ...cur, putOI: cur.putOI + row.openInterest, putGex: cur.putGex + gex, netGex: cur.netGex - gex };
    byStrike.set(row.strike, next);
  }
  const strikes = [...byStrike.values()].sort((a, b) => a.strike - b.strike);
  return { strikes, sources };
}

/** Net GEX re-priced over a grid of hypothetical spot levels (model gamma only). Pure. */
function gexProfile(rows, { spot, r = DEFAULT_RATE, halfWidth = PROFILE_HALF_WIDTH, steps = PROFILE_STEPS } = {}) {
  const usable = (rows || []).filter((row) => row.openInterest > 0 && usableIv(row.iv) && row.dte > 0);
  if (!usable.length || !isNum(spot) || spot <= 0) return [];
  const profile = [];
  for (let i = 0; i <= steps; i++) {
    const level = spot * (1 - halfWidth + (2 * halfWidth * i) / steps);
    let net = 0;
    for (const row of usable) {
      const g = gammaAt(row, level, { r, useVendor: false });
      if (!g) continue;
      const gex = contractGex({ gamma: g.gamma, openInterest: row.openInterest, spot: level });
      net += row.side === 'call' ? gex : -gex;
    }
    profile.push({ level, netGex: net });
  }
  return profile;
}

/** The zero crossing of a profile nearest to spot, linearly interpolated. Pure. */
function gammaFlip(profile, spot) {
  let best = null;
  for (let i = 1; i < (profile || []).length; i++) {
    const a = profile[i - 1], b = profile[i];
    if (!(a.netGex === 0 || Math.sign(a.netGex) !== Math.sign(b.netGex))) continue;
    const span = b.netGex - a.netGex;
    const level = span === 0 ? a.level : a.level + (b.level - a.level) * (-a.netGex / span);
    if (!best || Math.abs(level - spot) < Math.abs(best.level - spot)) best = { level, method: FLIP_METHOD };
  }
  return best;
}

/** Max-pain strike for one expiry's rows: minimizes holders' aggregate intrinsic payout. Pure. */
function maxPain(rows) {
  const withOI = (rows || []).filter((row) => row.openInterest > 0);
  const strikes = [...new Set(withOI.map((row) => row.strike))].sort((a, b) => a - b);
  if (!strikes.length) return null;
  let best = null;
  for (const S of strikes) {
    let payout = 0;
    for (const row of withOI) {
      const intrinsic = row.side === 'call' ? Math.max(0, S - row.strike) : Math.max(0, row.strike - S);
      payout += intrinsic * row.openInterest * CONTRACT_MULTIPLIER;
    }
    if (!best || payout < best.payout) best = { strike: S, payout };
  }
  return best;
}

/** Signed distance of spot from the flip, in % of the flip level (positive = spot ABOVE flip). */
function gammaFlipDistancePct(spot, flip) {
  if (!isNum(spot) || !isNum(flip) || flip <= 0) return null;
  return round(((spot - flip) / flip) * 100, 2);
}

// Deterministic PRNG (mulberry32) so the negative control is reproducible from its seed.
function seededRandom(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * NEGATIVE CONTROL: permute open interest across contracts of the same side (Fisher-Yates,
 * seeded). Strikes, IVs and expiries keep their places; only WHO holds the OI moves, so the
 * control flip carries the chain's size and skew but none of its positioning. Immutable.
 */
function shuffleOpenInterest(rows, seed = 1) {
  const rand = seededRandom(seed);
  const out = (rows || []).map((row) => ({ ...row }));
  for (const side of ['call', 'put']) {
    const idx = out.map((row, i) => (row.side === side ? i : -1)).filter((i) => i >= 0);
    const ois = idx.map((i) => out[i].openInterest);
    for (let i = ois.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [ois[i], ois[j]] = [ois[j], ois[i]];
    }
    idx.forEach((i, k) => { out[i] = { ...out[i], openInterest: ois[k] }; });
  }
  return out;
}

function nearestExpiryRows(rows) {
  const exps = rows.filter((row) => isNum(row.expiration) && row.openInterest > 0).map((row) => row.expiration);
  if (!exps.length) return { expiration: null, rows: [] };
  const nearest = Math.min(...exps);
  return { expiration: nearest, rows: rows.filter((row) => row.expiration === nearest) };
}

function persistedStrikes(strikes, spot) {
  return strikes
    .filter((s) => Math.abs(s.strike - spot) / spot <= PERSIST_BAND)
    .sort((a, b) => Math.abs(b.netGex) - Math.abs(a.netGex))
    .slice(0, PERSIST_MAX_ROWS)
    .sort((a, b) => a.strike - b.strike)
    .map((s) => ({ strike: s.strike, callOI: s.callOI, putOI: s.putOI, callGex: Math.round(s.callGex), putGex: Math.round(s.putGex), netGex: Math.round(s.netGex) }));
}

/**
 * Full GEX read for one normalized FULL chain result. Pure.
 * @param {{result:object, nowMs:number, r?:number, seed?:number}} p
 *   result — provider chain result with `chainComplete:true`, `quote.regularMarketPrice`, `options[]`
 * @returns {object} available:false + reason, or the overlay record
 */
function computeGex({ result, nowMs, r = DEFAULT_RATE, seed = 1 } = {}) {
  if (!result || !Array.isArray(result.options) || !result.options.length) return unavailable('no chain result');
  if (result.chainComplete !== true) return unavailable('chain incomplete: GEX needs every listed expiry and strike with open interest, not a nearest-expiry or truncated view');
  const spot = result.quote && result.quote.regularMarketPrice;
  if (!isNum(spot) || spot <= 0) return unavailable('no underlying price on the chain result');
  if (!isNum(nowMs)) return unavailable('nowMs is required to derive days-to-expiry');

  const rows = flattenChain(result, { nowMs, spot });
  const { strikes, sources } = perStrikeGex(rows, { spot, r });
  if (!strikes.length) return unavailable('no contracts with open interest and a usable gamma or IV inside the strike band');

  const total = (f) => strikes.reduce((s, x) => s + x[f], 0);
  const profile = gexProfile(rows, { spot, r });
  const flip = gammaFlip(profile, spot);
  const nearest = nearestExpiryRows(rows);
  const pain = maxPain(nearest.rows);
  const gammaSource = sources.vendor && sources.model ? 'mixed' : sources.vendor ? 'vendor' : 'model';
  // Regime label = sign of net dealer gamma AT spot. Equals above/below-flip whenever a flip
  // exists, and still labels the (common) case where the profile never crosses zero.
  const regimeOf = (p) => { const at = p.find((x) => Math.abs(x.level - spot) < 1e-9) || p[Math.floor(p.length / 2)]; return at ? (at.netGex >= 0 ? 'positive-gamma' : 'negative-gamma') : null; };
  const shuffledProfile = gexProfile(shuffleOpenInterest(rows, seed), { spot, r });
  const control = gammaFlip(shuffledProfile, spot);

  return {
    available: true,
    version: GEX_VERSION,
    ticker: result.underlyingSymbol || (result.quote && result.quote.symbol) || null,
    spot: round(spot, 2),
    asOf: new Date(nowMs).toISOString(),
    source: result.source || null,
    netGex: Math.round(total('netGex')),
    callGex: Math.round(total('callGex')),
    putGex: Math.round(total('putGex')),
    gammaFlip: flip ? round(flip.level, 2) : null,
    gammaFlipDistancePct: flip ? gammaFlipDistancePct(spot, flip.level) : null,
    regime: total('netGex') >= 0 ? 'positive-gamma' : 'negative-gamma',
    flipMethod: FLIP_METHOD,
    maxPainNearestExpiry: pain ? { expiry: new Date(nearest.expiration * 1000).toISOString().slice(0, 10), strike: pain.strike } : null,
    perStrike: persistedStrikes(strikes, spot),
    contracts: { used: sources.vendor + sources.model, skipped: sources.skipped, strikes: strikes.length, expiries: result.options.length },
    gammaSource,
    rate: r,
    control: {
      shuffledFlip: control ? round(control.level, 2) : null,
      shuffledFlipDistancePct: control ? gammaFlipDistancePct(spot, control.level) : null,
      shuffledRegime: regimeOf(shuffledProfile),
      seed, method: 'open interest permuted across same-side contracts, then the same flip + regime procedure',
    },
    signConvention: SIGN_CONVENTION,
    weight: 0,
    note: 'Regime read only (weight 0). Dealer positioning is inferred under a sign convention, from 15-min delayed open interest; it is not a forecast.',
  };
}

module.exports = {
  GEX_VERSION, CONTRACT_MULTIPLIER, PCT_MOVE, STRIKE_BAND, PROFILE_HALF_WIDTH, PROFILE_STEPS, SIGN_CONVENTION,
  contractGex, flattenChain, perStrikeGex, gexProfile, gammaFlip, maxPain, gammaFlipDistancePct,
  shuffleOpenInterest, computeGex,
};

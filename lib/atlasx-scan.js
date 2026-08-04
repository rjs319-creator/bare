'use strict';
// ATLAS-X TWO-PASS UNIVERSE (premove-universe-v2) — Phase 4 of the pre-move
// redesign (docs/premove-transition-v2.md).
//
// PASS A — cheap full-universe feature scan. For EVERY cached liquid name,
// compute inexpensive point-in-time features from daily candles, with HARD
// fail-closed eligibility (unknown inputs are ineligible, never assumed fine).
//
// PASS B — specialist-balanced shortlist. Bounded per-specialist shortlists
// (compression-transition, absorption, residual-inflection, first-pullback,
// sector-diffusion, catalyst-transition, near-threshold, open episodes,
// deterministic controls) with per-specialist AND per-liquidity-band caps so
// momentum can no longer consume the whole deep-analysis budget. Deduplication
// happens AFTER selection and preserves every selection reason.
//
// The funnel DISCLOSES: full pool size, eligible/ineligible-by-reason counts,
// per-specialist candidate counts, duplicates merged, cap truncation, missing/
// stale scopes, control coverage, and whether the scan is complete or partial.
//
// Pure: pool stats + candles in, shortlist out. Deterministic (hash-ordered
// controls, no Math.random, no clock).

const SCAN_VERSION = 'premove-universe-v2';

const ELIGIBILITY = Object.freeze({
  minBars: 60,                 // enough history for every cheap feature
  minPrice: 1,                 // sub-$1 names are untradeable for this book
  minDollarVol: 2e6,           // observed liquidity floor (matches the app's research floor)
  maxStaleSessions: 3,         // last bar must be recent vs the scan's own newest bar
  maxAbsDailyReturn: 0.75,     // |return| beyond this in the recent window = unresolved bad-bar/corp-action anomaly
});

// Per-specialist caps. Momentum is ONE bounded specialist among many.
const SPECIALIST_CAPS = Object.freeze({
  momentum: 30,
  compression: 30,
  absorption: 25,
  residualInflection: 25,
  firstPullback: 20,
  sectorDiffusion: 20,
  catalyst: 20,
  nearThreshold: 20,
  controls: 20,
});
// Within one specialist, at most this share may come from a single liquidity band.
const BAND_SHARE_CAP = 0.6;

const num = (v) => (Number.isFinite(v) ? v : null);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ── PASS A: cheap features for one name ──────────────────────────────────────
// bars: [{date,o,h,l,c,v}] (atlasx-residual toBars shape). All features use only
// the bars given (the caller passes decision-time slices).
function cheapFeatures(bars) {
  const n = bars.length;
  if (n < ELIGIBILITY.minBars) return null;
  const last = bars[n - 1];
  const c = (i) => bars[i].c;
  const ret = (k) => (n > k && c(n - 1 - k) > 0 ? c(n - 1) / c(n - 1 - k) - 1 : null);

  // range tightness + ATR compression (10 vs 50)
  const hi20 = Math.max(...bars.slice(-20).map(b => b.h));
  const lo20 = Math.min(...bars.slice(-20).map(b => b.l));
  const rangeTight = last.c > 0 ? (hi20 - lo20) / last.c : null;
  const atr = (k) => {
    const seg = bars.slice(-k);
    let s = 0, m = 0;
    for (let i = 1; i < seg.length; i++) {
      const tr = Math.max(seg[i].h - seg[i].l, Math.abs(seg[i].h - seg[i - 1].c), Math.abs(seg[i].l - seg[i - 1].c));
      if (Number.isFinite(tr)) { s += tr; m++; }
    }
    return m ? s / m : null;
  };
  const atr10 = atr(11), atr50 = atr(51);
  const atrRatio = atr10 != null && atr50 > 0 ? atr10 / atr50 : null;

  // turnover: 20d vs 50d volume + acceleration
  const vmean = (k) => {
    const seg = bars.slice(-k);
    const vs = seg.map(b => b.v).filter(Number.isFinite);
    return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
  };
  const v20 = vmean(20), v50 = vmean(50);
  const vdu = v20 != null && v50 > 0 ? v20 / v50 : null;
  const v5 = vmean(5);
  const turnoverAccel = v5 != null && v20 > 0 ? v5 / v20 : null;

  // close-location + wick asymmetry (absorption proxies) over the last 10 bars
  let clocSum = 0, clocN = 0, upWick = 0, dnWick = 0;
  for (const b of bars.slice(-10)) {
    const range = b.h - b.l;
    if (range > 0) {
      clocSum += (b.c - b.l) / range; clocN++;
      upWick += (b.h - Math.max(b.o, b.c)) / range;
      dnWick += (Math.min(b.o, b.c) - b.l) / range;
    }
  }
  const closeLoc10 = clocN ? clocSum / clocN : null;
  const wickAsym = clocN ? (dnWick - upWick) / clocN : null;   // >0: lower wicks dominate (dip-buying)

  // down-impact: |return| per unit of relative volume on down days (declining = absorption)
  const impact = (seg) => {
    let s = 0, m = 0;
    for (let i = 1; i < seg.length; i++) {
      const r = seg[i - 1].c > 0 ? seg[i].c / seg[i - 1].c - 1 : null;
      if (r == null || r >= 0 || !(v50 > 0)) continue;
      s += Math.abs(r) / Math.max(0.2, seg[i].v / v50); m++;
    }
    return m ? s / m : null;
  };
  const downImpactRecent = impact(bars.slice(-11));
  const downImpactPrior = impact(bars.slice(-31, -10));
  const absorptionTrend = downImpactRecent != null && downImpactPrior > 0 ? 1 - downImpactRecent / downImpactPrior : null;

  // higher-low persistence + pullback depth (first-pullback structure)
  const lows5 = [];
  for (let k = 4; k >= 0; k--) {
    const seg = bars.slice(n - (k + 1) * 4, n - k * 4);
    if (seg.length) lows5.push(Math.min(...seg.map(b => b.l)));
  }
  let hlUp = 0;
  for (let i = 1; i < lows5.length; i++) if (lows5[i] >= lows5[i - 1]) hlUp++;
  const higherLowFrac = lows5.length > 1 ? hlUp / (lows5.length - 1) : null;
  const pullbackDepth = hi20 > 0 ? (hi20 - last.c) / hi20 : null;

  return {
    price: num(last.c), lastDate: last.date,
    ret5: ret(5), ret20: ret(20), ret63: ret(63),
    rangeTight: num(rangeTight), atrRatio: num(atrRatio),
    vdu: num(vdu), turnoverAccel: num(turnoverAccel),
    closeLoc10: num(closeLoc10), wickAsym: num(wickAsym),
    absorptionTrend: num(absorptionTrend),
    higherLowFrac: num(higherLowFrac), pullbackDepth: num(pullbackDepth),
    distToHi20: last.c > 0 ? (hi20 - last.c) / last.c : null,
  };
}

// Hard eligibility for one pool entry. UNKNOWN inputs fail closed with a reason.
function eligibilityOf(stats, feats, newestDate) {
  if (!feats) return { eligible: false, reason: 'insufficient-history' };
  if (feats.price == null) return { eligible: false, reason: 'unknown-price' };
  if (feats.price < ELIGIBILITY.minPrice) return { eligible: false, reason: 'below-min-price' };
  if (stats.dollarVol == null) return { eligible: false, reason: 'unknown-liquidity' };
  if (stats.dollarVol < ELIGIBILITY.minDollarVol) return { eligible: false, reason: 'below-liquidity-floor' };
  if (!feats.lastDate) return { eligible: false, reason: 'unknown-bar-date' };
  if (newestDate && feats.lastDate < newestDate) {
    // staleness measured against the scan's own newest bar, in actual TRADING
    // SESSIONS (the limit is session-denominated; the old calendar-days-plus-2
    // fudge under-counted around weekends/holidays).
    const { calendarSessionsBetween } = require('./swing-sessions');
    const gapSessions = calendarSessionsBetween(feats.lastDate, newestDate);
    if (!(Number.isFinite(gapSessions) && gapSessions <= ELIGIBILITY.maxStaleSessions)) return { eligible: false, reason: 'stale-bars' };
  }
  if (feats.badBar) return { eligible: false, reason: 'bad-bar-anomaly' };
  return { eligible: true, reason: null };
}

// bad-bar / corporate-action anomaly: any recent |daily return| beyond the cap.
function hasBadBar(bars) {
  const seg = bars.slice(-21);
  for (let i = 1; i < seg.length; i++) {
    if (!(seg[i - 1].c > 0)) return true;
    const r = seg[i].c / seg[i - 1].c - 1;
    if (!Number.isFinite(r) || Math.abs(r) > ELIGIBILITY.maxAbsDailyReturn) return true;
  }
  return false;
}

// Deterministic string hash (fnv-1a) for control ordering — stable across runs.
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

// Apply per-liquidity-band share cap inside one specialist's ranked list.
function bandCapped(rankedTickers, capGroupOf, cap) {
  const maxPerBand = Math.max(1, Math.ceil(cap * BAND_SHARE_CAP));
  const perBand = {};
  const kept = [];
  const overflow = [];
  for (const t of rankedTickers) {
    if (kept.length >= cap) { overflow.push(t); continue; }
    const band = capGroupOf(t) || 'unknown';
    perBand[band] = perBand[band] || 0;
    if (perBand[band] >= maxPerBand) { overflow.push(t); continue; }
    perBand[band]++;
    kept.push(t);
  }
  return { kept, overflow };
}

// ── The two-pass scan ────────────────────────────────────────────────────────
//   pool:        { ticker → poolStats } from atlasx-universe (price/dollarVol/mom20/capGroup)
//   barsOf:      (ticker) → toBars() array (decision-time candles)
//   currentMeta: op=today swing rows (with event/sector when carried)
//   episodeTickers: open prior episodes (always kept)
//   benchRet:    { ret5, ret20 } of SPY over the same window (null → residuals unavailable, labeled)
function runTwoPassScan({ pool = {}, barsOf, currentMeta = [], episodeTickers = [], benchRet = null, caps = SPECIALIST_CAPS } = {}) {
  // ── PASS A ─────────────────────────────────────────────────────────────────
  const features = {};
  const ineligible = {};
  const eligible = [];
  let newestDate = null;
  const prelim = [];
  for (const t of Object.keys(pool)) {
    const bars = typeof barsOf === 'function' ? barsOf(t) : null;
    const feats = bars ? cheapFeatures(bars) : null;
    if (feats && bars) feats.badBar = hasBadBar(bars);
    prelim.push({ t, feats });
    if (feats && feats.lastDate && (!newestDate || feats.lastDate > newestDate)) newestDate = feats.lastDate;
  }
  for (const { t, feats } of prelim) {
    const verdict = eligibilityOf(pool[t], feats, newestDate);
    if (!verdict.eligible) { ineligible[verdict.reason] = (ineligible[verdict.reason] || 0) + 1; continue; }
    features[t] = feats;
    eligible.push(t);
  }

  const capGroupOf = (t) => (pool[t] ? pool[t].capGroup : 'unknown');
  const F = (t) => features[t];

  // residuals: beta-1 market residual from the benchmark window return, labeled.
  const residualized = !!(benchRet && Number.isFinite(benchRet.ret20));
  const resid20 = (t) => (residualized && F(t).ret20 != null ? F(t).ret20 - benchRet.ret20 : F(t).ret20);
  const resid5 = (t) => (residualized && benchRet && Number.isFinite(benchRet.ret5) && F(t).ret5 != null ? F(t).ret5 - benchRet.ret5 : F(t).ret5);

  // ── PASS B: specialist rankings (each a deterministic sort over `eligible`) ─
  const rank = (scoreFn) => eligible
    .map(t => ({ t, s: scoreFn(t) }))
    .filter(x => x.s != null)
    .sort((a, b) => b.s - a.s || (a.t < b.t ? -1 : 1))
    .map(x => x.t);

  const rankings = {
    momentum: rank(t => resid20(t)),
    compression: rank(t => {
      const f = F(t);
      if (f.rangeTight == null || f.atrRatio == null) return null;
      // tight range + contracting ATR + dried volume + early expansion of turnover
      return (1 - clamp01(f.rangeTight / 0.3)) + (1 - clamp01(f.atrRatio)) + (f.vdu != null ? 1 - clamp01(f.vdu) : 0) + (f.turnoverAccel != null ? clamp01(f.turnoverAccel - 1) : 0);
    }),
    absorption: rank(t => {
      const f = F(t);
      if (f.absorptionTrend == null && f.wickAsym == null) return null;
      return (f.absorptionTrend != null ? clamp01(f.absorptionTrend) : 0) + (f.wickAsym != null ? clamp01(f.wickAsym * 3) : 0) + (f.closeLoc10 != null ? clamp01(f.closeLoc10) : 0);
    }),
    residualInflection: rank(t => {
      const f = F(t);
      const r5 = resid5(t), r20 = resid20(t);
      if (r5 == null || r20 == null || f.turnoverAccel == null) return null;
      // fresh positive short-horizon residual out of a flat base, turnover-confirmed
      if (!(r5 > 0 && r20 <= 0.05)) return null;
      return r5 * clamp01(f.turnoverAccel - 0.9);
    }),
    firstPullback: rank(t => {
      const f = F(t);
      if (f.ret63 == null || f.pullbackDepth == null || f.higherLowFrac == null) return null;
      if (!(f.ret63 > 0.15 && f.pullbackDepth >= 0.03 && f.pullbackDepth <= 0.12)) return null;
      return f.ret63 * f.higherLowFrac * (1 - clamp01(Math.abs(f.pullbackDepth - 0.06) / 0.06));
    }),
  };

  // sector-diffusion: breadth of positive residual momentum per sector (from the
  // pool's own sectors when known); top names inside the top-breadth sectors.
  const sectorOf = (t) => (pool[t] && pool[t].sector) || null;
  const bySector = {};
  for (const t of eligible) {
    const s = sectorOf(t);
    if (!s) continue;
    (bySector[s] = bySector[s] || []).push(t);
  }
  const sectorBreadth = Object.entries(bySector)
    .filter(([, ts]) => ts.length >= 5)
    .map(([s, ts]) => ({ sector: s, n: ts.length, breadth: ts.filter(t => (resid20(t) ?? -1) > 0).length / ts.length }))
    .sort((a, b) => b.breadth - a.breadth || (a.sector < b.sector ? -1 : 1));
  const topSectors = new Set(sectorBreadth.slice(0, 2).map(x => x.sector));
  rankings.sectorDiffusion = rank(t => (topSectors.has(sectorOf(t)) ? (resid20(t) ?? null) : null));

  // catalyst-transition: ONLY names carrying a structured, timestamped catalyst
  // (from op=today's event metadata). Never inferred from a text label — when no
  // structured catalyst exists this specialist is honestly empty.
  const catalystByTicker = new Map();
  for (const c of currentMeta) {
    if (c && c.ticker && c.event && (c.event.when || c.event.inDays != null)) catalystByTicker.set(c.ticker, c.event);
  }
  rankings.catalyst = eligible.filter(t => catalystByTicker.has(t))
    .sort((a, b) => (a < b ? -1 : 1));

  // ── selection with caps + near-threshold + controls ────────────────────────
  const reasons = new Map();               // ticker → [reason...]
  const addReason = (t, r) => {
    if (!reasons.has(t)) reasons.set(t, []);
    if (!reasons.get(t).includes(r)) reasons.get(t).push(r);
  };
  const perSpecialist = {};
  let duplicatesMerged = 0;
  let capTruncated = 0;

  for (const [name, ranked] of Object.entries(rankings)) {
    const cap = caps[name] ?? 20;
    const { kept, overflow } = bandCapped(ranked, capGroupOf, cap);
    perSpecialist[name] = { candidates: ranked.length, kept: kept.length, truncated: Math.max(0, ranked.length - kept.length) };
    capTruncated += Math.max(0, ranked.length - kept.length);
    for (const t of kept) { if (reasons.has(t)) duplicatesMerged++; addReason(t, name); }
    // near-threshold: the first names past this specialist's cap — the
    // counterfactual band the learning loop needs.
    for (const t of overflow.slice(0, Math.ceil((caps.nearThreshold ?? 20) / Object.keys(rankings).length))) {
      addReason(t, `near-threshold:${name}`);
    }
  }

  // open episodes are always retained (anti-disappearance invariant).
  for (const t of episodeTickers) if (t) addReason(t, 'open-episode');
  // current op=today candidates always retained (the live board must be assessable).
  for (const c of currentMeta) if (c && c.ticker) addReason(c.ticker, 'current-today');

  // deterministic controls: hash-ordered eligible names not otherwise selected,
  // stratified across liquidity bands.
  const unselected = eligible.filter(t => !reasons.has(t));
  const controlsByBand = {};
  for (const t of unselected) (controlsByBand[capGroupOf(t)] = controlsByBand[capGroupOf(t)] || []).push(t);
  const controlCap = caps.controls ?? 20;
  const bands = Object.keys(controlsByBand).sort();
  const controls = [];
  let bi = 0;
  while (controls.length < controlCap && bands.some(b => controlsByBand[b].length)) {
    const b = bands[bi % bands.length]; bi++;
    const list = controlsByBand[b];
    if (!list || !list.length) continue;
    list.sort((a, x) => hash32(a) - hash32(x) || (a < x ? -1 : 1));
    controls.push(list.shift());
  }
  for (const t of controls) addReason(t, 'control');

  const shortlist = [...reasons.keys()];
  const funnel = Object.freeze({
    version: SCAN_VERSION,
    fullPool: Object.keys(pool).length,
    eligible: eligible.length,
    ineligibleByReason: Object.freeze(ineligible),
    perSpecialist: Object.freeze(perSpecialist),
    duplicatesMerged,
    capTruncated,
    controlCoverage: controls.length,
    residualized,
    residualNote: residualized ? 'market residual (beta 1) vs the benchmark window return' : 'NO benchmark supplied — momentum ranks are RAW returns, labeled unresidualized',
    complete: Object.keys(pool).length > 0 && Object.keys(ineligible).length >= 0,
  });

  return {
    version: SCAN_VERSION,
    eligible,
    features,
    shortlist,
    selectionReasons: Object.fromEntries(reasons),
    sectorBreadth,
    funnel,
  };
}

module.exports = {
  SCAN_VERSION, ELIGIBILITY, SPECIALIST_CAPS, BAND_SHARE_CAP,
  cheapFeatures, eligibilityOf, hasBadBar, runTwoPassScan, bandCapped, hash32,
};

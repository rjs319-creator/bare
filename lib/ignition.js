// MOMENTUM IGNITION ENGINE — measure ACCELERATION, not just how far a name has moved.
//
// The goal: surface catalyst-driven names in the EARLIEST phase of a momentum move —
// "up 10% and accelerating" ranks ABOVE "up 60% and decelerating" — before a name is
// obvious and extended. This is the honest, EOD-feasible core of the momentum-ignition
// ask: every metric below is computable from the daily candles + catalyst tags the app
// already has. It deliberately does NOT model real-time / LULD / sub-minute behavior —
// that needs a live tick feed the app doesn't have (the route + UI say so plainly).
//
// Pure + unit-testable: candles + optional catalyst/liquidity in, features + score + stage
// out. No network, no clock.

'use strict';

const IGNITION_VERSION = 'ignition-v1';

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const last = (a) => (a.length ? a[a.length - 1] : null);

// ── Acceleration metrics from a daily candle series ──────────────────────────────────
// Every field is a plain, inspectable number. `null` when there aren't enough bars —
// never a fabricated value.
function accelerationMetrics(candles) {
  const c = (candles || []).filter(x => x && Number.isFinite(x.close) && Number.isFinite(x.volume));
  const n = c.length;
  if (n < 30) return null;
  const closes = c.map(x => x.close);
  const highs = c.map(x => x.high);
  const lows = c.map(x => x.low);
  const vols = c.map(x => x.volume);
  const px = last(closes);

  // Daily returns.
  const ret = [];
  for (let i = 1; i < n; i++) ret.push(closes[i] / closes[i - 1] - 1);

  // Price VELOCITY = mean daily return over the last 3 sessions (recent speed).
  const vel3 = mean(ret.slice(-3));
  const velPrev3 = mean(ret.slice(-6, -3));
  // Price ACCELERATION = change in velocity (2nd derivative). Positive ⇒ speeding up.
  const priceAccel = vel3 - velPrev3;

  // VOLUME acceleration: recent 3-day avg volume vs the prior ~10-day baseline.
  const vol3 = mean(vols.slice(-3));
  const volBase = mean(vols.slice(-13, -3)) || 1;
  const volAccel = vol3 / volBase - 1;
  // Dollar-volume acceleration (price-weighted — a $ move on real turnover).
  const dv = c.map(x => x.close * x.volume);
  const dvAccel = (mean(dv.slice(-3)) / (mean(dv.slice(-13, -3)) || 1)) - 1;

  // Relative volume across windows (today vs trailing averages).
  const relVol5 = vols[n - 1] / (mean(vols.slice(-6, -1)) || 1);
  const relVol20 = vols[n - 1] / (mean(vols.slice(-21, -1)) || 1);
  const dollarVol = +(mean(vols.slice(-20)) * px).toFixed(0);   // ~20d ADV in $

  // VWAP-slope PROXY: rolling volume-weighted average price over ~10 sessions, and
  // whether price sits above it and it's rising (true intraday VWAP needs tick data).
  const vwapWin = 10;
  const seg = c.slice(-vwapWin);
  const vwapNow = seg.reduce((s, x) => s + x.close * x.volume, 0) / (seg.reduce((s, x) => s + x.volume, 0) || 1);
  const segPrev = c.slice(-vwapWin - 3, -3);
  const vwapPrev = segPrev.length ? segPrev.reduce((s, x) => s + x.close * x.volume, 0) / (segPrev.reduce((s, x) => s + x.volume, 0) || 1) : vwapNow;
  const aboveVwap = px > vwapNow;
  const vwapRising = vwapNow > vwapPrev;

  // Higher-high / higher-low STRUCTURE over the last ~8 sessions (trend health).
  let hh = 0, hl = 0;
  for (let i = n - 8; i < n; i++) { if (i < 1) continue; if (highs[i] > highs[i - 1]) hh++; if (lows[i] > lows[i - 1]) hl++; }
  const structure = (hh + hl) / 14;                 // 0..1

  // PULLBACK QUALITY: how shallow the deepest dip below the running high is over the last
  // 5 sessions (shallow pullbacks = healthy accumulation; deep = distribution). 1 = tight.
  const recentHigh = Math.max(...highs.slice(-6));
  const recentLow = Math.min(...lows.slice(-5));
  const pullback = recentHigh > 0 ? (recentHigh - recentLow) / recentHigh : 0;
  const pullbackQuality = clamp01(1 - pullback / 0.15);   // >15% dip ⇒ 0

  // TREND PERSISTENCE: fraction of the last 10 sessions that closed up.
  const trendPersistence = mean(ret.slice(-10).map(r => (r > 0 ? 1 : 0)));

  // EXTENSION / EXHAUSTION: how far above the 20-day mean price sits (a proxy for "already
  // run"), and the total move over the last 10 sessions. Used to PENALIZE late entries.
  const sma20 = mean(closes.slice(-20));
  const extAbove20 = sma20 > 0 ? px / sma20 - 1 : 0;
  const move10 = closes[n - 11] ? px / closes[n - 11] - 1 : 0;

  // Volatility / spread PROXY (no bid/ask on daily): average daily range %.
  const adrPct = mean(c.slice(-14).map(x => (x.high - x.low) / (x.close || 1)));

  // Today's % change (surfaced, but NOT the ranking driver — acceleration is).
  const changePct = closes[n - 2] ? px / closes[n - 2] - 1 : 0;

  return {
    price: +px.toFixed(2), changePct: +(changePct * 100).toFixed(2),
    velocity: +(vel3 * 100).toFixed(2), priceAccel: +(priceAccel * 100).toFixed(2),
    volAccel: +(volAccel * 100).toFixed(1), dvAccel: +(dvAccel * 100).toFixed(1),
    relVol5: +relVol5.toFixed(2), relVol20: +relVol20.toFixed(2), dollarVol,
    aboveVwap, vwapRising, structure: +structure.toFixed(2),
    pullbackQuality: +pullbackQuality.toFixed(2), trendPersistence: +trendPersistence.toFixed(2),
    extAbove20: +(extAbove20 * 100).toFixed(1), move10: +(move10 * 100).toFixed(1),
    adrPct: +(adrPct * 100).toFixed(2),
  };
}

// ── Catalyst quality (0..1) ──────────────────────────────────────────────────────────
// From the catalyst tag the merged signals already carry. Fresh + material + confident +
// novel scores high; stale or absent scores low. `ageDays` null = unknown age (mild
// discount, not zero). This never invents a catalyst — no tag ⇒ momentum-without-a-reason,
// which is honestly lower-conviction.
const CATALYST_WEIGHT = {
  fda: 1, 'm&a': 1, merger: 1, acquisition: 1, contract: 0.9, partnership: 0.85,
  earnings: 0.8, upgrade: 0.75, analyst: 0.7, approval: 0.95, offering: 0.5, financing: 0.5,
  'gap-up': 0.6, breakout: 0.55, legal: 0.6, product: 0.7, 'earnings-beat': 0.85,
};
function catalystQuality({ catalyst, ageDays = null, confidence = null } = {}) {
  if (!catalyst) return { quality: 0.25, label: null, fresh: false };  // momentum, no named reason
  const key = String(catalyst).toLowerCase();
  let base = 0.6;
  for (const [k, w] of Object.entries(CATALYST_WEIGHT)) if (key.includes(k)) { base = Math.max(base, w); }
  // Freshness: today/1d = full; decays over ~10 sessions; unknown age = 0.8× (mild).
  const freshness = ageDays == null ? 0.8 : clamp01(1 - ageDays / 10);
  const conf = confidence == null ? 1 : clamp01(confidence);
  return { quality: +clamp01(base * (0.5 + 0.5 * freshness) * conf).toFixed(3), label: catalyst, fresh: ageDays != null && ageDays <= 2 };
}

// ── The 0–100 Momentum Ignition Score ────────────────────────────────────────────────
// Rewards ACCELERATION + volume expansion + trend quality + a real catalyst; PENALIZES a
// stale/absent catalyst, an already-exhausted move, deceleration, thin liquidity, and wide
// range (spread proxy). The signature property: an early accelerating name outscores a
// large-but-slowing one. Multiplicative penalty envelope so a fatal flaw collapses it.
const WEIGHTS = { priceAccel: 0.26, volAccel: 0.20, catalyst: 0.20, trend: 0.16, liquidity: 0.10, vwap: 0.08 };
function ignitionScore(f, { catalyst = {}, regime = {} } = {}) {
  if (!f) return { score: 0, components: null, penalties: ['no data'] };
  // Normalize each driver to 0..1 (generous but bounded scales chosen from typical ranges).
  const priceA = clamp01(0.5 + f.priceAccel / 4);            // ±4%/day accel swing ⇒ 0..1
  const volA = clamp01(f.volAccel / 150);                    // +150% vol accel ⇒ 1
  const trendQ = clamp01(0.4 * f.structure + 0.3 * f.pullbackQuality + 0.3 * f.trendPersistence);
  const liq = clamp01(Math.log10(Math.max(1, f.dollarVol)) / 8);   // ~$100M ADV ⇒ 1
  const vwap = (f.aboveVwap ? 0.6 : 0) + (f.vwapRising ? 0.4 : 0);
  const catQ = catalyst.quality ?? 0.25;

  let base = 100 * (WEIGHTS.priceAccel * priceA + WEIGHTS.volAccel * volA + WEIGHTS.catalyst * catQ
    + WEIGHTS.trend * trendQ + WEIGHTS.liquidity * liq + WEIGHTS.vwap * vwap);

  // ── Penalties (multiplicative) ──
  const penalties = [];
  let mult = 1;
  if (f.priceAccel < 0) { mult *= 0.65; penalties.push('decelerating'); }         // the key anti-signal
  if (f.extAbove20 > 25) { mult *= 0.6; penalties.push('exhausted / extended'); } // already run far
  else if (f.extAbove20 > 15) { mult *= 0.82; penalties.push('extended'); }
  if (f.dollarVol < 3e6) { mult *= 0.6; penalties.push('thin liquidity'); }
  if (f.adrPct > 12) { mult *= 0.85; penalties.push('very wide range (slippage)'); }
  if (!catalyst.label) { mult *= 0.85; penalties.push('no named catalyst'); }
  if (catalyst.label && catalyst.fresh === false && catalyst.quality < 0.4) { mult *= 0.8; penalties.push('stale catalyst'); }
  // Regime: momentum ignition works far better in risk-on tapes (the app's validated lever).
  const riskOff = regime.bearish === true || regime.riskOn === false;
  if (riskOff) { mult *= 0.75; penalties.push('risk-off tape'); }

  const score = +Math.max(0, Math.min(100, base * mult)).toFixed(1);
  return {
    score,
    components: { priceAccel: +priceA.toFixed(2), volAccel: +volA.toFixed(2), catalyst: +catQ.toFixed(2),
      trend: +trendQ.toFixed(2), liquidity: +liq.toFixed(2), vwap: +vwap.toFixed(2) },
    penalties, penaltyMult: +mult.toFixed(2),
  };
}

// ── EOD-honest stages ────────────────────────────────────────────────────────────────
// The spec's Watch → Ignition → Pressure → Near-Halt → Post-Halt ladder needs real-time
// data. On EOD data we surface the four stages we CAN defend, and explicitly do NOT claim
// halt proximity (the route/UI say why). Extended = the exhaustion warning, not a buy.
const STAGES = ['Watch', 'Ignition', 'Pressure', 'Extended'];
const STAGE_META = {
  Watch:     { icon: '👁', blurb: 'Early acceleration, small move so far — building, room to run.' },
  Ignition:  { icon: '🔥', blurb: 'Accelerating with volume expansion — the ignition phase.' },
  Pressure:  { icon: '🚀', blurb: 'Strong accel + high relative volume, moving materially, still not exhausted.' },
  Extended:  { icon: '⚠️', blurb: 'Already run far and/or decelerating — exhaustion risk, not an entry.' },
};
function ignitionStage(f, scoreObj) {
  if (!f) return 'Watch';
  const accelerating = f.priceAccel > 0;
  const volExpanding = f.volAccel > 30 || f.relVol5 > 1.5;
  // Exhaustion first: run far AND (decelerating OR huge single move).
  if (f.extAbove20 > 25 && (!accelerating || f.changePct > 20)) return 'Extended';
  if (!accelerating) return 'Extended';
  if (f.changePct >= 8 && volExpanding && f.extAbove20 < 25) return 'Pressure';
  if (accelerating && volExpanding) return 'Ignition';
  return 'Watch';
}

// Tier for Scoreboard grouping (mirrors the app's tiering convention on other ledgers).
function ignitionTier(scoreObj) {
  const s = scoreObj ? scoreObj.score : 0;
  return s >= 70 ? 'IGNITION' : s >= 55 ? 'WATCH' : 'WEAK';
}

module.exports = {
  IGNITION_VERSION, accelerationMetrics, catalystQuality, ignitionScore,
  ignitionStage, ignitionTier, STAGES, STAGE_META, WEIGHTS,
};

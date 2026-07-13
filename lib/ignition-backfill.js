'use strict';
// MOMENTUM IGNITION — Scoreboard backfill (seed-from-history, leakage-safe).
//
// The Ignition Scoreboard resolves each pick's forward return from its logged DATE + entry.
// So instead of waiting weeks for forward accrual, we replay the ignition engine on
// point-in-time candle slices at historical cohort dates and write those picks into the
// SAME per-day ledger (ignition/<date>.json). The existing Scoreboard machinery then
// resolves their 1w/1m/3m returns + MFE automatically — no extra resolution code.
//
// Leakage-safe: each cohort's score uses only candles.slice(0, idx+1) (bars up to that
// date); cohort dates leave ≥ the longest horizon of forward data so the Scoreboard can
// resolve them from FUTURE bars only.
//
// Honest coverage: the acceleration/volume/trend core is reconstructable point-in-time,
// but the CATALYST layer is not (no historical catalyst tags), so backfilled picks carry
// no catalyst — they measure the momentum-ignition core alone. Scores therefore run a
// touch lower than live (the no-catalyst penalty applies uniformly); WATCH tier populates.

const { fetchDailyHistory } = require('./screener');
const { LARGE, SMALL_CAPS, MICRO_CAPS } = require('./universe');
const { buildMacroLookup } = require('./macro');
const IG = require('./ignition');

const BACKFILL_VERSION = 'ignition-backfill-v1';
const MAX_HOLD = 63;               // 3-month horizon → forward bars every cohort must have
// Historical catalyst data isn't available, so we treat it as UNKNOWN → neutral (the app's
// convention: unknown ≠ penalized). A truthy label avoids the "no named catalyst" penalty;
// quality 0.5 is neutral. This measures the momentum-ignition core on a fair footing with
// live scores rather than double-penalizing missing data.
const NEUTRAL_CATALYST = { quality: 0.5, label: '(catalyst unknown — historical)', fresh: null };

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch { out[k] = null; } } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function runIgnitionBackfill({ scope = 'large', limit = 90, step = 21, months = 18, deadlineMs = 46000 } = {}) {
  const t0 = Date.now();
  const list = scope === 'micro' ? MICRO_CAPS : scope === 'small' ? SMALL_CAPS : LARGE;
  const tickers = (limit > 0 ? list.slice(0, limit) : list).slice();

  const spy = await fetchDailyHistory('SPY', '2y').catch(() => null);
  if (!spy) return { byDate: {}, stats: { error: 'no SPY history', version: BACKFILL_VERSION } };
  const spyCandles = spy.candles;

  const macro = await buildMacroLookup('2y').catch(() => null);
  const regimeAt = (date) => {
    const s = macro && macro.at(date); const label = (s && s.regime) || 'neutral';
    return { label, riskOn: label === 'risk-on', bearish: label === 'risk-off' };
  };

  const hist = new Map();
  await mapLimit(tickers, 6, async (t) => { const d = await fetchDailyHistory(t, '2y').catch(() => null); if (d) hist.set(t, d.candles); });

  // Cohort date axis from SPY, leaving MAX_HOLD forward bars so every horizon resolves.
  const span = Math.min(spyCandles.length - 1, Math.round((months / 12) * 252));
  const dates = [];
  for (let k = span; k >= MAX_HOLD; k -= step) dates.push(spyCandles[spyCandles.length - 1 - k].date);

  const byDate = {};
  const stat = { picks: 0, byTier: { IGNITION: 0, WATCH: 0 }, cohortDates: dates.length, tickers: hist.size, deadlineHit: false };

  outer:
  for (const date of dates) {
    const regime = regimeAt(date);
    const dayPicks = [];
    for (const [t, candles] of hist) {
      if (Date.now() - t0 > deadlineMs) { stat.deadlineHit = true; break outer; }
      let idx = -1;
      for (let k = candles.length - 1; k >= 0; k--) { if (candles[k].date <= date) { idx = k; break; } }
      if (idx < 30 || candles.length - 1 - idx < MAX_HOLD) continue;   // need history + forward bars
      const f = IG.accelerationMetrics(candles.slice(0, idx + 1));
      if (!f) continue;
      const scoreObj = IG.ignitionScore(f, { catalyst: NEUTRAL_CATALYST, regime });
      const tier = IG.ignitionTier(scoreObj);
      if (tier !== 'IGNITION' && tier !== 'WATCH') continue;
      dayPicks.push({ ticker: t, section: 'Ignition', tier, date, entry: candles[idx].close,
        score: scoreObj.score, stage: IG.ignitionStage(f, scoreObj), catalyst: null, backfill: true });
      stat.picks++; stat.byTier[tier]++;
    }
    if (dayPicks.length) byDate[date] = dayPicks;
  }
  stat.version = BACKFILL_VERSION; stat.scope = scope; stat.datesWritten = Object.keys(byDate).length; stat.ms = Date.now() - t0;
  stat.coverage = 'acceleration/volume/trend core (point-in-time); no historical catalyst layer';
  return { byDate, stats: stat };
}

module.exports = { runIgnitionBackfill, BACKFILL_VERSION };

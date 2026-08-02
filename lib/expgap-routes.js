'use strict';
// 🌡 EXPECTATION-GAP routes — folded into api/tracker.js (no new function).
//
//   op=expgap      compute + return the current read (EXPENSIVE, rate-limited;
//                  serves the cached latest on build failure)
//   op=expgaplog   (cron/privileged) compute, persist latest, and — ONLY on a
//                  RISK_REDUCE day — append one SPY short-framed row to the
//                  ExpGap ledger (write-once/day). NEUTRAL days log nothing:
//                  "no signal" is not a signal.
//
// The falsifiable test this creates: SPY's forward return after RISK_REDUCE days
// should be worse than unconditional (rows carry short:true so the Scoreboard
// resolver grades a falling market as a win). Reduce-only, weight-0: nothing here
// touches live ranks, sizing, or the production regime gate.

const { nowET } = require('./stats');
const S = require('./store');
const { mapLimit } = require('./map-limit');
const { fetchDailyHistory } = require('./screener');
const { SECTOR_LIST } = require('./universe');
const { benchFor } = require('./readthrough');
const { computeExpectationGap, EXPGAP_VERSION } = require('./expectation-gap');

const LATEST_PATH = 'expgap/latest.json';
const SECTION = 'ExpGap';

function json(res, code, obj, sMaxAge) {
  if (sMaxAge) res.setHeader('Cache-Control', `s-maxage=${sMaxAge}, stale-while-revalidate=60`);
  return res.status(code).json(obj);
}

async function buildRead() {
  const { date } = nowET();
  const symbols = ['SPY', '^VIX', 'HYG', 'LQD', ...new Set(SECTOR_LIST.map(benchFor).filter(Boolean))];
  const candles = {};
  await mapLimit(symbols, 4, async s => {
    const r = await fetchDailyHistory(s, '1y').catch(() => null);
    if (r && Array.isArray(r.candles) && r.candles.length) candles[s] = r.candles;
  });
  const sectorBarsByEtf = {};
  for (const s of SECTOR_LIST) {
    const etf = benchFor(s);
    if (etf && candles[etf]) sectorBarsByEtf[etf] = candles[etf];
  }
  const read = computeExpectationGap({
    spyBars: candles.SPY || [], vixBars: candles['^VIX'] || [],
    hygBars: candles.HYG || [], lqdBars: candles.LQD || [],
    sectorBarsByEtf, asOf: date,
  });
  const spyClose = candles.SPY && candles.SPY.length ? candles.SPY[candles.SPY.length - 1].close : null;
  return { date, read, spyClose, shadow: true };
}

async function runExpGap(req, res) {
  try {
    const out = await buildRead();
    return json(res, 200, { ok: true, ...out }, 1800);
  } catch (e) {
    const cached = await S.readJSON(LATEST_PATH, null).catch(() => null);
    if (cached) return json(res, 200, { ...cached, stale: true, buildError: String((e && e.message) || e) }, 60);
    return json(res, 200, { ok: false, error: String((e && e.message) || e), version: EXPGAP_VERSION }, 30);
  }
}

async function runExpGapLog(req, res) {
  try {
    const { date, isMarketClosed } = nowET();
    if (isMarketClosed) return json(res, 200, { ok: true, skipped: 'market-closed', date });
    const out = await buildRead();
    await S.writeJSON(LATEST_PATH, { ok: true, ...out, savedAt: new Date().toISOString() }, 0);

    if (out.read.state !== 'RISK_REDUCE') {
      return json(res, 200, { ok: true, date, persisted: false, state: out.read.state, reason: 'neutral-days-log-nothing' });
    }
    const existing = await S.readJSON(`${S.EXPGAP_LEDGER}${date}.json`, null).catch(() => null);
    if (existing) return json(res, 200, { ok: true, date, persisted: false, reason: 'already-recorded' });
    if (!Number.isFinite(out.spyClose)) return json(res, 200, { ok: false, date, reason: 'no-spy-close-for-entry' });

    const picks = [{
      date, ts: new Date().toISOString(),
      ticker: 'SPY', section: SECTION, tier: 'RISK_REDUCE',
      entry: out.spyClose, short: true,                 // a falling tape after the call = win
      score: out.read.expectationGap, signalVersion: EXPGAP_VERSION,
      recommendedMaxExposure: out.read.recommendedMaxExposure,
      reasons: out.read.reasons.slice(0, 3),
    }];
    await S.writeExpGapDay(date, { picks, version: EXPGAP_VERSION });
    return json(res, 200, { ok: true, date, persisted: true, state: 'RISK_REDUCE', gap: out.read.expectationGap });
  } catch (e) {
    return json(res, 200, { ok: false, error: String((e && e.message) || e) }, 30);
  }
}

module.exports = { runExpGap, runExpGapLog, buildRead, SECTION, LATEST_PATH };

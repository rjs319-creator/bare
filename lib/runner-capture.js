'use strict';
// RUNNER CAPTURE & MISS TAXONOMY — the daily observability report that measures the thing
// the Day Trade engine is actually FOR: of today's real runners, how many did we surface,
// how early, with how much of the move still ahead — and WHY did we miss the rest?
//
// The "daily runner" event is defined INDEPENDENTLY of the engine (pre-registered below,
// with a sensitivity grid across ATR- and percent-based definitions) so the engine is graded
// against reality, not against its own selections. Misses are REASON-CODED so improvement
// work is driven by evidence (universe hole vs detector miss vs budget vs scanner downtime)
// rather than anecdotes.
//
// Pure core (buildCaptureReport) + a thin op wrapper that assembles inputs from the day's
// artifacts: daily candle caches (post-close bars), the discovery scan log, the persisted
// lifecycle day, and the discovery baseline universe.

const RUNNER_DEFS = Object.freeze({
  pct5: { kind: 'pct', min: 5, desc: 'intraday high ≥ +5% over prior close' },
  pct8: { kind: 'pct', min: 8, desc: 'intraday high ≥ +8% over prior close' },
  atr2: { kind: 'atr', min: 2, desc: 'intraday high ≥ prior close + 2×ATR(14)' },
  atr3: { kind: 'atr', min: 3, desc: 'intraday high ≥ prior close + 3×ATR(14)' },
});
const PRIMARY_DEF = 'atr2';   // vol-normalized primary (a 2-ATR day is "large" on ANY name); others reported for sensitivity

const MISS = Object.freeze({
  NOT_IN_UNIVERSE: 'NOT_IN_UNIVERSE',               // no daily candles at all — data hole
  BELOW_LIQUIDITY_FLOOR: 'BELOW_LIQUIDITY_FLOOR',   // excluded by the discovery price/liquidity gate
  SCANNER_NOT_RUNNING: 'SCANNER_NOT_RUNNING',       // zero discovery scans that day
  SCANNER_SPARSE: 'SCANNER_SPARSE',                 // scans ran but with large gaps (request-driven downtime)
  CUSUM_NOT_TRIPPED: 'CUSUM_NOT_TRIPPED',           // scanned continuously, detector never alarmed
  STAGE2_NEVER_VALIDATED: 'STAGE2_NEVER_VALIDATED', // alarmed in discovery but never got a lifecycle record (budget/threshold)
  UNKNOWN: 'UNKNOWN',
});

function isRunner(bar, def) {
  if (!bar || !(bar.prevClose > 0) || !(bar.high > 0)) return false;
  if (def.kind === 'pct') return (bar.high - bar.prevClose) / bar.prevClose * 100 >= def.min;
  return bar.atr > 0 && bar.high >= bar.prevClose + def.min * bar.atr;
}

// Largest gap (minutes) between consecutive scan timestamps inside the session window.
function largestScanGapMin(scanTimes) {
  if (scanTimes.length < 2) return null;
  const ts = scanTimes.map(t => Date.parse(t)).sort((a, b) => a - b);
  let g = 0;
  for (let i = 1; i < ts.length; i++) g = Math.max(g, ts[i] - ts[i - 1]);
  return +(g / 60000).toFixed(1);
}

// `dailyByTicker`: { T: { high, prevClose, atr, avgDollarVol } } — the day's COMPLETED bars
// (post-close ground truth, used ONLY for grading, never for detection).
// `discoveryLog`: { scans: [{ at, anomalies: [{ ticker, cusum, last, ... }] }] }
// `records`: persisted lifecycle day records map.
// `baselineTickers`: Set of tickers the discovery universe actually contained that day.
function buildCaptureReport({ date, dailyByTicker = {}, discoveryLog = null, records = {}, baselineTickers = null } = {}) {
  const scans = (discoveryLog && discoveryLog.scans) || [];
  const scanTimes = scans.map(s => s.at).filter(Boolean);
  const maxGapMin = largestScanGapMin(scanTimes);
  const scannerRan = scans.length > 0;
  const scannerSparse = maxGapMin != null ? maxGapMin > 10 : scans.length < 5;

  // First discovery sighting per ticker (earliest scan containing it) with the price then.
  const firstSeen = new Map();
  for (const s of scans) {
    for (const a of s.anomalies || []) {
      if (!firstSeen.has(a.ticker)) firstSeen.set(a.ticker, { at: s.at, price: a.last ?? null, cusum: a.cusum ?? null });
    }
  }

  const runnersByDef = {};
  for (const [key, def] of Object.entries(RUNNER_DEFS)) {
    runnersByDef[key] = Object.entries(dailyByTicker).filter(([, b]) => isRunner(b, def)).map(([t]) => t);
  }
  const primary = runnersByDef[PRIMARY_DEF] || [];

  const captured = [], missed = [];
  for (const t of primary) {
    const bar = dailyByTicker[t];
    const disc = firstSeen.get(t) || null;
    const rec = records[t] || null;
    const firstTransitionAt = rec && rec.history && rec.history.length ? rec.history[0].at : null;
    const detectionAt = [disc && disc.at, firstTransitionAt].filter(Boolean).sort()[0] || null;
    if (detectionAt) {
      const detectionPrice = disc && disc.price != null ? disc.price
        : (rec && rec.lastMetrics && rec.lastMetrics.last != null ? rec.lastMetrics.last : null);
      const totalMove = bar.high - bar.prevClose;
      const remainingAtDetection = (detectionPrice != null && totalMove > 0)
        ? +(Math.max(0, Math.min(1, (bar.high - detectionPrice) / totalMove))).toFixed(3) : null;
      captured.push({
        ticker: t, detectionAt, via: disc && (!firstTransitionAt || disc.at <= firstTransitionAt) ? 'discovery' : 'scan-lifecycle',
        detectionPrice, dayHigh: +bar.high.toFixed(4), prevClose: +bar.prevClose.toFixed(4),
        movePct: +((totalMove / bar.prevClose) * 100).toFixed(2),
        remainingFractionAtDetection: remainingAtDetection,
        lifecycleState: rec ? rec.state : null,
        everActionable: !!(rec && (rec.history || []).some(h => h.to === 'ACTIONABLE_NOW')),
      });
      continue;
    }
    // Reason-coded miss.
    let reason = MISS.UNKNOWN;
    if (baselineTickers && !baselineTickers.has(t)) {
      reason = Object.keys(dailyByTicker).length && dailyByTicker[t] ? MISS.BELOW_LIQUIDITY_FLOOR : MISS.NOT_IN_UNIVERSE;
    } else if (!scannerRan) reason = MISS.SCANNER_NOT_RUNNING;
    else if (scannerSparse) reason = MISS.SCANNER_SPARSE;
    else if (!firstSeen.has(t)) reason = MISS.CUSUM_NOT_TRIPPED;
    missed.push({ ticker: t, reason, movePct: +(((bar.high - bar.prevClose) / bar.prevClose) * 100).toFixed(2) });
  }
  // Discovery hits that never became lifecycle-tracked (budget / thresholding downstream).
  const discoveredNotTracked = [...firstSeen.keys()].filter(t => !records[t]);
  for (const m of missed) if (firstSeen.has(m.ticker)) m.reason = MISS.STAGE2_NEVER_VALIDATED;

  // Duds among displayed actionable names: post-decision day close below detection − 0.5 ATR
  // (coarse EOD read; the snapshot grader owns the precise barrier labels).
  const duds = Object.values(records)
    .filter(r => r && (r.history || []).some(h => h.to === 'ACTIONABLE_NOW'))
    .map(r => {
      const tr = r.history.find(h => h.to === 'ACTIONABLE_NOW');
      const px = tr && tr.metrics && tr.metrics.last != null ? tr.metrics.last : null;
      const bar = dailyByTicker[r.ticker];
      if (px == null || !bar || !(bar.close > 0) || !(bar.atr > 0)) return null;
      return bar.close < px - 0.5 * bar.atr ? { ticker: r.ticker, actionableAt: tr.at, detectionPrice: px, close: bar.close } : null;
    })
    .filter(Boolean);

  const captureRate = primary.length ? +(captured.length / primary.length).toFixed(3) : null;
  const medianRemaining = (() => {
    const v = captured.map(c => c.remainingFractionAtDetection).filter(x => x != null).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  })();

  return {
    date, definition: { primary: PRIMARY_DEF, ...RUNNER_DEFS[PRIMARY_DEF] },
    sensitivity: Object.fromEntries(Object.entries(runnersByDef).map(([k, v]) => [k, v.length])),
    runners: primary.length,
    captured, missed, duds,
    discoveredNotTracked,
    metrics: {
      captureRate,
      medianRemainingFractionAtDetection: medianRemaining,
      missReasons: missed.reduce((o, m) => ({ ...o, [m.reason]: (o[m.reason] || 0) + 1 }), {}),
      dudsAmongActionable: duds.length,
    },
    scanner: { scans: scans.length, firstScanAt: scanTimes[0] || null, lastScanAt: scanTimes.at(-1) || null, largestGapMin: maxGapMin, sparse: scannerSparse },
    honesty: 'Capture is graded against an INDEPENDENT, pre-registered runner definition (post-close daily bars). remainingFractionAtDetection near 0 means detection came after the move — such captures earn little credit. EOD dud reads are coarse; barrier-precise grading lives in op=lifecyclegrade.',
  };
}

// op=daytradecapture — assemble the day's artifacts and build/persist the report.
async function runDaytradeCapture(req, res) {
  const { readJSON, writeJSON, hasStore } = require('./store');
  const { etDate } = require('./freshness');
  const date = (req.query && req.query.date) || etDate(new Date());

  const { loadCandleCache, cacheGet } = require('./candle-cache');
  const scopes = ['large', 'small', 'micro', 'expanded'];
  const docs = await Promise.all(scopes.map(s => loadCandleCache(s).catch(() => null)));
  const dailyByTicker = {};
  for (const doc of docs) {
    if (!doc || !doc.data) continue;
    for (const t of Object.keys(doc.data)) {
      if (dailyByTicker[t]) continue;
      const entry = cacheGet(doc, t);
      const candles = entry && entry.candles;
      if (!candles || candles.length < 16) continue;
      const i = candles.findIndex(c => c.date === date);
      if (i < 1) continue;   // the report needs the DATE's completed bar + a prior close
      let atr = 0, cnt = 0;
      for (let k = Math.max(1, i - 14); k < i; k++) {
        const h = candles[k].high, l = candles[k].low, pc = candles[k - 1].close;
        atr += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)); cnt++;
      }
      dailyByTicker[t] = {
        high: candles[i].high, close: candles[i].close, prevClose: candles[i - 1].close,
        atr: cnt ? atr / cnt : 0, avgDollarVol: null,
      };
    }
  }

  const discoveryLog = hasStore() ? await readJSON(`lifecycle/daytrade/discovery/${date}.json`, null).catch(() => null) : null;
  const { loadLifecycleDay } = require('./lifecycle-store');
  const dayDoc = await loadLifecycleDay('daytrade', date).catch(() => ({ records: {} }));
  const baselines = hasStore() ? await readJSON(`lifecycle/daytrade/discovery-baseline-${date}.json`, null).catch(() => null) : null;

  const report = buildCaptureReport({
    date, dailyByTicker, discoveryLog,
    records: dayDoc.records || {},
    baselineTickers: baselines && baselines.byTicker ? new Set(Object.keys(baselines.byTicker)) : null,
  });
  if (hasStore()) { try { await writeJSON(`lifecycle/daytrade/capture/${date}.json`, report, 0); } catch { /* report still returned */ } }
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
  return res.json({ ok: true, ...report });
}

module.exports = { RUNNER_DEFS, PRIMARY_DEF, MISS, isRunner, buildCaptureReport, runDaytradeCapture, largestScanGapMin };

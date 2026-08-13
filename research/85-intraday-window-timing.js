'use strict';
// Frozen diagnostic: are 10:00-11:00 and 14:00-15:00 ET "high-probability institutional
// windows" for long entries, as the SMC folklore claims? Tests same-holding-period
// (60-minute) forward returns by 30-minute entry bucket on the local 5-minute cache
// (gap-event sessions), date-clustered, plus the realized-volatility profile.
//   node research/85-intraday-window-timing.js
const fs = require('node:fs');
const path = require('node:path');
const K = require('./lib/experiment-kit');

const ID = 'intraday-window-timing-2026-08';
const VERSION = 'intraday-window-v1';
const BARS_DIR = path.join(K.DATA_DIR, 'intra5');
const MIN_BARS_PER_SESSION = 70;
const FORWARD_MINUTES = 60;
const BUCKET_STARTS = ['09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00'];
const CLAIMED = new Set(['10:00', '10:30', '14:00', '14:30']);

function sessionReturns(bars) {
  const byTime = new Map(bars.map(b => [b.date.slice(11, 16), b]));
  const out = {};
  for (const t of BUCKET_STARTS) {
    const entry = byTime.get(t);
    if (!entry || !(entry.open > 0)) continue;
    const [h, m] = t.split(':').map(Number);
    const fh = h + Math.floor((m + FORWARD_MINUTES) / 60), fm = (m + FORWARD_MINUTES) % 60;
    const exit = byTime.get(`${String(fh).padStart(2, '0')}:${String(fm).padStart(2, '0')}`);
    if (!exit || !(exit.open > 0)) continue;
    // Realized vol inside the bucket: root sum of squared 5-minute log returns.
    let rv = 0, prev = null, counted = 0;
    for (const b of bars) {
      const bt = b.date.slice(11, 16);
      if (bt < t || bt >= `${String(fh).padStart(2, '0')}:${String(fm).padStart(2, '0')}`) continue;
      if (prev != null && prev > 0 && b.close > 0) { rv += Math.log(b.close / prev) ** 2; counted++; }
      prev = b.close;
    }
    out[t] = { fwd: exit.open / entry.open - 1, realizedVol: counted >= 6 ? Math.sqrt(rv) : null };
  }
  return out;
}

function main() {
  const t0 = Date.now();
  const files = fs.readdirSync(BARS_DIR).filter(f => f.endsWith('.json'));
  const byDate = new Map();
  const attrition = { files: files.length, unreadable: 0, tooFewBars: 0, used: 0 };
  for (const f of files) {
    let bars;
    try { bars = JSON.parse(fs.readFileSync(path.join(BARS_DIR, f), 'utf8')); } catch { attrition.unreadable++; continue; }
    if (!Array.isArray(bars) || bars.length < MIN_BARS_PER_SESSION) { attrition.tooFewBars++; continue; }
    const returns = sessionReturns(bars);
    if (!Object.keys(returns).length) { attrition.tooFewBars++; continue; }
    attrition.used++;
    const date = f.replace(/\.json$/, '').split('_')[1];
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(returns);
  }

  // Per-bucket clustered forward return and realized vol.
  const buckets = {};
  for (const t of BUCKET_STARTS) {
    const rows = [], vols = [];
    for (const [date, sessions] of byDate) {
      const fwd = sessions.map(s => s[t] && s[t].fwd).filter(Number.isFinite);
      const rv = sessions.map(s => s[t] && s[t].realizedVol).filter(Number.isFinite);
      if (fwd.length) rows.push({ date, value: K.mean(fwd) * 100 });
      if (rv.length) vols.push(K.mean(rv) * 100);
    }
    buckets[t] = { fwd60: K.summarizeByDate(rows, { horizonBars: 1 }), meanRealizedVolPct: +(K.mean(vols) || 0).toFixed(3), dates: rows.length };
  }

  // Headline paired contrast: claimed windows minus the rest, within the same date.
  const paired = [];
  for (const [date, sessions] of byDate) {
    const claimed = [], rest = [];
    for (const s of sessions) {
      for (const [t, v] of Object.entries(s)) {
        if (!Number.isFinite(v.fwd)) continue;
        (CLAIMED.has(t) ? claimed : rest).push(v.fwd);
      }
    }
    if (claimed.length && rest.length) paired.push({ date, value: (K.mean(claimed) - K.mean(rest)) * 100 });
  }
  const claimedMinusRest = K.summarizeByDate(paired, { horizonBars: 1 });
  const verdict = claimedMinusRest && claimedMinusRest.ci95.lo > 0
    ? 'WINDOW_EFFECT_CONFIRMED' : 'NO_CONFIRMED_WINDOW_EFFECT';

  const artifact = {
    studyId: ID, version: VERSION, kit: K.KIT_VERSION,
    frozenConfig: { forwardMinutes: FORWARD_MINUTES, bucketStarts: BUCKET_STARTS, claimedWindows: [...CLAIMED],
      contrast: 'within-date mean 60-minute forward return, claimed buckets minus all other buckets' },
    dataSnapshot: { barsDir: BARS_DIR, sessionsUsed: attrition.used, distinctDates: byDate.size },
    attrition, buckets, claimedMinusRest, verdict,
    survivorshipProvenSafe: false,
    limitations: [
      'The 5-minute cache holds GAP-EVENT sessions only — high-attention movers, not a neutral universe.',
      'Long-side entries only; the folklore claim is direction-agnostic but was specified here as long entries.',
      '60-minute open-to-open forward returns; no spread or slippage is charged.',
    ],
    runtimeMs: Date.now() - t0, generatedAt: new Date().toISOString(),
  };
  const written = K.writeArtifact(path.join(K.DATA_DIR, 'intraday-window-timing'), 'result.json', artifact);
  K.recordExperiment({
    id: ID,
    hypothesis: 'Long entries during 10:00-11:00 or 14:00-15:00 ET earn higher same-holding-period returns than entries at other times of day.',
    family: 'daytrade-execution',
    frozenConfig: artifact.frozenConfig,
    dataSnapshot: artifact.dataSnapshot,
    codeVersion: VERSION,
    variationsAttempted: 1,
    result: { verdict, claimedMinusRest, bucketMeans: Object.fromEntries(Object.entries(buckets).map(([t, b]) => [t, b.fwd60 && { avg: b.fwd60.avg, lo: b.fwd60.ci95.lo, hi: b.fwd60.ci95.hi, vol: b.meanRealizedVolPct }])) },
  });
  console.log(JSON.stringify({ verdict, claimedMinusRest: claimedMinusRest && { avg: claimedMinusRest.avg, ci95: claimedMinusRest.ci95 }, artifact: written.file }, null, 2));
  return artifact;
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e); process.exit(1); }
}
module.exports = { main, ID, VERSION };

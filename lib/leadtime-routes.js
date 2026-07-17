'use strict';
// LEAD-TIME / EARLY-DETECTION SCOREBOARD route (op=leadtime) — folded into api/tracker.js (no
// new Serverless Function). Reuses the SAME ledgers + point-in-time candle history the
// Scoreboard resolves on, but asks a different question: not "did the pick beat the market?"
// (op=scoreboard already answers that) but "did the algorithm find the move EARLY enough to be
// useful?" — days-before-breakout, share of the move captured before confirmation, false-early
// rate, and capital efficiency, with a verdict that refuses to call a screener early on lead
// time alone (spec §7). Heavy (fetches candles across the ledger universe) → EXPENSIVE_OPS
// rate-limited + CDN-cached + best-effort blob cache for the warm cron to prime.

const {
  readAllPicks, readAllGhost, readAllIgnition, readAllOmega, readAllDownDays, readAllCoilDays,
  hasStore, readJSON, writeJSON,
} = require('./store');
const { fetchDailyHistory } = require('./screener');
const LT = require('./leadtime');

const CACHE_PATH = 'apex/leadtime.json';
const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

// Sections included: those with a genuine DETECTION PRICE and a multi-day move to be early to.
// Intraday sleeves (daytrade, gap-down continuation) are deliberately excluded — a 63-bar
// breakout window is not their game, and lead-time on a same-session setup is meaningless.
async function assemblePicks() {
  const rawPicks = await readAllPicks().catch(() => []);                       // screener + momentum (section/tier/entry set)
  const rawGhost = await readAllGhost().catch(() => []);                       // → Ghost
  const rawIgn = await readAllIgnition().catch(() => []);                      // → Ignition (accel)
  const rawOmega = await readAllOmega().catch(() => []);                      // → OMEGA (swing)
  const rawDownDay = (await readAllDownDays().catch(() => [])).flatMap(dd => (dd.picks || []).map(p => ({ ...p, section: 'DownDay' })));
  const rawCoil = (await readAllCoilDays().catch(() => [])).flatMap(dd => (dd.picks || []).map(p => ({ ...p, date: p.date || dd.date, section: 'coil', tier: p.band || (p.decile != null ? `D${p.decile}` : 'coil'), entry: p.entry != null ? p.entry : p.entryPrice })));

  const groups = [
    ...rawPicks,
    ...rawGhost.map(p => ({ ...p, section: 'Ghost' })),
    ...rawIgn.map(p => ({ ...p, section: p.section || 'Ignition' })),
    ...rawOmega.map(p => ({ ...p, section: p.section || 'OMEGA' })),
    ...rawDownDay, ...rawCoil,
  ].filter(p => p && p.ticker && p.date && p.tier);

  // First-appearance only, per section:tier:ticker — the earliest record is where the
  // algorithm actually DETECTED the name, which is exactly the anchor lead-time measures from.
  const firstSeen = new Map();
  for (const p of groups.sort(byDate)) {
    const key = `${p.section}:${p.tier}:${p.ticker}`;
    if (!firstSeen.has(key)) firstSeen.set(key, p);
  }
  return [...firstSeen.values()];
}

async function fetchHist(tickers) {
  const hist = new Map();
  let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++];
      try { const d = await fetchDailyHistory(t); if (d) hist.set(t, d.candles); } catch { /* skip a bad feed */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, tickers.length) }, worker));
  return hist;
}

async function runLeadTime(req, res) {
  if (!hasStore()) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, configured: false, algorithms: [], note: 'No ledger store configured yet.' });
  }
  // Group by section by default; ?bytier=1 splits each tier (GHOST vs STALKING, etc.).
  const groupBy = req.query.bytier === '1' ? 'sectionTier' : 'section';
  const picks = await assemblePicks();
  if (!picks.length) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, configured: true, algorithms: [], coverage: { picks: 0, evaluated: 0 }, note: 'No resolvable first-appearance picks yet.' });
  }
  const hist = await fetchHist([...new Set(picks.map(p => p.ticker))]);
  const result = LT.computeLeadTime(picks, hist, { groupBy });
  const payload = {
    ok: true, configured: true, generatedAt: new Date().toISOString(),
    ...result,
    note: 'Earliness is measured against an objective, versioned breakout marker (+' + result.config.BREAKOUT_PCT + '% from detection within ' + result.config.WINDOW + ' bars). A screener is labeled "early" only if its signals also CONVERT and the wait is tradeable — being first is not enough.',
  };
  // Best-effort blob cache so the warm cron can prime it and a cheap reader exists.
  try { await writeJSON(CACHE_PATH, payload, 0); } catch { /* cache is optional */ }
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  return res.json(payload);
}

// Cheap cached read for surfaces that shouldn't trigger the heavy recompute (unused for now,
// exported for symmetry with the other route modules + future reuse).
async function loadLeadTime() {
  return readJSON(CACHE_PATH, null).catch(() => null);
}

module.exports = { runLeadTime, loadLeadTime, assemblePicks, CACHE_PATH };

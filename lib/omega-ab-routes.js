'use strict';
// OMEGA R10-vs-SCORE SHADOW A/B — tracker ops.
//
//   op=omegaab      public read  — experiment status, accumulated prospective series, verdict
//   op=omegaabtick  PRIVILEGED   — nightly: stamp today's both-arm top-10 (write-once),
//                                  resolve matured pending days (fills outcomes ONLY)
//
// SHADOW / weight-0. This never reads from or writes into live OMEGA scoring/ranking/
// alerts/portfolios; it evaluates the frozen 62-name options-liquid list independently
// and logs both orderings so a future scorer change can be judged on PROSPECTIVE
// evidence (retrospective motivation: research/90 + research/91, both registered).
//
// Storage (Blob): omegaab/v1/days/<date>.json (write-once decisions), omegaab/v1/index.json
// (date list), omegaab/v1/summary.json (resolved per-date series, appended at resolution).

const { requireTrusted } = require('./auth');
const STORE = require('./store');
const AB = require('./omega-ab');
const F = require('./research/si-features');
const O = require('./omega-swing');
const OX = require('./omega-execution');
const { roundTripCostPct } = require('./costs');
const { SECTOR_ETF } = require('./omega-backfill');
const { SECTOR_OF } = require('./universe');
const { LIQUID_OPTIONS } = require('./optionsflow');
const { logWarn } = require('./log');

const INDEX_KEY = 'omegaab/v1/index.json';
const SUMMARY_KEY = 'omegaab/v1/summary.json';
const dayKey = (date) => `omegaab/v1/days/${date}.json`;

const ETFS = new Set(['SPY', 'QQQ', 'IWM', 'GLD', 'SLV', 'TLT', 'SMH']);
const UNIVERSE = Object.freeze(LIQUID_OPTIONS.filter((t) => !ETFS.has(t)));
const SECTOR_SUPPLEMENT = {
  MSTR: 'Technology', BABA: 'Consumer Discretionary', MRVL: 'Technology',
  SNAP: 'Communication Services', GME: 'Consumer Discretionary',
  AMC: 'Communication Services', SHOP: 'Technology',
};
const sectorOf = (t) => SECTOR_OF[t] || SECTOR_SUPPLEMENT[t] || null;
const MIN_PIT_BARS = 220;

const noStore = (res) => res.setHeader('Cache-Control', 'no-store');
const cached = (res, s = 300) => res.setHeader('Cache-Control', `s-maxage=${s}, stale-while-revalidate=600`);

// ── op=omegaab (public read) ────────────────────────────────────────────────
async function runOmegaAb(req, res) {
  if (!STORE.hasStore()) { noStore(res); return res.status(200).json({ ok: false, reason: 'no blob store configured' }); }
  const [index, summary] = await Promise.all([
    STORE.readJSON(INDEX_KEY, { dates: [] }).catch(() => ({ dates: [] })),
    STORE.readJSON(SUMMARY_KEY, { points: [] }).catch(() => ({ points: [] })),
  ]);
  const assessment = AB.assessAb(summary.points || []);
  cached(res, 300);
  res.status(200).json({
    experimentId: AB.EXPERIMENT_ID, version: AB.OMEGA_AB_VERSION,
    shadow: true, affectsLiveOmega: false,
    motivation: 'Prospective test of research/90-91: does ordering the frozen 62-name cohort by plain r10 beat ordering by the production OMEGA score, net of costs vs SPY, over 5 sessions?',
    universe: UNIVERSE.length, frozen: AB.FROZEN,
    loggedDates: (index.dates || []).length,
    latestLogged: (index.dates || []).length ? index.dates[index.dates.length - 1] : null,
    ...assessment,
    progressPct: +(100 * Math.min(1, assessment.resolvedDates / AB.FROZEN.gate.minResolvedDates)).toFixed(1),
    recentPoints: (summary.points || []).slice(-20),
  });
}

// ── op=omegaabtick (PRIVILEGED) ─────────────────────────────────────────────
async function runOmegaAbTick(req, res) {
  if (!requireTrusted(req, res)) return;
  noStore(res);
  if (!STORE.hasStore()) return res.status(503).json({ ok: false, reason: 'no blob store configured' });
  const { fetchDailyHistory } = require('./screener');
  const report = { logged: null, resolved: [], skipped: [], errors: [] };

  const spyDoc = await fetchDailyHistory('SPY', '2y').catch(() => null);
  if (!spyDoc || !spyDoc.candles || !spyDoc.candles.length) return res.status(200).json({ ok: false, reason: 'no SPY history' });
  const spy = spyDoc.candles;
  const today = spy[spy.length - 1].date;

  const index = await STORE.readJSON(INDEX_KEY, { dates: [] }).catch(() => ({ dates: [] }));

  const histories = new Map();
  const getHist = async (t) => {
    if (!histories.has(t)) histories.set(t, await fetchDailyHistory(t, '2y').then((d) => (d && d.candles) || null).catch(() => null));
    return histories.get(t);
  };
  const mapLimit = async (items, limit, fn) => {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const k = i++; await fn(items[k]); }
    }));
  };

  // ── 1) Stamp today's decisions (write-once) ──
  if (index.dates.includes(today)) {
    report.skipped.push(`${today} already logged`);
  } else {
    const sectorCandles = {};
    await mapLimit([...new Set(Object.values(SECTOR_ETF))], 4, async (etf) => { sectorCandles[etf] = await getHist(etf); });
    await mapLimit([...UNIVERSE], 6, getHist);
    const regime = F.spyRegime(spy);
    const rows = [];
    for (const t of UNIVERSE) {
      const candles = histories.get(t);
      if (!candles || candles.length < MIN_PIT_BARS) continue;
      if (candles[candles.length - 1].date !== today) continue;   // lastBarDate must BE the decision bar
      const etf = SECTOR_ETF[sectorOf(t)];
      const sec = etf && sectorCandles[etf] ? sectorCandles[etf] : null;
      let card = null;
      try {
        card = O.evaluateCandidate({ ticker: t, candles, bench: { spy, sector: sec }, ctx: { regime: { riskOn: regime.riskOn, bearish: regime.bearish } } });
      } catch (e) { report.errors.push(`${t}: ${e.message}`); }
      if (!card || !Number.isFinite(card.score) || !Number.isFinite(card.features.r10)) continue;
      rows.push({
        ticker: t, lastBarDate: today,
        score: card.score, r10: card.features.r10, dollarVol: card.features.dollarVol,
        costPct: roundTripCostPct(OX.tierForDollarVol(card.features.dollarVol)),
      });
    }
    const doc = AB.buildDecisionDoc({ date: today, rows, createdAt: new Date().toISOString() });
    if (!doc) {
      report.skipped.push(`${today}: only ${rows.length} evaluable names — not logged`);
    } else {
      await STORE.writeJSON(dayKey(today), doc, 0);
      await STORE.writeJSON(INDEX_KEY, { dates: [...index.dates, today].sort() }, 0);
      index.dates.push(today);
      report.logged = { date: today, evaluated: doc.evaluated, armScoreTop: doc.armScoreTop, armR10Top: doc.armR10Top };
    }
  }

  // ── 2) Resolve matured pending days (outcome fields only; decisions immutable) ──
  const matured = index.dates.filter((d) => Date.parse(today) - Date.parse(d) >= AB.FROZEN.resolveAfterCalendarDays * 86_400_000);
  const summary = await STORE.readJSON(SUMMARY_KEY, { points: [] }).catch(() => ({ points: [] }));
  let summaryDirty = false;
  for (const d of matured.slice(-30)) {
    try {
      const doc = await STORE.readJSON(dayKey(d), null);
      if (!doc || doc.resolved) continue;
      await mapLimit(doc.rows.map((r) => r.ticker), 6, getHist);
      const { doc: next, pending } = AB.resolveDecisionDoc(doc, { histories, spy, resolvedAt: new Date().toISOString() });
      if (next.resolved) {
        await STORE.writeJSON(dayKey(d), next, 0);
        const point = AB.seriesPoint(next);
        if (point && !(summary.points || []).some((p) => p.date === point.date)) {
          summary.points = [...(summary.points || []), point].sort((a, b) => a.date.localeCompare(b.date));
          summaryDirty = true;
        }
        report.resolved.push({ date: d, pending: 0 });
      } else if (pending < doc.rows.length) {
        report.skipped.push(`${d}: ${pending} rows still pending`);
      }
    } catch (e) { report.errors.push(`resolve ${d}: ${e.message}`); logWarn('omegaabtick resolve failed', { date: d, error: e.message }); }
  }
  if (summaryDirty) await STORE.writeJSON(SUMMARY_KEY, { experimentId: AB.EXPERIMENT_ID, points: summary.points, updatedAt: new Date().toISOString() }, 0);

  res.status(200).json({ ok: true, today, universe: UNIVERSE.length, ...report, resolvedTotal: (summary.points || []).length });
}

module.exports = { runOmegaAb, runOmegaAbTick, UNIVERSE, INDEX_KEY, SUMMARY_KEY, dayKey };

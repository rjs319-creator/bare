// Shared forward-drift evaluator for shadow alt-signal probes.
//
// Given a list of PIT events { symbol, date, score } — where `score`'s SIGN is
// the hypothesised direction and its MAGNITUDE ranks the signal — this measures
// whether the signal predicts DURABLE, market-excess drift after the event. It
// mirrors the discipline of the SUE-PEAD engine: enter the CLOSE AFTER the
// event date (no same-day leakage), take SPY-excess (beta-removed) returns, and
// split the result by YEAR and by the VIX/credit MACRO regime so a single
// risk-on window can't masquerade as a durable edge. Returns an honest verdict.
const { fetchDailyHistory } = require('./screener');
const { buildMacroLookup } = require('./macro');

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
// DESCRIPTIVE ONLY (graduation-league QM-4): this treats every event as independent,
// but events cluster within decision dates (same-day events share the market window)
// and 21/63-session labels overlap across nearby dates — so this t is overstated.
// The VERDICT below never reads it; it runs on `clusteredStats`.
function stats(arr) {
  const n = arr.length; if (!n) return { n: 0 };
  const m = mean(arr), sd = Math.sqrt(mean(arr.map(x => (x - m) ** 2))) || 1e-9;
  return { n, meanPct: +(m * 100).toFixed(2), hitRate: Math.round((arr.filter(x => x > 0).length / n) * 100), tStat: +(m / (sd / Math.sqrt(n))).toFixed(2), basis: 'iid-descriptive' };
}
// Date-clustered inference (QM-4): equal-weight same-date events into ONE observation
// per decision date, then HAC/Newey-West SE with horizon-scaled lags via the shared
// evidence-stats machinery — the same statistic the registry's "t ≥ 2 via the
// drift-eval harness" gates are entitled to assume.
function clusteredStats(rows, horizonBars) {
  const n = (rows || []).length; if (!n) return { n: 0 };
  try {
    const ES = require('./evidence-stats');
    const ded = ES.dedupeToDateSeries(rows, { pickValue: r => r.v, pickDate: r => r.date });
    const s = ES.summarizeDateSeries(ded.series, { horizonBars });
    // FULL-PRECISION fields (audit 2026-08-14): summarizeDateSeries rounds `avg`/`se` to
    // 2dp for DISPLAY. Drift means are fractional (~0.004/date), so a t computed from the
    // rounded fields is 0.00/0.0001 — garbage that the CONFIRMED verdict then gates on at
    // t ≥ 2. Compute every derived value from avgExact/seExact; fall back to the rounded
    // fields only for summaries persisted before the exact fields existed.
    const avg = s && Number.isFinite(s.avgExact) ? s.avgExact : (s ? s.avg : null);
    const se = s && Number.isFinite(s.seExact) ? s.seExact : (s ? s.se : null);
    if (!s || !Number.isFinite(avg) || !Number.isFinite(se) || se <= 0) return { n, basis: 'date-clustered', note: 'insufficient date series' };
    // 95% interval from the exact fields (Student-t at the summary's own critical value).
    // The summary's widest-of(t, bootstrap) interval is only exposed at display rounding —
    // ±0.005 in fractional units, i.e. whole-percent quantization here — so the exact
    // t-interval is the honest choice for a fractional-units series.
    const tCrit = Number.isFinite(s.tCritical) ? s.tCritical : 1.96;
    return {
      n, dates: s.n, effectiveN: s.effectiveN ?? null,
      meanPct: +(avg * 100).toFixed(2),
      hitRate: Math.round((rows.filter(r => r.v > 0).length / n) * 100),
      tStat: +(avg / se).toFixed(2),
      ci95Pct: { lo: +((avg - tCrit * se) * 100).toFixed(2), hi: +((avg + tCrit * se) * 100).toFixed(2) },
      basis: 'date-clustered (HAC/Newey-West, horizon-lagged)',
    };
  } catch { return { n, basis: 'date-clustered', note: 'evidence-stats unavailable' }; }
}

async function evalDrift(events, { holds = [21, 63], minResolved = 200, label = 'signal', deadlineMs = 55000 } = {}) {
  const t0 = Date.now();
  const byYearCount = {}; events.forEach(e => { const y = e.date.slice(0, 4); byYearCount[y] = (byYearCount[y] || 0) + 1; });
  const ds = events.map(e => e.date).sort();
  const diag = { label, eventsTotal: events.length, coverage: { earliest: ds[0] || null, latest: ds[ds.length - 1] || null, byYear: byYearCount } };
  if (events.length < Math.max(80, minResolved * 0.5)) return { ...diag, note: `too few events (${events.length}) for a drift test` };

  // SPY (beta removal) + macro-regime lookup (VIX/credit, 5y point-in-time).
  const [spy, macro] = await Promise.all([fetchDailyHistory('SPY', '5y'), buildMacroLookup('5y')]);
  const sc = spy ? spy.candles : []; const sdate = sc.map(x => x.date); const sClose = {}; sc.forEach(x => { sClose[x.date] = x.close; });
  const spyAt = d => { let lo = 0, hi = sdate.length - 1, ans = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (sdate[m] <= d) { ans = sClose[sdate[m]]; lo = m + 1; } else hi = m - 1; } return ans; };
  const regimeAt = d => (macro && macro.at(d) && macro.at(d).regime) || 'unknown';

  // Price history for symbols that actually have events.
  const symbols = [...new Set(events.map(e => e.symbol))]; const hist = new Map(); let fi = 0;
  const fw = async () => { while (fi < symbols.length) { const s = symbols[fi++]; if (Date.now() - t0 > deadlineMs) return; try { const d = await fetchDailyHistory(s, '5y'); if (d) hist.set(s, d.candles); } catch {} } };
  await Promise.all(Array.from({ length: 16 }, fw));

  // Forward SPY-excess drift, entering the CLOSE AFTER the event date.
  const recs = [];
  for (const e of events) {
    const c = hist.get(e.symbol); if (!c) continue;
    let idx = -1; for (let k = 0; k < c.length; k++) { if (c[k].date >= e.date) { idx = k; break; } }
    if (idx < 0 || idx + 1 >= c.length) continue;
    const entryI = idx + 1, entry = c[entryI].close; if (!(entry > 0)) continue;
    const spyEntry = spyAt(c[entryI].date); if (!(spyEntry > 0)) continue;
    const ex = {}; let ok = true;
    for (const H of holds) { const xi = entryI + H; if (xi >= c.length) { ok = false; break; } const sx = spyAt(c[xi].date); if (!(sx > 0)) { ok = false; break; } ex[H] = (c[xi].close - entry) / entry - (sx - spyEntry) / spyEntry; }
    if (!ok) continue;
    recs.push({ score: e.score, year: e.date.slice(0, 4), regime: regimeAt(c[entryI].date), entryDate: c[entryI].date, ex });
  }
  diag.resolvedEvents = recs.length;
  if (recs.length < minResolved) return { ...diag, note: `too few resolvable events (${recs.length}/${minResolved})`, elapsedMs: Date.now() - t0 };

  // Quintiles by score + robustness splits (signed drift aligns with score sign).
  const horizons = {};
  for (const H of holds) {
    const withH = recs.filter(r => r.ex[H] != null).sort((a, b) => a.score - b.score);
    const k = Math.floor(withH.length / 5); const bottom = withH.slice(0, k), top = withH.slice(-k);
    const ls = []; const m = Math.min(top.length, bottom.length); for (let i = 0; i < m; i++) ls.push(top[i].ex[H] - bottom[i].ex[H]);
    const byYear = {}, byRegime = {};
    for (const r of withH) { (byYear[r.year] = byYear[r.year] || []).push(Math.sign(r.score) * r.ex[H]); }
    for (const R of ['risk-on', 'neutral', 'risk-off']) byRegime[R] = stats(withH.filter(r => r.regime === R).map(r => Math.sign(r.score) * r.ex[H]));
    // Date-clustered lanes (QM-4): the verdict statistics. Signed drift clusters all
    // events by entry date; long-short clusters per-date (top-quintile mean − bottom-
    // quintile mean) over dates where both quintiles are populated.
    const topSet = new Set(top), bottomSet = new Set(bottom);
    const lsByDate = new Map();
    for (const r of withH) {
      if (!topSet.has(r) && !bottomSet.has(r)) continue;
      const b = lsByDate.get(r.entryDate) || { top: [], bottom: [] };
      (topSet.has(r) ? b.top : b.bottom).push(r.ex[H]);
      lsByDate.set(r.entryDate, b);
    }
    const lsRows = [...lsByDate.entries()]
      .filter(([, b]) => b.top.length && b.bottom.length)
      .map(([date, b]) => ({ date, v: mean(b.top) - mean(b.bottom) }));
    horizons[H] = {
      topQuintile: stats(top.map(r => r.ex[H])),
      bottomQuintile: stats(bottom.map(r => r.ex[H])),
      longShort: stats(ls),
      signedOverall: stats(withH.map(r => Math.sign(r.score) * r.ex[H])),
      longShortClustered: clusteredStats(lsRows, H),
      signedClustered: clusteredStats(withH.map(r => ({ date: r.entryDate, v: Math.sign(r.score) * r.ex[H] })), H),
      byYear: Object.fromEntries(Object.entries(byYear).filter(([, a]) => a.length >= 30).map(([y, a]) => [y, stats(a)])),
      byRegime,
    };
  }

  // Verdict at 63d (or the longest horizon): significant AND robust, or artifact.
  const h = horizons[63] || horizons[holds[holds.length - 1]];
  const yrs = Object.values(h.byYear || {}); const posYears = yrs.filter(y => y.meanPct > 0).length;
  const regimes = Object.values(h.byRegime).filter(x => x.n >= 30); const posRegimes = regimes.filter(x => x.meanPct > 0).length;
  // VERDICT runs on the DATE-CLUSTERED t (QM-4) — a t computed as if same-day,
  // overlapping-window events were independent may not decide a preregistered gate.
  // Falls closed: a lane whose clustered statistic could not be computed reads t = 0.
  const lsT = Number.isFinite(h.longShortClustered && h.longShortClustered.tStat) ? h.longShortClustered.tStat : 0;
  const signedT = Number.isFinite(h.signedClustered && h.signedClustered.tStat) ? h.signedClustered.tStat : 0;
  let verdict, reason;
  if (lsT >= 2 && signedT >= 2 && yrs.length >= 3 && posYears / yrs.length >= 0.6 && posRegimes >= 2) {
    verdict = 'CONFIRMED';
    reason = `${label}: significant (date-clustered long-short t ${lsT}, signed t ${signedT} at 63d) AND robust across ${posYears}/${yrs.length} years and ${posRegimes} regimes.`;
  } else if (lsT >= 2 || signedT >= 2) {
    verdict = 'REGIME-DEPENDENT';
    reason = `${label}: significant overall (date-clustered long-short t ${lsT}, signed t ${signedT}) but concentrated — positive in only ${posYears}/${yrs.length} years and ${posRegimes} regime(s).`;
  } else {
    verdict = 'NOT-CONFIRMED';
    reason = `${label}: no durable predictive drift (date-clustered long-short t ${lsT}, signed t ${signedT} at 63d).`;
  }
  return { ...diag, elapsedMs: Date.now() - t0, horizons, verdict, verdictBasis: 'date-clustered (HAC), QM-4', reason };
}

module.exports = { evalDrift, stats, clusteredStats };

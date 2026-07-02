// Exit-strategy experiment. The factor research showed the model's composite
// predicts ~63-day forward DIRECTION (rank-IC ~0.10) but the seed's profit factor
// is < 1 — the structure stops cash out before the move plays out. This replays
// the model's historical Apex/Loaded selections and scores each one under several
// exit rules, so we can see which (if any) turns the directional edge into a
// positive expectancy.
const { fetchDailyHistory, screenTicker, smaAt } = require('./screener');
const { LARGE, SMALL_CAPS, MICRO_CAPS } = require('./universe');
const { buildMacroLookup } = require('./macro');
const apex = require('./apex');

const MIN_HISTORY = 150, HOLD = 63;

function ranker(values) {
  const vals = values.filter(v => v != null && !isNaN(v)).sort((a, b) => a - b);
  return x => { if (x == null || isNaN(x) || !vals.length) return 0; let lo = 0, hi = vals.length; while (lo < hi) { const m = (lo + hi) >> 1; if (vals[m] <= x) lo = m + 1; else hi = m; } return Math.round((lo / vals.length) * 100); };
}
function atrAt(c, idx, p = 14) { let s = 0, n = 0; for (let k = Math.max(1, idx - p + 1); k <= idx; k++) { const a = c[k], b = c[k - 1]; s += Math.max(a.high - a.low, Math.abs(a.high - b.close), Math.abs(a.low - b.close)); n++; } return n ? s / n : 0; }

// ── Exit rules — each returns { r, hold } given the forward candle path ──
function exStructure(c, i, e, stop, target) {
  const tgt = (target > e) ? target : e * 1.20, stp = (stop > 0 && stop < e) ? stop : e * 0.92;
  for (let h = 1; h <= HOLD && i + h < c.length; h++) { const x = c[i + h]; if (x.low <= stp) return { r: (stp - e) / e, hold: h }; if (x.high >= tgt) return { r: (tgt - e) / e, hold: h }; }
  const j = Math.min(i + HOLD, c.length - 1); return { r: (c[j].close - e) / e, hold: j - i };
}
function exTime(c, i, e, N) { const j = Math.min(i + N, c.length - 1); return { r: (c[j].close - e) / e, hold: j - i }; }
function exATR(c, i, e, atr, k) {
  const stp = e - k * atr, tgt = e + 2 * k * atr;
  for (let h = 1; h <= HOLD && i + h < c.length; h++) { const x = c[i + h]; if (x.low <= stp) return { r: (stp - e) / e, hold: h }; if (x.high >= tgt) return { r: (tgt - e) / e, hold: h }; }
  const j = Math.min(i + HOLD, c.length - 1); return { r: (c[j].close - e) / e, hold: j - i };
}
function exTrail(c, i, e, atr, k) { // chandelier: trail k·ATR below the highest high
  let hh = c[i].high;
  for (let h = 1; h <= HOLD && i + h < c.length; h++) { const x = c[i + h]; const tstop = hh - k * atr; if (x.low <= tstop) return { r: (tstop - e) / e, hold: h }; hh = Math.max(hh, x.high); }
  const j = Math.min(i + HOLD, c.length - 1); return { r: (c[j].close - e) / e, hold: j - i };
}
function exEMA(c, i, e, p) { // exit on close below a trailing EMA(p)
  let s = 0; for (let k = i - p + 1; k <= i; k++) s += c[k].close; let ema = s / p; const a = 2 / (p + 1);
  for (let h = 1; h <= HOLD && i + h < c.length; h++) { const x = c[i + h]; ema = x.close * a + ema * (1 - a); if (x.close < ema) return { r: (x.close - e) / e, hold: h }; }
  const j = Math.min(i + HOLD, c.length - 1); return { r: (c[j].close - e) / e, hold: j - i };
}
function exCatastrophic(c, i, e, target) { // measured target, only a −15% disaster stop
  const tgt = (target > e) ? target : e * 1.20, stp = e * 0.85;
  for (let h = 1; h <= HOLD && i + h < c.length; h++) { const x = c[i + h]; if (x.low <= stp) return { r: (stp - e) / e, hold: h }; if (x.high >= tgt) return { r: (tgt - e) / e, hold: h }; }
  const j = Math.min(i + HOLD, c.length - 1); return { r: (c[j].close - e) / e, hold: j - i };
}

const STRATS = {
  structure: (c, i, e, lv, atr) => exStructure(c, i, e, lv.stop, lv.target != null ? lv.target : lv.resistance),
  time21: (c, i, e) => exTime(c, i, e, 21),
  time63: (c, i, e) => exTime(c, i, e, 63),
  atr2: (c, i, e, lv, atr) => exATR(c, i, e, atr, 2),
  atr3: (c, i, e, lv, atr) => exATR(c, i, e, atr, 3),
  trail3ATR: (c, i, e, lv, atr) => exTrail(c, i, e, atr, 3),
  ema21: (c, i, e) => exEMA(c, i, e, 21),
  catastrophic: (c, i, e, lv) => exCatastrophic(c, i, e, lv.target != null ? lv.target : lv.resistance),
};

function agg(rs) {
  const n = rs.length; if (!n) return { n: 0 };
  const wins = rs.filter(r => r.r > 0);
  let w = 0, l = 0; rs.forEach(r => { if (r.r > 0) w += r.r; else l += Math.abs(r.r); });
  const mean = rs.reduce((a, r) => a + r.r, 0) / n;
  return { n, winRate: Math.round((wins.length / n) * 100), profitFactor: l > 0 ? +(w / l).toFixed(2) : (w > 0 ? 99 : 0), expectancyPct: +(mean * 100).toFixed(2), avgHold: Math.round(rs.reduce((a, r) => a + r.hold, 0) / n) };
}

// Win rate / PF / expectancy for a plain array of trade returns.
function pfWin(arr) {
  const n = arr.length; if (!n) return { n: 0 };
  const wins = arr.filter(r => r > 0).length; let w = 0, l = 0; arr.forEach(r => { if (r > 0) w += r; else l += Math.abs(r); });
  return { n, winRate: Math.round((wins / n) * 100), pf: l > 0 ? +(w / l).toFixed(2) : (w > 0 ? 99 : 0), exp: +((arr.reduce((a, b) => a + b, 0) / n) * 100).toFixed(2) };
}

async function runExitStudy({ scope = 'large', step = 10, months = 12, limit = 0, range = '2y', deadlineMs = 50000 } = {}) {
  const t0 = Date.now();
  // Point-in-time macro (VIX + credit) so each cohort's regime matches the LIVE
  // blend (SPY/breadth OR macro-risk-off), not the old SPY-200DMA-only read. The
  // range tracks the study window so multi-year runs get 5y of macro history.
  const macroLookup = await buildMacroLookup(range).catch(() => null);
  const list = scope === 'micro' ? MICRO_CAPS : scope === 'small' ? SMALL_CAPS : LARGE;
  let tickers = [...new Set(list)]; if (limit > 0) tickers = tickers.slice(0, limit);
  const spy = await fetchDailyHistory('SPY', range); const sc = spy ? spy.candles : []; const scl = sc.map(x => x.close);
  const sbd = {}; sc.forEach(x => { sbd[x.date] = x.close; }); const sIdx = {}; sc.forEach((x, i) => { sIdx[x.date] = i; });
  const hist = new Map(); let fi = 0;
  const fw = async () => { while (fi < tickers.length) { const t = tickers[fi++]; try { const d = await fetchDailyHistory(t, range); if (d) hist.set(t, { candles: d.candles, meta: { ...d.meta, symbol: t } }); } catch {} } };
  await Promise.all(Array.from({ length: 16 }, fw));
  const span = Math.min(sc.length - 1, months * 21); const dates = [];
  for (let k = span; k >= HOLD; k -= step) dates.push(sc[sc.length - 1 - k].date);

  const results = {}; for (const s in STRATS) results[s] = [];
  const tagged = [];   // per selection: { date, regime, structure, time63, catastrophic }
  let selections = 0;
  for (const date of dates) {
    if (Date.now() - t0 > deadlineMs) break;
    const cohort = [];
    for (const [t, { candles, meta }] of hist) {
      let idx = -1; for (let k = candles.length - 1; k >= 0; k--) { if (candles[k].date <= date) { idx = k; break; } }
      if (idx < MIN_HISTORY || candles.length - 1 - idx < HOLD) continue;
      const r = screenTicker(candles.slice(0, idx + 1), meta, { spyByDate: sbd });
      if (!r || !r.factors) continue;
      cohort.push({ idx, candles, r });
    }
    if (cohort.length < 20) continue;
    const rk = {
      mom63: ranker(cohort.map(c => c.r.factors.mom63)), mom126: ranker(cohort.map(c => c.r.factors.mom126)),
      trend: ranker(cohort.map(c => c.r.factors.trendTemplate)), volAdj: ranker(cohort.map(c => c.r.factors.volAdjMom)),
      base: ranker(cohort.map(c => c.r.factors.baseQuality)), prox: ranker(cohort.map(c => c.r.factors.proximity)),
      accum: ranker(cohort.map(c => c.r.metrics.accumRatio)), ud: ranker(cohort.map(c => c.r.metrics.udVol)),
    };
    const si = sIdx[date]; let a200 = null; if (si != null) { const s200 = smaAt(scl, 200, si); a200 = s200 != null ? scl[si] > s200 : null; }
    const breadth = Math.round((cohort.filter(x => x.r.above50).length / cohort.length) * 100);
    // Blend the SPY/breadth read with the point-in-time macro layer — matches live.
    const mac = macroLookup ? macroLookup.at(date) : null;
    const regime = apex.rawRegime({
      bearish: a200 === false || breadth < 40 || !!(mac && mac.riskOff),
      riskOn: a200 === true && breadth >= 45 && (!mac || mac.riskOn),
    });
    for (const c of cohort) {
      const f = c.r.factors, m = c.r.metrics;
      const pct = { rs: rk.mom126(f.mom126), mom: Math.round((rk.mom63(f.mom63) + rk.mom126(f.mom126)) / 2), trend: rk.trend(f.trendTemplate), volAdj: rk.volAdj(f.volAdjMom), base: rk.base(f.baseQuality), prox: rk.prox(f.proximity), accum: rk.accum(m.accumRatio), ud: rk.ud(m.udVol) };
      const { tier } = apex.scoreCandidate({ pct, narrativeStrength: null, status: c.r.status }, regime);
      if (tier !== 'apex' && tier !== 'loaded') continue;
      selections++;
      const lv = c.r.levels || {}, entry = lv.entry != null ? lv.entry : c.candles[c.idx].close, atr = atrAt(c.candles, c.idx);
      const out = {};
      for (const s in STRATS) { const o = STRATS[s](c.candles, c.idx, entry, lv, atr); results[s].push(o); out[s] = o.r; }
      tagged.push({ date, regime, structure: out.structure, time63: out.time63, catastrophic: out.catastrophic });
    }
  }
  const summary = Object.fromEntries(Object.keys(STRATS).map(s => [s, agg(results[s])]));

  // OOS breakdowns — is "hold-63 beats stops" robust, or a risk-on artifact?
  const KEYS = ['structure', 'time63', 'catastrophic'];
  const bucketStats = rows => Object.fromEntries(KEYS.map(k => [k, pfWin(rows.map(r => r[k]))]));
  const byRegime = {};
  for (const R of ['RISK_ON', 'NEUTRAL', 'RISK_OFF']) { const rows = tagged.filter(t => t.regime === R); if (rows.length >= 20) byRegime[R] = bucketStats(rows); }
  const qOf = d => `${d.slice(0, 4)}-Q${Math.floor(+d.slice(5, 7) / 3 - 0.01) + 1}`;
  const qMap = {}; tagged.forEach(t => { (qMap[qOf(t.date)] = qMap[qOf(t.date)] || []).push(t); });
  const byQuarter = Object.keys(qMap).sort().filter(q => qMap[q].length >= 20).map(q => ({ quarter: q, ...bucketStats(qMap[q]) }));

  return { selections, elapsedMs: Date.now() - t0, hold: HOLD, range, macroEnabled: !!macroLookup, summary, byRegime, byQuarter };
}

module.exports = { runExitStudy };

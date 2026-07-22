// op=optionsflow : scan the liquid-options universe for unusual flow, serve it
//   ranked, persist today's snapshot + roll a forward-tracking ledger.
// op=optionsperf : resolve the ledger's forward returns into a track record.
//
// Forward-tracking (the snippet's "forward-tracked performance"): each day we log
// the first-appearance flow signals (ticker + bullish/bearish lean + entry price);
// op=optionsperf later checks whether the underlying moved the flagged way over
// 1w/1m — an honest, falsifiable read on whether the flow had any edge.

const { fetchChainMultiExpiry } = require('./options-baseline');
const { fetchDailyHistory } = require('./screener');
const { fetchEarningsInfo } = require('./fundamentals');
const { readJSON, writeJSON, hasStore, readAllArchive } = require('./store');
const { computeBaselines } = require('./baseline');
const of = require('./optionsflow');
const ofFable = require('./optionsflow-fable');
const { snapshotContracts, indexBySymbol, stampOiConfirmation } = require('./options-snapshot');
const { foldEpisodes } = require('./options-episodes');

// Immutable options DECISION-EPISODE ledger — repeated daily ticker+lean appearances
// collapse into one episode (single writer, folded each day in runOptionsFlow).
const EPISODES_KEY = 'optionsflow/episodes.json';

// Load the most recent PRIOR session's contract snapshot (keyed by contractSymbol)
// so today's activity can be confirmed against next-session open interest. Bounded
// calendar lookback (weekends/holidays leave gaps); returns {} when none is found.
async function loadPriorSnapshotIndex(date, lookback = 5) {
  const base = new Date(`${date}T00:00:00Z`);
  for (let i = 1; i <= lookback; i++) {
    const prev = new Date(base);
    prev.setUTCDate(base.getUTCDate() - i);
    const key = prev.toISOString().slice(0, 10);
    const doc = await readJSON(`${DAILY_PREFIX}${key}.json`, null).catch(() => null);
    if (doc && Array.isArray(doc.signals) && doc.signals.length) {
      return indexBySymbol(snapshotContracts(doc.signals, { date: key }));
    }
  }
  return {};
}

// Earnings-before-expiry enrichment — the single most actionable options warning:
// an option held through earnings is an event bet (binary + IV crush), a different
// animal from a trend bet. We fetch the next earnings date for each FLAGGED ticker
// (a small set) and flag any whose report lands on/before the contract's expiry.
async function enrichEarnings(out) {
  const tickers = (out.byTicker || []).filter(r => !r.isIndex).map(r => r.ticker);
  const maxDteByTicker = {};
  for (const s of out.signals) maxDteByTicker[s.ticker] = Math.max(maxDteByTicker[s.ticker] || 0, s.dte || 0);
  const info = new Map();
  let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++];
      try { const e = await fetchEarningsInfo(t); if (e) info.set(t, e); } catch { /* skip */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, tickers.length) }, worker));
  if (!info.size) return;
  for (const r of out.byTicker) {
    const e = info.get(r.ticker); if (!e) continue;
    r.earningsDate = e.earningsDate; r.earningsInDays = e.earningsInDays;
    r.earningsBeforeExpiry = e.earningsInDays != null && e.earningsInDays >= 0 && e.earningsInDays <= (maxDteByTicker[r.ticker] || 0);
  }
  for (const s of out.signals) {
    const e = info.get(s.ticker); if (!e) continue;
    s.earningsInDays = e.earningsInDays;
    s.earningsBeforeExpiry = e.earningsInDays != null && e.earningsInDays >= 0 && e.earningsInDays <= (s.dte || 0);
  }
}

// Baseline overlay — the point of the whole archive: the static scanner flags flow
// on absolute thresholds ($50k premium, vol>OI), which can't tell "big for this name"
// from "big, period". We join each flagged ticker to its own daily-archive history
// (nearest-expiry total option volume) and mark the ones whose option volume is a
// statistical outlier vs THEIR OWN norm — "unusual relative to normal", finally.
async function attachBaselines(out, { minObs = 8, z = 2 } = {}) {
  let days;
  try { days = await readAllArchive(); } catch { return; }
  if (!days || !days.length) return;
  const bl = computeBaselines(days, { minObs, z });
  out.baselineAsOf = bl.asOf;
  const confirmed = [];
  let covered = 0;
  for (const r of (out.byTicker || [])) {
    const t = bl.tickers[r.ticker];
    if (!t) continue;
    const b = {};
    if (t.optVol) b.optVol = t.optVol;   // { latest, mean, sd, n, z, pctile, scored }
    if (t.atmIV) b.atmIV = t.atmIV;
    if (t.pcVol) b.pcVol = t.pcVol;
    if (Object.keys(b).length) { r.baseline = b; covered++; }
    const ov = t.optVol;
    if (ov && ov.scored && ov.z >= z) {
      r.abnormalVsNormal = true;
      r.baselineNote = `option volume +${ov.z}σ vs its ${ov.n}-day norm (pctile ${ov.pctile})`;
      confirmed.push(r.ticker);
    } else {
      r.abnormalVsNormal = false;
    }
  }
  out.baselineCoverage = covered;
  out.confirmedUnusual = confirmed;   // statically flagged AND abnormal vs their own history
  out.baselineNote = `${confirmed.length} name(s) show option volume ≥${z}σ above their own ${minObs}+ day norm` +
    ` (baseline as of ${bl.asOf || 'n/a'}, ${covered}/${(out.byTicker || []).length} tickers with enough history).`;
}

const DAILY_PREFIX = 'optionsflow/';
const LEDGER_KEY = 'optionsflow/ledger.json';
const ASSESS_KEY = 'optionsflow/assess.json';
const LEDGER_MAX = 400;
const HORIZONS = [['1w', 5], ['1m', 21]];

// Merge today's cached Fable analysis (op=optionsassess) onto a flow doc: expose
// the ticker→analysis map + desk read for the client, and annotate byTicker. Pure
// enhancement — a missing/stale assessment just leaves the mechanical read intact.
async function attachAssessment(out) {
  try {
    const a = await readJSON(ASSESS_KEY, null);
    if (!a || a.date !== out.date || !a.analyses) return;
    out.analyses = a.analyses;
    out.deskRead = a.deskRead || '';
    out.aiAnalyzedAt = a.generatedAt || null;
    out.byTicker = ofFable.mergeAnalyses(out.byTicker || [], a);
  } catch { /* AI overlay is best-effort */ }
}

async function runOptionsFlow(req, res) {
  const date = new Date().toISOString().slice(0, 10);
  // Baseline sensitivity is tunable via ?minObs=&z= — a PREVIEW: such requests skip
  // the cache and are never persisted, so they can't pollute the ledger/perf split.
  const preview = req.query.minObs != null || req.query.z != null;
  const blMinObs = Math.max(2, parseInt(req.query.minObs, 10) || 8);
  const blZ = Math.max(0.5, parseFloat(req.query.z) || 2);
  const force = req.query.refresh === '1' || preview;

  const cached = await readJSON(`${DAILY_PREFIX}${date}.json`, null).catch(() => null);
  if (cached && !force) {
    await attachAssessment(cached);   // overlay the day's Fable trade plans if ready
    res.setHeader('Cache-Control', 's-maxage=600');
    return res.json({ ...cached, cached: true });
  }

  const universe = of.LIQUID_OPTIONS;
  let signals;
  try {
    // Multi-expiry scan (nearest weekly + one swing expiry) across the broadened
    // universe. Higher concurrency + cap to absorb the ~2× fetch cost under the wall.
    signals = await of.scanOptionsFlow(universe, fetchChainMultiExpiry, { concurrency: 8, cap: 160 });
  } catch (e) {
    return res.status(200).json({ ok: false, error: 'Scan failed: ' + (e && e.message ? e.message : String(e)) });
  }

  // NEXT-SESSION OI CONFIRMATION: stamp each contract with how its open interest moved
  // since the prior snapshot (building = positioning confirmed, not proof of direction).
  const priorIndex = await loadPriorSnapshotIndex(date);
  signals = stampOiConfirmation(signals, priorIndex);

  const out = {
    ok: true, date, generatedAt: new Date().toISOString(),
    universe: universe.length, count: signals.length, signals,
    summary: of.flowSummary(signals),
    byTicker: of.rollupByTicker(signals),
    // HONEST metadata — the client and every downstream screen must reflect these.
    maturity: 'shadow',        // research/confirmation-only; never originates a live trade
    dataDelayed: true,         // free Yahoo chains are delayed, NOT live tick tape
    note: 'SHADOW confirmation overlay derived from DELAYED, free Yahoo option chains (volume vs open interest + estimated premium) — not live tick tape and no trade-level OPRA data. We cannot tell opening from closing or bought from sold, so directional reads are PROVISIONAL (provisional bullish/bearish, mixed, or direction-unknown), never proof and never "smart money". High-turnover / large-notional / premium-activity are heuristic size classes, not confirmed sweeps or blocks. This overlay cannot by itself create or boost a Today\'s Pick.',
  };

  // Per-ticker tally of contracts whose OI is building = a confirmation count the
  // ticker rollups and UI can surface (additive; the rollup itself is unchanged).
  const oiConfByTicker = new Map();
  for (const s of signals) {
    if (s.oiConfirm && s.oiConfirm.confirmsPositioning) oiConfByTicker.set(s.ticker, (oiConfByTicker.get(s.ticker) || 0) + 1);
  }
  for (const r of (out.byTicker || [])) r.oiConfirmedContracts = oiConfByTicker.get(r.ticker) || 0;

  try { await enrichEarnings(out); } catch { /* earnings best-effort */ }
  try { await attachBaselines(out, { minObs: blMinObs, z: blZ }); } catch { /* baseline overlay best-effort */ }

  if (hasStore() && signals.length && !preview) {
    await writeJSON(`${DAILY_PREFIX}${date}.json`, out, 0).catch(() => {});
    // Roll the ledger: one first-appearance entry per ticker:sentiment per day.
    // Tag each with the ticker's baseline abnormality so op=optionsperf can later
    // test whether "abnormal vs own norm" flow actually forward-performs better.
    const abn = new Map((out.byTicker || []).map(r => [r.ticker, !!r.abnormalVsNormal]));
    const led = await readJSON(LEDGER_KEY, { entries: [] }).catch(() => ({ entries: [] }));
    const seen = new Set((led.entries || []).map(e => `${e.date}:${e.ticker}:${e.sentiment}`));
    for (const s of signals) {
      const k = `${date}:${s.ticker}:${s.sentiment}`;
      if (seen.has(k) || s.underlying == null) continue;
      seen.add(k);
      led.entries.push({ date, ticker: s.ticker, sentiment: s.sentiment, kind: s.kind, entry: s.underlying, premium: s.premium, abnormalVsNormal: abn.get(s.ticker) || false });
    }
    led.entries = (led.entries || []).slice(-LEDGER_MAX);
    await writeJSON(LEDGER_KEY, led, 0).catch(() => {});

    // Fold today's per-ticker theses into the IMMUTABLE episode ledger: repeated
    // appearances collapse into one episode (so grading isn't inflated by dependent
    // daily observations); a lean flip or staleness closes an episode without ever
    // rewriting its first-seen "decided at" record.
    try {
      const prevEp = await readJSON(EPISODES_KEY, { episodes: [] }).catch(() => ({ episodes: [] }));
      const folded = foldEpisodes(prevEp.episodes || [], out.byTicker || [], { date });
      await writeJSON(EPISODES_KEY, { updatedAt: out.generatedAt, episodes: folded.episodes }, 0).catch(() => {});
    } catch { /* episode fold is best-effort; the flow response still stands */ }
  }

  await attachAssessment(out);   // overlay the day's Fable trade plans if ready
  res.setHeader('Cache-Control', 'no-store');
  return res.json(out);
}

// op=optionsassess : bounded Fable-5 analysis over today's flow snapshot. Reads the
// snapshot op=optionsflow already built, attaches each rollup's contracts, runs ONE
// parametric Fable call → per-ticker trade plans + a desk read, caches them, and
// stamps today's ledger entries with the AI bias for a later mechanical-vs-Fable A/B.
async function runOptionsAssess(req, res) {
  const date = new Date().toISOString().slice(0, 10);
  const force = req.query.force === '1' || req.query.refresh === '1';

  const cached = await readJSON(ASSESS_KEY, null).catch(() => null);
  if (cached && cached.date === date && !force) {
    res.setHeader('Cache-Control', 's-maxage=300');
    return res.json({ ...cached, cached: true });
  }

  const flow = await readJSON(`${DAILY_PREFIX}${date}.json`, null).catch(() => null);
  if (!flow || !flow.byTicker) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: false, date, analyzed: 0, note: 'No options-flow snapshot for today yet — run op=optionsflow first.' });
  }

  // Rollup rows carry only a contract COUNT; re-attach the actual contracts (from
  // the flat signals) so the analysis can reason over strikes/aggressor/DTE.
  const byTk = new Map();
  for (const s of (flow.signals || [])) {
    if (!byTk.has(s.ticker)) byTk.set(s.ticker, []);
    byTk.get(s.ticker).push(s);
  }
  const rows = (flow.byTicker || []).map(r => ({ ...r, contracts: byTk.get(r.ticker) || [] }));

  const doc = await ofFable.analyzeFlow(rows);
  const result = {
    ok: !!doc, date, generatedAt: new Date().toISOString(),
    analyses: (doc && doc.analyses) || {},
    deskRead: (doc && doc.deskRead) || '',
    analyzed: doc ? Object.keys(doc.analyses).length : 0,
    note: doc ? 'Fable-5 trade plans over today\'s unusual flow — a reasoned overlay on the mechanical scan, not advice.' : 'Fable analysis unavailable (no key / timeout) — the mechanical read stands.',
  };

  if (hasStore() && doc) {
    await writeJSON(ASSESS_KEY, result, 0).catch(() => {});
    try { await stampLedgerBias(result.analyses, date); } catch { /* A/B stamp best-effort */ }
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.json(result);
}

// Stamp the Fable bias/conviction onto today's ungraded ledger entries so
// op=optionsperf can later test whether the AI bias forward-beats the mechanical
// call=bullish/put=bearish lean (the falsifiable A/B — dormant until entries mature).
async function stampLedgerBias(analyses, date) {
  if (!hasStore() || !analyses) return;
  const led = await readJSON(LEDGER_KEY, { entries: [] }).catch(() => ({ entries: [] }));
  let touched = 0;
  for (const e of (led.entries || [])) {
    if (e.date !== date) continue;
    const a = analyses[String(e.ticker).toUpperCase()];
    if (!a) continue;
    e.aiBias = a.bias;
    e.aiConviction = a.conviction;
    touched++;
  }
  if (touched) await writeJSON(LEDGER_KEY, led, 0).catch(() => {});
}

const BIG_WIN_FRACS = [0.10, 0.20]; // favorable-excursion thresholds for "big mover" rates

// Close at the first candle on/after `date`, and `bars` sessions later. Returns
// { ret, mfe } (both fractions) — ret = directional close-to-close outcome,
// mfe = best favorable excursion along the path (bullish flow favors the high,
// bearish the low), so we can measure how often the flow preceded a big move.
function resolveAt(candles, date, bars, sentiment) {
  if (!candles || !candles.length) return null;
  let i = candles.findIndex(c => c.date >= date);
  if (i < 0) return null;
  const j = i + bars;
  if (j >= candles.length) return null;   // horizon not elapsed yet
  const ret = of.flowOutcome(candles[i].close, candles[j].close, sentiment);
  if (ret == null) return null;
  const entry = candles[i].close;
  const bullish = sentiment !== 'bearish';
  let mfe = 0;
  for (let k = i + 1; k <= j; k++) {
    const c = candles[k];
    const hi = c.high != null ? c.high : c.close;
    const lo = c.low != null ? c.low : c.close;
    const fav = bullish ? (hi - entry) / entry : (entry - lo) / entry;
    if (fav > mfe) mfe = fav;
  }
  return { ret, mfe };
}

// rets = resolveAt results [{ ret, mfe }]. Adds the realized "big mover" base
// rate — the share of flow signals whose underlying actually ran +10% / +20%
// in their favored direction — grounded in the ledger, not a fabricated stat.
function summarize(rets) {
  if (!rets.length) return { n: 0 };
  const n = rets.length;
  const wins = rets.filter(r => r.ret > 0).length;
  const avg = rets.reduce((s, r) => s + r.ret, 0) / n;
  const avgMfe = rets.reduce((s, r) => s + r.mfe, 0) / n;
  const big = f => Math.round((rets.filter(r => r.mfe >= f).length / n) * 100);
  return {
    n,
    winRate: Math.round((wins / n) * 100),
    avgReturnPct: +(avg * 100).toFixed(2),
    avgMfePct: +(avgMfe * 100).toFixed(2),
    big10Rate: big(BIG_WIN_FRACS[0]),
    big20Rate: big(BIG_WIN_FRACS[1]),
  };
}

async function runOptionsPerf(req, res) {
  const led = await readJSON(LEDGER_KEY, { entries: [] }).catch(() => ({ entries: [] }));
  const entries = led.entries || [];
  if (!entries.length) {
    res.setHeader('Cache-Control', 's-maxage=300');
    return res.json({ ok: true, logged: 0, resolved: 0, horizons: {}, bySentiment: {}, byKind: {}, note: 'No options-flow signals logged yet — accrues as op=optionsflow runs daily.' });
  }

  const tickers = [...new Set(entries.map(e => e.ticker))];
  const hist = new Map();
  let i = 0;
  const worker = async () => {
    while (i < tickers.length) {
      const t = tickers[i++];
      try { const d = await fetchDailyHistory(t); if (d) hist.set(t, d.candles); } catch { /* skip */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, tickers.length) }, worker));

  const buckets = { horizons: {}, bySentiment: {}, byKind: {}, byAbnormal: {}, fableEdge: {} };
  let resolved = 0;
  for (const [hk, bars] of HORIZONS) {
    const hor = [], bySent = { bullish: [], bearish: [] }, byKind = {}, byAbn = { abnormal: [], normal: [] };
    const aiPairs = [];   // { aiBias, sentiment, ret } for the Fable-vs-mechanical A/B
    for (const e of entries) {
      const r = resolveAt(hist.get(e.ticker), e.date, bars, e.sentiment);
      if (r == null) continue;
      hor.push(r);
      (bySent[e.sentiment] = bySent[e.sentiment] || []).push(r);
      (byKind[e.kind] = byKind[e.kind] || []).push(r);
      // Only entries logged after the baseline overlay shipped carry the flag.
      if (e.abnormalVsNormal === true) byAbn.abnormal.push(r);
      else if (e.abnormalVsNormal === false) byAbn.normal.push(r);
      // Only entries logged after op=optionsassess shipped carry an aiBias.
      if (e.aiBias) aiPairs.push({ aiBias: e.aiBias, sentiment: e.sentiment, ret: r.ret });
    }
    if (hk === '1m') resolved = hor.length;
    buckets.horizons[hk] = summarize(hor);
    buckets.bySentiment[hk] = { bullish: summarize(bySent.bullish), bearish: summarize(bySent.bearish) };
    buckets.byKind[hk] = Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, summarize(v)]));
    buckets.byAbnormal[hk] = { abnormal: summarize(byAbn.abnormal), normal: summarize(byAbn.normal) };
    buckets.fableEdge[hk] = ofFable.flowFableEdge(aiPairs);
  }

  res.setHeader('Cache-Control', 's-maxage=600');
  return res.json({
    ok: true, logged: entries.length, resolved, ...buckets,
    note: 'Win = the underlying moved the flagged way (bullish→up, bearish→down). Forward returns are on the UNDERLYING, not the option. byAbnormal splits flow that was abnormal vs the name\'s own option-volume baseline against the rest. fableEdge is the desk-read A/B — the 🧠 Fable bias vs the raw call/put lean on the SAME resolved calls; it stays TRACKING until enough AI-tagged entries mature. Needs weeks of logging before any read is meaningful.',
  });
}

module.exports = { runOptionsFlow, runOptionsPerf, runOptionsAssess, resolveAt, summarize };

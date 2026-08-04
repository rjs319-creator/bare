const { internalHeaders } = require('./auth');
// op=aligned — "Dual Confirmed" scan: names that are a BUY on BOTH horizons
// (trend-continuation), ranked by conviction.
//
// TWO-STAGE, FULL-MARKET:
//   Stage 1 — read the long-term trend for the WHOLE universe (large+small+micro)
//             straight from the daily candle cache the screener warm already built
//             (no re-fetching), keep only the long-term-bullish names, strongest first.
//   Stage 2 — run the intraday short-term signal ONLY on that shortlist (top-N by
//             long-term score) and keep the ones that are also a short-term buy.
// This scans the entire market on the long side while bounding the expensive
// intraday step. Falls back to the warm screener pool if the candle cache is cold.

const { isAligned, rankAligned, selectLongTermBullish } = require('./aligned');

const SCOPES = ['large', 'small', 'micro', 'expanded'];   // 'expanded' = the free full-market universe (Phase 2)
const STAGE2_MAX = 90;         // intraday confirmations to run (top long-term names)
const SCAN_BUDGET_MS = 45000;  // stay under the function wall
const FALLBACK_MAX = 44;
const stStrong = a => a === 'STRONG_BUY' || a === 'BUY';

function hostFrom(req) {
  return req.headers['x-forwarded-host'] || req.headers.host || process.env.WARM_HOST || 'market-news-app-chi.vercel.app';
}

// Build the full-universe daily-candle list from the per-scope candle caches.
async function universeFromCache() {
  const { loadCandleCache, cacheGet } = require('./candle-cache');
  const seen = new Set();
  const universe = [];
  for (const scope of SCOPES) {
    const doc = await loadCandleCache(scope);
    if (!doc || !doc.data) continue;
    for (const ticker of Object.keys(doc.data)) {
      const tk = ticker.toUpperCase();
      if (seen.has(tk)) continue;
      const entry = cacheGet(doc, ticker);
      if (!entry || !entry.candles || entry.candles.length < 60) continue;
      seen.add(tk);
      universe.push({ ticker: tk, company: entry.meta.shortName || entry.meta.longName || tk, candles: entry.candles });
    }
  }
  return universe;
}

// Fallback pool (warm screener candidates) when the candle cache isn't available.
async function screenerPool(host) {
  const out = new Map();
  await Promise.all(['large', 'small'].map(async scope => {
    try {
      const r = await fetch(`https://${host}/api/screener?scope=${scope}`, { headers: internalHeaders() });
      if (!r.ok) return;
      const j = await r.json();
      for (const c of (j.results || [])) {
        const tk = (c.ticker || '').toUpperCase();
        if (tk && !out.has(tk)) out.set(tk, { ticker: tk, company: c.company || tk, candles: null, levels: c.levels || null });
      }
    } catch { /* skip */ }
  }));
  return [...out.values()].slice(0, FALLBACK_MAX);
}

async function runAligned(req, res) {
  const { analyze } = require('./signal');
  const { fetchDailyHistory } = require('./screener');
  const { readJSON } = require('./store');
  const { tradeLevels } = require('./levels');

  const [spy, weightsDocRaw, universe, dualPolicy] = await Promise.all([
    fetchDailyHistory('SPY', '1y').catch(() => null),
    readJSON('dualread/groupweights.json', null).catch(() => null),
    universeFromCache().catch(() => []),
    require('./adaptive-layers').layerPolicy('dualread-adapt').catch(() => 'freeze'),
  ]);
  // Central adaptive policy: 'disable' scores with shipped default weights.
  const weightsDoc = dualPolicy === 'disable' ? null : weightsDocRaw;
  const spyC = spy && spy.candles;

  // ── Stage 1: full-universe long-term filter (from the cache) ──
  let shortlist = [], longTermBullish = 0;
  let scanned = universe.length, stage = 'full-market';
  if (spyC && universe.length) {
    const ltAll = selectLongTermBullish(universe, spyC, weightsDoc);
    longTermBullish = ltAll.length;
    shortlist = ltAll.slice(0, STAGE2_MAX);   // confirm the strongest long-term names first
  }

  // Fallback: candle cache cold → confirm the warm screener pool the old way.
  let fallbackLevels = {};
  if (!shortlist.length) {
    stage = 'screener-pool';
    const pool = await screenerPool(hostFrom(req));
    scanned = pool.length;
    shortlist = pool.map(p => ({ ticker: p.ticker, company: p.company, candles: null, lt: null, price: null }));
    fallbackLevels = Object.fromEntries(pool.map(p => [p.ticker, p.levels]));
  }

  // ── Stage 2: intraday short-term confirmation on the shortlist only ──
  const t0 = Date.now();
  const items = []; let i = 0, confirmed = 0;
  const worker = async () => {
    while (i < shortlist.length) {
      const cand = shortlist[i++];
      if (Date.now() - t0 > SCAN_BUDGET_MS) return;
      try {
        // Cache path already has the long-term read → only need the intraday signal
        // (light = no daily re-fetch). Fallback path has neither → full analyze.
        const r = await analyze(cand.ticker, cand.lt ? { light: true } : {});
        if (!r || !r.live) continue;
        confirmed++;
        if (!stStrong(r.live.action)) continue;

        const lt = cand.lt || r.longTerm;
        if (!lt) continue;
        const dual = require('./longterm').combineDualRead(r.live.action, lt.trend);
        if (!isAligned(dual)) continue;

        const P = r.price || {};
        const price = P.live || cand.price;
        let levels = fallbackLevels[cand.ticker] || null;
        if (!levels && cand.candles && price) {
          const L = tradeLevels(cand.candles, price, { bullish: true, targetMode: 'measured' });
          if (L) levels = { entry: +price.toFixed(2), stop: L.stop, target: L.resistance };
        }
        items.push({
          ticker: r.ticker, company: cand.company, price,
          // How it's trading today: regular-session price + day change + any extended move.
          regularPrice: P.regular ?? null,
          change: P.regChange ?? null,
          changePct: P.regChangePct ?? null,
          prevClose: P.previousClose ?? null,
          afterHours: P.afterHours || null,
          stAction: r.live.action, stConf: r.live.confidence,
          ltTrend: lt.trend, ltScore: lt.score, group: lt.group || cand.group || null,
          levels,
          stReasons: (r.live.reasons || []).slice(0, 2),
          ltReasons: (lt.reasons || []).slice(0, 2),
        });
      } catch { /* skip name */ }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));

  const picks = rankAligned(items);
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');
  return res.json({
    ok: true,
    picks,
    stage,                       // 'full-market' or 'screener-pool' (cache cold)
    scanned,                     // universe size scanned on the long side
    longTermBullish,             // names that passed the long-term filter
    stage2Confirmed: confirmed,  // intraday checks actually run
    qualified: picks.length,
    generatedAt: new Date().toISOString(),
    note: 'Names that are a BUY on BOTH horizons — the short-term signal AND the ~1y trend both bullish (trend-continuation), ranked by conviction. Full-market: the long-term filter runs over the whole universe, then the short-term signal confirms the strongest long-term names.',
  });
}

const ALIGNED_H = 21;   // ~1 month — Dual Confirmed is a swing/position setup

// Episode dedup (book v2, pure): a ticker's reappearance within `cooldown` calendar
// days of its LAST sighting extends the same episode (not re-graded); a reappearance
// after the cooldown opens a NEW graded episode. Replaces "first appearance per
// ticker forever", which could never grade a name twice — even a year later under a
// different setup. `days` = ledger [{date, picks:[…]}] in any order.
function episodeEntries(days, cooldown) {
  const sorted = (days || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const lastSeen = new Map();
  const entries = [];
  for (const d of sorted) for (const p of (d.picks || [])) {
    if (!p || !p.ticker) continue;
    const prev = lastSeen.get(p.ticker);
    lastSeen.set(p.ticker, d.date);
    if (prev != null) {
      const gapDays = Math.round((Date.parse(d.date) - Date.parse(prev)) / 86400000);
      if (!Number.isFinite(gapDays) || gapDays < cooldown) continue;   // same episode — not re-graded
    }
    entries.push({ ...p, date: d.date });
  }
  return entries;
}

// op=alignedlog — cron: snapshot today's Dual Confirmed picks (entry + conviction)
// to the ledger so the tab is accountable.
async function runAlignedLog(req, res) {
  const { hasStore, writeAlignedDay } = require('./store');
  const { nowET } = require('./stats');
  if (!hasStore()) return res.json({ ok: false, error: 'Blob storage not configured.' });
  const date = nowET().date;   // ET calendar date 'YYYY-MM-DD'
  let picks = [];
  try {
    const r = await fetch(`https://${hostFrom(req)}/api/tracker?op=aligned`, { headers: internalHeaders() });
    const j = await r.json();
    // Log the DISPLAYED plan levels too (previously computed for the card and then
    // dropped — the graded trade and the displayed trade must be reconcilable), plus
    // the scoring version so a version change resets evidence.
    picks = (j.picks || []).filter(p => p.price != null).map(p => ({
      ticker: p.ticker, entry: p.price, conviction: p.conviction, ltScore: p.ltScore, stConf: p.stConf,
      stop: (p.levels && p.levels.stop) ?? null, target: (p.levels && p.levels.target) ?? null,
      signalVersion: 'aligned-v1',
    }));
  } catch (e) { return res.json({ ok: false, error: String(e && e.message || e) }); }
  if (picks.length) await writeAlignedDay(date, picks);
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, date, logged: picks.length });
}

// op=alignedbook — resolve logged picks to forward excess-vs-SPY, overall + by
// conviction tier. Book v2 (non-daytrade redesign 2026-08):
//   • EPISODES with a cooldown replace "first appearance per ticker forever" — a
//     persistent pick extends its episode; a reappearance after the contract
//     cooldown (21 sessions) opens a NEW graded episode.
//   • Entry basis is the NEXT-SESSION OPEN (the contract's fillPolicy) — a signal-day
//     close is not an executable entry for an end-of-day signal.
//   • A cost-net channel is reported alongside gross (conservative 'small' tier —
//     the ledger carries no per-name liquidity, so the cheap tier must not be assumed).
async function runAlignedBook(req, res) {
  const { readAllAlignedDays } = require('./store');
  const { fetchDailyHistory } = require('./screener');
  const { wilson } = require('./stats');
  const SC = require('./strategy-contracts');
  const { roundTripCostPct } = require('./costs');
  const H = Math.max(1, parseInt(req.query.h, 10) || ALIGNED_H);
  const days = await readAllAlignedDays();   // episodeEntries sorts by date itself

  const COOLDOWN = ((SC.contractFor('aligned') || {}).episodeCooldownSessions) || 21;
  const entries = episodeEntries(days, COOLDOWN);

  const spy = await fetchDailyHistory('SPY', '1y').catch(() => null);
  const spyC = spy && spy.candles;
  // Next-session-open entry → close H sessions after the entry bar. Null (still open /
  // insufficient bars) is honest — never a fabricated fill.
  const nextOpenHold = (c, date, n) => {
    const idx = c.findIndex(x => x.date >= date);
    if (idx < 0 || idx + 1 >= c.length) return null;
    const eBar = c[idx + 1];
    const entry = Number.isFinite(eBar.open) && eBar.open > 0 ? eBar.open : eBar.close;
    const exitIdx = idx + 1 + n;
    if (exitIdx >= c.length) return null;
    return { c0: entry, c1: c[exitIdx].close };
  };

  const uniq = [...new Set(entries.map(e => e.ticker))];
  const candle = {};
  let j = 0;
  const worker = async () => { while (j < uniq.length) { const tk = uniq[j++]; try { const d = await fetchDailyHistory(tk, '1y'); candle[tk] = d && d.candles; } catch { candle[tk] = null; } } };
  await Promise.all(Array.from({ length: 6 }, worker));

  const costPct = roundTripCostPct('small');   // conservative: liquidity unknown ⇒ never the cheapest tier
  const resolved = []; let open = 0;
  for (const e of entries) {
    const c = candle[e.ticker];
    if (!c || !spyC) { open++; continue; }
    const st = nextOpenHold(c, e.date, H), m = nextOpenHold(spyC, e.date, H);
    if (!st || !m) { open++; continue; }
    const exc = ((st.c1 - st.c0) / st.c0 - (m.c1 - m.c0) / m.c0) * 100;
    const netExc = exc - costPct;
    resolved.push({ ...e, exc, netExc, beat: exc > 0 });
  }

  const summarize = arr => {
    const n = arr.length; if (!n) return null;
    const beats = arr.filter(x => x.beat).length; const ci = wilson(beats, n);
    const netBeats = arr.filter(x => x.netExc > 0).length;
    return {
      n,
      avgExc: +(arr.reduce((s, x) => s + x.exc, 0) / n).toFixed(2),
      beatRate: +((beats / n) * 100).toFixed(0), wilsonLo: +(ci.lo * 100).toFixed(0),
      avgNetExc: +(arr.reduce((s, x) => s + x.netExc, 0) / n).toFixed(2),
      netBeatRate: +((netBeats / n) * 100).toFixed(0),
    };
  };

  res.setHeader('Cache-Control', 's-maxage=600');
  return res.json({
    ok: true, horizon: H, resolved: resolved.length, open,
    episodeCooldownSessions: COOLDOWN,
    entryBasis: 'next-session-open (contract fillPolicy; a signal-day close is not an executable EOD entry)',
    costBasis: `net = gross − ${costPct}% round-trip ('small' tier — per-name liquidity not logged, cheap tier never assumed)`,
    overall: summarize(resolved),
    byTier: {
      STRONG: summarize(resolved.filter(x => x.conviction >= 80)),   // both horizons near-max
      GOOD: summarize(resolved.filter(x => x.conviction >= 60 && x.conviction < 80)),
    },
    note: `Forward ${H}-session excess-vs-SPY of logged Dual Confirmed EPISODES (cooldown ${COOLDOWN} sessions — a persistent pick is one episode, not a daily re-vote), entered at the next session's open, gross and cost-net. STRONG (≥80) should beat GOOD for conviction to be earning its keep. Displayed stop/target are logged but NOT yet graded (no verified-fill engine on this book) — this remains a proxy record and cannot drive Validated.`,
  });
}

module.exports = { runAligned, runAlignedLog, runAlignedBook, episodeEntries, screenerPool, universeFromCache };

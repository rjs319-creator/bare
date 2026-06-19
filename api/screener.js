const Anthropic = require('@anthropic-ai/sdk');
const { fetchDailyHistory, screenTicker, smaAt } = require('../lib/screener');
const { LARGE, SMALL_CAPS, MICRO_CAPS, SECTOR_OF } = require('../lib/universe');
const { fetchFundamentals, fetchInsiders } = require('../lib/fundamentals');
const { runGhostAccumulationIndex, REGIME_WEIGHTS: GHOST_WEIGHTS, PILLAR_LABEL: GHOST_PILLAR_LABEL } = require('../lib/ghost');
const { convictionScore, convictionWeights, longOk } = require('../lib/conviction');
const { fetchMacro } = require('../lib/macro');
const { loadCandleCache, cacheState, cacheGet, saveCandleCache } = require('../lib/candle-cache');
const { readJSON, writeJSON, hasStore } = require('../lib/store');

const NARRATIVE_TOOL = {
  name: 'submit_narratives',
  description: 'Provide a fundamental/narrative assessment for each screened breakout candidate.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ticker:            { type: 'string' },
            narrative:         { type: 'string', description: '1-2 sentence fundamental or thematic story for why this name could keep running.' },
            narrativeStrength: { type: 'integer', description: '1-10 strength of the fundamental/narrative tailwind (10 = exceptional).' },
            theme:             { type: 'string', description: 'Short theme tag, e.g. "AI infrastructure", "Nuclear/power", "GLP-1", "Fintech".' },
          },
          required: ['ticker', 'narrative', 'narrativeStrength', 'theme'],
        },
      },
    },
    required: ['items'],
  },
};

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Cross-sectional percentile rank (0-100) for each named factor across the set.
function attachPercentiles(items, getters) {
  for (const [name, fn] of Object.entries(getters)) {
    const vals = items.map(fn).filter(v => v != null && !isNaN(v)).sort((a, b) => a - b);
    const pr = x => {
      if (x == null || isNaN(x) || !vals.length) return 0;
      let lo = 0, hi = vals.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (vals[mid] <= x) lo = mid + 1; else hi = mid; }
      return Math.round((lo / vals.length) * 100);
    };
    items.forEach(it => { it._pct = it._pct || {}; it._pct[name] = pr(fn(it)); });
  }
}

// Default composite weighting a momentum/breakout quant desk would use (the
// client can override these live via the Tune panel). Relative strength leads
// (O'Neil), trend + vol-adjusted momentum next, accumulation base quality up.
const DEFAULT_WEIGHTS = { rs: 22, mom: 20, trend: 18, volAdj: 16, base: 12, vol: 8, prox: 4 };

// Cross-sectional percentile components for one name (0-100 each).
function pctComponents(it) {
  const p = it._pct || {};
  return {
    rs:     p.mom126 || 0,
    mom:    Math.round(((p.mom63 || 0) + (p.mom126 || 0)) / 2),
    trend:  p.trend || 0,
    volAdj: p.volAdj || 0,
    base:   p.base || 0,
    vol:    p.volSurge || 0,
    prox:   p.prox || 0,
    accum:  p.accum || 0,   // accumulation ratio — smart-money flow (has real edge)
    ud:     p.ud || 0,      // up/down volume
  };
}

function composite(pct, w) {
  const sum = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  let s = 0;
  for (const k in w) s += (w[k] / sum) * (pct[k] || 0);
  return Math.round(s);
}

// The raw LLM call (Anthropic haiku) — one request covering the given candidates.
async function callNarrativeLLM(candidates) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !candidates.length) return {};
  try {
    const client = new Anthropic({ apiKey: key });
    const list = candidates.map(c =>
      `${c.ticker} (${c.company || c.ticker}) — ${c.capTier} cap; vol ${c.metrics.volSurge}×, ${c.metrics.baseWeeks}wk base, ${c.metrics.pctFrom52wHigh}% off highs, 6mo ${c.factors.mom126}%`
    ).join('\n');
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      tools: [NARRATIVE_TOOL],
      tool_choice: { type: 'tool', name: 'submit_narratives' },
      messages: [{
        role: 'user',
        content: `These US stocks just triggered a technical breakout-from-accumulation screen. For EACH ticker, give a concise fundamental or narrative assessment: is there a real earnings/secular/thematic driver behind the move? Rate the narrative/fundamental strength 1-10 and tag the theme. Be honest — weak/unclear stories score low. If you don't recognise a ticker, give it 4 and note it's a technical-only setup.\n\nTICKERS:\n${list}`,
      }],
    });
    const tool = msg.content.find(b => b.type === 'tool_use');
    const map = {};
    (tool?.input?.items || []).forEach(it => { map[it.ticker.toUpperCase()] = it; });
    return map;
  } catch { return {}; }
}

// Cached candidate enrichment (narrative + fundamentals + insider). These were the
// screener's dominant cost: the LLM narrative call is ~20s and the Finnhub calls are
// flaky (insider data flips run-to-run, jittering ghost scores). All three are
// per-ticker and slowly-changing, so we cache them per scope in Blob:
//   • USER requests read the cache only → fast AND deterministic (no LLM, no Finnhub).
//   • The WARM cron LLM-calls just missing/stale narratives, re-fetches Finnhub
//     (keeping last-known-good on transient failures), and persists.
// Per-scope keys avoid a read-modify-write race between concurrent large/small/micro
// warm requests; brand-new names stay null until the next warm fills them (the
// technical signal doesn't depend on enrichment).
const ENRICH_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const enrichKey = scope => `enrich/${scope}.json`;

async function enrichCandidates(candidates, isWarm, scope) {
  if (!candidates.length) return;
  let cache = {};
  if (hasStore()) { try { const d = await readJSON(enrichKey(scope), null); if (d && d.data) cache = d.data; } catch {} }
  const now = Date.now();

  if (isWarm) {
    // Narratives: LLM only the missing/stale names (one batched call).
    const needNarr = candidates.filter(c => { const e = cache[c.ticker.toUpperCase()]; return !(e && e.nv && now - (e.nvTs || 0) < ENRICH_STALE_MS); });
    const llm = (needNarr.length && process.env.ANTHROPIC_API_KEY) ? await callNarrativeLLM(needNarr) : {};
    for (const [t, v] of Object.entries(llm)) { const e = cache[t] || {}; e.nv = v; e.nvTs = now; cache[t] = e; }
    // Fundamentals + insider: refresh names whose cached copy is >6h old (so the
    // daily cron refreshes once, but the 1M/3M/6M variants in one run don't each
    // re-hit Finnhub). Keep last-known-good on a failed call.
    if (process.env.FINNHUB_API_KEY) {
      const needFi = candidates.filter(c => { const e = cache[c.ticker.toUpperCase()]; return !(e && e.fiTs && now - e.fiTs < 6 * 60 * 60 * 1000); });
      await mapLimit(needFi, 8, async (c) => {
        const t = c.ticker.toUpperCase();
        try {
          const [f, ins] = await Promise.all([fetchFundamentals(c.ticker), fetchInsiders(c.ticker)]);
          const e = cache[t] || {};
          if (f) e.fund = f;
          if (ins) e.ins = ins;
          e.fiTs = now; cache[t] = e;
        } catch {}
      });
    }
    if (hasStore()) { try { await writeJSON(enrichKey(scope), { updatedAt: now, n: Object.keys(cache).length, data: cache }, 0); } catch {} }
  }

  // Attach cached enrichment onto each candidate (null where not yet built).
  for (const c of candidates) {
    const e = cache[c.ticker.toUpperCase()] || {};
    c.fundamentals = e.fund || null;
    c.insider = e.ins || null;
    c.narrative = e.nv ? e.nv.narrative : null;
    c.narrativeStrength = e.nv ? e.nv.narrativeStrength : null;
    c.theme = e.nv ? e.nv.theme : null;
  }
}

module.exports = async function handler(req, res) {
  const reqT0 = Date.now();
  const mark = {};
  const scope = (req.query.scope || 'large').toLowerCase();
  const isMicro = scope === 'micro';
  const isSmallScope = scope === 'small' || isMicro;

  // Build the universe for this scope (dedupe; tag cap tier)
  let list, tier, cap;
  if (isMicro)            { list = MICRO_CAPS; tier = 'Micro'; cap = 10; }
  else if (scope === 'small') { list = SMALL_CAPS; tier = 'Small'; cap = 10; }
  else                    { list = LARGE; tier = 'Large'; cap = 20; }
  // Optional filters
  const sectorFilter = (req.query.sector || 'all');
  const exchangeFilter = (req.query.exchange || 'all').toUpperCase();
  // Gate mode: 'relaxed' (default) drops the dead volume/base hard-gates so picks
  // surface in trending tapes; 'strict' restores the classic 4-filter breakout.
  const gate = (req.query.gate || 'relaxed').toLowerCase() === 'strict' ? 'strict' : 'relaxed';

  let tickers = [...new Set(list)];
  if (sectorFilter && sectorFilter !== 'all') tickers = tickers.filter(t => (SECTOR_OF[t] || 'Other') === sectorFilter);
  const universe = tickers.map(t => ({ t, tier }));

  // Looser, volatility-appropriate thresholds for smaller, choppier names
  const screenOpts = isMicro
    ? { gate, baseMax: 0.60, setupBelow: 0.18, earlyAbove: 0.15, moveMax: 0.70, setupHighGate: 0.55, setupMaGate: 0.88 }
    : scope === 'small'
    ? { gate, baseMax: 0.45, setupBelow: 0.10, earlyAbove: 0.12, moveMax: 0.60, setupHighGate: 0.35, setupMaGate: 0.93 }
    : { gate };

  // Historical rotation: replay the screen at these trading-day offsets (full
  // universe only, so the tilts are comparable across time).
  const wantHistory = !isSmallScope && sectorFilter === 'all' && exchangeFilter === 'ALL';
  const LB = { '1M': { span: 21, points: 6 }, '3M': { span: 63, points: 7 }, '6M': { span: 126, points: 7 } };
  const lookback = LB[(req.query.lookback || '1M').toUpperCase()] ? (req.query.lookback || '1M').toUpperCase() : '1M';
  const HIST_OFFSETS = (() => {
    const { span, points } = LB[lookback];
    const step = span / (points - 1), a = [];
    for (let k = points - 1; k >= 0; k--) a.push(Math.round(step * k));
    return [...new Set(a)];
  })();

  // Candle cache: read the pre-built per-scope candle doc (one fast Blob download)
  // instead of ~515 latency-bound Yahoo calls. The daily warm cron (x-warm header)
  // rebuilds it; user requests only read. Sector-filtered requests still read the
  // full-scope cache and subset it — only the unfiltered universe may WRITE it.
  const isWarm = !!(req.headers['x-warm'] || req.query.warm);
  const isFullUniverse = sectorFilter === 'all';

  try {
    // Kick off the macro (VIX + credit) read immediately so it overlaps the scan
    // instead of adding latency at the end.
    const macroPromise = fetchMacro().catch(() => null);
    const cacheDoc = await loadCandleCache(scope);
    mark.cacheLoad = Date.now() - reqT0;
    const { use: useCache } = cacheState(cacheDoc, isWarm);
    const freshFetched = new Map();   // tickers we hit Yahoo for this request
    // Benchmark (SPY) once — drives the RS line and the market-regime read.
    let spyCandles = null, spyByDate = null;
    try {
      const spy = await fetchDailyHistory('SPY');
      if (spy) { spyCandles = spy.candles; spyByDate = {}; spy.candles.forEach(x => { spyByDate[x.date] = x.close; }); }
    } catch {}
    const baseOpts = spyByDate ? { ...screenOpts, spyByDate } : screenOpts;

    // 1. Scan — prefer cached candles; fall back to a live Yahoo fetch per miss.
    const scored = await mapLimit(universe, 18, async ({ t, tier }) => {
      try {
        let data = useCache ? cacheGet(cacheDoc, t) : null;
        if (!data) { data = await fetchDailyHistory(t); if (data) freshFetched.set(t, data); }
        if (!data) return null;
        const r = screenTicker(data.candles, { ...data.meta, symbol: t }, wantHistory ? { ...baseOpts, history: HIST_OFFSETS } : baseOpts);
        if (!r) return null;
        if (!r.ticker) r.ticker = t;
        r.capTier = tier;
        return r;
      } catch { return null; }
    });

    let valid = scored.filter(Boolean);

    // Persist the (re)built candle cache on warm cron requests so every later
    // request — and the other cron lookback variants — reads it instead of
    // re-scanning Yahoo. Only the full unfiltered universe writes.
    if (isWarm && isFullUniverse && freshFetched.size) {
      const fullMap = new Map();
      for (const { t } of universe) {
        const d = freshFetched.get(t) || (useCache ? cacheGet(cacheDoc, t) : null);
        if (d) fullMap.set(t, d);
      }
      try { await saveCandleCache(scope, fullMap); } catch {}
    }
    mark.scan = Date.now() - reqT0;

    // Liquidity floor so results are actually tradeable
    if (isSmallScope) {
      const floor = isMicro ? 300000 : 2000000;
      valid = valid.filter(c => (c.factors.dollarVol || 0) >= floor);
    }

    // Exchange filter (from live chart meta)
    if (exchangeFilter && exchangeFilter !== 'ALL') {
      valid = valid.filter(c => (c.exchange || '').toUpperCase() === exchangeFilter);
    }

    // Sector rotation: how many names per sector qualified vs. were scanned
    const rot = {};
    valid.forEach(c => {
      const s = c.sector || 'Other';
      (rot[s] = rot[s] || { sector: s, scanned: 0, hits: 0, breakouts: 0 });
      rot[s].scanned++;
      if (c.include) rot[s].hits++;
      if (c.qualifies) rot[s].breakouts++;
    });
    const totHits = Object.values(rot).reduce((a, r) => a + r.hits, 0) || 1;
    const totScan = Object.values(rot).reduce((a, r) => a + r.scanned, 0) || 1;
    const rotation = Object.values(rot).map(r => {
      const breakoutShare = +((r.hits / totHits) * 100).toFixed(1);   // % of today's breakouts
      const universeShare = +((r.scanned / totScan) * 100).toFixed(1); // % of the scanned index
      return {
        ...r,
        hitRate: r.scanned ? +((r.hits / r.scanned) * 100).toFixed(0) : 0,
        breakoutShare,
        universeShare,
        tilt: +(breakoutShare - universeShare).toFixed(1), // >0 overweight, <0 underweight
      };
    }).sort((a, b) => b.tilt - a.tilt);

    // Replayed rotation tilts over time (oldest → newest)
    let rotationHistory = null;
    if (wantHistory) {
      const ref = valid.find(c => Array.isArray(c.history) && c.history.length);
      const offDate = {}; (ref?.history || []).forEach(h => { offDate[h.off] = h.date; });
      const cps = HIST_OFFSETS.map(off => ({ off, rot: {} }));
      valid.forEach(c => (c.history || []).forEach(h => {
        const cp = cps.find(x => x.off === h.off); if (!cp) return;
        const s = c.sector || 'Other';
        (cp.rot[s] = cp.rot[s] || { scanned: 0, hits: 0 });
        cp.rot[s].scanned++; if (h.include) cp.rot[s].hits++;
      }));
      rotationHistory = cps.map(cp => {
        const totH = Object.values(cp.rot).reduce((a, r) => a + r.hits, 0) || 1;
        const totS = Object.values(cp.rot).reduce((a, r) => a + r.scanned, 0) || 1;
        const tilts = {};
        for (const [s, r] of Object.entries(cp.rot)) tilts[s] = +(((r.hits / totH) * 100) - ((r.scanned / totS) * 100)).toFixed(1);
        return { daysAgo: cp.off, date: offDate[cp.off] || null, tilts };
      });
    }

    // 2. Quant percentiles across the scanned peer group
    attachPercentiles(valid, {
      mom63:    c => c.factors.mom63,
      mom126:   c => c.factors.mom126,
      trend:    c => c.factors.trendTemplate,
      volAdj:   c => c.factors.volAdjMom,
      volSurge: c => c.factors.volSurge,
      base:     c => c.factors.baseQuality,
      prox:     c => c.factors.proximity,
      accum:    c => c.metrics.accumRatio,
      ud:       c => c.metrics.udVol,
    });
    valid.forEach(c => { c.pct = pctComponents(c); c.quant = { score: composite(c.pct, DEFAULT_WEIGHTS) }; });

    // 3. Keep breakouts/setups, rank by default composite (breakouts first).
    //    Return a buffer beyond `cap` so client re-weighting can swap names in.
    const buffer = cap + (isSmallScope ? 6 : 8);
    let candidates = valid.filter(c => c.include).sort((a, b) => {
      if (a.qualifies !== b.qualifies) return a.qualifies ? -1 : 1;
      return b.quant.score - a.quant.score;
    }).slice(0, buffer);

    // 4. Enrich candidates — LLM narrative + real fundamentals + insider data —
    //    ALL IN PARALLEL (independent calls). Previously serialized, which made a
    //    cold screener ~26s once picks started flowing; parallel cuts it to ~the
    //    slowest single leg. Fundamentals + insider attach to the pre-map objects.
    await enrichCandidates(candidates, isWarm, scope);
    mark.enrich = Date.now() - reqT0;
    candidates = candidates.map(c => ({
      ticker: c.ticker, company: c.company, capTier: c.capTier,
      sector: c.sector, exchange: c.exchange, aboveSma200: c.aboveSma200,
      status: c.status, qualifies: c.qualifies,
      price: c.price, changePct: c.changePct,
      filters: c.filters,
      criteria: { ...c.criteria, narrative: c.narrativeStrength != null ? c.narrativeStrength >= 6 : false },
      metrics: c.metrics, levels: c.levels, factors: c.factors,
      pct: c.pct, quant: c.quant, reasons: c.reasons,
      fundamentals: c.fundamentals || null, insider: c.insider || null,
      narrative: c.narrative, narrativeStrength: c.narrativeStrength, theme: c.theme,
    }));

    // ── Market regime (large/unfiltered only): SPY vs 200-DMA + breadth ──
    let regime = null;
    if (!isSmallScope && sectorFilter === 'all' && exchangeFilter === 'ALL') {
      let indexAbove200 = null;
      if (spyCandles) { const cl = spyCandles.map(x => x.close), li = cl.length - 1, s200 = smaAt(cl, 200, li); indexAbove200 = s200 != null ? cl[li] > s200 : null; }
      const breadthPct = valid.length ? Math.round((valid.filter(c => c.above50).length / valid.length) * 100) : null;
      // Bearish regime: SPY below its 200-DMA OR fewer than 40% of names above
      // their 50-DMA. Breakouts fail at much higher rates here, so the UI warns
      // and downgrades long breakout scores when this is true.
      const bearish = indexAbove200 === false || (breadthPct != null && breadthPct < 40);
      regime = {
        indexAbove200,
        breadthPct,
        bearish,
        riskOn: indexAbove200 === true && (breadthPct == null || breadthPct >= 45),
      };
    }

    // ── Ghost Accumulation Index (GAI) — score the candidate pool through an
    //    accumulation lens, server-side (single source of truth in lib/ghost.js).
    //    Regime now blends the SPY-trend read with the VIX/credit MACRO layer
    //    (leads the index), and risk-off flips the kill switch (tiers downgraded).
    let macro = null;
    try { macro = await macroPromise; } catch {}
    const macroRiskOff = !!(macro && macro.riskOff);
    const ghostRegimeInput = {
      bearish: !!(regime && regime.bearish) || macroRiskOff,
      riskOn: !!(regime && regime.riskOn) && (!macro || macro.riskOn),
    };
    const ghostResult = runGhostAccumulationIndex(candidates, ghostRegimeInput, {
      killSwitch: !!(regime && regime.bearish) || macroRiskOff,
    });
    const ghostByTicker = {};
    for (const g of ghostResult.longs) {
      ghostByTicker[g.symbol] = { pillars: g.pillars, score: g.score, strongPillars: g.strongPillars, tier: g.tier };
    }
    candidates.forEach(c => { c.ghost = ghostByTicker[c.ticker] || null; });

    // ── Conviction score (Edge Book · Sleeve A) — the regime-gated ranker the
    //    walk-forward harness validated (momentum core + BONUS, IN dropped),
    //    computed LIVE over the GAI pillars. Sleeve A = top-quintile conviction
    //    names, long-eligible only when the regime gate allows (not risk-off).
    const convRegime = ghostResult.regime;
    const convCanLong = longOk(convRegime);
    const convVals = [];
    candidates.forEach(c => {
      const score = c.ghost ? convictionScore(c.ghost.pillars, convRegime) : null;
      c.conviction = score != null ? { score } : null;
      if (score != null) convVals.push(score);
    });
    const convSorted = [...convVals].sort((a, b) => a - b);
    const convPctile = x => { if (!convSorted.length) return null; let lo = 0, hi = convSorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (convSorted[m] <= x) lo = m + 1; else hi = m; } return Math.round((lo / convSorted.length) * 100); };
    candidates.forEach(c => {
      if (!c.conviction) return;
      c.conviction.pctile = convPctile(c.conviction.score);
      c.conviction.sleeveA = convCanLong && c.conviction.pctile >= 80;   // top quintile, long-eligible
    });

    // Fresh for 15m; then serve the STALE cached response INSTANTLY for up to a
    // day while revalidating in the background. With the daily warm cron this
    // means users almost never wait on a cold (~15s) screener build.
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=86400');
    return res.json({
      ghost: { regime: ghostResult.regime, killSwitch: ghostResult.killSwitch, weights: GHOST_WEIGHTS[ghostResult.regime], pillarLabels: GHOST_PILLAR_LABEL, macro },
      conviction: { regime: convRegime, longOk: convCanLong, weights: convictionWeights(convRegime), sleeveACount: candidates.filter(c => c.conviction && c.conviction.sleeveA).length },
      scope,
      cap,
      gateMode: gate,
      textbookBreakouts: valid.filter(c => c.passesAll4).length,
      sector: sectorFilter,
      exchange: exchangeFilter.toLowerCase() === 'all' ? 'all' : exchangeFilter,
      rotation,
      rotationHistory,
      regime,
      lookback,
      candleSource: useCache ? 'cache' : 'live',
      candlesFetched: freshFetched.size,
      timings: { cacheLoadMs: mark.cacheLoad, scanMs: mark.scan, enrichMs: (mark.enrich || 0) - (mark.scan || 0), totalMs: Date.now() - reqT0 },
      results: candidates,
      defaultWeights: DEFAULT_WEIGHTS,
      scannedCount: valid.length,
      breakoutCount: valid.filter(c => c.qualifies).length,
      narrativeEnabled: candidates.some(c => c.narrative),
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(502).json({ error: 'Screener failed: ' + e.message, results: [] });
  }
};

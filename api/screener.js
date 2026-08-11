const Anthropic = require('@anthropic-ai/sdk');
const { fetchDailyHistory, screenTicker } = require('../lib/screener');
const { LARGE, SMALL_CAPS, MICRO_CAPS, SECTOR_OF } = require('../lib/universe');
const { fetchFundamentals, fetchInsiders } = require('../lib/fundamentals');
const { runGhostAccumulationIndex, REGIME_WEIGHTS: GHOST_WEIGHTS, PILLAR_LABEL: GHOST_PILLAR_LABEL } = require('../lib/ghost');
const { convictionScore, convictionWeights, longOk } = require('../lib/conviction');
const apex = require('../lib/apex');
const { composeWhyNow } = require('../lib/whynow');
const { fetchMacro } = require('../lib/macro');
const { loadCandleCache, cacheState, cacheGet, saveCandleCache } = require('../lib/candle-cache');
const { rankOnly } = require('../lib/rank-semantics');
const { isTrusted, cronSecret } = require('../lib/auth');
const { readJSON, writeJSON, hasStore } = require('../lib/store');
const { fetchShortInterest, siFlag } = require('../lib/shortinterest');

// Union universe, for shrinking the FINRA short-interest payload to names we screen.
const UNIVERSE_SET = new Set([...LARGE, ...SMALL_CAPS, ...MICRO_CAPS]);

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

// SHARED SELECTION ENGINE (Screener Replay v3). Percentiles, the quant composite,
// scope thresholds, freshness gate, liquidity floor, regime and the admission/
// buffer selection all live in lib/swing-screener-engine.js — ONE implementation
// used by this live route AND by historical replay (lib/swing-replay-v3.js), so
// a backtest claim about "the screener" is provably about THIS selection. The
// default weights (Tune-panel overridable client-side; keep in sync with
// SCR_DEFAULT_W in public/js/app.js) are ENGINE.DEFAULT_WEIGHTS.
const ENGINE = require('../lib/swing-screener-engine');
const DEFAULT_WEIGHTS = ENGINE.DEFAULT_WEIGHTS;

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

// Every log line emitted while handling this request carries the op that caused it,
// so a `no daily data` warning names its own caller instead of having to be inferred.
const { withLogContext } = require('../lib/log');

module.exports = async function handler(req, res) {
  return withLogContext({ op: String(req.query.op || 'screen'), route: '/api/screener' }, () => handleRequest(req, res));
};

async function handleRequest(req, res) {
  const reqT0 = Date.now();
  const mark = {};
  const scope = (req.query.scope || 'large').toLowerCase();
  const isMicro = scope === 'micro';
  const isBiotech = scope === 'biotech';
  // Biotech is a cross-cap but high-volatility set → use the looser small-scope thresholds.
  const isExpanded = scope === 'expanded';
  const isSmallScope = scope === 'small' || isMicro || isBiotech || isExpanded;

  // The 'expanded' scope (free full-market universe, Phase 2) has no hard-coded
  // list — its tickers ARE the keys of its pre-built candle cache (read-only here;
  // op=universescan/compile own that doc).
  let expandedDoc = null;
  if (isExpanded) expandedDoc = await loadCandleCache('expanded').catch(() => null);

  // Build the universe for this scope (dedupe; tag cap tier)
  let list, tier, cap;
  if (isExpanded)         { list = expandedDoc && expandedDoc.data ? Object.keys(expandedDoc.data) : []; tier = 'Expanded'; cap = 10; }
  else if (isMicro)       { list = MICRO_CAPS; tier = 'Micro'; cap = 10; }
  else if (scope === 'small') { list = SMALL_CAPS; tier = 'Small'; cap = 10; }
  else if (isBiotech)     { list = require('../lib/universe').BIOTECH; tier = 'Biotech'; cap = 12; }
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
    : (scope === 'small' || isExpanded)
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
  // The warm flag forces a full live scan + cache write, so it must be a trusted
  // (cron) caller once CRON_SECRET is configured — otherwise anyone could append
  // ?warm=1 to trigger the ~515-ticker scan on demand. Fail-open until the secret
  // is set so the cron keeps rebuilding in the unconfigured deploy window.
  const warmRequested = !!(req.headers['x-warm'] || req.query.warm);
  const isWarm = warmRequested && (!cronSecret() || isTrusted(req));
  const isFullUniverse = sectorFilter === 'all';

  try {
    // Kick off the macro (VIX + credit) read immediately so it overlaps the scan
    // instead of adding latency at the end.
    const macroPromise = fetchMacro().catch(() => null);
    const cacheDoc = isExpanded ? expandedDoc : await loadCandleCache(scope);
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
        // Per-entry freshness provenance (defect #3): the candidate's own last bar
        // date is the ONLY freshness fact a compiled multi-shard cache can't forge.
        r.lastBarDate = data.candles.length ? data.candles[data.candles.length - 1].date : null;
        r.dataProvenance = data.provenance || null;
        return r;
      } catch { return null; }
    });

    let valid = scored.filter(Boolean);

    // Persist the (re)built candle cache on warm cron requests so every later
    // request — and the other cron lookback variants — reads it instead of
    // re-scanning Yahoo. Only the full unfiltered universe writes.
    if (isWarm && isFullUniverse && freshFetched.size && !isExpanded) {   // never overwrite the compiled expanded cache
      const fullMap = new Map();
      for (const { t } of universe) {
        const d = freshFetched.get(t) || (useCache ? cacheGet(cacheDoc, t) : null);
        if (d) fullMap.set(t, d);
      }
      try { await saveCandleCache(scope, fullMap); } catch {}
    }
    mark.scan = Date.now() - reqT0;

    // Exchange filter (from live chart meta) — applied BEFORE the cross-sectional
    // engine so the percentile cohort is the filtered universe, exactly as before.
    if (exchangeFilter && exchangeFilter !== 'ALL') {
      valid = valid.filter(c => (c.exchange || '').toUpperCase() === exchangeFilter);
    }

    // Macro (VIX + credit) resolves BEFORE selection — the engine's emerging-leader
    // admission arm is macro-gated. The promise was kicked off at request start.
    let macro = null;
    try { macro = await macroPromise; } catch {}
    const macroRiskOff = !!(macro && macro.riskOff);

    // ── SHARED SELECTION ENGINE (Screener Replay v3) ──────────────────────────
    // Freshness gate (defect #3) → liquidity floor → same-date cohort percentiles
    // + quant composite → regime → admission (status gate + regime-gated emerging
    // arm) → deterministic buffer selection, with a reason-coded rejection for
    // every evaluated name. Identical code path to historical replay.
    const sel = ENGINE.selectCandidates({
      rows: valid, scope, spyCandles, macroRiskOff,
      regimeEligible: sectorFilter === 'all' && exchangeFilter === 'ALL',
    });
    valid = sel.cohort;
    const regime = sel.regime;
    const freshness = sel.freshness;
    let candidates = sel.candidates;

    // CFL decision snapshot (warm cron, canonical unfiltered universe only): persist
    // the FULL reason-coded decision record — including every rejection the response
    // below truncates to 50 — so misses can later be attributed to a real stage
    // instead of guessed. Idempotent per (scope, session); never throws.
    if (isWarm && isFullUniverse && exchangeFilter === 'ALL' && freshness && freshness.decisionSession) {
      const SCHEMA = require('../lib/swing-candidate-schema');
      await require('../lib/cfl/capture').captureDecisionSnapshot({
        sel, scope, decisionDate: freshness.decisionSession, macroRiskOff,
        engineVersion: ENGINE.ENGINE_VERSION, scoringVersion: 'screener-v1',
        candidateSetHash: SCHEMA.candidateSetHash(sel.candidates.slice(0, sel.cap).map(c => SCHEMA.candidateId({
          strategyId: 'screener', scoringVersion: 'screener-v1', universeScope: scope,
          ticker: c.ticker, decisionCutoff: freshness.decisionSession,
        }))),
        dataCutoff: freshness.decisionSession,
      });
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

    // Percentiles, regime, admission and the buffer were all computed by the shared
    // engine above (sel.cohort / sel.regime / sel.candidates). The admission rule is
    // unchanged: ranked PURELY by the (cleaned) quant composite, with the regime- and
    // macro-gated emergingLeader arm (lib/emerging.js shipGated study; LARGE only,
    // never in risk-off). See lib/swing-screener-engine.js for the single source.

    // 4. Enrich candidates — LLM narrative + real fundamentals + insider data —
    //    ALL IN PARALLEL (independent calls). Previously serialized, which made a
    //    cold screener ~26s once picks started flowing; parallel cuts it to ~the
    //    slowest single leg. Fundamentals + insider attach to the pre-map objects.
    // Short interest fetched in parallel with enrichment (cached/memoized, ~free after
    // first). It's a SOFT AVOIDANCE FLAG only (research/26-si: high SI% is a significant
    // negative predictor but short-side + regime-fragile) — it is NOT fed into the
    // validated quant/GAI composites; it only annotates the displayed cards.
    const siPromise = fetchShortInterest(UNIVERSE_SET).catch(() => null);
    await enrichCandidates(candidates, isWarm, scope);
    mark.enrich = Date.now() - reqT0;
    const siData = await siPromise;
    candidates = candidates.map(c => ({
      ticker: c.ticker, company: c.company, capTier: c.capTier,
      sector: c.sector, exchange: c.exchange, aboveSma200: c.aboveSma200,
      status: c.status, qualifies: c.qualifies, emergingLeader: c.emergingLeader,
      lastBarDate: c.lastBarDate || null, dataProvenance: c.dataProvenance || null,
      price: c.price, changePct: c.changePct,
      filters: c.filters,
      criteria: { ...c.criteria, narrative: c.narrativeStrength != null ? c.narrativeStrength >= 6 : false },
      metrics: c.metrics, levels: c.levels, factors: c.factors,
      pct: c.pct, quant: c.quant, reasons: c.reasons,
      // Defect #7: the quant composite is a same-date cross-sectional RANKING score
      // (0-100 blend of factor percentiles). Not a probability; none exists here.
      rankSemantics: rankOnly(c.quant && c.quant.score),
      fundamentals: c.fundamentals || null, insider: c.insider || null,
      shortInterest: siData ? siFlag(siData.bySymbol[c.ticker.toUpperCase()], c.fundamentals && c.fundamentals.sharesOut) : null,
      narrative: c.narrative, narrativeStrength: c.narrativeStrength, theme: c.theme,
    }));
    const shortInterestAsOf = siData ? siData.settlementDate : null;

    // ── Ghost Accumulation Index (GAI) — score the candidate pool through an
    //    accumulation lens, server-side (single source of truth in lib/ghost.js).
    //    `regime` + `macro`/`macroRiskOff` were computed ABOVE (before selection).
    // Market TAPE (trend vs chop) from SPY efficiency ratio — breakouts fail in
    // choppy tapes too, so the UI downgrades them there (in addition to bearish).
    if (regime && spyCandles) {
      try { regime.condition = require('../lib/confluence').marketCondition(spyCandles, (regime.bearish || macroRiskOff) ? 'risk-off' : 'neutral'); } catch {}
    }
    const ghostRegimeInput = {
      bearish: !!(regime && regime.bearish) || macroRiskOff,
      riskOn: !!(regime && regime.riskOn) && (!macro || macro.riskOn),
    };
    // GAI + conviction are scored over the FULL scanned cross-section (`valid`),
    // NOT the ~28-name display buffer. The walk-forward harness that validated the
    // conviction ranker defines "top-quintile" over the whole cohort, so scoring
    // only the pre-sorted buffer here would ship a DIFFERENT ranker than the one
    // back-tested (train/serve skew). Pillar percentiles are already cross-sectional
    // over `valid`; only the buffer carries real BONUS/IN enrichment — the rest use
    // neutral 50, exactly as the harness pins those pillars where no feed exists.
    const ghostResult = runGhostAccumulationIndex(valid, ghostRegimeInput, {
      killSwitch: !!(regime && regime.bearish) || macroRiskOff,
    });
    const ghostByTicker = {};
    for (const g of ghostResult.longs) {
      ghostByTicker[g.symbol] = { pillars: g.pillars, score: g.score, strongPillars: g.strongPillars, tier: g.tier };
    }
    candidates.forEach(c => { c.ghost = ghostByTicker[c.ticker] || null; });

    // WHY NOW verdict badge — the SAME pure composer the lookup modal uses
    // (lib/whynow), computed once here so every card can show a consistent, honest
    // one-word read (constructive / watch / caution / quiet) without a per-card call.
    // Track records + read-through are omitted for the badge (they don't change the
    // LEVEL); the risk-off macro veto and the ghost/apex/conviction signals do.
    const rgStr = apex.rawRegime(regime);
    // Apex counts toward the verdict ONLY for names in the breakout candidate set —
    // the exact rule the lookup modal (op=whynow) uses, so a card and its modal never
    // disagree. A quietly-accumulating Ghost name that isn't breaking out is not
    // credited breakout momentum here.
    const breakoutSet = new Set(candidates.map(c => c.ticker));
    const whyNowFor = (c, ghost, conviction) => {
      let apexHit = null;
      if (breakoutSet.has(c.ticker)) {
        try { const sc = apex.scoreCandidate(c, rgStr, null); if (sc.tier) apexHit = { tier: sc.tier, score: sc.score }; } catch { /* pillars missing → no apex */ }
      }
      const ghostHit = ghost ? { tier: ghost.tier, score: ghost.score, strongPillars: ghost.strongPillars || [] } : null;
      const r = composeWhyNow({ ticker: c.ticker, apex: apexHit, ghost: ghostHit, conviction: conviction || null, macro });
      // `standout` = the strongest tier of confirmation (confirmed breakout OR
      // top-quintile conviction). The card badge shows a green flag only for these;
      // a plain "constructive" is the norm for a curated list, so it's suppressed to
      // keep the badge informative (watch/caution always show).
      const standout = !!(conviction && conviction.sleeveA) || (apexHit && apexHit.tier === 'apex');
      return { level: r.verdict.level, headline: r.verdict.headline, forCount: r.forCase.length, standout };
    };

    // Ghost is scored over the FULL scanned cross-section (`valid`), not just the
    // breakout candidates — so surface the top accumulation names regardless of
    // whether they're breaking out. This is what makes the 👻 Ghost tab a real
    // full-universe accumulation scan instead of a re-rank of the breakout pool.
    // Each row carries the POINT-IN-TIME fields the downstream pre-move pipeline
    // needs (decision price, levels, liquidity, pillar snapshot, cutoff, scope) —
    // previously only display fields survived, which stranded standalone
    // quiet-accumulation names from every decision/learning path. Missing data is
    // MARKED missing (explicit `missing` list), never imputed.
    const ghostDataCutoff = (spyCandles && spyCandles.length) ? spyCandles[spyCandles.length - 1].date : null;
    const ghostTop = valid
      .map(c => ({ c, g: ghostByTicker[c.ticker] }))
      .filter(x => x.g && x.g.tier !== 'PASS')
      .sort((a, b) => b.g.score - a.g.score)
      .slice(0, 40)
      .map(({ c, g }) => ({
        ticker: c.ticker, company: c.company, sector: c.sector, exchange: c.exchange,
        price: c.price, changePct: c.changePct, aboveSma200: c.aboveSma200,
        levels: c.levels || null, ghost: g,
        insider: c.insider || null, fundamentals: c.fundamentals || null,
        whynow: whyNowFor(c, g, null),
        // Point-in-time provenance for the pre-move pipeline (Phase 1):
        status: c.status || null,
        capTier: c.capTier || null,
        dollarVol: (c.factors && Number.isFinite(c.factors.dollarVol)) ? c.factors.dollarVol : null,
        liqTier: isMicro ? 'micro' : (isBiotech ? 'biotech' : (isSmallScope ? 'small' : 'liquid')),
        featureSnapshot: { pct: c.pct || null, quant: c.quant || null, metrics: c.metrics ? {
          pivot: c.metrics.pivot, accumRatio: c.metrics.accumRatio, udVol: c.metrics.udVol,
          adrPct: c.metrics.adrPct, pctFrom52wHigh: c.metrics.pctFrom52wHigh,
        } : null },
        universeScope: scope,
        universeSize: valid.length,
        dataCutoff: ghostDataCutoff,
        inBreakoutResults: breakoutSet.has(c.ticker),
        missing: [
          ...(c.levels ? [] : ['levels']),
          ...((c.factors && Number.isFinite(c.factors.dollarVol)) ? [] : ['dollarVol']),
          ...(c.fundamentals ? [] : ['fundamentals']),
          ...(c.insider ? [] : ['insider']),
          ...(ghostDataCutoff ? [] : ['dataCutoff']),
        ],
      }));

    // ── Conviction score (Edge Book · Sleeve A) — the regime-gated ranker the
    //    walk-forward harness validated (momentum core + BONUS, IN dropped).
    //    Sleeve A = top-quintile conviction across the FULL cross-section (the same
    //    denominator the harness used), long-eligible only when the regime gate
    //    allows (not risk-off). The displayed candidates then read their percentile
    //    off this whole-cohort distribution.
    const convRegime = ghostResult.regime;
    const convCanLong = longOk(convRegime);
    const convAll = [];
    for (const g of ghostResult.longs) {
      const score = convictionScore(g.pillars, convRegime);
      if (score != null) convAll.push(score);
    }
    const convSorted = convAll.sort((a, b) => a - b);
    const convPctile = x => { if (!convSorted.length) return null; let lo = 0, hi = convSorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (convSorted[m] <= x) lo = m + 1; else hi = m; } return Math.round((lo / convSorted.length) * 100); };
    candidates.forEach(c => {
      const score = c.ghost ? convictionScore(c.ghost.pillars, convRegime) : null;
      if (score == null) { c.conviction = null; return; }
      const pctile = convPctile(score);
      c.conviction = { score, pctile, sleeveA: convCanLong && pctile >= 80 };   // top quintile of the full cohort, long-eligible
    });
    // Attach the WHY NOW verdict now that ghost + conviction are on each candidate.
    candidates.forEach(c => { c.whynow = whyNowFor(c, c.ghost, c.conviction); });

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
      freshness,
      dataCutoff: freshness.decisionSession || ghostDataCutoff || null,
      // Live candidate-observation record (Screener Replay v3): the same
      // engine/hash the replay computes, so any served selection can be compared
      // against a replay of the same session — a mismatch fails parity.
      selection: {
        engineVersion: ENGINE.ENGINE_VERSION,
        candidateSetHash: require('../lib/swing-candidate-schema').candidateSetHash(
          candidates.slice(0, cap).map(c => require('../lib/swing-candidate-schema').candidateId({
            strategyId: 'screener', scoringVersion: 'screener-v1', universeScope: scope,
            ticker: c.ticker, decisionCutoff: freshness.decisionSession || ghostDataCutoff || 'unknown',
          }))),
        selectedCount: Math.min(cap, candidates.length),
        rejectionCounts: sel.rejections.reduce((m, r) => { m[r.reason] = (m[r.reason] || 0) + 1; return m; }, {}),
        rejections: sel.rejections.slice(0, 50),
      },
      timings: { cacheLoadMs: mark.cacheLoad, scanMs: mark.scan, enrichMs: (mark.enrich || 0) - (mark.scan || 0), totalMs: Date.now() - reqT0 },
      results: candidates,
      ghostTop,
      defaultWeights: DEFAULT_WEIGHTS,
      shortInterestAsOf,
      scannedCount: valid.length,
      breakoutCount: valid.filter(c => c.qualifies).length,
      narrativeEnabled: candidates.some(c => c.narrative),
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(502).json({ error: 'Screener failed: ' + e.message, results: [] });
  }
};

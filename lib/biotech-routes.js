// 🧬 BIOTECH SWING ENGINE — routes. Ops:
//   op=biotechtick  : full pipeline (universe → detect → evidence retrieval → deterministic
//                     capital + verified-event ledger → bounded AI interpretation → assemble
//                     archetype/plan/gates/score → lifecycle episodes → immutable ledger + cache).
//                     Slow (~50s, one bounded AI call). Cron/force only.
//   op=biotech      : serve the cached board (fast, never blocks on AI). Back-compat items[].
//   op=biotechgrade : multi-horizon (3/5/10/21) XBI-relative grading of resolved episodes,
//                     stratified by archetype. Measurement only — changes NO live weight.
// Benchmarked vs XBI. Governance maturity, eligibility, and production weight are UNCHANGED:
// biotech still feeds decision.js as `catalystForcedFlow`/`event` exactly as before, and the
// Research-Priority number is NOT a probability.
const { readJSON, writeJSON, hasStore, writeBiotechDay, readAllBiotechDays } = require('./store');
const { assembleCandidate } = require('./biotech-engine');
const { buildBiotechEpisodes } = require('./biotech-episodes');
const { gradeBiotechEpisode, summarize, summarizeByArchetype } = require('./biotech-grade');
const { buildEvidenceBundle, parseAssessment, investigate } = require('./biotech-ai');
const { classifyCapitalState, offeringFlagsFromNews } = require('./biotech-capital');
const { makeEvent, makeSource } = require('./biotech-events');
const { findEventBar } = require('./biotech-features');
const { biotechRegime } = require('./biotech-regime');
const { buildUniverse, coverageReport } = require('./biotech-universe');
const { isBiotechRunner } = require('./biotech');
const { DETECT, MICRO_DOLLAR_VOL, BIOTECH_ETF, VALIDATION_FLOORS, HORIZONS } = require('./biotech-config');

const CACHE_KEY = 'biotech/latest.json';
const EPISODES_KEY = 'biotech/episodes.json';
const GRADE_KEY = 'biotech/grade.json';
const REFRESH_MS = 6 * 60 * 60 * 1000;
const EVIDENCE_DEADLINE_MS = 22000;         // cap per-name deterministic retrieval before the AI call
const MAX_INVESTIGATE = 8;
const DETECT_LIMIT = 30;
const DISCLAIMER = 'Verified, liquid, properly-timed biotech swing setups — separated from unresolved binaries, dilution traps, illiquid promotions, M&A near offer, and already-consumed moves. The 0–100 value is a RESEARCH PRIORITY (attention ordering), NOT a probability. Actionability is capped by independent severe-loss and dilution gates. A research lead, not a buy signal — biotech binary events cut both ways.';

// XBI (and SPY) daily candles for the benchmark / regime / grading.
async function benchCandles(sym, range = '1y') {
  try { const { fetchDailyHistory } = require('./screener'); const d = await fetchDailyHistory(sym, range); return (d && d.candles) || []; }
  catch { return []; }
}

// Sources to scan = curated BIOTECH ∪ biotech-named expanded universe (candles from their caches).
async function biotechScanSources() {
  const { loadCandleCache, cacheGet } = require('./candle-cache');
  const [bioDoc, expDoc] = await Promise.all([loadCandleCache('biotech').catch(() => null), loadCandleCache('expanded').catch(() => null)]);
  let expanded = [];
  try {
    const doc = await readJSON('universe/candidates.json', null);
    if (doc && Array.isArray(doc.tickers)) expanded = doc.tickers.map(t => ({ symbol: t.symbol, name: t.name }));
  } catch { /* degrade */ }
  const uni = buildUniverse({ expanded });
  const sources = [];
  for (const m of uni.members) {
    const doc = m.source === 'curated' ? bioDoc : expDoc;
    if (doc && cacheGet(doc, m.symbol)) sources.push({ ticker: m.symbol, doc });
    else if (m.source === 'expanded' && bioDoc && cacheGet(bioDoc, m.symbol)) sources.push({ ticker: m.symbol, doc: bioDoc });
  }
  return { sources, universe: uni, bioDoc, expDoc };
}

// Detect early runners; RETAIN candles + eventIdx so the engine/episodes can use them.
async function detect(limit, ctx) {
  const { cacheGet } = require('./candle-cache');
  const { dayMetrics } = require('./daytrade');
  const { sources, universe, bioDoc, expDoc } = await biotechScanSources();
  const out = []; let asOf = null;
  for (const { ticker, doc } of sources) {
    const e = cacheGet(doc, ticker); if (!e || !e.candles || !e.candles.length) continue;
    const m = dayMetrics(e.candles); if (!isBiotechRunner(m)) continue;
    const last = e.candles[e.candles.length - 1].date;
    if (!asOf || last > asOf) asOf = last;
    out.push({
      ticker, candles: e.candles, company: (e.meta && (e.meta.shortName || e.meta.longName)) || null,
      last: m.last, relVol: +m.relVol.toFixed(1), pctChange: +m.pctChange.toFixed(1),
      avgDollarVol: m.avgDollarVol, highVolDays5: m.highVolDays5, pct5d: +(m.pct5d || 0).toFixed(1),
      capTier: (m.avgDollarVol || 0) < MICRO_DOLLAR_VOL ? 'micro' : 'large',
      eventIdx: findEventBar(e.candles, 15),
    });
  }
  // Pre-rank by a cheap proxy (5d move × liquidity) so the AI budget goes to the strongest names.
  out.sort((a, b) => (b.pct5d * Math.log10(b.avgDollarVol + 10)) - (a.pct5d * Math.log10(a.avgDollarVol + 10)));
  return { movers: out.slice(0, limit), asOf, universe, coverageDocs: { bioDoc, expDoc } };
}

// Deterministic per-name evidence retrieval (news + EDGAR offering filings + insider + shares),
// deadline-bounded. Returns { capital, bundle, sources } — the AI interprets the bundle only.
async function gatherEvidence(cand, asOf, t0, deadline) {
  const { fetchCompanyNews, fetchFundamentals } = require('./fundamentals');
  const { fetchOfferingFilings, fetchInsiderTransactions, aggregateInsider } = require('./edgar');
  const from = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
  const today = asOf || new Date().toISOString().slice(0, 10);
  const ev = { asOf, price: cand.last, hasNews: false, hasFilings: false };
  let news = [], filings = [];
  if (Date.now() - t0 < deadline) news = await fetchCompanyNews(cand.ticker, from, today).catch(() => []) || [];
  if (Array.isArray(news) && news.length) { ev.hasNews = true; const nf = offeringFlagsFromNews(news, asOf); ev.newsFlags = nf.flags; ev.offeringSources = nf.sources; ev.mostRecentOfferingDate = nf.mostRecentOfferingDate; }
  if (Date.now() - t0 < deadline) { const f = await fetchOfferingFilings(cand.ticker, { fromDate: from, maxFilings: 30 }).catch(() => null); if (f && Array.isArray(f.filings)) { filings = f.filings; ev.offeringFilings = filings; ev.hasFilings = true; } }
  if (Date.now() - t0 < deadline) { try { const tx = await fetchInsiderTransactions(cand.ticker, { fromDate: from, maxFilings: 15, throttleMs: 50 }); if (tx && tx.txs && tx.txs.length) ev.insiderNet = (aggregateInsider(tx.txs, { asOf }) || {}).net || null; } catch { /* degrade */ } }
  if (Date.now() - t0 < deadline) { try { const fund = await fetchFundamentals(cand.ticker); if (fund && fund.sharesOut != null) ev.sharesOut = fund.sharesOut; } catch { /* degrade */ } }
  const capital = classifyCapitalState(ev);
  const bundle = buildEvidenceBundle({ news, filings });
  return { capital, bundle };
}

// Build a verified-event ledger entry from the AI interpretation + the cited bundle sources.
function eventFromAssessment(ai, bundle, cand, asOf) {
  if (!ai || ai.classification === 'STEALTH' || ai.classification === 'NOISE') return null;
  const TYPE = { FDA: 'FDA_DECISION', DATA: 'TRIAL_READOUT', MA: 'MA', PARTNER: 'PARTNERSHIP', FINANCING: 'FINANCING', ANALYST: 'ANALYST', SYMPATHY: 'OTHER' };
  const cited = new Set(ai.citations || []);
  const sources = (bundle || []).filter(b => cited.has(b.id)).map(b => makeSource({ sourceType: b.sourceType, originId: b.id, title: b.title, url: b.url, publishedAt: b.publishedAt, primary: b.primary }));
  return makeEvent({
    ticker: cand.ticker, company: cand.company, eventType: TYPE[ai.classification] || 'OTHER',
    actualDate: ai.catalyst_timing === 'Behind' ? asOf : null,
    outcomeDirection: ai.outcomeDirection === 'unknown' ? null : ai.outcomeDirection,
    scientificQuality: ai.scientificQuality === 'unknown' ? null : ai.scientificQuality,
    sources, firstKnownAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(),
  });
}

// Persist episodes + append immutable origins for episodes FIRST decided today (a clean dedupe
// so the hash chain gets each origin once). Best-effort; never breaks the scan.
async function persistEpisodes(supervisor, asOf) {
  if (!hasStore() || !supervisor) return;
  try { await writeJSON(EPISODES_KEY, { generatedAt: new Date().toISOString(), episodes: supervisor.episodes || [] }, 0); } catch { /* degrade */ }
  try {
    const { append } = require('./immutable-ledger');
    for (const ep of (supervisor.episodes || [])) {
      const o = ep && ep.origin;
      if (o && o.firstDecisionDate === asOf) await append('biotech-episodes', o).catch(() => {});
    }
  } catch { /* degrade */ }
}

// Counterfactual ledger: log EVERY surfaced candidate (not just attractive ones) with the full
// immutable decision-time snapshot + the back-compat picks[] apex/calibration consume.
async function logSurfaced(asOf, cands) {
  if (!hasStore() || !asOf || !cands.length) return 0;
  const picks = cands.map(c => ({
    ticker: c.ticker, tier: c.tier, date: asOf, entry: c.plan ? c.plan.trigger : null, short: false,
    bench: BIOTECH_ETF, score: c.score, classification: c.classification, evidence: c.evidence, confidence: c.confidence,
    archetype: c.archetype, actionCeiling: c.actionCeiling, actionability: c.actionability,
    severeLossRisk: c.severeLossRisk, capitalState: c.capitalState, dataQuality: c.dataQuality,
  }));
  const snapshot = cands.map(c => ({
    ticker: c.ticker, archetype: c.archetype, actionCeiling: c.actionCeiling, dataQuality: c.dataQuality,
    scores: { research: c.overallResearchPriority, setup: c.setupScore, catalyst: c.catalystEvidenceScore, scientific: c.scientificQualityScore, capital: c.capitalStructureScore, execution: c.executionScore },
    plan: c.plan, event: c.event, capitalState: c.capitalState, features: c.features, timing: c.timing,
  }));
  await writeBiotechDay(asOf, { picks, snapshot, dataProvenance: 'prospective_live', engineVersion: 'biotech-swing-v1' }).catch(() => {});
  return picks.length;
}

// op=biotechtick — the full pipeline.
async function runBiotechTick(req, res) {
  const t0 = Date.now();
  res.setHeader('Cache-Control', 'no-store');
  try {
    const xbi = await benchCandles(BIOTECH_ETF, '1y');
    const regimeInfo = biotechRegime(xbi);
    const ctx = { regime: regimeInfo.regime, etfPct5d: null };
    const { movers, asOf, universe, coverageDocs } = await detect(DETECT_LIMIT, ctx);
    if (!movers.length) {
      const empty = { asOf, items: [], notes: 'no biotech runners detected on the latest tape', detected: 0, regime: regimeInfo.regime, generatedAt: new Date().toISOString() };
      if (hasStore()) await writeJSON(CACHE_KEY, empty, 0).catch(() => {});
      return res.json({ ok: true, ...empty, elapsedMs: Date.now() - t0 });
    }

    // Evidence retrieval for the top names (deterministic first), then ONE bounded AI call.
    const invest = movers.slice(0, MAX_INVESTIGATE);
    const evByTicker = new Map();
    let i = 0;
    const worker = async () => { while (i < invest.length) { const c = invest[i++]; try { evByTicker.set(c.ticker, await gatherEvidence(c, asOf, t0, EVIDENCE_DEADLINE_MS)); } catch { evByTicker.set(c.ticker, { capital: classifyCapitalState({ asOf }), bundle: [] }); } } };
    await Promise.all(Array.from({ length: 4 }, worker));

    let aiResult = { model: null, promptVersion: null, generatedAt: null, raw: null };
    if (process.env.ANTHROPIC_API_KEY) {
      const aiCands = invest.map(c => ({ ticker: c.ticker, last: c.last, relVol: c.relVol, ret5: c.pct5d, bundle: (evByTicker.get(c.ticker) || {}).bundle || [] }));
      try { aiResult = await investigate(aiCands); } catch { /* degrade — mechanical candidates remain */ }
    }
    const aiParsed = parseAssessment(aiResult.raw, invest.map(c => ({ ticker: c.ticker, bundle: (evByTicker.get(c.ticker) || {}).bundle || [] })));
    const aiByTicker = new Map(aiParsed.items.map(a => [a.ticker, a]));

    // Assemble EVERY detected candidate (investigated names get evidence; the tail is mechanical
    // with an honest data-quality state — nothing silently disappears).
    const assembled = movers.map((c, idx) => {
      const ai = aiByTicker.get(c.ticker) || null;
      const evd = evByTicker.get(c.ticker) || null;
      const event = ai ? eventFromAssessment(ai, evd ? evd.bundle : [], c, asOf) : null;
      const capital = evd ? evd.capital : null;
      const cand = assembleCandidate({
        ticker: c.ticker, company: c.company, last: c.last, relVol: c.relVol, avgDollarVol: c.avgDollarVol,
        candles: c.candles, xbi, regime: regimeInfo.regime, eventIdx: c.eventIdx, event, capital, ai, asOf,
      });
      cand.rank = idx + 1;
      return cand;
    }).sort((a, b) => b.overallResearchPriority - a.overallResearchPriority);

    // Lifecycle episodes (union with prior published biotech episodes → no silent disappearance).
    let supervisor = null;
    try {
      const prev = hasStore() ? await readJSON(EPISODES_KEY, { episodes: [] }).catch(() => ({ episodes: [] })) : { episodes: [] };
      const map = {}; for (const c of movers) map[c.ticker] = c.candles;
      supervisor = buildBiotechEpisodes({
        prevEpisodes: (prev && prev.episodes) || [], candidates: assembled,
        priceBundle: { map, bench: { SPY: xbi, XBI: xbi } },
        ctx: { date: asOf, generatedAt: new Date().toISOString(), regime: regimeInfo.regime, regimeRiskOff: regimeInfo.regime === 'risk-off', costBps: 25, cooldownSessions: 3, isHoliday: null },
      });
      await persistEpisodes(supervisor, asOf);
    } catch { /* episodes are shadow monitoring — never break the scan */ }

    const logged = await logSurfaced(asOf, assembled);
    const coverage = coverageReport(universe.members, sym => {
      const { cacheGet } = require('./candle-cache');
      const e = coverageDocs.bioDoc && cacheGet(coverageDocs.bioDoc, sym) || coverageDocs.expDoc && cacheGet(coverageDocs.expDoc, sym);
      return e && e.candles && e.candles.length ? { hasCandles: true, lastDate: e.candles[e.candles.length - 1].date } : null;
    }, { asOf });

    const items = assembled.map(toWireItem);
    const payload = {
      asOf, items, notes: aiParsed.notes, detected: movers.length, investigated: invest.length,
      regime: regimeInfo.regime, regimeInfo, universe: { size: universe.size, curated: universe.curatedCount, expanded: universe.expandedCount, uncertain: universe.uncertainCount, survivorshipSafe: universe.survivorshipSafe }, coverage,
      ai: { model: aiResult.model, promptVersion: aiResult.promptVersion, assessedAt: aiResult.generatedAt },
      sections: supervisor ? supervisor.counts : null, logged, generatedAt: new Date().toISOString(),
    };
    if (hasStore()) await writeJSON(CACHE_KEY, payload, 0).catch(() => {});
    return res.json({ ok: true, asOf, itemCount: items.length, investigated: invest.length, detected: movers.length, logged, regime: regimeInfo.regime, coverage, elapsedMs: Date.now() - t0 });
  } catch (e) {
    return res.json({ ok: false, error: String(e && e.message || e), elapsedMs: Date.now() - t0 });
  }
}

// Project the assembled candidate to the wire item (superset of the legacy back-compat fields).
function toWireItem(c) {
  return {
    ticker: c.ticker, company: c.company,
    archetype: c.archetype, archetypeLabel: c.archetypeLabel,
    actionCeiling: c.actionCeiling, actionCeilingReasons: c.actionCeilingReasons, actionability: c.actionability,
    severeLossRisk: c.severeLossRisk, severeLossReasons: c.severeLossReasons,
    researchPriority: c.overallResearchPriority,
    setupScore: c.setupScore, catalystEvidenceScore: c.catalystEvidenceScore, scientificQualityScore: c.scientificQualityScore,
    capitalStructureScore: c.capitalStructureScore, executionScore: c.executionScore,
    plan: c.plan, event: c.event, capitalState: c.capitalState, capitalEvidence: c.capitalEvidence, dilutionRisk: c.dilutionRisk,
    timing: c.timing, daysToBinary: c.daysToBinary, dataQuality: c.dataQuality, subsector: c.subsector,
    features: c.features ? { residual5: c.features.residual5, xbiRet5: c.features.xbiRet5 } : null,
    thesis: c.thesis, bear_case: c.bear_case, caution: c.caution, citations: c.citations, groundedPrimary: c.groundedPrimary, confidence: c.confidence,
    reasons: c.reasons, flags: c.flags,
    // ── Back-compat (decision-normalizers.fromBiotech + UI) ──
    tier: c.tier, score: c.score, classification: c.classification, evidence: c.evidence,
    catalyst_timing: c.catalyst_timing, last: c.last, relVol: c.relVol, sector: c.sector, pct5d: c.pct5d,
  };
}

// op=biotech — serve the cached board (fast, never AI).
async function runBiotech(req, res) {
  const cached = hasStore() ? await readJSON(CACHE_KEY, null).catch(() => null) : null;
  if (cached) {
    const ageMins = cached.generatedAt ? Math.round((Date.now() - new Date(cached.generatedAt).getTime()) / 60000) : null;
    const stale = cached.generatedAt ? (Date.now() - new Date(cached.generatedAt).getTime() >= REFRESH_MS) : true;
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
    return res.json({ ok: true, cached: true, stale, disclaimer: DISCLAIMER, ...cached, ageMins });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: false, error: 'warming up — building the biotech swing board (try Refresh in a moment)', items: [], disclaimer: DISCLAIMER });
}

// op=biotechgrade — multi-horizon XBI-relative grading of resolved episodes. Measurement only.
async function runBiotechGrade(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const days = await readAllBiotechDays().catch(() => []);
    const picks = days.flatMap(d => (d.picks || []).map(p => ({ ...p, date: p.date || d.date })));
    if (!picks.length) return res.json({ ok: true, graded: 0, note: 'no biotech ledger yet' });
    const xbi = await benchCandles(BIOTECH_ETF, '2y');
    const { fetchDailyHistory } = require('./screener');
    const uniqTickers = [...new Set(picks.map(p => p.ticker))];
    const candleMap = new Map();
    for (const t of uniqTickers) { const d = await fetchDailyHistory(t, '2y').catch(() => null); if (d && d.candles) candleMap.set(t, d.candles); }
    const graded = picks.map(p => gradeBiotechEpisode(p, { candles: candleMap.get(p.ticker) || [], xbi })).filter(g => g.graded);
    const rollups = {}; for (const h of HORIZONS) rollups[h] = summarize(graded, { horizon: h });
    const byArchetype = summarizeByArchetype(graded, { horizon: 10 });
    const totalResolved = graded.filter(g => HORIZONS.some(h => g.byHorizon[h] && g.byHorizon[h].resolved)).length;
    const payload = {
      generatedAt: new Date().toISOString(), gradedEpisodes: graded.length, resolvedEpisodes: totalResolved,
      rollups, byArchetype, validationFloors: VALIDATION_FLOORS,
      gateStatus: totalResolved >= VALIDATION_FLOORS.minResolvedEpisodes ? 'sufficient-sample' : `accruing (${totalResolved}/${VALIDATION_FLOORS.minResolvedEpisodes} resolved)`,
      note: 'Shadow measurement only — no live weight or governance maturity changes on this signal.',
    };
    if (hasStore()) await writeJSON(GRADE_KEY, payload, 0).catch(() => {});
    return res.json({ ok: true, ...payload });
  } catch (e) {
    return res.json({ ok: false, error: String(e && e.message || e) });
  }
}

module.exports = {
  runBiotech, runBiotechTick, runBiotechGrade, detect, biotechScanSources, logSurfaced,
  gatherEvidence, eventFromAssessment, toWireItem, CACHE_KEY, EPISODES_KEY, GRADE_KEY, BIOTECH_ETF,
};

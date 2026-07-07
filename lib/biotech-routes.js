// 🧬 BIOTECH RADAR route — TWO ops (mirrors 🕵️ Stealth):
//   op=biotechtick : scan the dedicated biotech candle cache for early runners → mechanical
//                    /100 pre-score → AI investigation (Haiku + web_search) of the top names
//                    → catalyst-adjusted final /100 → forward-log → cache. Slow (~50s).
//   op=biotech     : serve the cached result (fast). Never blocks on the AI call.
// Benchmarked vs XBI (the equal-weight biotech ETF) — the honest peer index for a runner.
const { readJSON, writeJSON, hasStore, writeBiotechDay } = require('./store');
const {
  isBiotechRunner, biotechFeatures, scoreBiotech, tierFor, parseResult, investigate, MAX_INVESTIGATE,
} = require('./biotech');

const CACHE_KEY = 'biotech/latest.json';
const REFRESH_MS = 6 * 60 * 60 * 1000;
const NEWS_DEADLINE_MS = 14000;               // cap per-name news checks before the AI call
const BIOTECH_ETF = 'XBI';
const MICRO_DOLLAR_VOL = 15_000_000;          // below this → "micro" cap tier (analyst-catalyst haircut)
const DISCLAIMER = 'Biotech names that have just started running, scored 0–100 (100 = highest conviction). Catalyst credit is evidence-graded and the model actively penalizes dilution risk, serial spike-faders, and sub-$2 delisting candidates. An AI finds the reason (or flags it Unknown). A research lead, NOT a buy signal — biotech binary events cut both ways.';

// 5-session % change of the biotech benchmark, for the relative-strength component.
async function etfPct5d() {
  try {
    const { fetchDailyHistory } = require('./screener');
    const d = await fetchDailyHistory(BIOTECH_ETF, '1y');
    const c = d && d.candles;
    if (!c || c.length < 6) return 0;
    const last = c[c.length - 1].close, base = c[c.length - 6].close;
    return base > 0 ? +(((last - base) / base) * 100).toFixed(2) : 0;
  } catch { return 0; }
}

// Point-in-time macro regime ('risk-on' | 'neutral' | 'risk-off') for the momentum gate.
async function currentRegime() {
  try { const { fetchMacro } = require('./macro'); const m = await fetchMacro(); return (m && m.regime) || 'neutral'; }
  catch { return 'neutral'; }
}

// Scan the dedicated biotech candle cache for early runners, mechanically pre-score each
// (no AI yet), and return them ranked. Pure tape + fundamentals-free — the catalyst comes later.
async function detect(limit, ctx) {
  const { loadCandleCache, cacheGet } = require('./candle-cache');
  const { dayMetrics } = require('./daytrade');
  const { BIOTECH } = require('./universe');
  const doc = await loadCandleCache('biotech').catch(() => null);
  if (!doc) return { movers: [], asOf: null };
  const out = []; let asOf = null;
  for (const t of BIOTECH) {
    const e = cacheGet(doc, t); if (!e || !e.candles || !e.candles.length) continue;
    const m = dayMetrics(e.candles); if (!isBiotechRunner(m)) continue;
    const f = biotechFeatures(e.candles); if (!f) continue;
    const capTier = (m.avgDollarVol || 0) < MICRO_DOLLAR_VOL ? 'micro' : 'large';
    const sc = scoreBiotech(m, f, { ...ctx, capTier });                 // pre-AI mechanical score
    const last = e.candles[e.candles.length - 1].date;
    if (!asOf || last > asOf) asOf = last;
    out.push({
      ticker: t, pct5d: +(m.pct5d || 0).toFixed(1), relVol: +m.relVol.toFixed(1),
      pctChange: +m.pctChange.toFixed(1), last: m.last, avgDollarVol: m.avgDollarVol,
      highVolDays5: m.highVolDays5, adrDaysConsumed: f.adrDaysConsumed, runAge: f.runAge,
      capTier, features: f, preScore: sc.score,
    });
  }
  out.sort((a, b) => b.preScore - a.preScore);
  return { movers: out.slice(0, limit), asOf };
}

// Tag the candidates going to the AI with whether our own news feed found a recent headline
// (feeds the STEALTH-vs-known distinction). Deadline-bounded; unchecked names default to known.
async function tagNewsless(cands, t0, deadline) {
  const { fetchCompanyNews } = require('./fundamentals');
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  let i = 0;
  const worker = async () => {
    while (i < cands.length) {
      const c = cands[i++];
      if (Date.now() - t0 > deadline) { c.newsless = false; continue; }
      const news = await fetchCompanyNews(c.ticker, from, today).catch(() => null);
      c.newsless = Array.isArray(news) && news.length === 0;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return cands;
}

// Counterfactual archive: log EVERY surfaced name with its score-tier (Hot/Emerging/Watch) so
// the Scoreboard can falsify the /100 model — do Hot names beat Watch names AND beat XBI?
async function logSurfaced(asOf, items) {
  if (!hasStore() || !asOf || !items.length) return 0;
  const picks = items.map(c => ({
    ticker: c.ticker, tier: c.tier, date: asOf, entry: null, short: false,
    bench: BIOTECH_ETF, score: c.score, classification: c.classification, evidence: c.evidence,
    confidence: c.confidence,   // for the calibration conviction-IC layer (does AI confidence order excess?)
  }));
  await writeBiotechDay(asOf, { picks }).catch(() => {});
  return picks.length;
}

// op=biotechtick — detect → investigate top N → final score → log → cache.
async function runBiotechTick(req, res) {
  const t0 = Date.now();
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.ANTHROPIC_API_KEY) return res.json({ ok: false, error: 'no ANTHROPIC_API_KEY' });
  try {
    const [etf5, regime] = await Promise.all([etfPct5d(), currentRegime()]);
    const ctx = { etfPct5d: etf5, regime };
    const { movers, asOf } = await detect(30, ctx);
    if (!movers.length) {
      const empty = { asOf, items: [], notes: 'no biotech runners detected on the latest tape', detected: 0, etfPct5d: etf5, regime, generatedAt: new Date().toISOString() };
      if (hasStore()) await writeJSON(CACHE_KEY, empty, 0).catch(() => {});
      return res.json({ ok: true, ...empty, elapsedMs: Date.now() - t0 });
    }
    const cands = movers.slice(0, MAX_INVESTIGATE);
    await tagNewsless(cands, t0, NEWS_DEADLINE_MS);
    const raw = await investigate(cands);
    const { items: aiItems, notes } = parseResult(raw, cands);
    const aiByTicker = new Map(aiItems.map(a => [a.ticker, a]));

    // Merge the AI catalyst back in and compute the catalyst-adjusted FINAL /100 score.
    const scored = cands.map(c => {
      const ai = aiByTicker.get(c.ticker) || null;
      const m = { pct5d: c.pct5d, relVol: c.relVol, pctChange: c.pctChange, last: c.last, avgDollarVol: c.avgDollarVol, highVolDays5: c.highVolDays5, newsless: c.newsless };
      const sc = scoreBiotech(m, c.features, { etfPct5d: etf5, regime, capTier: c.capTier, ai });
      const f = c.features || {};
      return {
        ticker: c.ticker, score: sc.score, tier: sc.tier, breakdown: sc.breakdown,
        pct5d: c.pct5d, relVol: c.relVol, pctChange: c.pctChange, last: c.last,
        adrDaysConsumed: c.adrDaysConsumed, runAge: c.runAge, capTier: c.capTier,
        newsless: !!c.newsless,
        // Trap-flag row for the card (Fable B6): quick "engineered to be sold into" tells.
        flags: {
          dilutionHigh: !!(ai && ai.dilution_risk === 'High'),
          serialSpiker: (f.spikeFades || 0) >= 2,
          penny: !!f.lowPriced,
          overextended: (f.extADR || 0) >= 4,
        },
        classification: ai ? ai.classification : (c.newsless ? 'STEALTH' : 'NOISE'),
        evidence: ai ? ai.evidence : 'None',
        catalyst_timing: ai ? ai.catalyst_timing : 'NA',
        reason: ai ? ai.reason : 'not yet investigated',
        subsector: ai ? ai.subsector : null,
        dilution_risk: ai ? ai.dilution_risk : null,
        confidence: ai ? ai.confidence : 2,
        bear_case: ai ? ai.bear_case : null,
        thesis: ai ? ai.thesis : '',
        caution: ai ? ai.caution : null,
      };
    }).sort((a, b) => b.score - a.score);

    const logged = await logSurfaced(asOf, scored);
    const payload = { asOf, items: scored, notes, detected: movers.length, investigated: cands.length, etfPct5d: etf5, regime, logged, generatedAt: new Date().toISOString() };
    if (hasStore()) await writeJSON(CACHE_KEY, payload, 0).catch(() => {});
    return res.json({ ok: true, asOf, itemCount: scored.length, logged, detected: movers.length, elapsedMs: Date.now() - t0 });
  } catch (e) {
    return res.json({ ok: false, error: String(e && e.message || e), elapsedMs: Date.now() - t0 });
  }
}

// op=biotech — serve the cached result (fast). Never calls the AI.
async function runBiotech(req, res) {
  const cached = hasStore() ? await readJSON(CACHE_KEY, null).catch(() => null) : null;
  if (cached) {
    const ageMins = cached.generatedAt ? Math.round((Date.now() - new Date(cached.generatedAt).getTime()) / 60000) : null;
    const stale = cached.generatedAt ? (Date.now() - new Date(cached.generatedAt).getTime() >= REFRESH_MS) : true;
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
    return res.json({ ok: true, cached: true, stale, disclaimer: DISCLAIMER, ...cached, ageMins });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: false, error: 'warming up — building the biotech scan (try Refresh in a moment)', items: [], disclaimer: DISCLAIMER });
}

module.exports = { runBiotech, runBiotechTick, detect, tagNewsless, logSurfaced, CACHE_KEY, BIOTECH_ETF };

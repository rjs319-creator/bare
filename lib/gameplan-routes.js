// op=gameplan : build (or serve) the Daily Game Plan. Gathers the day's market
// state (macro/regime + headlines + app signal leans), feeds the running
// multi-day narrative back in, synthesizes via lib/gameplan, and persists both
// today's plan and the rolling narrative so each re-run BUILDS on the story.
//
// op=gameplan            → serve today's stored plan, or build it if absent
// op=gameplan&refresh=1  → force a fresh rebuild (used by the warm cron / on-demand)

const gp = require('./gameplan');
const reflection = require('./gameplan-reflection');
const of = require('./optionsflow');
const { fetchChainResult } = require('./options-baseline');
const { fetchMacro } = require('./macro');
const { sessionInfoAt, lastCompletedRegularSession } = require('./market-session');
const snap = require('./verified-snapshot');
const { readJSON, writeJSON, hasStore } = require('./store');
// NB: @anthropic-ai/sdk is lazy-required inside the handler (matching
// predict-routes.js) so this module imports cleanly in the no-deps test CI.

const NEWS_DOMAINS = 'reuters.com,bloomberg.com,apnews.com,cnbc.com,wsj.com,ft.com,barrons.com,marketwatch.com,investors.com,forbes.com,fortune.com,businessinsider.com,economist.com,seekingalpha.com,morningstar.com,benzinga.com,axios.com,nytimes.com';
const NEWS_QUERY = '(stock market OR Federal Reserve OR rate cut OR inflation OR earnings OR "S&P 500" OR Nasdaq OR recession OR jobs report)';
const NARRATIVE_KEY = 'gameplan/narrative.json';
const NARRATIVE_MAX_DAYS = 6;

async function fetchHeadlines(apiKey, pageSize = 16) {
  if (!apiKey) return [];
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(NEWS_QUERY)}&language=en&sortBy=publishedAt&pageSize=${pageSize}&domains=${NEWS_DOMAINS}&apiKey=${apiKey}`;
  try {
    const r = await fetch(url);
    const d = await r.json();
    if (!Array.isArray(d.articles)) return [];
    return d.articles.map(a => ({ title: a.title, source: a.source, publishedAt: a.publishedAt }));
  } catch {
    return [];
  }
}

// Gather the unusual-options-flow grades (smart-money positioning) for the brief:
// the market grade + the top single-stock grades. ~1.5s scan; failures degrade.
async function gatherOptionsFlow() {
  try {
    const sigs = await of.scanOptionsFlow(of.LIQUID_OPTIONS, fetchChainResult, { concurrency: 6, cap: 120 });
    if (!sigs.length) return null;
    const summary = of.flowSummary(sigs);
    const topStocks = of.rollupByTicker(sigs).filter(r => !r.isIndex).slice(0, 8)
      .map(r => ({ ticker: r.ticker, grade: r.grade, score: r.score }));
    return { marketGrade: summary.grade, marketScore: summary.score, topStocks };
  } catch { return null; }
}

// Normalize fetchMacro's nested shape into the flat one lib/gameplan expects.
function normalizeMacro(m) {
  if (!m) return null;
  return {
    regime: m.regime,
    vix: m.vix && m.vix.level,
    vixPctile: m.vix && m.vix.pctile,
    macroRisk: m.macroRisk,
    creditStress: m.creditStress,
  };
}

// Render the stored narrative entries into the prompt's prior-narrative text.
function renderNarrative(entries) {
  return (entries || []).map(e => `[${e.date}] ${e.text}`).join('\n\n');
}

// Candle frames for the verified snapshot. Every requested symbol always gets a key —
// a failed fetch yields null, which snapshotBlock renders as the anti-fabrication
// sentinel line rather than silently omitting the symbol. VIX is deliberately NOT
// here: macroLine already carries the ^VIX read (fetchMacro owns that frame), and a
// second independent fetch could disagree with it inside the same prompt.
// The benchmark symbol comes from the reflection module — resolution scores against
// this exact frame, so the coupling is explicit, not a string coincidence.
const SNAPSHOT_SYMBOLS = [reflection.BENCH_SYMBOL, 'QQQ', 'IWM'];
async function gatherSnapshotCandles() {
  const { fetchDailyHistory } = require('./screener');
  const out = {};
  await Promise.all(SNAPSHOT_SYMBOLS.map(async (sym) => {
    try { const d = await fetchDailyHistory(sym, '6mo'); out[sym] = d && Array.isArray(d.candles) ? d.candles : null; }
    catch { out[sym] = null; }
  }));
  return out;
}

// Market-implied event probabilities (Kalshi + Polymarket) with ~1-day odds drift,
// rendered to one compact prompt line via the shared predmarkets pipeline. Bounded:
// the venue fetches carry their own 8s timeouts and the whole gather is raced against
// a hard deadline, so a hung venue can never stall the plan. Degrades to ''.
const PREDMKT_DEADLINE_MS = 9000;
async function gatherPredMarkets() {
  try {
    const pm = require('./predmarkets');
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), PREDMKT_DEADLINE_MS));
    const scored = await Promise.race([pm.loadScoredMarkets({ limitDays: 8 }), timeout]);
    return scored ? snap.predMarketsLine(scored) : '';
  } catch { return ''; }
}

async function runGamePlan(req, res) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const newsKey = process.env.NEWS_API_KEY;
  if (!anthropicKey) return res.status(200).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured.' });

  // ET calendar date: the plan (and the reflection ledger it feeds) is FOR a US trading
  // day. The old UTC stamp put an evening-ET build under TOMORROW's date, which would
  // anchor its reflection scoring to a close that postdates the stance by a session.
  const date = sessionInfoAt(new Date()).etDate;
  const force = req.query.refresh === '1' || req.query.force === '1';

  // Serve today's cached plan unless a refresh is requested.
  const stored = await readJSON(`gameplan/${date}.json`, null).catch(() => null);
  if (stored && !force) {
    res.setHeader('Cache-Control', 's-maxage=300');
    return res.json({ ...stored, cached: true });
  }

  const [macroRaw, headlines, optionsFlow, narrativeDoc, reflectionDocRead, snapCandles, predMarketsText] = await Promise.all([
    fetchMacro().catch(() => null),
    fetchHeadlines(newsKey),
    gatherOptionsFlow(),
    readJSON(NARRATIVE_KEY, { entries: [] }).catch(() => ({ entries: [] })),
    readJSON(reflection.KEY, { entries: [] }).catch(() => ({ entries: [] })),
    gatherSnapshotCandles(),
    gatherPredMarkets(),
  ]);
  const macro = normalizeMacro(macroRaw);
  const signals = { fadeRegime: macro && macro.regime };
  const priorNarrative = renderNarrative(narrativeDoc.entries);
  // Forming-bar guard: the snapshot renders bars only through the last COMPLETED
  // regular session, so an intraday build can't cache a moving mid-session print
  // as a verified close.
  const snapshotText = snap.snapshotBlock(snapCandles, date, lastCompletedRegularSession(new Date()));

  // Reflection loop: score pending prior plans against realized SPY moves (deterministic,
  // completed bars only, fail-open — an unscoreable entry stays pending), persist any new
  // resolutions IMMEDIATELY (never coupled to whether the LLM call below succeeds), then
  // hand the model its own measured record + open predictions. The SPY frame is the same
  // one the verified snapshot just fetched — no extra request.
  let reflectionDoc = reflectionDocRead;
  const benchFrame = snapCandles[reflection.BENCH_SYMBOL];
  const spyCandles = Array.isArray(benchFrame) && benchFrame.length ? benchFrame : null;
  if (spyCandles && reflection.hasMaturablePending(reflectionDoc, date)) {
    const resolvedDoc = reflection.resolveEntries(reflectionDoc, spyCandles, new Date().toISOString(), date);
    if (hasStore() && JSON.stringify(resolvedDoc) !== JSON.stringify(reflectionDoc)) {
      await writeJSON(reflection.KEY, resolvedDoc, 0).catch(() => {});
    }
    reflectionDoc = resolvedDoc;
  }
  const reflectionText = reflection.reflectionBlock(reflectionDoc, date);

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: anthropicKey });
  let plan;
  try {
    plan = await gp.synthesize(client, { date, macro, headlines, signals, optionsFlow, priorNarrative, reflection: reflectionText, snapshot: snapshotText, predMarkets: predMarketsText });
  } catch (e) {
    return res.status(200).json({ ok: false, error: 'Synthesis failed: ' + (e && e.message ? e.message : String(e)) });
  }

  const out = {
    ok: true, date, generatedAt: new Date().toISOString(), model: gp.MODEL,
    ...plan,
    inputs: {
      regime: macro && macro.regime, vix: macro && macro.vix, headlineCount: headlines.length,
      hadPriorNarrative: !!priorNarrative,
      optionsGrade: optionsFlow ? `${optionsFlow.marketGrade} (${optionsFlow.marketScore > 0 ? '+' : ''}${optionsFlow.marketScore})` : null,
      // Observability for the grounding + reflection loops (the ledger blob itself is
      // not served by any op, so this is the only external view of the loop's health).
      snapshotSymbols: Object.keys(snapCandles).filter((s) => Array.isArray(snapCandles[s]) && snapCandles[s].length),
      hadPredMarkets: !!predMarketsText,
      reflection: {
        entries: (reflectionDoc.entries || []).length,
        pending: (reflectionDoc.entries || []).filter((e) => e && e.status === 'pending').length,
        resolved: (reflectionDoc.entries || []).filter((e) => e && e.status === 'resolved').length,
        injectedBlock: !!reflectionText,
      },
    },
  };

  // Persist today's plan + roll the multi-day narrative (one entry per day, latest wins).
  if (hasStore()) {
    await writeJSON(`gameplan/${date}.json`, out, 0).catch(() => {});
    const kept = (narrativeDoc.entries || []).filter(e => e.date !== date);
    kept.push({ date, text: plan.narrativeUpdate || plan.headline || '(no narrative update)' });
    const trimmed = kept.slice(-NARRATIVE_MAX_DAYS);
    await writeJSON(NARRATIVE_KEY, { entries: trimmed, updatedAt: new Date().toISOString() }, 0).catch(() => {});
    // Reflection ledger: today's plan enters PENDING (scored on a later build). Re-read
    // the doc and re-apply resolution first — the multi-second LLM call above is a wide
    // window for a concurrent build's write, and recordPlan/resolveEntries are pure and
    // idempotent, so rebasing onto the freshest copy narrows the blind-overwrite race
    // to the Blob read-back lag.
    const freshDoc = await readJSON(reflection.KEY, { entries: [] }).catch(() => reflectionDoc);
    const rebased = spyCandles
      ? reflection.resolveEntries(freshDoc, spyCandles, new Date().toISOString(), date)
      : freshDoc;
    const recorded = reflection.recordPlan(rebased, {
      date, tone: plan.sentiment && plan.sentiment.tone, headline: plan.headline, predictions: plan.predictions,
    });
    await writeJSON(reflection.KEY, recorded, 0).catch(() => {});
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.json(out);
}

module.exports = { runGamePlan, fetchHeadlines, normalizeMacro, renderNarrative };

// op=gameplan : build (or serve) the Daily Game Plan. Gathers the day's market
// state (macro/regime + headlines + app signal leans), feeds the running
// multi-day narrative back in, synthesizes via lib/gameplan, and persists both
// today's plan and the rolling narrative so each re-run BUILDS on the story.
//
// op=gameplan            → serve today's stored plan, or build it if absent
// op=gameplan&refresh=1  → force a fresh rebuild (used by the warm cron / on-demand)

const gp = require('./gameplan');
const { fetchMacro } = require('./macro');
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

async function runGamePlan(req, res) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const newsKey = process.env.NEWS_API_KEY;
  if (!anthropicKey) return res.status(200).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured.' });

  const date = new Date().toISOString().slice(0, 10);
  const force = req.query.refresh === '1' || req.query.force === '1';

  // Serve today's cached plan unless a refresh is requested.
  const stored = await readJSON(`gameplan/${date}.json`, null).catch(() => null);
  if (stored && !force) {
    res.setHeader('Cache-Control', 's-maxage=300');
    return res.json({ ...stored, cached: true });
  }

  const [macroRaw, headlines] = await Promise.all([
    fetchMacro().catch(() => null),
    fetchHeadlines(newsKey),
  ]);
  const macro = normalizeMacro(macroRaw);
  const signals = { fadeRegime: macro && macro.regime };

  const narrativeDoc = await readJSON(NARRATIVE_KEY, { entries: [] }).catch(() => ({ entries: [] }));
  const priorNarrative = renderNarrative(narrativeDoc.entries);

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: anthropicKey });
  let plan;
  try {
    plan = await gp.synthesize(client, { date, macro, headlines, signals, priorNarrative });
  } catch (e) {
    return res.status(200).json({ ok: false, error: 'Synthesis failed: ' + (e && e.message ? e.message : String(e)) });
  }

  const out = {
    ok: true, date, generatedAt: new Date().toISOString(), model: gp.MODEL,
    ...plan,
    inputs: { regime: macro && macro.regime, vix: macro && macro.vix, headlineCount: headlines.length, hadPriorNarrative: !!priorNarrative },
  };

  // Persist today's plan + roll the multi-day narrative (one entry per day, latest wins).
  if (hasStore()) {
    await writeJSON(`gameplan/${date}.json`, out, 0).catch(() => {});
    const kept = (narrativeDoc.entries || []).filter(e => e.date !== date);
    kept.push({ date, text: plan.narrativeUpdate || plan.headline || '(no narrative update)' });
    const trimmed = kept.slice(-NARRATIVE_MAX_DAYS);
    await writeJSON(NARRATIVE_KEY, { entries: trimmed, updatedAt: new Date().toISOString() }, 0).catch(() => {});
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.json(out);
}

module.exports = { runGamePlan, fetchHeadlines, normalizeMacro, renderNarrative };

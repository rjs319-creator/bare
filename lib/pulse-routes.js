'use strict';
// 📡 MARKET PULSE — an ATTENTION-LIFECYCLE trading-intelligence feed.
//
// PIPELINE (each stage its own serverless invocation — a search+reason in one call blows
// the 60s wall, proven):
//   1. GATHER  (op=pulse)       Haiku 4.5 + web_search sweeps trending finance chatter and
//                               returns raw candidates with STRUCTURED, concise insight and
//                               (optionally) real source links. Citations from the search
//                               tool are captured so hallucinated URLs can be dropped.
//   2. REFINE  (op=pulserefine) Fable 5 merges dupes, re-ranks, adds the crowding/contrarian
//                               read; then we ENRICH tickers with cached point-in-time price
//                               context, DERIVE lifecycle/action/evidence states, fold the
//                               snapshot into the episode ledger, and archive an immutable snap.
//   3. GRADE   (op=pulsegrade)  Shadow, prospective. Grades matured first-seen decisions.
//
// HONEST FRAMING: this is attention + decision SUPPORT, not buy signals — and not proven to
// have directional value. Popularity = editorial prominence (LLM estimate), velocity = an
// inferred buzz trend. States are DERIVED deterministically (pulse-schema), never trusted raw.

const schema = require('./pulse-schema');
const { foldSnapshot, findEpisode, ageDays } = require('./pulse-episodes');
const { enrichTickers, extractCitations, computeEnrichment } = require('./pulse-enrich');
const { gradeEpisode, summarizePulseOutcomes } = require('./pulse-grade');
const store = require('./pulse-store');
const { fetchWithTimeout } = require('./http');

const { SENTIMENTS, VELOCITIES, CROWDINGS, CATEGORIES, HORIZONS,
        sanitizeItem, parsePulse, parseRefinedPulse, deriveStates } = schema;

const REFRESH_MS = 4 * 60 * 60 * 1000;          // regenerate at most every 4 hours
const GATHER_MODEL = 'claude-haiku-4-5-20251001';
const REFINE_MODEL = 'claude-fable-5';
const N = 10;              // items surfaced to the user
const GATHER_N = 16;       // raw candidates Haiku pulls (Fable dedupes/culls to N)
const REFINE_TIMEOUT_MS = 50000;   // Fable pass; the ~52s original envelope, headroom for the 60s wall
const REFINE_MAX_TOKENS = 7000;
const REFINE_EFFORT = 'low';       // bound Fable's always-on thinking
const ENRICH_MAX = 16;             // cap PIT price fetches per refine
const ENRICH_BUDGET_MS = 5000;     // hard cap on enrichment so it can't push the invocation past 60s
const GRADE_MAX = 12;              // cap forward-price fetches per grade run
const MIN_GRADE_SESSIONS = 5;      // an episode is gradable once ≥5 sessions have elapsed

// Honest staleness tiers by snapshot age (minutes).
function freshnessOf(ageMins) {
  if (ageMins == null) return 'unknown';
  if (ageMins < 240) return 'live';
  if (ageMins < 720) return 'stale';
  return 'very-stale';
}

const DISCLAIMER = 'Attention & decision-support — an evidence-graded read of what is newly moving the tape, NOT buy signals and NOT proven to predict returns. "Prominence" is an LLM estimate of how widely a story is discussed (not a measured mention count); "buzz trend" is inferred. Verify links before acting. Refreshes ~every 4 hours.';

// ── Structured-output tools ──────────────────────────────────────────────────
const INSIGHT_PROPS = {
  category: { type: 'string', enum: CATEGORIES, description: 'ticker = a specific stock story; macro = a rates/inflation/commodity/geopolitical/index theme with no single ticker.' },
  whatChanged: { type: 'string', description: 'the concrete NEW development, ≤140 chars. e.g. "Three independent outlets picked up the FDA decision within 40 min."' },
  whyItMatters: { type: 'string', description: 'one concise sentence on why it could move markets' },
  traderRead: { type: 'string', description: 'one concise professional read (structure/positioning), not a buy call' },
  noviceTranslation: { type: 'string', description: 'one plain-English sentence a beginner understands; warn against chasing when apt' },
  primaryRisk: { type: 'string', description: 'the single biggest risk in one sentence' },
  invalidation: { type: 'string', description: 'one TESTABLE condition that would weaken the thesis' },
  horizon: { type: 'string', enum: HORIZONS, description: 'intraday / days / weeks / context' },
  sourceList: {
    type: 'array',
    description: 'REAL sources only. Use URLs that appeared in your web search results — never invent a link, timestamp, count, or platform. Omit if you cannot cite a real page.',
    items: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'exact URL from your search results (or omit)' },
        title: { type: 'string' },
        type: { type: 'string', enum: schema.SOURCE_TYPES },
        publishedAt: { type: 'string', description: 'YYYY-MM-DD if known' },
        claim: { type: 'string', description: 'what this source supports' },
        independent: { type: 'boolean', description: 'false if it just echoes another listed source' },
        credibility: { type: 'string', enum: schema.CREDIBILITIES },
      },
    },
  },
};

const PULSE_TOOL = {
  name: 'submit_pulse',
  description: `Return the top trending market-moving distillations, ranked by a blend of prominence (how widely discussed right now) and buzz trend (how fast it is accelerating).`,
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: `Up to ${GATHER_N} items, most prominent + fastest-trending first. Include overlaps — the refine pass merges them.`,
        items: {
          type: 'object',
          properties: {
            rank: { type: 'integer', description: '1..N' },
            headline: { type: 'string', description: 'one punchy sentence' },
            tickers: { type: 'array', items: { type: 'string' }, description: 'relevant US tickers (empty for a macro theme)' },
            idea: { type: 'string', description: 'what the crowd / media is actually saying (1-2 sentences)' },
            whyMoves: { type: 'string', description: 'why this could move US markets (1 sentence)' },
            sentiment: { type: 'string', enum: SENTIMENTS },
            popularity: { type: 'integer', description: '1-100 editorial prominence (your estimate of how widely discussed)' },
            velocity: { type: 'string', enum: VELOCITIES, description: 'inferred buzz trend' },
            sources: { type: 'string', description: 'short summary of WHERE this is trending' },
            caution: { type: 'string', description: 'optional honest flag — hype/crowded/extended; empty if none' },
            ...INSIGHT_PROPS,
          },
          required: ['rank', 'headline', 'tickers', 'idea', 'whyMoves', 'sentiment', 'popularity', 'velocity', 'sources'],
        },
      },
    },
    required: ['items'],
  },
};

const PULSE_REFINE_TOOL = {
  name: 'submit_pulse_refined',
  description: `Return the FINAL top ${N} after merging duplicate/overlapping themes, re-ranking by genuine market-moving weight, and adding a crowding/contrarian read. Ranked #1 = most important. Keep every insight field concise.`,
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: `Exactly ${N} de-duplicated items, ranked #1..${N}.`,
        items: {
          type: 'object',
          properties: {
            rank: { type: 'integer', description: `1..${N}` },
            headline: { type: 'string' },
            tickers: { type: 'array', items: { type: 'string' } },
            idea: { type: 'string' },
            whyMoves: { type: 'string' },
            sentiment: { type: 'string', enum: SENTIMENTS },
            popularity: { type: 'integer', description: '1-100 editorial prominence' },
            velocity: { type: 'string', enum: VELOCITIES },
            crowding: { type: 'string', enum: CROWDINGS, description: 'how positioned the crowd already is: early / building / crowded / capitulation.' },
            contrarian: { type: 'string', description: 'one honest desk read — is this already priced / a probable fade?' },
            contrarianThesis: { type: 'boolean', description: 'true ONLY if there is an explicit, testable contrarian thesis (not merely "crowded").' },
            conflicted: { type: 'boolean', description: 'true if sources materially disagree on the facts' },
            sources: { type: 'string' },
            caution: { type: 'string' },
            ...INSIGHT_PROPS,
          },
          required: ['rank', 'headline', 'tickers', 'idea', 'whyMoves', 'sentiment', 'popularity', 'velocity', 'crowding', 'contrarian', 'sources'],
        },
      },
    },
    required: ['items'],
  },
};

const GATHER_PROMPT = `You are a markets desk analyst. Using web search, run an EXHAUSTIVE sweep of what finance social media and media are trending on RIGHT NOW that could move US markets: X/FinTwit, StockTwits, r/wallstreetbets, finance YouTube (CNBC/Bloomberg/Yahoo), breaking news, earnings, FDA/biotech catalysts, unusual options / squeeze chatter, and this week's macro calendar.

Return up to ${GATHER_N} candidates — specific stocks OR macro themes. Cast a WIDE net (overlaps are fine; a second pass merges them). For each: tickers (empty for macro), what the crowd is saying, why it could move US markets, sentiment, a 1-100 prominence estimate, a buzz-trend bucket, and — CRITICALLY — concise structured insight (whatChanged ≤140 chars, whyItMatters, traderRead, noviceTranslation, primaryRisk, invalidation, horizon) and a category (ticker vs macro).

SOURCE INTEGRITY: in sourceList, use ONLY real URLs that appeared in your search results. NEVER invent a URL, timestamp, author, platform, or count. If you cannot cite a real page, omit sourceList and keep the free-text sources summary honest. Submit via submit_pulse — no plain text.`;

// ── Anthropic helpers ─────────────────────────────────────────────────────────
function client() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
}

function etDate() {
  // Stable America/New_York trading date (YYYY-MM-DD) for episode keying.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ── STAGE 1: gather ───────────────────────────────────────────────────────────
async function gatherPulse() {
  const c = client();
  if (!c) return null;
  const msg = await c.messages.create({
    model: GATHER_MODEL,
    max_tokens: 6000,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }, PULSE_TOOL],
    messages: [{ role: 'user', content: GATHER_PROMPT + `\n\nAfter searching, you MUST call submit_pulse — do not answer in plain text.` }],
  }, { timeout: 48000 });
  const { urls, sources } = extractCitations(msg);
  const items = parsePulse(msg, GATHER_N, urls);   // validate any per-item URLs against real citations
  if (!items.length) return null;
  return { items, sourcePool: sources, generation: new Date().toISOString(), stage: 'draft' };
}

// ── STAGE 2: refine ────────────────────────────────────────────────────────────
function draftLine(it, i) {
  const tks = (it.tickers || []).map(t => '$' + t).join(' ') || '—';
  return `${i + 1}. [${tks}] ${it.headline}\n   crowd: ${it.idea}\n   why: ${it.whyMoves} | sentiment: ${it.sentiment} | prominence ${it.popularity} | buzz ${it.velocity} | category ${it.category}`;
}
function buildRefinePrompt(draftItems) {
  const lines = draftItems.map(draftLine).join('\n\n');
  return `You are the senior editor on a markets desk. A junior analyst produced this RAW draft of trending ideas. It is noisy: themes overlap, ranking is crude, and it takes the crowd at face value.

RAW DRAFT (${draftItems.length} items):
${lines}

Produce the FINAL top ${N}. Your PRIMARY job is judgment, not rewriting:
1. MERGE duplicates/overlaps into one item (combine tickers, take the higher prominence). Keep MACRO themes as macro — do NOT force a rates/inflation/geopolitical theme into a ticker.
2. RE-RANK by genuine market-moving weight = how widely discussed × how fast it is accelerating × how actually tradeable/consequential it is. Drop pure noise.
3. Add the desk's CONTRARIAN read: crowding (early/building/crowded/capitulation) and one honest contrarian line. Set contrarianThesis=true ONLY when there is an explicit, testable contrarian call — "crowded" alone is a RISK state, not a short. Social sentiment is a weak/contrarian signal here; say so when a name is loud and crowded.
4. The insight fields (whatChanged/whyItMatters/traderRead/noviceTranslation/primaryRisk/invalidation/horizon) are OPTIONAL — reuse the draft's wording, or omit them and they carry over. Only rewrite one if merging made it wrong. Keep any you write concise (whatChanged ≤140 chars).
5. Keep sentiment/prominence/buzz honest. Never invent a source, URL, count, or platform.

Return exactly ${N} de-duplicated items via submit_pulse_refined — no plain text. Speed matters: prioritise the merge, rank and contrarian read.`;
}

async function refineDraft(draftItems, allowedUrls, timeoutMs = REFINE_TIMEOUT_MS, diag) {
  const note = m => { if (diag) diag.reason = m; };
  const c = client();
  if (!c) { note('no-api-key'); return null; }
  const items = (draftItems || []).filter(it => it && it.headline).slice(0, GATHER_N);
  if (!items.length) { note('no-items'); return null; }
  try {
    const msg = await c.messages.create({
      model: REFINE_MODEL,
      max_tokens: REFINE_MAX_TOKENS,
      output_config: { effort: REFINE_EFFORT },
      tools: [PULSE_REFINE_TOOL],
      tool_choice: { type: 'tool', name: 'submit_pulse_refined' },
      messages: [{ role: 'user', content: buildRefinePrompt(items) }],
    }, { timeout: timeoutMs });
    if (diag) diag.stop = msg.stop_reason;
    const tool = (msg.content || []).find(b => b.type === 'tool_use' && b.name === 'submit_pulse_refined');
    if (!tool) { note('no-tool-block:' + (msg.stop_reason || '?')); return null; }
    const refined = parseRefinedPulse(tool.input, N, allowedUrls);
    if (!refined.length) { note('empty-after-parse'); return null; }
    return refined;
  } catch (e) {
    note('threw:' + (e && e.message || e));
    return null;
  }
}

// Attach derived states to a list, using episode age + (optional) enrichment map. Pure-ish.
function stateItems(items, episodes, date, enrichMap) {
  return items.map(it => {
    const ep = findEpisode(episodes, it);
    const age = ep ? ageDays(ep.firstSeenDate, date) : 0;
    const primary = (it.tickers || [])[0];
    const enrichment = primary && enrichMap ? (enrichMap[primary] || null) : null;
    return deriveStates(it, { ageDays: age, enrichment });
  });
}

// Backfill insight fields a refined item omitted, from its best-matching draft candidate
// (shared ticker, else shared headline words). Pure. Lets Fable skip regenerating them.
const INSIGHT_KEYS = ['whatChanged', 'whyItMatters', 'traderRead', 'noviceTranslation', 'primaryRisk', 'invalidation'];
function bestDraftMatch(item, candidates) {
  const tks = new Set((item.tickers || []).map(t => t.toUpperCase()));
  if (tks.size) {
    const hit = candidates.find(c => (c.tickers || []).some(t => tks.has(String(t).toUpperCase())));
    if (hit) return hit;
  }
  const words = new Set(String(item.headline || '').toLowerCase().split(/\s+/).filter(w => w.length >= 4));
  let best = null, bestN = 0;
  for (const c of candidates) {
    let n = 0;
    for (const w of String(c.headline || '').toLowerCase().split(/\s+/)) if (words.has(w)) n++;
    if (n > bestN) { bestN = n; best = c; }
  }
  return bestN >= 2 ? best : null;
}
function carryInsight(refined, candidates) {
  return refined.map(it => {
    const needs = INSIGHT_KEYS.some(k => !it[k]);
    if (!needs) return it;
    const src = bestDraftMatch(it, candidates || []);
    if (!src) return it;
    const filled = { ...it };
    for (const k of INSIGHT_KEYS) if (!filled[k] && src[k]) filled[k] = src[k];
    if (filled.horizon === 'context' && src.horizon && src.horizon !== 'context') filled.horizon = src.horizon;
    return filled;
  });
}

// A compact, user-facing recently-changed feed from the transition list.
function recentTransitions(episodes, limit = 12) {
  const all = [];
  for (const e of episodes || []) {
    const hist = e.lifecycleHistory || [];
    if (hist.length >= 2) {
      const last = hist[hist.length - 1];
      all.push({ episodeId: e.id, headline: e.canonicalTheme, from: hist[hist.length - 2].state, to: last.state, at: last.at, date: last.date });
    }
  }
  return all.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, limit);
}

function serve(res, doc, extra, cacheHeader) {
  res.setHeader('Cache-Control', cacheHeader);
  const ageMins = doc.generatedAt ? Math.round((Date.now() - new Date(doc.generatedAt).getTime()) / 60000) : null;
  const freshness = freshnessOf(ageMins);
  return res.json({ ok: true, disclaimer: DISCLAIMER, refreshMins: 240, ...doc, ...extra, ageMins, freshness });
}

// ── op=pulse — STAGE 1 (gather) ────────────────────────────────────────────────
async function runPulse(req, res) {
  const force = req.query.force === '1';
  const hasStore = store.hasStore();
  const cached = hasStore ? await store.readLatest().catch(() => null) : null;
  const fresh = cached && cached.generatedAt && (Date.now() - new Date(cached.generatedAt).getTime() < REFRESH_MS);
  if (cached && fresh && !force) {
    const { raw, sourcePool, ...userDoc } = cached;
    return serve(res, userDoc, { cached: true, persisted: hasStore }, 's-maxage=1800, stale-while-revalidate=86400');
  }

  let draft = null, genErr;
  try { draft = await gatherPulse(); } catch (e) { draft = null; genErr = e && e.message; }
  if (!draft) {
    // Generation failed → preserve last-known-good, flagged honestly by age.
    if (cached) {
      const { raw, sourcePool, ...userDoc } = cached;
      return serve(res, userDoc, { cached: true, stale: true, lastKnownGood: true, persisted: hasStore }, 's-maxage=600');
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: false, error: genErr || 'pulse unavailable (no API key or no results)', items: [], disclaimer: DISCLAIMER });
  }

  const date = etDate();
  const episodesDoc = hasStore ? await store.readEpisodes().catch(() => ({ episodes: [] })) : { episodes: [] };
  const stated = stateItems(draft.items.slice(0, N), episodesDoc.episodes || [], date, null);
  const generatedAt = draft.generation;
  const doc = {
    stage: 'draft', generation: draft.generation, generatedAt, date,
    items: stated, raw: draft.items, sourcePool: draft.sourcePool,
    verifiedThemes: stated.filter(x => x.evidenceState === 'Verified' || x.evidenceState === 'Multi-source').length,
    unverifiedThemes: stated.filter(x => x.evidenceState === 'Unverified' || x.evidenceState === 'Search-summary only').length,
  };

  let persisted = false;
  if (hasStore) {
    persisted = await store.writeVerified(store.LATEST_KEY, doc, b => b.generation === draft.generation);
    // Immutable archive (write-once; failure-tolerant).
    await store.writeSnapshot(draft.generation, doc).catch(() => {});
  }
  const { raw, sourcePool, ...userDoc } = doc;
  return serve(res, userDoc, { cached: false, persisted, candidates: draft.items.length }, 's-maxage=1800, stale-while-revalidate=86400');
}

// ── op=pulserefine — STAGE 2 (refine + enrich + episodes) ──────────────────────
async function runPulseRefine(req, res) {
  if (!store.hasStore()) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: false, needsDraft: true, error: 'no store — refine needs a persisted draft' });
  }
  const cached = await store.readLatest().catch(() => null);
  const candidates = cached && (Array.isArray(cached.raw) ? cached.raw : cached.items);
  if (!cached || !Array.isArray(candidates) || !candidates.length) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: false, needsDraft: true, error: 'no draft to refine — call op=pulse first' });
  }
  const force = req.query.force === '1';
  if (cached.stage === 'refined' && !force) {
    return serve(res, cached, { cached: true, alreadyRefined: true, persisted: true }, 's-maxage=1800, stale-while-revalidate=86400');
  }

  const generation = cached.generation;              // the generation we are refining
  const allowedUrls = new Set((cached.sourcePool || []).map(s => s.url).filter(Boolean));
  const diag = {};
  const refinedRaw = await refineDraft(candidates, allowedUrls, REFINE_TIMEOUT_MS, diag);
  if (!refinedRaw) {
    const { raw, sourcePool, ...userDoc } = cached;   // keep serving the draft; never break the tab
    return serve(res, userDoc, { refineFailed: true, persisted: true, ...(req.query.debug === '1' ? { diag } : {}) }, 's-maxage=600');
  }
  // Fable is told the insight fields are optional — carry over anything it omitted from the
  // matching draft candidate (keeps cards complete without making Fable regenerate them all).
  const refined = carryInsight(refinedRaw, candidates);

  // ENRICH tickers with point-in-time price context (bounded + time-capped so a slow price
  // provider can never push this invocation past the 60s wall — skips to episodes/persist).
  const date = cached.date || etDate();
  const tickers = refined.flatMap(it => (it.category !== 'macro' ? it.tickers : [])).slice(0, ENRICH_MAX);
  let enrichMap = {};
  try {
    enrichMap = await Promise.race([
      enrichTickers(tickers, { max: ENRICH_MAX }),
      new Promise(r => setTimeout(() => r({}), ENRICH_BUDGET_MS)),
    ]);
  } catch { enrichMap = {}; }

  const episodesDoc = await store.readEpisodes().catch(() => ({ episodes: [], transitions: [] }));
  const stated = stateItems(refined, episodesDoc.episodes || [], date, enrichMap);

  // Fold into the episode ledger (immutable — first-seen preserved).
  const folded = foldSnapshot(episodesDoc.episodes || [], stated, { date, generation });

  const generatedAt = cached.generatedAt;
  const doc = {
    stage: 'refined', generation, generatedAt, date,
    items: stated, sourcePool: cached.sourcePool || [],
    transitions: folded.transitions,
    recentlyChanged: recentTransitions(folded.episodes),
    verifiedThemes: stated.filter(x => x.evidenceState === 'Verified' || x.evidenceState === 'Multi-source').length,
    unverifiedThemes: stated.filter(x => x.evidenceState === 'Unverified' || x.evidenceState === 'Search-summary only').length,
    refinedAt: new Date().toISOString(),
  };

  // CONCURRENCY GUARD: only overwrite latest if it is STILL the generation we refined — a
  // newer gather must win. Re-read right before writing.
  const now = await store.readLatest().catch(() => null);
  if (now && now.generation !== generation) {
    // A newer gather superseded us; do not clobber it. Report honestly.
    return serve(res, { ...doc, items: stated }, { superseded: true, persisted: true }, 's-maxage=600');
  }

  const persisted = await store.writeVerified(store.LATEST_KEY, doc, b => b.stage === 'refined' && b.generation === generation);
  await store.writeSnapshot(generation, doc).catch(() => {});
  await store.writeEpisodes({ episodes: folded.episodes, transitions: (episodesDoc.transitions || []).concat(folded.transitions).slice(-500) }).catch(() => {});

  const { sourcePool, ...userDoc } = doc;
  return serve(res, userDoc, { cached: false, refined: true, persisted, enriched: Object.keys(enrichMap).length }, 's-maxage=1800, stale-while-revalidate=86400');
}

// ── op=pulseepisodes — read the ledger (recently-changed / lifecycle history) ──
async function runPulseEpisodes(req, res) {
  if (!store.hasStore()) return res.json({ ok: false, error: 'no store', episodes: [] });
  const doc = await store.readEpisodes().catch(() => ({ episodes: [], transitions: [] }));
  const outcomes = await store.readOutcomes().catch(() => ({ summary: null }));
  res.setHeader('Cache-Control', 's-maxage=600');
  return res.json({
    ok: true,
    episodeCount: (doc.episodes || []).length,
    recentlyChanged: recentTransitions(doc.episodes || [], 20),
    calibration: outcomes.summary || { status: 'Collecting evidence', note: 'Prospective grading starts once episodes mature (≥5 sessions).' },
  });
}

// ── op=pulsegrade — SHADOW prospective grader ──────────────────────────────────
// Fetch dated daily bars for a ticker (and SPY), for forward outcome measurement.
async function fetchDatedBars(ticker) {
  const sym = String(ticker).toUpperCase();
  const path = `/v8/finance/chart/${encodeURIComponent(sym)}?range=3mo&interval=1d`;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const r = await fetchWithTimeout(`https://${host}${path}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'application/json' },
      });
      if (!r.ok) continue;
      const result = (await r.json())?.chart?.result?.[0];
      const ts = result?.timestamp || [];
      const q = result?.indicators?.quote?.[0];
      if (!ts.length || !q) continue;
      const rows = ts.map((t, i) => ({
        date: new Date(t * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
        open: q.open?.[i] ?? null, close: q.close?.[i] ?? null, high: q.high?.[i] ?? null, low: q.low?.[i] ?? null,
      })).filter(r => r.close != null);
      if (rows.length) return rows;
    } catch { /* next host */ }
  }
  return null;
}

// Build the `forward` object gradeEpisode expects: next-open entry AT/AFTER firstSeenDate.
function buildForward(rows, spyRows, firstSeenDate, horizons = [1, 3, 5, 10]) {
  if (!rows || !rows.length) return null;
  const entryIdx = rows.findIndex(r => r.date > firstSeenDate);   // strictly next session (no lookahead)
  if (entryIdx < 0 || rows[entryIdx].open == null) return null;
  const entryOpen = rows[entryIdx].open;
  const closes = {}, spyRet = {};
  const spyEntryIdx = spyRows ? spyRows.findIndex(r => r.date > firstSeenDate) : -1;
  const spyEntry = spyEntryIdx >= 0 ? spyRows[spyEntryIdx].open : null;
  let mfe = 0, mae = 0;
  for (const h of horizons) {
    const row = rows[entryIdx + h];
    if (row && row.close != null) closes[h] = row.close;
    if (spyEntry && spyRows[spyEntryIdx + h] && spyRows[spyEntryIdx + h].close != null) {
      spyRet[h] = ((spyRows[spyEntryIdx + h].close - spyEntry) / spyEntry) * 100;
    }
  }
  // MFE/MAE across the path to the last horizon.
  const lastH = horizons[horizons.length - 1];
  for (let i = entryIdx + 1; i <= entryIdx + lastH && i < rows.length; i++) {
    if (rows[i].high != null) mfe = Math.max(mfe, ((rows[i].high - entryOpen) / entryOpen) * 100);
    if (rows[i].low != null) mae = Math.min(mae, ((rows[i].low - entryOpen) / entryOpen) * 100);
  }
  return { entryOpen, closes, spyRet, mfe, mae };
}

async function runPulseGrade(req, res) {
  if (!store.hasStore()) return res.json({ ok: false, error: 'no store', graded: 0 });
  const date = etDate();
  const episodesDoc = await store.readEpisodes().catch(() => ({ episodes: [] }));
  const outDoc = await store.readOutcomes().catch(() => ({ outcomes: [], gradedIds: [], summary: null }));
  const gradedIds = new Set(outDoc.gradedIds || []);

  // Episodes matured (≥5 sessions since first-seen) and not yet graded.
  const mature = (episodesDoc.episodes || [])
    .filter(e => e.category === 'ticker' && (e.tickers || []).length && !gradedIds.has(e.id) && ageDays(e.firstSeenDate, date) >= MIN_GRADE_SESSIONS)
    .slice(0, GRADE_MAX);

  if (!mature.length) {
    // Honest cold-start: nothing has matured yet.
    const summary = summarizePulseOutcomes(outDoc.outcomes || []);
    await store.writeOutcomes({ ...outDoc, summary }).catch(() => {});
    return res.json({ ok: true, graded: 0, coldStart: (outDoc.outcomes || []).length === 0, summary });
  }

  let spyRows = null;
  try { spyRows = await fetchDatedBars('SPY'); } catch { spyRows = null; }

  const fresh = [];
  for (const e of mature) {
    try {
      const rows = await fetchDatedBars(e.tickers[0]);
      const forward = buildForward(rows, spyRows, e.firstSeenDate);
      const outcome = gradeEpisode(e, forward);
      if (outcome.gradable) { fresh.push(outcome); gradedIds.add(e.id); }
    } catch { /* skip this episode; retry a later run */ }
  }

  const outcomes = (outDoc.outcomes || []).concat(fresh);
  const summary = summarizePulseOutcomes(outcomes);
  await store.writeOutcomes({ outcomes: outcomes.slice(-2000), gradedIds: [...gradedIds].slice(-2000), summary }).catch(() => {});
  return res.json({ ok: true, graded: fresh.length, total: outcomes.length, summary });
}

module.exports = {
  runPulse, runPulseRefine, runPulseGrade, runPulseEpisodes,
  // pure helpers exported for tests + legacy imports
  parsePulse, parseRefinedPulse, sanitizeItem,
  stateItems, recentTransitions, buildForward, freshnessOf, etDate, carryInsight,
  PULSE_TOOL, PULSE_REFINE_TOOL,
};

// TRADE ALERTS ROUTES — source-aware swing-research pipeline (SHADOW).
//
// Ingest (push, no market data): normalize to the immutable v2 schema → durable evidence
// ledger + rolling display buffer → source registry → clustered/lifecycle-parsed leads →
// immutable ticker-thesis episodes. The legacy v1 buffer/ranker/edge harness is kept intact
// for backward compatibility (a clearly-labeled legacy path).
//
// Cron build (op=alertsgrade): fetch candles once → grade matured episodes at the NEXT OPEN
// over 1/3/5/10/21 sessions → hierarchical partial-pooled account skill → stamp registry →
// verify catalysts + score active episodes into the four coordinated views → walk-forward
// validation. Nothing here can originate or boost a live trade: the strategy is registered
// shadow and every payload says so.
//
// Semantic layer (op=alertsassess): a bounded, RESTRICTED Fable call keyed by IMMUTABLE
// episodeId — it resolves language only, never predicts outcomes, and never rewrites an
// existing episode's assessment.

const alerts = require('./alerts');                 // v1 mechanical ranker (kept for compat)
const alertsFable = require('./alerts-fable');      // v1 A/B report (kept for compat)
const semantic = require('./alerts-semantic');      // v2 immutable semantic layer
const schema = require('./alerts-schema');
const registry = require('./alerts-registry');
const episodesLib = require('./alerts-episodes');
const skillLib = require('./alerts-skill');
const gradeLib = require('./alerts-grade');
const pipeline = require('./alerts-pipeline');
const validation = require('./alerts-validation');
const { evaluateSetup } = require('./stock-setup');
const { fetchDailyHistory } = require('./screener');
const { hasStore, readJSON, writeJSON } = require('./store');
const { requireMethod, ingestAuthorized } = require('./auth');
const { statusOf, isTradeEligible, PROMOTION_GATE } = require('./strategy-gate');

let fetchEarningsInfo = null;
try { ({ fetchEarningsInfo } = require('./fundamentals')); } catch { /* optional adapter */ }

// ── Blob keys ────────────────────────────────────────────────────────────────
// v1 (legacy display + edge/fade harness — preserved for backward compatibility):
const V1 = { RAW: 'alerts/raw.json', RANKED: 'alerts/ranked.json', LOG: 'alerts/log.json', RECORD: 'alerts/record.json', EDGE: 'alerts/edge.json', ASSESS: 'alerts/assess.json' };
// v2 (source-aware pipeline):
const V2 = {
  REGISTRY: 'alerts/registry.json',
  EPISODES: 'alerts/episodes.json',
  GRADED: 'alerts/graded.json',
  SKILL: 'alerts/skill.json',
  DECISIONS: 'alerts/decisions.json',
  VALIDATION: 'alerts/validation.json',
  SEMANTIC: 'alerts/semantic.json',
};
const evidenceKey = date => `alerts/evidence/${date}.json`;   // durable immutable audit shards (daily)

const RAW_TTL_MS = 48 * 3600 * 1000, RAW_CAP = 600;
const STRATEGY_ID = 'xalerts';
const MODEL_VERSION = 'alerts-v2';

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const todayISO = now => new Date(now).toISOString().slice(0, 10);
const isOpen = e => ['NEW', 'WAITING', 'TRIGGERED', 'EXTENDED'].includes(e.status);

// Deterministic market regime from SPY candles (no new feed).
function readRegime(spy) {
  if (!Array.isArray(spy) || spy.length < 60) return { riskOff: false, supportive: false, label: 'unknown' };
  const closes = spy.map(c => c.close);
  const spot = closes[closes.length - 1];
  const sma20 = mean(closes.slice(-20)), sma50 = mean(closes.slice(-50));
  const riskOff = spot < sma50 && sma20 < sma50;
  const supportive = spot > sma50 && sma20 > sma50;
  return { riskOff, supportive, label: riskOff ? 'risk-off' : supportive ? 'supportive' : 'neutral' };
}

// The governance block echoed in every payload (UI wording can never change eligibility).
function governanceBlock() {
  const status = statusOf(STRATEGY_ID);
  return {
    strategyId: STRATEGY_ID,
    maturity: status,
    tradeEligible: isTradeEligible(STRATEGY_ID),   // must be false while shadow
    weight: isTradeEligible(STRATEGY_ID) ? 'live' : 0,
    promotionGate: PROMOTION_GATE,
    note: 'Trade Alerts is SHADOW: social posts are leads, not facts. This layer may confirm/contradict an independent price setup and accumulate a prospective record, but cannot originate or boost a live trade until a human promotes it via the strategy-gate PROMOTION_GATE.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// INGEST
// ─────────────────────────────────────────────────────────────────────────────
async function runAlertsIngest(req, res) {
  if (!requireMethod(req, res, ['POST'])) return;
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  if (!ingestAuthorized(req, 'ALERTS_INGEST_TOKEN')) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const now = Date.now();
  if (req.query.reset === '1') return resetStores(res, now);

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const incoming = (body && Array.isArray(body.posts)) ? body.posts : null;
  if (!incoming) return res.status(400).json({ ok: false, error: 'expected JSON { posts: [...] } (v2 or legacy {text, account, timestamp})' });

  const collectorId = (body && body.collectorId) || (req.headers && req.headers['x-collector-id']) || 'external-collector';
  const collectorVersion = (body && body.collectorVersion) || 'unknown';

  // ── v2: normalize (server owns collectedAt), validate, reject bad rows ──
  const { records, rejected } = schema.normalizeBatch(incoming, { collectedAtMs: now, collectorId, collectorVersion });

  // Durable evidence ledger (immutable audit — dedupe by contentHash+accountKey within the day).
  const day = todayISO(now);
  const evDoc = (await readJSON(evidenceKey(day), { date: day, records: [] })) || { date: day, records: [] };
  const seenEv = new Set(evDoc.records.map(r => (r.accountKey || r.handle || '') + '|' + r.contentHash));
  const freshRecords = [];
  for (const r of records) {
    const k = (r.accountKey || r.handle || '') + '|' + r.contentHash;
    if (seenEv.has(k)) continue;
    seenEv.add(k);
    evDoc.records.push(r); freshRecords.push(r);
  }
  evDoc.updatedAt = new Date(now).toISOString();

  // Source registry (identity, alias history, integrity flags).
  const reg = registry.foldRegistry(await readJSON(V2.REGISTRY, {}), freshRecords, { now: () => new Date(now).toISOString() });

  // Leads → immutable episodes (using the current skill model for lead weights).
  const skillModel = await readJSON(V2.SKILL, null);
  const { leads } = pipeline.buildLeads(freshRecords, { skillModel });
  const prevEpisodes = ((await readJSON(V2.EPISODES, { episodes: [] })) || {}).episodes || [];
  const { episodes, transitions } = episodesLib.foldEpisodes(prevEpisodes, leads, { date: day, now: () => new Date(now).toISOString() });

  // ── v1 legacy path (kept working: display buffer + mechanical rank + grade log) ──
  await runLegacyIngest(incoming, now);

  await Promise.all([
    writeJSON(evidenceKey(day), evDoc),
    writeJSON(V2.REGISTRY, reg),
    writeJSON(V2.EPISODES, { episodes, updatedAt: new Date(now).toISOString(), modelVersion: MODEL_VERSION }),
  ]);

  return res.status(200).json({
    ok: true, schema: 'v2',
    received: incoming.length, accepted: records.length, rejected: rejected.length,
    newEvidence: freshRecords.length, evidenceInDay: evDoc.records.length,
    episodes: episodes.length, openEpisodes: episodes.filter(isOpen).length,
    transitions: transitions.length,
    sources: Object.keys(reg).length,
    rejectedSamples: rejected.slice(0, 5),
    governance: governanceBlock(),
  });
}

// Legacy {text, account, timestamp} display buffer + mechanical ranker + grade log.
async function runLegacyIngest(incoming, now) {
  const rawDoc = (await readJSON(V1.RAW, { posts: [] })) || { posts: [] };
  const seen = new Set(rawDoc.posts.map(p => (p.account || '') + '|' + (p.text || '')));
  for (const p of incoming) {
    const text = p && (p.text);
    if (!text) continue;
    const account = p.handle || p.account || '?';
    const timestamp = p.publishedAt || p.timestamp || new Date(now).toISOString();
    const k = account + '|' + text;
    if (seen.has(k)) continue;
    seen.add(k);
    rawDoc.posts.push({ text: String(text).slice(0, 600), account, timestamp });
  }
  rawDoc.posts = rawDoc.posts.filter(p => { const t = Date.parse(p.timestamp); return isNaN(t) || now - t <= RAW_TTL_MS; }).slice(-RAW_CAP);
  rawDoc.updatedAt = new Date(now).toISOString();

  const record = (await readJSON(V1.RECORD, {})) || {};
  const ranked = alerts.rankPosts(rawDoc.posts, record, now);
  const log = (await readJSON(V1.LOG, [])) || [];
  const logKeys = new Set(log.map(e => `${e.ticker}|${e.direction}|${e.account}|${e.logged_at.slice(0, 10)}`));
  const today = todayISO(now);
  for (const r of ranked) {
    if (r.direction === 'neutral' || r.coordinated) continue;
    for (const acct of r.accounts) {
      const k = `${r.ticker}|${r.direction}|${acct}|${today}`;
      if (logKeys.has(k)) continue;
      logKeys.add(k);
      log.push({ ticker: r.ticker, direction: r.direction, account: acct, weightedSignal: r.weightedSignal, score: r.score, logged_at: new Date(now).toISOString(), graded: false, excess: null });
    }
  }
  await Promise.all([
    writeJSON(V1.RAW, rawDoc),
    writeJSON(V1.RANKED, { ranked, generatedAt: rawDoc.updatedAt, bufferSize: rawDoc.posts.length }),
    writeJSON(V1.LOG, log),
  ]);
}

async function resetStores(res, now) {
  await Promise.all([
    writeJSON(V1.RAW, { posts: [] }), writeJSON(V1.RANKED, { ranked: [] }), writeJSON(V1.LOG, []),
    writeJSON(V1.RECORD, {}), writeJSON(V1.EDGE, { n: 0, edge: false, verdict: 'INSUFFICIENT DATA (0/50 graded directional alerts)', minGraded: 50 }),
    writeJSON(V1.ASSESS, { assessments: {}, generatedAt: null, model: alertsFable.MODEL }),
    writeJSON(V2.REGISTRY, {}), writeJSON(V2.EPISODES, { episodes: [] }), writeJSON(V2.GRADED, { graded: {} }),
    writeJSON(V2.SKILL, null), writeJSON(V2.DECISIONS, { views: null, decisions: [] }),
    writeJSON(V2.VALIDATION, null), writeJSON(V2.SEMANTIC, { assessments: {} }),
  ]);
  return res.status(200).json({ ok: true, reset: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// READ (fast, cached — serves the pre-built v2 decisions + scoreboard + validation)
// ─────────────────────────────────────────────────────────────────────────────
async function runAlerts(req, res) {
  if (!hasStore()) return res.json({ configured: false, views: null, note: 'Blob storage not configured.', governance: governanceBlock() });

  const [decDoc, epDoc, skill, valid, reg, semDoc, v1ranked, v1edge, v1log] = await Promise.all([
    readJSON(V2.DECISIONS, null), readJSON(V2.EPISODES, { episodes: [] }), readJSON(V2.SKILL, null),
    readJSON(V2.VALIDATION, null), readJSON(V2.REGISTRY, {}), readJSON(V2.SEMANTIC, { assessments: {} }),
    readJSON(V1.RANKED, null), readJSON(V1.EDGE, null), readJSON(V1.LOG, []),
  ]);

  const episodes = (epDoc && epDoc.episodes) || [];
  const scoreboard = buildScoreboard(skill, reg);

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=600');
  return res.json({
    configured: true,
    governance: governanceBlock(),
    views: decDoc ? decDoc.views : null,
    decisions: decDoc ? decDoc.decisions : [],
    decisionsBuiltAt: decDoc ? decDoc.generatedAt : null,
    counts: {
      episodes: episodes.length,
      open: episodes.filter(isOpen).length,
      graded: skill ? skill.gradedCount || 0 : 0,
      sources: Object.keys(reg || {}).length,
    },
    scoreboard,
    validation: valid,
    semanticNotes: semDoc ? semDoc.notes : null,
    probability: { available: false, message: 'Probability unavailable — insufficient prospective calibrated evidence.' },
    // ── legacy fields (backward compatibility) ──
    legacy: {
      ranked: v1ranked ? v1ranked.ranked : [],
      edge: v1edge,
      fableEdge: alertsFable.fableEdgeReport(v1log || []),
      loggedTotal: (v1log || []).length,
      gradedTotal: (v1log || []).filter(e => e.graded).length,
    },
  });
}

// Account Scoreboard: conservative evidence per account (never sorted by raw hit rate).
function buildScoreboard(skill, reg) {
  if (!skill || !skill.accounts) return { accounts: [], nAccounts: 0, populationPrior: null, note: 'No graded account evidence yet.' };
  const accounts = skill.accounts.map(a => {
    const r = (reg || {})[a.accountKey] || {};
    return {
      sourceId: a.accountKey,
      handle: r.currentHandle || null,
      evidenceState: a.state,
      netExpectancy: a.meanExcess,
      ci90: a.ci90,
      deflatedLB90: a.deflatedLB90,
      independentEpisodes: a.n,
      independentDates: a.independentDates,
      monthsSpan: a.monthsSpan,
      profitFactor: a.profitFactor,
      recentVsLong: { recent: a.recentMeanExcess, long: a.longMeanExcess },
      weight: a.skillWeight === 0 ? 'zero' : a.state === 'SUPPORTED' ? 'normal' : a.state === 'PROVEN' ? 'supported' : a.state === 'DEGRADING' ? 'reduced' : 'reduced',
      weightReason: a.weightReason,
      integrityFlags: r.promotionalFlags || [],
    };
  });
  return { accounts, nAccounts: skill.nAccounts, populationPrior: skill.populationPrior, note: 'Conservative evidence — deflated for multiple testing. Follower count and badges are integrity context, never predictive skill.' };
}

// ─────────────────────────────────────────────────────────────────────────────
// CRON BUILD: grade matured episodes → skill → registry → decisions → validation
// ─────────────────────────────────────────────────────────────────────────────
async function runAlertsGrade(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });

  const now = Date.now();
  const [epDoc, gradedDoc, regDoc, semDoc] = await Promise.all([
    readJSON(V2.EPISODES, { episodes: [] }), readJSON(V2.GRADED, { graded: {} }),
    readJSON(V2.REGISTRY, {}), readJSON(V2.SEMANTIC, { assessments: {} }),
  ]);
  const episodes = (epDoc && epDoc.episodes) || [];
  await runLegacyGrade(now).catch(() => {});   // keep the v1 edge/fade harness fresh
  if (!episodes.length) return res.status(200).json({ ok: true, note: 'no episodes yet', governance: governanceBlock() });

  // Candles: SPY + every episode ticker (bounded concurrency).
  const tickers = [...new Set(episodes.map(e => e.ticker))];
  let spy = null; try { const d = await fetchDailyHistory('SPY'); if (d) spy = d.candles; } catch { /* ignore */ }
  const candlesByTicker = new Map();
  let i = 0;
  const worker = async () => { while (i < tickers.length) { const t = tickers[i++]; try { const d = await fetchDailyHistory(t); if (d) candlesByTicker.set(t, d.candles); } catch { /* skip */ } } };
  await Promise.all(Array.from({ length: Math.min(8, tickers.length) }, worker));
  const regime = readRegime(spy);

  // Grade any not-yet-graded episode that now has forward data.
  const graded = { ...(gradedDoc.graded || {}) };
  let gradedThisRun = 0;
  for (const ep of episodes) {
    if (graded[ep.id]) continue;
    const candles = candlesByTicker.get(ep.ticker);
    if (!candles) continue;
    const g = gradeLib.gradeEpisode(ep, { candles, spy });
    if (g.graded) { graded[ep.id] = g; gradedThisRun++; }
  }
  const gradedList = Object.values(graded);

  // Account skill from graded outcomes.
  const skillModel = skillLib.buildSkillModel(gradedList);
  skillModel.gradedCount = gradedList.length;
  skillModel.generatedAt = new Date(now).toISOString();
  const reg = registry.stampEvidenceState(regDoc, skillModel);

  // Verify catalysts for the active tickers (earnings adapter; degrade honestly).
  const activeEpisodes = episodes.filter(isOpen);
  const earningsByTicker = new Map();
  if (fetchEarningsInfo) {
    const at = [...new Set(activeEpisodes.map(e => e.ticker))];
    let j = 0;
    const ew = async () => { while (j < at.length) { const t = at[j++]; try { const e = await fetchEarningsInfo(t); if (e && e.earningsDate) earningsByTicker.set(t, { nextDate: e.earningsInDays >= 0 ? e.earningsDate : null, lastDate: e.earningsInDays < 0 ? e.earningsDate : null }); } catch { /* skip */ } } };
    await Promise.all(Array.from({ length: Math.min(6, at.length) }, ew));
  }

  const semanticById = (semDoc && semDoc.assessments) || {};
  const { decisions, views } = pipeline.buildDecisions(activeEpisodes, { candlesByTicker, spy, skillModel, regime, earningsByTicker, semanticById });

  // Walk-forward validation ladder over graded episodes (with decision-time arm signals).
  const valid = validation.walkForward(buildValidationRows(gradedList, episodes, candlesByTicker, spy, skillModel));

  await Promise.all([
    writeJSON(V2.GRADED, { graded, updatedAt: new Date(now).toISOString() }),
    writeJSON(V2.SKILL, skillModel),
    writeJSON(V2.REGISTRY, reg),
    writeJSON(V2.DECISIONS, { views, decisions, generatedAt: new Date(now).toISOString(), regime }),
    writeJSON(V2.VALIDATION, valid),
  ]);

  return res.status(200).json({
    ok: true, gradedThisRun, totalGraded: gradedList.length,
    activeDecisions: decisions.length, regime: regime.label,
    supportedAccounts: skillModel.accounts.filter(a => a.state === 'SUPPORTED' || a.state === 'PROVEN').length,
    validationReady: valid.ready, governance: governanceBlock(),
  });
}

// Build walk-forward rows: decision-time arm signals + realized excess (independent-date purged
// downstream). setup is recomputed on candles TRUNCATED to the decision date (no lookahead).
function buildValidationRows(gradedList, episodes, candlesByTicker, spy, skillModel) {
  const epById = new Map((episodes || []).map(e => [e.id, e]));
  const rows = [];
  for (const g of gradedList) {
    const ep = epById.get(g.episodeId);
    if (!ep) continue;
    const candles = candlesByTicker.get(g.ticker);
    let setupQ = 0;
    if (candles) {
      const upTo = candles.filter(c => c.date <= g.decisionDate);
      if (upTo.length >= 60) { const s = evaluateSetup(upTo); setupQ = s.valid && ((ep.side === 'long' && s.direction === 'long') || (ep.side === 'short' && s.direction === 'short')) ? s.quality : 0; }
    }
    const social = pipeline.socialConfirmation(ep, skillModel);
    const equalConf = Math.min(0.85, 1 - Math.pow(0.88, social.independentClusters));   // equal-weight saturating
    const skillConf = social.confirmation;
    const placebo = ((hashStr(g.episodeId) % 1000) / 1000);   // deterministic pseudo-random
    rows.push({
      date: g.decisionDate, excess: g.excess,
      arms: {
        setup: setupQ,
        socialEqual: equalConf,
        socialSkill: skillConf,
        priceEqual: setupQ * 0.7 + equalConf * 0.3,
        priceSkill: setupQ * 0.7 + skillConf * 0.3,
        placebo,
      },
    });
  }
  return rows;
}
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return Math.abs(h); }

// Legacy v1 grader (forward excess on the LOG) — kept so the legacy edge/fade report survives.
async function runLegacyGrade(now) {
  const log = (await readJSON(V1.LOG, [])) || [];
  const record = (await readJSON(V1.RECORD, {})) || {};
  const hold = alerts.CFG.gradeHoldDays;
  const pending = log.filter(e => !e.graded && e.direction !== 'neutral');
  if (!pending.length) { const edge = alerts.analyzeEdge(log); edge.generatedAt = new Date(now).toISOString(); await writeJSON(V1.EDGE, edge); return; }
  const tickers = [...new Set(pending.map(e => e.ticker))];
  let spy = null; try { const d = await fetchDailyHistory('SPY'); if (d) spy = d.candles; } catch { /* ignore */ }
  const hist = new Map();
  let i = 0;
  const worker = async () => { while (i < tickers.length) { const t = tickers[i++]; try { const d = await fetchDailyHistory(t); if (d) hist.set(t, d.candles); } catch { /* skip */ } } };
  await Promise.all(Array.from({ length: Math.min(8, tickers.length) }, worker));
  let graded = 0;
  if (spy) for (const e of pending) {
    const c = hist.get(e.ticker); if (!c) continue;
    const ex = alerts.gradeExcess(c, spy, e.logged_at.slice(0, 10), hold);
    if (ex == null) continue;
    e.excess = ex; e.graded = true;
    const hit = e.direction === 'bullish' ? ex > 0 : ex < 0;
    const s = record[e.account] || (record[e.account] = { hits: 0, total: 0 });
    s.total++; s.hits += hit ? 1 : 0;
    graded++;
  }
  const edge = alerts.analyzeEdge(log); edge.generatedAt = new Date(now).toISOString();
  if (graded) { await writeJSON(V1.LOG, log); await writeJSON(V1.RECORD, record); }
  await writeJSON(V1.EDGE, edge);
}

// ─────────────────────────────────────────────────────────────────────────────
// SEMANTIC (bounded Fable, immutable, keyed by episodeId)
// ─────────────────────────────────────────────────────────────────────────────
async function runAlertsAssess(req, res) {
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(200).json({ ok: false, error: 'ANTHROPIC_API_KEY not set — semantic layer disabled.' });

  const [epDoc, semDoc] = await Promise.all([readJSON(V2.EPISODES, { episodes: [] }), readJSON(V2.SEMANTIC, { assessments: {} })]);
  const episodes = (epDoc && epDoc.episodes) || [];
  const already = new Set(Object.keys((semDoc && semDoc.assessments) || {}));
  // Only assess OPEN episodes that don't already have an (immutable) assessment.
  const toAssess = episodes.filter(e => isOpen(e) && !already.has(e.id)).map(e => ({
    episodeId: e.id, ticker: e.ticker, side: e.side,
    event: e.contributors && e.contributors[0] ? e.contributors[0].event : null,
    sampleText: e.contributors && e.contributors[0] ? null : null,
    text: null,
  }));
  if (!toAssess.length) return res.status(200).json({ ok: true, assessed: 0, note: 'no new open episodes to assess' });

  // Pull a representative post text per episode from the durable evidence (best-effort).
  await attachSampleText(toAssess, episodes);

  const fresh = await semantic.assessEpisodes(toAssess);
  if (!fresh) return res.status(200).json({ ok: false, error: 'semantic call failed (kept prior assessments)' });
  const merged = semantic.mergeSemantic(semDoc, fresh);
  await writeJSON(V2.SEMANTIC, merged);
  return res.status(200).json({ ok: true, assessed: merged.added, total: Object.keys(merged.assessments).length, model: semantic.MODEL, governance: governanceBlock() });
}

// Best-effort: attach one recent post text per episode from today's evidence shard.
async function attachSampleText(toAssess, episodes) {
  const day = todayISO(Date.now());
  const ev = await readJSON(evidenceKey(day), { records: [] });
  const byTicker = new Map();
  for (const r of (ev.records || [])) { const arr = byTicker.get((r.text.match(/\$([A-Z]{1,5})/) || [])[1]) || []; arr.push(r.text); byTicker.set((r.text.match(/\$([A-Z]{1,5})/) || [])[1], arr); }
  for (const a of toAssess) { const arr = byTicker.get(a.ticker); if (arr && arr.length) a.sampleText = arr[0]; }
}

module.exports = { runAlertsIngest, runAlerts, runAlertsGrade, runAlertsAssess };

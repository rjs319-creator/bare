'use strict';
// 📡 MARKET PULSE v2 — PRIVILEGED WRITER TICKS.
//
// Every op in this file is registered in api/tracker.js PRIVILEGED_OPS: an anonymous
// page load can NEVER reach these — no public route may initiate an LLM search or
// mutate a ledger. Auth lives entirely in the tracker gate (lib/auth requireTrusted).
// Each tick is idempotent + retry-safe (whole-doc writes with read-back verification,
// generation guards, lease keys) and records its own health.
//
//   op=pulse2statetick   deterministic market-state snapshot (NO LLM) — 1-5 min cadence
//   op=pulse2collect     LLM narrative collection + provenance + event fold — 15-60 min
//   op=pulse2refine      Fable editorial pass (crowding/contrarian) — after collect
//   op=pulse2grade       per-horizon outcome appends + evaluation — daily
//
// Scheduling reality (Hobby plan: ONE daily Vercel cron): the nightly warm chain runs
// collect→refine→grade daily; intraday cadence requires the GitHub Actions workflow
// (.github/workflows/pulse2-tick.yml). The page reports the ACTUAL cadence honestly.

const { sessionInfoAt, assessFreshness, SESSION } = require('./market-session');
const { buildIntradayFeatures } = require('./intraday-features');
const { fetchIntradayBatch } = require('./intraday-data');
const marketState = require('./pulse2-market-state');
const provenance = require('./pulse2-provenance');
const direction = require('./pulse2-direction');
const eventsLib = require('./pulse2-events');
const grade = require('./pulse2-grade');
const views = require('./pulse2-views');
const alertsLib = require('./pulse2-alerts');
const clocks = require('./pulse2-clocks');
const store = require('./pulse2-store');
const { enrichTickers, extractCitations } = require('./pulse-enrich');

const COLLECT_MODEL = 'claude-haiku-4-5-20251001';
const REFINE_MODEL = 'claude-fable-5';
const COLLECT_TIMEOUT_MS = 90000;    // tracker maxDuration is 300s — generous but bounded
const REFINE_TIMEOUT_MS = 60000;
const COLLECT_MAX_SEARCHES = 3;
const COLLECT_N = 12;
const INTRADAY_EVENT_CAP = 12;
const SETUP_MAX = 8;
const GRADE_TICKER_FETCHES = 10;
const STATE_LEASE_MS = 45 * 1000;

function client() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
}

// ── op=pulse2statetick — deterministic market state (NO LLM) ─────────────────
async function runPulse2StateTick(req, res) {
  const t0 = Date.now();
  const now = new Date();
  const nowIso = now.toISOString();
  const sessionInfo = sessionInfoAt(now);

  if (store.hasStore()) {
    try {   // lease: overlapping scheduler runs yield (idempotent either way)
      const lease = await store.readJSON('pulse/v2/market-state/lease.json', null);
      if (lease && lease.at && Date.now() - Date.parse(lease.at) < STATE_LEASE_MS) {
        return res.status(200).json({ ok: true, skipped: 'lease-held', leaseAt: lease.at });
      }
      await store.writeJSON('pulse/v2/market-state/lease.json', { at: nowIso }, 0);
    } catch { /* best-effort */ }
  }

  const symbols = [...marketState.INDEX_TICKERS, ...Object.keys(marketState.SECTOR_ETFS), marketState.VIX_TICKER];
  let batch = { byTicker: {}, coverage: { note: 'fetch failed' } };
  try { batch = await fetchIntradayBatch(symbols, { now, cap: symbols.length + 1 }); } catch { /* honest degrade below */ }
  const byTicker = batch.byTicker || {};

  // VIX read from its intraday bars (no volume — level + day change only).
  let vixState = null;
  const vix = byTicker[marketState.VIX_TICKER];
  if (vix && vix.ok && (vix.bars || []).length) {
    const last = vix.bars[vix.bars.length - 1];
    const prevC = vix.prevClose;
    vixState = {
      available: true, level: +last.c.toFixed(2),
      dayReturnPct: prevC ? +(((last.c - prevC) / prevC) * 100).toFixed(2) : null,
      asOf: last.t,
    };
  }

  // Macro: reuse today's persisted read, else compute (3 daily-history fetches).
  const prevDoc = await store.readMarketState().catch(() => null);
  let macro = null, macroAsOf = null;
  const prevMacro = prevDoc && prevDoc.state && prevDoc.state.macro && prevDoc.state.macro.available ? prevDoc.state.macro : null;
  if (prevMacro && prevMacro.asOf === sessionInfo.etDate) {
    macro = { regime: prevMacro.regime, macroRisk: prevMacro.macroRisk, vix: prevMacro.vix, credit: prevMacro.credit, asOf: prevMacro.asOf };
    macroAsOf = prevMacro.asOf;
  } else {
    try { macro = await require('./macro').fetchMacro(); macroAsOf = macro && macro.asOf; } catch { macro = null; }
  }

  // Sector leadership + breadth from the persisted RLT scan (cheap reads, never computed here).
  let sectorLeadership = null, breadth = null, sectorDataAsOf = null;
  try {
    const rlt = await require('./rlt-store').loadLatest();
    if (rlt && rlt.sectorLeadership) { sectorLeadership = rlt.sectorLeadership; sectorDataAsOf = rlt.sectorLeadership.asOf || null; }
    const states = rlt && rlt.sectorStates && rlt.sectorStates.states ? Object.values(rlt.sectorStates.states) : [];
    const rows = states.filter(s => s && s.vector && s.vector.breadth50 != null);
    if (rows.length >= 6) {
      const members = rows.reduce((s, r) => s + (r.vector.memberCount || 0), 0);
      const w = key => members
        ? rows.reduce((s, r) => s + (r.vector[key] || 0) * (r.vector.memberCount || 0), 0) / members : null;
      breadth = {
        pctAbove50dma: +(w('breadth50') * 100).toFixed(1),
        pctAbove200dma: w('breadth200') != null ? +(w('breadth200') * 100).toFixed(1) : null,
        newHighs63: rows.reduce((s, r) => s + (r.vector.newHighs || 0), 0),
        newLows63: rows.reduce((s, r) => s + (r.vector.newLows || 0), 0),
        sample: members || null,
        source: 'rlt-sector-aggregate',
        asOf: rlt.sectorStates.asOf || sectorDataAsOf,
      };
    }
  } catch { /* stays unavailable with reason */ }

  const prevState = prevDoc && prevDoc.state ? prevDoc.state : null;
  const state = marketState.buildMarketState({
    intradayByTicker: byTicker, dailyByTicker: {}, vixState,
    macro, macroAsOf, sectorLeadership, breadth, sessionInfo, prevState, now,
  });

  // Freshness verdict for the snapshot's own data.
  const assessed = assessFreshness({
    sourceKind: state.coverage.intradayCount > 0 ? 'intraday' : (state.marketDataAsOf ? 'daily' : null),
    barTimestamp: state.marketDataAsOf, barIntervalSec: 300, now,
  });

  // Market-level transition alerts (mode / breadth / leadership), deduped + cooled.
  const prevAlerts = await store.readMarketAlerts().catch(() => ({ alerts: [], state: {} }));
  const mTrans = alertsLib.marketTransitions(prevState, state);
  const derived = alertsLib.deriveAlerts({
    transitions: mTrans,
    context: {
      marketMode: state.mode.mode, sessionState: state.sessionState,
      marketDataFreshness: clocks.marketDataFreshnessOf(assessed),
    },
    prevState: prevAlerts.state,
    now: () => nowIso,
  });

  const doc = {
    schema: 'pulse2-market-state-doc-v1',
    at: nowIso,
    state,
    assessed: { freshnessState: assessed.freshnessState, ageSeconds: assessed.ageSeconds, delayed: assessed.delayed },
    sectorDataAsOf,
    coverage: { ...state.coverage, provider: (batch.coverage && batch.coverage.provider) || 'yahoo-chart', note: batch.coverage && batch.coverage.note },
    elapsedMs: Date.now() - t0,
  };

  let persisted = false;
  if (store.hasStore()) {
    if (prevDoc) await store.writeJSON(store.KEYS.MARKET_STATE_PREV, prevDoc, 0).catch(() => {});
    persisted = await store.writeVerified(store.KEYS.MARKET_STATE, doc, b => b.at === nowIso);
    if (derived.alerts.length || !prevAlerts.alerts) {
      await store.writeJSON(store.KEYS.MARKET_ALERTS, {
        alerts: [...(prevAlerts.alerts || []), ...derived.alerts].slice(-60),
        state: derived.state,
      }, 0).catch(() => {});
    }
    await store.mergeHealth('marketState', {
      lastAttemptAt: nowIso,
      lastSuccessAt: persisted ? nowIso : undefined,
      lastError: persisted ? null : 'persist-failed',
      coverage: doc.coverage, mode: state.mode.mode,
      durationMs: doc.elapsedMs,
    }).catch(() => {});
  }
  const failed = store.hasStore() && !persisted;
  return res.status(failed ? 500 : 200).json({
    ok: !failed, persisted, mode: state.mode.mode, alerts: derived.alerts.length,
    coverage: doc.coverage, elapsedMs: doc.elapsedMs,
  });
}

// ── The v2 collection tool (claim-level provenance in the schema) ────────────
const COLLECT_TOOL = {
  name: 'submit_pulse2',
  description: `Return up to ${COLLECT_N} market-moving developments found via web search, most material first.`,
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            headline: { type: 'string', description: 'one factual sentence' },
            tickers: { type: 'array', items: { type: 'string' }, description: 'US tickers (empty for macro)' },
            eventFamily: { type: 'string', enum: eventsLib.EVENT_FAMILIES },
            direction: { type: 'string', enum: ['bullish', 'bearish', 'mixed', 'non_directional', 'unknown'], description: 'the direction the DEVELOPMENT implies for the named tickers — not your trading opinion' },
            eventDate: { type: 'string', description: 'YYYY-MM-DD the underlying event occurred/occurs, or "" if unclear' },
            claims: {
              type: 'array',
              description: 'up to 2 MATERIAL factual claims. Each sourceUrls entry MUST be a URL your web search actually returned — never invent one.',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  sourceUrls: { type: 'array', items: { type: 'string' } },
                  conflicted: { type: 'boolean', description: 'true if sources materially disagree' },
                },
                required: ['text', 'sourceUrls'],
              },
            },
            denied: { type: 'boolean', description: 'true if the story has been denied/corrected by a credible source' },
            prominence: { type: 'integer', description: '1-100 editorial estimate of how widely discussed (NOT a measured count)' },
          },
          required: ['headline', 'tickers', 'eventFamily', 'direction', 'claims'],
        },
      },
    },
    required: ['items'],
  },
};

const COLLECT_PROMPT = `You are a markets desk analyst. Using at most ${COLLECT_MAX_SEARCHES} focused web searches (e.g. "market moving news today", "biggest stock movers news", "macro calendar this week"), find the developments most likely to move US markets right now: earnings/guidance, analyst moves, FDA/regulatory, M&A, macro/rates, and genuinely market-moving social themes.

For each item report the FACTS: what happened (headline), affected tickers, the event family, the direction the development itself implies, the event date, and up to 2 material claims each mapped to the REAL source URLs your search returned. NEVER invent a URL, count, or source — a claim with no real source keeps an empty sourceUrls and will be labeled unverified. Mark denied=true only if a credible source denied the story. prominence is your editorial estimate, clearly not a measurement.

After searching, call submit_pulse2 immediately — no plain text.`;

// ── op=pulse2collect — narrative collection + provenance + event fold ────────
async function runPulse2Collect(req, res) {
  const t0 = Date.now();
  const now = new Date();
  const nowIso = now.toISOString();
  const sessionInfo = sessionInfoAt(now);
  const date = sessionInfo.etDate;
  const c = client();
  if (!c) return res.status(200).json({ ok: false, error: 'no ANTHROPIC_API_KEY — narrative collection unavailable' });
  if (!store.hasStore()) return res.status(200).json({ ok: false, error: 'no Blob store — cannot persist narratives' });

  // 1. Gather (one bounded search+structure call).
  let msg;
  try {
    msg = await c.messages.create({
      model: COLLECT_MODEL,
      max_tokens: 6000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: COLLECT_MAX_SEARCHES }, COLLECT_TOOL],
      messages: [{ role: 'user', content: COLLECT_PROMPT }],
    }, { timeout: COLLECT_TIMEOUT_MS });
  } catch (e) {
    await store.mergeHealth('narratives', { lastAttemptAt: nowIso, lastError: 'gather:' + (e && e.message || e) }).catch(() => {});
    return res.status(200).json({ ok: false, error: 'gather failed: ' + (e && e.message || e) });
  }
  const { sources } = extractCitations(msg);
  const index = provenance.buildSourceIndex(sources);
  const tool = (msg.content || []).find(b => b.type === 'tool_use' && b.name === COLLECT_TOOL.name);
  const rawItems = tool && tool.input && Array.isArray(tool.input.items) ? tool.input.items.slice(0, COLLECT_N) : [];
  if (!rawItems.length) {
    await store.mergeHealth('narratives', { lastAttemptAt: nowIso, lastError: 'no-items' }).catch(() => {});
    return res.status(200).json({ ok: false, error: 'collection returned no items' });
  }

  // 2. Claim-level provenance (anti-fabrication: unmatched URLs dropped).
  const items = rawItems.map(it => {
    const claims = provenance.sanitizeClaims(it.claims, index);
    const tickers = (Array.isArray(it.tickers) ? it.tickers : [])
      .map(t => String(t).toUpperCase().replace(/[^A-Z.^-]/g, '').slice(0, 8)).filter(Boolean).slice(0, 6);
    return {
      headline: String(it.headline || '').slice(0, 240),
      tickers,
      eventFamily: eventsLib.sanitizeFamily(it.eventFamily),
      direction: direction.sanitizeDirection(it.direction),
      eventDate: /^\d{4}-\d{2}-\d{2}$/.test(String(it.eventDate || '')) ? it.eventDate : null,
      claims,
      evidence: provenance.rollupEvidence(claims),
      denied: it.denied === true,
      prominence: Math.max(1, Math.min(100, parseInt(it.prominence, 10) || 50)),
      prominenceLabel: 'editorial LLM estimate — not a measured mention count',
    };
  }).filter(it => it.headline);

  // 3. Enrichment: daily context for all event tickers; intraday features when in-session.
  const allTickers = [...new Set(items.flatMap(it => it.tickers))];
  let dailyEnrich = {};
  try { dailyEnrich = await enrichTickers(allTickers, { max: 20 }); } catch { dailyEnrich = {}; }

  let intradayFeatures = {};
  let spyBars = [];
  if (sessionInfo.marketSession === SESSION.REGULAR || sessionInfo.marketSession === SESSION.AFTERHOURS) {
    try {
      const evTickers = allTickers.slice(0, INTRADAY_EVENT_CAP);
      const batch = await fetchIntradayBatch(['SPY', ...evTickers], { now, cap: INTRADAY_EVENT_CAP + 1 });
      const spyRes = batch.byTicker.SPY;
      spyBars = spyRes && spyRes.ok ? spyRes.bars : [];
      for (const t of evTickers) {
        const r = batch.byTicker[t];
        if (r && r.ok && (r.bars || []).length) {
          intradayFeatures[t] = buildIntradayFeatures({
            todayBars: r.bars, priorSessions: r.priorSessions || [], spyTodayBars: spyBars,
            now, prevClose: r.prevClose,
          });
        }
      }
    } catch { intradayFeatures = {}; }
  }

  // 3b. Swing setups for the most relevant tickers (bounded daily-history fetches) —
  // computed BEFORE the ledger fold so setup validity is captured in the IMMUTABLE
  // first-seen snapshot (the price-only vs price-plus-Pulse comparison depends on it).
  const setupTickers = allTickers.slice(0, SETUP_MAX);
  const setups = {};
  try {
    const { fetchDailyHistory } = require('./screener');
    const { evaluateSetup } = require('./stock-setup');
    await Promise.all(setupTickers.map(async t => {
      try {
        const hist = await fetchDailyHistory(t, '6mo');
        if (hist && hist.candles) setups[t] = evaluateSetup(hist.candles);
      } catch { /* absent setup handled honestly downstream */ }
    }));
  } catch { /* setups stay empty */ }

  // 4. Prior ledger + since-detection reaction per (event, primary ticker).
  const eventsDoc = await store.readEvents().catch(() => ({ events: [] }));
  const prevEvents = eventsDoc.events || [];
  const marketStateDoc = await store.readMarketState().catch(() => null);

  const observations = items.map(it => {
    const featuresByTicker = {};
    for (const t of it.tickers) {
      const daily = dailyEnrich[t] || null;
      const intra = intradayFeatures[t] || null;
      featuresByTicker[t] = {
        ret3: daily ? daily.ret3 : null, dayReturn: daily ? daily.dayReturn : null,
        atrExt: daily ? daily.atrExt : null, relVol: daily ? daily.relVol : null,
        asOfClose: daily ? daily.asOfClose : null,
        sameTimeRelVol: intra ? intra.timeOfDayRelVol : null,
        vwapDistPct: intra && intra.vwapDist != null ? +(intra.vwapDist * 100).toFixed(2) : null,
        setupValid: setups[t] ? setups[t].valid === true : null,
      };
    }
    return {
      headline: it.headline, tickers: it.tickers, claim: (it.claims[0] && it.claims[0].text) || it.headline,
      eventFamily: it.eventFamily, eventDate: it.eventDate, direction: it.direction,
      evidence: it.evidence, claims: it.claims,
      independentLineages: provenance.independentLineageCount(it.claims.flatMap(cl => cl.sourceRefs), index),
      denied: it.denied,
      featuresByTicker,
      marketStateRef: marketStateDoc ? marketStateDoc.at : null,
      modelVersion: clocks.MODEL_VERSION,
    };
  });

  const generation = nowIso;
  const cycleId = 'cy_' + date.replace(/-/g, '') + '_' + String(now.getUTCHours()).padStart(2, '0') + String(now.getUTCMinutes()).padStart(2, '0');
  const folded = eventsLib.foldObservations(prevEvents, observations, { date, generation, cycleId, now: () => nowIso });

  // 5. Reaction + view decisions per active event.
  const prevByKey = new Map();
  for (const e of prevEvents) prevByKey.set(e.id, e);
  const reactionTransitions = [];
  const dayList = [], swingCandidates = [], investorList = [];

  const activeRecent = folded.events.filter(e => !e.expired && e.missedCycles === 0 && e.category === 'ticker');
  for (const ev of activeRecent) {
    const primary = ev.tickers[0];
    const f = intradayFeatures[primary] || null;
    const daily = dailyEnrich[primary] || null;
    const firstClose = ev.firstSeenFeatures && ev.firstSeenFeatures[primary] ? ev.firstSeenFeatures[primary].asOfClose : null;
    const nowClose = daily ? daily.asOfClose : null;
    const sincePct = (firstClose && nowClose) ? ((nowClose - firstClose) / firstClose) * 100 : (daily ? daily.dayReturn : null);
    const assessed = assessFreshness({
      sourceKind: f && f.hasIntraday ? 'intraday' : (daily ? 'daily' : null),
      barTimestamp: f && f.completedBarEndAt ? f.completedBarEndAt : null,
      barIntervalSec: 300, now,
    });
    const reactionInfo = direction.assessReaction({
      direction: ev.currentDirection,
      features: {
        residualPct: null, rawPct: sincePct,
        vsVWAP: f && f.vwapDist != null ? f.vwapDist * 100 : null,
        sameTimeRelVol: f ? f.timeOfDayRelVol : null,
        atrExt: daily ? daily.atrExt : null,
        sectorConfirms: null,
        brokeStructure: f ? f.breakoutFailed === true : null,
      },
      dataFresh: assessed.freshnessState === 'live' || assessed.freshnessState === 'live-extended' || !!daily,
    });
    const prevReaction = prevByKey.get(ev.id) ? prevByKey.get(ev.id).reaction : null;
    ev.reaction = reactionInfo.reaction;
    ev.reactionWhy = reactionInfo.why;
    ev.matrixCell = direction.catalystMatrixCell({
      evidence: ev.evidence, direction: ev.currentDirection, reaction: reactionInfo.reaction,
      isRepeat: (ev.observationCount || 0) > 2 && !ev.newLineageLastObs, movePct: sincePct,
    });
    if (prevReaction && prevReaction !== ev.reaction) {
      reactionTransitions.push({ eventId: ev.id, kind: 'reaction', from: prevReaction, to: ev.reaction, headline: ev.headline, date, evidence: ev.evidence });
    }

    // Views.
    const day = views.dayTradeDecision({
      event: ev, ticker: primary, features: f, reactionInfo,
      executionAllowed: assessed.executionAllowed, sessionState: sessionInfo.marketSession,
    });
    const swing = views.swingDecision({ event: ev, ticker: primary, setup: setups[primary] || null, enrichment: daily });
    const investor = views.investorDecision({ event: ev, ticker: primary, enrichment: daily });
    const prevTrade = prevByKey.get(ev.id) ? prevByKey.get(ev.id).tradeStates : null;
    ev.tradeStates = { day: day.tradeState, swing: swing.tradeState, investor: investor.tradeState };
    for (const [v, cur] of Object.entries(ev.tradeStates)) {
      const was = prevTrade ? prevTrade[v] : null;
      if (was && was !== cur) {
        reactionTransitions.push({
          eventId: ev.id, kind: 'trade', from: was, to: cur, headline: ev.headline, date,
          evidence: ev.evidence, horizon: v, trigger: (v === 'day' ? day.trigger : v === 'swing' ? swing.trigger : null),
          invalidation: (v === 'day' ? day.invalidation : v === 'swing' ? swing.invalidation : null),
        });
      }
    }
    dayList.push(day); swingCandidates.push(swing); investorList.push(investor);
  }

  const allTransitions = [...folded.transitions, ...reactionTransitions];

  // 6. Alerts (event-scope), deduped + cooled.
  const alertState = await store.readAlertState().catch(() => ({ emitted: {}, lastByKind: {} }));
  const prevAlertsDoc = await store.readAlerts().catch(() => ({ alerts: [] }));
  const derivedAlerts = alertsLib.deriveAlerts({
    transitions: allTransitions,
    context: {
      marketMode: marketStateDoc && marketStateDoc.state ? marketStateDoc.state.mode.mode : null,
      sessionState: sessionInfo.marketSession,
      narrativeFreshness: 'CURRENT_NARRATIVE',
    },
    prevState: alertState,
    now: () => nowIso,
  });

  // 7. Section lists for the UI (deterministic, from measured states).
  const active = folded.events.filter(e => !e.expired);
  const sections = {
    freshVerified: active.filter(e => (e.evidence === 'VERIFIED' || e.evidence === 'SUPPORTED') && e.firstSeenDate === date).map(e => e.id),
    unreacted: active.filter(e => e.reaction === 'UNREACTED' && (e.evidence === 'VERIFIED' || e.evidence === 'SUPPORTED')).map(e => e.id),
    priceConfirmed: active.filter(e => e.tradeStates && Object.values(e.tradeStates).includes('PRICE_CONFIRMED')).map(e => e.id),
    crowdedExtended: active.filter(e => e.reaction === 'EXTENDED' || (e.matrixCell || '').endsWith('_EXTENDED')).map(e => e.id),
    contradictions: active.filter(e => e.reaction === 'CONTRADICTED' || e.evidence === 'CONFLICTED' || e.invalidated).map(e => e.id),
  };

  // 8. Persist (generation-guarded).
  const narrativesDoc = {
    schema: 'pulse2-narratives-v1',
    generation, generatedAt: nowIso, date, cycleId,
    stage: 'collected',
    modelVersion: clocks.MODEL_VERSION,
    items,
    views: { day: dayList, swing: swingCandidates, investor: investorList },
    sections,
    sources: provenance.indexToJSON(index),
    sourceCoverageAsOf: nowIso,
    disclaimer: 'Evidence-graded market intelligence. Verified claims map to real sources; prominence is an editorial LLM estimate, never a measured count. Not investment advice; directional value is unproven until prospectively measured.',
  };
  const persisted = await store.writeVerified(store.KEYS.NARRATIVES, narrativesDoc, b => b.generation === generation);
  await store.writeVerified(store.KEYS.EVENTS, { events: folded.events, updatedAt: nowIso }, b => b.updatedAt === nowIso);
  const transDoc = await store.readTransitions().catch(() => ({ transitions: [] }));
  await store.writeJSON(store.KEYS.TRANSITIONS, { transitions: [...(transDoc.transitions || []), ...allTransitions].slice(-500) }, 0).catch(() => {});
  await store.writeJSON(store.KEYS.ALERTS, { alerts: [...(prevAlertsDoc.alerts || []), ...derivedAlerts.alerts].slice(-80) }, 0).catch(() => {});
  await store.writeJSON(store.KEYS.ALERT_STATE, derivedAlerts.state, 0).catch(() => {});
  await store.writeSnapshot(generation.replace(/[:.]/g, ''), narrativesDoc).catch(() => {});
  await store.mergeHealth('narratives', {
    lastAttemptAt: nowIso, lastSuccessAt: persisted ? nowIso : undefined,
    lastError: persisted ? null : 'persist-failed',
    items: items.length, events: folded.events.length,
    transitions: allTransitions.length, alerts: derivedAlerts.alerts.length,
    droppedFabricatedUrls: items.reduce((s, it) => s + it.claims.reduce((x, cl) => x + (cl.droppedUrls || 0), 0), 0),
    durationMs: Date.now() - t0,
  }).catch(() => {});

  const failed = !persisted;
  return res.status(failed ? 500 : 200).json({
    ok: !failed, persisted, generation,
    items: items.length, events: folded.events.length,
    transitions: allTransitions.length, alerts: derivedAlerts.alerts.length,
    elapsedMs: Date.now() - t0,
  });
}

// ── op=pulse2refine — Fable editorial pass (crowding/contrarian; judgment only) ──
const REFINE_TOOL = {
  name: 'submit_pulse2_refined',
  description: 'Return editorial judgment per item id: crowding read + one contrarian line. Judgment only — never new facts, sources, or numbers.',
  input_schema: {
    type: 'object',
    properties: {
      reads: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer', description: 'the item number you are annotating' },
            crowding: { type: 'string', enum: ['early', 'building', 'crowded', 'capitulation'] },
            contrarian: { type: 'string', description: 'one honest desk line — is this priced/fadeable?' },
            duplicateOf: { type: 'integer', description: 'index of the item this duplicates, or -1' },
          },
          required: ['index', 'crowding', 'contrarian'],
        },
      },
    },
    required: ['reads'],
  },
};

async function runPulse2Refine(req, res) {
  const now = new Date();
  const nowIso = now.toISOString();
  const c = client();
  if (!c) return res.status(200).json({ ok: false, error: 'no ANTHROPIC_API_KEY' });
  if (!store.hasStore()) return res.status(200).json({ ok: false, error: 'no store' });
  const doc = await store.readNarratives().catch(() => null);
  if (!doc || !Array.isArray(doc.items) || !doc.items.length) {
    return res.status(200).json({ ok: false, error: 'no collected narratives to refine' });
  }
  if (doc.stage === 'refined' && req.query.force !== '1') {
    return res.status(200).json({ ok: true, alreadyRefined: true, generation: doc.generation });
  }
  const generation = doc.generation;
  const lines = doc.items.map((it, i) =>
    `${i}. [${(it.tickers || []).join(',') || 'macro'}] ${it.headline} | family ${it.eventFamily} | direction ${it.direction} | evidence ${it.evidence}`).join('\n');
  let refined = null;
  try {
    const msg = await c.messages.create({
      model: REFINE_MODEL, max_tokens: 3000,
      output_config: { effort: 'low' },     // bound Fable's always-on thinking (proven pattern)
      tools: [REFINE_TOOL], tool_choice: { type: 'tool', name: REFINE_TOOL.name },
      messages: [{ role: 'user', content: `Senior desk editor. For each numbered item, give a crowding read (early/building/crowded/capitulation) and ONE honest contrarian line (is it priced? fade risk?). Mark true duplicates with duplicateOf. Judgment only — no new facts.\n\n${lines}` }],
    }, { timeout: REFINE_TIMEOUT_MS });
    const tool = (msg.content || []).find(b => b.type === 'tool_use' && b.name === REFINE_TOOL.name);
    refined = tool && tool.input && Array.isArray(tool.input.reads) ? tool.input.reads : null;
  } catch (e) {
    return res.status(200).json({ ok: false, error: 'refine failed: ' + (e && e.message || e), served: 'collected stage remains' });
  }
  if (!refined) return res.status(200).json({ ok: false, error: 'no refined reads' });

  // Generation guard: only annotate the exact generation we read.
  const nowDoc = await store.readNarratives().catch(() => null);
  if (!nowDoc || nowDoc.generation !== generation) {
    return res.status(200).json({ ok: false, superseded: true });
  }
  const items = doc.items.map((it, i) => {
    const r = refined.find(x => x && x.index === i);
    if (!r) return it;
    return {
      ...it,
      crowding: ['early', 'building', 'crowded', 'capitulation'].includes(r.crowding) ? r.crowding : null,
      contrarian: String(r.contrarian || '').slice(0, 300) || null,
      duplicateOf: Number.isInteger(r.duplicateOf) && r.duplicateOf >= 0 && r.duplicateOf !== i ? r.duplicateOf : null,
      editorialNote: 'crowding/contrarian are model inference, not measurements',
    };
  });
  const updated = { ...doc, items, stage: 'refined', refinedAt: nowIso };
  const persisted = await store.writeVerified(store.KEYS.NARRATIVES, updated, b => b.stage === 'refined' && b.generation === generation);
  await store.mergeHealth('narratives', { lastRefineAt: nowIso, refinePersisted: persisted }).catch(() => {});
  return res.status(persisted ? 200 : 500).json({ ok: persisted, generation, refined: items.filter(x => x.crowding).length });
}

// ── op=pulse2grade — per-horizon outcome appends (daily) ─────────────────────
async function runPulse2Grade(req, res) {
  const t0 = Date.now();
  const now = new Date();
  const nowIso = now.toISOString();
  const sessionInfo = sessionInfoAt(now);
  if (!store.hasStore()) return res.status(200).json({ ok: false, error: 'no store', graded: 0 });

  const eventsDoc = await store.readEvents().catch(() => ({ events: [] }));
  const outDoc = await store.readOutcomes().catch(() => ({ outcomes: [] }));
  const outcomes = outDoc.outcomes || [];
  const byPair = new Map(outcomes.map(o => [o.eventId + '|' + o.ticker, o]));

  // Every (event, ticker) pair with any not-yet-recorded horizon is a grading candidate —
  // multi-ticker events grade EVERY ticker; nothing is "fully graded" until 63 sessions.
  const pairs = [];
  for (const ev of eventsDoc.events || []) {
    if (ev.category !== 'ticker' || !(ev.tickers || []).length) continue;
    if (ev.firstSeenDate >= sessionInfo.etDate) continue;   // needs at least one elapsed session
    for (const t of ev.tickers) {
      const existing = byPair.get(ev.id + '|' + t);
      if (existing && existing.fullyMatured) continue;
      pairs.push({ ev, ticker: t, existing });
    }
  }
  const batchPairs = pairs.slice(0, GRADE_TICKER_FETCHES);
  if (!batchPairs.length) {
    const summary = grade.summarizeOutcomes(outcomes);
    const comparison = grade.compareSetupVsSetupPlusPulse(outcomes);
    await store.writeJSON(store.KEYS.OUTCOMES, { ...outDoc, summary, comparison, updatedAt: nowIso }, 0).catch(() => {});
    return res.json({ ok: true, graded: 0, pending: pairs.length, total: outcomes.length });
  }

  const { fetchDailyHistory } = require('./screener');
  const barsCache = new Map();
  const getBars = async t => {
    if (barsCache.has(t)) return barsCache.get(t);
    let rows = null;
    try {
      const hist = await fetchDailyHistory(t, '1y');
      rows = hist && hist.candles ? hist.candles : null;
    } catch { rows = null; }
    barsCache.set(t, rows);
    return rows;
  };
  const spyRows = await getBars('SPY');
  let SECTOR_OF = {}, benchFor = () => null;
  try { SECTOR_OF = require('./universe').SECTOR_OF; benchFor = require('./readthrough').benchFor; } catch { /* sector-relative stays null */ }

  let appendedCount = 0;
  for (const { ev, ticker, existing } of batchPairs) {
    const rows = await getBars(ticker);
    if (!rows) continue;
    const sector = SECTOR_OF[ticker] || null;
    const etf = sector ? benchFor(sector) : null;
    const sectorRows = etf ? await getBars(etf) : null;
    const setupValid = ev.firstSeenFeatures && ev.firstSeenFeatures[ticker]
      ? ev.firstSeenFeatures[ticker].setupValid === true : false;
    const { outcome, appended } = grade.gradeEventTicker({
      event: ev, ticker, rows, spyRows, sectorRows, sectorBenchmark: etf, existing,
    });
    if (outcome && appended.length) {
      outcome.updatedAt = nowIso;
      outcome.setupValidAtDecision = existing ? existing.setupValidAtDecision ?? setupValid : setupValid;
      byPair.set(ev.id + '|' + ticker, outcome);
      appendedCount += appended.length;
    }
  }

  const merged = [...byPair.values()].slice(-3000);
  const summary = grade.summarizeOutcomes(merged);
  const comparison = grade.compareSetupVsSetupPlusPulse(merged);
  const persisted = await store.writeVerified(store.KEYS.OUTCOMES,
    { outcomes: merged, summary, comparison, updatedAt: nowIso }, b => b.updatedAt === nowIso);
  await store.mergeHealth('grading', {
    lastAttemptAt: nowIso, lastSuccessAt: persisted ? nowIso : undefined,
    lastError: persisted ? null : 'persist-failed',
    horizonsAppended: appendedCount, pairsPending: pairs.length - batchPairs.length,
    durationMs: Date.now() - t0,
  }).catch(() => {});
  return res.status(persisted ? 200 : 500).json({
    ok: persisted, graded: appendedCount, pairs: batchPairs.length,
    pending: pairs.length - batchPairs.length, total: merged.length,
  });
}

module.exports = {
  runPulse2StateTick, runPulse2Collect, runPulse2Refine, runPulse2Grade,
  COLLECT_TOOL, REFINE_TOOL, COLLECT_MODEL, REFINE_MODEL,
  COLLECT_N, INTRADAY_EVENT_CAP, SETUP_MAX, GRADE_TICKER_FETCHES,
};

'use strict';
// OPTIONS INTELLIGENCE ENGINE v2 — ROUTES (the only storage-owning layer).
//
//   op=optionsscan2     PRIVILEGED writer — the scheduled scan: dynamic universe,
//                       PIT observations, baselines, anomaly, interpretation,
//                       trade gate, lifecycle fold, OI attribution, radar + health.
//                       Idempotent per decision session and safe under retries.
//   op=optionsresolve2  PRIVILEGED writer — grades matured events + control
//                       cohort, builds the prospective evidence report.
//   op=optionsradar     public read — the current radar doc (never scans).
//   op=optionsevidence2 public read — the evidence report.
//   op=optionshealth2   public read — coverage/freshness/provider diagnostics.
//
// Storage (all v2 keys are NEW — nothing legacy is rewritten):
//   optionsflow-v2/obs/<session>.json   immutable per-session observations
//   optionsflow-v2/events.json          lifecycle event ledger (single writer)
//   optionsflow-v2/controls.json        price-only control episodes
//   optionsflow-v2/radar.json           latest published radar
//   optionsflow-v2/health.json          rolling scan health
//   optionsflow-v2/evidence.json        evaluation report

const { readJSON, writeJSON, hasStore, readAllByPrefix } = require('./store');
const { sessionInfoAt, lastCompletedRegularSession } = require('./market-session');
const { fetchDailyHistory } = require('./screener');
const { fetchEarningsInfo } = require('./fundamentals');
const { evaluateSetup } = require('./stock-setup');
const { SECTOR_OF, SP500 } = require('./universe');

const cfg = require('./options-config-v2');
const { optionsV2Enabled, resolveOptionsV2Mode } = require('./options-flags-v2');
const provider = require('./options-provider-v2');
const { buildUniverse } = require('./options-universe-v2');
const { observeTicker, totals } = require('./options-observe-v2');
const anomaly = require('./options-anomaly-v2');
const { interpretTicker, interpretationSide } = require('./options-interpret-v2');
const gate = require('./options-trade-gate-v2');
const lifecycle = require('./options-lifecycle-v2');
const health = require('./options-health-v2');
const evalv2 = require('./options-evaluate-v2');
const of = require('./optionsflow');

const OBS_PREFIX = 'optionsflow-v2/obs/';
const OBS_RE = /^optionsflow-v2\/obs\/\d{4}-\d{2}-\d{2}\.json$/;
const EVENTS_KEY = 'optionsflow-v2/events.json';
const CONTROLS_KEY = 'optionsflow-v2/controls.json';
const RADAR_KEY = 'optionsflow-v2/radar.json';
const HEALTH_KEY = 'optionsflow-v2/health.json';
const EVIDENCE_KEY = 'optionsflow-v2/evidence.json';

const FEATURE_NAME = 'Options Activity Radar — Delayed Chain Anomalies';
const SCAN_DEADLINE_MS = 150_000;   // hard time-box inside the 240s chain budget
const BASELINE_DOCS_MAX = 25;       // sessions of history fed to the baselines
const MAX_CONTROLS = 400;
const RAW_ROWS_MAX = 100;

// ── Session context: which decision session does a snapshot attest? ──────────
// Regular/after-hours of a trading day → TODAY's session (partial during RTH,
// complete after the close). Premarket / weekend / holiday → the chain still
// shows the LAST COMPLETED session's totals, so that is the session we may key
// (a "late capture", never a fresh weekend session).
function sessionContext(now = new Date()) {
  const info = sessionInfoAt(now);
  if (info.isTradingDay && (info.marketSession === 'regular' || info.marketSession === 'afterhours')) {
    const fraction = info.marketSession === 'regular'
      ? Math.max(0, Math.min(1, (info.etMinutes - info.regularOpenMin) / (info.regularCloseMin - info.regularOpenMin)))
      : 1;
    return { session: info.etDate, sessionFraction: +fraction.toFixed(3), lateCapture: false, info };
  }
  return { session: lastCompletedRegularSession(now), sessionFraction: 1, lateCapture: true, info };
}

// ── Dynamic universe sources (each best-effort; the core list is the floor) ──
async function loadUniverseSources() {
  const sources = { core: of.LIQUID_OPTIONS, screener: [], movers: [], catalysts: [], broad: [] };
  try {
    const { recentCandidateTickers } = require('./capture-routes');
    const m = await recentCandidateTickers(3);
    sources.screener = [...m.keys()];
  } catch { /* screener candidates unavailable */ }
  try {
    const { loadTechUniverse, viewsOf } = require('./tech-command-universe');
    const doc = await loadTechUniverse().catch(() => null);
    if (doc) sources.broad = viewsOf(doc).liquidOptionsProxy.tickers;
  } catch { /* tech universe unavailable */ }
  if (!sources.broad.length) sources.broad = SP500;   // deterministic broad fallback
  return sources;
}

// Candles for setup evaluation — from the warmed candle cache only (no network).
async function candlesForTickers(tickers) {
  const { loadCandleCache, cacheGet } = require('./candle-cache');
  const want = new Set((tickers || []).map(t => String(t).toUpperCase()));
  const map = new Map();
  for (const scope of ['large', 'small', 'micro', 'expanded']) {
    if (map.size >= want.size) break;
    const doc = await loadCandleCache(scope).catch(() => null);
    if (!doc || !doc.data) continue;
    for (const t of want) {
      if (map.has(t)) continue;
      const entry = cacheGet(doc, t);
      if (entry && entry.candles && entry.candles.length >= 60) map.set(t, entry.candles);
    }
  }
  return map;
}

// ── Novice-facing plain-language summary for one event ───────────────────────
function noviceSummary(ev) {
  const bits = [];
  bits.push(`${ev.ticker}: ${String(ev.anomaly.activityLabel || '').toLowerCase()}` +
    (ev.anomaly.baselineScored
      ? ` — option volume at the ${ev.anomaly.anomalyPercentile ?? '?'}th percentile of its own ${ev.anomaly.baselineSampleSize}-session norm.`
      : ` — admitted on sheer size (${ev.anomaly.absoluteSizeTier}); this name's baseline is still maturing.`));
  if (ev.interpretation.state === 'UNKNOWN') bits.push('We cannot tell which DIRECTION this activity bets — that is normal on delayed data, and unusual-but-unknown is still worth watching.');
  else if (ev.interpretation.state === 'MIXED') bits.push('Both bullish and bearish activity — no net read.');
  else if (ev.interpretation.state === 'POSSIBLE_SPREAD') bits.push('The pattern looks like a spread (two offsetting legs), so no direction is claimed.');
  else if (ev.interpretation.state === 'POSSIBLE_HEDGE') bits.push('The pattern looks like hedging (protection), not a directional bet.');
  else bits.push(`Weak evidence leans ${ev.side} — provisional and unverified on delayed data.`);
  if (ev.gate.tradeStatus === 'PRICE_CONFIRMED') bits.push(`${ev.side === 'bullish' ? 'Bullish' : 'Bearish'} price-confirmed setup; the options activity is supportive, but the options direction itself is unverified.`);
  else if (ev.gate.whatWouldMakeTradeable && ev.gate.whatWouldMakeTradeable.length) bits.push(`Not tradeable yet: ${ev.gate.whatWouldMakeTradeable[0]}`);
  else bits.push('Not a trade signal by itself.');
  return bits.join(' ');
}

// ── The scan (PRIVILEGED writer) ─────────────────────────────────────────────
async function runOptionsScanV2(req, res) {
  if (!optionsV2Enabled()) {
    return res.status(200).json({ ok: false, disabled: true, mode: resolveOptionsV2Mode(), note: 'OPTIONS_V2_MODE=off — v2 pipeline disabled.' });
  }
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });

  const now = new Date();
  const sc = sessionContext(now);
  if (!sc.session) return res.status(200).json({ ok: false, error: 'No completed regular session found.' });

  const force = req.query.force === '1' || req.query.refresh === '1';
  const existing = await readJSON(`${OBS_PREFIX}${sc.session}.json`, null).catch(() => null);
  // Idempotency + trading-session correctness: a weekend/holiday invocation whose
  // decision session is already captured writes NOTHING (no stale re-key).
  if (existing && sc.lateCapture && !force) {
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, skipped: true, session: sc.session, reason: 'session already captured; market closed — no new session to observe' });
  }
  // A same-session re-scan replaces the snapshot with a LATER, more complete one
  // (e.g. post-close after an intraday run) — event decision records stay immutable.

  const scanId = `scan_${sc.session}_${now.toISOString().slice(11, 19).replace(/:/g, '')}`;
  const startedAt = now.toISOString();
  const deadline = Date.now() + Math.min(SCAN_DEADLINE_MS, parseInt(req.query.budgetMs, 10) || SCAN_DEADLINE_MS);

  // 1. Universe
  const sources = await loadUniverseSources();
  const uni = buildUniverse(sources, { session: sc.session });

  // 2. Fetch + observe (bounded concurrency, hard deadline; unattempted = failed).
  // While each raw chain is in memory, index EVERY contract symbol → OI so a prior
  // session's pending events can be confirmed even when a contract isn't among the
  // bounded rows we persist.
  const observations = [];
  const contractIndex = {};
  let idx = 0;
  const worker = async () => {
    while (idx < uni.entries.length) {
      const entry = uni.entries[idx++];
      if (Date.now() > deadline) {
        observations.push(observeTicker(entry.ticker, null, { nowMs: Date.now(), session: sc.session, sessionFraction: sc.sessionFraction, failure: 'budget-exhausted', source: entry.source }));
        continue;
      }
      const { result, telemetry } = await provider.fetchTickerObservation(entry.ticker, { nowMs: Date.now() });
      if (result && Array.isArray(result.options)) {
        for (const chain of result.options) {
          if (!chain) continue;
          for (const c of [...(chain.calls || []), ...(chain.puts || [])]) {
            if (c && c.contractSymbol) contractIndex[c.contractSymbol] = { openInterest: c.openInterest || 0 };
          }
        }
      }
      observations.push(observeTicker(entry.ticker, result, {
        nowMs: Date.now(), session: sc.session, sessionFraction: sc.sessionFraction,
        sourceMode: provider.resolveSourceMode(), source: entry.source,
        expiriesRequested: telemetry.expiriesRequested, expiriesReturned: telemetry.expiriesReturned,
        latencyMs: telemetry.latencyMs, failure: telemetry.failure,
      }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(cfg.UNIVERSE.concurrency, uni.entries.length) }, worker));

  // 3. Persist the immutable observation doc (the baseline raw material).
  const tickersDoc = {};
  for (const o of observations) tickersDoc[o.ticker] = o;
  const obsDoc = { date: sc.session, session: sc.session, scanId, generatedAt: new Date().toISOString(), lateCapture: sc.lateCapture, universe: { budget: uni.budget, shardIndex: uni.shardIndex, shardCount: uni.shardCount, truncated: uni.truncated, entries: uni.entries }, tickers: tickersDoc };
  await writeJSON(`${OBS_PREFIX}${sc.session}.json`, obsDoc, 0).catch(() => {});

  // 4. Baselines from STRICTLY PRIOR sessions (point-in-time by construction).
  let history = [];
  // Bound the READ, not just the slice: this used to download every observation doc ever
  // written — each carrying per-ticker observations for the whole options universe — and
  // then keep 26. Selecting the newest by path first means the fetch cost stops growing
  // with the archive. Paths are session-dated, so path order is session order.
  try { history = await readAllByPrefix(OBS_PREFIX, OBS_RE, { limit: BASELINE_DOCS_MAX + 1 }); } catch { /* none yet */ }
  const baselines = anomaly.buildBaselines(history, { beforeSession: sc.session });

  // 5. Score, interpret, gate — per ticker.
  const okObs = observations.filter(o => o.ok);
  const candleMap = await candlesForTickers(okObs.map(o => o.ticker)).catch(() => new Map());
  const capabilities = provider.capabilities();
  const items = [];      // admitted ticker events for the lifecycle fold
  const rawRows = [];    // transparent raw-activity rows (every scanned name with volume)
  const controlRows = [];
  const nowMs = Date.now();

  for (const obs of okObs) {
    const tot = totals(obs);
    const base = baselines.tickers.get(obs.ticker) || null;
    const a = anomaly.scoreTicker(obs, base);
    const ranked = anomaly.rankContractsWithinTicker(obs.contracts);
    const isIndex = of.INDEX_ETFS.has(obs.ticker);
    const interp = interpretTicker(ranked, { nowMs, isIndex, sourceMode: capabilities.sourceMode });
    const setup = evaluateSetup(candleMap.get(obs.ticker) || []);
    if (tot.vol > 0) {
      rawRows.push({
        ticker: obs.ticker, underlying: obs.underlying, isIndex,
        callVol: tot.callVol, putVol: tot.putVol, totalVol: tot.vol,
        callNotional: tot.callNotional, putNotional: tot.putNotional, totalNotional: tot.notional,
        activityStatus: a.activityStatus, anomalyScore: a.anomalyScore, anomalyPercentile: a.anomalyPercentile,
        baselineSampleSize: a.baselineSampleSize, dataQuality: a.dataQuality,
        interpretation: interp.state, source: obs.universeSource,
      });
    }
    const unusual = a.activityStatus !== cfg.ACTIVITY_STATUS.NORMAL;
    if (unusual) {
      items.push({
        ticker: obs.ticker, side: interpretationSide(interp.state),
        anomaly: a, interpretation: interp, setup,
        // Computed over the FULL chain at observation time (options-observe-v2), before
        // the per-ticker contract cap — the retained rows cannot express this.
        fullChainConcentration: (obs.aggregates && obs.aggregates.strikeConcentration) || null,
        atmIVNow: atmIvOf(obs),
        // Prior-session ATM IV distribution (PIT — the baseline excludes this session).
        ivHistory: base && Array.isArray(base.atmIVSeries) ? base.atmIVSeries.map(v => v * 100) : null,
        underlying: obs.underlying, estNotional: tot.notional,
        contracts: ranked, sourceMode: capabilities.sourceMode, modelVersion: cfg.MODEL_VERSION,
        isIndex,
      });
    } else if (setup && setup.valid && gate.triggerReached(setup)) {
      // Control cohort: an identical price-only setup with NO unusual options —
      // the comparison arm for the incremental-value question.
      controlRows.push({ session: sc.session, ticker: obs.ticker, side: setup.direction === 'long' ? 'bullish' : 'bearish', setup: { direction: setup.direction, trigger: setup.trigger, invalidation: setup.invalidation, target: setup.target, rr: setup.rr } });
    }
  }

  // 6. Earnings context for admitted events only (bounded fetch set).
  const earningsByTicker = new Map();
  {
    const tickers = items.filter(i => !i.isIndex).map(i => i.ticker);
    let ei = 0;
    const eWorker = async () => {
      while (ei < tickers.length) {
        const t = tickers[ei++];
        try { const e = await fetchEarningsInfo(t); if (e) earningsByTicker.set(t, e); } catch { /* best-effort */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, tickers.length) }, eWorker));
  }

  // 7. Trade gate per event + the false-positive ledger, contract-level executable
  //    liquidity, and volatility context. These are ADDITIVE: a failure in any of them
  //    leaves the field null and the existing gate decision is untouched.
  //
  // Two calendar calls total (date-ranged, all symbols), regardless of universe size.
  let corpActions = null, corpActionDiagnostics = null;
  try {
    const ca = await require('./corp-actions').buildCorpActionIndex({
      tickers: items.map(i => i.ticker), now: nowMs,
    });
    corpActions = ca.index; corpActionDiagnostics = ca.diagnostics;
  } catch { /* additive — a failure leaves the hypothesis exactly as it was before */ }

  for (const item of items) {
    const e = earningsByTicker.get(item.ticker);
    item.earningsInDays = e && e.earningsInDays != null ? e.earningsInDays : null;
    item.gate = gate.decideTradeStatus(item.anomaly, item.interpretation, item.setup, { earningsInDays: item.earningsInDays });
    item.plan = gate.stockPlan(item.setup);
    try { attachEvidenceLayers(item, { nowMs, capabilities, corpActions }); } catch { /* additive only */ }
  }

  // 8. Lifecycle fold + OI attribution to ORIGINAL events (today's full chain
  //    contract index confirms any prior session's pending events).
  const prevLedger = await readJSON(EVENTS_KEY, { events: [], emittedAlertIds: [] }).catch(() => ({ events: [], emittedAlertIds: [] }));
  const attached = lifecycle.attachOiConfirmations(prevLedger.events || [], contractIndex, { session: sc.session });
  const folded = lifecycle.foldEventsV2({ events: attached.events, emittedAlertIds: prevLedger.emittedAlertIds }, items, { session: sc.session });
  const allTransitions = [...attached.transitions, ...folded.transitions];
  await writeJSON(EVENTS_KEY, { updatedAt: new Date().toISOString(), events: folded.events, emittedAlertIds: folded.emittedAlertIds }, 0).catch(() => {});

  // 9. Control ledger (bounded, dedup by session:ticker).
  try {
    const controls = await readJSON(CONTROLS_KEY, { entries: [] }).catch(() => ({ entries: [] }));
    const seen = new Set((controls.entries || []).map(c => `${c.session}:${c.ticker}`));
    for (const c of controlRows) if (!seen.has(`${c.session}:${c.ticker}`)) controls.entries.push(c);
    controls.entries = (controls.entries || []).slice(-MAX_CONTROLS);
    await writeJSON(CONTROLS_KEY, controls, 0).catch(() => {});
  } catch { /* controls best-effort */ }

  // 10. Health + radar.
  const scanHealth = health.buildScanHealth(observations, {
    session: sc.session, scanId, startedAt, finishedAt: new Date().toISOString(),
    sourceMode: capabilities.sourceMode, capabilities,
    universe: { budget: uni.budget, shardIndex: uni.shardIndex, shardCount: uni.shardCount, truncated: uni.truncated },
  });
  const prevHealth = await readJSON(HEALTH_KEY, null).catch(() => null);
  const healthDoc = health.foldHealth(prevHealth, scanHealth);
  await writeJSON(HEALTH_KEY, healthDoc, 0).catch(() => {});

  const radar = buildRadar({ session: sc.session, scanId, items, rawRows, events: folded.events, alerts: folded.alerts, transitions: allTransitions, scanHealth, capabilities, baselines, universe: uni, corpActionDiagnostics });
  await writeJSON(RADAR_KEY, radar, 0).catch(() => {});

  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, session: sc.session, scanId, scanned: okObs.length, failed: observations.length - okObs.length, events: items.length, alerts: folded.alerts.length, transitions: allTransitions.length, coveragePct: scanHealth.coveragePct });
}

// ── Radar assembly (what the public read serves) ─────────────────────────────
// Attach the false-positive hypothesis ledger, evidence strength, contract-level
// executable liquidity, volatility context, and the Greeks capability disclosure.
//
// Two deliberate refusals live here:
//   • `strikeConcentration` is passed `chainComplete:false` because `item.contracts` is
//     the RETAINED (ranked, display-capped) set, not the full chain. It therefore reports
//     UNAVAILABLE with that reason rather than returning a number that is really a
//     function of the display cut. Wiring the full chain through the observation layer is
//     tracked as follow-up work.
//   • Contract liquidity is evaluated for the SELECTED contract only, and only against a
//     requested size when one is supplied. With no size it reports the capacity check
//     unevaluated instead of passing it.
// Current ATM IV for the swing bucket — the same series the baseline accumulates, so
// "today" and "history" are measured the same way and the rank is apples-to-apples.
function atmIvOf(obs) {
  const b = obs && obs.aggregates && obs.aggregates.byBucket;
  if (!b) return null;
  const swing = b['21-45'] || b['8-20'] || null;
  return swing && swing.atmIV != null ? swing.atmIV * 100 : null;   // module works in IV points
}

function attachEvidenceLayers(item, { nowMs, capabilities, corpActions = null }) {
  const hyp = require('./options-hypotheses-v2');
  const oex = require('./options-execution-v2');

  const rows = item.contracts || [];
  item.falsePositiveHypotheses = hyp.buildHypotheses({
    contracts: rows.map(c => ({ ...c, underlying: c.underlying ?? item.underlying })),
    capabilities: {
      hasOpenClose: !!capabilities.hasOpenClose,
      hasAggressor: !!capabilities.hasAggressorSide,
      hasLinkedLegs: !!capabilities.hasLinkedLegs,
    },
    earnings: item.earningsInDays != null ? { daysUntil: item.earningsInDays } : null,
    // Ex-dividend / split calendar. A clean "no action" REFUTES the hypothesis; a failed
    // or plan-gated calendar leaves it open. corpActions is null ⇒ unchanged prior wording.
    corpAction: corpActions ? corpActions.get(item.ticker) || null : null,
    isIndex: !!item.isIndex,
    nowMs,
  });

  item.evidenceStrength = hyp.evidenceStrength({
    hypotheses: item.falsePositiveHypotheses,
    componentCoverage: item.anomaly && item.anomaly.componentCoverage != null ? item.anomaly.componentCoverage : null,
    directionState: item.interpretation ? item.interpretation.state : null,
    independentPriceConfirmation: !!(item.gate && item.gate.tradeStatus === 'PRICE_CONFIRMED'),
    sourceMode: item.sourceMode,
  });

  // The contract a plan would actually name: the top-ranked retained row.
  const selected = rows[0] || null;
  item.contractLiquidity = selected
    ? oex.contractLiquidity({ contract: { ...selected, underlying: selected.underlying ?? item.underlying }, contracts: null, nowMs })
    : { state: 'UNKNOWN', unavailableReason: 'no contract retained for this event — no contract-level liquidity check is possible', coverage: 0, executableFraction: 0 };

  item.strikeConcentrationFullChain = oex.strikeConcentration({
    fullChainSummary: item.fullChainConcentration,   // preferred: exact, full-chain
    chainRows: rows, chainComplete: false,           // fallback still refuses, by design
  });

  // Prefer the bucket-level ATM IV (matches the baseline series) over a single contract's.
  const atmIV = item.atmIVNow != null ? item.atmIVNow : (selected && selected.iv != null ? selected.iv * 100 : null);
  item.volatilityContext = oex.volatilityContext({
    // Point-in-time prior-session series from the baseline; `ivRank` still refuses below
    // its 60-session floor, so this lights up only once real history has accrued.
    currentIV: atmIV, ivHistory: item.ivHistory || null,
    atmIV, days: selected ? selected.dte : null, spot: item.underlying,
    chainRows: rows, chainComplete: false,
    dte: selected ? selected.dte : null,
    eventInDays: item.earningsInDays,
    current: null, prior: null,                     // no prior-session surface snapshot is persisted yet
  });

  item.greeksCapability = oex.greeksCapability({ capabilities, chainRows: rows });
}

function buildRadar({ session, scanId, items, rawRows, events, alerts, transitions, scanHealth, capabilities, baselines, universe, corpActionDiagnostics = null }) {
  const byKey = new Map(items.map(i => [`${i.ticker}:${i.side}`, i]));
  const openEvents = (events || []).filter(e => e.status === 'open' || e.closedSession === session);

  const cards = openEvents.map(ev => {
    const item = byKey.get(ev.key);
    const cur = ev.current || {};
    const prevRow = (ev.history || []).length > 1 ? ev.history[ev.history.length - 2] : null;
    const card = {
      eventId: ev.id, ticker: ev.ticker, side: ev.side, status: ev.status,
      firstSeenSession: ev.firstSeen.session, lastSeenSession: ev.lastSeenSession,
      appearances: ev.appearances,
      seenThisSession: ev.lastSeenSession === session,
      anomaly: item ? item.anomaly : {
        anomalyScore: cur.anomalyScore, anomalyPercentile: cur.anomalyPercentile,
        activityStatus: cur.activityStatus, activityLabel: cfg.ACTIVITY_LABEL[cur.activityStatus] || null,
        dataQuality: cur.dataQuality, liquidityQuality: cur.liquidityQuality,
        baselineSampleSize: ev.firstSeen.baselineSampleSize, baselineScored: ev.firstSeen.baselineSampleSize >= cfg.ANOMALY_CONFIG.minBaselineSessions,
        absoluteSizeTier: ev.firstSeen.absoluteSizeTier, reasons: [], warnings: ['carried from a prior session — not re-observed in this scan'],
      },
      interpretation: item ? item.interpretation : { state: cur.interpretation || 'UNKNOWN', label: cfg.INTERPRETATION_LABEL[cur.interpretation] || 'Direction unknown', confidence: cur.interpretationConfidence || 0, evidenceFor: [], evidenceAgainst: [] },
      gate: item ? item.gate : { tradeStatus: cur.tradeStatus || 'STALE', tradeLabel: cfg.TRADE_LABEL[cur.tradeStatus] || 'Stale', gateVersion: ev.firstSeen.gateVersion, reasons: [], whatWouldMakeTradeable: [], actionable: cur.tradeStatus === 'PRICE_CONFIRMED' },
      setup: item && item.setup && item.setup.valid ? item.setup : (ev.firstSeen.setup || null),
      plan: item ? item.plan : null,
      contracts: item ? item.contracts : (ev.firstSeen.contracts || []),
      estNotional: item ? item.estNotional : ev.firstSeen.estNotional,
      estNotionalMethod: 'volume × last/mid price × 100 — an ESTIMATE from delayed chains, not verified traded premium',
      underlying: item ? item.underlying : cur.underlying,
      earningsInDays: item ? item.earningsInDays : null,
      oiConfirmation: ev.oiConfirmation,
      changeSincePrev: prevRow ? {
        prevSession: prevRow.session,
        anomalyScore: prevRow.anomalyScore != null && cur.anomalyScore != null ? +(cur.anomalyScore - prevRow.anomalyScore).toFixed(0) : null,
        activityStatus: prevRow.activityStatus !== cur.activityStatus ? `${prevRow.activityStatus} → ${cur.activityStatus}` : null,
        tradeStatus: prevRow.tradeStatus !== cur.tradeStatus ? `${prevRow.tradeStatus || 'n/a'} → ${cur.tradeStatus}` : null,
      } : null,
      transitions: (ev.transitions || []).slice(-6),
      modelVersion: ev.modelVersion,
      gateVersion: ev.firstSeen.gateVersion,
      // ── Evidence layers (null on carried-forward events that were not re-observed) ──
      falsePositiveHypotheses: item ? item.falsePositiveHypotheses : null,
      evidenceStrength: item ? item.evidenceStrength : null,
      contractLiquidity: item ? item.contractLiquidity : null,
      strikeConcentrationFullChain: item ? item.strikeConcentrationFullChain : null,
      volatilityContext: item ? item.volatilityContext : null,
      greeksCapability: item ? item.greeksCapability : null,
      evidenceLayersNote: item ? null : 'Carried forward from a prior session and NOT re-observed in this scan — its false-positive ledger, contract liquidity, and volatility context are stale and therefore withheld rather than shown as current.',
    };
    card.novice = noviceSummary(card);
    return card;
  });

  // Rank: activity level, then anomaly score, then notional. Fairness is upstream
  // (per-ticker contract caps + one event per ticker), so this cap is per EVENT.
  const rank = { EXCEPTIONAL: 4, HIGHLY_UNUSUAL: 3, UNUSUAL: 2, UNUSUAL_LOW_QUALITY: 1, NORMAL: 0 };
  cards.sort((a, b) => (rank[b.anomaly.activityStatus] || 0) - (rank[a.anomaly.activityStatus] || 0)
    || (b.anomaly.anomalyScore || 0) - (a.anomaly.anomalyScore || 0)
    || (b.estNotional || 0) - (a.estNotional || 0));
  const capped = cards.slice(0, cfg.RANKING.maxEvents);

  const views = {
    discovery: capped.filter(c => c.seenThisSession || c.status === 'open').map(c => c.eventId),
    watch: capped.filter(c => ['WATCH_FOR_PRICE_TRIGGER', 'READY'].includes(c.gate.tradeStatus)).map(c => c.eventId),
    confirmed: capped.filter(c => c.gate.tradeStatus === 'PRICE_CONFIRMED').map(c => c.eventId),
    risks: capped.filter(c => ['CONTRADICTS_SETUP', 'AVOID_EVENT_RISK', 'POSSIBLE_HEDGE', 'POSSIBLE_SPREAD', 'INVALIDATED'].includes(c.gate.tradeStatus)).map(c => c.eventId),
  };

  return {
    ok: true,
    featureName: FEATURE_NAME,
    session, scanId, generatedAt: new Date().toISOString(),
    modelVersion: cfg.MODEL_VERSION, gateVersion: cfg.GATE_VERSION,
    capabilities,
    dataDelayed: capabilities.dataDelayed,
    // Which corporate-action calendars answered this scan. A plan-gated or failed
    // calendar is why some events' corpAction hypothesis stays UNRESOLVED.
    corpActions: corpActionDiagnostics,
    baselineDays: baselines ? baselines.days : 0,
    universe: { budget: universe.budget, scanned: scanHealth.tickersSucceeded, shardIndex: universe.shardIndex, shardCount: universe.shardCount, truncated: universe.truncated },
    events: capped,
    views,
    rawActivity: rawRows.sort((a, b) => (b.totalNotional || 0) - (a.totalNotional || 0)).slice(0, RAW_ROWS_MAX),
    alerts,
    transitions: transitions.slice(-50),
    health: scanHealth,
    weightsDisclosure: { config: cfg.ANOMALY_CONFIG.id, hypothesis: true, weights: cfg.ANOMALY_CONFIG.weights, note: 'Anomaly weights are initial hypotheses under prospective challenger evaluation — not validated predictors.' },
    note: 'Unusualness ≠ direction ≠ trade signal. Scores describe how ABNORMAL activity is vs this name\'s own history on DELAYED chain data; direction is provisional at best; only an independent price-confirmed stock setup earns an actionable label. This layer cannot originate or boost a live pick (registry maturity: shadow).',
  };
}

// ── Public reads ─────────────────────────────────────────────────────────────
async function runOptionsRadar(req, res) {
  if (!optionsV2Enabled()) {
    res.setHeader('Cache-Control', 's-maxage=300');
    return res.json({ ok: false, disabled: true, note: 'Options v2 is disabled (OPTIONS_V2_MODE=off). The legacy Options tab remains available.' });
  }
  const doc = await readJSON(RADAR_KEY, null).catch(() => null);
  if (!doc) {
    // NEVER CDN-cache the empty state: right after the first scan writes the doc,
    // a cached empty here would mask fresh data from every viewer for its TTL.
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: false, empty: true, featureName: FEATURE_NAME, note: 'No v2 radar yet — the first scheduled scan has not run. Nothing is hidden; there is simply no data yet.' });
  }
  res.setHeader('Cache-Control', 's-maxage=300');
  return res.json(doc);
}

async function runOptionsHealthV2(req, res) {
  const doc = await readJSON(HEALTH_KEY, null).catch(() => null);
  res.setHeader('Cache-Control', 's-maxage=300');
  return res.json(doc || { ok: false, empty: true, note: 'No scan health yet — the v2 scan has not run.' });
}

async function runOptionsEvidenceV2(req, res) {
  const doc = await readJSON(EVIDENCE_KEY, null).catch(() => null);
  res.setHeader('Cache-Control', 's-maxage=600');
  return res.json(doc || { ok: false, empty: true, note: 'No evidence report yet — events must mature (weeks) before op=optionsresolve2 can grade anything. This is honest patience, not a failure.' });
}

// ── Resolution / evaluation (PRIVILEGED writer) ──────────────────────────────
const MATURITY_BUFFER_DAYS = 32;   // ≥ 21 sessions of forward data (calendar buffer)
const GRADE_CAP = 80;

async function runOptionsResolveV2(req, res) {
  if (!optionsV2Enabled()) return res.status(200).json({ ok: false, disabled: true });
  if (!hasStore()) return res.status(200).json({ ok: false, error: 'Blob storage not configured.' });

  const today = sessionContext(new Date()).session || new Date().toISOString().slice(0, 10);
  const ledger = await readJSON(EVENTS_KEY, { events: [] }).catch(() => ({ events: [] }));
  const controls = await readJSON(CONTROLS_KEY, { entries: [] }).catch(() => ({ entries: [] }));

  const matured = (ledger.events || []).filter(e =>
    e.firstSeen && lifecycle.sessionsBetween(e.firstSeen.session, today) >= MATURITY_BUFFER_DAYS);
  const directional = matured.filter(e => e.side === 'bullish' || e.side === 'bearish').slice(-GRADE_CAP);
  const maturedControls = (controls.entries || []).filter(c => lifecycle.sessionsBetween(c.session, today) >= MATURITY_BUFFER_DAYS).slice(-GRADE_CAP);

  // Candles for events + controls + benchmarks (SPY + involved sector ETFs).
  const tickers = [...new Set([...directional.map(e => e.ticker), ...maturedControls.map(c => c.ticker)])];
  const sectorEtfs = [...new Set(tickers.map(t => evalv2.SECTOR_ETF[SECTOR_OF[t]]).filter(Boolean))];
  const hist = new Map(), etfHist = new Map();
  let i = 0;
  const worker = async (list, map) => {
    while (i < list.length) {
      const t = list[i++];
      try { const d = await fetchDailyHistory(t); if (d) map.set(t, d.candles); } catch { /* skip */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, tickers.length || 1) }, () => worker(tickers, hist)));
  i = 0;
  await Promise.all(Array.from({ length: Math.min(4, sectorEtfs.length || 1) }, () => worker(sectorEtfs, etfHist)));
  const spyRes = await fetchDailyHistory('SPY', '1y').catch(() => null);
  const spy = spyRes && spyRes.candles ? spyRes.candles : null;
  const sectorByTicker = new Map(tickers.map(t => [t, etfHist.get(evalv2.SECTOR_ETF[SECTOR_OF[t]]) || null]));

  const gradedDirectional = evalv2.gradeEvents(directional, { candlesByTicker: hist, spy, sectorByTicker });
  // Controls grade through the same engine as pseudo-events.
  const controlEvents = maturedControls.map((c, n) => ({
    id: `ctl_${c.session}_${c.ticker}_${n}`, ticker: c.ticker, side: c.side,
    firstSeen: { session: c.session, anomalyScore: null, setup: c.setup, interpretation: null, tradeStatus: 'CONTROL' },
  }));
  const gradedControls = evalv2.gradeEvents(controlEvents, { candlesByTicker: hist, spy, sectorByTicker });

  const report = {
    ...evalv2.evidenceReport({ events: ledger.events || [], gradedDirectional, gradedControls }),
    asOf: today, generatedAt: new Date().toISOString(),
    maturedEvents: matured.length, gradedDirectional: gradedDirectional.length, gradedControls: gradedControls.length,
    registryMaturity: 'shadow',
  };
  await writeJSON(EVIDENCE_KEY, report, 0).catch(() => {});
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, asOf: today, maturedEvents: matured.length, gradedDirectional: gradedDirectional.length, gradedControls: gradedControls.length });
}

module.exports = {
  runOptionsScanV2, runOptionsRadar, runOptionsResolveV2, runOptionsEvidenceV2, runOptionsHealthV2,
  sessionContext, buildRadar, noviceSummary, loadUniverseSources,
  OBS_PREFIX, OBS_RE, EVENTS_KEY, CONTROLS_KEY, RADAR_KEY, HEALTH_KEY, EVIDENCE_KEY, FEATURE_NAME,
};

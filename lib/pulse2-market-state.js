'use strict';
// 📡 MARKET PULSE v2 — DETERMINISTIC LIVE MARKET STATE.
//
// The measured layer v1 never had. No LLM anywhere in this module: every field is a
// deterministic calculation over real bars/quotes, or an honest UNAVAILABLE with a
// reason. The market MODE derives from EXPLICIT inputs that ride along in the payload
// so an expert can audit exactly why the mode is what it is.
//
// Pure: assembly happens over PRE-FETCHED inputs (intraday results, daily candles,
// persisted sector/breadth/macro reads). All fetching lives in pulse2-routes.
// Reuses lib/intraday-features (VWAP, opening range, SAME-TIME-OF-DAY relative
// volume) — no duplicate implementations.

const { buildIntradayFeatures } = require('./intraday-features');

const INDEX_TICKERS = Object.freeze(['SPY', 'QQQ', 'IWM', 'DIA', 'RSP']);
const SECTOR_ETFS = Object.freeze({
  XLK: 'Technology', XLC: 'Communication Services', XLY: 'Consumer Discretionary',
  XLP: 'Consumer Staples', XLV: 'Health Care', XLF: 'Financials', XLI: 'Industrials',
  XLE: 'Energy', XLU: 'Utilities', XLRE: 'Real Estate', XLB: 'Materials',
});
const VIX_TICKER = '^VIX';

const MARKET_MODES = Object.freeze([
  'RISK_ON_TREND', 'RISK_OFF_TREND', 'ROTATION', 'TWO_WAY_CHOP', 'EVENT_SHOCK',
  'NARROW_LEADERSHIP', 'BROAD_PARTICIPATION', 'INSUFFICIENT_DATA',
]);

// Mode thresholds — explicit, versioned hypotheses (audit trail rides in `inputs`).
const MODE_T = Object.freeze({
  SHOCK_ABS_RET: 2.0,        // |SPY day %| — event shock
  SHOCK_VIX_JUMP: 15,        // VIX day % jump alongside a ≥1% index move
  TREND_MIN_RET: 0.6,        // day % that counts as a trend day
  CHOP_MAX_RET: 0.4,
  ROTATION_MIN_SPREAD: 1.5,  // top–bottom sector day-% spread
  NARROW_RSP_LAG: 0.5,       // SPY − RSP day-% gap = cap-weighted carrying the tape
  BROAD_BREADTH_PCT: 55,     // % above 50DMA for broad participation
});

const round = (n, d = 2) => (n == null || !Number.isFinite(n) ? null : +n.toFixed(d));

/** UNAVAILABLE placeholder with a required reason — never a silent neutral. Pure. */
const unavailable = reason => ({ available: false, reason: String(reason || 'no data') });

/**
 * One instrument's state from its intraday result + (fallback) daily candles. Pure.
 * `intradayResult` is a lib/intraday-data fetchIntradayBars() result or null.
 */
function instrumentState({ ticker, intradayResult, dailyCandles = null, spyBars = null, now = new Date() } = {}) {
  const base = { ticker: String(ticker || '').toUpperCase() };
  if (intradayResult && intradayResult.ok && (intradayResult.bars || []).length) {
    const f = buildIntradayFeatures({
      todayBars: intradayResult.bars,
      priorSessions: intradayResult.priorSessions || [],
      spyTodayBars: spyBars || [],
      now,
      prevClose: intradayResult.prevClose,
    });
    if (f.hasIntraday) {
      return {
        ...base, available: true, source: 'intraday',
        dayReturnPct: round(f.dayChangePct), gapPct: round(f.gapPct),
        vsVWAPPct: round(f.vwapDist != null ? f.vwapDist * 100 : null),
        aboveVWAP: f.aboveVwap ?? null,
        openingRange: f.openingRange ? {
          high: round(f.openingRange.high), low: round(f.openingRange.low),
          complete: !!f.orComplete,
          brokeAbove: f.last != null && f.orComplete ? f.last.c > f.openingRange.high : null,
          brokeBelow: f.last != null && f.orComplete ? f.last.c < f.openingRange.low : null,
        } : null,
        trend30mPct: round(f.mom30 != null ? f.mom30 * 100 : null),
        sameTimeRelVol: f.timeOfDayRelVol,
        distFromHighPct: round(f.distFromHod != null ? f.distFromHod * 100 : null),
        rangeExpansion: round(f.rangeExpansion),
        residual15Pct: round(f.residual15 != null ? f.residual15 * 100 : null),
        asOf: f.completedBarEndAt || f.asOf || null,
        dataQuality: f.dataQuality || null,
      };
    }
  }
  // Daily fallback — honest DAILY_ONLY, never dressed as live.
  const cs = Array.isArray(dailyCandles) ? dailyCandles.filter(c => c && c.close != null) : [];
  if (cs.length >= 2) {
    const last = cs[cs.length - 1], prev = cs[cs.length - 2];
    return {
      ...base, available: true, source: 'daily',
      dayReturnPct: round(((last.close - prev.close) / prev.close) * 100),
      gapPct: last.open != null ? round(((last.open - prev.close) / prev.close) * 100) : null,
      vsVWAPPct: null, aboveVWAP: null, openingRange: null, trend30mPct: null,
      sameTimeRelVol: null, distFromHighPct: null, rangeExpansion: null, residual15Pct: null,
      asOf: last.date || null, dataQuality: { note: 'daily bars only' },
    };
  }
  return { ...base, ...unavailable('no intraday or daily bars for ' + base.ticker) };
}

/** Sector states: each SPDR ETF's day return + residual vs SPY, ranked. Pure. */
function sectorStatesOf(indexStates, sectorStates) {
  const spy = indexStates.SPY && indexStates.SPY.available ? indexStates.SPY.dayReturnPct : null;
  const rows = [];
  for (const [etf, name] of Object.entries(SECTOR_ETFS)) {
    const s = sectorStates[etf];
    if (!s || !s.available || s.dayReturnPct == null) continue;
    rows.push({
      etf, sector: name,
      dayReturnPct: s.dayReturnPct,
      vsSpyPct: spy != null ? round(s.dayReturnPct - spy) : null,
      aboveVWAP: s.aboveVWAP,
      sameTimeRelVol: s.sameTimeRelVol,
    });
  }
  rows.sort((a, b) => b.dayReturnPct - a.dayReturnPct);
  const n = rows.length;
  return {
    available: n > 0,
    ...(n === 0 ? { reason: 'no sector ETF data' } : {}),
    rows,
    leading: rows.slice(0, 3).map(r => r.sector),
    lagging: rows.slice(-3).map(r => r.sector).reverse(),
    upCount: rows.filter(r => r.dayReturnPct > 0).length,
    downCount: rows.filter(r => r.dayReturnPct < 0).length,
    spreadPct: n >= 2 ? round(rows[0].dayReturnPct - rows[n - 1].dayReturnPct) : null,
  };
}

/**
 * Deterministic MARKET MODE from explicit inputs. Pure — returns { mode, inputs, why }.
 * Precedence: data sufficiency → shock → directional trend (broad/narrow refinement)
 * → rotation → chop.
 */
function deriveMarketMode({
  spyRet = null, qqqRet = null, iwmRet = null, rspRet = null,
  spyAboveVwap = null, qqqAboveVwap = null,
  vixLevel = null, vixChangePct = null,
  sectorSpreadPct = null, sectorUpCount = null, sectorCount = null,
  breadthPctAbove50 = null,
} = {}) {
  const inputs = {
    spyRet, qqqRet, iwmRet, rspRet, spyAboveVwap, qqqAboveVwap,
    vixLevel, vixChangePct, sectorSpreadPct, sectorUpCount, sectorCount, breadthPctAbove50,
  };
  const out = (mode, why) => ({ mode, inputs, why });

  if (spyRet == null || qqqRet == null) return out('INSUFFICIENT_DATA', 'missing SPY/QQQ day return');

  if (Math.abs(spyRet) >= MODE_T.SHOCK_ABS_RET
      || (vixChangePct != null && vixChangePct >= MODE_T.SHOCK_VIX_JUMP && Math.abs(spyRet) >= 1)) {
    return out('EVENT_SHOCK', `|SPY| ${Math.abs(spyRet).toFixed(1)}%${vixChangePct != null ? `, VIX ${vixChangePct >= 0 ? '+' : ''}${vixChangePct.toFixed(0)}%` : ''}`);
  }

  const upTrend = spyRet >= MODE_T.TREND_MIN_RET && qqqRet >= MODE_T.TREND_MIN_RET
    && spyAboveVwap !== false && qqqAboveVwap !== false;
  const downTrend = spyRet <= -MODE_T.TREND_MIN_RET && qqqRet <= -MODE_T.TREND_MIN_RET
    && spyAboveVwap !== true && qqqAboveVwap !== true;

  if (upTrend) {
    const rspLags = rspRet != null && (spyRet - rspRet) >= MODE_T.NARROW_RSP_LAG;
    const iwmLags = iwmRet != null && iwmRet <= 0;
    const weakBreadth = breadthPctAbove50 != null && breadthPctAbove50 < 45;
    if (rspLags || (iwmLags && weakBreadth)) return out('NARROW_LEADERSHIP', 'indexes up but equal-weight/small-caps not participating');
    const broad = (rspRet != null && rspRet >= spyRet - 0.1) && (iwmRet == null || iwmRet > 0)
      && (breadthPctAbove50 == null || breadthPctAbove50 >= MODE_T.BROAD_BREADTH_PCT);
    if (broad) return out('BROAD_PARTICIPATION', 'up-trend with equal-weight and small-caps participating');
    return out('RISK_ON_TREND', 'SPY and QQQ trending up above VWAP');
  }
  if (downTrend) return out('RISK_OFF_TREND', 'SPY and QQQ trending down below VWAP');

  if (Math.abs(spyRet) < MODE_T.TREND_MIN_RET && sectorSpreadPct != null && sectorSpreadPct >= MODE_T.ROTATION_MIN_SPREAD) {
    return out('ROTATION', `index flat but sector spread ${sectorSpreadPct.toFixed(1)}% — money moving between groups`);
  }
  return out('TWO_WAY_CHOP', 'no directional trend and no strong sector divergence');
}

/**
 * Assemble the full deterministic market-state snapshot from pre-fetched inputs. Pure.
 *
 * @param {object} p
 * @param {object} p.intradayByTicker  { [T]: fetchIntradayBars result } (may be empty)
 * @param {object} p.dailyByTicker     { [T]: candles[] } fallback daily bars
 * @param {object|null} p.vixState     instrumentState-shaped VIX read (or null)
 * @param {object|null} p.macro        lib/macro fetchMacro() result (or a persisted copy)
 * @param {string|null} p.macroAsOf
 * @param {object|null} p.sectorLeadership  persisted RLT sectorLeadership summary
 * @param {object|null} p.breadth      persisted breadth read { pctAbove50dma, pctAbove200dma,
 *                                     advancing, declining, newHighs63, newLows63, asOf, sample }
 * @param {object} p.sessionInfo       sessionInfoAt(now)
 * @param {object|null} p.prevState    the previous snapshot (for change-since detection)
 * @param {Date} p.now
 */
function buildMarketState({
  intradayByTicker = {}, dailyByTicker = {}, vixState = null,
  macro = null, macroAsOf = null, sectorLeadership = null, breadth = null,
  sessionInfo, prevState = null, now = new Date(),
} = {}) {
  const spyBars = intradayByTicker.SPY && intradayByTicker.SPY.ok ? intradayByTicker.SPY.bars : [];

  const indexes = {};
  for (const t of INDEX_TICKERS) {
    indexes[t] = instrumentState({
      ticker: t, intradayResult: intradayByTicker[t] || null,
      dailyCandles: dailyByTicker[t] || null,
      spyBars: t === 'SPY' ? [] : spyBars, now,
    });
  }
  const sectorInstr = {};
  for (const etf of Object.keys(SECTOR_ETFS)) {
    sectorInstr[etf] = instrumentState({
      ticker: etf, intradayResult: intradayByTicker[etf] || null,
      dailyCandles: dailyByTicker[etf] || null, spyBars, now,
    });
  }
  const sectors = sectorStatesOf(indexes, sectorInstr);

  const spy = indexes.SPY, qqq = indexes.QQQ, iwm = indexes.IWM, rsp = indexes.RSP;
  const modeResult = deriveMarketMode({
    spyRet: spy.available ? spy.dayReturnPct : null,
    qqqRet: qqq.available ? qqq.dayReturnPct : null,
    iwmRet: iwm.available ? iwm.dayReturnPct : null,
    rspRet: rsp.available ? rsp.dayReturnPct : null,
    spyAboveVwap: spy.available ? spy.aboveVWAP : null,
    qqqAboveVwap: qqq.available ? qqq.aboveVWAP : null,
    vixLevel: vixState && vixState.available ? vixState.level : null,
    vixChangePct: vixState && vixState.available ? vixState.dayReturnPct : null,
    sectorSpreadPct: sectors.available ? sectors.spreadPct : null,
    sectorUpCount: sectors.available ? sectors.upCount : null,
    sectorCount: sectors.available ? sectors.rows.length : null,
    breadthPctAbove50: breadth && breadth.pctAbove50dma != null ? breadth.pctAbove50dma : null,
  });

  // Equal-weight vs cap-weight, large vs small — measured spreads.
  const participation = {
    equalVsCapPct: (rsp.available && spy.available && rsp.dayReturnPct != null && spy.dayReturnPct != null)
      ? round(rsp.dayReturnPct - spy.dayReturnPct) : null,
    smallVsLargePct: (iwm.available && spy.available && iwm.dayReturnPct != null && spy.dayReturnPct != null)
      ? round(iwm.dayReturnPct - spy.dayReturnPct) : null,
  };

  // Regime change vs the prior snapshot — a measured transition, not an opinion.
  const prevMode = prevState && prevState.mode ? prevState.mode.mode : null;
  const modeChanged = !!(prevMode && prevMode !== modeResult.mode);

  // Coverage/quality — a provider failure is VISIBLE, never a neutral market.
  const failedSymbols = [...INDEX_TICKERS, ...Object.keys(SECTOR_ETFS)]
    .filter(t => !(indexes[t] || sectorInstr[t] || {}).available);
  const intradayCount = [...INDEX_TICKERS, ...Object.keys(SECTOR_ETFS)]
    .filter(t => ((indexes[t] || sectorInstr[t] || {}).source === 'intraday')).length;

  const newest = [
    ...Object.values(indexes), ...Object.values(sectorInstr),
  ].filter(s => s.available && s.asOf).map(s => s.asOf).sort().pop() || null;

  return {
    schema: 'pulse2-market-state-v1',
    sessionState: sessionInfo ? sessionInfo.marketSession : null,
    etDate: sessionInfo ? sessionInfo.etDate : null,
    mode: { ...modeResult, changed: modeChanged, previous: prevMode },
    indexes,
    vix: vixState || unavailable('no VIX read'),
    sectors,
    participation,
    breadth: breadth && breadth.pctAbove50dma != null
      ? { available: true, ...breadth }
      : unavailable('no persisted breadth read (RLT/tech-command source absent)'),
    sectorLeadership: sectorLeadership
      ? { available: true, ...sectorLeadership }
      : unavailable('no persisted sector-leadership read'),
    macro: macro
      ? { available: true, asOf: macroAsOf || macro.asOf || null, regime: macro.regime, macroRisk: macro.macroRisk, vix: macro.vix, credit: macro.credit }
      : unavailable('macro read failed or absent'),
    coverage: {
      symbolsRequested: INDEX_TICKERS.length + Object.keys(SECTOR_ETFS).length,
      intradayCount,
      failedSymbols,
      degraded: failedSymbols.length > 0 || intradayCount === 0,
    },
    marketDataAsOf: newest,
  };
}

// ── The Market Playbook (replaces "tape in 20 seconds") ─────────────────────
// Every line carries a basis tag: MEASURED | VERIFIED_FACT | MODEL_INFERENCE |
// EDITORIAL_SUMMARY. Deterministic templating over measured state — never LLM prose.
const BASIS = Object.freeze(['MEASURED', 'VERIFIED_FACT', 'MODEL_INFERENCE', 'EDITORIAL_SUMMARY']);

function line(text, basis) { return { text, basis }; }
const fmtPct = v => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);

/**
 * Build the playbook from a market-state snapshot + event intelligence. Pure.
 * @param {object} state    buildMarketState() output
 * @param {object} p        { freshVerified:[], triggers:[], eventRisk:[], favor:[], avoid:[] }
 */
function buildPlaybook(state, { freshVerified = [], triggers = [], eventRisk = [] } = {}) {
  const s = state || {};
  const idx = s.indexes || {};
  const spy = idx.SPY || {}, qqq = idx.QQQ || {}, iwm = idx.IWM || {};
  const mode = s.mode || {};
  const sectors = s.sectors || {};

  const marketMode = line(
    mode.mode ? `${mode.mode.replace(/_/g, ' ')}${mode.why ? ' — ' + mode.why : ''}` : 'Unavailable',
    'MEASURED');

  const changed = [];
  if (mode.changed) changed.push(`Market mode shifted ${mode.previous ? mode.previous.replace(/_/g, ' ') + ' → ' : ''}${(mode.mode || '').replace(/_/g, ' ')}.`);
  if (spy.available) changed.push(`SPY ${fmtPct(spy.dayReturnPct)}${spy.gapPct != null ? ` (gap ${fmtPct(spy.gapPct)})` : ''}${spy.aboveVWAP != null ? spy.aboveVWAP ? ', above VWAP' : ', below VWAP' : ''}.`);
  if (iwm.available && spy.available && iwm.dayReturnPct != null && spy.dayReturnPct != null && iwm.dayReturnPct < spy.dayReturnPct - 0.3) {
    changed.push('Small caps (IWM) lagging the large-cap tape.');
  }
  const whatChanged = changed.length ? changed.map(t => line(t, 'MEASURED')) : [line('No material change measured since the open.', 'MEASURED')];

  const leadership = sectors.available && sectors.leading.length
    ? line(`Leading: ${sectors.leading.join(', ')} (${sectors.upCount}/${sectors.rows.length} sectors up).`, 'MEASURED')
    : line('Sector leadership unavailable.', 'MEASURED');
  const deterioration = sectors.available && sectors.lagging.length
    ? line(`Lagging: ${sectors.lagging.join(', ')}${s.participation && s.participation.equalVsCapPct != null && s.participation.equalVsCapPct < -0.3 ? '; equal-weight trailing cap-weight (narrow tape)' : ''}.`, 'MEASURED')
    : line('No deterioration read available.', 'MEASURED');

  // FAVOR / AVOID are model inferences from measured leadership — labeled as such.
  const favor = sectors.available && sectors.rows.length && sectors.rows[0].vsSpyPct != null && sectors.rows[0].vsSpyPct > 0.3
    ? line(`${sectors.rows[0].sector}: sector relative strength positive vs SPY today.`, 'MODEL_INFERENCE')
    : line('No sector shows favorable measured relative strength right now.', 'MODEL_INFERENCE');
  const worst = sectors.available && sectors.rows.length ? sectors.rows[sectors.rows.length - 1] : null;
  const avoid = worst && worst.vsSpyPct != null && worst.vsSpyPct < -0.3
    ? line(`Late entries in ${worst.sector}: weakest sector on the day (${fmtPct(worst.vsSpyPct)} vs SPY).`, 'MODEL_INFERENCE')
    : line('No sector is measurably deteriorating enough to flag.', 'MODEL_INFERENCE');

  // Next decision point — only levels derived from current data.
  let next = null;
  for (const t of ['QQQ', 'SPY']) {
    const st = idx[t];
    if (st && st.available && st.openingRange && st.openingRange.complete
        && st.openingRange.brokeAbove === false && st.openingRange.brokeBelow === false) {
      next = line(`${t} opening-range ${st.openingRange.high} / ${st.openingRange.low} — first break sets the tone.`, 'MEASURED');
      break;
    }
  }
  if (!next && eventRisk.length) next = line(`Next scheduled risk: ${eventRisk[0]}`, 'VERIFIED_FACT');
  if (!next) next = line(s.sessionState === 'regular' ? 'No unbroken opening range; watch the close.' : 'Market closed — next decision point is the next open.', 'MEASURED');

  return {
    marketMode,
    whatChanged,
    leadership,
    deterioration,
    favor,
    avoid,
    nextDecisionPoint: next,
    freshOpportunities: freshVerified.slice(0, 3).map(h => line(h, 'VERIFIED_FACT')),
    activeTriggers: triggers.slice(0, 3).map(h => line(h, 'MEASURED')),
    upcomingEventRisk: eventRisk.slice(0, 3).map(h => line(h, 'VERIFIED_FACT')),
  };
}

module.exports = {
  INDEX_TICKERS, SECTOR_ETFS, VIX_TICKER, MARKET_MODES, MODE_T, BASIS,
  instrumentState, sectorStatesOf, deriveMarketMode, buildMarketState, buildPlaybook,
};

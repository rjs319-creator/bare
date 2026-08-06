'use strict';
// SELECTED-STOCK DOSSIER & MULTI-HORIZON ALIGNMENT — tech-command-dossier-v1.
//
// One name, three INDEPENDENT stances, assembled from the boards that already
// decided them. The dossier never re-decides anything: it reads the day-trade,
// swing and long-term rows for a ticker, keeps their conclusions separate, and
// then does the one thing no single board can do — surface the CONTRADICTIONS
// between them.
//
// Alignment across horizons is INFORMATION, not conviction. It is displayed; it
// never raises an action, a score, or a size. That is stated on the record itself
// so a renderer cannot quietly reinterpret it.
//
// Pure: snapshot sections in, frozen dossier out.

const DOSSIER_VERSION = 'tech-command-dossier-v1';

// Coarse per-horizon stance used only for the alignment strip.
const STANCE = Object.freeze({
  daytrade: {
    TRIGGERED: 'bullish', MANAGE: 'bullish', READY: 'constructive', WATCH: 'watch',
    AVOID: 'overextended', INVALIDATED: 'bearish', EXPIRED: 'no-trade', TARGET_REACHED: 'completed',
  },
  swing: {
    ENTER: 'bullish', READY: 'constructive', HOLD: 'constructive', WATCH: 'watch',
    DO_NOT_CHASE: 'overextended', REDUCE: 'weakening', EXIT_INVALIDATE: 'invalidated',
  },
  longterm: {
    ACCUMULATE: 'bullish', WATCH_VALUATION: 'constructive', HOLD: 'constructive',
    THESIS_WEAKENING: 'weakening', REDUCE: 'weakening', EXIT_THESIS_BROKEN: 'broken',
    INSUFFICIENT_DATA: 'unknown',
  },
});

const find = (rows, ticker) => (rows || []).find(r => r.ticker === ticker) || null;

/**
 * The compact alignment strip for a set of tickers.
 * @param {{daytrade: object, swing: object, longterm: object, tickers?: string[]}} input
 */
function buildAlignment({ daytrade, swing, longterm, tickers = null } = {}) {
  const dtRows = (daytrade && daytrade.rows) || [];
  const swRows = (swing && swing.rows) || [];
  const ltRows = (longterm && longterm.rows) || [];
  const universe = tickers || [...new Set([...dtRows, ...swRows, ...ltRows].map(r => r.ticker))];

  const rows = universe.map(t => {
    const dt = find(dtRows, t), sw = find(swRows, t), lt = find(ltRows, t);
    const dtStance = dt ? (STANCE.daytrade[dt.action] || 'unknown') : 'not-on-board';
    const swStance = sw ? (STANCE.swing[sw.action] || 'unknown') : 'not-on-board';
    const ltStance = lt ? (STANCE.longterm[lt.action] || 'unknown') : 'not-on-board';
    const present = [dt, sw, lt].filter(Boolean).length;
    const distinct = new Set([dtStance, swStance, ltStance].filter(s => s !== 'not-on-board'));
    return {
      ticker: t,
      company: (dt && dt.company) || (sw && sw.company) || (lt && lt.company) || null,
      subsector: (dt && dt.subsector) || (sw && sw.subsector) || (lt && lt.subsector) || null,
      daytrade: dt ? { action: dt.action, stance: dtStance } : null,
      swing: sw ? { action: sw.action, stance: swStance } : null,
      longterm: lt ? { action: lt.action, stance: ltStance } : null,
      horizonsPresent: present,
      agreement: distinct.size <= 1 && present > 1 ? 'aligned' : present > 1 ? 'divergent' : 'single-horizon',
      summary: `day ${dtStance} / swing ${swStance} / long-term ${ltStance}`,
    };
  }).sort((a, b) => b.horizonsPresent - a.horizonsPresent || a.ticker.localeCompare(b.ticker));

  return Object.freeze({
    schema: DOSSIER_VERSION,
    rows: Object.freeze(rows),
    policy: 'Alignment across horizons is INFORMATION ONLY. It does not increase conviction, action or size; its incremental value has not been prospectively validated.',
    affectsConviction: false,
  });
}

/**
 * The full dossier for one ticker.
 * @param {{ticker: string, snapshot: object}} input
 */
function buildDossier({ ticker, snapshot } = {}) {
  const t = String(ticker || '').toUpperCase();
  if (!t || !snapshot) return null;
  const u = (snapshot.universe && snapshot.universe.byTicker && snapshot.universe.byTicker[t]) || null;
  const dt = find(snapshot.daytrade && snapshot.daytrade.rows, t);
  const sw = find(snapshot.swing && snapshot.swing.rows, t);
  const lt = find(snapshot.longterm && snapshot.longterm.rows, t);
  const opt = find(snapshot.options && snapshot.options.rows, t);
  const soc = find(snapshot.sentiment && snapshot.sentiment.rows, t);
  const rt = find(snapshot.readthrough && snapshot.readthrough.movers, t);

  if (!u && !dt && !sw && !lt) {
    return Object.freeze({
      schema: DOSSIER_VERSION, ticker: t, found: false,
      reason: 'This ticker is not in the technology universe and is not on any Command Center board.',
    });
  }

  const events = filterEventsFor(snapshot.events, t);
  const scenarios = (snapshot.scenarios && snapshot.scenarios[t]) || null;
  const lifecycle = collectLifecycle(snapshot.lifecycle, t);
  const contradictions = buildContradictions({ dt, sw, lt, opt, soc, rt, longtermRow: lt });

  return Object.freeze({
    schema: DOSSIER_VERSION,
    ticker: t,
    found: true,
    company: u ? u.company : (dt && dt.company) || (sw && sw.company) || null,
    subsector: u ? u.subsector : null,
    subsectorLabel: u ? u.subsectorLabel : null,
    classification: u ? u.classification : null,
    conclusion: buildConclusion({ dt, sw, lt }),
    // Three INDEPENDENT stances — never merged into one number.
    intraday: dt ? Object.freeze({ ...dt }) : Object.freeze({ action: 'NOT_ON_BOARD', reason: 'No Day Trade candidate exists for this name right now.' }),
    swing: sw ? Object.freeze({ ...sw }) : Object.freeze({ action: 'NOT_ON_BOARD', reason: 'No governed swing signal exists for this name right now.' }),
    longterm: lt ? Object.freeze({ ...lt }) : Object.freeze({ action: 'NOT_ON_BOARD', reason: 'No long-term evaluation was computed for this name this cycle.' }),
    whyItMattersNow: buildWhyNow({ dt, sw, lt, rt, events }),
    whatChangedSincePriorSession: lifecycle.whatChanged,
    priceStructure: dt ? Object.freeze({
      price: dt.price, pctChange: dt.pctChange, relVol: dt.relVol,
      vwap: dt.vwap, aboveVwap: dt.aboveVwap, extensionAtr: dt.extensionAtr,
    }) : null,
    relativeStrength: Object.freeze({
      vsQqq: (sw && sw.techContext && sw.techContext.rsVsQqq21) ?? (rt && rt.rsVsQqq) ?? null,
      vsSubsector: (sw && sw.techContext && sw.techContext.rsVsSubsector21) ?? (rt && rt.rsVsSubsector) ?? null,
      subsectorRank: (sw && sw.techContext && sw.techContext.subsectorRank) ?? null,
      subsectorCount: (sw && sw.techContext && sw.techContext.subsectorCount) ?? null,
      benchmark: u ? u.benchmark : null,
    }),
    readThrough: rt ? Object.freeze({ ...rt }) : null,
    events: Object.freeze(events),
    scenarios,
    options: opt ? Object.freeze({ ...opt }) : Object.freeze({ state: 'DIRECTION_UNKNOWN', reason: 'No unusual options activity cleared the thresholds for this name.', weight: 0, canOriginate: false }),
    social: soc ? Object.freeze({ ...soc }) : Object.freeze({ state: 'INSUFFICIENT_COVERAGE', reason: 'This name did not appear in the archived attention window. Missing mentions are not zero mentions.', weight: 0 }),
    tradePlanByHorizon: Object.freeze({
      intraday: dt ? { action: dt.action, trigger: dt.trigger, entry: dt.entry, invalidation: dt.invalidation, target: dt.target, timeStop: dt.timeStop } : null,
      swing: sw ? { action: sw.action, trigger: sw.trigger, entry: sw.entry, invalidation: sw.invalidation, target: sw.target, hold: sw.expectedHoldingPeriod } : null,
      longterm: lt ? { action: lt.action, thesis: lt.coreThesis, invalidation: lt.longTermInvalidation } : null,
    }),
    supportingEvidence: Object.freeze([
      ...((sw && sw.supporting) || []).map(e => ({ horizon: 'swing', ...e })),
      ...((lt && lt.supporting) || []).map(e => ({ horizon: 'longterm', ...e })),
    ]),
    contradictingEvidence: Object.freeze([
      ...((sw && sw.contradicting) || []).map(e => ({ horizon: 'swing', ...e })),
      ...((lt && lt.contradicting) || []).map(e => ({ horizon: 'longterm', ...e })),
    ]),
    contradictions: Object.freeze(contradictions),
    invalidationConditions: Object.freeze([
      ...(dt && dt.invalidation != null ? [`Intraday: ${dt.invalidation}`] : []),
      ...(sw && sw.invalidation != null ? [`Swing: ${sw.invalidation}`] : []),
      ...(lt && lt.longTermInvalidation ? lt.longTermInvalidation.map(x => `Long term: ${x}`) : []),
    ]),
    stateTransitions: Object.freeze(lifecycle.history),
    evidenceMaturity: Object.freeze({
      daytrade: 'validated-executable (frozen production engine, consumed read-only)',
      swing: sw ? `governed (${sw.signalClass || 'unclassified'}) — uncalibrated relative score` : 'not evaluated',
      longterm: 'heuristic — uncalibrated, no out-of-sample artifact',
      options: 'research overlay — weight 0',
      social: 'research overlay — weight 0',
      readThroughInferredEdges: 'research only — weight 0',
    }),
    dataTimestamps: Object.freeze({
      price: (dt && (dt.quoteAsOf || dt.intradayBarAsOf)) || null,
      swingInputs: (sw && sw.dataAsOf) || null,
      fundamentals: (lt && lt.latestDataAsOf) || null,
      options: opt ? opt.asOf : null,
      social: soc ? soc.asOf : null,
      universe: (snapshot.universe && snapshot.universe.universeAsOf) || null,
    }),
    probability: null,
    probabilityNote: 'No calibrated probability exists for any horizon on this page.',
  });
}

function buildConclusion({ dt, sw, lt }) {
  const parts = [];
  if (dt) parts.push(`intraday ${dt.action}`);
  if (sw) parts.push(`swing ${sw.action}`);
  if (lt) parts.push(`long term ${lt.action}`);
  if (!parts.length) return 'Not currently surfaced on any horizon.';
  return parts.join(' · ');
}

function buildWhyNow({ dt, sw, lt, rt, events }) {
  const out = [];
  if (dt && dt.catalyst) out.push(`Intraday: ${dt.catalyst}`);
  if (sw && sw.whyNow) out.push(`Swing: ${sw.whyNow}`);
  if (lt && lt.coreThesis) out.push(`Long term: ${lt.coreThesis}`);
  if (rt && rt.scopeExplanation) out.push(`Read-through: ${rt.scopeExplanation}`);
  const nextEvent = (events || []).find(e => e.scheduledFor);
  if (nextEvent) out.push(`Next scheduled event: ${nextEvent.kind} on ${nextEvent.scheduledFor}.`);
  if (!out.length) out.push('Nothing specific is driving this name on this surface right now.');
  return out;
}

function buildContradictions({ dt, sw, lt, opt, soc, rt }) {
  const out = [];
  if (lt && sw && ['ACCUMULATE', 'HOLD', 'WATCH_VALUATION'].includes(lt.action) && sw.action === 'EXIT_INVALIDATE') {
    out.push('Long-term evidence is constructive, but the swing setup is below its invalidation. Long-term watch; no swing entry.');
  }
  if (lt && lt.revisions && lt.revisions.status === 'PIT_UNPROVEN') {
    out.push('Analyst revisions look supportive but are PIT_UNPROVEN — they carry zero weight and cannot be used as evidence.');
  }
  if (dt && sw && dt.action === 'AVOID' && sw.action === 'ENTER') {
    out.push('The intraday engine calls this overextended while the swing board would enter — the entry price you get today may be poor even if the multi-week thesis is right.');
  }
  if (opt && opt.state === 'CONTRADICTS_SETUP') {
    out.push('Delayed options positioning leans against the price setup. It cannot veto the setup, but it lowers the quality of the evidence.');
  }
  if (soc && (soc.state === 'SATURATED' || soc.state === 'COORDINATED')) {
    out.push(`Attention is ${soc.state === 'SATURATED' ? 'saturated' : 'possibly coordinated'} — crowding risk, not confirmation.`);
  }
  if (rt && rt.betaCheck && /beta/.test(rt.betaCheck) && !/genuine relative leadership/.test(rt.betaCheck)) {
    out.push(`Apparent strength is ${rt.betaCheck.toLowerCase()}`);
  }
  if (lt && lt.action === 'INSUFFICIENT_DATA') {
    out.push('The long-term model does not have enough data on this name to reach a verdict — treat any long-term claim about it as unsupported.');
  }
  return out;
}

function filterEventsFor(events, ticker) {
  if (!events) return [];
  const all = [...(events.past || []), ...(events.upcoming || [])];
  return all.filter(e => e.ticker === ticker || e.scope !== 'company').slice(0, 30);
}

function collectLifecycle(lifecycle, ticker) {
  const out = { history: [], whatChanged: null };
  if (!lifecycle) return out;
  for (const horizon of ['daytrade', 'swing', 'longterm']) {
    const h = lifecycle[horizon];
    const rec = h && h.records && h.records[ticker];
    if (!rec) continue;
    out.history.push(...(rec.history || []).map(x => ({ horizon, ...x })));
    const tr = (h.transitions || []).find(x => x.ticker === ticker);
    if (tr && !out.whatChanged) out.whatChanged = `${horizon}: ${tr.whatChanged}`;
  }
  out.history.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  out.history = out.history.slice(0, 30);
  return out;
}

module.exports = {
  DOSSIER_VERSION, STANCE, buildAlignment, buildDossier,
  buildConclusion, buildWhyNow, buildContradictions,
};

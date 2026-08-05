'use strict';
// CENTRAL FAIL-CLOSED ELIGIBILITY (quant-redesign-3, Phase 4A) — the ONE place that
// decides, for every normalized live source, whether its signals may originate/boost a
// live recommendation and how much sizing clearance they carry. No adapter has to
// remember to gate itself (the audit found exactly one of eleven did).
//
// Three separate questions, answered separately (display ≠ trade ≠ size):
//   displayEligible — may the signal be SHOWN (with an honest status badge)? Always
//                     true here: UI placement must not imply validation, and hiding
//                     research from view is not the control that matters.
//   tradeEligible   — may it originate or boost a LIVE recommendation (Today top list,
//                     portfolio, opportunity-density qualification)? Requires BOTH the
//                     registry's explicit static 'production' maturity AND earned,
//                     current governance clearance. Unknown, missing, stale, or
//                     version-mismatched governance ⇒ NOT eligible (fail closed).
//   sizingWeight    — 0..1 clearance from governance status (Production 1, Reduced .5,
//                     Probation .25, else 0), zero when not tradeEligible.
//
// MODE resolution (env DECISION_ELIGIBILITY_MODE):
//   'enforce'  — THE DEFAULT (non-daytrade redesign 2026-08 §9). Non-trade-eligible
//                sources are excluded BEFORE the merge (so research evidence can neither
//                originate a row nor boost a production row), and shorts without observed
//                borrow are excluded fail-closed. The served payload still carries the
//                full research cross-section, explicitly classed.
//   'annotate' — EXPLICIT DIAGNOSTIC OVERRIDE ONLY. The ranked board is the legacy
//                ungated merge and every signal carries its verdict. It was the default
//                during the pre-enable review period; leaving a fail-OPEN merge as the
//                default is precisely the hazard this module exists to remove, so it must
//                now be requested deliberately (env or opts) and the payload says so.
//   'off'      — legacy escape hatch, no annotation at all.
//
// IMPORTANT: the sizing lanes (portfolio, ensemble Book, opportunity density) are built
// from ACTIONABLE + sizing-eligible signals in EVERY mode — see lib/decision-routes.js.
// The mode only decides what the ranked *display* board contains.
//
// DAY TRADE EXCLUSION (user directive): source 'daytrade' is PINNED to its existing
// behavior — static production status alone, no earned-governance requirement — so no
// shared-system change here can alter Day Trade's presence or rank. Regression-tested.
//
// Pure (registry + governance doc injected). No network, no state.

const { statusOf } = require('./strategy-gate');
const SC = require('./strategy-contracts');

const ELIGIBILITY_VERSION = 'eligibility-v2';
const MODES = ['off', 'annotate', 'enforce'];
// FAIL-CLOSED DEFAULT (redesign Phase 2 item 1). Was 'annotate'.
const DEFAULT_MODE = 'enforce';
const DIAGNOSTIC_MODES = Object.freeze(['annotate', 'off']);
// Governance older than this is STALE ⇒ no clearance. The warm cron refreshes daily;
// 7 days tolerates a broken weekend cron without silently trading on ancient evidence.
const GOV_STALE_MS = 7 * 24 * 3600 * 1000;
const PINNED_SOURCES = Object.freeze({ daytrade: 'Day Trade behavior is frozen by user directive — static production status only, governance not consulted.' });

function resolveMode(raw) {
  const m = String(raw || '').toLowerCase();
  return MODES.includes(m) ? m : DEFAULT_MODE;
}

// Index a governance doc ({ strategies: [{id, status, weight, version, ...}], savedAt })
// by strategy id, with freshness resolved once.
function indexGovernance(governanceDoc, nowMs) {
  if (!governanceDoc || !Array.isArray(governanceDoc.strategies)) return null;
  const savedAt = governanceDoc.savedAt ? Date.parse(governanceDoc.savedAt) : NaN;
  const writeFresh = Number.isFinite(savedAt) && Number.isFinite(nowMs)
    ? (nowMs - savedAt) <= GOV_STALE_MS
    : false; // no timestamp ⇒ cannot prove freshness ⇒ stale (fail closed)
  // EVIDENCE freshness is checked SEPARATELY from write freshness: the daily maturity
  // cron re-stamps savedAt even when the scoreboard chain is broken, so a fresh write
  // timestamp must not make old evidence look current. scoreboardGeneratedAt (or the
  // classifier's generatedAt ride-along) is the Scoreboard's own generation time;
  // absent ⇒ evidence age unprovable ⇒ stale (fail closed).
  const evidRaw = governanceDoc.scoreboardGeneratedAt || governanceDoc.generatedAt || null;
  const evidAt = evidRaw ? Date.parse(evidRaw) : NaN;
  const evidenceFresh = Number.isFinite(evidAt) && Number.isFinite(nowMs)
    ? (nowMs - evidAt) <= GOV_STALE_MS
    : false;
  const byId = new Map();
  for (const s of governanceDoc.strategies) if (s && s.id) byId.set(s.id, s);
  return { byId, fresh: writeFresh && evidenceFresh, writeFresh, evidenceFresh, savedAt: governanceDoc.savedAt || null, scoreboardGeneratedAt: evidRaw };
}

// Assess ONE source id. `gov` = indexGovernance() result (or null when no doc exists).
function assessSource(source, { registry, gov, registryVersionOf } = {}) {
  const staticStatus = statusOf(source, registry);
  const reasons = [];
  const pinned = Object.prototype.hasOwnProperty.call(PINNED_SOURCES, source);

  if (pinned) {
    const trade = staticStatus === 'production';
    if (!trade) reasons.push(`static maturity '${staticStatus}' — not production`);
    return {
      source, staticStatus, pinned: true, governance: null,
      displayEligible: true, tradeEligible: trade, sizingWeight: trade ? 1 : 0,
      reasons: trade ? [PINNED_SOURCES[source]] : reasons,
    };
  }

  let tradeEligible = false;
  let sizingWeight = 0;
  let governance = null;
  let reasonCode = null;

  if (staticStatus !== 'production') {
    reasonCode = 'NOT_PRODUCTION';
    reasons.push(`static maturity '${staticStatus}' — not production (fail closed)`);
  } else if (!gov) {
    reasonCode = 'NO_GOVERNANCE';
    reasons.push('no governance state available — earned clearance unknown (fail closed)');
  } else if (!gov.fresh) {
    reasonCode = 'GOVERNANCE_STALE';
    reasons.push(gov.writeFresh && !gov.evidenceFresh
      ? `governance was re-written recently (savedAt ${gov.savedAt || 'unknown'}) but its underlying Scoreboard evidence is stale/unproven (${gov.scoreboardGeneratedAt || 'no evidence timestamp'}) — a fresh write cannot make old evidence current (fail closed)`
      : `governance state stale (savedAt ${gov.savedAt || 'unknown'}) — fail closed`);
  } else {
    const rec = gov.byId.get(source) || null;
    if (!rec) {
      reasonCode = 'NO_GOVERNANCE';
      reasons.push('no governance record for this strategy — fail closed');
    } else {
      governance = {
        status: rec.status || null,
        weight: Number.isFinite(rec.weight) ? rec.weight : 0,
        version: rec.version ?? null,
        // gov-v3 reduce-only (grandfathered) clearance: existing exposure may be managed,
        // but NO new position may be originated. Absent ⇒ derived from the status ladder.
        newPositions: rec.newPositions === undefined
          ? require('./governance').newPositionsAllowed(rec.status)
          : rec.newPositions === true,
        grandfathered: rec.grandfathered === true,
        grandfatherExpiresAt: rec.grandfatherExpiresAt || null,
      };
      const expectVersion = registryVersionOf ? registryVersionOf(source) : null;
      // A governance record with NO version cannot prove it matches the current
      // scoring version — missing is a mismatch, not a pass (the `rec.version &&`
      // guard used to let null-versioned records through open).
      if (expectVersion && rec.version !== expectVersion) {
        reasonCode = 'VERSION_MISMATCH';
        reasons.push(rec.version
          ? `governance evidence is for scoring version ${rec.version}, current is ${expectVersion} — reset required (fail closed)`
          : `governance evidence carries NO scoring version, current is ${expectVersion} — unversioned legacy evidence cannot clear a current strategy (fail closed)`);
      } else if (!(governance.weight > 0)) {
        reasonCode = 'NO_CLEARANCE';
        reasons.push(`governance status '${governance.status}' carries no sizing clearance`);
      } else if (!governance.newPositions) {
        reasonCode = 'REDUCE_ONLY';
        reasons.push(`governance status '${governance.status}' is REDUCE-ONLY${governance.grandfatherExpiresAt ? ` (grandfathered, expires ${governance.grandfatherExpiresAt})` : ''} — existing exposure may be managed, but no NEW position may be originated (fail closed)`);
      } else {
        tradeEligible = true;
        sizingWeight = Math.max(0, Math.min(1, governance.weight));
        reasons.push(`production + governance '${governance.status}' (clearance ${sizingWeight})`);
      }
    }
  }
  return { source, staticStatus, pinned: false, governance, displayEligible: true, tradeEligible, sizingWeight, reasonCode, reasons };
}

// Machine-readable exclusion codes (the UI and the tests join on these, never on prose).
const REASON_CODE = Object.freeze({
  OK: 'OK',
  NOT_PRODUCTION: 'NOT_PRODUCTION',
  NO_GOVERNANCE: 'NO_GOVERNANCE',
  GOVERNANCE_STALE: 'GOVERNANCE_STALE',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  NO_CLEARANCE: 'NO_CLEARANCE',
  REDUCE_ONLY: 'REDUCE_ONLY',
  NO_BORROW: 'NO_BORROW',
  CONDITION_UNMET: 'CONDITION_UNMET',
  DATA_STALE: 'DATA_STALE',
  NO_PLAN: 'NO_PLAN',
  LEAD_ONLY: 'LEAD_ONLY',
  LIQUIDITY_UNKNOWN: 'LIQUIDITY_UNKNOWN',
});

// Signal-level verdict on top of the source verdict: short-side borrow fail-closed gate,
// pre-ranking data freshness (Phase 8), and data-completeness sizing discipline (missing
// plan levels or unknown liquidity must reduce eligibility/size — never receive the
// cheapest assumption at full confidence).
//   dataGate — { ok:boolean, reason, staleInputs:[] } for THIS signal's source, from
//              lib/data-gates.js. Absent ⇒ not consulted (callers that predate the gate);
//              present and not ok ⇒ the signal cannot originate a NEW entry (fail closed).
function assessSignal(sig, srcAssessment, { borrowFeed = null, dataGate = null } = {}) {
  const a = srcAssessment;
  const reasons = [];
  const codes = [];
  let tradeEligible = a.tradeEligible;
  if (!tradeEligible) codes.push(a.reasonCode || REASON_CODE.NOT_PRODUCTION);

  const isShort = sig.side === 'short';
  const needsBorrow = isShort && SC.borrowRequired(sig.source);
  const hasBorrow = !!(borrowFeed && sig.ticker && borrowFeed[sig.ticker]);
  if (isShort && needsBorrow && !hasBorrow) {
    tradeEligible = false;
    codes.push(REASON_CODE.NO_BORROW);
    reasons.push('short with no observed borrow/locate — research/watch only (fail closed)');
  }

  // PRE-RANKING DATA GATE (Phase 8): stale/partial required inputs block a NEW entry
  // recommendation outright. Existing positions stay visible through the retained-pick
  // lanes (MONITOR/HOLD/INVALIDATED/DATA_STALE) — they are simply not fresh entries.
  if (dataGate && dataGate.ok === false) {
    tradeEligible = false;
    codes.push(REASON_CODE.DATA_STALE);
    reasons.push(`required data is stale/incomplete (${dataGate.reason || 'unproven freshness'}) — no new entry may be recommended (fail closed)`);
  }

  // CONDITIONAL-CONTEXT GATE (fail closed): a conditional sleeve (e.g. Down-Day's
  // red-tape-only contract) may only be actionable while its own condition is MET.
  // A declared-but-unmet (or unknown) condition demotes the row to research — the
  // validated sample simply does not cover the current context.
  if (sig.conditionGate && sig.conditionGate.required && sig.conditionGate.met !== true) {
    tradeEligible = false;
    codes.push(REASON_CODE.CONDITION_UNMET);
    reasons.push(`conditional sleeve outside its validated context (${sig.conditionGate.required} not met) — research control, not actionable (fail closed)`);
  }

  // LEAD-ONLY CONTRACTS (Phase 7): a strategy whose own contract declares `lead-only`
  // publishes information, not a trade plan. Even if a downstream adapter attaches
  // levels, it can never be sized under this identity — its evidence was never earned
  // on an executable plan.
  const contract = SC.contractFor(sig.source);
  const leadOnly = !!(contract && contract.fillPolicy === 'lead-only');
  const planComplete = Number.isFinite(sig.entry) && Number.isFinite(sig.stop) && Number.isFinite(sig.target);
  const liquidityKnown = !!(sig.liquidity && Number.isFinite(sig.liquidity.dollarVol));
  const sizingEligible = tradeEligible && planComplete && liquidityKnown && !leadOnly;
  if (tradeEligible && leadOnly) { codes.push(REASON_CODE.LEAD_ONLY); reasons.push('contract fillPolicy is lead-only — informational lead, never a sizable position'); }
  if (tradeEligible && !planComplete) { codes.push(REASON_CODE.NO_PLAN); reasons.push('no complete entry/stop/target plan — lead only, not sizable'); }
  if (tradeEligible && !liquidityKnown) { codes.push(REASON_CODE.LIQUIDITY_UNKNOWN); reasons.push('liquidity unknown — not sizable at full confidence'); }

  return {
    version: ELIGIBILITY_VERSION,
    source: a.source,
    staticStatus: a.staticStatus,
    pinned: a.pinned || false,
    governance: a.governance,
    displayEligible: true,
    tradeEligible,
    sizingEligible,
    leadOnly,
    dataFresh: dataGate ? dataGate.ok !== false : null,
    sizingWeight: sizingEligible ? a.sizingWeight : 0,
    // Three-class taxonomy (novice-facing): ACTIONABLE = evidence-cleared AND a
    // complete executable plan with known liquidity (may be sized); QUALIFIED_LEAD =
    // evidence-cleared directional information that is NOT an executable/sizable trade
    // (plan or liquidity missing — never backfilled with assumptions); RESEARCH =
    // everything else (unproven/shadow/stale/mismatched), visible but never sized.
    signalClass: sizingEligible ? 'ACTIONABLE' : tradeEligible ? 'QUALIFIED_LEAD' : 'RESEARCH',
    reasonCodes: codes.length ? [...new Set(codes)] : [REASON_CODE.OK],
    reasons: [...a.reasons, ...reasons],
  };
}

// Gate a batch of RAW normalized signals (pre-merge). Returns:
//   { mode, perSource, annotated: [ {sig, eligibility} … ],
//     tradeable: raw signals allowed to originate/boost under 'enforce',
//     excluded: [{ticker, source, side, reason}] }
function gateSignals(rawSignals, { mode = DEFAULT_MODE, registry, governance, borrowFeed = null, dataGates = null, nowMs = Date.now() } = {}) {
  const gov = indexGovernance(governance, nowMs);
  const regVersion = (src) => {
    const list = registry || require('./strategy-registry').STRATEGY_REGISTRY;
    const e = list.find(x => x && x.id === src);
    return (e && e.scoringVersion) || null;
  };
  const perSource = new Map();
  const annotated = [];
  const tradeable = [];   // ACTIONABLE ∪ QUALIFIED_LEAD (may display on the gated board)
  const sizable = [];     // ACTIONABLE only (may originate/size a portfolio position)
  const excluded = [];
  for (const sig of rawSignals || []) {
    if (!sig) continue;
    const src = sig.source;
    if (!perSource.has(src)) perSource.set(src, assessSource(src, { registry, gov, registryVersionOf: regVersion }));
    const el = assessSignal(sig, perSource.get(src), { borrowFeed, dataGate: dataGates ? (dataGates[src] || null) : null });
    annotated.push({ sig, eligibility: el });
    if (el.tradeEligible) tradeable.push(sig);
    else excluded.push({ ticker: sig.ticker, source: src, side: sig.side || 'long', code: el.reasonCodes[0], reason: el.reasons[el.reasons.length - 1] || 'ineligible' });
    if (el.sizingEligible) sizable.push(sig);
  }
  const classCounts = { ACTIONABLE: 0, QUALIFIED_LEAD: 0, RESEARCH: 0 };
  for (const a of annotated) classCounts[a.eligibility.signalClass]++;
  return {
    mode,
    version: ELIGIBILITY_VERSION,
    diagnosticOverride: DIAGNOSTIC_MODES.includes(mode),
    governanceSeen: !!gov,
    governanceFresh: !!(gov && gov.fresh),
    perSource: Object.fromEntries([...perSource.entries()].map(([k, v]) => [k, v])),
    annotated, tradeable, sizable, excluded, classCounts,
  };
}

module.exports = {
  ELIGIBILITY_VERSION, MODES, DEFAULT_MODE, DIAGNOSTIC_MODES, GOV_STALE_MS, PINNED_SOURCES,
  REASON_CODE,
  resolveMode, indexGovernance, assessSource, assessSignal, gateSignals,
};

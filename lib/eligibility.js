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
// ENFORCEMENT IS FEATURE-GATED. Mode resolution (env DECISION_ELIGIBILITY_MODE):
//   'off'      — legacy behavior, no annotation (escape hatch).
//   'annotate' — DEFAULT. The board is byte-identical to legacy; every signal carries
//                its eligibility verdict and the payload carries a shadow comparison
//                (what enforcement WOULD change). This is the pre-enable report the
//                redesign requires before any live flip.
//   'enforce'  — non-trade-eligible sources are excluded BEFORE the merge (so shadow
//                evidence can neither originate a row nor boost a production row),
//                and shorts without observed borrow are excluded fail-closed.
//
// DAY TRADE EXCLUSION (user directive): source 'daytrade' is PINNED to its existing
// behavior — static production status alone, no earned-governance requirement — so no
// shared-system change here can alter Day Trade's presence or rank. Regression-tested.
//
// Pure (registry + governance doc injected). No network, no state.

const { statusOf } = require('./strategy-gate');
const SC = require('./strategy-contracts');

const ELIGIBILITY_VERSION = 'eligibility-v1';
const MODES = ['off', 'annotate', 'enforce'];
const DEFAULT_MODE = 'annotate';
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

  if (staticStatus !== 'production') {
    reasons.push(`static maturity '${staticStatus}' — not production (fail closed)`);
  } else if (!gov) {
    reasons.push('no governance state available — earned clearance unknown (fail closed)');
  } else if (!gov.fresh) {
    reasons.push(gov.writeFresh && !gov.evidenceFresh
      ? `governance was re-written recently (savedAt ${gov.savedAt || 'unknown'}) but its underlying Scoreboard evidence is stale/unproven (${gov.scoreboardGeneratedAt || 'no evidence timestamp'}) — a fresh write cannot make old evidence current (fail closed)`
      : `governance state stale (savedAt ${gov.savedAt || 'unknown'}) — fail closed`);
  } else {
    const rec = gov.byId.get(source) || null;
    if (!rec) {
      reasons.push('no governance record for this strategy — fail closed');
    } else {
      governance = { status: rec.status || null, weight: Number.isFinite(rec.weight) ? rec.weight : 0, version: rec.version ?? null };
      const expectVersion = registryVersionOf ? registryVersionOf(source) : null;
      // A governance record with NO version cannot prove it matches the current
      // scoring version — missing is a mismatch, not a pass (the `rec.version &&`
      // guard used to let null-versioned records through open).
      if (expectVersion && rec.version !== expectVersion) {
        reasons.push(rec.version
          ? `governance evidence is for scoring version ${rec.version}, current is ${expectVersion} — reset required (fail closed)`
          : `governance evidence carries NO scoring version, current is ${expectVersion} — unversioned legacy evidence cannot clear a current strategy (fail closed)`);
      } else if (!(governance.weight > 0)) {
        reasons.push(`governance status '${governance.status}' carries no sizing clearance`);
      } else {
        tradeEligible = true;
        sizingWeight = Math.max(0, Math.min(1, governance.weight));
        reasons.push(`production + governance '${governance.status}' (clearance ${sizingWeight})`);
      }
    }
  }
  return { source, staticStatus, pinned: false, governance, displayEligible: true, tradeEligible, sizingWeight, reasons };
}

// Signal-level verdict on top of the source verdict: short-side borrow fail-closed gate
// and data-completeness sizing discipline (missing plan levels or unknown liquidity must
// reduce eligibility/size — never receive the cheapest assumption at full confidence).
function assessSignal(sig, srcAssessment, { borrowFeed = null } = {}) {
  const a = srcAssessment;
  const reasons = [];
  let tradeEligible = a.tradeEligible;

  const isShort = sig.side === 'short';
  const needsBorrow = isShort && SC.borrowRequired(sig.source);
  const hasBorrow = !!(borrowFeed && sig.ticker && borrowFeed[sig.ticker]);
  if (isShort && needsBorrow && !hasBorrow) {
    tradeEligible = false;
    reasons.push('short with no observed borrow/locate — research/watch only (fail closed)');
  }

  // CONDITIONAL-CONTEXT GATE (fail closed): a conditional sleeve (e.g. Down-Day's
  // red-tape-only contract) may only be actionable while its own condition is MET.
  // A declared-but-unmet (or unknown) condition demotes the row to research — the
  // validated sample simply does not cover the current context.
  if (sig.conditionGate && sig.conditionGate.required && sig.conditionGate.met !== true) {
    tradeEligible = false;
    reasons.push(`conditional sleeve outside its validated context (${sig.conditionGate.required} not met) — research control, not actionable (fail closed)`);
  }

  const planComplete = Number.isFinite(sig.entry) && Number.isFinite(sig.stop) && Number.isFinite(sig.target);
  const liquidityKnown = !!(sig.liquidity && Number.isFinite(sig.liquidity.dollarVol));
  const sizingEligible = tradeEligible && planComplete && liquidityKnown;
  if (tradeEligible && !planComplete) reasons.push('no complete entry/stop/target plan — lead only, not sizable');
  if (tradeEligible && !liquidityKnown) reasons.push('liquidity unknown — not sizable at full confidence');

  return {
    version: ELIGIBILITY_VERSION,
    source: a.source,
    staticStatus: a.staticStatus,
    pinned: a.pinned || false,
    governance: a.governance,
    displayEligible: true,
    tradeEligible,
    sizingEligible,
    sizingWeight: sizingEligible ? a.sizingWeight : 0,
    // Three-class taxonomy (novice-facing): ACTIONABLE = evidence-cleared AND a
    // complete executable plan with known liquidity (may be sized); QUALIFIED_LEAD =
    // evidence-cleared directional information that is NOT an executable/sizable trade
    // (plan or liquidity missing — never backfilled with assumptions); RESEARCH =
    // everything else (unproven/shadow/stale/mismatched), visible but never sized.
    signalClass: sizingEligible ? 'ACTIONABLE' : tradeEligible ? 'QUALIFIED_LEAD' : 'RESEARCH',
    reasons: [...a.reasons, ...reasons],
  };
}

// Gate a batch of RAW normalized signals (pre-merge). Returns:
//   { mode, perSource, annotated: [ {sig, eligibility} … ],
//     tradeable: raw signals allowed to originate/boost under 'enforce',
//     excluded: [{ticker, source, side, reason}] }
function gateSignals(rawSignals, { mode = DEFAULT_MODE, registry, governance, borrowFeed = null, nowMs = Date.now() } = {}) {
  const gov = indexGovernance(governance, nowMs);
  const regVersion = (src) => {
    const list = registry || require('./strategy-registry').STRATEGY_REGISTRY;
    const e = list.find(x => x && x.id === src);
    return (e && e.scoringVersion) || null;
  };
  const perSource = new Map();
  const annotated = [];
  const tradeable = [];
  const excluded = [];
  for (const sig of rawSignals || []) {
    if (!sig) continue;
    const src = sig.source;
    if (!perSource.has(src)) perSource.set(src, assessSource(src, { registry, gov, registryVersionOf: regVersion }));
    const el = assessSignal(sig, perSource.get(src), { borrowFeed });
    annotated.push({ sig, eligibility: el });
    if (el.tradeEligible) tradeable.push(sig);
    else excluded.push({ ticker: sig.ticker, source: src, side: sig.side || 'long', reason: el.reasons[el.reasons.length - 1] || 'ineligible' });
  }
  return {
    mode,
    version: ELIGIBILITY_VERSION,
    governanceSeen: !!gov,
    governanceFresh: !!(gov && gov.fresh),
    perSource: Object.fromEntries([...perSource.entries()].map(([k, v]) => [k, v])),
    annotated, tradeable, excluded,
  };
}

module.exports = {
  ELIGIBILITY_VERSION, MODES, DEFAULT_MODE, GOV_STALE_MS, PINNED_SOURCES,
  resolveMode, indexGovernance, assessSource, assessSignal, gateSignals,
};

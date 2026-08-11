'use strict';
// CFL — LIVE DECISION-SNAPSHOT CAPTURE. Called from /api/screener on WARM (cron)
// runs only, AFTER selection and BEFORE the response truncates rejections to 50.
// This closes audit gap #1: the live engine's reason-coded rejections were
// computed and then discarded; now the full per-name decision record persists to
// cfl/v1/decisions/<scope>-<date>.json (idempotent — re-warm overwrites the same
// key with the same-day record).
//
// Never throws to the caller: capture failure is logged evidence, not an outage.

const CFLSTORE = require('./store');
const { makeDecisionSnapshot } = require('./schemas');
const { logWarn } = require('../log');

const factorsOf = (c) => c && c.factors ? {
  mom63: c.factors.mom63 ?? null,
  vol: c.factors.vol ?? null,
  dollarVol: c.factors.dollarVol ?? null,
} : null;

// sel: the lib/swing-screener-engine selectCandidates result. regime/freshness ride on it.
function buildSnapshot({ sel, scope, decisionDate, macroRiskOff = null, engineVersion, scoringVersion, candidateSetHash = null, dataCutoff = null, governance = null }) {
  const names = [];
  sel.candidates.forEach((c, i) => {
    names.push({
      symbol: c.ticker, status: i < sel.cap ? 'selected' : 'near-miss',
      rejectionCode: null, rank: i + 1,
      score: c.quant ? c.quant.score : null,
      factors: factorsOf(c),
      missing: c.metrics && c.metrics.rsVsSpy63 != null ? [] : ['rsVsSpy63'],
    });
  });
  const selectedSet = new Set(sel.candidates.map(c => c.ticker));
  for (const r of sel.rejections) {
    if (!r.ticker || selectedSet.has(r.ticker)) continue;
    names.push({ symbol: r.ticker, status: 'rejected', rejectionCode: r.reason || null, rank: null, score: null, factors: null, missing: [] });
  }
  return makeDecisionSnapshot({
    scope, decisionDate,
    decisionSession: sel.freshness ? sel.freshness.decisionSession : null,
    engineVersion, scoringVersion,
    regime: sel.regime ? (sel.regime.bearish ? 'risk-off' : sel.regime.riskOn ? 'risk-on' : 'neutral') : null,
    macroRiskOff,
    candidateSetHash,
    cohortSize: sel.cohort.length,
    selectedCount: Math.min(sel.cap, sel.candidates.length),
    rejectionCounts: sel.rejections.reduce((m, r) => { m[r.reason] = (m[r.reason] || 0) + 1; return m; }, {}),
    names,
    freshness: sel.freshness ? { adjudicated: sel.freshness.adjudicated, decisionSession: sel.freshness.decisionSession, sessionSource: sel.freshness.sessionSource } : null,
    governance,
    dataCutoff,
    capturedAt: new Date().toISOString(),
    source: 'live-warm',
  });
}

// Fire-and-forget persistence. Returns a promise the caller may ignore.
async function captureDecisionSnapshot(input) {
  try {
    if (!CFLSTORE.hasStore()) return { written: false, reason: 'no-store' };
    const snap = buildSnapshot(input);
    await CFLSTORE.writeDecision(input.scope, snap.decisionDate, snap);
    return { written: true, decisionId: snap.decisionId, names: snap.names.length };
  } catch (e) {
    logWarn('cfl.capture', 'decision snapshot capture failed', { scope: input && input.scope, error: e.message });
    return { written: false, reason: e.message };
  }
}

module.exports = { buildSnapshot, captureDecisionSnapshot };

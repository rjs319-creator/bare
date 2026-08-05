'use strict';
// PRE-RANKING DATA FRESHNESS & COVERAGE GATES (non-daytrade redesign 2026-08, Phase 8).
//
// THE DEFECT THIS CLOSES. Freshness was computed AFTER the board was built and ranked
// (`payload.freshness` in lib/decision-routes.js) and only ever produced a warning
// string. A screener whose cache was two sessions old still originated fresh "enter now"
// recommendations at full rank; a missing sectors feed silently removed the sector
// control from every row; a partial universe scan looked identical to a complete one.
// Freshness must CONTROL actionability, not decorate it.
//
// THE CONTRACT. Before ranking or portfolio construction, every live source is checked
// for the inputs its own contract needs:
//   1. required price bar for the relevant horizon (payload asOf age vs the horizon's
//      tolerance — an intraday source may not run on yesterday's bar);
//   2. source timestamp AND information cutoff (decisionSession) both present;
//   3. minimum universe coverage (how many names were actually scanned);
//   4. required source-family coverage (did the upstreams this source depends on answer);
//   5. benchmark + sector reference data (the sector control cannot be silently dropped);
//   6. liquidity data (share of rows carrying a usable dollar-volume);
//   7. governance-artifact freshness is handled in lib/eligibility.js (same fail-closed rule).
// A source that fails ANY of these cannot originate a NEW entry (lib/eligibility.js
// consumes the verdict). Already-held/previously-published names remain visible through
// the retained lanes — MONITOR / HOLD / INVALIDATED / DATA_STALE — never as fresh entries.
//
// UNKNOWN IS STALE. A payload with no timestamp cannot prove freshness, so it fails
// closed. This is the opposite of the "unknown is neutral" rule used for ranking inputs,
// and deliberately so: ranking-neutral is a size question, actionability is a safety one.
//
// Pure: payloads in → verdicts out. No network, no state, injectable clock.

const DATA_GATE_VERSION = 'data-gates-v1';

// Age tolerance by the source's contract horizon. EOD data is the app's substrate, so a
// swing source may ride the previous session's close (≤30h covers a normal overnight plus
// the cron window); an intraday source may not (its own contract is same-session).
// Position/portfolio books rebalance slowly and tolerate a long weekend.
const MAX_AGE_HOURS = Object.freeze({ intraday: 20, swing: 30, position: 96, portfolio: 168 });

// Minimum share of a source's published rows that must carry a usable dollar-volume for
// the liquidity control to count as present. Below this the source can still display, but
// its rows are not sizable (eligibility already refuses unknown liquidity per row) and the
// gate records the coverage hole.
const MIN_LIQUIDITY_COVERAGE = 0.5;

// Reference feeds every cross-sectional ranking needs. Missing ⇒ the sector/benchmark
// control is absent, which is a data blocker, not a neutral.
const REFERENCE_FEEDS = Object.freeze(['sectors', 'scoreboard']);

const hoursBetween = (aMs, bMs) => (aMs - bMs) / 3_600_000;

function parseAsOf(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload.generatedAt || payload.at || payload.asOf
    || (payload.freshness && payload.freshness.generatedAt) || null;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? { raw, ms } : null;
}

// The information cutoff a payload declares (the last SESSION it could observe). This is
// the field that actually matters: every source stamps `generatedAt` at RESPONSE time, so
// a fresh response timestamp proves only that the endpoint answered — never that the data
// underneath it is current. Sources publish the cutoff under several historical names.
function cutoffOf(payload) {
  if (!payload) return null;
  const f = payload.freshness || payload.dataFreshness || null;
  return (f && (f.decisionSession || f.dataCutoffSession || f.sessionDate || f.asOfDate))
    || payload.decisionSession || payload.spyLastDate || payload.asOf || null;
}

// Trading sessions between the declared cutoff and the evaluation date. A source whose
// newest observable session is more than `maxSessions` behind cannot support a new entry.
function cutoffSessionsBehind(cutoff, nowMs) {
  if (!cutoff || !/^\d{4}-\d{2}-\d{2}/.test(String(cutoff))) return null;
  try {
    const { calendarSessionsBetween } = require('./swing-sessions');
    const today = new Date(nowMs).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const n = calendarSessionsBetween(String(cutoff).slice(0, 10), today);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

// How many sessions of staleness each contract horizon tolerates in its information
// cutoff. Intraday: the cutoff must be the current or immediately-prior session. Swing:
// one extra session of slack for a late cron. Position/portfolio books rebalance slowly.
const MAX_CUTOFF_SESSIONS = Object.freeze({ intraday: 1, swing: 2, position: 5, portfolio: 10 });

// Rows a source published (for coverage/liquidity accounting). Sources shape their
// payloads differently; we look at the conventional arrays and never guess a count.
function rowsOf(payload) {
  if (!payload) return [];
  for (const k of ['picks', 'rows', 'candidates', 'signals', 'names', 'results', 'items', 'list']) {
    if (Array.isArray(payload[k])) return payload[k];
  }
  // Bucketed payloads (gap engines publish strong/moderate lanes).
  const buckets = ['strong', 'moderate', 'bounces', 'fades'].filter(k => Array.isArray(payload[k]));
  if (buckets.length) return buckets.flatMap(k => payload[k]);
  return [];
}

// A row's dollar-volume, whichever of the app's historical shapes it uses. Returns null
// when the row genuinely carries no liquidity evidence (which is what the gate counts).
function dollarVolOf(row) {
  if (!row || typeof row !== 'object') return null;
  const cands = [
    row.liquidity && row.liquidity.dollarVol, row.dollarVol, row.avgDollarVol,
    row.factors && row.factors.dollarVol, row.liq && row.liq.dollarVol,
  ];
  for (const v of cands) if (Number.isFinite(v)) return v;
  return null;
}

// How many names the source SCANNED (the universe), when it says so. Distinct from how
// many it published: an empty result over a full scan is honest, an empty result over an
// empty scan is a broken feed.
function scannedOf(payload) {
  const f = payload && payload.freshness;
  const c = (f && f.counts) || payload?.counts || null;
  if (!c) return null;
  for (const k of ['scanned', 'attempted', 'universe', 'evaluated', 'total']) {
    if (Number.isFinite(c[k])) return c[k];
  }
  return null;
}

// Evaluate ONE source. `spec` = { horizon, minScanned, requires: [feed…] }.
function evaluateSource(id, payload, spec = {}, ctx = {}) {
  const nowMs = ctx.nowMs ?? Date.now();
  const horizon = spec.horizon || 'swing';
  const maxAge = MAX_AGE_HOURS[horizon] ?? MAX_AGE_HOURS.swing;
  const staleInputs = [];

  if (!payload) {
    return { source: id, ok: false, reason: 'source did not answer', staleInputs: ['payload'], asOf: null, ageHours: null, horizon, cutoff: null };
  }
  const asOf = parseAsOf(payload);
  const ageHours = asOf ? +hoursBetween(nowMs, asOf.ms).toFixed(2) : null;
  if (!asOf) staleInputs.push('no source timestamp (freshness unprovable)');
  else if (ageHours > maxAge) staleInputs.push(`payload is ${ageHours}h old (>${maxAge}h for a ${horizon} contract)`);
  else if (ageHours < -0.25) staleInputs.push(`payload timestamp is in the FUTURE (${ageHours}h) — contradictory clock`);

  const cutoff = cutoffOf(payload);
  let cutoffSessions = null;
  if (!cutoff) staleInputs.push('no declared information cutoff (decisionSession)');
  else {
    cutoffSessions = cutoffSessionsBehind(cutoff, nowMs);
    const maxSessions = MAX_CUTOFF_SESSIONS[horizon] ?? MAX_CUTOFF_SESSIONS.swing;
    if (cutoffSessions != null && cutoffSessions > maxSessions) {
      staleInputs.push(`information cutoff ${cutoff} is ${cutoffSessions} sessions behind (>${maxSessions} for a ${horizon} contract)`);
    }
  }

  const scanned = scannedOf(payload);
  if (Number.isFinite(spec.minScanned)) {
    if (scanned == null) staleInputs.push('universe coverage not reported');
    else if (scanned < spec.minScanned) staleInputs.push(`universe coverage ${scanned} < required ${spec.minScanned}`);
  }

  for (const need of spec.requires || []) {
    if (!ctx.available || ctx.available[need] !== true) staleInputs.push(`required reference feed '${need}' unavailable`);
  }

  const rows = rowsOf(payload);
  let liquidityCoverage = null;
  if (rows.length) {
    const withLiq = rows.filter(r => dollarVolOf(r) != null).length;
    liquidityCoverage = +(withLiq / rows.length).toFixed(3);
    if (liquidityCoverage < MIN_LIQUIDITY_COVERAGE) staleInputs.push(`liquidity data on only ${Math.round(liquidityCoverage * 100)}% of rows (<${Math.round(MIN_LIQUIDITY_COVERAGE * 100)}%)`);
  }

  return {
    source: id,
    ok: staleInputs.length === 0,
    reason: staleInputs[0] || null,
    staleInputs,
    asOf: asOf ? asOf.raw : null,
    ageHours, horizon, cutoff, cutoffSessions,
    scanned, rows: rows.length, liquidityCoverage,
  };
}

// Evaluate every live source before ranking.
//   sources  — { [id]: payload } exactly as the route pulled them
//   specs    — { [id]: { horizon, minScanned, requires } } (from lib/strategy-contracts)
// Returns the per-source gate map plus a degraded-data banner the UI can render verbatim.
function evaluateDataGates(sources = {}, { specs = {}, nowMs = Date.now(), referenceFeeds = REFERENCE_FEEDS } = {}) {
  const available = {};
  for (const feed of referenceFeeds) {
    const p = sources[feed];
    available[feed] = !!(p && (parseAsOf(p) || Object.keys(p).length > 0));
  }
  const perSource = {};
  for (const [id, payload] of Object.entries(sources)) {
    if (referenceFeeds.includes(id)) continue;
    perSource[id] = evaluateSource(id, payload, specs[id] || {}, { nowMs, available });
  }
  const blocked = Object.values(perSource).filter(g => !g.ok);
  const missingRef = referenceFeeds.filter(f => !available[f]);
  const banner = blocked.length || missingRef.length
    ? `Degraded data: ${blocked.length} source(s) cannot support a NEW entry${missingRef.length ? `; reference feed(s) missing: ${missingRef.join(', ')}` : ''}. Existing names stay visible as monitor/hold — they are not fresh entries.`
    : null;
  return {
    version: DATA_GATE_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    perSource,
    referenceFeeds: available,
    blockedSources: blocked.map(g => ({ source: g.source, reason: g.reason, staleInputs: g.staleInputs })),
    newEntriesBlocked: blocked.map(g => g.source),
    degraded: blocked.length > 0 || missingRef.length > 0,
    banner,
  };
}

// Build the per-source specs from the contract registry: the horizon a source is graded
// on decides its freshness tolerance, so the gate can never disagree with the contract.
function specsFromContracts(ids, { contracts = null, minScanned = null } = {}) {
  const SC = contracts || require('./strategy-contracts');
  const out = {};
  for (const id of ids || []) {
    const c = SC.contractFor(id);
    out[id] = {
      horizon: (c && c.horizon) || 'swing',
      ...(Number.isFinite(minScanned) ? { minScanned } : {}),
    };
  }
  return out;
}

// Retained (previously-published) picks must stay visible without ever reading as a fresh
// entry. This is the label lane: what the user is told about a name they may already hold.
//   INVALIDATED — the plan is objectively broken (stop hit / failed / expired lifecycle)
//   DATA_STALE  — we cannot currently attest the inputs; no judgement is offered
//   HOLD        — the trade is live (triggered) and the thesis is intact
//   MONITOR     — pre-trigger, still watchable, but not a fresh entry today
function retainedLabelFor(sig, gate) {
  const state = sig && sig.state;
  if (state === 'failed' || state === 'expired') return 'INVALIDATED';
  if (gate && gate.ok === false) return 'DATA_STALE';
  if (state === 'triggered' || state === 'extended') return 'HOLD';
  return 'MONITOR';
}

const RETAINED_LABEL_BLURB = Object.freeze({
  INVALIDATED: 'The original plan is broken (stop hit or the setup expired) — not a trade.',
  DATA_STALE: 'Required data is stale or incomplete — no fresh judgement is offered on this name today.',
  HOLD: 'Already triggered — manage the existing position; this is not a new entry.',
  MONITOR: 'Still watchable but not a fresh entry right now.',
});

module.exports = {
  DATA_GATE_VERSION, MAX_AGE_HOURS, MAX_CUTOFF_SESSIONS, MIN_LIQUIDITY_COVERAGE, REFERENCE_FEEDS,
  RETAINED_LABEL_BLURB,
  parseAsOf, cutoffOf, cutoffSessionsBehind, rowsOf, dollarVolOf, scannedOf,
  evaluateSource, evaluateDataGates, specsFromContracts, retainedLabelFor,
};

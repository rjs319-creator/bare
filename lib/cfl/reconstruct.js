'use strict';
// CFL — MARKET-WIDE MISSED-OPPORTUNITY RECONSTRUCTION. Pure core; dataset injected.
//
// For one (scope, horizon, checkpoint date): replay the EXACT production selection
// (lib/swing-replay-v3 → lib/swing-screener-engine — never a second scorer), label
// every evaluated symbol's forward window (path + cross-sectional), build a
// detection trace from the surrounding checkpoints' replays, and attribute every
// significant missed winner deterministically (lib/cfl/taxonomy).
//
// The sweep does NOT restrict itself to selected names — the whole point is the
// false negatives. Symbols absent from the dataset are the UNIVERSE_EXCLUSION
// evidence; symbols with thin history are DATA_UNAVAILABLE.
//
// Honesty stamps carried on every output: survivorshipSafe:false (candles are an
// as-of-today fetch; delisted names absent), macro overlay not point-in-time.

const REPLAY = require('../swing-replay-v3');
const CFG = require('./config');
const L = require('./labels');
const S = require('./schemas');
const T = require('./taxonomy');

// Benchmark-session checkpoints, oldest→newest, every `step` sessions, ending at
// least `horizonSessions` before the last benchmark bar (so labels can mature).
function buildCheckpoints({ spyCandles = [], horizonSessions, stepSessions = CFG.SWEEP.checkpointStepSessions, maxCheckpoints = 40 } = {}) {
  const lastIdx = spyCandles.length - 1 - horizonSessions - 1;   // -1: entry is next session
  if (lastIdx < 0) return [];
  const dates = [];
  for (let i = lastIdx; i >= 0 && dates.length < maxCheckpoints; i -= stepSessions) {
    dates.push(spyCandles[i].date);
  }
  return dates.reverse();
}

const tierForScope = (scope) => scope === 'micro' ? 'micro'
  : (scope === 'small' || scope === 'expanded') ? 'small'
  : scope === 'biotech' ? 'biotech' : 'liquid';

// Index one replay's observations by ticker (selected beats rejected on dupes).
function obsByTicker(replay) {
  const m = new Map();
  if (!replay || !replay.ok) return m;
  for (const o of replay.observations) {
    const prev = m.get(o.ticker);
    if (!prev || prev.status === 'rejected' || prev.status === 'control') m.set(o.ticker, o);
  }
  return m;
}

// Cohort feature mean/sd for the OOD check (decision-time facts of THIS checkpoint).
function cohortFeatureStats(obsMap) {
  const cols = { mom63: [], vol: [], dollarVol: [] };
  for (const o of obsMap.values()) {
    const f = o.features && o.features.factors;
    if (!f) continue;
    if (Number.isFinite(f.mom63)) cols.mom63.push(f.mom63);
    if (Number.isFinite(f.vol)) cols.vol.push(f.vol);
    if (Number.isFinite(f.dollarVol)) cols.dollarVol.push(Math.log10(Math.max(1, f.dollarVol)));
  }
  const stats = {};
  for (const [k, xs] of Object.entries(cols)) {
    if (xs.length < 10) continue;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    if (sd > 0) stats[k] = { mean, sd };
  }
  return stats;
}

function oodZFor(obs, stats) {
  if (!obs || !obs.features || !obs.features.factors) return null;
  const f = obs.features.factors;
  const feats = { mom63: f.mom63, vol: f.vol, dollarVol: Number.isFinite(f.dollarVol) ? Math.log10(Math.max(1, f.dollarVol)) : null };
  const { maxZ } = require('./forecastability').distributionShift(feats, stats);
  return maxZ;
}

// Detection trace for one symbol from a window of prior replays (oldest→newest,
// ending at the episode's checkpoint). Warning time = sessions between the first
// checkpoint that surfaced the symbol and the episode's entry session.
function buildTrace({ symbol, horizonKey, episode, replays = [], spyCandles = [] }) {
  const rankHistory = [];
  const riskVetoes = [];
  const displayHistory = [];
  let firstDetectionDate = null, firstSelectedDate = null, highestRank = null;
  for (const rp of replays) {
    const o = obsByTicker(rp).get(symbol);
    if (!o) { rankHistory.push({ date: rp.decisionDate, status: 'absent', rejectionCode: null, rank: null, score: null }); continue; }
    rankHistory.push({ date: rp.decisionDate, status: o.status, rejectionCode: o.rejectionCode, rank: o.displayRank, score: o.rankScore });
    if (CFG.DETECTION.generatedStatuses.includes(o.status)) {
      if (!firstDetectionDate) firstDetectionDate = rp.decisionDate;
      if (o.status === 'selected' && !firstSelectedDate) firstSelectedDate = rp.decisionDate;
      if (o.displayRank != null) highestRank = highestRank == null ? o.displayRank : Math.min(highestRank, o.displayRank);
    }
    if (o.rejectionCode === 'risk-off' || o.rejectionCode === 'governance' || o.rejectionCode === 'event-risk') {
      riskVetoes.push({ date: rp.decisionDate, code: o.rejectionCode });
    }
    if (o.displayed) displayHistory.push({ date: rp.decisionDate, rank: o.displayRank });
  }
  const sessionIdx = (d) => spyCandles.findIndex(b => b.date === d);
  const warningSessions = (firstDetectionDate && episode.entryDate)
    ? Math.max(0, sessionIdx(episode.entryDate) - sessionIdx(firstDetectionDate))
    : null;
  // Fraction of the final MFE already consumed at first detection: 0 = saw it
  // before the move, 1 = saw it only at the top. Approximated on the trace grid.
  let detectedBeforeMoveFrac = null;
  if (firstDetectionDate && Number.isFinite(episode.mfe) && episode.mfe > 0 && episode.entryDate) {
    detectedBeforeMoveFrac = firstDetectionDate <= episode.checkpointDate ? 0
      : Math.min(1, +(1 - (warningSessions || 0) / Math.max(1, CFG.HORIZONS[horizonKey].sessions)).toFixed(2));
  }
  return S.makeDetectionTrace({
    opportunityId: episode.opportunityId, symbol, horizon: horizonKey,
    universeEligible: rankHistory.some(r => r.status !== 'absent'),
    candidateGenerated: !!firstDetectionDate,
    firstDetectionDate, firstSelectedDate,
    rankHistory: rankHistory.slice(-CFG.SWEEP.traceCheckpoints),
    riskVetoes, alertHistory: null, displayHistory,
    earliestActionableDate: episode.entryDate || null,
    warningSessions, detectedBeforeMoveFrac, highestRankBeforeMove: highestRank,
  });
}

// Strongest pre-move evidence the pipeline COULD have seen (for the
// NO_PREMOVE_EVIDENCE call): best cohort percentile + any fired criteria across
// the trace window at/before the episode checkpoint.
function premoveEvidenceFor(symbol, replays) {
  let maxPctile = null, anyCriteria = false;
  for (const rp of replays) {
    const o = obsByTicker(rp).get(symbol);
    if (!o || o.rankScore == null) continue;
    const cohortScores = rp.observations.filter(x => x.rankScore != null).map(x => x.rankScore);
    if (cohortScores.length > 4) {
      const below = cohortScores.filter(s2 => s2 <= o.rankScore).length;
      const p = below / cohortScores.length;
      maxPctile = maxPctile == null ? p : Math.max(maxPctile, p);
    }
    if (o.status === 'selected' || o.status === 'near-miss') anyCriteria = true;
  }
  return { maxPctile: maxPctile != null ? +maxPctile.toFixed(2) : null, anyCriteria };
}

// Reconstruct ONE (scope, horizon, checkpoint): episodes for every evaluated
// symbol, traces + deterministic attribution for the significant missed winners.
// `priorReplays` are the already-computed replays for earlier checkpoints in the
// sweep (the trace window) — pass [] when unavailable; the trace degrades honestly.
function reconstructCheckpoint({
  dataset, spyCandles, sectorCandlesOf = null, decisionDate, scope = 'large',
  horizonKey = 'h21', priorReplays = [], replay = null,
} = {}) {
  const h = CFG.HORIZONS[horizonKey];
  if (!h || h.dataSupport !== 'full') return { ok: false, reason: 'unsupported-horizon' };
  const rp = replay || REPLAY.replayDate({ dataset, spyCandles, decisionDate, scope });
  if (!rp.ok) return { ok: false, reason: rp.error || 'replay-failed', decisionDate };

  const obs = obsByTicker(rp);
  const stats = cohortFeatureStats(obs);
  const tier = tierForScope(scope);
  const rows = [];
  const episodes = [];
  let truncated = false;

  for (const [ticker, v] of dataset) {
    if (episodes.length >= CFG.SWEEP.maxEpisodesPerDay) { truncated = true; break; }
    const label = L.pathLabel({
      candles: v.candles, decisionDate, horizonKey,
      spyCandles, sectorCandles: sectorCandlesOf ? sectorCandlesOf(ticker) : null, tier,
    });
    if (!label.ok || label.outcome === 'no-fill' || label.outcome === 'pending') {
      if (label.ok && label.outcome === 'pending') continue;      // not matured — later sweep
      if (label.ok) rows.push({ symbol: ticker, excessReturn: null, gapClass: 'unavailable', outcome: label.outcome });
      continue;
    }
    const o = obs.get(ticker);
    const dollarVol = o && o.features && o.features.factors ? o.features.factors.dollarVol : null;
    rows.push({ symbol: ticker, excessReturn: label.excessReturn, dollarVol, gapClass: label.gap ? label.gap.class : null, outcome: label.outcome });
    episodes.push({ ticker, label, obsRow: o || null, dollarVol });
  }

  const cs = L.crossSectionLabels(rows);
  const csBySymbol = new Map(cs.map(r => [r.symbol, r]));

  const built = episodes.map(({ ticker, label, obsRow, dollarVol }) => {
    const crossSection = csBySymbol.get(ticker) || null;
    const episode = S.makeOpportunityEpisode({
      symbol: ticker, checkpointDate: decisionDate, horizon: horizonKey,
      label, crossSection, liquidity: dollarVol ?? null, universeScope: scope,
      dataQuality: { survivorshipSafe: false, adjustmentBasis: 'as-of-fetch', macroPIT: false },
    });
    return { episode, obsRow };
  });

  // Significant opportunity = big vol-adjusted move OR cross-sectional top winner.
  const isOpportunity = (e) => e.episode.bigMove
    || (e.episode.crossSection && (e.episode.crossSection.topPercentile || e.episode.crossSection.largestLiquidWinner));
  const missed = [];
  const traceWindow = [...priorReplays, rp];
  for (const e of built) {
    if (!isOpportunity(e)) continue;
    const wasSelected = e.obsRow && e.obsRow.status === 'selected';
    if (wasSelected) continue;                                    // captured, not missed
    if (missed.length >= CFG.SWEEP.maxMissedPerDay) { truncated = true; break; }
    const trace = buildTrace({ symbol: e.episode.symbol, horizonKey, episode: e.episode, replays: traceWindow, spyCandles });
    const attribution = T.attributeMiss({
      inUniverse: true,                                           // it was in the dataset — absence is handled upstream
      insufficientHistory: false,
      rejectionCode: e.obsRow ? e.obsRow.rejectionCode : null,
      trace, episode: e.episode,
      oodZ: oodZFor(e.obsRow, stats),
      premoveEvidence: premoveEvidenceFor(e.episode.symbol, traceWindow),
      alertLayerExists: false,                                    // the swing screener has no alert layer (audit gap #7)
    });
    missed.push({
      episode: e.episode, trace,
      attribution: S.makeFailureAttribution({ opportunityId: e.episode.opportunityId, ...attribution }),
    });
  }

  return {
    ok: true, version: CFG.CFL_VERSION, labelVersion: CFG.LABEL_VERSION,
    scope, horizon: horizonKey, decisionDate,
    replaySummary: {
      candidateSetHash: rp.candidateSetHash, counts: rp.counts,
      rejectionCounts: rp.rejectionCounts, regime: rp.regime,
      engineVersion: rp.engineVersion,
    },
    episodes: built.map(e => e.episode),
    opportunities: built.filter(isOpportunity).length,
    captured: built.filter(e => isOpportunity(e) && e.obsRow && e.obsRow.status === 'selected').length,
    missed, truncated,
    dataQuality: { survivorshipSafe: false, adjustmentBasis: 'as-of-fetch', macroPIT: false },
  };
}

// Sweep symbols OUTSIDE the scope's universe (e.g. the expanded market minus the
// curated large list) for significant moves the scope could never have seen —
// the UNIVERSE_EXCLUSION false negatives. Bounded by `cap`; truncation reported.
function scanOutOfUniverse({ outsideDataset, spyCandles, decisionDate, horizonKey = 'h21', cap = 25 } = {}) {
  const h = CFG.HORIZONS[horizonKey];
  if (!h || h.dataSupport !== 'full') return { ok: false, reason: 'unsupported-horizon' };
  const missed = [];
  let scanned = 0, truncated = false;
  for (const [ticker, v] of outsideDataset) {
    scanned++;
    const label = L.pathLabel({ candles: v.candles, decisionDate, horizonKey, spyCandles });
    if (!label.ok || label.outcome === 'no-fill' || label.outcome === 'pending' || !label.bigMove) continue;
    if (missed.length >= cap) { truncated = true; break; }
    const episode = S.makeOpportunityEpisode({
      symbol: ticker, checkpointDate: decisionDate, horizon: horizonKey, label,
      universeScope: 'out-of-scope',
      dataQuality: { survivorshipSafe: false, adjustmentBasis: 'as-of-fetch', macroPIT: false },
    });
    const attribution = T.attributeMiss({ inUniverse: false, episode });
    missed.push({ episode, trace: null, attribution: S.makeFailureAttribution({ opportunityId: episode.opportunityId, ...attribution }) });
  }
  return { ok: true, decisionDate, horizon: horizonKey, scanned, missed, truncated };
}

module.exports = { buildCheckpoints, reconstructCheckpoint, scanOutOfUniverse, buildTrace, premoveEvidenceFor, cohortFeatureStats, obsByTicker };

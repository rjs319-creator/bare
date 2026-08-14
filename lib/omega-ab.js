'use strict';
// OMEGA R10-vs-SCORE PROSPECTIVE SHADOW A/B — pure core (no I/O, no network, no clock).
//
// Motivation (research/90 + research/91, both registered): retrospectively, ordering the
// options-liquid cohort by plain r10 beat ordering by the production OMEGA score, whose
// exhaustion penalty demotes winners and whose components carry no ranking signal. That
// evidence is retrospective on present-day universes, so it authorizes NOTHING — this A/B
// accumulates the PROSPECTIVE evidence a scorer change would actually require.
//
// Contract: each session close, BOTH orderings of the SAME frozen 62-name cohort are
// stamped before any outcome exists (write-once); outcomes resolve after 5 sessions and
// only fill outcome fields — decisions are never rewritten. The verdict can never leave
// INSUFFICIENT_DATA before 100 resolved prospective dates.
//
// SHADOW / weight-0: nothing here reads from or writes into live OMEGA scoring, ranking,
// alerts, recommendations or portfolio construction.

const OMEGA_AB_VERSION = 'omega-ab-v1';
const EXPERIMENT_ID = 'OMEGA_R10_VS_SCORE_5D_TOP10';

const FROZEN = Object.freeze({
  topK: 10,
  horizonSessions: 5,
  minRows: 20,                       // a decision day needs a real cross-section
  resolveAfterCalendarDays: 9,       // >= 5 sessions before resolution is attempted
  // A row never flips terminal UNRESOLVABLE off ONE night's bad fetch (audit
  // 2026-08-14): it stays PENDING with an `attempts` counter and only becomes
  // UNRESOLVABLE after this many failed attempts on different runs.
  maxResolveAttempts: 3,
  gate: Object.freeze({ minResolvedDates: 100, blocks: 4, minPositiveBlocks: 3 }),
  bootstrap: Object.freeze({ B: 5000, blockLen: 4, seed: 20260814 }),
});

const VERDICTS = Object.freeze(['INSUFFICIENT_DATA', 'NO_INCREMENTAL_ALPHA', 'SHADOW_CANDIDATE', 'PROMOTION_REVIEW_REQUIRED']);

const mean = (a) => (a.length ? a.reduce((x, v) => x + v, 0) / a.length : null);

// Deterministic ranking with a ticker tiebreak — identical convention to the
// retrospective chain (lib/research/si-experiment.topK).
function rankBy(rows, pick) {
  return rows
    .map((r) => ({ r, s: pick(r) }))
    .filter((x) => Number.isFinite(x.s))
    .sort((a, b) => (b.s - a.s) || a.r.ticker.localeCompare(b.r.ticker))
    .map((x, i) => ({ ticker: x.r.ticker, rank: i + 1 }));
}

// ── Decision doc (stamped BEFORE outcomes exist) ────────────────────────────
// rows: [{ ticker, lastBarDate, score, r10, dollarVol, costPct }]
function buildDecisionDoc({ date, rows, createdAt }) {
  if (!date || !Array.isArray(rows)) return null;
  const clean = rows.filter((r) => r && r.ticker && r.lastBarDate === date
    && Number.isFinite(r.score) && Number.isFinite(r.r10) && Number.isFinite(r.costPct));
  if (clean.length < FROZEN.minRows) return null;
  const scoreRanks = new Map(rankBy(clean, (r) => r.score).map((x) => [x.ticker, x.rank]));
  const r10Ranks = new Map(rankBy(clean, (r) => r.r10).map((x) => [x.ticker, x.rank]));
  const docRows = clean
    .map((r) => ({
      ticker: r.ticker, lastBarDate: r.lastBarDate,
      score: r.score, r10: r.r10, dollarVol: r.dollarVol ?? null,
      scoreRank: scoreRanks.get(r.ticker) ?? null, r10Rank: r10Ranks.get(r.ticker) ?? null,
      selectedScore: (scoreRanks.get(r.ticker) ?? Infinity) <= FROZEN.topK,
      selectedR10: (r10Ranks.get(r.ticker) ?? Infinity) <= FROZEN.topK,
      cost: r.costPct,
      entryDate: null, entryOpen: null, exitDate: null, exitClose: null,
      rawReturn: null, benchmarkReturn: null, residualReturn: null, netResidualReturn: null,
      outcomeStatus: 'PENDING', attempts: 0,
    }))
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
  return {
    experimentId: EXPERIMENT_ID, version: OMEGA_AB_VERSION,
    decisionDate: date, decisionTime: `${date} session close (US/Eastern)`,
    createdAt: createdAt || null, provenance: 'prospective_frozen_shadow',
    evaluated: docRows.length,
    armScoreTop: docRows.filter((r) => r.selectedScore).map((r) => r.ticker),
    armR10Top: docRows.filter((r) => r.selectedR10).map((r) => r.ticker),
    rows: docRows, resolved: false,
  };
}

// ── Resolution (fills outcome fields ONLY — decisions are immutable) ────────
// histories: Map(ticker -> ascending candles). spy: ascending candles.
// Returns { doc, pending } — doc.resolved flips true only when NO row is left pending.
function resolveDecisionDoc(doc, { histories, spy, resolvedAt = null }) {
  if (!doc || doc.resolved) return { doc, pending: 0 };
  const H = FROZEN.horizonSessions;
  const spyIdx = new Map((spy || []).map((b, i) => [b.date, i]));
  const si = spyIdx.get(doc.decisionDate);
  if (si == null || si + H > (spy || []).length - 1) return { doc, pending: doc.rows.length };
  const eS = spy[si + 1], xS = spy[si + H];
  if (!eS || !(eS.open > 0) || !xS || !(xS.close > 0)) return { doc, pending: doc.rows.length };
  const bench = (xS.close / eS.open - 1) * 100;
  let pending = 0;
  const rows = doc.rows.map((r) => {
    if (r.outcomeStatus === 'RESOLVED' || r.outcomeStatus === 'UNRESOLVABLE') return r;
    // One failed attempt is retryable (tonight's truncated fetch may serve the bar
    // fine tomorrow); only a run's-worth of repeated failures is terminal. Waiting
    // states (missing history / not matured) do NOT burn the attempts budget.
    const failedAttempt = () => {
      const attempts = (r.attempts || 0) + 1;
      if (attempts >= FROZEN.maxResolveAttempts) return { ...r, attempts, outcomeStatus: 'UNRESOLVABLE' };
      pending++;
      return { ...r, attempts, outcomeStatus: 'PENDING' };
    };
    const candles = histories.get(r.ticker);
    if (!candles) { pending++; return r; }
    const idx = new Map(candles.map((b, i) => [b.date, i]));
    const i = idx.get(doc.decisionDate);
    if (i == null) return failedAttempt();                               // series lost the decision bar
    if (i + H > candles.length - 1) { pending++; return r; }             // not matured in this series yet
    const e = candles[i + 1], x = candles[i + H];
    if (!e || !(e.open > 0) || !x || !(x.close > 0)) return failedAttempt();
    const raw = (x.close / e.open - 1) * 100;
    const residual = raw - bench;
    return {
      ...r,
      entryDate: e.date, entryOpen: e.open, exitDate: x.date, exitClose: x.close,
      rawReturn: +raw.toFixed(4), benchmarkReturn: +bench.toFixed(4),
      residualReturn: +residual.toFixed(4), netResidualReturn: +(residual - r.cost).toFixed(4),
      outcomeStatus: 'RESOLVED',
    };
  });
  const allSettled = rows.every((r) => r.outcomeStatus !== 'PENDING');
  return {
    doc: { ...doc, rows, resolved: allSettled, ...(allSettled ? { resolvedAt } : {}) },
    pending,
  };
}

// Per-date arm returns from a fully resolved doc → one summary-series point.
function seriesPoint(doc) {
  if (!doc || !doc.resolved) return null;
  const arm = (sel) => {
    const nets = doc.rows.filter((r) => r[sel] && r.outcomeStatus === 'RESOLVED').map((r) => r.netResidualReturn);
    return nets.length ? +mean(nets).toFixed(4) : null;
  };
  const a = arm('selectedScore'), b = arm('selectedR10');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { date: doc.decisionDate, scoreArm: a, r10Arm: b, diff: +(b - a).toFixed(4) };
}

// ── Verdict over the accumulated prospective series ─────────────────────────
// Seeded moving-block bootstrap (same construction as the retrospective chain).
function bootstrapCI(series, { B, blockLen, seed } = FROZEN.bootstrap) {
  const xs = series.filter(Number.isFinite);
  const n = xs.length;
  if (n < blockLen + 4) return null;
  let state = seed >>> 0;
  const rnd = () => { state = (1664525 * state + 1013904223) >>> 0; return state / 2 ** 32; };
  const nBlocks = n - blockLen + 1;
  const stats = new Array(B);
  for (let b = 0; b < B; b++) {
    let sum = 0, count = 0;
    while (count < n) {
      const start = Math.floor(rnd() * nBlocks);
      for (let j = 0; j < blockLen && count < n; j++, count++) sum += xs[start + j];
    }
    stats[b] = sum / n;
  }
  stats.sort((a, b) => a - b);
  const q = (f) => stats[Math.min(B - 1, Math.floor(f * B))];
  return { lo: +q(0.025).toFixed(4), hi: +q(0.975).toFixed(4), B, blockLen, seed };
}

function assessAb(points) {
  const series = (points || []).map((p) => p.diff).filter(Number.isFinite);
  const n = series.length;
  const g = FROZEN.gate;
  const summary = {
    resolvedDates: n,
    scoreArmMeanPct: n ? +mean(points.map((p) => p.scoreArm)).toFixed(4) : null,
    r10ArmMeanPct: n ? +mean(points.map((p) => p.r10Arm)).toFixed(4) : null,
    diffMeanPct: n ? +mean(series).toFixed(4) : null,
    diffCi95: bootstrapCI(series),
    blocks: null, positiveBlocks: null,
  };
  if (n >= g.blocks) {
    const size = Math.floor(n / g.blocks);
    const blocks = Array.from({ length: g.blocks }, (_, i) =>
      +mean(series.slice(i * size, i === g.blocks - 1 ? n : (i + 1) * size)).toFixed(4));
    summary.blocks = blocks;
    summary.positiveBlocks = blocks.filter((b) => b > 0).length;
  }
  // The prospective gate: the verdict can NEVER leave INSUFFICIENT_DATA early.
  if (n < g.minResolvedDates) {
    return { ...summary, verdict: 'INSUFFICIENT_DATA', verdictReasons: [`resolved prospective dates ${n} < ${g.minResolvedDates}`] };
  }
  const reasons = [];
  if (!(summary.diffMeanPct > 0)) reasons.push(`r10-minus-score mean ${summary.diffMeanPct} not positive`);
  if (!summary.diffCi95 || !(summary.diffCi95.lo > 0)) reasons.push('bootstrap 95% interval not entirely above zero');
  if (!(summary.positiveBlocks >= g.minPositiveBlocks)) reasons.push(`positive blocks ${summary.positiveBlocks} < ${g.minPositiveBlocks}`);
  return reasons.length
    ? { ...summary, verdict: 'NO_INCREMENTAL_ALPHA', verdictReasons: reasons }
    : { ...summary, verdict: 'PROMOTION_REVIEW_REQUIRED', verdictReasons: [] };
}

// ── Forming-bar guard (audit 2026-08-14) ────────────────────────────────────
// A decision may only be keyed on a COMPLETED session bar: the bar's date must be
// strictly before the current America/New_York calendar date, or equal to it with NY
// time >= 16:05 (regular close + settle). Before this, only cron timing (22:00 UTC)
// kept a manual/misfired tick from stamping a forming intraday bar as the immutable
// decision of record. Pure given `now` — the clock default is the caller convenience,
// tests always pass an explicit instant. ET arithmetic reuses lib/market-session's
// DST-correct primitives.
const SESSION_COMPLETE_MIN = 16 * 60 + 5;   // 16:05 ET
function isCompletedSessionBar(barDate, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(barDate || ''))) return false;
  const { date, minutes } = require('./market-session').etParts(now);
  if (barDate < date) return true;           // a prior session is complete by definition
  if (barDate > date) return false;          // a future-dated bar is never acceptable
  return minutes >= SESSION_COMPLETE_MIN;    // same date: only after the close settles
}

module.exports = {
  OMEGA_AB_VERSION, EXPERIMENT_ID, FROZEN, VERDICTS,
  rankBy, buildDecisionDoc, resolveDecisionDoc, seriesPoint, bootstrapCI, assessAb,
  isCompletedSessionBar,
};

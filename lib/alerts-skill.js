'use strict';
// ACCOUNT SKILL MODEL — hierarchical, partially pooled, deflated for multiple testing.
//
// Replaces the single {hits,total} record. A context-specific rate (side × horizon × setup)
// shrinks toward the account's global rate, which shrinks toward a conservative population
// prior (empirical-Bayes, reusing lib/evolve.pooledRate). Tiny samples stay near the prior,
// so a 3-for-3 fluke can't earn a big weight.
//
// Evidence STATE is gated by INDEPENDENT episode counts and distinct decision DATES (not raw
// post count), cost-adjusted net expectancy, and recent-vs-long drift. Because we test many
// accounts at once, the confidence bound used for promotion is DEFLATED by the number of
// accounts under test — the luckiest of many is not crowned "supported".
//
// Skill can only ever ADD, never rescue: unknown/unproven accounts get zero track-record
// bonus, and the whole account contribution is hard-capped (see MAX_ACCOUNT_POINTS).
//
// Pure. Consumes graded episode outcomes; produces per-account skill records + a lookup.

const { pooledRate } = require('./evolve');
const { wilson } = require('./stats');

const STATES = { UNKNOWN: 'UNKNOWN', PROVISIONAL: 'PROVISIONAL', SUPPORTED: 'SUPPORTED', PROVEN: 'PROVEN', DEGRADING: 'DEGRADING', REJECTED: 'REJECTED' };

// Episode-count FLOORS (not automatic promotions — net evidence must also hold).
const N_PROVISIONAL = 30;
const N_SUPPORTED = 75;
const N_PROVEN = 150;
const MIN_DATES_SUPPORTED = 20;    // distinct independent decision dates
const PROVEN_MIN_MONTHS = 6;
const RECENT_WINDOW = 40;          // most-recent episodes considered "recent" for drift

// The HARD CAP on how much account history can move the final actionable score (points out
// of 100). The complete social layer must never dominate price/catalyst/regime/execution.
const MAX_ACCOUNT_POINTS = 22;

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function trimmedMean(a, frac = 0.1) { if (a.length < 3) return mean(a); const s = [...a].sort((x, y) => x - y), k = Math.floor(s.length * frac); return mean(s.slice(k, s.length - k)); }
function percentile(a, p) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const i = Math.max(0, Math.min(s.length - 1, Math.floor(p * (s.length - 1)))); return s[i]; }
function maxDrawdown(seq) { let peak = 0, cum = 0, mdd = 0; for (const x of seq) { cum += x; peak = Math.max(peak, cum); mdd = Math.min(mdd, cum - peak); } return mdd; }
const monthsSpan = dates => { if (dates.length < 2) return 0; const s = dates.slice().sort(); return (Date.parse(s[s.length - 1]) - Date.parse(s[0])) / (30.44 * 86400000); };

// Deflated Wilson lower bound: widen z by the multiple-testing count so the best-of-many
// account must clear breakeven with a stiffer bar. z0=1.645 (90%), scaled by √(2·ln(K)).
function deflatedLowerBound(wins, n, nAccounts) {
  if (!n) return 0;
  const z = 1.645 * Math.max(1, Math.sqrt(2 * Math.log(Math.max(2, nAccounts))) / Math.sqrt(2 * Math.log(2)));
  return wilson(wins, n, z).lo;
}

/**
 * Compute per-account skill from graded episode outcomes.
 * @param {Array} graded  each: { accountKey, identityKnown, date, side, horizon, setupClass,
 *                                 excess (cost-adjusted %, the win metric), mfe, mae, rMultiple }
 * @param {object} opts   { priorP }
 * @returns {{ byAccount: object, accounts: object[], nAccounts:number, populationPrior:number }}
 */
function buildSkillModel(graded, { priorP = null } = {}) {
  const rows = (graded || []).filter(g => g && g.identityKnown && g.accountKey && Number.isFinite(g.excess));
  // Population prior: the pooled hit rate across ALL known accounts (conservative fallback 0.45).
  const popWins = rows.filter(r => r.excess > 0).length;
  const popRate = rows.length ? popWins / rows.length : 0.45;
  const prior = priorP != null ? priorP : Math.min(0.5, Math.max(0.35, popRate));

  const byAcct = new Map();
  for (const r of rows) {
    const a = byAcct.get(r.accountKey) || { accountKey: r.accountKey, eps: [] };
    a.eps.push(r);
    byAcct.set(r.accountKey, a);
  }
  const nAccounts = byAcct.size;

  const accounts = [];
  const byAccount = {};
  for (const [key, a] of byAcct) {
    const eps = a.eps;
    const excess = eps.map(e => e.excess);
    const dates = [...new Set(eps.map(e => e.date))];
    const n = eps.length, indepDates = dates.length;
    const wins = excess.filter(x => x > 0);
    const losses = excess.filter(x => x <= 0);
    const globalWins = wins.length;

    // Per-context {wins,n} keyed by side|horizon|setup. Context rate shrinks toward global.
    const ctxMap = {};
    for (const e of eps) {
      const ck = `${e.side || '?'}|${e.horizon || '?'}|${e.setupClass || '?'}`;
      const c = ctxMap[ck] || (ctxMap[ck] = { wins: 0, n: 0 });
      c.n++; if (e.excess > 0) c.wins++;
    }
    const contexts = {};
    for (const [ck, c] of Object.entries(ctxMap)) {
      const pooled = pooledRate({ ctxWins: c.wins, ctxN: c.n, globalWins, globalN: n, priorP: prior });
      contexts[ck] = { n: c.n, hitRate: +(100 * c.wins / c.n).toFixed(1), pooledRate: pooled.rate, effN: pooled.effN };
    }

    // Global cost-adjusted stats. Independent-date Wilson CI (not row-inflated).
    const dateWins = dates.filter(d => {
      const de = eps.filter(e => e.date === d); return mean(de.map(e => e.excess)) > 0;   // date is a "win" if its mean excess > 0
    }).length;
    const { lo: ciLo, hi: ciHi } = wilson(dateWins, indepDates);
    const deflatedLo = deflatedLowerBound(dateWins, indepDates, nAccounts);
    const meanExcess = +mean(excess).toFixed(3);
    const rMultiples = eps.map(e => e.rMultiple).filter(Number.isFinite);
    const recent = excess.slice(-RECENT_WINDOW), long = excess;
    const recentMean = +mean(recent).toFixed(3), longMean = +mean(long).toFixed(3);
    const profitFactor = losses.length ? +(wins.reduce((s, x) => s + x, 0) / Math.abs(losses.reduce((s, x) => s + x, 0) || 1e-9)).toFixed(2) : null;

    // Drift: recent independent-date window clearly below the long-run and below breakeven.
    const drifting = n >= N_SUPPORTED && recentMean < 0 && recentMean < longMean - 0.5;

    const stats = {
      accountKey: key,
      n, independentDates: indepDates, monthsSpan: +monthsSpan(dates).toFixed(1),
      hitRatePct: +(100 * globalWins / n).toFixed(1),
      dateHitRatePct: +(100 * dateWins / indepDates).toFixed(1),
      meanExcess, medianExcess: +median(excess).toFixed(3), trimmedMeanExcess: +trimmedMean(excess).toFixed(3),
      avgWin: wins.length ? +mean(wins).toFixed(3) : null,
      avgLoss: losses.length ? +mean(losses).toFixed(3) : null,
      profitFactor,
      avgMFE: +mean(eps.map(e => e.mfe).filter(Number.isFinite)).toFixed(2) || null,
      avgMAE: +mean(eps.map(e => e.mae).filter(Number.isFinite)).toFixed(2) || null,
      tailLoss: +percentile(excess, 0.05).toFixed(3),
      maxDrawdown: +maxDrawdown(excess).toFixed(3),
      netR: rMultiples.length ? +mean(rMultiples).toFixed(3) : null,
      recentMeanExcess: recentMean, longMeanExcess: longMean,
      ci90: [+(100 * ciLo).toFixed(1), +(100 * ciHi).toFixed(1)],
      deflatedLB90: +(100 * deflatedLo).toFixed(1),
      contexts,
    };

    const state = classifyState(stats, prior);
    const skillWeight = weightFor(state, stats, prior);
    const rec = { ...stats, state, skillWeight: +skillWeight.toFixed(3), accountPoints: +(skillWeight * MAX_ACCOUNT_POINTS).toFixed(1), weightReason: weightReason(state, stats) };
    byAccount[key] = rec;
    accounts.push(rec);
  }

  accounts.sort((a, b) => (b.deflatedLB90 - a.deflatedLB90) || (b.n - a.n));
  return { byAccount, accounts, nAccounts, populationPrior: +prior.toFixed(3) };
}

// Evidence-state classification. Floors are necessary, not sufficient — net evidence and
// the DEFLATED lower bound must also hold. Breakeven for cost-adjusted excess is 0% (→ 50%
// of independent dates positive).
function classifyState(s, prior) {
  const breakeven = 50;   // % of independent dates with positive mean excess
  if (s.n < N_PROVISIONAL) return STATES.UNKNOWN;
  // Persistent negative net evidence with a real sample ⇒ rejected.
  if (s.n >= N_SUPPORTED && s.meanExcess < 0 && s.ci90[1] < breakeven) return STATES.REJECTED;
  if (s.n < N_SUPPORTED) return s.meanExcess > 0 ? STATES.PROVISIONAL : STATES.PROVISIONAL;
  // ≥ SUPPORTED floor:
  const netPositive = s.meanExcess > 0 && s.deflatedLB90 > breakeven && s.independentDates >= MIN_DATES_SUPPORTED;
  if (!netPositive) return s.recentMeanExcess < 0 && s.longMeanExcess > 0 ? STATES.DEGRADING : STATES.PROVISIONAL;
  // Drift check demotes a once-supported account.
  if (s.recentMeanExcess < 0 && s.recentMeanExcess < s.longMeanExcess - 0.5) return STATES.DEGRADING;
  const regimeBreadth = Object.keys(s.contexts).length;
  if (s.n >= N_PROVEN && s.monthsSpan >= PROVEN_MIN_MONTHS && s.deflatedLB90 > breakeven && regimeBreadth >= 2) return STATES.PROVEN;
  return STATES.SUPPORTED;
}

// Track-record weight in [0,1]. UNKNOWN/REJECTED = 0 (no bonus, ever). Others scale with the
// deflated lower bound above breakeven, so a barely-positive account earns very little.
function weightFor(state, s) {
  if (state === STATES.UNKNOWN || state === STATES.REJECTED) return 0;
  const edge = Math.max(0, (s.deflatedLB90 - 50) / 25);   // 0 at breakeven, 1 at +25pts of deflated LB
  const base = { PROVISIONAL: 0.30, SUPPORTED: 0.70, PROVEN: 1.0, DEGRADING: 0.25 }[state] || 0;
  return Math.max(0, Math.min(base, base * (0.4 + 0.6 * Math.min(1, edge))));
}

function weightReason(state, s) {
  if (state === STATES.UNKNOWN) return `No track-record bonus — only ${s.n}/${N_PROVISIONAL} independent episodes.`;
  if (state === STATES.REJECTED) return `Zero weight — persistent negative net evidence (mean ${s.meanExcess}%, n=${s.n}).`;
  if (state === STATES.DEGRADING) return `Reduced weight — recent evidence deteriorated (recent ${s.recentMeanExcess}% vs long ${s.longMeanExcess}%).`;
  if (state === STATES.PROVISIONAL) return `Small weight — encouraging but uncertain (${s.n} episodes, deflated LB ${s.deflatedLB90}%).`;
  if (state === STATES.SUPPORTED) return `Normal weight — positive net over ${s.independentDates} dates, deflated LB ${s.deflatedLB90}%.`;
  if (state === STATES.PROVEN) return `Full weight — ${s.n} episodes over ${s.monthsSpan}mo, multi-context, deflated LB ${s.deflatedLB90}%.`;
  return '';
}

// Cold-start / lookup: an account with no known record returns UNKNOWN, weight 0.
function skillFor(model, accountKey) {
  const rec = model && model.byAccount && model.byAccount[accountKey];
  if (!rec) return { state: STATES.UNKNOWN, skillWeight: 0, accountPoints: 0, n: 0, weightReason: 'No record yet — cold start (no track-record bonus).' };
  return rec;
}

module.exports = {
  STATES, N_PROVISIONAL, N_SUPPORTED, N_PROVEN, MAX_ACCOUNT_POINTS,
  buildSkillModel, classifyState, weightFor, skillFor, deflatedLowerBound,
};

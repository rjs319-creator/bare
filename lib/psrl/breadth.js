'use strict';
// ═══════════════════════════════════════════════════════════════════════════
// PSRL addendum — sector breadth, within-sector leadership structure, and a
// graded market state. PURE: computed from the already-built cards + SPY bars.
//
// Sector labels are current-vendor (NOT point-in-time) — every consumer of
// these states inherits that disclosure. ISOLATED_LEADER is a NEUTRAL
// classification: whether isolation helps or hurts is a registered research
// question, not an assumption.
// ═══════════════════════════════════════════════════════════════════════════

const BREADTH_VERSION = 'psrl-breadth-v1';
const MIN_SECTOR_NAMES = 5;

const MARKET_STATES = Object.freeze(['BULL', 'CORRECTION', 'BEAR', 'REBOUND', 'PANIC_REVERSAL_RISK', 'UNCERTAIN']);
const SECTOR_STOCK_STATES = Object.freeze([
  'LEADER_IN_STRENGTHENING_SECTOR', 'LEADER_IN_WEAK_SECTOR', 'SECTOR_PASSENGER',
  'MARKET_PASSENGER', 'ISOLATED_LEADER', 'LOSING_SECTOR_RANK', 'EMERGING_SECTOR_LEADER',
]);

const isNum = (x) => Number.isFinite(x);
const median = (a) => {
  const v = a.filter(isNum).sort((x, y) => x - y);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const frac = (a, pred) => {
  const v = a.filter((x) => x != null);
  return v.length ? v.filter(pred).length / v.length : null;
};

/** Graded market state from SPY bars (never a green/red binary). */
function marketState(spyBars) {
  const cl = (spyBars || []).map((b) => b.close ?? b.c).filter((x) => x > 0);
  if (cl.length < 70) return { state: 'UNCERTAIN', version: BREADTH_VERSION, reason: 'insufficient-history' };
  const last = cl[cl.length - 1];
  const hi252 = Math.max(...cl.slice(-252));
  const dd = last / hi252 - 1;
  const r21 = cl[cl.length - 22] > 0 ? last / cl[cl.length - 22] - 1 : null;
  const r10 = cl[cl.length - 11] > 0 ? last / cl[cl.length - 11] - 1 : null;
  const rets = [];
  for (let i = cl.length - 21; i < cl.length; i++) rets.push(cl[i] / cl[i - 1] - 1);
  const vol = Math.sqrt(rets.reduce((s, r) => s + r * r, 0) / rets.length);
  let state = 'UNCERTAIN';
  const reasons = [];
  if (dd <= -0.2) { state = r10 > 0.04 ? 'REBOUND' : 'BEAR'; reasons.push(`drawdown ${(dd * 100).toFixed(1)}%`); }
  else if (dd <= -0.1) {
    state = vol > 0.025 && r10 < -0.03 ? 'PANIC_REVERSAL_RISK' : (r10 > 0.03 ? 'REBOUND' : 'CORRECTION');
    reasons.push(`drawdown ${(dd * 100).toFixed(1)}%`);
  } else if (dd > -0.05 && r21 != null && r21 > -0.02) { state = 'BULL'; }
  else { state = 'CORRECTION'; }
  if (vol > 0.03 && state === 'BULL') { state = 'UNCERTAIN'; reasons.push('elevated volatility inside an uptrend'); }
  return { version: BREADTH_VERSION, state, drawdownFrom252High: dd, ret21: r21, ret10: r10, vol21: vol, reasons };
}

/** Per-sector breadth vector from the scored cards (prev = prior snapshot's breadth for acceleration). */
function sectorBreadth(cards, { prev = null } = {}) {
  const bySector = {};
  for (const c of cards || []) {
    if (!c.sector || !c.available) continue;
    (bySector[c.sector] = bySector[c.sector] || []).push(c);
  }
  const out = {};
  for (const [sector, members] of Object.entries(bySector)) {
    if (members.length < MIN_SECTOR_NAMES) {
      out[sector] = { available: false, names: members.length, reason: `fewer than ${MIN_SECTOR_NAMES} scored names` };
      continue;
    }
    const dist = (n) => members.map((c) => c.trend?.sma?.byN?.[n]?.dist);
    const ret21 = members.map((c) => c.trend?.byHorizon?.[21]?.totalReturn);
    const resid21 = members.map((c) => c.residual?.byHorizon?.[21]?.residual);
    const dFromHigh = members.map((c) => c.trend?.byHorizon?.[63]?.distFromHigh);
    const newHighs = dFromHigh.filter((d) => isNum(d) && d > -0.01).length;
    const newLows = dFromHigh.filter((d) => isNum(d) && d < -0.25).length;
    const r = ret21.filter(isNum);
    const m = r.length ? r.reduce((s, x) => s + x, 0) / r.length : null;
    const disp = r.length > 2 ? Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1)) : null;
    const cur = {
      available: true, names: members.length,
      pctAboveSma20: frac(dist(20), (d) => d > 0),
      pctAboveSma50: frac(dist(50), (d) => d > 0),
      pctAboveSma200: frac(dist(200), (d) => d > 0),
      pctPositive21: frac(ret21, (x) => x > 0),
      pctPositiveResidual21: frac(resid21, (x) => x > 0),
      newHighLowRatio: newLows > 0 ? newHighs / newLows : (newHighs > 0 ? Infinity : null),
      medianReturn21: median(ret21),
      medianResidual21: median(resid21),
      returnDispersion21: disp,
    };
    const prevSec = prev?.[sector];
    cur.breadthAccel = prevSec?.available && isNum(prevSec.pctAboveSma20) && isNum(cur.pctAboveSma20)
      ? cur.pctAboveSma20 - prevSec.pctAboveSma20 : null;
    cur.strengthening = isNum(cur.breadthAccel) ? cur.breadthAccel > 0.02
      : (isNum(cur.pctAboveSma20) ? cur.pctAboveSma20 >= 0.6 : null);
    out[sector] = cur;
  }
  return { version: BREADTH_VERSION, sectors: out, sectorBasis: 'current-vendor classification — NOT point-in-time' };
}

/** Within-sector leadership state for one card. */
function sectorStockState(card, breadth, { prevPercentile = null } = {}) {
  const sec = card.sector ? breadth?.sectors?.[card.sector] : null;
  if (!sec?.available) {
    return { available: false, reason: card.sector ? 'sector-breadth-unavailable' : 'no-sector-mapping', state: null };
  }
  const isLeader = card.quadrant === 'TRUE_LEADER';
  const residUp = isNum(card.residual?.byHorizon?.[21]?.residual) && card.residual.byHorizon[21].residual > 0;
  const secStrong = sec.strengthening === true || (isNum(sec.pctAboveSma50) && sec.pctAboveSma50 >= 0.6);
  const secWeak = (isNum(sec.pctAboveSma50) && sec.pctAboveSma50 <= 0.35) || sec.strengthening === false && isNum(sec.breadthAccel) && sec.breadthAccel < -0.05;
  const pctile = card.sectorPercentile;
  const losingRank = isNum(prevPercentile) && isNum(pctile) && pctile < prevPercentile - 0.15;
  const isolated = isLeader && isNum(sec.pctPositiveResidual21) && sec.pctPositiveResidual21 < 0.35;

  let state;
  if (losingRank) state = 'LOSING_SECTOR_RANK';
  else if (isLeader && isolated) state = 'ISOLATED_LEADER';
  else if (isLeader && secStrong) state = 'LEADER_IN_STRENGTHENING_SECTOR';
  else if (isLeader && secWeak) state = 'LEADER_IN_WEAK_SECTOR';
  else if (!isLeader && residUp && secStrong && isNum(pctile) && pctile >= 0.6) state = 'EMERGING_SECTOR_LEADER';
  else if (!residUp && card.quadrant === 'MARKET_CARRIED_LAGGARD') state = 'MARKET_PASSENGER';
  else if (!residUp && isNum(card.residual?.byHorizon?.[21]?.sectorRel) && Math.abs(card.residual.byHorizon[21].sectorRel) < 0.01) state = 'SECTOR_PASSENGER';
  else state = null;
  return {
    available: true, state,
    isolatedLeadershipNote: isolated ? 'isolation is a registered research question, not a scored positive or negative' : null,
  };
}

/** Annotate ranked cards with within-sector percentiles + states (pure, returns new array). */
function annotateSectorStructure(cards, { spyBars, prevBreadth = null, prevCards = null } = {}) {
  const breadth = sectorBreadth(cards, { prev: prevBreadth?.sectors || null });
  const market = marketState(spyBars);
  const prevPct = new Map((prevCards || []).map((c) => [c.ticker, c.sectorPercentile]));
  const bySector = {};
  for (const c of cards) if (c.sector && c.available) (bySector[c.sector] = bySector[c.sector] || []).push(c);
  const pctOf = new Map();
  for (const members of Object.values(bySector)) {
    const sorted = [...members].sort((a, b) => (a.scores?.combinedAfterPenalties ?? -1) - (b.scores?.combinedAfterPenalties ?? -1));
    sorted.forEach((c, i) => pctOf.set(c.ticker, sorted.length > 1 ? i / (sorted.length - 1) : null));
  }
  const annotated = cards.map((c) => {
    const sectorPercentile = pctOf.get(c.ticker) ?? null;
    const withPct = { ...c, sectorPercentile };
    return {
      ...withPct,
      sectorStructure: sectorStockState(withPct, breadth, { prevPercentile: prevPct.get(c.ticker) ?? null }),
    };
  });
  return { cards: annotated, breadth, market };
}

module.exports = {
  BREADTH_VERSION, MARKET_STATES, SECTOR_STOCK_STATES, MIN_SECTOR_NAMES,
  marketState, sectorBreadth, sectorStockState, annotateSectorStructure,
};

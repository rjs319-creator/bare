'use strict';
// NOVEL SIGNAL LAB — Engine 2: opportunistic insider conviction (insider-conviction-v1).
//
// Not all insider buying is informative. A director's quarterly grant-driven top-up is
// routine; a CEO's first open-market purchase in three years, large relative to salary,
// alongside two other insiders buying the same week, is opportunistic — and it is the
// opportunistic kind that historically carries information (Cohen-Malloy-Pomorski,
// NBER w16454). This engine reuses the existing PIT Form-4 feed (lib/edgar.js) and adds a
// routine-vs-opportunistic classifier plus a conviction envelope.
//
// POINT-IN-TIME SAFETY: every transaction is admitted using its SEC FILING date (public
// availability), never the transaction date — an insider's trade is not information until
// the Form 4 is accepted. The caller passes `asOf`; transactions with filingDate > asOf are
// invisible. The classifier (classifyInsider) is PURE and deterministic; only
// computeInsiderConviction touches the network (via edgar.js).

const { fetchInsiderTransactions } = require('../edgar');
const { makeEnvelope, unavailable, STATUS, DIRECTION } = require('./registry');

const CONFIG = Object.freeze({
  WINDOW_DAYS: 90,          // conviction window ending at asOf
  CLUSTER_DAYS: 30,         // insiders buying within this many days = a cluster
  DORMANCY_DAYS: 365,       // no prior open-market buy in a year ⇒ "first purchase" (opportunistic marker)
  LARGE_BUY_USD: 100000,    // a single purchase ≥ $100k is materially large
  BIG_BUY_USD: 500000,      // ≥ $500k is a strong conviction marker
  MAX_SCORE_BUYS: 4,        // saturation: distinct opportunistic buyers that max the cluster term
});

const daysBetween = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);

// Classify a single purchase as routine vs opportunistic given the insider's own prior
// open-market history (buys before this one). Returns a score in [0,1] (1 = fully
// opportunistic) plus the reasons that drove it. Sales are handled separately (they are
// ambiguous — taxes/diversification/10b5-1 — so they never add conviction).
function classifyPurchase(tx, priorBuysByOwner, asOf) {
  const reasons = [];
  let opp = 0.35; // base: an open-market purchase is already discretionary

  // Size relative to a materiality floor (we lack salary/holdings from the parse, so use
  // absolute dollar thresholds — conservative and monotone).
  if (tx.value >= CONFIG.BIG_BUY_USD) { opp += 0.30; reasons.push('big-dollar'); }
  else if (tx.value >= CONFIG.LARGE_BUY_USD) { opp += 0.18; reasons.push('large-dollar'); }

  // First open-market buy after a long dormancy = strong opportunistic marker.
  const prior = priorBuysByOwner[tx.owner] || [];
  const lastBuyBefore = prior.filter(p => p.date < tx.date).map(p => p.date).sort().at(-1);
  if (!lastBuyBefore) { opp += 0.20; reasons.push('first-recorded-buy'); }
  else if (daysBetween(tx.date, lastBuyBefore) >= CONFIG.DORMANCY_DAYS) { opp += 0.20; reasons.push('post-dormancy-buy'); }
  else if (daysBetween(tx.date, lastBuyBefore) <= 45) { opp -= 0.10; reasons.push('recent-repeat'); } // cadence looks routine

  // Senior roles' discretionary buys carry more signal than 10% holders topping up.
  if (tx.isOfficer && !tx.isTenPct) { opp += 0.08; reasons.push('officer'); }
  if (tx.isTenPct && !tx.isOfficer && !tx.isDirector) { opp -= 0.08; reasons.push('ten-pct-owner'); }

  return { opportunistic: Math.max(0, Math.min(1, opp)), reasons };
}

// PURE. Aggregate a transaction list (as returned by edgar.fetchInsiderTransactions.txs)
// into a conviction assessment as of `asOf`, over the trailing WINDOW_DAYS. Uses filingDate
// for availability and transactionDate for economics.
function classifyInsider(txs, asOf, cfg = CONFIG) {
  const windowStart = new Date(Date.parse(asOf) - cfg.WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  // Available = filed on/before asOf. Prior history = everything filed before asOf (for dormancy).
  const visible = txs.filter(t => (t.filingDate || t.date) && (t.filingDate || t.date) <= asOf);
  const priorBuys = {};
  for (const t of visible) if (t.code === 'P') (priorBuys[t.owner] = priorBuys[t.owner] || []).push(t);

  const windowBuys = visible.filter(t => t.code === 'P' && (t.date || t.filingDate) >= windowStart);
  const windowSells = visible.filter(t => t.code === 'S' && (t.date || t.filingDate) >= windowStart);

  if (!windowBuys.length && !windowSells.length) {
    return { hasData: visible.length > 0, empty: true, latestFiling: visible.map(t => t.filingDate).sort().at(-1) || null };
  }

  let oppValue = 0, routineValue = 0, buyValue = 0;
  const oppBuyers = new Set(), allBuyers = new Set();
  const classified = [];
  for (const t of windowBuys) {
    const c = classifyPurchase(t, priorBuys, asOf);
    classified.push({ ...t, ...c });
    buyValue += t.value; allBuyers.add(t.owner);
    oppValue += t.value * c.opportunistic;
    routineValue += t.value * (1 - c.opportunistic);
    if (c.opportunistic >= 0.6) oppBuyers.add(t.owner);
  }
  const sellValue = windowSells.reduce((s, t) => s + t.value, 0);

  // Cluster: distinct opportunistic buyers within CLUSTER_DAYS of the latest buy.
  const latestBuyDate = windowBuys.map(t => t.date).sort().at(-1);
  const clusterBuyers = new Set();
  if (latestBuyDate) {
    for (const t of classified) {
      if (t.opportunistic >= 0.6 && daysBetween(latestBuyDate, t.date) <= cfg.CLUSTER_DAYS) clusterBuyers.add(t.owner);
    }
  }

  const oppShare = buyValue > 0 ? oppValue / buyValue : 0;
  const clusterStrength = Math.min(1, clusterBuyers.size / cfg.MAX_SCORE_BUYS);
  // Net opportunistic conviction: opportunistic buy value net of sells, softened by log-size,
  // scaled to [-1,1]. Sells subtract but never define the signal (they are ambiguous).
  const netOpp = oppValue - sellValue;
  const magnitude = Math.tanh(Math.sign(netOpp) * Math.log10(1 + Math.abs(netOpp) / cfg.LARGE_BUY_USD) / 2);
  const conviction = Math.max(-1, Math.min(1, magnitude * (0.5 + 0.5 * clusterStrength)));

  const latestFiling = visible.map(t => t.filingDate).filter(Boolean).sort().at(-1) || null;
  return {
    hasData: true, empty: false,
    windowStart, asOf,
    buyValue: Math.round(buyValue), sellValue: Math.round(sellValue),
    oppValue: Math.round(oppValue), routineValue: Math.round(routineValue),
    oppShare, clusterBuyers: clusterBuyers.size, distinctBuyers: allBuyers.size,
    conviction, clusterStrength,
    routineProbability: buyValue > 0 ? routineValue / buyValue : null,
    latestFiling,
    examples: classified.sort((a, b) => b.value - a.value).slice(0, 3)
      .map(t => ({ owner: t.owner, date: t.date, filingDate: t.filingDate, value: t.value, opportunistic: +t.opportunistic.toFixed(2), reasons: t.reasons })),
  };
}

// Build the standard envelope from a classification. `externalConflict` (optional) is a
// signed number from OTHER engines (e.g. accounting deterioration) that contradicts a buy;
// it only populates insider_signal_conflict, never the score.
function toEnvelope(cls, { ticker, securityId, asOf, externalConflict = null } = {}) {
  const base = { engine: 2, signal: 'insider_conviction', signalVersion: 'insider-conviction-v1', ticker, securityId, asOf };
  if (!cls || !cls.hasData) return unavailable('insider_conviction', { engine: 2, ticker, securityId, asOf, reason: 'no Form 4 history', provider: 'sec_form4' });
  if (cls.empty) {
    return makeEnvelope({ ...base, status: STATUS.USABLE, score: 0, direction: DIRECTION.NEUTRAL, confidence: 0.2, coverage: 1,
      staleness: cls.latestFiling ? { ageDays: daysBetween(asOf, cls.latestFiling), publishedTs: cls.latestFiling } : null,
      warnings: ['no insider transactions in window'], inputs: { buyValue: 0, sellValue: 0 } });
  }
  const ageDays = cls.latestFiling ? daysBetween(asOf, cls.latestFiling) : null;
  const conflict = externalConflict != null && cls.conviction > 0 && externalConflict < 0
    ? { direction: 'buy-vs-negative-fundamentals', magnitude: Math.abs(externalConflict) } : null;
  return makeEnvelope({
    ...base,
    status: STATUS.USABLE,
    score: +cls.conviction.toFixed(4),
    direction: cls.conviction > 0.05 ? DIRECTION.LONG : (cls.conviction < -0.05 ? DIRECTION.SHORT : DIRECTION.NEUTRAL),
    confidence: +Math.min(1, 0.3 + 0.5 * cls.clusterStrength + 0.2 * cls.oppShare).toFixed(3),
    coverage: 1,
    staleness: ageDays != null ? { ageDays, publishedTs: cls.latestFiling } : null,
    expectedDecay: { halfLifeDays: 45, reversal: false }, // insider-buy drift is a months-scale effect
    historicalSupport: { n: cls.distinctBuyers, note: `${cls.distinctBuyers} distinct buyers, ${cls.clusterBuyers} in cluster` },
    warnings: ageDays != null && ageDays > CONFIG.WINDOW_DAYS ? ['freshest filing older than window'] : [],
    inputs: {
      buyValue: cls.buyValue, sellValue: cls.sellValue, oppValue: cls.oppValue,
      opportunistic_purchase_probability: +cls.oppShare.toFixed(3),
      cluster_buy_strength: +cls.clusterStrength.toFixed(3),
      routine_trade_probability: cls.routineProbability != null ? +cls.routineProbability.toFixed(3) : null,
      insider_signal_conflict: conflict,
      examples: cls.examples,
    },
  });
}

// ASYNC. Fetch + classify + envelope for one ticker as of `asOf` (default: today from caller).
async function computeInsiderConviction(ticker, { asOf, securityId = null, externalConflict = null, lookbackDays = 400 } = {}) {
  if (!asOf) throw new Error('computeInsiderConviction requires asOf (no clock in this module)');
  const fromDate = new Date(Date.parse(asOf) - lookbackDays * 86400000).toISOString().slice(0, 10);
  let data;
  try {
    data = await fetchInsiderTransactions(ticker, { fromDate });
  } catch (e) {
    return unavailable('insider_conviction', { engine: 2, ticker, securityId, asOf, reason: `edgar fetch failed: ${e.message}`, provider: 'sec_form4' });
  }
  if (!data || data.cik == null) return unavailable('insider_conviction', { engine: 2, ticker, securityId, asOf, reason: 'no CIK / not an SEC filer', provider: 'sec_form4' });
  const cls = classifyInsider(data.txs || [], asOf);
  return toEnvelope(cls, { ticker, securityId, asOf, externalConflict });
}

module.exports = { classifyPurchase, classifyInsider, toEnvelope, computeInsiderConviction, CONFIG };

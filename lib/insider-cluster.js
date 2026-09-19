'use strict';
// INSIDER CLUSTER BUYS — the shared, FROZEN event definition (research/69 + research/98)
// and the prospective ledger's eligibility rules (research/INSIDER-CLUSTER-RESIDUAL-2026-09.md).
//
// One module, two consumers: the research scripts (retrospective, sealed) and the
// prospective shadow feed (lib/insider-cluster-feed.js). Moving the constructor here is
// what keeps "the same definition" a fact rather than a promise — research/69's lock
// test still runs against THIS function.
//
// PIT rule: the event date is the LATEST FILING date of the cluster's members — a
// cluster is only knowable once its last member files (transaction-date anchoring would
// leak the disclosure lag: the congress-trades lesson).

const DAY = 86_400_000;

// FROZEN cluster definition (preregistration 2026-08-05 §2, reused unchanged 2026-09-09).
const CLUSTER = Object.freeze({ windowDays: 14, minOwners: 2, minValue: 50_000 });

// FROZEN prospective-ledger eligibility (2026-09 §2; the study's primary cohort).
// ADV tiers mirror the app's cost model (research/lib/experiment-kit costFractions):
// liquid ≥ $20M, small ≥ $5M, else micro. Liquid is EXCLUDED from the policy cohort —
// the study found nothing there (+0.06%, n 965), consistent with limits-to-arbitrage.
const LEDGER = Object.freeze({
  minAdv: 5e5, minPrice: 1, advLookback: 60, cooldownSessions: 21, cooldownCalendarDays: 30,
  tierLiquidAdv: 2e7, tierSmallAdv: 5e6,
  policyTier: 'CLUSTER', excludedTier: 'CLUSTER_EXCLUDED',
});

function tierForAdv(adv) {
  if (!Number.isFinite(adv)) return 'micro';
  return adv >= LEDGER.tierLiquidAdv ? 'liquid' : adv >= LEDGER.tierSmallAdv ? 'small' : 'micro';
}

function isCleanBuy(t) {
  return !!(t && t.code === 'P' && t.shares > 0 && t.price > 0 && t.owner && t.date && t.filingDate);
}

// A JOINT filing (several reporting owners on one accession — a fund, its GP and its
// managing member) is ONE economic decision. Collapse it to one row so it cannot be a
// "cluster" by itself. Pure; keeps the first owner and records how many were on the form.
function dedupeJointFilings(txs) {
  const seen = new Map();
  for (const t of txs || []) {
    if (!isCleanBuy(t)) continue;
    const key = `${t.accession || ''}|${t.date}|${t.shares}|${t.price}`;
    const prev = seen.get(key);
    if (prev) { prev.jointOwners = (prev.jointOwners || 1) + 1; continue; }
    seen.set(key, { ...t, jointOwners: 1 });
  }
  return [...seen.values()];
}

// FROZEN constructor (verbatim behaviour of research/69-insider-cluster.js clusterEvents).
function clusterEvents(txs, { windowDays = CLUSTER.windowDays, minOwners = CLUSTER.minOwners, minValue = CLUSTER.minValue } = {}) {
  const buys = (txs || []).filter(isCleanBuy).sort((a, b) => (a.date < b.date ? -1 : 1));
  const events = [];
  let i = 0;
  while (i < buys.length) {
    const start = Date.parse(buys[i].date);
    const members = [];
    let j = i;
    while (j < buys.length && Date.parse(buys[j].date) - start <= windowDays * DAY) { members.push(buys[j]); j++; }
    const owners = new Set(members.map((m) => m.owner.trim().toUpperCase()));
    const combinedValue = members.reduce((s, m) => s + (m.value || Math.round(m.shares * m.price)), 0);
    if (owners.size >= minOwners && combinedValue >= minValue) {
      const eventDate = members.map((m) => String(m.filingDate).slice(0, 10)).sort().pop();
      events.push({ eventDate, owners: owners.size, combinedValue, txDates: [members[0].date, members[members.length - 1].date], members });
      i = j;                                    // consume the window — no overlapping events
    } else {
      i++;
    }
  }
  return events;
}

// Ledger row classification at the decision bar. Pure. `adv` = trailing 60-session mean
// dollar volume, `close` = decision close, `members` = the cluster's buys.
function classifyEligibility({ adv, close, members = [] }) {
  const tier = tierForAdv(adv);
  const reasons = [];
  if (members.some((m) => m.tenB51 === true)) reasons.push('10b5-1');
  if (tier === 'liquid') reasons.push('liquid-tier');
  if (!(adv >= LEDGER.minAdv)) reasons.push('illiquid');
  if (!(close >= LEDGER.minPrice)) reasons.push('sub-dollar');
  return { tier: reasons.length ? LEDGER.excludedTier : LEDGER.policyTier, liqTier: tier, reasons };
}

module.exports = { DAY, CLUSTER, LEDGER, tierForAdv, isCleanBuy, dedupeJointFilings, clusterEvents, classifyEligibility };

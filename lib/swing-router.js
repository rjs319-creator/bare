'use strict';
// SWING ALGORITHM ROUTER — evidence-gated, algorithm-SPECIFIC performance tilt.
//
// Replaces the fallacy the audit found in the client Opportunities strip: a single global
// "model health" scalar multiplied into every candidate identically, which is mathematically
// order-preserving (it cannot rerank anything) yet was presented as "adaptive ranking".
//
// This router instead learns a SEPARATE tilt per source algorithm / strategy family from RESOLVED
// UNIQUE episodes (one terminal grade per episode — never per daily snapshot), shrinks each toward
// a neutral global prior with hierarchical empirical Bayes so a thin cell stays neutral, and only
// tilts at all once a per-algorithm sample threshold is cleared. Because different algorithms get
// different multipliers, it CAN change relative order — the property a uniform scalar can never have.
//
// It is SHADOW by construction: the band is narrow, it is applied server-side only to the supervisor's
// remaining-opportunity ordering, it never originates or boosts a live trade, and below-threshold
// algorithms are pinned to 1.0. Pure: no clock, no store, no network.

const VERSION = 'swing-router-v1';
const MIN_EPISODES = 12;      // below this per algorithm → neutral (no tilt from thin evidence)
const PRIOR_STRENGTH = 12;    // empirical-Bayes pseudo-count toward the global prior
const BAND = 0.15;            // multiplier stays within [1-BAND, 1+BAND]
const TILT_GAIN = 0.6;        // how hard a shrunk edge maps into the band

function num(v) { return (v === null || v === undefined || v === '' || typeof v === 'boolean') ? null : (Number.isFinite(+v) ? +v : null); }
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// A resolved episode → the fields the router scores. `win` = target-before-stop (or positive net
// when there is no barrier). Fill/no-fill and excess are collected for display.
function outcomeOf(ep) {
  const a = ep && ep.assessment ? ep.assessment : ep || {};
  const oc = a.outcomeState;
  const win = oc === 'WIN' || oc === 'EXPIRED_POSITIVE';
  const loss = oc === 'LOSS' || oc === 'EXPIRED_NEGATIVE';
  const noFill = oc === 'NO_FILL';
  return {
    family: (ep.origin && ep.origin.strategyFamily) || a.strategyFamily || 'priceTrend',
    source: (ep.origin && ep.origin.sourceStrategy) || a.sourceStrategy || 'unknown',
    resolved: win || loss || (oc === 'EXPIRED_POSITIVE') || (oc === 'EXPIRED_NEGATIVE'),
    win, loss, noFill,
    net: num(a.returnSinceFill), excess: num(a.excessVsSpy),
  };
}

function summarize(rows) {
  const graded = rows.filter(r => r.win || r.loss);   // fills that reached a decision
  const wins = graded.filter(r => r.win).length;
  const n = graded.length;
  const excesses = rows.map(r => r.excess).filter(v => v != null);
  const nets = rows.map(r => r.net).filter(v => v != null);
  const gains = nets.filter(v => v > 0).reduce((s, v) => s + v, 0);
  const losses = -nets.filter(v => v < 0).reduce((s, v) => s + v, 0);
  return {
    episodes: rows.length, resolved: n, wins,
    winRate: n ? wins / n : null,
    noFillRate: rows.length ? rows.filter(r => r.noFill).length / rows.length : null,
    meanExcessVsSpy: excesses.length ? excesses.reduce((s, v) => s + v, 0) / excesses.length : null,
    profitFactor: losses > 1e-9 ? +(gains / losses).toFixed(2) : (gains > 0 ? Infinity : null),
  };
}

// Build the router from resolved episodes. Returns { multiplierFor, table, priorRate, version }.
function buildRouter(episodes = []) {
  const rows = (episodes || []).map(outcomeOf).filter(r => r.resolved || r.noFill);
  const gradedAll = rows.filter(r => r.win || r.loss);
  const priorRate = gradedAll.length ? gradedAll.filter(r => r.win).length / gradedAll.length : 0.5;

  const bySource = new Map();
  const byFamily = new Map();
  for (const r of rows) {
    if (!bySource.has(r.source)) bySource.set(r.source, []);
    bySource.get(r.source).push(r);
    if (!byFamily.has(r.family)) byFamily.set(r.family, []);
    byFamily.get(r.family).push(r);
  }

  const tiltFor = (group) => {
    const s = summarize(group);
    // Evidence gate: thin cell → neutral, and shrink toward the global prior always.
    const graded = group.filter(r => r.win || r.loss).length;
    const wins = group.filter(r => r.win).length;
    const shrunkRate = (wins + PRIOR_STRENGTH * priorRate) / (graded + PRIOR_STRENGTH);
    const belowThreshold = graded < MIN_EPISODES;
    const multiplier = belowThreshold ? 1 : clamp(1 + TILT_GAIN * (shrunkRate - priorRate), 1 - BAND, 1 + BAND);
    return { ...s, shrunkRate: +shrunkRate.toFixed(3), belowThreshold, multiplier: +multiplier.toFixed(3) };
  };

  const sourceTable = {};
  for (const [k, g] of bySource) sourceTable[k] = tiltFor(g);
  const familyTable = {};
  for (const [k, g] of byFamily) familyTable[k] = tiltFor(g);

  function multiplierFor(family, source) {
    if (source && sourceTable[source] && !sourceTable[source].belowThreshold) return sourceTable[source].multiplier;
    if (family && familyTable[family] && !familyTable[family].belowThreshold) return familyTable[family].multiplier;
    return 1;  // neutral prior — thin or unknown evidence never tilts
  }

  return {
    version: VERSION, priorRate: +priorRate.toFixed(3),
    minEpisodes: MIN_EPISODES, band: BAND,
    sources: sourceTable, families: familyTable,
    multiplierFor,
    // Shadow honesty stamp — this is a ranking tilt over shadow episodes, not proven edge.
    shadow: true, note: 'Algorithm-specific shrunk tilt from resolved swing episodes. Neutral (1.0) below the per-algorithm sample threshold. Never originates or boosts a live trade.',
  };
}

module.exports = { buildRouter, outcomeOf, summarize, VERSION, MIN_EPISODES, BAND };

'use strict';
// ⚡ GRIDLOCK — Read-Through extension: deterministic tape read +
// notYetRepricedScore (pure).
//
// This EXTENDS the existing Read-Through system rather than duplicating it:
// sector benchmarking reuses lib/readthrough.js benchFor(), and the tape logic
// generalizes readthrough's binary alreadyMovedFlag / govdemand's
// priceConsumedGate into a decomposed 0–100 "not yet repriced" read. It is the
// MEASURED route (repo rule: the LLM proposes, deterministic code disposes —
// repricing is measurable, so no LLM is involved at all).
//
// Honesty rule baked in: a stock that has not moved because its causal link is
// WEAK is not a hidden opportunity. The score is null (with an explicit note)
// unless the classification carries a beneficial, evidence-backed link.

const { benchFor } = require('./readthrough');

const NYR_VERSION = 'gridlock-nyr-v1';
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// ── Deterministic tape read (event-anchored, PIT-safe) ──────────────────────
// Close-on/before eventDate → close-on/before asOf, excess vs the bench series
// (sector ETF via benchFor, else SPY). relVol = latest volume / trailing-20d.
// Missing coverage → nulls (absence of data is UNAVAILABLE, never "no move").
function tapeRead({ candles, benchCandles, eventDate, asOf }) {
  const at = (cs, d) => {
    if (!Array.isArray(cs)) return null;
    let idx = -1;
    for (let i = 0; i < cs.length; i++) { if (cs[i].date <= d) idx = i; else break; }
    return idx >= 0 ? { c: cs[idx], idx } : null;
  };
  const c0 = at(candles, String(eventDate).slice(0, 10)), c1 = at(candles, asOf);
  const b0 = at(benchCandles, String(eventDate).slice(0, 10)), b1 = at(benchCandles, asOf);
  let excessMovePct = null;
  if (c0 && c1 && b0 && b1 && c0.c.close > 0 && b0.c.close > 0) {
    excessMovePct = +((((c1.c.close - c0.c.close) / c0.c.close) - ((b1.c.close - b0.c.close) / b0.c.close)) * 100).toFixed(2);
  }
  let relVol = null, dollarVol = null;
  if (c1 && c1.idx >= 20) {
    const win = candles.slice(c1.idx - 20, c1.idx);
    const avg = win.reduce((s, c) => s + (c.volume || 0), 0) / win.length;
    if (avg > 0 && Number.isFinite(candles[c1.idx].volume)) relVol = +(candles[c1.idx].volume / avg).toFixed(2);
    dollarVol = Math.round(win.reduce((s, c) => s + (c.volume || 0) * (c.close || 0), 0) / win.length);
  }
  return { excessMovePct, relVol, dollarVol, coverage: !!(c0 && c1 && b0 && b1) };
}

// ── notYetRepricedScore ─────────────────────────────────────────────────────
// Decomposed; every sub-read returned. `expectedMovePct` is a disclosed proxy
// for "proportional reaction": high-materiality direct links should move more
// than weak second-order ones before being called repriced.
function notYetRepricedScore({ classification, relationship, event, tape, asOf }) {
  const beneficial = ['DIRECT_BENEFICIARY', 'SECOND_ORDER_BENEFICIARY', 'EQUIPMENT_OR_CAPACITY_BENEFICIARY'].includes(classification.classification);
  if (!beneficial || classification.verifiedOrInferred === 'inferred') {
    return {
      version: NYR_VERSION, score: null,
      note: 'not scored: a non-mover with a weak/inferred link is NOT a hidden opportunity',
      reads: null,
    };
  }
  const expectedMovePct =
    classification.classification === 'DIRECT_BENEFICIARY' ? (relationship.estimatedMateriality === 'high' ? 6 : 4) :
    classification.classification === 'EQUIPMENT_OR_CAPACITY_BENEFICIARY' ? 3 : 2;

  const days = (Date.parse(asOf) - Date.parse(String(event.announcedAt).slice(0, 10))) / 864e5;
  const reads = {
    exposureVerified: relationship.verifiedOrInferred === 'verified' ? 100 : 40,
    materiality: relationship.estimatedMateriality === 'high' ? 100 : relationship.estimatedMateriality === 'medium' ? 60 : 20,
    freshness: !Number.isFinite(days) || days < 0 ? null : Math.round(clamp(1 - days / 30, 0, 1) * 100),
    // How much of the "proportional" move remains uncaptured (direction-aware).
    unreactedGap: (() => {
      if (!tape || tape.excessMovePct == null) return null;
      const captured = classification.direction >= 0 ? tape.excessMovePct : -tape.excessMovePct;
      if (captured >= expectedMovePct) return 0;                        // fully repriced
      if (captured <= -expectedMovePct) return 20;                      // moving AGAINST thesis — not "unpriced", suspicious
      return Math.round(clamp(1 - captured / expectedMovePct, 0, 1) * 100);
    })(),
    volumeInflection: tape && tape.relVol != null ? Math.round(clamp((tape.relVol - 0.8) / 1.2, 0, 1) * 100) : null,
    attentionRoom: (() => {
      const n = event.independentSourceCount || 1;
      if (event.lifecycle === 'CROWDED') return 10;
      return Math.round(clamp(1 - (n - 1) / 8, 0, 1) * 100);            // >9 publishers = saturated
    })(),
    tradability: tape && tape.dollarVol != null ? (tape.dollarVol >= 20e6 ? 100 : tape.dollarVol >= 3e6 ? 55 : 15) : null,
  };
  const weightsNyr = { exposureVerified: 0.20, materiality: 0.20, freshness: 0.12, unreactedGap: 0.22, volumeInflection: 0.10, attentionRoom: 0.08, tradability: 0.08 };
  const avail = Object.keys(reads).filter(k => reads[k] != null);
  if (!avail.length) return { version: NYR_VERSION, score: null, note: 'no inputs available', reads };
  const wSum = avail.reduce((s, k) => s + weightsNyr[k], 0);
  const score = Math.round(avail.reduce((s, k) => s + reads[k] * (weightsNyr[k] / wSum), 0));
  return {
    version: NYR_VERSION, score, reads, weights: weightsNyr,
    available: avail, missing: Object.keys(reads).filter(k => reads[k] == null),
    expectedMovePct,
    note: null,
  };
}

// Sector bench resolver — direct reuse of the Read-Through resolver.
function benchForSector(sector) { return benchFor(sector); }

module.exports = { NYR_VERSION, tapeRead, notYetRepricedScore, benchForSector };

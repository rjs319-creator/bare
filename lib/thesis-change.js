'use strict';
// 🔀 THESIS CHANGE (redesign stage E/K) — "what materially changed, and is it confirmed?"
//
// The redesign's headline user question is not "what's the news?" but "did this company's
// investment thesis STRENGTHEN or WEAKEN, on which horizon, and does independent evidence /
// the market confirm it?". This module assembles ONE thesis-change object per ticker from:
//   - the clustered events (what changed, direction, horizon, materiality, contradictions)
//   - the evidence-consensus score (independent breadth, penalties, confirmation)
//   - optional enrichment from the app's EXISTING engines (toneshift Δ, analyst-revision Δ,
//     insider net) — passed in by the route so this stays a pure, testable assembler.
//
// It deliberately does NOT emit a probability or a "buy". It emits a direction, a magnitude,
// a horizon, a confirmation status, and the drivers/contradictions behind them — decision
// support, honest about the project's finding that there is no durable standalone alpha.

const num = (v, d = 0) => (typeof v === 'number' && isFinite(v)) ? v : d;

// Net directional change from the clustered events, weighted by materiality × novelty (a big
// novel event outweighs several trivial restatements). Returns a signed score in ~[-1,1].
function directionalPressure(events) {
  let s = 0, w = 0;
  for (const e of events || []) {
    const weight = num(e.materialityScore, 0.5) * (0.5 + 0.5 * num(e.noveltyScore, 0.5));
    const sign = e.direction === 'positive' ? 1 : e.direction === 'negative' ? -1 : 0;
    s += sign * weight; w += weight;
  }
  return w > 0 ? +(s / w).toFixed(3) : 0;
}

// Map the pressure + consensus into a discrete thesis-change verdict.
function classify(pressure, consensus, extras) {
  const mag = Math.abs(pressure);
  const strengthening = pressure > 0.15;
  const weakening = pressure < -0.15;
  // Enrichment nudges (existing engines): toneshift brightening/darkening, revision up/down.
  const toneUp = extras.toneShift === 'BRIGHTENING', toneDown = extras.toneShift === 'DARKENING';
  const revUp = num(extras.revisionDelta) > 0, revDown = num(extras.revisionDelta) < 0;

  let level, headline;
  const confirmed = !!(consensus && consensus.hasPrimarySource) &&
                    (consensus && num(consensus.subscores?.marketConfirm) > 0 || toneUp || toneDown || revUp || revDown);

  if (strengthening) {
    level = mag > 0.45 ? 'strengthened' : 'improving';
    headline = 'Thesis strengthening' + (toneUp || revUp ? ' (tone/estimates confirm)' : '');
  } else if (weakening) {
    level = mag > 0.45 ? 'weakened' : 'deteriorating';
    headline = 'Thesis weakening' + (toneDown || revDown ? ' (tone/estimates confirm)' : '');
  } else if (consensus && consensus.conflicting) {
    level = 'conflicting'; headline = 'Mixed / conflicting signals';
  } else {
    level = 'stable'; headline = 'No material thesis change';
  }
  return { level, headline, confirmed, magnitude: +mag.toFixed(3) };
}

/**
 * Build the thesis-change object for one ticker.
 * @param {object} input
 *  - ticker (required)
 *  - clusters (from evidence-cluster) — the events behind the change
 *  - consensus (from evidence-consensus.scoreConsensus)
 *  - extras: { toneShift?: 'BRIGHTENING'|'STABLE'|'DARKENING', revisionDelta?: number,
 *             insiderNet?: number, horizonConflict?: string } — optional enrichment
 */
function buildThesisChange(input = {}) {
  const ticker = (input.ticker || '').toUpperCase();
  const clusters = (input.clusters || []).filter(c => c && c.primary);
  const events = clusters.map(c => c.primary);
  const consensus = input.consensus || null;
  const extras = input.extras || {};

  if (!events.length) {
    return { ticker, level: 'none', headline: 'No events', changed: false, drivers: [], contradictions: [], horizon: 'unclear' };
  }

  const pressure = directionalPressure(events);
  const verdict = classify(pressure, consensus, extras);

  // Dominant horizon: how many events bear on swing vs long-term (both counts for each).
  let swing = 0, long = 0;
  for (const e of events) {
    if (e.affectedHorizon === 'swing' || e.affectedHorizon === 'both') swing++;
    if (e.affectedHorizon === 'long_term' || e.affectedHorizon === 'both') long++;
  }
  const horizon = swing && long ? 'both' : swing ? 'swing' : long ? 'long_term' : 'unclear';

  // Drivers = the most material events (their claims); contradictions = opposing events + notes.
  const drivers = events
    .slice()
    .sort((a, b) => num(b.materialityScore) - num(a.materialityScore))
    .slice(0, 4)
    .map(e => ({ eventType: e.eventType, claim: e.claim, direction: e.direction, horizon: e.affectedHorizon, novelty: e.noveltyScore, materiality: e.materialityScore, sourceType: e.sourceType }));
  const contradictions = [
    ...events.flatMap(e => (e.contradictions || []).map(c => ({ from: e.eventType, note: c }))),
  ].slice(0, 4);

  return {
    ticker,
    changed: verdict.level !== 'stable' && verdict.level !== 'none',
    level: verdict.level,                     // strengthened|improving|deteriorating|weakened|conflicting|stable
    headline: verdict.headline,
    directionPressure: pressure,              // signed, materiality-weighted
    magnitude: verdict.magnitude,
    confirmed: verdict.confirmed,             // primary source + market/tone/estimate confirmation
    horizon,                                  // swing|long_term|both|unclear
    consensusScore: consensus ? consensus.score : null,
    consensusState: consensus ? consensus.state : null,
    distinctFamilies: consensus ? consensus.distinctFamilies : events.length ? 1 : 0,
    drivers,
    contradictions,
    enrichment: {
      toneShift: extras.toneShift || null,
      revisionDelta: extras.revisionDelta != null ? +num(extras.revisionDelta).toFixed(2) : null,
      insiderNet: extras.insiderNet != null ? extras.insiderNet : null,
    },
  };
}

module.exports = { buildThesisChange, directionalPressure, classify };

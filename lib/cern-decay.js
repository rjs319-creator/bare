'use strict';
// Decay curves per CERN forced-flow event type (roadmap Step 2).
//
// For every logged CERN event (the counterfactual archive — traded or not) we
// measure its EXCESS return vs the S&P 500 at each day 1..20 after the signal
// fired, then average within each event type. The resulting curve shows how long
// a type's market-beating edge lasts before it decays — which sets a recommended
// holding window (hold to the peak, exit before it fades).
//
// Pure + dependency-light: forwardReturn / spyForwardReturn are injected so this
// module has no I/O and is unit-testable with synthetic candles.

const MAX_DAY = 20;      // curve runs day 1..20 (trading days)
const MIN_SAMPLE = 5;    // min resolved picks at a given day to plot that day's point
const MIN_TRUST = 20;    // min picks resolved to the full window before we trust the window

// picks:   [{ date, tier(=event type), ticker, entry, short }]  (from cernPicksFrom)
// histMap: Map<ticker, candles>
// spy:     SPY candles
// fns:     { forwardReturn, spyForwardReturn } injected from lib/apex-routes
function computeDecayCurves(picks, histMap, spy, fns, opts = {}) {
  const maxDay = opts.maxDay || MAX_DAY;
  const minSample = opts.minSample || MIN_SAMPLE;
  const minTrust = opts.minTrust || MIN_TRUST;
  const { forwardReturn, spyForwardReturn } = fns;

  // Group picks by event type.
  const byType = new Map();
  for (const p of picks || []) {
    if (!p || !p.tier || !p.ticker) continue;
    if (!byType.has(p.tier)) byType.set(p.tier, []);
    byType.get(p.tier).push(p);
  }

  const types = {};
  for (const [type, tPicks] of byType) {
    // For each day, gather the excess of every pick resolved at that day.
    const curve = [];
    let n20 = 0; // picks resolved all the way to the final day (the trust sample)
    for (let day = 1; day <= maxDay; day++) {
      const excs = [];
      for (const p of tPicks) {
        const candles = histMap.get(p.ticker);
        if (!candles) continue;
        const r = forwardReturn(candles, p, day);      // direction-aware pick return
        const s = spyForwardReturn(spy, p, day);        // market over the same window
        if (r == null || s == null || !Number.isFinite(r)) continue;
        excs.push(r - s);
      }
      const n = excs.length;
      if (day === maxDay) n20 = n;
      curve.push({
        day,
        n,
        avgExcess: n ? +(excs.reduce((a, b) => a + b, 0) / n).toFixed(2) : null,
      });
    }

    // Days with enough sample to be believed, in day order.
    const eligible = curve.filter(pt => pt.n >= minSample && pt.avgExcess != null);
    // Recommended hold = the peak of the INITIAL positive stretch. Holding is a
    // day-1-onward decision, so an isolated positive day buried in an otherwise
    // negative curve is not a real window — the edge has to be there from the start.
    // If the first believable day is already ≤ 0, the type fades (no window).
    let recommendedHold = null, holdExcess = null, fades = false;
    if (eligible.length) {
      if (eligible[0].avgExcess > 0) {
        for (const pt of eligible) {
          if (pt.avgExcess <= 0) break;                 // positive stretch ended
          if (holdExcess == null || pt.avgExcess > holdExcess) { holdExcess = pt.avgExcess; recommendedHold = pt.day; }
        }
      } else {
        fades = true;                                   // negative from the start
      }
    }
    // Best market-beating day observed (for display), independent of the window rule.
    const peakExcess = eligible.length ? Math.max(...eligible.map(pt => pt.avgExcess)) : null;
    types[type] = {
      curve,
      n: tPicks.length,
      n20,                                   // resolved-to-full-window sample
      trustworthy: n20 >= minTrust,
      daysNeeded: Math.max(0, minTrust - n20),
      peakExcess,
      recommendedHold,
      holdExcess,                            // avg excess if held to the recommended day
      fades,                                 // has data but is underwater from day 1
    };
  }

  return {
    types,
    maxDay,
    minSample,
    minTrust,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { computeDecayCurves, MAX_DAY, MIN_SAMPLE, MIN_TRUST };

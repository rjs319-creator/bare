// THREE-HORIZON SYNTHESIS (pure, deterministic).
//
// Fuses the three INDEPENDENT reads — intraday, swing, long-term — into one
// plain-English headline WITHOUT altering any underlying horizon action. The
// whole point is to PRESERVE disagreement (and name it), never to average three
// conflicting signals into a mushy number. There is deliberately no composite
// score here.

const SIGN = { bull: 1, neutral: 0, bear: -1, unavailable: null };

function intradaySide(intraday) {
  if (!intraday || intraday.available === false || intraday.action === 'UNAVAILABLE') return 'unavailable';
  const a = intraday.action;
  if (a === 'STRONG_BUY' || a === 'BUY') return 'bull';
  if (a === 'STRONG_SELL' || a === 'SELL') return 'bear';
  return 'neutral';
}
function swingSide(swing) {
  if (!swing || swing.available === false || swing.action === 'UNAVAILABLE') return 'unavailable';
  if (swing.action === 'BUY') return 'bull';
  if (swing.action === 'SELL') return 'bear';
  return 'neutral';
}
function longTermSide(lt) {
  if (!lt || lt.available === false) return 'unavailable';
  if (lt.trend === 'bullish') return 'bull';
  if (lt.trend === 'bearish') return 'bear';
  return 'neutral';
}

// Named, deterministic headline for the meaningful combinations. Falls through to
// a generated description that still preserves the disagreement.
function headlineFor(sides) {
  const { intraday: i, swing: s, longTerm: l } = sides;
  const key = `${i}|${s}|${l}`;
  const TABLE = {
    'bull|bull|bull':   'Bullish across all three horizons.',
    'bear|bull|bull':   'Intraday pullback inside bullish higher-timeframe structure — wait for a reclaim.',
    'bull|bear|bear':   'Counter-trend bounce inside damaged higher-timeframe structure.',
    'bear|bear|bear':   'Bearish across all three horizons — avoid or manage risk.',
    'bull|bull|bear':   'Early swing rebound inside a long-term downtrend — higher failure risk.',
    'neutral|bull|bull':'Long-term and swing trends are up; today is quiet — constructive.',
    'bull|neutral|bull':'Long-term uptrend intact; the swing setup has no fresh trigger yet.',
  };
  if (TABLE[key]) return TABLE[key];

  // Swing-vs-long-term is the axis a multi-week trader cares about most.
  if (s === 'bear' && l === 'bull') return 'Long-term trend remains intact, but the multi-week setup is deteriorating — protect gains or wait.';
  if (s === 'bull' && l === 'bear') return 'Early swing rebound inside a long-term downtrend — higher failure risk.';
  if (s === 'bull' && l === 'bull') return 'Swing and long-term trends agree to the upside.';
  if (s === 'bear' && l === 'bear') return 'Swing and long-term trends agree to the downside — avoid.';
  if (s === 'unavailable' && l === 'unavailable') return 'Only the intraday read is available right now.';
  if (s === 'unavailable') return 'Swing read unavailable — leaning on the intraday and long-term horizons.';
  return 'Horizons disagree — trade the timeframe you actually hold.';
}

// Coarse overall bucket — a LABEL, not an averaged score.
function overallFor(sides) {
  const vals = [sides.intraday, sides.swing, sides.longTerm].map(x => SIGN[x]).filter(v => v != null);
  if (!vals.length) return 'unavailable';
  const allBull = vals.every(v => v > 0), allBear = vals.every(v => v < 0);
  if (allBull) return 'aligned-bullish';
  if (allBear) return 'aligned-bearish';
  const hasBull = vals.some(v => v > 0), hasBear = vals.some(v => v < 0);
  if (hasBull && hasBear) return 'conflicting';
  if (hasBull) return 'leaning-bullish';
  if (hasBear) return 'leaning-bearish';
  return 'neutral';
}

// Enumerate the concrete disagreements so the UI can show them verbatim.
function conflictsFor(sides) {
  const out = [];
  const label = { bull: 'bullish', bear: 'bearish', neutral: 'neutral', unavailable: 'unavailable' };
  const pairs = [
    ['intraday', 'swing'], ['swing', 'longTerm'], ['intraday', 'longTerm'],
  ];
  for (const [a, b] of pairs) {
    const sa = sides[a], sb = sides[b];
    if (sa === 'unavailable' || sb === 'unavailable') continue;
    if ((SIGN[sa] > 0 && SIGN[sb] < 0) || (SIGN[sa] < 0 && SIGN[sb] > 0)) {
      out.push(`${a} is ${label[sa]} while ${b} is ${label[sb]}`);
    }
  }
  return out;
}

/**
 * @param {Object} horizons { intraday, swing, longTerm }
 * @returns {Object} { overall, setup, headline, sides, conflicts, note }
 */
function synthesizeHorizons({ intraday, swing, longTerm } = {}) {
  const sides = {
    intraday: intradaySide(intraday),
    swing: swingSide(swing),
    longTerm: longTermSide(longTerm),
  };
  const overall = overallFor(sides);
  const conflicts = conflictsFor(sides);
  const headline = headlineFor(sides);
  const setup = (swing && swing.setup) || null;

  let note;
  if (sides.swing === 'unavailable' && sides.longTerm === 'unavailable') {
    note = 'Daily-horizon data is unavailable — treat this as an intraday-only read.';
  } else if (!conflicts.length) {
    note = 'The horizons agree — the main risk is a regime change, not internal conflict.';
  } else {
    note = 'Pick the horizon that matches your holding period; the others are context, not a veto.';
  }

  return { overall, setup, headline, sides, conflicts, note };
}

module.exports = { synthesizeHorizons, intradaySide, swingSide, longTermSide, overallFor };

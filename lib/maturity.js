// Evidence-Maturity system — the honest "how much should I trust this?" grade for
// every strategy/signal class in the app.
//
// The grade is EARNED from each class's own resolved Scoreboard track record — the
// same falsifiability backbone the rest of the app already uses (excess vs benchmark,
// Wilson lower bound, sample size). It is NOT a hand-assigned label: a class only
// reaches "Validated" by beating its benchmark at statistical significance over enough
// resolved picks, and drops to "Disabled" when its resolved record significantly
// underperforms. This is the mechanism that auto-routes unproven overlays (CERN, Tone
// Shift, Cross-Asset, Second Wave, …) into the Research Lab and graduates them out
// only when the data earns it.
//
// Pure + dependency-light (only lib/stats wilson) → fully unit-testable, no network.

const { wilson } = require('./stats');

const MATURITY_VERSION = 'maturity-v1';

// Grades, strongest → weakest. rank is used for sorting / "at least this mature" tests.
const GRADE_META = {
  validated:     { label: 'Validated',     icon: '✅', rank: 5, blurb: 'Beats its benchmark at statistical significance over enough resolved picks.' },
  promising:     { label: 'Promising',     icon: '🟡', rank: 4, blurb: 'Positive track record so far, but not yet enough resolved picks to be sure.' },
  experimental:  { label: 'Experimental',  icon: '🧪', rank: 3, blurb: 'Live and logging, but too few resolved picks for any verdict yet.' },
  informational: { label: 'Informational', icon: 'ℹ️', rank: 2, blurb: 'Context / awareness, not a graded buy-or-sell signal.' },
  disabled:      { label: 'Disabled',      icon: '⛔', rank: 1, blurb: 'Resolved track record significantly underperforms its benchmark — demoted.' },
};
const GRADES = Object.keys(GRADE_META);

// Sample-size gates (resolved picks that carry a benchmark comparison).
const MIN_VERDICT = 20;    // needed to earn Validated or Disabled (a real verdict)
const MIN_PROMISING = 8;   // needed to leave Experimental ("accruing") for Promising

// Which realized-return horizon we grade each intended holding period on. Mirrors the
// decision engine's HORIZON_METRIC so a swing setup is judged on its swing outcome.
const HORIZON_METRIC = { intraday: '1d', swing: '5d', position: '1m', portfolio: '3m' };

// Grade a SINGLE pooled track record against its baselines. Primary baseline = the
// market (SPY): excessN / avgExcess / beatMktRate. Secondary baseline = the SECTOR
// ETF (secExcN / avgSecExcess / beatSecRate) — required so a strategy can't earn
// "Validated" just by riding a hot sector (the spec's "control for sector"). Returns
// { grade, reason, stats:{ …, baselines:{ market, sector } } }.
function gradeTrack(track) {
  const excessN = (track && Number.isFinite(track.excessN)) ? track.excessN : 0;
  const avgExcess = (track && Number.isFinite(track.avgExcess)) ? track.avgExcess : null;
  const beatMktRate = (track && Number.isFinite(track.beatMktRate)) ? track.beatMktRate : null;
  const secExcN = (track && Number.isFinite(track.secExcN)) ? track.secExcN : 0;
  const avgSecExcess = (track && Number.isFinite(track.avgSecExcess)) ? track.avgSecExcess : null;
  const beatSecRate = (track && Number.isFinite(track.beatSecRate)) ? track.beatSecRate : null;
  const sector = { n: secExcN, avgExcess: avgSecExcess, beatRate: beatSecRate };

  if (!excessN || avgExcess === null || beatMktRate === null) {
    return { grade: 'experimental', reason: 'No resolved picks with a benchmark yet — accruing.', stats: { excessN, avgExcess, beatMktRate, beatLo: null, beatHi: null, baselines: { market: { n: excessN, avgExcess, beatRate: beatMktRate }, sector } } };
  }

  // Conservative bound on "beats the market more than half the time", sample-aware.
  const beatWins = Math.round((beatMktRate / 100) * excessN);
  const { lo, hi } = wilson(beatWins, excessN);
  const stats = { excessN, avgExcess, beatMktRate, beatLo: +(lo * 100).toFixed(0), beatHi: +(hi * 100).toFixed(0), baselines: { market: { n: excessN, avgExcess, beatRate: beatMktRate }, sector } };
  // Sector baseline only counts as a real control when it has enough resolved picks.
  const sectorKnown = secExcN >= MIN_PROMISING && avgSecExcess !== null;
  const beatsSector = !sectorKnown || avgSecExcess > 0;

  // Disabled — enough evidence AND significantly (or materially) losing to the market.
  if (excessN >= MIN_VERDICT && avgExcess < 0 && (hi < 0.5 || avgExcess <= -1)) {
    return { grade: 'disabled', reason: `Underperforms the market over ${excessN} resolved (avg ${avgExcess > 0 ? '+' : ''}${avgExcess}% vs SPY, beats ${beatMktRate}%).`, stats };
  }
  // Validated — beats the MARKET significantly AND (where measurable) beats its SECTOR.
  if (excessN >= MIN_VERDICT && avgExcess > 0 && lo > 0.5 && beatsSector) {
    return { grade: 'validated', reason: `Beats SPY ${beatMktRate}% of ${excessN} (avg +${avgExcess}%, Wilson lo ${stats.beatLo}%>50%)${sectorKnown ? ` and its sector (+${avgSecExcess}%)` : ''}.`, stats };
  }
  // Beats the market but NOT its sector → the edge is sector beta, not selection.
  if (excessN >= MIN_VERDICT && avgExcess > 0 && lo > 0.5 && sectorKnown && avgSecExcess <= 0) {
    return { grade: 'promising', reason: `Beats SPY (+${avgExcess}%) but NOT its sector (${avgSecExcess > 0 ? '+' : ''}${avgSecExcess}%) — edge looks like sector beta, not selection.`, stats };
  }
  // Promising — positive point estimate, not yet significant / not yet enough samples.
  if (excessN >= MIN_PROMISING && avgExcess > 0) {
    return { grade: 'promising', reason: `Positive so far (avg +${avgExcess}% vs SPY over ${excessN}) but not yet proven — Wilson lo ${stats.beatLo}%≤50%.`, stats };
  }
  // Enough samples but flat/underwater without being significantly bad → still experimental.
  if (excessN >= MIN_PROMISING) {
    return { grade: 'experimental', reason: `Mixed so far (avg ${avgExcess > 0 ? '+' : ''}${avgExcess}% vs SPY over ${excessN}) — no verdict.`, stats };
  }
  return { grade: 'experimental', reason: `Only ${excessN} resolved — too few for a verdict.`, stats };
}

// Pool a scoreboard section's tiers into ONE benchmark-relative track record at the
// intended horizon, then grade it. `groups` = scoreboard summary.groups filtered to a
// section; each group has { tier, horizons: { <metric>: { excessN, avgExcess, beatMktRate } } }.
// Pooling is excessN-weighted so a big proven tier isn't diluted by a tiny noisy one.
function poolSectionTrack(groups, horizon) {
  const metric = HORIZON_METRIC[horizon] || '1m';
  let n = 0, wExcess = 0, beatWins = 0;            // vs market (SPY)
  let sn = 0, wSec = 0, secWins = 0;               // vs sector ETF
  for (const g of groups) {
    const h = g.horizons && (g.horizons[metric] || g.horizons['1m'] || g.horizons['5d']);
    if (!h) continue;
    if (Number.isFinite(h.excessN) && h.excessN && Number.isFinite(h.avgExcess) && Number.isFinite(h.beatMktRate)) {
      n += h.excessN; wExcess += h.avgExcess * h.excessN; beatWins += Math.round((h.beatMktRate / 100) * h.excessN);
    }
    if (Number.isFinite(h.secExcN) && h.secExcN && Number.isFinite(h.avgSecExcess) && Number.isFinite(h.beatSecRate)) {
      sn += h.secExcN; wSec += h.avgSecExcess * h.secExcN; secWins += Math.round((h.beatSecRate / 100) * h.secExcN);
    }
  }
  if (!n) return { excessN: 0, avgExcess: null, beatMktRate: null, secExcN: sn, avgSecExcess: sn ? +(wSec / sn).toFixed(2) : null, beatSecRate: sn ? +((secWins / sn) * 100).toFixed(0) : null };
  return {
    excessN: n, avgExcess: +(wExcess / n).toFixed(2), beatMktRate: +((beatWins / n) * 100).toFixed(0),
    secExcN: sn, avgSecExcess: sn ? +(wSec / sn).toFixed(2) : null, beatSecRate: sn ? +((secWins / sn) * 100).toFixed(0) : null,
  };
}

// Grade one registry entry against a scoreboard summary. Informational entries and any
// with a forced grade short-circuit; everything else earns its grade from data.
function gradeStrategy(entry, summary) {
  const base = {
    id: entry.id, label: entry.label, horizon: entry.horizon || 'swing',
    kind: entry.kind || 'signal', core: !!entry.core, section: entry.section || null,
    criteria: entry.criteria || null,
  };
  if (entry.kind === 'informational') {
    return { ...base, grade: 'informational', reason: entry.note || GRADE_META.informational.blurb, stats: null, inLab: false };
  }
  if (entry.forceGrade && GRADE_META[entry.forceGrade]) {
    return { ...base, grade: entry.forceGrade, reason: entry.note || GRADE_META[entry.forceGrade].blurb, stats: null, inLab: !entry.core && entry.forceGrade !== 'validated' };
  }
  const groups = ((summary && summary.groups) || []).filter(g => entry.section && g.section === entry.section);
  let graded;
  if (!groups.length) {
    graded = { grade: 'experimental', reason: entry.note || 'Not yet tracked in the Scoreboard — accruing.', stats: { excessN: 0, avgExcess: null, beatMktRate: null, beatLo: null, beatHi: null } };
  } else {
    graded = gradeTrack(poolSectionTrack(groups, base.horizon));
  }
  // Research Lab = a non-core signal strategy that has NOT earned Validated. Core
  // backbone screeners stay in the main workspaces regardless (they're the app's
  // tradeable tools); a lab overlay graduates the moment it reaches Validated.
  const inLab = !base.core && graded.grade !== 'validated';
  return { ...base, ...graded, inLab };
}

// Grade the whole registry. Returns entries sorted strongest-grade-first, with a
// per-grade tally and the Research-Lab membership list.
function classifyStrategies(summary, registry) {
  const out = (registry || []).map(e => gradeStrategy(e, summary));
  out.sort((a, b) => (GRADE_META[b.grade].rank - GRADE_META[a.grade].rank)
    || ((b.stats?.excessN || 0) - (a.stats?.excessN || 0))
    || a.label.localeCompare(b.label));
  const counts = {};
  for (const g of GRADES) counts[g] = out.filter(s => s.grade === g).length;
  return { generatedAt: summary?.generatedAt || null, version: MATURITY_VERSION, counts, strategies: out, lab: out.filter(s => s.inLab).map(s => s.id) };
}

module.exports = {
  MATURITY_VERSION, GRADE_META, GRADES, MIN_VERDICT, MIN_PROMISING, HORIZON_METRIC,
  gradeTrack, poolSectionTrack, gradeStrategy, classifyStrategies,
};

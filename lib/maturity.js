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

const MATURITY_VERSION = 'maturity-v2';

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
const MIN_VERDICT = 20;    // needed to earn Disabled (a protective demotion verdict)
const MIN_PROMISING = 8;   // needed to leave Experimental ("accruing") for Promising
// PROMOTION-GRADE gates (maturity-v2) — Validated is the grade governance converts
// into live clearance, so it carries the strategy-gate PROMOTION_GATE sample bars:
const MIN_VALIDATED_EPISODES = 50;  // resolved episodes (was 20 — too thin for a promotion grade)
const MIN_VALIDATED_DATES = 20;     // distinct independent decision dates, must be KNOWN (no raw-pick fallback)

// Which realized-return horizon we grade each intended holding period on. Mirrors the
// decision engine's HORIZON_METRIC so a swing setup is judged on its swing outcome.
const HORIZON_METRIC = { intraday: '1d', swing: '5d', position: '1m', portfolio: '3m' };

// Grade a SINGLE pooled track record against its baselines. Primary baseline = the
// market (SPY): excessN / avgExcess / beatMktRate. Secondary baseline = the SECTOR
// ETF (secExcN / avgSecExcess / beatSecRate) — required so a strategy can't earn
// "Validated" just by riding a hot sector (the spec's "control for sector"). Returns
// { grade, reason, stats:{ …, baselines:{ market, sector } } }.
// `opts.fillVerified` — whether this strategy's grading pipeline proves an executable
// fill (lib/strategy-contracts.js `fillVerified`). Default FALSE = fail closed:
// proxy (close-to-close, level-assumed) outcomes may stay visible as diagnostics but
// can never drive the promotion grade (Phase-1 rule 8).
function gradeTrack(track, opts = {}) {
  const fillVerified = opts.fillVerified === true;
  const grossN = (track && Number.isFinite(track.excessN)) ? track.excessN : 0;
  const grossAvg = (track && Number.isFinite(track.avgExcess)) ? track.avgExcess : null;
  const grossBeat = (track && Number.isFinite(track.beatMktRate)) ? track.beatMktRate : null;
  // COST-NET FIRST (quant-redesign-3 H5): when the pooled track carries the net-of-cost
  // channel (spread+slippage, borrow for shorts), the GRADE is earned on it — a sleeve
  // whose gross excess is eaten by friction must not reach Validated. Gross remains as
  // a labeled fallback for summaries that predate the net wiring.
  const netN = (track && Number.isFinite(track.netExcessN)) ? track.netExcessN : 0;
  const netAvg = (track && Number.isFinite(track.avgNetExcess)) ? track.avgNetExcess : null;
  const netBeat = (track && Number.isFinite(track.netBeatMktRate)) ? track.netBeatMktRate : null;
  const useNet = netN > 0 && netAvg !== null && netBeat !== null;
  const basis = useNet ? 'net' : 'gross';
  const excessN = useNet ? netN : grossN;
  const avgExcess = useNet ? netAvg : grossAvg;
  const beatMktRate = useNet ? netBeat : grossBeat;
  const secExcN = (track && Number.isFinite(track.secExcN)) ? track.secExcN : 0;
  const avgSecExcess = (track && Number.isFinite(track.avgSecExcess)) ? track.avgSecExcess : null;
  const beatSecRate = (track && Number.isFinite(track.beatSecRate)) ? track.beatSecRate : null;
  const sector = { n: secExcN, avgExcess: avgSecExcess, beatRate: beatSecRate };
  // INDEPENDENT DECISION DATES (H5): same-day picks share the market factor, so the
  // Wilson bound runs on distinct decision dates when the summary carries them; raw
  // pick counts remain only as a labeled fallback for older summaries.
  const dates = (track && Number.isFinite(track.dates) && track.dates > 0) ? track.dates : null;
  const verdictN = dates != null ? Math.min(dates, excessN) : excessN;
  const independenceBasis = dates != null ? 'independent-dates' : 'raw-picks (dates unavailable)';

  if (!excessN || avgExcess === null || beatMktRate === null) {
    return { grade: 'experimental', reason: 'No resolved picks with a benchmark yet — accruing.', stats: { excessN, avgExcess, beatMktRate, beatLo: null, beatHi: null, basis, independenceBasis, dates, baselines: { market: { n: excessN, avgExcess, beatRate: beatMktRate }, sector } } };
  }

  // Conservative bound on "beats the market more than half the time" — sample-aware,
  // over INDEPENDENT decision dates where available (not correlated same-day picks).
  const beatWins = Math.round((beatMktRate / 100) * verdictN);
  const { lo, hi } = wilson(beatWins, verdictN);
  const stats = { excessN, avgExcess, beatMktRate, beatLo: +(lo * 100).toFixed(0), beatHi: +(hi * 100).toFixed(0), basis, independenceBasis, dates, verdictN, fillVerified, dateNet: (track && track.dateNet) || null, baselines: { market: { n: excessN, avgExcess, beatRate: beatMktRate }, sector } };
  // Sector baseline only counts as a real control when it has enough resolved picks.
  const sectorKnown = secExcN >= MIN_PROMISING && avgSecExcess !== null;
  const beatsSector = !sectorKnown || avgSecExcess > 0;

  const netTag = basis === 'net' ? 'net of costs ' : '';
  // Disabled — enough INDEPENDENT evidence AND significantly (or materially) losing.
  if (verdictN >= MIN_VERDICT && avgExcess < 0 && (hi < 0.5 || avgExcess <= -1)) {
    return { grade: 'disabled', reason: `Underperforms the market ${netTag}over ${excessN} resolved / ${verdictN} independent (avg ${avgExcess > 0 ? '+' : ''}${avgExcess}% vs SPY, beats ${beatMktRate}%).`, stats };
  }
  // Validated (maturity-v2) — the promotion grade. Every gate below FAILS CLOSED to
  // Promising with an explicit reason; a positive-but-unproven record stays honest:
  //   1. cost-net channel required (friction decides which sleeves are real)
  //   2. SECTOR control required — a missing sector record can no longer pass open
  //   3. ≥50 resolved episodes AND ≥20 KNOWN independent decision dates
  //   4. DATE-LEVEL portfolio net-excess 95% CI must exclude zero — a pick-level
  //      beat rate projected onto a date count treats correlated same-day picks
  //      as independent evidence and is no longer accepted as the verdict statistic
  //   5. executable-fill grading required (contract fillVerified) — proxy outcomes
  //      (signal-close, level-assumed) remain visible diagnostics but cannot promote
  if (verdictN >= MIN_VERDICT && avgExcess > 0 && lo > 0.5 && beatsSector) {
    if (basis !== 'net') {
      return { grade: 'promising', reason: `Beats SPY gross (${beatMktRate}% of ${excessN}, avg +${avgExcess}%) but the record carries NO cost-net channel — Validated requires net-of-cost evidence.`, stats };
    }
    if (!sectorKnown) {
      return { grade: 'promising', reason: `Beats SPY ${netTag}but has NO sector-relative record (${secExcN} sector-benchmarked resolved) — the sector control is required and fails closed.`, stats };
    }
    if (excessN < MIN_VALIDATED_EPISODES) {
      return { grade: 'promising', reason: `Beats SPY ${netTag}but only ${excessN} resolved episodes — Validated requires ≥${MIN_VALIDATED_EPISODES}.`, stats };
    }
    if (dates == null || dates < MIN_VALIDATED_DATES) {
      return { grade: 'promising', reason: dates == null
        ? `Beats SPY ${netTag}but independent decision dates are UNKNOWN — Validated requires ≥${MIN_VALIDATED_DATES} known distinct dates (no raw-pick fallback).`
        : `Beats SPY ${netTag}but only ${dates} independent decision dates — Validated requires ≥${MIN_VALIDATED_DATES}.`, stats };
    }
    const dn = track && track.dateNet;
    const dnOk = dn && Number.isFinite(dn.n) && dn.n >= MIN_VALIDATED_DATES
      && dn.ci95 && Number.isFinite(dn.ci95.lo) && dn.ci95.lo > 0;
    if (!dnOk) {
      return { grade: 'promising', reason: dn
        ? `Date-level portfolio net excess (${dn.n} dates, avg ${dn.avg > 0 ? '+' : ''}${dn.avg}%, 95% CI [${dn.ci95 ? dn.ci95.lo : '?'}, ${dn.ci95 ? dn.ci95.hi : '?'}]) does not exclude zero — Validated requires the date-level CI clear of zero.`
        : 'No date-level portfolio return evidence — Validated requires per-date net-excess statistics (fails closed).', stats };
    }
    if (!fillVerified) {
      return { grade: 'promising', reason: `Beats SPY ${netTag}on a fill-UNVERIFIED (proxy) grading pipeline — proxy outcomes cannot drive Validated; the pipeline must prove executable fills first (contract fillVerified).`, stats };
    }
    return { grade: 'validated', reason: `Beats SPY ${netTag}${beatMktRate}% of ${excessN} resolved / ${dates} independent dates (avg +${avgExcess}%, Wilson lo ${stats.beatLo}%>50%, date-level CI [+${dn.ci95.lo}, +${dn.ci95.hi}]) and its sector (+${avgSecExcess}%), on verified executable fills.`, stats };
  }
  // Beats the market but NOT its sector → the edge is sector beta, not selection.
  if (verdictN >= MIN_VERDICT && avgExcess > 0 && lo > 0.5 && sectorKnown && avgSecExcess <= 0) {
    return { grade: 'promising', reason: `Beats SPY ${netTag}(+${avgExcess}%) but NOT its sector (${avgSecExcess > 0 ? '+' : ''}${avgSecExcess}%) — edge looks like sector beta, not selection.`, stats };
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
// `horizonOrOpts` — a legacy horizon string ('swing') or `{ metric }` from the
// strategy's outcome contract (lib/strategy-contracts.js). STRICT (quant-redesign-3
// H4): only the strategy's OWN metric is read. The old silent fallback to a DIFFERENT
// horizon ('1m', then '5d') meant e.g. an intraday strategy with an empty 1d bucket
// was quietly graded on 1-month drift — a substituted contract with no flag anywhere.
function poolSectionTrack(groups, horizonOrOpts) {
  const metric = (horizonOrOpts && typeof horizonOrOpts === 'object')
    ? (horizonOrOpts.metric || '1m')
    : (HORIZON_METRIC[horizonOrOpts] || '1m');
  let n = 0, wExcess = 0, beatWins = 0;            // vs market (SPY), gross
  let nn = 0, wNet = 0, netWins = 0;               // vs market, NET of costs (+borrow, shorts)
  let sn = 0, wSec = 0, secWins = 0;               // vs sector ETF
  let dates = 0;                                    // independent decision dates (conservative: max per tier)
  let dateNet = null;                               // date-level portfolio stats (largest-dates tier — see below)
  for (const g of groups) {
    const h = g.horizons && g.horizons[metric];
    if (!h) continue;
    if (Number.isFinite(h.excessN) && h.excessN && Number.isFinite(h.avgExcess) && Number.isFinite(h.beatMktRate)) {
      n += h.excessN; wExcess += h.avgExcess * h.excessN; beatWins += Math.round((h.beatMktRate / 100) * h.excessN);
    }
    if (Number.isFinite(h.netExcessN) && h.netExcessN && Number.isFinite(h.avgNetExcess) && Number.isFinite(h.netBeatMktRate)) {
      nn += h.netExcessN; wNet += h.avgNetExcess * h.netExcessN; netWins += Math.round((h.netBeatMktRate / 100) * h.netExcessN);
    }
    if (Number.isFinite(h.secExcN) && h.secExcN && Number.isFinite(h.avgSecExcess) && Number.isFinite(h.beatSecRate)) {
      sn += h.secExcN; wSec += h.avgSecExcess * h.secExcN; secWins += Math.round((h.beatSecRate / 100) * h.secExcN);
    }
    // Distinct-date counts can't be unioned across tiers without the raw dates, so the
    // pooled figure takes the LARGEST single tier — a lower bound on the section's true
    // union, i.e. conservative for the significance gate.
    if (Number.isFinite(h.dates) && h.dates > dates) dates = h.dates;
    // Date-level stats can't be pooled from aggregates either: the LARGEST single tier
    // (by date count) must independently clear the date-level CI gate — conservative,
    // and labeled so the verdict basis is auditable.
    if (h.dateNet && Number.isFinite(h.dateNet.n) && (!dateNet || h.dateNet.n > dateNet.n)) {
      dateNet = { ...h.dateNet, poolingBasis: 'largest-dates-tier (cross-tier date union unavailable from aggregates)' };
    }
  }
  const base = {
    metric,
    secExcN: sn, avgSecExcess: sn ? +(wSec / sn).toFixed(2) : null, beatSecRate: sn ? +((secWins / sn) * 100).toFixed(0) : null,
    netExcessN: nn, avgNetExcess: nn ? +(wNet / nn).toFixed(2) : null, netBeatMktRate: nn ? +((netWins / nn) * 100).toFixed(0) : null,
    dates: dates || null,
    dateNet,
  };
  if (!n) return { ...base, excessN: 0, avgExcess: null, beatMktRate: null };
  return {
    ...base,
    excessN: n, avgExcess: +(wExcess / n).toFixed(2), beatMktRate: +((beatWins / n) * 100).toFixed(0),
  };
}

// Grade one registry entry against a scoreboard summary. Informational entries and any
// with a forced grade short-circuit; everything else earns its grade from data.
function gradeStrategy(entry, summary) {
  const base = {
    id: entry.id, label: entry.label, horizon: entry.horizon || 'swing',
    kind: entry.kind || 'signal', core: !!entry.core, section: entry.section || null,
    criteria: entry.criteria || null,
    // Scoring version rides through to governance so its version-reset guard is LIVE
    // (quant-redesign-3 H7 — the guard compared versions that were always null).
    version: entry.scoringVersion || null,
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
    // Grade on the strategy's OWN outcome contract metric (lib/strategy-contracts.js),
    // not a generic horizon guess; strict — no silent substitution of another horizon.
    const SC = require('./strategy-contracts');
    const { metric, basis } = SC.metricFor(entry.id, HORIZON_METRIC[base.horizon] || '1m');
    // fillVerified rides in from the contract: a strategy with no contract, or whose
    // grading pipeline has not proven executable fills, fails closed (proxy outcomes
    // cannot earn the promotion grade).
    const contract = SC.contractFor(entry.id);
    graded = gradeTrack(poolSectionTrack(groups, { metric }), { fillVerified: !!(contract && contract.fillVerified) });
    if (graded && graded.stats) graded.stats.metricBasis = basis;
    if (graded && graded.grade === 'experimental' && graded.stats && !graded.stats.excessN) {
      graded = { ...graded, reason: `No resolved record at this strategy's own contract horizon (${metric}) yet — accruing (no substitute horizon is used).` };
    }
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
  MATURITY_VERSION, GRADE_META, GRADES, MIN_VERDICT, MIN_PROMISING,
  MIN_VALIDATED_EPISODES, MIN_VALIDATED_DATES, HORIZON_METRIC,
  gradeTrack, poolSectionTrack, gradeStrategy, classifyStrategies,
};

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

const MATURITY_VERSION = 'maturity-v4';

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
// redesign Phase 5: raw date counts overstate independence when consecutive decisions
// share an overlapping label path. The EFFECTIVE (autocorrelation-adjusted) date count and
// chronological block stability are separate, additional gates — both fail closed.
const MIN_EFFECTIVE_DATES = 12;
const MIN_POSITIVE_BLOCKS = 3;      // of 4 chronological blocks
// Ceiling on the share of a group's picks that are ungradeable for want of price
// history. Survivorship inside the record: these are overwhelmingly delistings and
// acquisitions, whose absence biases the surviving sample in the direction of the
// thing being measured. 5% is a disclosure threshold, not a validated tolerance.
const NO_HISTORY_MAX_RATE = 0.05;
// Benjamini-Hochberg false-discovery rate across every strategy graded in one run.
const FDR_ALPHA = 0.05;

// Which realized-return horizon we grade each intended holding period on. Mirrors the
// decision engine's HORIZON_METRIC so a swing setup is judged on its swing outcome.
const HORIZON_METRIC = { intraday: '1d', swing: '5d', position: '1m', portfolio: '3m' };

// Ledger tiers that are RESEARCH LANES, never promotion evidence for the section's
// registered strategy: BROAD_* (independent shadow discovery, own record) and HIST_*
// (historical reconstructions reclassified at Scoreboard read time — reconstructed
// history can inform research but can never satisfy prospective confirmation).
const EXCLUDED_TIER_PREFIXES = ['BROAD_', 'HIST_'];

// Grade a SINGLE pooled track record against its baselines. Primary baseline = the
// market (SPY): excessN / avgExcess / beatMktRate. Secondary baseline = the SECTOR
// ETF (secExcN / avgSecExcess / beatSecRate) — required so a strategy can't earn
// "Validated" just by riding a hot sector (the spec's "control for sector"). Returns
// { grade, reason, stats:{ …, baselines:{ market, sector } } }.
// `opts.fillVerified` — whether this strategy's grading pipeline proves an executable
// fill (lib/strategy-contracts.js `fillVerified`). Default FALSE = fail closed:
// proxy (close-to-close, level-assumed) outcomes may stay visible as diagnostics but
// can never drive the promotion grade (Phase-1 rule 8).
// A strategy's own promotion `criteria` may declare that it must beat a NAMED
// baseline — not just SPY and its sector, but the thing it is suspected of
// duplicating: the screener it correlates 0.96 with, the WATCH control it was
// split from, plain 12-1 momentum. Those sentences were carried through to the
// payload as prose and read by nothing (F-12), so `validated` could be awarded to
// a strategy whose own declared bar had never been computed.
//
// Two phrasings are used in the registry and both mean the same thing:
//   • the word "incremental"          — "incremental lift over the WATCH control"
//   • a paired "on identical dates"   — "beating plain 12-1 momentum ... on
//                                        identical dates" (a same-date A/B)
// Over-matching is the SAFE direction here: a false positive only makes the gate
// stricter (it fails closed), while a false negative silently restores the defect.
const INCREMENTAL_DECLARED_RE = /incremental|identical dates/i;

function declaresIncrementalGate(criteria) {
  return typeof criteria === 'string' && INCREMENTAL_DECLARED_RE.test(criteria);
}

// Normalised declared-incremental contract, or null when nothing was declared.
// BOTH grading paths build it through here: a strategy with resolved rows (via
// gradeTrack) and one still accruing (which short-circuits before gradeTrack).
// The payload shape must not depend on whether a strategy happens to have a
// record yet — that dependence is what left 9 of 10 declarers advertising
// nothing, the same invisibility F-12 was about.
function incrementalContract(inc) {
  if (!inc || inc.declared !== true) return null;
  return { declared: true, measured: inc.measured === true, cleared: inc.cleared === true, source: inc.source || null };
}

// F-11 (review half). lib/cfl/prosecutor composes the repo's adversarial controls
// into `prosecuteClaim`, whose entire purpose is to challenge a claimed edge
// before it is believed — and it had ZERO production callers. Every strategy
// reached its grade without one adversarial question being asked of it.
//
// Prosecution runs on the DATE-LEVEL portfolio series, not per-pick nets: a
// same-day cluster is one observation everywhere else in this file, so "does the
// edge survive excising its best DATES, or is it carried by one of them" is the
// honest form of the question.
//
// WHAT BLOCKS Validated, and why the line sits here:
//   • REJECTED — a leak/placebo test FAILED; the claim is invalid, not weak.
//   • a check that RAN and failed (excision / concentration).
//   • a check that could NOT run is recorded in `unrun` and does NOT block.
// That last clause is a judgement, not an oversight: prosecuteClaim marks unrun
// checks `ok:null` and folds them into RESEARCH, so demanding a full SURVIVES
// would block EVERY strategy from Validated until a feature-sample channel is
// wired — a policy change nobody asked for. Unrun is surfaced loudly instead of
// being silently counted as a pass. Tightening it is a one-line change.
// Largest single observation and the date it fell on (null when dates are absent
// — older summaries predate the dates channel).
function peakOf(values, dates) {
  if (!values || !values.length) return null;
  let idx = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[idx]) idx = i;
  const date = (dates && dates.length === values.length) ? dates[idx] : null;
  if (!date) return null;
  return { date, value: values[idx], index: idx + 1, of: values.length };
}

function prosecuteRecord(dateNet) {
  const values = dateNet && Array.isArray(dateNet.values)
    ? dateNet.values.filter(v => Number.isFinite(v)) : null;
  // The session carrying the tail, when the series arrived with its dates. A
  // concentration verdict that cannot be traced to a date is not actionable.
  const dates = dateNet && Array.isArray(dateNet.dates) ? dateNet.dates : null;
  if (!values || !values.length) {
    return { ran: false, blocked: false, verdict: null, checks: [], unrun: [],
      reason: 'no per-date portfolio series on this record — the claim is UNPROSECUTED, which is not the same as prosecuted and cleared' };
  }
  const { prosecuteClaim } = require('./cfl/prosecutor');
  const res = prosecuteClaim({ trades: values.map(net => ({ net })) });
  const checks = res.checks || [];
  const failed = checks.filter(c => c.ok === false).map(c => c.check);
  const unrun = checks.filter(c => c.ok == null).map(c => c.check);
  // ONLY the calibrated statistic (and a genuine leak REJECTION) can block. The
  // raw excision/concentration checks use absolute thresholds that were shown
  // twice to convict on dispersion — screener at the 49.6th percentile of its
  // own null, events where 83% of matched null draws fail the same test. They
  // stay as descriptives on `failed`; they no longer take a grade away.
  const calibrated = checks.find(c => c.check === 'null-calibrated-concentration');
  return {
    ran: true,
    verdict: res.verdict,                       // the prosecutor's own, unmodified
    blocked: res.verdict === 'REJECTED' || (calibrated && calibrated.ok === false),
    blockedBy: res.verdict === 'REJECTED' ? 'leak-control' : (calibrated && calibrated.ok === false) ? 'null-calibrated-concentration' : null,
    calibrated: calibrated ? calibrated.detail : null,
    peak: peakOf(values, dates),
    failed, unrun, checks,
    basis: 'date-level portfolio net-excess series (one equal-weight observation per decision date)',
  };
}

function gradeTrack(track, opts = {}) {
  const fillVerified = opts.fillVerified === true;
  // The declared-incremental contract: { declared, measured, cleared, source }.
  // Absent entirely = this strategy never declared such a bar; declared with no
  // measurement = unproven, which is not the same as passed.
  const incremental = incrementalContract(opts.incremental);
  // F-11: adversarial challenge of this record, run on its own date-level series.
  const prosecution = prosecuteRecord(track && track.dateNet);
  // UNGRADEABLE SHARE (alpha-research pass 3). Picks whose ticker has no price history —
  // delisted, acquired, bankrupt, long-halted — are counted by the Scoreboard but can
  // enter no statistic. Delisting is not missing-at-random with respect to the outcome
  // being graded, so a group carrying a material unaccounted share cannot claim a
  // validated record. null (a summary written before the counter existed) fails CLOSED
  // for Validated only: an unmeasurable share is not a provable one.
  const noHistoryRate = Number.isFinite(opts.noHistoryRate) ? opts.noHistoryRate : null;
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
  // Sector control prefers the COST-NET channel (same treatment as the market gate —
  // the gross sector lane was one round-trip easier); gross remains a labeled fallback
  // for summaries predating the netSecExc wiring.
  const netSecN = (track && Number.isFinite(track.netSecExcN)) ? track.netSecExcN : 0;
  const useNetSec = netSecN > 0 && Number.isFinite(track && track.avgNetSecExcess);
  const secExcN = useNetSec ? netSecN : ((track && Number.isFinite(track.secExcN)) ? track.secExcN : 0);
  const avgSecExcess = useNetSec ? track.avgNetSecExcess : ((track && Number.isFinite(track.avgSecExcess)) ? track.avgSecExcess : null);
  const beatSecRate = useNetSec
    ? ((track && Number.isFinite(track.netBeatSecRate)) ? track.netBeatSecRate : null)
    : ((track && Number.isFinite(track.beatSecRate)) ? track.beatSecRate : null);
  const sector = { n: secExcN, avgExcess: avgSecExcess, beatRate: beatSecRate, basis: useNetSec ? 'net' : 'gross' };
  // INDEPENDENT DECISION DATES (H5): same-day picks share the market factor, so the
  // Wilson bound runs on distinct decision dates when the summary carries them; raw
  // pick counts remain only as a labeled fallback for older summaries.
  const dates = (track && Number.isFinite(track.dates) && track.dates > 0) ? track.dates : null;
  const verdictN = dates != null ? Math.min(dates, excessN) : excessN;
  const independenceBasis = dates != null ? 'independent-dates' : 'raw-picks (dates unavailable)';

  if (!excessN || avgExcess === null || beatMktRate === null) {
    return { grade: 'experimental', reason: 'No resolved picks with a benchmark yet — accruing.', stats: { excessN, avgExcess, beatMktRate, beatLo: null, beatHi: null, basis, independenceBasis, dates, baselines: { market: { n: excessN, avgExcess, beatRate: beatMktRate, basis }, sector } } };
  }

  // Conservative bound on "beats the market more than half the time" — sample-aware,
  // over INDEPENDENT decision dates where available (not correlated same-day picks).
  const beatWins = Math.round((beatMktRate / 100) * verdictN);
  const { lo, hi } = wilson(beatWins, verdictN);
  const stats = { excessN, avgExcess, beatMktRate, beatLo: +(lo * 100).toFixed(0), beatHi: +(hi * 100).toFixed(0), basis, independenceBasis, dates, verdictN, fillVerified, dateNet: (track && track.dateNet) || null, baselines: { market: { n: excessN, avgExcess, beatRate: beatMktRate, basis }, sector }, incremental, prosecution };
  // Sector baseline only counts as a real control when it has enough resolved picks.
  const sectorKnown = secExcN >= MIN_PROMISING && avgSecExcess !== null;
  const beatsSector = !sectorKnown || avgSecExcess > 0;

  const netTag = basis === 'net' ? 'net of costs ' : '';
  // Disabled — protective demotion. Two dependence-aware routes:
  //   (a) enough INDEPENDENT evidence AND significantly (or materially) losing;
  //   (b) the DATE-LEVEL portfolio CI (HAC-widened upstream) sits entirely below zero.
  const dn0 = track && track.dateNet;
  const dateNetSignificantlyNegative = !!(dn0 && Number.isFinite(dn0.n) && dn0.n >= MIN_VERDICT
    && dn0.ci95 && Number.isFinite(dn0.ci95.hi) && dn0.ci95.hi < 0);
  if ((verdictN >= MIN_VERDICT && avgExcess < 0 && (hi < 0.5 || avgExcess <= -1)) || dateNetSignificantlyNegative) {
    return { grade: 'disabled', reason: dateNetSignificantlyNegative
      ? `Date-level portfolio net excess is significantly NEGATIVE (${dn0.n} dates, avg ${dn0.avg}%, 95% CI [${dn0.ci95.lo}, ${dn0.ci95.hi}]) — demoted.`
      : `Underperforms the market ${netTag}over ${excessN} resolved / ${verdictN} independent (avg ${avgExcess > 0 ? '+' : ''}${avgExcess}% vs SPY, beats ${beatMktRate}%).`, stats };
  }
  // High hit rate cannot rescue negative expectancy: wins-often/loses-money is a
  // rejected shape, never a promotable one (the mirror of the low-hit/high-payoff
  // acceptance below — utility decides, hit rate never does).
  if (excessN >= MIN_PROMISING && avgExcess !== null && avgExcess <= 0 && beatMktRate !== null && beatMktRate > 50) {
    return { grade: 'experimental', reason: `Beats the market on ${beatMktRate}% of picks but expectancy is ${avgExcess}% ${netTag}— a positive hit rate cannot rescue negative utility; no verdict.`, stats };
  }
  // Validated (maturity-v3) — the promotion grade, earned on the strategy's PRIMARY
  // UTILITY metric: the date-level cost-net portfolio excess. The maturity-v2 gate
  // additionally required a pick-level >50% beat rate (Wilson lower bound), which
  // structurally rejected low-hit/high-payoff strategies with genuinely positive
  // utility — hit rate is now DESCRIPTIVE ONLY (reported in stats, never a gate).
  // Every gate below FAILS CLOSED to Promising with an explicit reason:
  //   1. cost-net channel required (friction decides which sleeves are real)
  //   2. SECTOR control required — a missing sector record can no longer pass open
  //   3. ≥50 resolved episodes AND ≥20 KNOWN independent decision dates
  //   4. DATE-LEVEL portfolio net-excess 95% CI (HAC/Newey-West-widened upstream for
  //      overlapping multi-session labels) must exclude zero — a pick-level beat rate
  //      projected onto a date count treats correlated same-day picks as independent
  //      evidence and is not accepted as the verdict statistic
  //   5. executable-fill grading required (contract fillVerified) — proxy outcomes
  //      (signal-close, level-assumed) remain visible diagnostics but cannot promote
  if (verdictN >= MIN_VERDICT && avgExcess > 0 && beatsSector) {
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
    // EFFECTIVE sample size (Phase 5 item 6): autocorrelated dates are not independent
    // evidence. Reported by dateLevelNetExcess; absent on summaries written before it
    // existed ⇒ fail closed (an unprovable independence claim cannot promote).
    if (!Number.isFinite(dn.effectiveN) || dn.effectiveN < MIN_EFFECTIVE_DATES) {
      return { grade: 'promising', reason: Number.isFinite(dn.effectiveN)
        ? `Only ${dn.effectiveN} EFFECTIVE independent dates after the autocorrelation adjustment (${dn.n} raw) — Validated requires ≥${MIN_EFFECTIVE_DATES}.`
        : 'Effective sample size unavailable on this evidence record — independence is unproven and Validated fails closed.', stats };
    }
    // BLOCK STABILITY (Phase 5 item 6): an edge that lives in one chronological block is
    // a regime artifact, not a strategy.
    if (!dn.blockStability || !dn.blockStability.usable || dn.positiveBlocks < MIN_POSITIVE_BLOCKS) {
      return { grade: 'promising', reason: dn.blockStability && dn.blockStability.usable
        ? `Positive in only ${dn.positiveBlocks} of ${dn.blockStability.blocks} chronological blocks (means ${JSON.stringify(dn.blockStability.means)}) — Validated requires ≥${MIN_POSITIVE_BLOCKS}.`
        : 'Too few dates to measure chronological block stability — Validated requires it (fails closed).', stats };
    }
    if (!fillVerified) {
      return { grade: 'promising', reason: `Beats SPY ${netTag}on a fill-UNVERIFIED (proxy) grading pipeline — proxy outcomes cannot drive Validated; the pipeline must prove executable fills first (contract fillVerified).`, stats };
    }
    if (noHistoryRate === null || noHistoryRate > NO_HISTORY_MAX_RATE) {
      return { grade: 'promising', reason: noHistoryRate === null
        ? 'The ungradeable (no-price-history) share of this record is UNMEASURED — delisted and acquired names would be silently absent from every statistic, so Validated fails closed.'
        : `${(noHistoryRate * 100).toFixed(1)}% of this record's picks have no price history (delisted / acquired / halted) and enter no statistic — above the ${(NO_HISTORY_MAX_RATE * 100).toFixed(0)}% ceiling, the surviving sample cannot support Validated.`, stats };
    }
    //   6. DECLARED INCREMENTAL BAR (F-12). Beating SPY and its sector does not answer
    //      "does this add anything the sleeve it duplicates does not?". Where a strategy
    //      wrote that question into its OWN criteria, it must be measured and cleared.
    //      Unmeasured is not passed — the whole defect was reading silence as clearance.
    if (incremental && !(incremental.measured && incremental.cleared)) {
      return { grade: 'promising', reason: incremental.measured
        ? `Clears every market/sector gate, but its own criteria declare an INCREMENTAL bar over a named baseline and the measured artifact${incremental.source ? ` (${incremental.source})` : ''} does not clear it — Validated fails closed.`
        : 'Clears every market/sector gate, but its own criteria declare an INCREMENTAL bar over a named baseline that has never been measured — an unmeasured requirement is not a cleared one, so Validated fails closed.', stats };
    }
    //   7. ADVERSARIAL PROSECUTION (F-11). A claim nothing ever challenged is not a
    //      validated one. Blocks on a genuine leak/placebo REJECTION or on a check
    //      that ran and failed; checks that could not run are surfaced, not passed.
    if (prosecution.blocked) {
      return { grade: 'promising', reason: prosecution.verdict === 'REJECTED'
        ? 'Clears every utility gate but the adversarial prosecutor REJECTED the claim (a leak/placebo control failed) — Validated fails closed.'
        : `Clears every utility gate but fails adversarial prosecution (${prosecution.failed.join(', ')}) — an edge that dies without its best dates, or is carried by one of them, is concentration rather than alpha.`, stats };
    }
    return { grade: 'validated', reason: `Positive utility ${netTag}over ${excessN} resolved / ${dates} independent dates (avg +${avgExcess}%, date-level CI [+${dn.ci95.lo}, +${dn.ci95.hi}] clear of zero) and beats its sector (+${avgSecExcess}%), on verified executable fills. Hit rate ${beatMktRate}% is descriptive, not a gate.`, stats };
  }
  // Beats the market but NOT its sector → the edge is sector beta, not selection.
  if (verdictN >= MIN_VERDICT && avgExcess > 0 && sectorKnown && avgSecExcess <= 0) {
    return { grade: 'promising', reason: `Beats SPY ${netTag}(+${avgExcess}%) but NOT its sector (${avgSecExcess > 0 ? '+' : ''}${avgSecExcess}%) — edge looks like sector beta, not selection.`, stats };
  }
  // Promising — positive point estimate, not yet cleared by the utility gates above.
  if (excessN >= MIN_PROMISING && avgExcess > 0) {
    return { grade: 'promising', reason: `Positive so far (avg +${avgExcess}% vs SPY over ${excessN}) but the promotion gates are not met (date-level utility CI / sample bars).`, stats };
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
  let sn = 0, wSec = 0, secWins = 0;               // vs sector ETF (gross — legacy channel)
  let nsn = 0, wNetSec = 0, netSecWins = 0;        // vs sector ETF, NET of costs
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
    if (Number.isFinite(h.netSecExcN) && h.netSecExcN && Number.isFinite(h.avgNetSecExcess) && Number.isFinite(h.netBeatSecRate)) {
      nsn += h.netSecExcN; wNetSec += h.avgNetSecExcess * h.netSecExcN; netSecWins += Math.round((h.netBeatSecRate / 100) * h.netSecExcN);
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
    netSecExcN: nsn, avgNetSecExcess: nsn ? +(wNetSec / nsn).toFixed(2) : null, netBeatSecRate: nsn ? +((netSecWins / nsn) * 100).toFixed(0) : null,
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
  // POLICY-COHORT evidence selection (maturity-v3). Section match alone pooled every
  // tier in the section into one grade — including explicit CONTROL cohorts (Ignition
  // WATCH vs IGNITION is the falsifiable contrast, not one strategy), shadow research
  // lanes ledgered under prefixed tiers (BROAD_*), and read-time-reclassified
  // historical reconstructions (HIST_*). The promoted policy is graded on ITS OWN
  // frozen cohort only; everything excluded is listed so controls stay reportable.
  //   entry.policyTiers  — exact tier strings of the frozen selected policy (optional;
  //                        when absent, all non-prefixed tiers pool as before)
  //   entry.policyScopes — exact scope strings of the frozen selected policy (optional;
  //                        when absent, all scopes pool as before). A scoped ledger can
  //                        carry one positive cohort under negative ones (screener
  //                        Early:large vs its small/micro lanes) — the promoted policy
  //                        is graded on its own scope only; excluded scopes stay
  //                        reportable as controls.
  //   EXCLUDED_TIER_PREFIXES — research/reconstruction lanes, never promotion evidence
  const sectionGroups = ((summary && summary.groups) || []).filter(g => entry.section && g.section === entry.section);
  const policyTiers = Array.isArray(entry.policyTiers) && entry.policyTiers.length ? new Set(entry.policyTiers) : null;
  const policyScopes = Array.isArray(entry.policyScopes) && entry.policyScopes.length ? new Set(entry.policyScopes) : null;
  const isExcludedTier = t => typeof t === 'string' && EXCLUDED_TIER_PREFIXES.some(p => t.startsWith(p));
  const groups = sectionGroups.filter(g => !isExcludedTier(g.tier)
    && (!policyTiers || policyTiers.has(g.tier))
    && (!policyScopes || (g.scope != null && policyScopes.has(g.scope))));
  // Excluded-control labels: a group excluded by SCOPE keeps its tier name visible but
  // is disambiguated (`Early@small`) so the report never reads as if the tier itself
  // was dropped; de-duplicated for display.
  const excludedTiers = [...new Set(sectionGroups.filter(g => !groups.includes(g)).map(g =>
    (policyScopes && g.scope != null && !policyScopes.has(g.scope) && (!policyTiers || policyTiers.has(g.tier)))
      ? `${g.tier}@${g.scope}` : g.tier))];
  // F-12: the entry's OWN criteria decide whether it is held to an incremental bar.
  // Hoisted above BOTH paths so an accruing strategy still advertises the bar it
  // declared — the accruing branch hard-codes `experimental` and so can never
  // bypass the gate, but a declared requirement the payload never mentions is the
  // exact invisibility this finding was about.
  const incremental = { declared: declaresIncrementalGate(entry.criteria) };
  let graded;
  if (!groups.length) {
    graded = { grade: 'experimental', reason: entry.note || 'Not yet tracked in the Scoreboard — accruing.', stats: { excessN: 0, avgExcess: null, beatMktRate: null, beatLo: null, beatHi: null, incremental: incrementalContract(incremental) } };
  } else {
    // Grade on the strategy's OWN outcome contract metric (lib/strategy-contracts.js),
    // not a generic horizon guess; strict — no silent substitution of another horizon.
    const SC = require('./strategy-contracts');
    const { metric, basis } = SC.metricFor(entry.id, HORIZON_METRIC[base.horizon] || '1m');
    // fillVerified rides in from the contract: a strategy with no contract, or whose
    // grading pipeline has not proven executable fills, fails closed (proxy outcomes
    // cannot earn the promotion grade).
    // Fill verification comes from the DERIVED episode evidence, never from the contract
    // flag (Phase 6 rule 1): `summary.fillVerification[id]` is produced by
    // lib/episode-ledger.deriveFillVerified over the strategy's own resolved episodes.
    const fv = SC.fillVerifiedFor(entry.id, summary);
    // Ungradeable share, pooled over exactly the groups that form this policy cohort —
    // the same population the track statistics are pooled from, so the ratio describes
    // the record being graded rather than the whole section. `null` when no group
    // carries the counter (a pre-counter summary), which fails Validated closed.
    const nhPicks = groups.reduce((s, g) => s + (Number.isFinite(g.picks) ? g.picks : 0), 0);
    const nhMissing = groups.reduce((s, g) => s + (Number.isFinite(g.noHistory) ? g.noHistory : 0), 0);
    const nhKnown = groups.some(g => Number.isFinite(g.noHistory));
    const noHistoryRate = (nhKnown && nhPicks > 0) ? nhMissing / nhPicks : null;
    // No measured artifact channel exists yet, so a declarer fails closed at
    // Promising until one is wired — the honest state, not a regression.
    graded = gradeTrack(poolSectionTrack(groups, { metric }), { fillVerified: fv.fillVerified, noHistoryRate, incremental });
    if (graded && graded.stats) graded.stats.noHistory = { picks: nhPicks, missing: nhMissing, rate: noHistoryRate };
    if (graded && graded.stats) graded.stats.fillVerification = fv;
    if (graded && graded.stats) graded.stats.metricBasis = basis;
    if (graded && graded.stats) {
      graded.stats.pooledTiers = groups.map(g => g.tier);
      if (excludedTiers.length) graded.stats.excludedTiers = excludedTiers;
    }
    if (graded && graded.grade === 'experimental' && graded.stats && !graded.stats.excessN) {
      graded = { ...graded, reason: `No resolved record at this strategy's own contract horizon (${metric}) yet — accruing (no substitute horizon is used).` };
    }
  }
  // CANONICAL EVIDENCE IDENTITY (Phase 4). Stamped on every graded strategy so governance,
  // calibration and promotion all join on the SAME immutable key — and so a record whose
  // identity cannot be fully established is visibly LEGACY_CONTEXT rather than silently
  // authoritative. Never guessed: unknown axes stay null.
  const EI = require('./evidence-identity');
  const SCr = require('./strategy-contracts');
  const contractFor = SCr.contractFor(entry.id);
  const identity = EI.identityForStrategy(entry, {
    contract: contractFor,
    side: (contractFor && contractFor.side === 'short') ? 'short' : 'long',
    policyTier: (Array.isArray(entry.policyTiers) && entry.policyTiers.length === 1) ? entry.policyTiers[0] : null,
    cohortVersion: (summary && (summary.evidenceKeyVersion || summary.version)) || null,
  });
  base.identity = identity;
  base.identityClass = EI.classifyIdentity(identity);
  base.identityMissingAxes = EI.missingAxes(identity);
  base.mayGovern = EI.mayGovern(identity);

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
  applyFdrAcrossStrategies(out);
  out.sort((a, b) => (GRADE_META[b.grade].rank - GRADE_META[a.grade].rank)
    || ((b.stats?.excessN || 0) - (a.stats?.excessN || 0))
    || a.label.localeCompare(b.label));
  const counts = {};
  for (const g of GRADES) counts[g] = out.filter(s => s.grade === g).length;
  const fdr = {
    version: 'fdr-v1', alpha: FDR_ALPHA, method: 'benjamini-hochberg',
    tested: out.filter(s => s.fdr).length,
    demoted: out.filter(s => s.fdr && s.fdr.demoted).map(s => s.id),
  };
  return { generatedAt: summary?.generatedAt || null, version: MATURITY_VERSION, counts, strategies: out, fdr, lab: out.filter(s => s.inLab).map(s => s.id) };
}

// MULTIPLE TESTING ACROSS THE WHOLE REGISTRY (alpha-research pass 3).
//
// Every strategy was graded against its OWN 95% date-level CI, independently, and there
// are ~50 registry entries spanning far more tier/scope cells. At alpha=0.05 a handful
// of nominal winners is the expected yield from pure noise, so a per-group CI cannot
// support "this strategy has an edge" — it can only support "this group's mean differs
// from zero, ignoring that we ran the test many times".
//
// lib/evidence-stats.fdrAdjust + pValueOf already implement exactly this, and their own
// test is named "a lone nominal winner among many does not survive". Until now they had
// ZERO production callers. This is the wiring, not a new statistic.
//
// One-directional: FDR may only DEMOTE validated → promising. It never promotes, never
// upgrades, and never touches disabled/informational verdicts.
function applyFdrAcrossStrategies(strategies) {
  const ES = require('./evidence-stats');
  // The family is every strategy carrying a usable date-level test — including the ones
  // that did NOT reach validated. Correcting only over the winners would understate the
  // number of tests run, which is the whole error being corrected.
  const tested = [];
  for (const s of strategies || []) {
    const dn = s && s.stats && s.stats.dateNet;
    const p = dn ? ES.pValueOf(dn) : null;
    if (Number.isFinite(p)) { tested.push({ id: s.id, p }); s._fdrP = p; }
  }
  if (!tested.length) return;
  const adjusted = new Map(ES.fdrAdjust(tested, { alpha: FDR_ALPHA }).map(r => [r.id, r]));
  for (const s of strategies || []) {
    if (!Number.isFinite(s._fdrP)) continue;
    const r = adjusted.get(s.id);
    delete s._fdrP;
    if (!r) continue;
    const demote = s.grade === 'validated' && !r.survives;
    s.fdr = { p: +r.p.toFixed(6), q: Number.isFinite(r.q) ? +r.q.toFixed(6) : null, survives: !!r.survives, tests: tested.length, demoted: demote };
    if (demote) {
      s.grade = 'promising';
      s.reason = `Nominally validated, but does not survive Benjamini-Hochberg FDR across the ${tested.length} strategies tested this run `
        + `(p ${r.p.toFixed(4)} → q ${Number.isFinite(r.q) ? r.q.toFixed(4) : '?'} > ${FDR_ALPHA}). `
        + `A per-strategy 95% interval cannot carry a promotion claim when many strategies are graded at once. Original verdict: ${s.reason}`;
      s.inLab = !s.core;
    }
  }
}

module.exports = {
  MATURITY_VERSION, GRADE_META, GRADES, MIN_VERDICT, MIN_PROMISING,
  MIN_VALIDATED_EPISODES, MIN_VALIDATED_DATES, MIN_EFFECTIVE_DATES, MIN_POSITIVE_BLOCKS,
  HORIZON_METRIC, EXCLUDED_TIER_PREFIXES,
  INCREMENTAL_DECLARED_RE, declaresIncrementalGate, incrementalContract, prosecuteRecord,
  gradeTrack, poolSectionTrack, gradeStrategy, classifyStrategies,
};

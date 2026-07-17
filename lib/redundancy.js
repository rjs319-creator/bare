'use strict';

// MEASURED REDUNDANCY — replaces the ASSERTED redundancy discount with one earned
// from the ledgers.
//
// WHY: `lib/decision.js independentEvidence()` decides how much a SECOND agreeing
// screener is worth using a hand-assigned family map and a hardcoded literal
// (`CORR_DISCOUNT = 0.3`, duplicated verbatim in `lib/confluence.js`). That constant
// was never fit, never calibrated, never read from data. It penalises two same-family
// signals identically whether their realized return correlation is 0.05 or 0.95, and
// treats two different-family signals as fully independent even when they are 0.9
// correlated. The repo already owns every primitive needed to measure this properly
// (Pearson over paired daily excess at apex-routes.js runEdgeBook, Spearman IC in
// rankquality.js) — but each is wired to a REPORTING surface and never back into the
// score. This module closes that loop.
//
// WHAT IT MEASURES, per ordered algorithm pair (a → b):
//   • overlapRate      — Jaccard on (date, ticker): how often they fire on the same name
//   • returnCorr       — Pearson of the two algorithms' daily mean-excess streams
//   • confirmationLift — the falsification test that actually matters: when BOTH fire on
//                        a name, does it outperform the names only ONE fired on? If
//                        agreement buys no lift, then counting agreement as extra
//                        evidence is unjustified regardless of correlation.
//   • credit           — what b's evidence is worth GIVEN a already fired (0..1). This is
//                        the measured replacement for the flat 0.3.
//
// HONESTY RULES (the app's standing ethos — abstention is a valid output):
//   • A pair below the sample gates gets `method:'prior'` and falls back to the caller's
//     static family rule. We never fabricate a correlation from 3 observations.
//   • Measured credit is SHRUNK toward the prior by paired-sample size, so the transition
//     from asserted to measured is gradual, not a cliff.
//   • This module is PURE: rows in → model out. No network, no clock, no store. The caller
//     supplies the ledger rows, the family map, and the prior.
//
// It does NOT claim to find edge. It only makes the double-counting penalty honest —
// which is falsifiable whether or not the underlying signals have any edge at all.

const REDUNDANCY_VERSION = 'redundancy-v1';

// Sample gates. Below these a pair is not measured — it inherits the static prior.
// 8 paired dates mirrors the existing bar in apex-routes.js runEdgeBook crossSleeve.
const GATES = {
  minPairedDates: 8,   // dates where BOTH algorithms produced a resolved pick
  minCoSelections: 5,  // (date,ticker) cells both algorithms selected
  minRowsPerAlgo: 10,  // resolved rows before an algorithm is measurable at all
};

// Shrinkage strength: credit = w·measured + (1-w)·prior, with w = n/(n+SHRINK_K).
// At n = SHRINK_K the measurement carries half the weight. Deliberately conservative —
// the prior is a defensible default, the measurement has to earn its way in.
const SHRINK_K = 10;

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den > 0 ? num / den : null;
}

const cellKey = (r) => `${r.date}|${String(r.ticker || '').toUpperCase()}`;
const pairKey = (a, b) => `${a}|${b}`;

// Daily mean excess for one algorithm: date → mean resolved excess that day.
function dailyMeanExcess(rows) {
  const byDate = new Map();
  for (const r of rows) {
    if (!Number.isFinite(r.excess)) continue;
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r.excess);
  }
  const out = {};
  for (const [d, xs] of byDate) out[d] = mean(xs);
  return out;
}

// Does agreement pay? Compare resolved excess on cells BOTH algorithms selected against
// cells exactly one of them selected. A positive lift is the only empirical justification
// for treating a second agreeing signal as real confirmation.
function confirmationLift(rowsA, rowsB) {
  const keysA = new Set(rowsA.map(cellKey));
  const keysB = new Set(rowsB.map(cellKey));
  const co = new Set([...keysA].filter(k => keysB.has(k)));

  const coEx = [], soloEx = [];
  for (const r of [...rowsA, ...rowsB]) {
    if (!Number.isFinite(r.excess)) continue;
    (co.has(cellKey(r)) ? coEx : soloEx).push(r.excess);
  }
  const coMean = mean(coEx), soloMean = mean(soloEx);
  const lift = coMean != null && soloMean != null ? coMean - soloMean : null;
  return {
    coSelections: co.size,
    coResolved: coEx.length,
    soloResolved: soloEx.length,
    coAvgExcess: coMean == null ? null : +coMean.toFixed(3),
    soloAvgExcess: soloMean == null ? null : +soloMean.toFixed(3),
    lift: lift == null ? null : +lift.toFixed(3),
    coWinRate: coEx.length ? +(coEx.filter(x => x > 0).length / coEx.length).toFixed(3) : null,
    soloWinRate: soloEx.length ? +(soloEx.filter(x => x > 0).length / soloEx.length).toFixed(3) : null,
  };
}

// Redundancy of a pair, 0 (independent) … 1 (interchangeable).
// Taken as the MAX of the two observable channels: they fire on the same names
// (overlap), or their outcomes move together (return correlation). Either one alone is
// enough to make the second signal not-independent, so max — not an average — is the
// conservative read. Negative correlation is floored at 0: an anti-correlated pair is
// not redundant, it is genuinely different information.
function redundancyOf({ overlapRate, returnCorr }) {
  const channels = [
    Number.isFinite(overlapRate) ? clamp01(overlapRate) : null,
    Number.isFinite(returnCorr) ? clamp01(returnCorr) : null,
  ].filter(v => v != null);
  return channels.length ? Math.max(...channels) : null;
}

// Build the measured model from resolved ledger rows.
//   rows: [{ date, ticker, algorithm, excess }]  — excess may be null (unresolved)
//   priorCredit: the caller's static fallback (decision.js CORR_DISCOUNT)
//   familyOf: (algorithm) => familyKey | null — the caller's static family map
// Returns an immutable model; never throws on malformed input.
function buildRedundancyModel(rows, { priorCredit = 0.3, familyOf = () => null, gates = {} } = {}) {
  const G = { ...GATES, ...gates };
  const clean = (rows || []).filter(r => r && r.date && r.ticker && r.algorithm);

  const byAlgo = new Map();
  for (const r of clean) {
    const a = r.algorithm;
    if (!byAlgo.has(a)) byAlgo.set(a, []);
    byAlgo.get(a).push(r);
  }

  const algorithms = [...byAlgo.keys()].sort().map(name => {
    const rs = byAlgo.get(name);
    const resolved = rs.filter(r => Number.isFinite(r.excess));
    return {
      algorithm: name,
      family: familyOf(name) || null,
      picks: rs.length,
      resolved: resolved.length,
      dates: new Set(rs.map(r => r.date)).size,
      avgExcess: resolved.length ? +mean(resolved.map(r => r.excess)).toFixed(3) : null,
      measurable: resolved.length >= G.minRowsPerAlgo,
    };
  });

  const names = algorithms.map(a => a.algorithm);
  const pairs = [];
  const credits = {};

  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i], b = names[j];
      const rowsA = byAlgo.get(a), rowsB = byAlgo.get(b);

      const keysA = new Set(rowsA.map(cellKey)), keysB = new Set(rowsB.map(cellKey));
      const inter = [...keysA].filter(k => keysB.has(k)).length;
      const union = new Set([...keysA, ...keysB]).size;
      const overlapRate = union ? +(inter / union).toFixed(3) : null;

      const dA = dailyMeanExcess(rowsA), dB = dailyMeanExcess(rowsB);
      const common = Object.keys(dA).filter(d => d in dB).sort();
      const rc = common.length >= G.minPairedDates
        ? pearson(common.map(d => dA[d]), common.map(d => dB[d]))
        : null;
      const returnCorr = rc == null ? null : +rc.toFixed(3);

      const conf = confirmationLift(rowsA, rowsB);
      const sameFamily = !!(familyOf(a) && familyOf(a) === familyOf(b));
      const priorForPair = sameFamily ? priorCredit : 1;

      // The two channels gate INDEPENDENTLY. Return correlation needs paired dates to be
      // computable at all; overlap is a rate over the union and is meaningful as soon as
      // both algorithms have a real pick history — including when it is legitimately ZERO
      // (never co-fire ⇒ not redundant, whatever the static family map asserts). Requiring
      // co-selections here would have made the map's worst failure case unmeasurable.
      const enough = common.length >= G.minPairedDates;
      const redundancy = redundancyOf({ overlapRate, returnCorr });
      // Confirmation lift is a separate question with its own sample bar: it can only be
      // read when the pair actually co-fired enough times to compare.
      conf.measurable = conf.coSelections >= G.minCoSelections && conf.coResolved > 0;

      let credit = priorForPair, method = 'prior', shrinkW = 0;
      if (enough && redundancy != null) {
        const measured = clamp01(1 - redundancy);
        shrinkW = common.length / (common.length + SHRINK_K);
        credit = +(shrinkW * measured + (1 - shrinkW) * priorForPair).toFixed(3);
        method = 'measured';
      }

      pairs.push({
        a, b, sameFamily,
        overlapRate, returnCorr, pairedDates: common.length,
        redundancy: redundancy == null ? null : +redundancy.toFixed(3),
        confirmation: conf,
        credit, method, priorCredit: priorForPair,
        shrinkWeight: +shrinkW.toFixed(3),
        note: method === 'measured'
          ? 'Credit earned from overlap + realized return correlation, shrunk toward the family prior by sample size.'
          : `Below the sample gate (${common.length}/${G.minPairedDates} paired dates) — using the static family prior.`,
      });
      // ONLY measured credits go in the lookup. A prior-method pair is deliberately
      // absent so `creditFor` falls through to the caller's static family rule — which
      // yields the identical number — and `effectiveEvidence` can tell a real
      // measurement from a fallback instead of reporting an asserted prior as measured.
      if (method === 'measured') {
        credits[pairKey(a, b)] = credit;
        credits[pairKey(b, a)] = credit;
      }
    }
  }

  const measuredPairs = pairs.filter(p => p.method === 'measured');
  const liftPairs = measuredPairs.filter(p => p.confirmation.lift != null);
  const avgLift = liftPairs.length ? mean(liftPairs.map(p => p.confirmation.lift)) : null;

  // Verdict describes the STATE OF EVIDENCE, not an edge claim.
  let verdict = 'insufficient';
  if (measuredPairs.length) {
    const avgCredit = mean(measuredPairs.map(p => p.credit));
    verdict = avgCredit < priorCredit ? 'more-redundant-than-assumed'
      : avgCredit > 0.8 ? 'largely-independent'
      : 'mixed';
  }

  return {
    version: REDUNDANCY_VERSION,
    gates: G,
    shrinkK: SHRINK_K,
    priorCredit,
    algorithms,
    pairs,
    credits,
    summary: {
      algorithms: algorithms.length,
      measurablePairs: measuredPairs.length,
      totalPairs: pairs.length,
      avgMeasuredCredit: measuredPairs.length ? +mean(measuredPairs.map(p => p.credit)).toFixed(3) : null,
      avgConfirmationLift: avgLift == null ? null : +avgLift.toFixed(3),
      confirmationPays: avgLift == null ? null : avgLift > 0,
    },
    verdict,
    note: measuredPairs.length
      ? `${measuredPairs.length}/${pairs.length} pairs have earned a measured credit; the rest use the static family prior (${priorCredit}).`
      : 'No pair clears the sample gates yet — every credit is the static family prior. Accrues as the ledgers fill.',
  };
}

// What is algorithm `b`'s evidence worth given `a` already fired? Measured credit when
// the pair earned one, else the caller's static rule.
function creditFor(model, a, b, { priorCredit = 0.3, familyOf = () => null } = {}) {
  if (a === b) return 0;
  const measured = model && model.credits ? model.credits[pairKey(a, b)] : undefined;
  if (Number.isFinite(measured)) return measured;
  const fa = familyOf(a), fb = familyOf(b);
  return fa && fb && fa === fb ? priorCredit : 1;
}

// The measured generalisation of independentEvidence(). Sources are credited in order:
// the first counts full; each subsequent source is worth the MINIMUM credit against any
// already-counted source — i.e. if it is redundant with ANYTHING already on the board, it
// adds little, regardless of its declared family. With no model this reduces EXACTLY to
// the existing family rule (same family → priorCredit, else → 1), so it is a safe
// drop-in: behaviour is unchanged until data earns a change.
function effectiveEvidence(sources, { model = null, priorCredit = 0.3, familyOf = () => null } = {}) {
  const list = [...new Set((sources || []).filter(Boolean))];
  if (!list.length) return { sourceCount: 0, score: 0, credits: [], method: 'none' };

  const counted = [];
  const credits = [];
  let score = 0, anyMeasured = false;

  for (const s of list) {
    if (!counted.length) {
      counted.push(s); credits.push({ source: s, credit: 1, against: null });
      score += 1;
      continue;
    }
    let worst = 1, against = null, measuredHere = false;
    for (const prev of counted) {
      const hasMeasured = !!(model && model.credits && Number.isFinite(model.credits[pairKey(prev, s)]));
      const c = creditFor(model, prev, s, { priorCredit, familyOf });
      if (c < worst) { worst = c; against = prev; measuredHere = hasMeasured; }
    }
    if (measuredHere) anyMeasured = true;
    counted.push(s);
    credits.push({ source: s, credit: +worst.toFixed(3), against });
    score += worst;
  }

  return {
    sourceCount: list.length,
    score: +score.toFixed(2),
    credits,
    method: anyMeasured ? 'measured' : 'prior',
    // The misleading case the flat rule was built to catch, preserved: several sources
    // agree but they are effectively one signal.
    redundantAgreement: list.length >= 2 && score < 1.5,
  };
}

module.exports = {
  REDUNDANCY_VERSION, GATES, SHRINK_K,
  pearson, dailyMeanExcess, confirmationLift, redundancyOf,
  buildRedundancyModel, creditFor, effectiveEvidence,
};

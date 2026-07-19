// Point-in-time historical data contract (pit-v1).
//
// This is the leakage/survivorship SAFETY layer the historical-learning system
// rests on. It formalizes what ORBIT/ORBIT-ML previously only asserted:
//   • a versioned record schema with an explicit PUBLICATION timestamp,
//   • strict as-of joins (a record may use only information whose publication
//     timestamp is ≤ the decision timestamp — no future information, ever),
//   • an automated integrity-check battery, and
//   • a dataset-suitability gate (old picks ⇒ eval-only, not train-ready).
//
// It reuses lib/market-data (series data-quality) and lib/security-master (PIT
// universe / delisting) rather than duplicating them. Pure + deterministic.

const { hashContent } = require('./run-manifest');

const PIT_VERSION = 'pit-v1';

// The canonical record contract. `required` must be present on every record;
// the rest are optional but, when present, are integrity-checked.
const RECORD_CONTRACT = Object.freeze({
  version: PIT_VERSION,
  required: ['securityId', 'ticker', 'tradingDate', 'observationTs'],
  optional: [
    'publicationTs', 'openAdj', 'highAdj', 'lowAdj', 'closeAdj', 'volume',
    'openRaw', 'closeRaw', 'adjFactor', 'splits', 'dividends',
    'exchange', 'sector', 'industry', 'universeVersion', 'indexMembership',
    'listedDate', 'delistedDate', 'delistingReturn', 'marketCap', 'price',
    'dollarVolume', 'fundamentals', 'reportPeriod', 'fundamentalPublicationTs',
    'eventTs', 'newsTs', 'spreadEst', 'source', 'retrievedAt', 'vintage', 'revision',
  ],
});

const isTs = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v);

// Validate one record against the contract. Returns { ok, issues:[] }.
function validateRecord(rec) {
  const issues = [];
  if (!rec || typeof rec !== 'object') return { ok: false, issues: ['not-an-object'] };
  for (const f of RECORD_CONTRACT.required) if (rec[f] == null) issues.push(`missing-required:${f}`);
  if (rec.tradingDate != null && !isTs(rec.tradingDate)) issues.push('bad-tradingDate');
  if (rec.observationTs != null && !isTs(rec.observationTs)) issues.push('bad-observationTs');
  // Publication timestamp cannot precede the observation it publishes.
  if (isTs(rec.publicationTs) && isTs(rec.observationTs) && rec.publicationTs < rec.observationTs) issues.push('publication-before-observation');
  return { ok: issues.length === 0, issues };
}

// The effective "known-at" timestamp of a record: its publication timestamp if
// present, else its observation timestamp (a bar is knowable at its own close).
function knownAt(rec) { return isTs(rec.publicationTs) ? rec.publicationTs : rec.observationTs; }

// STRICT AS-OF JOIN: keep only records knowable no later than `decisionTs`.
// This is the single most important leakage guard — it rejects future info.
function asOfJoin(records, decisionTs) {
  if (!isTs(decisionTs)) throw new Error('asOfJoin: decisionTs must be a timestamp');
  return (records || []).filter(r => { const k = knownAt(r); return isTs(k) && k <= decisionTs; });
}

// Latest point-in-time value of `field` as-of `decisionTs` (last knowable record).
function pointInTimeValue(records, field, decisionTs) {
  const usable = asOfJoin(records, decisionTs).filter(r => r[field] != null).sort((a, b) => knownAt(a) < knownAt(b) ? -1 : 1);
  return usable.length ? usable[usable.length - 1][field] : null;
}

// ── Integrity-check battery ─────────────────────────────────────────────────
// `records`: array of contract records (possibly many securities × dates).
// `asOf`: optional cutoff; fundamentals/events published after it are flagged.
function checkIntegrity(records, opts = {}) {
  const recs = records || [];
  const issues = [], warnings = [];
  const seen = new Map();          // securityId|tradingDate → count
  const tickerToIds = new Map();   // ticker → Set(securityId)
  const yearFeatureMissing = {};   // year → {feature → missingCount}
  const featureFirstYear = {};     // feature → earliest year seen

  for (const r of recs) {
    const v = validateRecord(r);
    if (!v.ok) { issues.push({ type: 'schema', securityId: r && r.securityId, detail: v.issues }); continue; }

    // Duplicate security/date.
    const key = `${r.securityId}|${r.tradingDate}`;
    seen.set(key, (seen.get(key) || 0) + 1);

    // Ticker reuse across security ids.
    if (!tickerToIds.has(r.ticker)) tickerToIds.set(r.ticker, new Set());
    tickerToIds.get(r.ticker).add(r.securityId);

    // Impossible / future timestamps.
    if (opts.asOf && isTs(opts.asOf)) {
      if (isTs(r.observationTs) && r.observationTs > opts.asOf) issues.push({ type: 'future-observation', securityId: r.securityId, tradingDate: r.tradingDate });
      if (isTs(r.fundamentalPublicationTs) && r.fundamentalPublicationTs > opts.asOf) issues.push({ type: 'future-fundamental', securityId: r.securityId, at: r.fundamentalPublicationTs });
      if (isTs(r.eventTs) && r.eventTs > opts.asOf) warnings.push({ type: 'future-event', securityId: r.securityId, at: r.eventTs });
    }
    // Fundamentals published before their own report period is impossible.
    if (isTs(r.fundamentalPublicationTs) && isTs(r.reportPeriod) && r.fundamentalPublicationTs < r.reportPeriod) issues.push({ type: 'fundamental-before-period', securityId: r.securityId });

    // Adjustment-factor consistency: adjusted close must equal raw × adjFactor.
    if (r.closeRaw != null && r.closeAdj != null && r.adjFactor != null && r.adjFactor > 0) {
      const implied = r.closeRaw * r.adjFactor;
      if (Math.abs(implied - r.closeAdj) / Math.max(1e-9, Math.abs(r.closeAdj)) > 0.02) warnings.push({ type: 'adjustment-mismatch', securityId: r.securityId, tradingDate: r.tradingDate });
    }

    // Listing / delisting bounds.
    if (isTs(r.listedDate) && r.tradingDate < r.listedDate) issues.push({ type: 'before-listing', securityId: r.securityId, tradingDate: r.tradingDate });
    if (isTs(r.delistedDate) && r.tradingDate > r.delistedDate) issues.push({ type: 'after-delisting', securityId: r.securityId, tradingDate: r.tradingDate });

    // Missingness by year × feature, and feature first-appearance year.
    const year = r.tradingDate.slice(0, 4);
    for (const f of ['closeAdj', 'volume', 'sector', 'marketCap', 'fundamentals', 'spreadEst']) {
      yearFeatureMissing[year] = yearFeatureMissing[year] || {};
      if (r[f] == null) yearFeatureMissing[year][f] = (yearFeatureMissing[year][f] || 0) + 1;
      else if (featureFirstYear[f] == null || year < featureFirstYear[f]) featureFirstYear[f] = year;
    }
  }

  for (const [key, n] of seen) if (n > 1) issues.push({ type: 'duplicate-security-date', key, count: n });
  for (const [ticker, ids] of tickerToIds) if (ids.size > 1) warnings.push({ type: 'ticker-reuse', ticker, securityIds: [...ids] });

  // Late-starting features: a feature that only appears well into the history is
  // a look-ahead hazard if used in early folds. Flag features whose first year is
  // later than the dataset's first year.
  const years = [...new Set(recs.filter(r => isTs(r.tradingDate)).map(r => r.tradingDate.slice(0, 4)))].sort();
  const firstYear = years[0];
  for (const [f, y] of Object.entries(featureFirstYear)) if (firstYear && y > firstYear) warnings.push({ type: 'late-starting-feature', feature: f, firstYear: y, datasetStart: firstYear });

  return {
    version: PIT_VERSION, ok: issues.length === 0,
    nRecords: recs.length, issues, warnings,
    stats: { years, yearFeatureMissing, tickers: tickerToIds.size, securityDates: seen.size },
  };
}

// Detect a feature that is suspiciously (near-perfectly) correlated with a FORWARD
// label across a cross-section — the signature of a leaked future value.
function suspiciousForwardCorrelation(rows, labelField, opts = {}) {
  const { pearson } = require('./orbit-math');
  const threshold = opts.threshold != null ? opts.threshold : 0.95;
  const flagged = [];
  if (!rows || !rows.length) return { flagged, checked: 0 };
  const featNames = Object.keys(rows[0].features || {});
  for (const f of featNames) {
    const xs = rows.map(r => r.features ? r.features[f] : null);
    const ys = rows.map(r => r[labelField]);
    const c = pearson(xs, ys);
    if (c != null && Math.abs(c) >= threshold) flagged.push({ feature: f, corr: +c.toFixed(3) });
  }
  return { flagged, checked: featNames.length, threshold };
}

// Dataset-suitability gate: is this dataset usable to TRAIN the cross-sectional
// ranker, or only to EVALUATE existing algorithms? Old screener PICKS (selected
// names only, no rejected candidates, no delisted, no PIT universe) are eval-only.
function datasetSuitability(meta = {}) {
  const reasons = [];
  if (!meta.hasRejectedCandidates) reasons.push('no-rejected-candidates (training population would be only past picks)');
  if (!meta.hasDelisted) reasons.push('no-delisted-securities (survivorship-biased)');
  if (!meta.pointInTimeUniverse) reasons.push('universe-not-point-in-time');
  const trainReady = reasons.length === 0;
  return {
    version: PIT_VERSION,
    trainReady,
    evalOnly: !trainReady,
    survivorshipSafe: !!meta.hasDelisted && !!meta.pointInTimeUniverse,
    reasons,
    note: trainReady ? 'Suitable for training the cross-sectional ranker.' : 'Eval-only: suitable for scoring existing algorithms, NOT for training the new ranker. Promotion blocked.',
  };
}

// Deterministic dataset fingerprint (for immutable manifests / reproducibility).
function fingerprint(records) { return hashContent({ v: PIT_VERSION, n: (records || []).length, keys: (records || []).map(r => `${r.securityId}|${r.tradingDate}|${knownAt(r)}`).sort() }); }

module.exports = {
  PIT_VERSION, RECORD_CONTRACT,
  validateRecord, knownAt, asOfJoin, pointInTimeValue,
  checkIntegrity, suspiciousForwardCorrelation, datasetSuitability, fingerprint,
};

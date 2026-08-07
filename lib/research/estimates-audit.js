'use strict';
// Analyst-estimates sample auditor — pure, offline, research-side. Given a
// vendor sample (rows of plain objects), infers which columns play which role
// and audits whether the data could support point-in-time (as-of) queries.
//
// HONESTY CONTRACT: column NAMES alone never prove PIT safety. PIT_LIKELY
// requires the data itself to show multiple dated historical observations per
// ticker+fiscal-period whose values actually change — and even then the
// classification stays preliminary until vendor documentation confirms the
// availability-timestamp semantics. Auth/parse problems are reported as such,
// never as data findings.

const MIN_ROWS = 20;
const MIN_MULTI_OBS_GROUPS = 5;
// Above this share of rows, future-dated observations disqualify PIT_LIKELY.
const FUTURE_VIOLATION_TOLERANCE = 0.01;

// Role → name fragments, checked case-insensitively against snake/camel names.
const ROLE_PATTERNS = Object.freeze({
  ticker: ['ticker', 'symbol'],
  securityId: ['security_id', 'securityid', 'permno', 'gvkey', 'figi', 'cusip', 'isin', 'sedol', 'm_ticker', 'obj_id'],
  fiscalPeriod: ['fiscal', 'period', 'per_end', 'qtr', 'quarter', 'fy'],
  estimateType: ['estimate_type', 'metric', 'measure', 'item', 'est_type'],
  estimateValue: ['estimate', 'mean_est', 'consensus', 'eps_mean', 'value', 'mean'],
  asOfDate: ['as_of', 'asof', 'obs_date', 'observation', 'snapshot', 'file_date', 'vintage'],
  publishedAt: ['publish', 'announce', 'release', 'timestamp', 'created', 'source_date'],
  analystCount: ['num_analyst', 'analyst_count', 'num_est', 'coverage', 'nbr'],
  upRevisions: ['up_rev', 'uprevision', 'rev_up', 'up_agree', 'up'],
  downRevisions: ['down_rev', 'downrevision', 'rev_down', 'down_agree', 'down'],
  actual: ['actual', 'reported'],
  activeStatus: ['active', 'status', 'delisted', 'inactive'],
});

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '_');

// Map each role to candidate column names. Overlapping fragments make several
// candidates per role possible — all are reported, first is the working pick.
function inferColumns(columnNames) {
  const cols = columnNames.map(c => ({ raw: c, n: norm(c) }));
  const taken = new Set();
  const mapping = {};
  for (const [role, frags] of Object.entries(ROLE_PATTERNS)) {
    const candidates = cols.filter(c => frags.some(f => c.n.includes(f))).map(c => c.raw);
    const pick = candidates.find(c => !taken.has(c)) || null;
    if (pick) taken.add(pick);
    mapping[role] = { candidates, pick };
  }
  return mapping;
}

function parseDate(v) {
  if (v == null || v === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function toNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Minimal CSV parser (quoted fields, escaped quotes, CRLF). Returns row objects.
function parseCsv(text) {
  const rows = [];
  let field = '', record = [], inQuotes = false;
  const pushField = () => { record.push(field); field = ''; };
  const pushRecord = () => { if (record.length > 1 || record[0] !== '') rows.push(record); record = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') pushField();
    else if (ch === '\n') { pushField(); pushRecord(); }
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || record.length) { pushField(); pushRecord(); }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

function summarizeMissingness(rows, columns) {
  const out = {};
  for (const c of columns) {
    const missing = rows.reduce((n, r) => n + (r[c] == null || r[c] === '' ? 1 : 0), 0);
    out[c] = { missing, pct: rows.length ? +(missing / rows.length * 100).toFixed(1) : 0 };
  }
  return out;
}

function auditEstimatesSample(rows, { now = null } = {}) {
  const reasons = [];
  const limitations = [
    'Classification is preliminary: vendor documentation must confirm availability-timestamp semantics before any PIT claim is final.',
    'Column-name inference is heuristic; verify the role mapping against the vendor data dictionary.',
  ];
  if (!Array.isArray(rows) || rows.length === 0) {
    return { rowCount: 0, classification: 'INSUFFICIENT_SAMPLE', reasons: ['no rows parsed'], limitations };
  }
  const columns = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const mapping = inferColumns(columns);
  const pick = (role) => mapping[role].pick;

  const tickerCol = pick('ticker');
  const idCol = pick('securityId');
  const fpCol = pick('fiscalPeriod');
  const valueCol = pick('estimateValue');
  const asOfCol = pick('asOfDate') || pick('publishedAt');

  const tickers = tickerCol ? [...new Set(rows.map(r => r[tickerCol]).filter(v => v != null && v !== ''))] : [];
  const asOfTimes = asOfCol ? rows.map(r => parseDate(r[asOfCol])) : [];
  const validTimes = asOfTimes.filter(t => t != null);
  const fiscalPeriods = fpCol ? [...new Set(rows.map(r => r[fpCol]).filter(v => v != null && v !== ''))] : [];

  // Exact duplicates on the identifying tuple.
  const seen = new Map();
  let duplicateCount = 0;
  for (const r of rows) {
    const k = JSON.stringify([tickerCol && r[tickerCol], fpCol && r[fpCol], asOfCol && r[asOfCol], valueCol && r[valueCol]]);
    duplicateCount += seen.has(k) ? 1 : 0;
    seen.set(k, true);
  }

  // Groups = ticker+fiscalPeriod; count those with >1 distinct dated observation,
  // and whether values genuinely change across observations within a group.
  const groups = new Map();
  if (tickerCol && fpCol) {
    for (const r of rows) {
      const k = `${r[tickerCol]}|${r[fpCol]}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
  }
  let multiObsGroups = 0, changingValueGroups = 0;
  for (const g of groups.values()) {
    const dates = new Set(asOfCol ? g.map(r => r[asOfCol]).filter(v => v != null && v !== '') : []);
    if (dates.size > 1) {
      multiObsGroups++;
      const values = new Set(valueCol ? g.map(r => toNumber(r[valueCol])).filter(v => v != null) : []);
      if (values.size > 1) changingValueGroups++;
    }
  }
  const valuesChange = changingValueGroups > 0;

  // Future-dated observations (vs supplied audit time — caller passes `now`).
  const nowMs = now != null ? parseDate(now) : null;
  const futureTimestampViolations = nowMs != null ? validTimes.filter(t => t > nowMs).length : null;

  // Observation-after-decision check is only testable if the sample carries an
  // explicit decision/test-time column — not inferable, so report testability.
  const decisionCol = columns.find(c => /decision|test_time|backtest/i.test(norm(c))) || null;
  let observationAfterDecisionRows = null;
  if (decisionCol && asOfCol) {
    observationAfterDecisionRows = rows.filter(r => {
      const obs = parseDate(r[asOfCol]); const dec = parseDate(r[decisionCol]);
      return obs != null && dec != null && obs > dec;
    }).length;
  }

  // Identifier ambiguity: one ticker ↔ multiple stable ids, or the reverse.
  let ambiguousIdentifierMappings = 0;
  if (tickerCol && idCol) {
    const byTicker = new Map(), byId = new Map();
    for (const r of rows) {
      const t = r[tickerCol], id = r[idCol];
      if (t == null || t === '' || id == null || id === '') continue;
      if (!byTicker.has(t)) byTicker.set(t, new Set());
      byTicker.get(t).add(id);
      if (!byId.has(id)) byId.set(id, new Set());
      byId.get(id).add(t);
    }
    for (const s of byTicker.values()) if (s.size > 1) ambiguousIdentifierMappings++;
    for (const s of byId.values()) if (s.size > 1) ambiguousIdentifierMappings++;
  }

  const activeCol = pick('activeStatus');
  const activeCoverage = activeCol
    ? { detectable: true, column: activeCol, distinctValues: [...new Set(rows.map(r => String(r[activeCol])))].slice(0, 8) }
    : { detectable: false, note: 'no active/inactive column found — survivorship bias in the sample is NOT ruled out' };
  if (!activeCol) limitations.push('Inactive/delisted securities may be missing entirely (survivorship); not detectable from this sample.');

  const restatedOnly = multiObsGroups > 0 && !valuesChange;

  // ---- classification (order matters; most disqualifying first) ----
  let classification;
  if (rows.length < MIN_ROWS || tickers.length < 2) {
    classification = 'INSUFFICIENT_SAMPLE';
    reasons.push(`sample too small (${rows.length} rows, ${tickers.length} tickers; need >=${MIN_ROWS} rows, >=2 tickers)`);
  } else if (!asOfCol || validTimes.length === 0) {
    classification = 'NOT_PIT';
    reasons.push('no usable observation/as-of date column — as-of queries are impossible, so lookahead cannot be excluded');
  } else if (multiObsGroups === 0) {
    classification = 'NOT_PIT';
    reasons.push('every ticker/fiscal-period group has a single dated observation — latest-value-only shape, revision history absent');
  } else if (restatedOnly) {
    classification = 'PIT_UNPROVEN';
    reasons.push('groups have multiple dated observations but values never change — cannot demonstrate that revisions (vs restated copies) are recorded');
  } else if (futureTimestampViolations != null && futureTimestampViolations > rows.length * FUTURE_VIOLATION_TOLERANCE) {
    classification = 'PIT_UNPROVEN';
    reasons.push(`${futureTimestampViolations} observations are dated in the future — availability timestamps are not trustworthy as-is`);
  } else if (multiObsGroups >= MIN_MULTI_OBS_GROUPS && valuesChange) {
    classification = 'PIT_LIKELY';
    reasons.push(`${multiObsGroups} ticker/fiscal-period groups carry multiple dated observations with genuinely changing values — later observations can be excluded from earlier as-of queries`);
  } else {
    classification = 'PIT_UNPROVEN';
    reasons.push(`only ${multiObsGroups} multi-observation groups (need >=${MIN_MULTI_OBS_GROUPS} with changing values for PIT_LIKELY)`);
  }
  if (observationAfterDecisionRows == null) limitations.push('Observation-after-decision check untestable: sample has no decision/test-time column.');
  if (ambiguousIdentifierMappings > 0) reasons.push(`${ambiguousIdentifierMappings} ambiguous ticker/security-id mappings — joins need a stable identifier policy`);

  return {
    rowCount: rows.length,
    tickerCount: tickers.length,
    dateCoverage: validTimes.length
      ? { from: new Date(Math.min(...validTimes)).toISOString().slice(0, 10), to: new Date(Math.max(...validTimes)).toISOString().slice(0, 10), datedRows: validTimes.length }
      : null,
    fiscalPeriodCoverage: { distinct: fiscalPeriods.length, sample: fiscalPeriods.slice(0, 8) },
    duplicateCount,
    missingnessByField: summarizeMissingness(rows, columns),
    columnMapping: mapping,
    activeCoverage,
    multiObsGroups,
    changingValueGroups,
    valuesChange,
    restatedOnly,
    futureTimestampViolations,
    observationAfterDecision: decisionCol ? { testable: true, column: decisionCol, violations: observationAfterDecisionRows } : { testable: false },
    ambiguousIdentifierMappings,
    classification,
    reasons,
    limitations,
  };
}

module.exports = { auditEstimatesSample, inferColumns, parseCsv, MIN_ROWS, MIN_MULTI_OBS_GROUPS };

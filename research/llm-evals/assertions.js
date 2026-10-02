'use strict';
// Pure assertion helpers for the golden-set runner. Each returns `{ ok, detail }`.
// The property under test in most of them is GROUNDING: numbers and indexes the model emits
// must exist in the text it was shown. These are the "javascript" assertions promptfoo would
// run; keeping them here lets node --test and promptfoo share one implementation.

const { validate } = require('./schema-check');

const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;
const HEDGE_PHRASES = ['could go either way', 'it is hard to say', 'time will tell', 'only time will tell'];

/** Numeric tokens in a text, comma-stripped ("1,200" → "1200"), as a Set of strings. */
function numberTokens(text) {
  const out = new Set();
  for (const m of String(text == null ? '' : text).match(NUMBER_RE) || []) out.add(m.replace(/,/g, ''));
  return out;
}

const YEAR_RE = /^\d{4}$/;
const SHORT_YEAR_LEN = 2;

/**
 * True when `token` is verbatim in `inputTokens`. The ONE tolerated rewrite is a two-digit
 * year against a four-digit one (FY26 vs FY2026). "12" is NOT grounded by "$0.12" and "15"
 * is not grounded by "150" — those are exactly the fabrications the check exists to catch.
 */
function tokenGrounded(token, inputTokens) {
  if (inputTokens.has(token)) return true;
  const bare = token.replace(/^0+(?=\d)/, '');
  for (const t of inputTokens) {
    if (t === bare) return true;
    if (YEAR_RE.test(t) && token.length === SHORT_YEAR_LEN && t.endsWith(token)) return true;
  }
  return false;
}

function schemaValid(schema, output) {
  const violations = validate(schema, output);
  return { ok: violations.length === 0, detail: violations.slice(0, 5).join('; ') || 'schema ok' };
}

/** Every number in `outputText` appears in `inputText`. */
function numbersVerbatim(outputText, inputText) {
  const inTok = numberTokens(inputText);
  const missing = [...numberTokens(outputText)].filter(t => !tokenGrounded(t, inTok));
  return { ok: missing.length === 0, detail: missing.length ? `ungrounded numbers: ${missing.join(', ')}` : 'all numbers grounded' };
}

/** A numeric field (e.g. quantitativeMagnitude) must appear in the input text, or be null. */
function numberFieldGrounded(value, inputText) {
  if (value == null) return { ok: true, detail: 'null' };
  if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, detail: `non-numeric ${JSON.stringify(value)}` };
  const inTok = numberTokens(inputText);
  const candidates = [String(value), String(Math.abs(value)), value.toFixed(2), value.toFixed(1), String(Math.round(value))];
  const ok = candidates.some(c => tokenGrounded(c.replace(/\.0+$/, ''), inTok));
  return { ok, detail: ok ? `${value} grounded` : `${value} not in input` };
}

/** Every index in `indexes` is an integer in [0, count). */
function indexesSubset(indexes, count) {
  if (!Array.isArray(indexes)) return { ok: false, detail: 'not an array' };
  const bad = indexes.filter(i => !Number.isInteger(i) || i < 0 || i >= count);
  return { ok: bad.length === 0, detail: bad.length ? `out-of-range indexes: ${bad.join(', ')} (inputs: ${count})` : 'indexes ⊆ inputs' };
}

function nonEmptyIndexes(indexes) {
  const ok = Array.isArray(indexes) && indexes.length > 0;
  return { ok, detail: ok ? 'cites ≥1 source' : 'event cites no headline' };
}

/** Every value in `values` is in `allowed` (case-sensitive). */
function subsetOf(values, allowed, label = 'values') {
  if (!Array.isArray(values)) return { ok: false, detail: `${label}: not an array` };
  const set = new Set(allowed);
  const bad = values.filter(v => !set.has(v));
  return { ok: bad.length === 0, detail: bad.length ? `${label} not in inputs: ${bad.join(', ')}` : `${label} ⊆ inputs` };
}

function intInRange(value, lo, hi, label = 'value') {
  const ok = Number.isInteger(value) && value >= lo && value <= hi;
  return { ok, detail: ok ? `${label}=${value}` : `${label}=${JSON.stringify(value)} outside [${lo}, ${hi}]` };
}

function maxItems(arr, max, label = 'items') {
  const n = Array.isArray(arr) ? arr.length : 0;
  return { ok: n <= max, detail: `${label}: ${n} (max ${max})` };
}

function nonEmptyString(value, label = 'text', max = 2000) {
  const ok = typeof value === 'string' && value.trim().length > 0 && value.length <= max;
  return { ok, detail: ok ? `${label} ok` : `${label} empty, not a string, or > ${max} chars` };
}

function noHedging(text) {
  const low = String(text || '').toLowerCase();
  const hit = HEDGE_PHRASES.find(p => low.includes(p));
  return { ok: !hit, detail: hit ? `hedge phrase: "${hit}"` : 'no hedge phrases' };
}

/** Fold a list of named results into one verdict. */
function all(results) {
  const failed = results.filter(r => !r.ok);
  return { ok: failed.length === 0, failed, results };
}

module.exports = {
  numberTokens, tokenGrounded, schemaValid, numbersVerbatim, numberFieldGrounded, indexesSubset, nonEmptyIndexes,
  subsetOf, intInRange, maxItems, nonEmptyString, noHedging, all, HEDGE_PHRASES,
};

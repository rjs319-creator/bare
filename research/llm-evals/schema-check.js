'use strict';
// Minimal JSON-Schema (draft-07 subset) checker for tool input_schema objects — zero deps.
// Supports: type (string or array of types), properties, required, enum, items, nested
// objects/arrays, integer vs number. Ignores everything else (descriptions, additionalProperties).
// Returns a list of violation strings; empty = valid.

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(actual, allowed) {
  const list = Array.isArray(allowed) ? allowed : [allowed];
  return list.some(t => t === actual || (t === 'number' && actual === 'integer'));
}

function check(schema, value, path, out) {
  if (!schema || typeof schema !== 'object') return out;
  const actual = typeOf(value);
  if (schema.type && !typeMatches(actual, schema.type)) {
    out.push(`${path}: expected ${JSON.stringify(schema.type)}, got ${actual}`);
    return out;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    out.push(`${path}: ${JSON.stringify(value)} not in enum`);
  }
  if (actual === 'object' && schema.properties) {
    for (const key of schema.required || []) {
      if (!(key in value)) out.push(`${path}.${key}: required`);
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in value) check(sub, value[key], `${path}.${key}`, out);
    }
  }
  if (actual === 'array' && schema.items) {
    value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, out));
  }
  return out;
}

/** @returns {string[]} violations (empty when valid) */
function validate(schema, value) {
  return check(schema, value, '$', []);
}

module.exports = { validate, typeOf };

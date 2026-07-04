'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  clampTone, bucketOf, transcriptKey, recentEnough, parseToneFromMessage, TONE_TOOL,
} = require('../lib/earnings-tone');

// ── clampTone: bound + integerize the model's score ──────────────────────────
test('clampTone: rounds and clamps into [-10, 10]', () => {
  assert.equal(clampTone(7), 7);
  assert.equal(clampTone(7.6), 8);
  assert.equal(clampTone(11), 10);   // over-range
  assert.equal(clampTone(-14), -10); // under-range
  assert.equal(clampTone('9'), null); // wrong type
  assert.equal(clampTone(NaN), null);
});

// ── bucketOf: tone → Scoreboard tier ─────────────────────────────────────────
test('bucketOf: extremes bucket, middle band is Neutral', () => {
  assert.equal(bucketOf(3), 'Bullish');
  assert.equal(bucketOf(10), 'Bullish');
  assert.equal(bucketOf(-3), 'Bearish');
  assert.equal(bucketOf(2), 'Neutral');
  assert.equal(bucketOf(-2), 'Neutral');
  assert.equal(bucketOf(0), 'Neutral');
  assert.equal(bucketOf(null), null);
});

// ── transcriptKey: stable per-call cache key ─────────────────────────────────
test('transcriptKey: prefers fiscal period, falls back to date', () => {
  assert.equal(transcriptKey({ symbol: 'AAPL', year: 2026, quarter: 2 }), 'AAPL-2026Q2');
  assert.equal(transcriptKey({ symbol: 'AAPL', date: '2026-07-01T12:00:00Z' }), 'AAPL-2026-07-01');
  assert.equal(transcriptKey({ symbol: 'AAPL' }), null);
  assert.equal(transcriptKey(null), null);
});

// ── recentEnough: only score fresh calls ─────────────────────────────────────
test('recentEnough: within the window and not in the future', () => {
  const now = Date.parse('2026-07-04T00:00:00Z');
  assert.equal(recentEnough('2026-06-25', now, 21), true);   // 9 days ago
  assert.equal(recentEnough('2026-05-01', now, 21), false);  // 64 days ago
  assert.equal(recentEnough('2026-07-20', now, 21), false);  // future
  assert.equal(recentEnough(null, now, 21), false);
  assert.equal(recentEnough('not-a-date', now, 21), false);
});

// ── parseToneFromMessage: extract the structured result ──────────────────────
test('parseToneFromMessage: reads tone + reason from a tool_use block', () => {
  const msg = { content: [
    { type: 'text', text: 'ok' },
    { type: 'tool_use', name: 'submit_tone', input: { tone: 6, reason: 'Management sounded confident.' } },
  ] };
  assert.deepEqual(parseToneFromMessage(msg), { tone: 6, reason: 'Management sounded confident.' });
});

test('parseToneFromMessage: clamps an out-of-range tone from the model', () => {
  const msg = { content: [{ type: 'tool_use', input: { tone: 15, reason: 'Very upbeat.' } }] };
  assert.equal(parseToneFromMessage(msg).tone, 10);
});

test('parseToneFromMessage: null when no tool call or missing fields', () => {
  assert.equal(parseToneFromMessage({ content: [{ type: 'text', text: 'hi' }] }), null);
  assert.equal(parseToneFromMessage({ content: [{ type: 'tool_use', input: { tone: 5 } }] }), null); // no reason
  assert.equal(parseToneFromMessage(null), null);
});

// ── TONE_TOOL: schema is well-formed for the API ─────────────────────────────
test('TONE_TOOL: requires tone + reason', () => {
  assert.equal(TONE_TOOL.name, 'submit_tone');
  assert.deepEqual(TONE_TOOL.input_schema.required, ['tone', 'reason']);
  assert.equal(TONE_TOOL.input_schema.properties.tone.type, 'integer');
});

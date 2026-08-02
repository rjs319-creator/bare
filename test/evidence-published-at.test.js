'use strict';
// EVIDENCE EVENT PROVENANCE tests (the underreaction engine's data contract).
// The invariants that matter:
//   1. publishedAt = the EARLIEST valid source timestamp — never invented: no
//      parseable source datetime → null (the underreaction engine then reports
//      INSUFFICIENT_DATA instead of guessing an age from detectedAt).
//   2. Source records persist on the event (url/publisher/publishedAt/type) —
//      the durable provenance a prospective study needs.
//   3. The exact extractor identity (model + prompt version) is stamped so a
//      model/prompt change can never silently contaminate a prospective dataset.
//   4. All additions are ADDITIVE: legacy callers without the new opts still get
//      valid events (publishedAt null, extractor null) and validateEvent passes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEvent, validateEvent, earliestPublishedAt } = require('../lib/evidence-schema');
const { PROMPT_VERSION, MODEL } = require('../lib/evidence-extract');

const RAW = { eventType: 'guidance', claim: 'raised FY26 revenue guidance 8%', direction: 'positive', affectedHorizon: 'swing', noveltyScore: 0.8, materialityScore: 0.7 };

test('publishedAt is the earliest valid source timestamp', () => {
  const ev = normalizeEvent(RAW, {
    ticker: 'abc',
    sources: [
      { url: 'https://www.reuters.com/x', publisher: 'Reuters', datetime: '2026-07-30T14:05:00Z' },
      { url: 'https://www.prnewswire.com/y', publisher: 'PR Newswire', datetime: '2026-07-30T12:00:00Z' },
      { url: 'https://blog.example.com/z', publisher: 'Blog', datetime: 'not-a-date' },
    ],
    detectedAt: '2026-07-31',
  });
  assert.equal(ev.publishedAt, '2026-07-30T12:00:00.000Z');
  assert.equal(ev.sources.length, 3);
  assert.equal(ev.sources[1].type, 'primary_release');
  assert.equal(ev.sources[2].publishedAt, null, 'unparseable datetime → null, never fabricated');
  assert.ok(validateEvent(ev).ok);
});

test('no parseable source datetime → publishedAt null (fail closed)', () => {
  const ev = normalizeEvent(RAW, { ticker: 'ABC', sources: [{ url: 'https://x.com/a', publisher: 'X' }], detectedAt: '2026-07-31' });
  assert.equal(ev.publishedAt, null);
  assert.equal(earliestPublishedAt([]), null);
  assert.equal(earliestPublishedAt([{ datetime: 'garbage' }]), null);
});

test('extractor identity (model + prompt version) is stamped when supplied', () => {
  const ev = normalizeEvent(RAW, { ticker: 'ABC', sources: [], detectedAt: '2026-07-31', extractor: { model: MODEL, promptVersion: PROMPT_VERSION } });
  assert.deepEqual(ev.extractor, { model: 'claude-haiku-4-5-20251001', promptVersion: 'extract-v1' });
});

test('additive: legacy calls without new opts still produce valid events', () => {
  const ev = normalizeEvent(RAW, { ticker: 'ABC' });
  assert.equal(ev.publishedAt, null);
  assert.equal(ev.extractor, null);
  assert.deepEqual(ev.sources, []);
  assert.ok(validateEvent(ev).ok);
});

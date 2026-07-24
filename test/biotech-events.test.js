'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeEvent, independentOrigins, classifyTiming, daysToNextBinary, VERIFICATION } = require('../lib/biotech-events');

test('makeEvent: a matched primary source establishes PRIMARY verification', () => {
  const e = makeEvent({ ticker: 'agio', eventType: 'FDA_DECISION', actualDate: '2026-07-01',
    sources: [{ sourceType: 'sec', originId: 'acc-1', title: '8-K approval', primary: true, publishedAt: '2026-07-01' }] });
  assert.equal(e.ticker, 'AGIO');
  assert.equal(e.verification, VERIFICATION.PRIMARY);
  assert.equal(e.verified, true);
  assert.equal(e.sourceQuality, 'primary');
});

test('makeEvent: multiple articles from one press release collapse to ONE factual origin', () => {
  const sources = [
    { sourceType: 'news', title: 'XYZ announces positive Phase 3 topline results' },
    { sourceType: 'news', title: 'XYZ Announces Positive Phase 3 Topline Results!' }, // rewrite of same PR
    { sourceType: 'news', title: 'XYZ announces positive phase 3 topline results (update)' },
  ];
  const { count } = independentOrigins(sources.map(s => ({ ...s, primary: false })));
  assert.equal(count, 1, 'three rewrites of one PR = one origin');
});

test('makeEvent: news-only evidence is SECONDARY, not verified', () => {
  const e = makeEvent({ ticker: 'XYZ', eventType: 'TRIAL_READOUT',
    sources: [{ sourceType: 'news', title: 'XYZ pops on rumor', primary: false }] });
  assert.equal(e.verification, VERIFICATION.SECONDARY);
  assert.equal(e.verified, false);
});

test('makeEvent: no sources → UNVERIFIED (never fabricated)', () => {
  const e = makeEvent({ ticker: 'XYZ', eventType: 'OTHER', sources: [] });
  assert.equal(e.verification, VERIFICATION.UNVERIFIED);
  assert.equal(e.verified, false);
});

test('makeEvent: conflicting sources reduce confidence to CONFLICTED', () => {
  const e = makeEvent({ ticker: 'XYZ', eventType: 'TRIAL_READOUT', conflicts: ['one source says met, another says missed'],
    sources: [{ sourceType: 'sec', originId: 'a', title: 'x', primary: true }] });
  assert.equal(e.verification, VERIFICATION.CONFLICTED);
  assert.equal(e.verified, false);
});

test('makeEvent: two independent primary origins → CORROBORATED', () => {
  const e = makeEvent({ ticker: 'XYZ', eventType: 'FDA_DECISION', actualDate: '2026-07-01',
    sources: [
      { sourceType: 'sec', originId: 'acc-1', title: '8-K', primary: true },
      { sourceType: 'fda', originId: 'fda-1', title: 'FDA approval letter', primary: true },
    ] });
  assert.equal(e.verification, VERIFICATION.CORROBORATED);
  assert.equal(e.independentOriginCount, 2);
});

test('classifyTiming: separates expected (Ahead) from actual (Behind)', () => {
  assert.equal(classifyTiming(makeEvent({ ticker: 'X', actualDate: '2026-07-01', sources: [] }), '2026-07-10'), 'Behind');
  assert.equal(classifyTiming(makeEvent({ ticker: 'X', expectedDate: '2026-08-01', sources: [] }), '2026-07-10'), 'Ahead');
});

test('daysToNextBinary: days until the dated future binary, null when none/past', () => {
  const e = makeEvent({ ticker: 'X', expectedDate: '2026-07-20', nextUnresolvedBinaryDate: '2026-07-20', sources: [] });
  assert.equal(daysToNextBinary(e, '2026-07-10'), 10);
  assert.equal(daysToNextBinary(makeEvent({ ticker: 'X', actualDate: '2026-07-01', sources: [] }), '2026-07-10'), null);
});

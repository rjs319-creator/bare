'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sem = require('../lib/alerts-semantic');

test('parse: clamps enums, keys by episodeId, filters unknown ids, drops predictive confidence', () => {
  const out = sem.parseSemantic({
    assessments: [
      { episodeId: 'aep_1', impliedDirection: 'long', lifecycleEvent: 'entry', realThesisStated: true, semanticClarity: 'clear', thesisSpecificity: 'high', directionCertainty: 'high', promotionalRisk: 'low' },
      { episodeId: 'nope', impliedDirection: 'long', lifecycleEvent: 'entry', realThesisStated: true, semanticClarity: 'clear', thesisSpecificity: 'high', directionCertainty: 'high', promotionalRisk: 'low' },
      { episodeId: 'aep_2', impliedDirection: 'sideways', lifecycleEvent: 'x', realThesisStated: 'yes', semanticClarity: 'bogus', thesisSpecificity: 'x', directionCertainty: 'y', promotionalRisk: 'z' },
    ],
  }, ['aep_1', 'aep_2']);
  assert.ok(out.assessments.aep_1);
  assert.equal(out.assessments.nope, undefined);                 // not in the valid set
  assert.equal(out.assessments.aep_2.impliedDirection, 'none');  // invalid enum → none
  assert.equal(out.assessments.aep_2.promotionalRisk, 'medium'); // invalid enum → default
  assert.equal('confidence' in out.assessments.aep_1, false);    // no predictive confidence field
});

test('IMMUTABLE merge: an existing episode assessment is never overwritten by a later review', () => {
  const prev = { assessments: { aep_1: { impliedDirection: 'long', summary: 'original read', assessedAt: 't0' } } };
  const fresh = { assessments: { aep_1: { impliedDirection: 'short', summary: 'CHANGED read' }, aep_2: { impliedDirection: 'long' } } };
  const merged = sem.mergeSemantic(prev, fresh, { now: () => 't1' });
  assert.equal(merged.assessments.aep_1.summary, 'original read');   // unchanged
  assert.equal(merged.assessments.aep_1.impliedDirection, 'long');
  assert.equal(merged.assessments.aep_2.impliedDirection, 'long');   // new episode added
  assert.equal(merged.added, 1);
});

test('bullish and bearish theses on the same ticker are keyed by distinct episodeIds (separate assessments)', () => {
  const merged = sem.mergeSemantic({ assessments: {} }, {
    assessments: {
      aep_AAA_long: { impliedDirection: 'long' },
      aep_AAA_short: { impliedDirection: 'short' },
    },
  }, { now: () => 't' });
  assert.equal(merged.assessments.aep_AAA_long.impliedDirection, 'long');
  assert.equal(merged.assessments.aep_AAA_short.impliedDirection, 'short');
});

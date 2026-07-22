'use strict';
// OMEGA Scoreboard conviction test (Phase 13 / high-risk area #5): the shared Scoreboard must
// validate OMEGA picks against the ACTUAL logged OMEGA score, not a generic momentum proxy.
const { test } = require('node:test');
const assert = require('node:assert');
const sectionscore = require('../lib/sectionscore');

test('OMEGA section reconstructs conviction from the logged score (method omega-logged), not the proxy', () => {
  const picks = [
    { ticker: 'AAA', date: '2025-03-01', section: 'OMEGA', regime: 'risk-on', score: 82 },
    { ticker: 'BBB', date: '2025-03-01', section: 'OMEGA', regime: 'risk-on', score: 47 },
  ];
  // Provide a proxy that would be WRONG if used — the logged score must win.
  const out = sectionscore.reconstruct(picks, { candlesFor: () => null, proxyScore: () => 99 });
  assert.strictEqual(out[0].method, 'omega-logged');
  assert.strictEqual(out[0].score, 82);
  assert.strictEqual(out[1].method, 'omega-logged');
  assert.strictEqual(out[1].score, 47);
});

test('an OMEGA pick with no logged score falls back to the proxy honestly', () => {
  const picks = [{ ticker: 'CCC', date: '2025-03-01', section: 'OMEGA', regime: 'neutral' }];
  const out = sectionscore.reconstruct(picks, { candlesFor: () => null, proxyScore: () => 60 });
  assert.strictEqual(out[0].method, 'proxy');
  assert.strictEqual(out[0].score, 60);
});

test('the OMEGA scorer is registered in RECON as logged', () => {
  assert.strictEqual(sectionscore.RECON.OMEGA, 'logged');
});

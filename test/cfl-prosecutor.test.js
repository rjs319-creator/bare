'use strict';
// CFL PROSECUTOR — the adversary can only downgrade, never promote.
const test = require('node:test');
const assert = require('node:assert');
const P = require('../lib/cfl/prosecutor');

test('canPromote is structurally false in every verdict', () => {
  const r = P.prosecuteClaim({ samples: [], trades: [] });
  assert.strictEqual(r.canPromote, false);
  assert.strictEqual(r.verdict, 'RESEARCH');   // nothing could run ⇒ stay research
});

test('an edge concentrated in one monster trade fails the concentration check', () => {
  const trades = [{ net: 5 }, ...Array.from({ length: 30 }, () => ({ net: 0.01 }))];
  const r = P.prosecuteClaim({ samples: [], trades });
  const conc = r.checks.find(c => c.check === 'concentration');
  assert.strictEqual(conc.ok, false);
  assert.ok(conc.detail.top1Share > 0.5);
});

test('excision: an edge that dies without its best 5 trades does not survive', () => {
  const trades = [
    ...Array.from({ length: 5 }, () => ({ net: 1 })),
    ...Array.from({ length: 40 }, () => ({ net: -0.02 })),
  ];
  const e = P.excisionCheck(trades);
  assert.strictEqual(e.survives, false);
});

test('excision: a broad edge survives removing the best 5/10/20', () => {
  const trades = Array.from({ length: 100 }, (_, i) => ({ net: 0.01 + (i % 7) * 0.001 }));
  const e = P.excisionCheck(trades);
  assert.strictEqual(e.survives, true);
});

test('too few trades is an honest refusal, not a pass', () => {
  const e = P.excisionCheck([{ net: 1 }, { net: 2 }]);
  assert.strictEqual(e.ok, false);
  assert.strictEqual(e.reason, 'insufficient-trades');
});

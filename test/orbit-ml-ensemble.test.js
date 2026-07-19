'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const E = require('../lib/orbit-ml-ensemble');

function lcg(seed) { let s = seed >>> 0; return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; }; }

test('redundancyContribution flags ORBIT-ML as redundant when its excess mirrors a peer', () => {
  const rnd = lcg(1); const rows = [];
  for (let d = 0; d < 40; d++) {
    const date = `2024-${String(1 + (d % 12)).padStart(2, '0')}-${String(1 + (d % 27)).padStart(2, '0')}`;
    for (let t = 0; t < 5; t++) {
      const ex = (rnd() - 0.5) * 0.1;
      rows.push({ date, ticker: `T${t}`, algorithm: 'momentumIgnition', excess: ex });
      rows.push({ date, ticker: `T${t}`, algorithm: 'idiosyncraticPersistence', excess: ex + (rnd() - 0.5) * 0.005 }); // near-copy
    }
  }
  const out = E.redundancyContribution(rows);
  assert.ok(out.peers.length >= 1, 'measured vs a peer');
  assert.ok(out.maxAbsReturnCorr > 0.7, `highly correlated, got ${out.maxAbsReturnCorr}`);
  assert.ok(['redundant', 'partly-redundant'].includes(out.verdict), `verdict ${out.verdict}`);
});

test('leaveOneOutIC: ORBIT-ML that carries real signal RAISES ensemble IC', () => {
  const rnd = lcg(2); const preds = [];
  for (let d = 0; d < 30; d++) {
    const date = `2024-06-${String(1 + d).padStart(2, '0')}`;
    for (let t = 0; t < 12; t++) {
      const orbit = rnd();                       // orbit-ml score
      const peer = rnd();                        // uninformative peer
      const outcome = (orbit - 0.5) * 0.2 + (rnd() - 0.5) * 0.05;  // outcome tracks orbit
      preds.push({ date, ticker: `T${t}`, outcome, scores: { momentumIgnition: peer, idiosyncraticPersistence: orbit } });
    }
  }
  const out = E.leaveOneOutIC(preds);
  assert.ok(out.ready);
  assert.ok(out.marginalDelta > 0, `marginal delta positive, got ${out.marginalDelta}`);
  assert.strictEqual(out.verdict, 'adds-incremental-info');
});

test('leaveOneOutIC: a NOISE ORBIT-ML shows ~no incremental info (honest)', () => {
  const rnd = lcg(3); const preds = [];
  for (let d = 0; d < 30; d++) {
    const date = `2024-07-${String(1 + d).padStart(2, '0')}`;
    for (let t = 0; t < 12; t++) {
      const peer = rnd();
      const outcome = (peer - 0.5) * 0.2 + (rnd() - 0.5) * 0.05;   // outcome tracks the PEER
      preds.push({ date, ticker: `T${t}`, outcome, scores: { momentumIgnition: peer, idiosyncraticPersistence: rnd() } }); // orbit = pure noise
    }
  }
  const out = E.leaveOneOutIC(preds);
  assert.ok(out.ready);
  assert.ok(out.marginalDelta <= 0.02, `noise adds ~nothing, got ${out.marginalDelta}`);
  assert.ok(['no-incremental-info', 'hurts-ensemble'].includes(out.verdict));
});

test('insufficient joint cross-section → ready:false', () => {
  const out = E.leaveOneOutIC([{ date: '2024-01-01', ticker: 'A', outcome: 0.1, scores: { idiosyncraticPersistence: 0.5 } }]);
  assert.strictEqual(out.ready, false);
});

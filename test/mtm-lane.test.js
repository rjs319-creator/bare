const test = require('node:test');
const assert = require('node:assert');
const { mtmSummary, MTM_BARS } = require('../lib/apex-routes');

test('mtmSummary combines resolved 1m nets with open marks — open positions exist from day one', () => {
  // Arrange — two resolved picks (net +2, −1) and one open pick marked at −0.5.
  const g = {
    h: { '1m': [{ net: 2 }, { net: -1 }, { net: null }] },
    mtmOpen: [{ date: '2026-08-05', barsHeld: 4, net: -0.5, netExc: -0.8 }],
  };

  // Act
  const m = mtmSummary(g);

  // Assert
  assert.strictEqual(m.version, 'mtm-v1');
  assert.strictEqual(m.resolvedN, 2);
  assert.strictEqual(m.openN, 1);
  assert.strictEqual(m.resolvedAvgNet, 0.5);          // (2 − 1) / 2
  assert.strictEqual(m.openAvgNet, -0.5);
  assert.strictEqual(m.combinedAvgNet, 0.17);         // (2 − 1 − 0.5) / 3
  assert.match(m.basis, /dividends and cash drag NOT modeled/);
});

test('mtmSummary is null when there is nothing to mark, and open-only groups still report', () => {
  assert.strictEqual(mtmSummary({ h: {}, mtmOpen: [] }), null);
  const m = mtmSummary({ h: {}, mtmOpen: [{ net: 1.2 }] });
  assert.strictEqual(m.resolvedN, 0);
  assert.strictEqual(m.combinedAvgNet, 1.2);
});

test('the open-position boundary is the 1m horizon', () => {
  assert.strictEqual(MTM_BARS, 21);
});

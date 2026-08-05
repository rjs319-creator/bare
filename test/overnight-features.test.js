// Locks the FROZEN definitions of the overnight/intraday decomposition features
// (overnight-share-conditioning, exploratory registration) — especially the
// dividend correction, which is the preregistered artifact risk: vendor opens
// are split-adjusted but not dividend-reinvested.
const test = require('node:test');
const assert = require('node:assert');
const { overnightFeatures } = require('../research/15-panel-features-v3');

const DAY = 86_400_000;
const mkBars = (n, f) => Array.from({ length: n }, (_, k) => ({ ms: k * DAY, ...f(k) }));

test('overnightFeatures: pure overnight drift gives onShare ≈ +1, flat intraday', () => {
  // Every day: close→next-open +1%, open→close flat.
  const bars = mkBars(70, (k) => { const base = 100 * Math.pow(1.01, k); return { open: base, close: base }; });
  const f = overnightFeatures(bars, 69, 63);
  assert.ok(f.onShare > 0.99, `onShare ${f.onShare}`);
  assert.ok(f.tugOfWar > 0, `tugOfWar ${f.tugOfWar}`);
});

test('overnightFeatures: pure intraday drift gives onShare ≈ −? no — onShare 0-signed, tug negative', () => {
  // Every day: flat overnight (open = prev close), intraday +1%.
  const bars = mkBars(70, (k) => ({ open: 100 * Math.pow(1.01, k), close: 100 * Math.pow(1.01, k + 1) }));
  const f = overnightFeatures(bars, 69, 63);
  assert.ok(Math.abs(f.onShare) < 0.01, `onShare ${f.onShare}`);
  assert.ok(f.tugOfWar < 0, `tugOfWar ${f.tugOfWar}`);
});

test('overnightFeatures: an ex-div bar is corrected by divAmt, not read as an overnight loss', () => {
  // Flat price at 100, one $5 dividend: uncorrected, the ex-div open of 95
  // would register a −5% "overnight return".
  const flat = mkBars(70, () => ({ open: 100, close: 100 }));
  const withDiv = flat.map((b, k) => (k === 50 ? { ...b, open: 95, close: 95, divAmt: 5 } : (k > 50 ? { ...b, open: 95, close: 95 } : b)));
  const f = overnightFeatures(withDiv, 69, 63);
  // Corrected: ln((95+5)/100) = 0 for the ex-div overnight → decomposition stays ~flat.
  assert.ok(Math.abs(f.tugOfWar) < 1e-4, `tugOfWar ${f.tugOfWar} — dividend leaked into the overnight leg`);
  const uncorrected = overnightFeatures(withDiv.map(({ divAmt, ...b }) => b), 69, 63);
  assert.ok(uncorrected.tugOfWar < -1e-4, 'control: without divAmt the artifact must appear');
});

test('overnightFeatures: fails closed on missing opens', () => {
  const bars = mkBars(70, (k) => ({ open: k % 2 ? null : 100, close: 100 }));
  const f = overnightFeatures(bars, 69, 63);
  assert.equal(f.onShare, null);
  assert.equal(f.tugOfWar, null);
});

test('overnightFeatures: fails closed without enough history', () => {
  const bars = mkBars(40, () => ({ open: 100, close: 100 }));
  const f = overnightFeatures(bars, 39, 63);
  assert.equal(f.onShare, null);
});

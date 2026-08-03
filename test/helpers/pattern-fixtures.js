'use strict';
// Synthetic candle fixtures for family-detector tests. Each returns a daily-shape candle
// array whose LAST bar is the confirmation bar. Dates are sequential ISO days.

function seq(n, start = '2026-01-02') {
  const t0 = Date.parse(start);
  return i => new Date(t0 + i * 86400000).toISOString().slice(0, 10);
}

function mk(rows) {
  const d = seq(rows.length);
  return rows.map((r, i) => ({ date: d(i), open: r[0], high: r[1], low: r[2], close: r[3], volume: r[4] || 1e6 }));
}

// Bull flag: 10-bar pole 100→130, 6-bar controlled drift, confirmation closes above boundary.
function bullFlag({ confirmClose = 131, retraceDeep = false } = {}) {
  const rows = [];
  let p = 100;
  for (let i = 0; i < 10; i++) { rows.push([p, p + 3.2, p - 0.5, p + 3, 2e6]); p += 3; }
  let q = 130;
  const drop = retraceDeep ? 4.2 : 1;      // deep retrace destroys the flag (>62% of pole)
  for (let i = 0; i < 6; i++) { rows.push([q, q + 0.8, q - drop - 0.4, q - drop, 9e5]); q -= drop; }
  rows.push([q + 0.5, Math.max(confirmClose + 0.5, q + 1), q - 0.5, confirmClose, 3e6]);
  return mk(rows);
}

function bearFlag({ confirmClose = 69 } = {}) {
  const rows = [];
  let p = 100;
  for (let i = 0; i < 10; i++) { rows.push([p, p + 0.5, p - 3.2, p - 3, 2e6]); p -= 3; }
  let q = 70;
  for (let i = 0; i < 6; i++) { rows.push([q, q + 1 + 0.4, q - 0.8, q + 1, 9e5]); q += 1; }
  rows.push([q - 0.5, q + 0.5, Math.min(confirmClose - 0.5, q - 1), confirmClose, 3e6]);
  return mk(rows);
}

// Double bottom: decline, low ~90, reaction to ~97, second low ~90.5, recovery, confirm.
function doubleBottom({ confirmClose = 98, single = false } = {}) {
  const px = single
    ? [100, 98, 96, 93, 91, 90, 90.5, 92, 93, 94, 95, 95.5, 96, 96.2, 96.4, 96.6, 96.8, 97, 97.2, 97.4] // V — one low only
    : [100, 98, 96, 93, 91, 90, 90.5, 92, 94, 96, 97, 95, 93, 91.5, 90.6, 90.4, 91.5, 93, 95, 96.5];
  const rows = px.map(x => [x + 0.2, x + 0.9, x - 0.9, x, 1e6]);
  rows.push([96.8, Math.max(confirmClose + 0.2, 97), 96.5, confirmClose, 1.5e6]);
  return mk(rows);
}

function doubleTop({ confirmClose = 92 } = {}) {
  const px = [90, 92, 94, 97, 99, 100, 99.5, 98, 96, 94, 93, 95, 97, 98.5, 99.4, 99.6, 98.5, 97, 95, 93.5];
  const rows = px.map(x => [x - 0.2, x + 0.9, x - 0.9, x, 1e6]);
  rows.push([93.2, 93.5, Math.min(confirmClose - 0.2, 93), confirmClose, 1.5e6]);
  return mk(rows);
}

// VCP: advance then three successively smaller swings (8 → 5 → 3), tight finish, confirm.
function vcp({ confirmClose = 121, expanding = false } = {}) {
  const rows = [];
  let p = 90;
  for (let i = 0; i < 8; i++) { rows.push([p, p + 4.2, p - 0.5, p + 4, 2e6]); p += 4; } // advance to ~122
  const swings = expanding ? [[122, 3], [121, 5.5], [122, 8]] : [[122, 8], [120, 5], [120, 3]];
  for (const [top, depth] of swings) {
    // down leg then up leg, ~3 bars each
    let q = top;
    for (let i = 0; i < 3; i++) { const nx = q - depth / 3; rows.push([q, q + 0.3, nx - 0.3, nx, 8e5]); q = nx; }
    for (let i = 0; i < 3; i++) { const nx = q + depth / 3.2; rows.push([q, nx + 0.3, q - 0.3, nx, 7e5]); q = nx; }
  }
  rows.push([119.5, Math.max(confirmClose + 0.4, 120), 119, confirmClose, 2.5e6]);
  return mk(rows);
}

// Flat base: pole then tight sideways range near highs, confirm above base high.
function flatBase({ confirmClose = 131.5 } = {}) {
  const rows = [];
  let p = 100;
  for (let i = 0; i < 10; i++) { rows.push([p, p + 3.2, p - 0.5, p + 3, 2e6]); p += 3; }
  const base = [129.5, 130.2, 129.2, 130.4, 129.4, 130.1, 129.6, 130.3];
  for (const b of base) rows.push([b - 0.2, b + 0.6, b - 0.7, b, 8e5]);
  rows.push([130, Math.max(confirmClose + 0.3, 130.8), 129.8, confirmClose, 2.4e6]);
  return mk(rows);
}

// Cup and handle: 44-bar cup 100→70→100 + 6-bar shallow handle + confirm bar.
function cupHandle({ confirmClose = 101.5, deepHandle = false } = {}) {
  const rows = [];
  const n = 44;
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    const c = 100 - 30 * Math.sin(Math.PI * x); // 100 → 70 → 100
    rows.push([c + 0.3, c + 1.2, c - 1.2, c, 1e6]);
  }
  const hLow = deepHandle ? 78 : 95;
  const handle = [99, 98, 97, hLow + 1, hLow, hLow + 1.5];
  for (const h of handle) rows.push([h + 0.3, h + 1, h - 0.8, h, 7e5]);
  rows.push([98.5, Math.max(confirmClose + 0.4, 99.5), 98, confirmClose, 2.2e6]);
  return mk(rows);
}

// Ascending triangle: flat top ~110 with rising lows, confirm above the flat top.
function ascTriangle({ confirmClose = 111.2 } = {}) {
  const tops = [110, 110.2, 109.9, 110.1];
  const lows = [100, 102.5, 105, 107.5];
  const rows = [];
  for (let k = 0; k < 4; k++) {
    let q = k === 0 ? 104 : lows[k - 1] + 1;
    // up to the top
    for (let i = 0; i < 3; i++) { const nx = q + (tops[k] - q) / (3 - i); rows.push([q, nx + 0.3, q - 0.3, nx, 1e6]); q = nx; }
    // down to the rising low
    for (let i = 0; i < 2; i++) { const nx = q - (q - lows[k]) / (2 - i); rows.push([q, q + 0.3, nx - 0.3, nx, 9e5]); q = nx; }
  }
  rows.push([109, Math.max(confirmClose + 0.3, 110.5), 108.8, confirmClose, 2.5e6]);
  return mk(rows);
}

function descTriangle({ confirmClose = 98.6 } = {}) {
  const bottoms = [100, 99.9, 100.1, 100];
  const highs = [110, 107.5, 105, 102.5];
  const rows = [];
  for (let k = 0; k < 4; k++) {
    let q = k === 0 ? 106 : highs[k - 1] - 1;
    for (let i = 0; i < 3; i++) { const nx = q - (q - bottoms[k]) / (3 - i); rows.push([q, q + 0.3, nx - 0.3, nx, 1e6]); q = nx; }
    for (let i = 0; i < 2; i++) { const nx = q + (highs[k] - q) / (2 - i); rows.push([q, nx + 0.3, q - 0.3, nx, 9e5]); q = nx; }
  }
  rows.push([100.5, 100.8, Math.min(confirmClose - 0.3, 99.6), confirmClose, 2.5e6]);
  return mk(rows);
}

// Breakout & retest: base under 100, breakout to 106, pullback to ~100.5 holds, confirm up.
function breakoutRetest({ confirmClose = 104 } = {}) {
  const px = [96, 97, 98, 99.5, 98.5, 97.5, 99, 99.8, 98.8, 99.6, 103, 105, 106, 104, 102, 100.8, 100.5, 101.5, 102.2];
  const rows = px.map((x, i) => [x - 0.2, x + 0.8, x - 0.8, x, i >= 10 && i <= 12 ? 2.5e6 : 1e6]);
  rows.push([102.5, Math.max(confirmClose + 0.3, 103), 102.2, confirmClose, 2e6]);
  return mk(rows);
}

// Failed breakout: same start, breakout to 103, then collapse back below 100 → short.
function failedBreakout({ confirmClose = 96.8 } = {}) {
  const px = [96, 97, 98, 99.5, 98.5, 97.5, 99, 99.8, 98.8, 99.6, 102, 103, 101, 99.2, 98.5, 98.2, 98.8, 98.4];
  const rows = px.map(x => [x - 0.2, x + 0.8, x - 0.8, x, 1e6]);
  rows.push([98, 98.2, Math.min(confirmClose - 0.3, 97.4), confirmClose, 2.2e6]);
  return mk(rows);
}

// Undercut & reclaim: support ~90, undercut to 88, reclaim close above 90, confirm up.
function undercutReclaim({ confirmClose = 94.5 } = {}) {
  const px = [95, 93, 91, 90.2, 90.5, 91.5, 92.5, 91.5, 90.8, 90.3, 89.4, 88.2, 88.8, 91, 92, 92.8, 93.2];
  const rows = px.map(x => [x - 0.2, x + 0.8, x - 0.8, x, 1e6]);
  rows.push([93.4, Math.max(confirmClose + 0.3, 94), 93, confirmClose, 1.8e6]);
  return mk(rows);
}

// Pure steady downtrend — negative control for long families.
function downtrend() {
  const rows = [];
  let p = 100;
  for (let i = 0; i < 21; i++) { rows.push([p, p + 0.6, p - 1.4, p - 1.1, 1e6]); p -= 1.1; }
  return mk(rows);
}

module.exports = {
  mk, bullFlag, bearFlag, doubleBottom, doubleTop, vcp, flatBase, cupHandle,
  ascTriangle, descTriangle, breakoutRetest, failedBreakout, undercutReclaim, downtrend,
};

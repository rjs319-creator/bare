'use strict';
// ⏱ HEAVY-ENDPOINT CLIENT TIMEOUT GUARD.
//
// public/js/fetch-json.js aborts at DEFAULT_TIMEOUT_MS (20s). That is correct for the ~110
// sub-second reads, but WRONG for any tab whose endpoint does real server-side work. Measured
// cold on prod (serial, 2026-07-25):
//
//   atlasx 15.4s · omega 13.6s · swingmonitor 13.3s · challenger 12.7s
//   ignition 11.9s · evolve 11.5s · today 11-13s · scoreboard 10.5s · pulse gather 29s
//
// Every one of those is at or near the 20s abort, so a slow upstream turns a working tab into
// its error state — the client giving up while the server is still legitimately working. Each
// such call site must therefore pass an explicit HEAVY_TIMEOUT_MS (or, for optional overlays
// that share a Promise.all with a primary payload, OPTIONAL_TIMEOUT_MS).
//
// SOURCE-SCAN assertions on purpose: the defect is a client-side call-site config that no
// data-layer test can reach.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const readJs = f => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8');
const FETCH_JSON_JS = readJs('fetch-json.js');

const numFrom = (src, name) => {
  const m = src.match(new RegExp(`${name}\\s*=\\s*(\\d+)`));
  assert.ok(m, `could not find constant ${name}`);
  return Number(m[1]);
};

// Primary payloads: the tab renders its empty/error state if these abort.
const HEAVY_SITES = [
  ['app.js', 'op=pulse'],
  ['app.js', 'op=pulserefine'],
  ['today.js', 'op=today'],
  ['atlas.js', 'op=atlasx'],
  ['omega-swing.js', 'op=omega'],
  ['swing-supervisor.js', 'op=swingmonitor'],
  ['ignition.js', 'op=ignition'],
  ['evolve.js', 'op=evolve'],
  ['leaderboard.js', 'op=scoreboard'],
];

// Optional overlays sharing a Promise.all with a primary payload — these must stay BOUNDED,
// because Promise.all waits for a caught rejection to settle: their timeout is the primary
// render's worst-case delay.
const OPTIONAL_SITES = [
  ['today.js', 'op=maturity'],
  ['today.js', 'op=challenger'],
  ['leaderboard.js', 'op=leaderboard'],
];

for (const [file, op] of HEAVY_SITES) {
  test(`${file} ${op} passes the HEAVY timeout budget`, () => {
    // Arrange: isolate this call site.
    const src = readJs(file);
    const idx = src.indexOf(`fetchJSON('/api/tracker?${op}'`);
    assert.ok(idx > -1, `no fetchJSON call site for ${op} in ${file}`);
    const callSite = src.slice(idx, idx + 200);

    // Assert: must not ride the 20s default.
    assert.match(callSite, /timeoutMs:\s*HEAVY_TIMEOUT_MS/,
      `${file} ${op} rides the 20s default — a slow upstream will blank the tab`);
  });
}

for (const [file, op] of OPTIONAL_SITES) {
  test(`${file} ${op} stays on the bounded OPTIONAL budget`, () => {
    // Arrange
    const src = readJs(file);
    const idx = src.indexOf(`fetchJSON('/api/tracker?${op}'`);
    assert.ok(idx > -1, `no fetchJSON call site for ${op} in ${file}`);
    const callSite = src.slice(idx, idx + 200);

    // Assert: an optional overlay must NOT take the heavy budget — it would hold the primary
    // render hostage for the full 70s via Promise.all.
    assert.match(callSite, /timeoutMs:\s*OPTIONAL_TIMEOUT_MS/,
      `${file} ${op} is optional but does not use the bounded OPTIONAL budget`);
  });
}

// op=patterns builds its URL as a template literal (the view filter is interpolated), so it
// can't ride the HEAVY_SITES quote-matcher above. It became a heavy payload the first night
// the radar populated (2026-08-07: ~2,800 episodes, 3.7MB) — on mobile data that transfer
// alone can blow the 20s default and blank the tab.
test('app.js op=patterns passes the HEAVY timeout budget', () => {
  // Arrange: isolate this call site.
  const src = readJs('app.js');
  const idx = src.indexOf('fetchJSON(`/api/tracker?op=patterns');
  assert.ok(idx > -1, 'no fetchJSON call site for op=patterns in app.js');
  const callSite = src.slice(idx, idx + 200);

  // Assert: must not ride the 20s default.
  assert.match(callSite, /timeoutMs:\s*HEAVY_TIMEOUT_MS/,
    'app.js op=patterns rides the 20s default — a slow transfer will blank the tab');
});

test('every file using a shared budget actually imports it', () => {
  const files = [...new Set([...HEAVY_SITES, ...OPTIONAL_SITES].map(([f]) => f))];
  for (const f of files) {
    const src = readJs(f);
    const imp = src.match(/import \{[^}]*\} from '\.\/fetch-json\.js'/);
    assert.ok(imp, `${f} has no fetch-json import`);
    if (/timeoutMs:\s*HEAVY_TIMEOUT_MS/.test(src)) {
      assert.match(imp[0], /HEAVY_TIMEOUT_MS/, `${f} uses HEAVY_TIMEOUT_MS without importing it`);
    }
    if (/timeoutMs:\s*OPTIONAL_TIMEOUT_MS/.test(src)) {
      assert.match(imp[0], /OPTIONAL_TIMEOUT_MS/, `${f} uses OPTIONAL_TIMEOUT_MS without importing it`);
    }
  }
});

test('the budgets are ordered: default < optional < heavy', () => {
  // Arrange
  const dflt = numFrom(FETCH_JSON_JS, 'DEFAULT_TIMEOUT_MS');
  const opt = numFrom(FETCH_JSON_JS, 'OPTIONAL_TIMEOUT_MS');
  const heavy = numFrom(FETCH_JSON_JS, 'HEAVY_TIMEOUT_MS');

  // Assert: the three tiers must stay meaningfully distinct, or the distinction is decorative.
  assert.ok(dflt < opt, `default ${dflt} must be below optional ${opt}`);
  assert.ok(opt < heavy, `optional ${opt} must be below heavy ${heavy}`);
});

test('the HEAVY budget clears the 60s serverless wall', () => {
  // Arrange: vercel.json caps these functions at 60s.
  const VERCEL_WALL_MS = 60000;
  const heavy = numFrom(FETCH_JSON_JS, 'HEAVY_TIMEOUT_MS');

  // Assert: below the wall, a client abort can only ever pre-empt a server that is still
  // working — it cannot save time, it just converts a real answer into a false error.
  assert.ok(heavy > VERCEL_WALL_MS, `heavy ${heavy}ms must exceed the ${VERCEL_WALL_MS}ms wall`);
});

test('the OPTIONAL budget covers the slowest measured overlay', () => {
  // Arrange: op=challenger measured 12.7s cold; keep real headroom over it so the overlay
  // degrades only when genuinely stuck, not routinely.
  const SLOWEST_OPTIONAL_MS = 12700;
  const opt = numFrom(FETCH_JSON_JS, 'OPTIONAL_TIMEOUT_MS');

  // Assert
  assert.ok(opt >= SLOWEST_OPTIONAL_MS * 2,
    `optional ${opt}ms leaves too little headroom over the slowest overlay (${SLOWEST_OPTIONAL_MS}ms)`);
});

test('the shared default is still low enough to fail a stall fast', () => {
  // The 20s default exists to stop a stalled read hanging a tab (#191/#192). Guard against
  // someone "fixing" timeouts by simply raising the global default, which would silently
  // reintroduce the hang for all ~110 fast call sites.
  const dflt = numFrom(FETCH_JSON_JS, 'DEFAULT_TIMEOUT_MS');
  assert.ok(dflt <= 20000, `default raised to ${dflt}ms — that reintroduces the tab-hang it exists to prevent`);
});

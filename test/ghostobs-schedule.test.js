'use strict';
// ghostobs/ had NO writer from 2026-08-13 (op=ghostlog left the `ledger` chain when
// ghost was retired) to 2026-10-02, while lib/premove-routes.js kept reading
// readAllGhostObsDays() for the Pre-Move inventory — the input was frozen for ~7 weeks
// and nothing surfaced it. These pins make both halves of that failure loud:
//   1. op=ghostlog is SCHEDULED, in a root-reachable chain, AHEAD of its consumers;
//   2. the Pre-Move payload reports ghostobs freshness, and calls an old ledger stale.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const WC = require('../lib/warm-chains');
const { ghostObsFreshness, STALE_AFTER_SESSIONS } = require('../lib/ghostobs-freshness');
const { isMarketHoliday } = require('../lib/stats');

const chainsReachableFromRoots = () => {
  const seen = new Set();
  const walk = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const s of WC.CHAINS[name] || []) if (s.startsWith('@')) walk(s.slice(1));
  };
  WC.ROOT_CHAINS.forEach(walk);
  return seen;
};
const stepIndex = (steps, op) => steps.findIndex((s) => s === op || s.startsWith(op + '&'));

test('op=ghostlog is scheduled in a chain reachable from ROOT_CHAINS', () => {
  const reachable = chainsReachableFromRoots();
  const homes = [...reachable].filter((name) => stepIndex(WC.CHAINS[name], 'op=ghostlog') >= 0);
  assert.equal(homes.length, 1, `exactly one scheduled home, got ${JSON.stringify(homes)}`);
});

test('op=ghostlog runs BEFORE the premove consumers in the same chain', () => {
  const home = Object.keys(WC.CHAINS).find((n) => stepIndex(WC.CHAINS[n], 'op=ghostlog') >= 0);
  const steps = WC.CHAINS[home];
  const ghost = stepIndex(steps, 'op=ghostlog');
  for (const consumer of ['op=premovelog', 'op=premoveresolve']) {
    const i = stepIndex(steps, consumer);
    assert.ok(i > ghost, `${consumer} must follow op=ghostlog in ${home}: ${JSON.stringify(steps)}`);
  }
});

test('op=ghostlog is scheduled observation-only: the retired ghost/ ledger stays frozen', () => {
  // strategy-registry `ghost` is `rejected`: "no new standalone evidence accrues".
  const step = Object.values(WC.CHAINS).flat().find((s) => s.startsWith('op=ghostlog'));
  assert.match(step, /[?&]obsonly=1\b/, step);
});

test('re-homing op=ghostlog did not add a root (the 44-root list is unchanged)', () => {
  assert.equal(WC.ROOT_CHAINS.length, 44);
});

test('ghostObsFreshness: a ledger written last session is fresh', () => {
  // 2026-10-01 (Thu) → 2026-10-02 (Fri): one session behind, i.e. "last night's write".
  const f = ghostObsFreshness({ lastDate: '2026-10-01', asOfDate: '2026-10-02', isHoliday: isMarketHoliday });
  assert.deepEqual(f, { lastDate: '2026-10-01', sessionsBehind: 1, stale: false, status: 'fresh' });
});

test('ghostObsFreshness: a weekend does not count as missed sessions', () => {
  // Fri 2026-09-25 → Mon 2026-09-28 is ONE session behind, not three days.
  const f = ghostObsFreshness({ lastDate: '2026-09-25', asOfDate: '2026-09-28', isHoliday: isMarketHoliday });
  assert.equal(f.sessionsBehind, 1);
  assert.equal(f.stale, false);
});

test('ghostObsFreshness: the real 7-week gap is reported stale with the session count', () => {
  const f = ghostObsFreshness({ lastDate: '2026-08-12', asOfDate: '2026-10-02', isHoliday: isMarketHoliday });
  assert.equal(f.stale, true);
  assert.equal(f.status, 'stale');
  assert.ok(f.sessionsBehind >= 30, `expected dozens of sessions behind, got ${f.sessionsBehind}`);
  assert.ok(f.sessionsBehind >= STALE_AFTER_SESSIONS);
});

test('ghostObsFreshness: no ledger at all is "missing", never silently fresh', () => {
  assert.deepEqual(ghostObsFreshness({ lastDate: null, asOfDate: '2026-10-02' }),
    { lastDate: null, sessionsBehind: null, stale: true, status: 'missing' });
});

test('ghostObsFreshness: a malformed or future date fails closed as stale', () => {
  assert.equal(ghostObsFreshness({ lastDate: 'not-a-date', asOfDate: '2026-10-02' }).stale, true);
  assert.equal(ghostObsFreshness({ lastDate: '2026-10-09', asOfDate: '2026-10-02' }).sessionsBehind, 0);
});

test('Pre-Move inventory payload carries ghostobs freshness (the silent-stop detector)', async () => {
  const PR = require('../lib/premove-routes');
  // No Blob store in tests → every ledger reads empty; the detector must still be
  // present and must say the input is missing rather than omit the field.
  const { counts, ghostobs } = await PR.assembleCandidates();
  assert.equal(counts.ghostDay, null);
  assert.equal(ghostobs.status, 'missing');
  assert.equal(ghostobs.stale, true);
});

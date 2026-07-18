'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const S = require('../lib/security-master');

const sectorOf = { AAPL: 'Technology', OLDCO: 'Industrials', REUSE: 'Financials' };

// ── buildMaster: merge the identity sources ─────────────────────────────────
test('buildMaster tags a live known symbol as active with its sector + source', () => {
  const m = S.buildMaster({ sectorOf, knownSymbols: ['AAPL'] });
  assert.equal(m.AAPL.status, 'active');
  assert.equal(m.AAPL.sector, 'Technology');
  assert.equal(m.AAPL.securityId, 'AAPL');
  assert.ok(m.AAPL.sources.includes('universe'));
});

test('buildMaster marks a removed-and-no-longer-known symbol as removed with its date', () => {
  const m = S.buildMaster({ sectorOf, knownSymbols: ['AAPL'], removed: [{ ticker: 'OLDCO', removedDate: '2024-03-01' }] });
  assert.equal(m.OLDCO.status, 'removed');
  assert.equal(m.OLDCO.removedDate, '2024-03-01');
  assert.ok(m.OLDCO.sources.includes('constituents'));
});

test('buildMaster keeps a symbol ACTIVE when an old removal is contradicted by live membership (re-add)', () => {
  const m = S.buildMaster({ sectorOf, knownSymbols: ['REUSE'], removed: [{ ticker: 'REUSE', removedDate: '2022-01-01' }] });
  assert.equal(m.REUSE.status, 'active');
  assert.equal(m.REUSE.removedDate, null);
  assert.equal(m.REUSE.priorRemoval, '2022-01-01'); // recorded, not fabricated away
});

test('buildMaster folds observed first/last-seen from the ledger', () => {
  const observed = { AAPL: { firstSeen: '2026-01-05', lastSeen: '2026-02-10' } };
  const m = S.buildMaster({ sectorOf, knownSymbols: ['AAPL'], observed });
  assert.equal(m.AAPL.firstSeen, '2026-01-05');
  assert.equal(m.AAPL.lastSeen, '2026-02-10');
  assert.ok(m.AAPL.sources.includes('ledger'));
});

// ── resolveAsOf: point-in-time status ───────────────────────────────────────
test('resolveAsOf: a removed name reads inactive ON/AFTER its removal date, active before', () => {
  const rec = { symbol: 'OLDCO', securityId: 'OLDCO', sector: 'Industrials', status: 'removed', firstSeen: '2020-01-01', removedDate: '2024-03-01' };
  assert.equal(S.resolveAsOf(rec, '2024-03-01').active, false);
  assert.equal(S.resolveAsOf(rec, '2024-02-28').active, true);
});

test('resolveAsOf: firstSeen (a KNOWN-SINCE date) after the as-of date flags knownAsOf false but stays active', () => {
  // firstSeen is when OUR ledger first logged it, NOT a listing date — so it must not
  // drop a long-listed name from an old universe. active is driven by removal only.
  const rec = { symbol: 'AAPL', securityId: 'AAPL', status: 'active', firstSeen: '2026-01-05' };
  const r = S.resolveAsOf(rec, '2025-12-01');
  assert.equal(r.active, true);
  assert.equal(r.knownAsOf, false);
});

test('resolveAsOf: unknown firstSeen returns knownAsOf null (does not over-claim unlisted)', () => {
  const rec = { symbol: 'AAPL', securityId: 'AAPL', status: 'active', firstSeen: null };
  const r = S.resolveAsOf(rec, '2010-01-01');
  assert.equal(r.knownAsOf, null);
  assert.equal(r.active, true); // no evidence it was unlisted → treated active, flagged as unknown
});

test('resolveAsOf: a missing record is reported not-found rather than throwing', () => {
  const r = S.resolveAsOf(null, '2026-01-01');
  assert.equal(r.found, false);
  assert.equal(r.status, 'unknown');
});

// ── universeAtFrom: the point-in-time universe ──────────────────────────────
test('universeAtFrom excludes names removed by the date and includes those active then', () => {
  const records = {
    AAPL: { symbol: 'AAPL', status: 'active', firstSeen: '2020-01-01' },
    OLDCO: { symbol: 'OLDCO', status: 'removed', firstSeen: '2018-01-01', removedDate: '2024-03-01' },
  };
  assert.deepEqual(S.universeAtFrom(records, '2023-06-01'), ['AAPL', 'OLDCO']); // both active mid-2023
  assert.deepEqual(S.universeAtFrom(records, '2025-01-01'), ['AAPL']);          // OLDCO gone by 2025
});

test('universeAtFrom keeps a name with a LATE ledger firstSeen (delisting-only gate, no listing feed)', () => {
  // AAPL was only first LOGGED by us in 2026, but it was never removed — so it must
  // still appear in a 2023 universe. Gating on firstSeen here would be the bug.
  const records = { AAPL: { symbol: 'AAPL', status: 'active', firstSeen: '2026-01-05' } };
  assert.deepEqual(S.universeAtFrom(records, '2023-06-01'), ['AAPL']);
});

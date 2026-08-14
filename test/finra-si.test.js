'use strict';
// FINRA consolidated short interest — point-in-time availability, schema discipline,
// append-only revisions, and safe degradation (OMEGA_SI_LEVEL_5D_TOP10 spine).
const { test } = require('node:test');
const assert = require('node:assert');
const SI = require('../lib/research/finra-si');

// Raw-row factory mirroring the real FINRA payload shape.
const raw = (over = {}) => ({
  settlementDate: '2025-06-13', symbolCode: 'NVDA',
  currentShortPositionQuantity: 250_000_000, previousShortPositionQuantity: 240_000_000,
  averageDailyVolumeQuantity: 200_000_000, daysToCoverQuantity: 1.25,
  changePercent: 4.17, revisionFlag: null, ...over,
});
const snap = (settlementDate, rows, over = {}) => ({
  settlementDate, fetchedAt: '2026-08-13T00:00:00Z', sourceHash: 'h-' + settlementDate, rows, ...over,
});

test('a FINRA observation is unavailable before publication (settlement date itself never joins)', () => {
  const { bySymbol } = SI.buildSiHistory([snap('2025-06-13', [raw()])]);
  // On the settlement date, and through the whole pre-publication window, the join is null.
  assert.strictEqual(SI.asOfJoinSi(bySymbol.get('NVDA'), '2025-06-13'), null);
  assert.strictEqual(SI.asOfJoinSi(bySymbol.get('NVDA'), '2025-06-25'), null);   // 12 days later: still dark
  const joined = SI.asOfJoinSi(bySymbol.get('NVDA'), '2025-06-26');              // settlement + 13d
  assert.ok(joined && joined.settlementDate === '2025-06-13');
  assert.strictEqual(joined.availableAt, '2025-06-26');
});

test('future observations cannot enter earlier decisions', () => {
  const { bySymbol } = SI.buildSiHistory([
    snap('2025-05-30', [raw({ settlementDate: '2025-05-30', daysToCoverQuantity: 2 })]),
    snap('2025-06-13', [raw({ daysToCoverQuantity: 9 })]),
  ]);
  const joined = SI.asOfJoinSi(bySymbol.get('NVDA'), '2025-06-20');
  // 2025-06-13 becomes available 06-26; on 06-20 only the May settlement may serve.
  assert.strictEqual(joined.settlementDate, '2025-05-30');
  assert.strictEqual(joined.dtc, 2);
});

test('ticker joins cannot cross-contaminate symbols', () => {
  const { bySymbol } = SI.buildSiHistory([snap('2025-06-13', [
    raw({ symbolCode: 'NVDA', daysToCoverQuantity: 1 }),
    raw({ symbolCode: 'GME', daysToCoverQuantity: 25 }),
  ])]);
  assert.strictEqual(SI.asOfJoinSi(bySymbol.get('NVDA'), '2025-07-15').dtc, 1);
  assert.strictEqual(SI.asOfJoinSi(bySymbol.get('GME'), '2025-07-15').dtc, 25);
  assert.strictEqual(bySymbol.get('NVDA').length, 1);
});

test('settlement date is not treated as publication date', () => {
  const a = SI.availabilityFor('2025-06-13');
  assert.ok(a.publicationDate > '2025-06-13');
  assert.ok(a.availableAt > '2025-06-13');
  assert.strictEqual(a.availabilityMethod, 'conservative_13d_fallback');
});

test('conservative fallback never produces earlier availability than the estimated publication', () => {
  for (const s of ['2025-01-15', '2025-06-13', '2025-12-31', '2026-07-31']) {
    const a = SI.availabilityFor(s);
    assert.ok(a.availableAt >= a.publicationDate, `${s}: ${a.availableAt} < ${a.publicationDate}`);
    assert.ok(a.availableAt >= SI.addCalendarDays(s, 13));
  }
  // The staler predeclared variant is strictly later than the primary.
  const p = SI.availabilityFor('2025-06-13'), q = SI.availabilityFor('2025-06-13', { lagDays: 16 });
  assert.ok(q.availableAt > p.availableAt);
});

test('revisions append a new version instead of overwriting history', () => {
  const first = snap('2025-06-13', [raw({ daysToCoverQuantity: 1.25 })], { fetchedAt: '2026-01-01T00:00:00Z' });
  const refetch = snap('2025-06-13', [raw({ daysToCoverQuantity: 9.99, revisionFlag: 'R' })], { fetchedAt: '2026-08-01T00:00:00Z' });
  const { bySymbol, health } = SI.buildSiHistory([first, refetch]);
  const rec = bySymbol.get('NVDA')[0];
  assert.strictEqual(rec.dtc, 1.25);                    // the first observed version stays authoritative
  assert.strictEqual(health.revisions, 1);
  assert.strictEqual(rec.revisions.length, 1);
  assert.strictEqual(rec.revisions[0].dtc, 9.99);       // the revision is preserved, not lost
  assert.strictEqual(rec.revisionRisk, true);
});

test('retrospectively downloaded historical data is marked revisionRisk', () => {
  const rec = SI.toRecord(raw());
  assert.strictEqual(rec.revisionRisk, true);           // the default is risk-on — only prospective capture clears it
  const prospective = SI.toRecord(raw(), { revisionRisk: false });
  assert.strictEqual(prospective.revisionRisk, false);
});

test('daily short-sale volume cannot satisfy the short-interest schema', () => {
  const dailyVolumeRow = {
    tradeReportDate: '2025-06-13', symbolCode: 'NVDA',
    shortParQuantity: 1_000_000, shortExemptParQuantity: 100, totalParQuantity: 2_000_000, marketCode: 'Q',
  };
  const v = SI.validateSiRow(dailyVolumeRow);
  assert.strictEqual(v.ok, false);
  assert.deepStrictEqual(v.errors, ['daily_short_volume_schema']);
  // Even one daily-volume marker on an otherwise-valid row is a hard rejection.
  const hybrid = SI.validateSiRow(raw({ shortParQuantity: 5 }));
  assert.strictEqual(hybrid.ok, false);
  assert.deepStrictEqual(hybrid.errors, ['daily_short_volume_schema']);
  const { bySymbol, health } = SI.buildSiHistory([snap('2025-06-13', [dailyVolumeRow])]);
  assert.strictEqual(bySymbol.size, 0);
  assert.strictEqual(health.invalidReasons.daily_short_volume_schema, 1);
});

test('duplicate rows within a snapshot are detected and dropped', () => {
  const { bySymbol, health } = SI.buildSiHistory([snap('2025-06-13', [raw(), raw()])]);
  assert.strictEqual(bySymbol.get('NVDA').length, 1);
  assert.strictEqual(health.duplicates, 1);
});

test('partial FINRA failure degrades safely without corrupting stored history', async () => {
  // Retry client: two 500s then success — backoff path exercised, result intact.
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls <= 2) return { ok: false, status: 500, text: async () => '' };
    return { ok: true, status: 200, text: async () => JSON.stringify([raw()]) };
  };
  const page = await SI.fetchSiPage({ settlementDate: '2025-06-13', fetchImpl: flaky, retries: 3, baseBackoffMs: 1, sleepImpl: async () => {} });
  assert.strictEqual(page.rows.length, 1);
  assert.strictEqual(calls, 3);
  // A permanently failing date throws (surfaced, not silently empty)…
  await assert.rejects(SI.fetchSiPage({ settlementDate: '2025-06-13', fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }), retries: 1, baseBackoffMs: 1, sleepImpl: async () => {} }));
  // …and history built from the snapshots that DID land is unaffected by the gap.
  const { bySymbol, health } = SI.buildSiHistory([snap('2025-05-30', [raw({ settlementDate: '2025-05-30' })]), null]);
  assert.strictEqual(bySymbol.get('NVDA').length, 1);
  assert.strictEqual(health.snapshots, 1);
});

test('non-retryable HTTP errors fail fast instead of burning retries', async () => {
  let calls = 0;
  await assert.rejects(
    SI.fetchSiPage({ settlementDate: '2025-06-13', fetchImpl: async () => { calls++; return { ok: false, status: 400, text: async () => '' }; }, retries: 4, baseBackoffMs: 1, sleepImpl: async () => {} }),
    /not retryable/,
  );
  assert.strictEqual(calls, 1);
});

const test = require('node:test');
const assert = require('node:assert');
const AA = require('../lib/alpha-archive');
const { sliceOf, gexUniverse } = require('../lib/alpha-archive-routes');

// ── calendar diff ───────────────────────────────────────────────────────────

const row = (s, d, eps = 1) => ({ s, d, eps, rev: null, lu: '2026-08-01' });

test('diffCalendarSnapshots: an advanced date is a revision with negative deltaDays', () => {
  const prev = [row('AAPL', '2026-08-20')];
  const curr = [row('AAPL', '2026-08-14')];
  const d = AA.diffCalendarSnapshots(prev, curr, { prevObservedAt: '2026-08-04', observedAt: '2026-08-05' });
  assert.equal(d.revisions.length, 1);
  const r = d.revisions[0];
  assert.equal(r.symbol, 'AAPL');
  assert.equal(r.deltaDays, -6);
  assert.equal(r.direction, 'advanced');
  assert.equal(r.prevDate, '2026-08-20');
  assert.equal(r.newDate, '2026-08-14');
  assert.equal(r.observedAt, '2026-08-05');
  assert.equal(r.prevSnapshotDate, '2026-08-04');
});

test('diffCalendarSnapshots: a delayed date is direction "delayed"', () => {
  const d = AA.diffCalendarSnapshots([row('MSFT', '2026-08-10')], [row('MSFT', '2026-08-24')], { observedAt: '2026-08-05' });
  assert.equal(d.revisions.length, 1);
  assert.equal(d.revisions[0].direction, 'delayed');
  assert.equal(d.revisions[0].deltaDays, 14);
});

test('diffCalendarSnapshots: unchanged dates produce no revision, only a compare count', () => {
  const d = AA.diffCalendarSnapshots([row('NVDA', '2026-09-01')], [row('NVDA', '2026-09-01')], { observedAt: '2026-08-05' });
  assert.equal(d.revisions.length, 0);
  assert.equal(d.compared, 1);
});

test('diffCalendarSnapshots: an event that already happened is not a phantom reschedule', () => {
  // Prev snapshot had the event on 08-04; by the 08-05 observation it has passed and
  // the symbol\'s NEXT event (next quarter) appears. Comparing "next upcoming as of
  // the SAME observation date" must not flag this as a 90-day delay.
  const prev = [row('TSLA', '2026-08-04'), row('TSLA', '2026-11-03')];
  const curr = [row('TSLA', '2026-11-03')];
  const d = AA.diffCalendarSnapshots(prev, curr, { observedAt: '2026-08-05' });
  assert.equal(d.revisions.length, 0);
  assert.equal(d.compared, 1);                  // both reduce to the 11-03 event → equal
});

test('diffCalendarSnapshots: multi-row symbols reduce to the earliest upcoming event', () => {
  const prev = [row('AMD', '2026-10-27'), row('AMD', '2026-08-11')];
  const curr = [row('AMD', '2026-08-18'), row('AMD', '2026-10-27')];
  const d = AA.diffCalendarSnapshots(prev, curr, { observedAt: '2026-08-05' });
  assert.equal(d.revisions.length, 1);          // 08-11 → 08-18, the 10-27 row is not the next event
  assert.equal(d.revisions[0].deltaDays, 7);
});

test('diffCalendarSnapshots: window entries/exits are counted, never treated as revisions', () => {
  const prev = [row('OLD', '2026-08-20')];
  const curr = [row('NEW', '2026-09-15')];
  const d = AA.diffCalendarSnapshots(prev, curr, { observedAt: '2026-08-05' });
  assert.equal(d.revisions.length, 0);
  assert.equal(d.addedCount, 1);
  assert.equal(d.removedCount, 1);
});

// ── Black-Scholes gamma + GEX ───────────────────────────────────────────────

test('bsGamma: matches the closed-form value at a known point', () => {
  // S=100, K=100, σ=0.2, T=0.25, r=0 → d1 = 0.05, γ = φ(0.05)/(100·0.2·0.5) ≈ 0.03984
  const g = AA.bsGamma({ spot: 100, strike: 100, iv: 0.2, dteYears: 0.25, rate: 0 });
  assert.ok(Math.abs(g - 0.039844) < 1e-4, `gamma ${g}`);
});

test('bsGamma: rejects degenerate inputs with null, never NaN', () => {
  assert.equal(AA.bsGamma({ spot: 0, strike: 100, iv: 0.2, dteYears: 0.25 }), null);
  assert.equal(AA.bsGamma({ spot: 100, strike: 100, iv: 0, dteYears: 0.25 }), null);
  assert.equal(AA.bsGamma({ spot: 100, strike: 100, iv: 0.2, dteYears: 0 }), null);
});

const DAY_SEC = 86_400;
const mkContract = (strike, iv, oi) => ({ strike, impliedVolatility: iv, openInterest: oi });

test('expiryGex: net follows the dealer sign convention (calls positive, puts negative)', () => {
  const nowSec = 1_700_000_000;
  const chain = {
    expirationDate: nowSec + 30 * DAY_SEC,
    calls: [mkContract(100, 0.3, 1000)],
    puts: [mkContract(100, 0.3, 1000)],
  };
  const e = AA.expiryGex(chain, 100, nowSec);
  assert.ok(e.callGex > 0 && e.putGex > 0);
  // Same strike/IV/OI on both legs → identical gamma → net exactly zero.
  assert.equal(e.netGex, 0);
  const skewed = AA.expiryGex({ ...chain, puts: [mkContract(100, 0.3, 3000)] }, 100, nowSec);
  assert.ok(skewed.netGex < 0, 'put-heavy OI must be net-negative dealer gamma');
});

test('expiryGex: filters degenerate IV and far-wing strikes', () => {
  const nowSec = 1_700_000_000;
  const chain = {
    expirationDate: nowSec + 30 * DAY_SEC,
    calls: [mkContract(100, 0.0001, 5000), mkContract(200, 0.3, 5000), mkContract(100, 0.3, 100)],
    puts: [],
  };
  const e = AA.expiryGex(chain, 100, nowSec);
  assert.equal(e.contractsUsed, 1);             // junk-IV and the +100% wing dropped
  assert.equal(e.callOI, 100);
});

test('expiryGex: an expired or empty chain is null', () => {
  const nowSec = 1_700_000_000;
  assert.equal(AA.expiryGex({ expirationDate: nowSec - DAY_SEC, calls: [mkContract(100, 0.3, 10)], puts: [] }, 100, nowSec), null);
  assert.equal(AA.expiryGex({ expirationDate: nowSec + DAY_SEC, calls: [], puts: [] }, 100, nowSec), null);
});

test('nameGexRecord: aggregates expiries and totals net gex', () => {
  const nowSec = 1_700_000_000;
  const result = {
    quote: { regularMarketPrice: 50 },
    options: [
      { expirationDate: nowSec + 7 * DAY_SEC, calls: [mkContract(50, 0.4, 500)], puts: [] },
      { expirationDate: nowSec + 35 * DAY_SEC, calls: [], puts: [mkContract(50, 0.4, 500)] },
    ],
  };
  const rec = AA.nameGexRecord('nvda', result, nowSec);
  assert.equal(rec.t, 'NVDA');
  assert.equal(rec.expiries.length, 2);
  assert.equal(rec.netGex, rec.expiries[0].netGex + rec.expiries[1].netGex);
  assert.ok(rec.expiries[0].netGex > 0 && rec.expiries[1].netGex < 0);
  assert.equal(rec.totalOI, 1000);
});

test('nameGexRecord: null without a spot or without any computable expiry', () => {
  assert.equal(AA.nameGexRecord('X', { quote: {}, options: [] }, 0), null);
  assert.equal(AA.nameGexRecord('X', { quote: { regularMarketPrice: 10 }, options: [] }, 0), null);
});

// ── analyst-event dedup ─────────────────────────────────────────────────────

test('dedupeEvents: identity keys collapse the deliberate day-to-day pull overlap', () => {
  const e = { symbol: 'AAPL', publishedDate: '2026-08-04T12:00:00.000Z', gradingCompany: 'JP Morgan', action: 'upgrade' };
  const out = AA.dedupeEvents([e, { ...e }, { ...e, action: 'downgrade' }], AA.gradeEventKey);
  assert.equal(out.length, 2);
});

test('dedupeEvents: rows without identity fields are dropped', () => {
  const out = AA.dedupeEvents([{ symbol: 'A' }, { publishedDate: 'x' }, null], AA.gradeEventKey);
  assert.equal(out.length, 0);
});

test('compact event forms keep only the archive fields', () => {
  const g = AA.compactGradeEvent({ symbol: 'ab', publishedDate: 'd', gradingCompany: 'c', action: 'upgrade', newGrade: 'Buy', previousGrade: 'Hold', priceWhenPosted: 5, newsURL: 'http://x', newsTitle: 't' });
  assert.equal(g.symbol, 'AB');
  assert.ok(!('newsURL' in g) && !('newsTitle' in g));
  const t = AA.compactTargetEvent({ symbol: 'cd', publishedDate: 'd', analystCompany: 'c', analystName: 'n', priceTarget: 10, adjPriceTarget: 10, priceWhenPosted: 9, newsURL: 'u' });
  assert.equal(t.symbol, 'CD');
  assert.ok(!('newsURL' in t));
});

// ── gex slicing ─────────────────────────────────────────────────────────────

test('sliceOf: slices partition the list exactly, in order', () => {
  const list = Array.from({ length: 10 }, (_, i) => i);
  const parts = [0, 1, 2].map(s => sliceOf(list, s, 3));
  assert.deepEqual(parts.flat(), list);
  assert.ok(Math.max(...parts.map(p => p.length)) - Math.min(...parts.map(p => p.length)) <= 4);
});

test('gexUniverse: deduped, uppercase, liquid-options names lead the order', () => {
  const u = gexUniverse();
  assert.ok(u.length > 400, `universe ${u.length}`);
  assert.equal(new Set(u).size, u.length);
  const { LIQUID_OPTIONS } = require('../lib/optionsflow');
  assert.equal(u[0], String(LIQUID_OPTIONS[0]).toUpperCase());
});

test('archivehealth: exported, and counts-only by construction (no symbol/value fields emitted)', () => {
  const { runArchiveHealth } = require('../lib/alpha-archive-routes');
  assert.equal(typeof runArchiveHealth, 'function');
  const src = runArchiveHealth.toString();
  // The public telemetry view may expose counts and dates ONLY — emitting event
  // rows or per-name records from it would be an outcome-shaped read.
  for (const banned of ['.revisions,', 'records:', 'grades:', 'targets:', 'netGex']) {
    assert.ok(!src.includes(banned), `archivehealth must not emit ${banned}`);
  }
});

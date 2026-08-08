const test = require('node:test');
const assert = require('node:assert');
const { buildUniverse, planExpiries, broadShard } = require('../lib/options-universe-v2');
const { observeTicker } = require('../lib/options-observe-v2');
const { buildScanHealth, foldHealth } = require('../lib/options-health-v2');
const { sessionContext } = require('../lib/optionsflow-v2-routes');

const nowSec = Math.floor(Date.parse('2026-08-06T21:30:00Z') / 1000);
const DAY = 86400;

test('universe: deterministic — same session + inputs → identical universe (reproducible scans)', () => {
  const src = { core: ['NVDA', 'TSLA'], screener: ['HOOD'], broad: ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG'] };
  const a = buildUniverse(src, { session: '2026-08-06', budget: 6, shardSize: 2 });
  const b = buildUniverse(src, { session: '2026-08-06', budget: 6, shardSize: 2 });
  assert.deepStrictEqual(a.tickers, b.tickers);
  assert.ok(a.entries.every(e => e.source));
});

test('universe: shards ROTATE across sessions so the broad tail gets fair coverage', () => {
  const broad = Array.from({ length: 30 }, (_, i) => `T${String(i).padStart(2, '0')}`);
  const seen = new Set();
  for (let d = 0; d < 15; d++) {
    const session = new Date(Date.parse('2026-08-01T00:00:00Z') + d * DAY * 1000).toISOString().slice(0, 10);
    const { shard, shardIndex, shardCount } = broadShard(broad, session, 10);
    assert.strictEqual(shard.length, 10);
    assert.ok(shardIndex >= 0 && shardIndex < shardCount);
    shard.forEach(t => seen.add(t));
  }
  assert.strictEqual(seen.size, 30, 'every broad name is visited over the rotation');
});

test('universe: budget caps + truncation flag; higher tiers win; dedup across tiers', () => {
  const u = buildUniverse({ core: ['NVDA'], screener: ['NVDA', 'HOOD'], broad: ['AAA', 'BBB', 'CCC'] }, { session: '2026-08-06', budget: 3, shardSize: 3 });
  assert.strictEqual(u.tickers.length, 3);
  assert.strictEqual(u.tickers.filter(t => t === 'NVDA').length, 1, 'dedup');
  assert.strictEqual(u.entries[0].source, 'core');
  assert.strictEqual(u.truncated, true);
});

test('DTE BUCKETS: every configured bucket is planned; coverage recorded as requested vs covered', () => {
  const plan = planExpiries({
    expirationDates: [3, 14, 32, 58, 100].map(d => nowSec + d * DAY),
    nearestTs: nowSec + 3 * DAY, nowSec, maxExtra: 4,
  });
  assert.strictEqual(plan.buckets.length, 5);
  assert.ok(plan.buckets.every(b => b.requested));
  assert.ok(plan.buckets.every(b => b.covered), 'all buckets covered when expiries exist');
});

test('STRESS: MISSING EXPIRATIONS — an uncoverable bucket is recorded "unavailable", never silently dropped', () => {
  const plan = planExpiries({
    expirationDates: [3, 100].map(d => nowSec + d * DAY),   // nothing in 8-75 DTE
    nearestTs: nowSec + 3 * DAY, nowSec, maxExtra: 4,
  });
  const missing = plan.buckets.filter(b => !b.covered);
  assert.ok(missing.length >= 2, 'the uncoverable middle buckets are visible');
  assert.ok(missing.every(b => b.via === 'unavailable'));
});

test('STRESS: PARTIAL PROVIDER FAILURE lands in coverage diagnostics with reasons — never "no unusual activity"', () => {
  const nowMs = nowSec * 1000;
  const ok = observeTicker('GOOD', { quote: { regularMarketPrice: 100, regularMarketVolume: 1e6 }, options: [{ expirationDate: nowSec + 30 * DAY, calls: [{ strike: 100, expiration: nowSec + 30 * DAY, volume: 10, openInterest: 100, bid: 1, ask: 1.1, lastPrice: 1.05, impliedVolatility: 0.4 }], puts: [] }] }, { nowMs, session: '2026-08-06', sessionFraction: 1 });
  const fail1 = observeTicker('BAD1', null, { nowMs, session: '2026-08-06', sessionFraction: 1, failure: 'chain-fetch-error: 429 too many requests' });
  const fail2 = observeTicker('BAD2', null, { nowMs, session: '2026-08-06', sessionFraction: 1, failure: 'budget-exhausted' });
  const h = buildScanHealth([ok, fail1, fail2], { session: '2026-08-06', scanId: 's1', universe: { budget: 3 } });
  assert.strictEqual(h.tickersAttempted, 3);
  assert.strictEqual(h.tickersFailed, 2);
  assert.ok(h.coveragePct < 70);
  assert.match(h.note, /Partial coverage/);
  assert.ok(h.failureReasons['budget-exhausted'] === 1);
  assert.strictEqual(h.rateLimitSuspected, true, '429-style failures flag rate limiting');
  assert.ok(h.failedTickers.some(f => f.ticker === 'BAD1'));
});

test('TOTAL provider failure says PROVIDER FAILURE, ok:false — not an empty quiet day', () => {
  const nowMs = nowSec * 1000;
  const h = buildScanHealth([observeTicker('X', null, { nowMs, session: '2026-08-06', failure: 'no-chain-response' })], { session: '2026-08-06', scanId: 's1' });
  assert.strictEqual(h.ok, false);
  assert.match(h.note, /PROVIDER FAILURE/);
});

test('foldHealth is idempotent per scanId (a retried scan replaces, never double-counts)', () => {
  const h1 = buildScanHealth([], { session: '2026-08-06', scanId: 's1' });
  const d1 = foldHealth(null, h1);
  const d2 = foldHealth(d1, h1);
  assert.strictEqual(d2.history.length, 1);
});

test('WEEKEND/HOLIDAY CORRECTNESS: a Saturday snapshot keys to the last completed session (late capture), never a fresh weekend session', () => {
  const sat = new Date('2026-08-08T15:00:00Z');   // Saturday
  const sc = sessionContext(sat);
  assert.strictEqual(sc.lateCapture, true);
  assert.strictEqual(sc.session, '2026-08-07', 'Friday is the attested session');
  assert.strictEqual(sc.sessionFraction, 1);
});

test('session context: an in-session snapshot attests TODAY with a partial session fraction', () => {
  const midday = new Date('2026-08-06T16:00:00Z');   // ~12:00 ET on a trading Thursday
  const sc = sessionContext(midday);
  assert.strictEqual(sc.session, '2026-08-06');
  assert.strictEqual(sc.lateCapture, false);
  assert.ok(sc.sessionFraction > 0.2 && sc.sessionFraction < 0.6, `fraction ${sc.sessionFraction}`);
});

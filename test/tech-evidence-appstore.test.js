'use strict';
// Prevents: a Play-page layout drift silently producing zeros, chart rank invented for
// apps outside the top list, velocity math reading snapshots after the cutoff, z-scores
// on thin history, budget overruns with nothing persisted, and consumer mappings with
// guessed app identifiers entering signal production.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const APP = require('../lib/tech-evidence/adapters/appstore');
const VEL = require('../lib/tech-evidence/appstore-velocity');
const S = require('../lib/tech-evidence/signals');
const R = require('../lib/tech-evidence/registry');
const TSTORE = require('../lib/tech-evidence/store');
const SCHEMA = require('../lib/tech-evidence/schema');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'techev', name), 'utf8');
const NOW = new Date('2026-10-02T05:00:00Z');
const okJson = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const fail = (status) => ({ ok: false, status, headers: { get: () => null }, text: async () => 'nope' });

const HOOD_IOS = { ticker: 'HOOD', mappingId: 'HOOD-appstore-ios', version: 2, source: 'appstore', platform: 'ios', sourceId: '938003185', sourceUrl: 'https://apps.apple.com/us/app/id938003185' };
const HOOD_ANDROID = { ticker: 'HOOD', mappingId: 'HOOD-appstore-android', version: 2, source: 'appstore', platform: 'android', sourceId: 'com.robinhood.android', sourceUrl: 'https://play.google.com/store/apps/details?id=com.robinhood.android' };

// ── parsers on trimmed real payloads (probed 2026-10-02) ──────────────────────
test('iTunes lookup parser reads rating count, average, version and release date; rejects empty results', () => {
  const p = APP.parseItunesLookup(JSON.parse(fixture('itunes-lookup-hood.json')), '938003185');
  assert.equal(p.error, null);
  assert.equal(p.app.ratingCount, 4862757);
  assert.ok(Math.abs(p.app.averageRating - 4.2946) < 1e-9);
  assert.equal(p.app.version, '2026.39.1');
  assert.equal(p.app.versionReleasedAt, '2026-10-01T15:51:32Z');
  assert.equal(p.app.seller, 'Robinhood Markets Inc');
  assert.match(APP.parseItunesLookup({ resultCount: 0, results: [] }, '1').error, /no result/);
  assert.match(APP.parseItunesLookup({ resultCount: 1, results: [{ trackId: 999 }] }, '1').error, /id mismatch/);
});

test('Google Play parser ports the ds:5 path (ratings count + score) and fails soft on layout drift', () => {
  const p = APP.parsePlayDetails(fixture('play-details-hood.html'));
  assert.equal(p.error, null);
  assert.equal(p.app.ratingCount, 582479);
  assert.ok(Math.abs(p.app.averageRating - 4.7616024) < 1e-6);
  assert.equal(p.app.version, '2026.39.2');
  assert.equal(p.app.developer, 'Robinhood');
  assert.equal(p.app.title, 'Robinhood: Trading & Investing');
  assert.match(APP.parsePlayDetails('<html><body>no scripts</body></html>').error, /ds:5/);
  assert.match(APP.parsePlayDetails('<script>AF_initDataCallback({key: \'ds:5\', data:[1,[2,[]]], sideChannel: {}});</script>').error, /ratings path/);
});

test('Apple RSS chart parser yields id→rank for listed apps only', () => {
  const ranks = APP.parseChartFeed(JSON.parse(fixture('apple-rss-top-free.json')));
  assert.equal(ranks.error, null);
  assert.equal(ranks.byId['6448311069'], 2, 'ChatGPT was rank 2 in the fixture');
  assert.equal(ranks.byId['938003185'], undefined, 'an app absent from the feed has NO rank — never zero');
  assert.match(APP.parseChartFeed({ feed: {} }).error, /results/);
});

// ── collection: observations, snapshots, budget, partial persistence ─────────
function fetchFor(map) {
  return async (url) => {
    for (const [needle, res] of Object.entries(map)) if (url.includes(needle)) return typeof res === 'function' ? res() : res;
    return fail(404);
  };
}

test('collectAppstore emits per-platform ratingCount/averageRating observations, chart rank only when listed, and a per-app snapshot', async () => {
  const chart = JSON.parse(fixture('apple-rss-top-free.json'));
  chart.feed.results = [{ id: '938003185', name: 'Robinhood' }, ...chart.feed.results];
  const fetchImpl = fetchFor({
    'itunes.apple.com/lookup': okJson(JSON.parse(fixture('itunes-lookup-hood.json'))),
    'rss.marketingtools.apple.com': okJson(chart),
    'play.google.com': okJson(fixture('play-details-hood.html')),
  });
  const r = await APP.collectAppstore({ mappings: [HOOD_IOS, HOOD_ANDROID], now: NOW, fetchImpl });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const metrics = r.observations.map((o) => `${o.entity}|${o.metric}|${o.value}`).sort();
  assert.ok(metrics.includes('938003185|ratingCount|4862757'));
  assert.ok(metrics.includes('938003185|averageRating|4.2946'));
  assert.ok(metrics.includes('938003185|chartRank|1'));
  assert.ok(metrics.includes('com.robinhood.android|ratingCount|582479'));
  assert.ok(!metrics.some((m) => m.startsWith('com.robinhood.android|chartRank')), 'no chart feed is fetched for Play — no rank may be invented');
  for (const o of r.observations) assert.equal(o.effectiveDate, '2026-10-02', 'snapshot day is the retrieval day');
  assert.deepEqual(Object.keys(r.snapshots).sort(), ['938003185', 'com.robinhood.android']);
  assert.equal(r.snapshots['938003185'].chartRank, 1);
  assert.equal(r.snapshots['com.robinhood.android'].chartRank, null);
  assert.equal(r.snapshots['com.robinhood.android'].ticker, 'HOOD');
});

test('a 502 chart feed never fails the run; a failing Play fetch degrades to partial with the iOS snapshot persisted', async () => {
  const fetchImpl = fetchFor({
    'itunes.apple.com/lookup': okJson(JSON.parse(fixture('itunes-lookup-hood.json'))),
    'rss.marketingtools.apple.com': fail(502),
    'play.google.com': fail(503),
  });
  const r = await APP.collectAppstore({ mappings: [HOOD_IOS, HOOD_ANDROID], now: NOW, fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.partial, true);
  assert.ok(r.errors.some((e) => /com\.robinhood\.android/.test(e)));
  assert.ok(!r.errors.some((e) => /chart/.test(e)), 'chart feed outage is a coverage note, not an error');
  assert.equal(r.coverage.chartFeed.ok, false);
  assert.deepEqual(Object.keys(r.snapshots), ['938003185']);
  assert.equal(r.observations.filter((o) => o.metric === 'chartRank').length, 0);
});

test('an exhausted budget starts no new fetch and reports every starved app visibly', async () => {
  let called = 0;
  const r = await APP.collectAppstore({ mappings: [HOOD_IOS, HOOD_ANDROID], now: NOW, budget: { t0: Date.now() - 5000, deadlineMs: 1 }, fetchImpl: async () => { called += 1; return okJson({}); } });
  assert.equal(called, 0);
  assert.equal(r.errors.filter((e) => /skipped:budget/.test(e)).length, 2);
  assert.deepEqual(r.snapshots, {});
});

test('the daily snapshot doc merges per app under CAS so a retry or a partial night never erases earlier apps', async () => {
  const docs = {};
  const fakeStore = {
    updateJSON: async (key, mutate, { initial }) => { docs[key] = mutate(docs[key] === undefined ? initial : docs[key]); return { written: true }; },
  };
  const day = '2026-10-02';
  await TSTORE.writeAppstoreSnapshot(day, { a1: { ticker: 'HOOD', ratingCount: 1 } }, { store: fakeStore });
  await TSTORE.writeAppstoreSnapshot(day, { a2: { ticker: 'COIN', ratingCount: 2 } }, { store: fakeStore });
  await TSTORE.writeAppstoreSnapshot(day, { a1: { ticker: 'HOOD', ratingCount: 999 } }, { store: fakeStore });
  const key = TSTORE.KEYS.appstoreDay(day);
  assert.equal(key, 'techev/appstore/2026-10-02.json');
  assert.deepEqual(Object.keys(docs[key].apps).sort(), ['a1', 'a2']);
  assert.equal(docs[key].apps.a1.ratingCount, 1, 'first snapshot of the day stands (PIT first-wins)');
});

test('series fold: one ratingCount/averageRating/chartRank point per entity per day, first wins', () => {
  const mk = (metric, value, day = '2026-10-02') => SCHEMA.makeObservation({ source: 'appstore', ticker: 'HOOD', entity: '938003185', metric, effectiveDate: day, value, retrievedAt: NOW.toISOString() });
  const { series, freshObservations } = TSTORE.foldIntoSeries('appstore', null, [mk('ratingCount', 10), mk('averageRating', 4.2), mk('chartRank', 7), mk('ratingCount', 11)]);
  assert.equal(freshObservations.length, 3);
  assert.deepEqual(series.entities['938003185'].ratings, { '2026-10-02': 10 });
  assert.deepEqual(series.entities['938003185'].scores, { '2026-10-02': 4.2 });
  assert.deepEqual(series.entities['938003185'].ranks, { '2026-10-02': 7 });
});

// ── velocity / acceleration math ─────────────────────────────────────────────
// Cumulative rating counts with a steady 30-day velocity, optionally accelerating at the end.
function ratingSeries({ start = '2026-01-01', days = 200, perDay = 100, boostLastDays = 0, boostFactor = 2, skipEvery = 0 }) {
  const ratings = {};
  let total = 1_000_000;
  for (let i = 0; i < days; i += 1) {
    const d = S.addDays(start, i);
    const rate = boostLastDays && i >= days - boostLastDays ? perDay * boostFactor : perDay;
    total += Math.round(rate * (1 + 0.05 * Math.sin(i * 0.9))); // deterministic wobble → MAD > 0
    if (!(skipEvery && i % skipEvery === 3)) ratings[d] = total; // missing nights are normal
  }
  return { ratings, lastDay: S.addDays(start, days - 1) };
}

test('velocity uses the nearest snapshot at or before each window edge (±tolerance) and never a snapshot after the cutoff', () => {
  const { ratings, lastDay } = ratingSeries({ days: 100, skipEvery: 7 });
  const v = VEL.velocityAt(ratings, lastDay);
  assert.ok(v && Math.abs(v.perDay - 100) < 8, `velocity ≈ 100/day, got ${v && v.perDay}`);
  const future = { ...ratings, [S.addDays(lastDay, 1)]: 9e9 };
  const v2 = VEL.velocityAt(future, lastDay);
  assert.equal(v2.endDay <= lastDay, true, 'a snapshot dated after the cutoff must be invisible');
  assert.equal(VEL.velocityAt({ [lastDay]: 5 }, lastDay), null, 'no prior snapshot → no velocity, never a guess');
});

test('acceleration: a steady app has growth ≈ 0 and |z| small; a doubled review velocity is a positive eligible surprise', () => {
  const steady = ratingSeries({ days: 200 });
  const flat = VEL.platformSignal({ ratings: steady.ratings }, steady.lastDay);
  assert.equal(flat.available, true, flat.reason);
  assert.ok(Math.abs(flat.recentGrowth) < 0.1, `steady growth ≈ 0, got ${flat.recentGrowth}`);
  assert.ok(Math.abs(flat.z) < 2, `steady z small, got ${flat.z}`);
  const boosted = ratingSeries({ days: 200, boostLastDays: 30, boostFactor: 2 });
  const hot = VEL.platformSignal({ ratings: boosted.ratings }, boosted.lastDay);
  assert.equal(hot.available, true, hot.reason);
  assert.ok(hot.recentGrowth > 0.6, `velocity roughly doubled, got ${hot.recentGrowth}`);
  assert.ok(hot.z > 1, `z must flag the acceleration, got ${hot.z}`);
  assert.equal(hot.baselineSamples >= VEL.PARAMS.minBaseline, true);
});

test('thin history is unavailable with a stated reason — no z on fewer than the minimum baseline windows', () => {
  const thin = ratingSeries({ days: 70 });
  const r = VEL.platformSignal({ ratings: thin.ratings }, thin.lastDay);
  assert.equal(r.available, false);
  assert.match(r.reason, /baseline/);
});

test('ticker composite averages per-platform z, degrades quality when one platform is missing, and is unavailable when both are', () => {
  const ios = ratingSeries({ days: 200, boostLastDays: 30, boostFactor: 2 });
  const android = ratingSeries({ days: 200, boostLastDays: 30, boostFactor: 2, perDay: 40 });
  const both = VEL.appstoreSignal({ platforms: { ios: { ratings: ios.ratings }, android: { ratings: android.ratings } } }, ios.lastDay);
  assert.equal(both.available, true);
  assert.equal(both.quality, 'ok');
  assert.deepEqual(both.coverage.platforms.sort(), ['android', 'ios']);
  const one = VEL.appstoreSignal({ platforms: { ios: { ratings: ios.ratings } } }, ios.lastDay);
  assert.equal(one.available, true);
  assert.equal(one.quality, 'degraded');
  const none = VEL.appstoreSignal({ platforms: {} }, ios.lastDay);
  assert.equal(none.available, false);
});

test('deriveArmSignals wires the appstore arm with peer adjustment and the shared |z| ≥ 1 eligibility', () => {
  const mk = (t, boost) => {
    const s = ratingSeries({ days: 200, boostLastDays: boost ? 30 : 0, boostFactor: 2 });
    return { ticker: t, entity: `${t}:appstore`, mappingId: `${t}-appstore-ios`, mappingVersion: 2, bucket: { platforms: { ios: { ratings: s.ratings }, android: { ratings: s.ratings } } }, lastDay: s.lastDay };
  };
  const entries = [mk('HOOD', true), mk('COIN', false), mk('DUOL', false)];
  const sigs = S.deriveArmSignals('appstore', entries, entries[0].lastDay);
  assert.equal(sigs.length, 3);
  const hood = sigs.find((s) => s.ticker === 'HOOD');
  assert.equal(hood.eligible, true, hood.eligibleReason);
  assert.equal(hood.direction, 'positive');
  assert.ok(Number.isFinite(hood.peerMedianSurprise));
});

test('earnings annotation records the next report date and sessions-until, and marks unavailable lookups honestly', async () => {
  const events = [Object.freeze({ id: 'e1', arm: 'appstore', ticker: 'HOOD', cutoffDate: '2026-10-01' }), Object.freeze({ id: 'e2', arm: 'npm', ticker: 'MDB', cutoffDate: '2026-10-01' })];
  const out = await VEL.annotateEarnings(events, { lookup: async (t) => (t === 'HOOD' ? { earningsDate: '2026-10-29' } : null) });
  assert.equal(out[0].earnings.nextDate, '2026-10-29');
  assert.equal(out[0].earnings.calendarDaysUntil, 28);
  assert.equal(out[0].earnings.preEarningsWindow, true, '≥5 sessions and ≤45 calendar days ahead → inside the hypothesis window');
  assert.equal(out[1].earnings, undefined, 'non-appstore arms are untouched');
  const none = await VEL.annotateEarnings([events[0]], { lookup: async () => { throw new Error('finnhub down'); } });
  assert.equal(none[0].earnings.nextDate, null);
  assert.match(none[0].earnings.note, /unavailable/);
});

// ── registry shape ───────────────────────────────────────────────────────────
test('every appstore mapping carries a platform, a well-formed app identifier, probe-dated ownership evidence and the official store URL', () => {
  const apps = R.MAPPINGS.filter((m) => m.source === 'appstore');
  assert.ok(apps.length >= 40, `expected ~23 names × 2 platforms, got ${apps.length}`);
  const byTicker = new Map();
  for (const m of apps) {
    assert.ok(['ios', 'android'].includes(m.platform), `${m.mappingId} platform`);
    if (m.platform === 'ios') {
      assert.match(m.sourceId, /^\d{6,12}$/, `${m.mappingId} iOS id`);
      assert.equal(new URL(m.sourceUrl).hostname, 'apps.apple.com');
    } else {
      assert.match(m.sourceId, /^[a-z][\w.]+$/i, `${m.mappingId} package`);
      assert.equal(new URL(m.sourceUrl).hostname, 'play.google.com');
    }
    assert.match(m.ownershipEvidence, /2026-10-02/, `${m.mappingId} must cite the probe date`);
    assert.ok(R.validateMapping(m).ok, `${m.mappingId}: ${R.validateMapping(m).issues.join('; ')}`);
    byTicker.set(m.ticker, (byTicker.get(m.ticker) || 0) + 1);
  }
  for (const [t, n] of byTicker) assert.equal(n, 2, `${t} needs both an iOS and a Play mapping`);
  for (const t of ['APP', 'U']) {
    assert.ok(!byTicker.has(t), `${t} has no consumer app — must be a candidate, not a mapping`);
    assert.ok(R.CANDIDATES.some((c) => c.ticker === t && c.source === 'appstore'), `${t} candidate row with a reason`);
  }
  assert.ok(R.isAllowedUrl('https://itunes.apple.com/lookup?id=938003185'));
  assert.ok(R.isAllowedUrl('https://play.google.com/store/apps/details?id=com.robinhood.android'));
  assert.ok(R.isAllowedUrl('https://rss.marketingtools.apple.com/api/v2/us/apps/top-free/100/apps.json'));
});

test('a guessed app identifier cannot validate: platform/id mismatch and foreign hosts are rejected', () => {
  const ios = R.MAPPINGS.find((m) => m.source === 'appstore' && m.platform === 'ios');
  assert.equal(R.validateMapping({ ...ios, sourceId: 'com.not.numeric' }).ok, false);
  assert.equal(R.validateMapping({ ...ios, platform: 'windows' }).ok, false);
  assert.equal(R.validateMapping({ ...ios, sourceUrl: 'https://apps.apple.com.evil.example/x' }).ok, false);
});

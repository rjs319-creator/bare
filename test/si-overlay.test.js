'use strict';
// OMEGA_SI_LEVEL_5D_TOP10 — experiment-engine guarantees, verdict guards, live-OMEGA
// isolation, and route authentication.
const { test } = require('node:test');
const assert = require('node:assert');
const K = require('../research/lib/experiment-kit');
const X = require('../lib/research/si-experiment');
const F = require('../lib/research/si-features');

// Deterministic synthetic panel factory: nDates cohorts of nNames rows each.
function makePanels({ nDates = 60, nNames = 30, seed = 11, siFor = null, netFor = null } = {}) {
  const rnd = K.lcg(seed);
  const panels = [];
  const d0 = Date.parse('2024-01-02T00:00:00Z');
  for (let d = 0; d < nDates; d++) {
    const date = new Date(d0 + d * 86_400_000 * 2).toISOString().slice(0, 10);
    const rows = [];
    for (let i = 0; i < nNames; i++) {
      const ticker = `T${String(i).padStart(2, '0')}`;
      const dtc = siFor ? siFor(d, i) : +(rnd() * 12).toFixed(2);
      const si = dtc == null ? null : { settlementDate: date, dtc, si: 1e6, prevSi: 1e6, adv: 1e6, revisionFlag: null, revisionRisk: true, publicationDate: date, availableAt: date, fetchedAt: null, sourceHash: 'h' };
      const net5 = netFor ? netFor(d, i, rnd) : +((rnd() - 0.5) * 4).toFixed(4);
      rows.push({
        ticker, lastBarDate: date, sector: i % 2 ? 'Technology' : 'Energy', si, dtc,
        score: 40 + rnd() * 40, utility: rnd() * 0.05, pPositive: 0.4 + rnd() * 0.2,
        p3pct: 0.2 + rnd() * 0.2, p5pct: 0.1 + rnd() * 0.2, expResid10: (rnd() - 0.5) * 0.04,
        r10: (rnd() - 0.5) * 0.2, distFrom52High: -rnd() * 0.3, relVol5: 0.5 + rnd(),
        net: { 5: net5, 10: net5 },
      });
    }
    panels.push({ date, regime: { riskOn: true, bearish: false }, rows: F.attachSiFeatures(rows) });
  }
  return panels;
}

test('missing lastBarDate produces INSUFFICIENT_DATA', () => {
  const reasons = X.assessInsufficient({ panelCount: 0, resolvedOutcomes: 0, summary: null, missingLastBarDate: true });
  assert.ok(reasons.some((r) => r.includes('lastBarDate')));
});

test('zero panels cannot produce a negative-alpha verdict', () => {
  const reasons = X.assessInsufficient({ panelCount: 0, resolvedOutcomes: 100, summary: { oosDates: 0, siCoverage: 0, usableFolds: 0 } });
  assert.ok(reasons.includes('zero reconstructed panels'));
  assert.ok(reasons.length > 0);   // any reason at all forces INSUFFICIENT_DATA before assessRetrospective can run
});

test('zero outcomes cannot produce a negative-alpha verdict', () => {
  const reasons = X.assessInsufficient({ panelCount: 50, resolvedOutcomes: 0, summary: { oosDates: 50, siCoverage: 1, usableFolds: 4 } });
  assert.ok(reasons.includes('zero resolved outcomes'));
});

test('thin OOS, thin coverage and thin folds each trip the INSUFFICIENT_DATA guard', () => {
  const base = { panelCount: 50, resolvedOutcomes: 500 };
  assert.ok(X.assessInsufficient({ ...base, summary: { oosDates: 39, siCoverage: 1, usableFolds: 4 } }).length);
  assert.ok(X.assessInsufficient({ ...base, summary: { oosDates: 120, siCoverage: 0.59, usableFolds: 4 } }).length);
  assert.ok(X.assessInsufficient({ ...base, summary: { oosDates: 120, siCoverage: 1, usableFolds: 1 } }).length);
  assert.strictEqual(X.assessInsufficient({ ...base, summary: { oosDates: 120, siCoverage: 1, usableFolds: 4 } }).length, 0);
});

test('baseline and augmented arms use identical panels (rows, exclusions, costs)', () => {
  const panels = makePanels({ nDates: 40, nNames: 25 });
  // Knock one row's label out on every date — it must vanish from BOTH arms' world.
  for (const p of panels) p.rows[3] = { ...p.rows[3], net: { 5: null, 10: null } };
  const run = X.runSpec(panels, { topK: 5, horizon: 5 });
  const excluded = new Set(panels.map((p) => p.rows[3].ticker));
  for (const row of run.ledger) assert.ok(!excluded.has(row.ticker) || row.ticker !== 'T03');
  // Same candidate count feeds both arms on every OOS date.
  for (const d of run.perDate) assert.strictEqual(d.names, 24);
});

test('costs are applied identically to both arms (identical inputs → zero incremental exactly)', () => {
  // Every name has the SAME net outcome → whatever each arm picks, returns are equal.
  const panels = makePanels({ nDates: 40, netFor: () => 1.5 });
  const run = X.runSpec(panels, { topK: 5, horizon: 5 });
  for (const d of run.perDate) {
    assert.strictEqual(d.retB, 1.5);
    assert.strictEqual(d.retC, 1.5);
    assert.strictEqual(d.incr, 0);
  }
});

test('next-open execution is enforced by the outcome contract', () => {
  const candles = [];
  for (let i = 0; i < 10; i++) candles.push({ date: `2024-02-0${i + 1}`, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1e6 });
  const entry = { candles, idx: new Map(candles.map((b, i) => [b.date, i])) };
  const fwd = K.forwardFromNextOpen(entry, '2024-02-03', 5, null);
  // decision at index 2 → entry = open of index 3 (103), exit = close of index 7 (107.5)
  assert.ok(Math.abs(fwd - (107.5 / 103 - 1)) < 1e-12);
});

test('five-session labels are aligned correctly (exit = close of decision index + 5)', () => {
  const candles = [];
  for (let i = 0; i < 12; i++) candles.push({ date: `2024-03-${String(i + 1).padStart(2, '0')}`, open: 50, high: 51, low: 49, close: i === 6 ? 60 : 50, volume: 1e6 });
  const entry = { candles, idx: new Map(candles.map((b, i) => [b.date, i])) };
  // decision at index 1 → i+5 = index 6, whose close is the outlier 60.
  assert.ok(Math.abs(K.forwardFromNextOpen(entry, '2024-03-02', 5) - (60 / 50 - 1)) < 1e-12);
  // decision at index 2 → i+5 = index 7 (close 50) → flat.
  assert.ok(Math.abs(K.forwardFromNextOpen(entry, '2024-03-03', 5) - 0) < 1e-12);
});

test('purge gaps prevent forward-label overlap between train and test', () => {
  const dates = Array.from({ length: 50 }, (_, i) => `d${String(i).padStart(2, '0')}`);
  const folds = X.foldsOf(dates);
  assert.strictEqual(folds.length, X.FROZEN.testFolds);
  for (const f of folds) {
    assert.strictEqual(f.purgedDates.length, X.FROZEN.purgeCohorts);
    const lastTrain = f.trainDates[f.trainDates.length - 1];
    const firstTest = f.testDates[0];
    const gap = dates.indexOf(firstTest) - dates.indexOf(lastTrain);
    assert.ok(gap > X.FROZEN.purgeCohorts, `gap ${gap} must exceed purge ${X.FROZEN.purgeCohorts}`);
    for (const d of f.trainDates) assert.ok(d < firstTest);
  }
  // Never shuffled: train and test stay chronological.
  for (const f of folds) {
    assert.deepStrictEqual(f.trainDates, [...f.trainDates].sort());
    assert.deepStrictEqual(f.testDates, [...f.testDates].sort());
  }
});

test('training scalers and imputers never use test data', () => {
  const train = [{ a: 1 }, { a: 3 }, { a: null }];
  const prep = X.fitPreprocessor(train, ['a']);
  assert.strictEqual(prep.medians.a, 2);                       // median of TRAIN only
  assert.deepStrictEqual(prep.missingKeys, ['a']);
  // A wild test-time value cannot move the fitted stats.
  const vTest = X.designVector({ a: 1000 }, prep);
  const vTrain = X.designVector({ a: 1 }, prep);
  assert.strictEqual(prep.medians.a, 2);
  assert.ok(Number.isFinite(vTest[0]) && Number.isFinite(vTrain[0]));
  // Missing test value → imputed to the TRAIN median, indicator fires.
  const vMiss = X.designVector({ a: null }, prep);
  assert.strictEqual(vMiss[0], (2 - prep.means[0]) / prep.sds[0]);
  assert.ok(vMiss[1] > vTrain[1]);                             // indicator column
});

test('bootstrap output is deterministic under the fixed seed', () => {
  const rnd = K.lcg(99);
  const series = Array.from({ length: 120 }, () => (rnd() - 0.5) * 2);
  const a = X.bootstrapCI(series);
  const b = X.bootstrapCI(series);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.B, X.FROZEN.bootstrap.B);
  const c = X.bootstrapCI(series, { ...X.FROZEN.bootstrap, seed: 1 });
  assert.notDeepStrictEqual([a.lo, a.hi], [c.lo, c.hi]);       // the seed is real, not decorative
});

test('FDR calculations follow Benjamini-Hochberg', () => {
  const items = [{ id: 'a', p: 0.01 }, { id: 'b', p: 0.04 }, { id: 'c', p: 0.03 }, { id: 'd', p: 0.9 }];
  const out = K.fdr(items, { alpha: 0.05 });
  const q = Object.fromEntries(out.map((r) => [r.id, r.q]));
  // BH with m=4, sorted p = .01, .03, .04, .9 → raw p·m/rank = .04, .06, .0533…, .9;
  // step-up monotone (min over larger ranks): q(.01)=.04, q(.03)=.0533…, q(.04)=.0533…, q(.9)=.9
  assert.ok(Math.abs(q.a - 0.04) < 1e-9);
  assert.ok(Math.abs(q.c - 0.04 * 4 / 3) < 1e-9);
  assert.ok(Math.abs(q.b - 0.04 * 4 / 3) < 1e-9);
  assert.ok(Math.abs(q.d - 0.9) < 1e-9);
  assert.strictEqual(out.find((r) => r.id === 'a').survives, true);
  assert.strictEqual(out.find((r) => r.id === 'd').survives, false);
});

test('retrospective SHADOW_CANDIDATE gates hold (and NO_INCREMENTAL_ALPHA otherwise)', () => {
  const good = {
    summary: {
      oosDates: 150, positiveFolds: 4, usableFolds: 4,
      incremental: { meanPct: 0.5, bootstrap: { lo: 0.1, hi: 0.9 }, tTest: { pOneSided: 0.003 } },
    },
    staleSummary: { incremental: { meanPct: 0.4 } },
    exRevisedSummary: { incremental: { meanPct: 0.45 } },
    fdrQ: 0.06,
  };
  assert.strictEqual(X.assessRetrospective(good).verdict, 'SHADOW_CANDIDATE');
  assert.strictEqual(X.assessRetrospective({ ...good, fdrQ: 0.2 }).verdict, 'NO_INCREMENTAL_ALPHA');
  assert.strictEqual(X.assessRetrospective({ ...good, staleSummary: { incremental: { meanPct: -0.1 } } }).verdict, 'NO_INCREMENTAL_ALPHA');
  assert.strictEqual(X.assessRetrospective({ ...good, summary: { ...good.summary, incremental: { ...good.summary.incremental, bootstrap: { lo: -0.01, hi: 0.9 } } } }).verdict, 'NO_INCREMENTAL_ALPHA');
});

// ── Live-OMEGA isolation ─────────────────────────────────────────────────────
function syntheticCandles(n = 260, seed = 5) {
  const rnd = K.lcg(seed);
  const out = [];
  let px = 100;
  const d0 = Date.parse('2025-06-02T00:00:00Z');
  for (let i = 0; i < n; i++) {
    px *= 1 + (rnd() - 0.48) * 0.02;
    out.push({ date: new Date(d0 + i * 86_400_000).toISOString().slice(0, 10), open: px * 0.995, high: px * 1.01, low: px * 0.99, close: px, volume: 5e6 + rnd() * 1e6 });
  }
  return out;
}

test('live OMEGA rankings are byte-for-byte unchanged when the experiment is enabled', () => {
  const O = require('../lib/omega-swing');
  const candles = syntheticCandles(260, 5);
  const spy = syntheticCandles(260, 6);
  const args = () => ({ ticker: 'TEST', candles, bench: { spy, sector: null }, ctx: { regime: { riskOn: true, bearish: false } } });
  const before = JSON.stringify(O.evaluateCandidate(args()));
  // Load every experiment module and exercise it — the SI overlay must be inert to OMEGA.
  require('../lib/research/finra-si');
  require('../lib/research/si-features');
  require('../lib/research/si-experiment');
  require('../lib/si-overlay-routes');
  process.env.SI_OVERLAY_ENABLED = '1';
  X.runSpec(makePanels({ nDates: 30 }), { topK: 5, horizon: 5 });
  const after = JSON.stringify(O.evaluateCandidate(args()));
  delete process.env.SI_OVERLAY_ENABLED;
  assert.strictEqual(after, before);
  // And the OMEGA scorer has no code path into the overlay at all.
  const src = require('node:fs').readFileSync(require.resolve('../lib/omega-swing.js'), 'utf8');
  assert.ok(!/si-overlay|si-experiment|si-features|finra-si|shortinterest/.test(src));
});

// ── Route authentication ─────────────────────────────────────────────────────
function mkRes() {
  const r = { headers: {}, code: null, body: null, setHeader(k, v) { r.headers[k] = v; }, status(c) { r.code = c; return r; }, json(o) { r.body = o; return r; }, send(s) { r.body = s; return r; } };
  return r;
}

test('authentication protects the privileged research route', async () => {
  const prevSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'test-secret-abc';
  try {
    delete require.cache[require.resolve('../lib/si-overlay-routes')];
    const R = require('../lib/si-overlay-routes');
    const res = mkRes();
    await R.runSiTick({ query: {}, headers: {} }, res);        // no bearer
    assert.strictEqual(res.code, 401);
    const res2 = mkRes();
    await R.runSiTick({ query: {}, headers: { authorization: 'Bearer wrong' } }, res2);
    assert.strictEqual(res2.code, 401);
  } finally {
    if (prevSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prevSecret;
    delete require.cache[require.resolve('../lib/si-overlay-routes')];
  }
});

test('the tracker classifies sitick as privileged', () => {
  const src = require('node:fs').readFileSync(require.resolve('../api/tracker.js'), 'utf8');
  const priv = src.match(/PRIVILEGED_OPS = new Set\(\[([\s\S]*?)\]\)/)[1];
  assert.ok(/'sitick'/.test(priv));
  for (const op of ['sistatus', 'sisnapshot', 'sihealth', 'siwf', 'siledger', 'siexport', 'sitick']) {
    assert.ok(new RegExp(`op === '${op}'`).test(src), `op=${op} must be dispatched`);
  }
});

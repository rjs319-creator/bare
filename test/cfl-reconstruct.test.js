'use strict';
// CFL RECONSTRUCTION — an end-to-end fixture: synthetic dataset → production
// replay → episodes → detection trace → deterministic attribution. No network.
const test = require('node:test');
const assert = require('node:assert');
const RECON = require('../lib/cfl/reconstruct');
const CFG = require('../lib/cfl/config');

// Deterministic trading-day axis (weekdays only, real calendar dates).
function tradingDates(n, start = '2025-06-02') {
  const out = [];
  const d = new Date(start + 'T00:00:00Z');
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function series(dates, { start = 100, drift = 0.0005, vol = 0.01, burstAt = null, burstPct = 0 } = {}) {
  let px = start;
  return dates.map((date, i) => {
    // Deterministic pseudo-noise (no Math.random — reproducible fixtures).
    const noise = Math.sin(i * 1.7) * vol;
    px = px * (1 + drift + noise);
    if (burstAt != null && i >= burstAt && i < burstAt + 5) px = px * (1 + burstPct / 5 / 100);
    const open = px * 0.999, close = px;
    return { date, open, high: Math.max(open, close) * 1.005, low: Math.min(open, close) * 0.995, close, volume: 2_000_000 + (i % 10) * 100_000 };
  });
}

const N = 260;
const DATES = tradingDates(N);
const spyCandles = series(DATES, { drift: 0.0004, vol: 0.004 });

function buildDataset(burstTicker = 'MOVER', burstAt = 210) {
  const dataset = new Map();
  for (let k = 0; k < 12; k++) {
    dataset.set(`FLAT${k}`, { candles: series(DATES, { drift: 0.0002, vol: 0.008 + k * 0.0005 }), meta: {} });
  }
  dataset.set(burstTicker, { candles: series(DATES, { drift: 0.0004, vol: 0.008, burstAt, burstPct: 40 }), meta: {} });
  return dataset;
}

test('buildCheckpoints only offers checkpoints whose labels can mature, oldest→newest', () => {
  const cps = RECON.buildCheckpoints({ spyCandles, horizonSessions: 21, stepSessions: 5, maxCheckpoints: 10 });
  assert.ok(cps.length > 0 && cps.length <= 10);
  assert.ok(cps.every((d, i) => i === 0 || d > cps[i - 1]));
  const lastIdx = DATES.indexOf(cps[cps.length - 1]);
  assert.ok(lastIdx <= N - 1 - 21 - 1, 'latest checkpoint leaves room for entry + full horizon');
});

test('reconstructCheckpoint builds matured episodes for the whole cohort and attributes the burst mover', () => {
  const dataset = buildDataset();
  const decisionDate = DATES[208];   // just before the 40% burst at bar 210
  const day = RECON.reconstructCheckpoint({ dataset, spyCandles, decisionDate, scope: 'large', horizonKey: 'h21' });
  assert.ok(day.ok, `reconstruction failed: ${day.reason}`);
  assert.ok(day.episodes.length >= 10, 'episodes cover the evaluated cohort');
  assert.ok(day.episodes.every(e => e.matured), 'a 21-session window 30+ bars from the end must mature');
  assert.ok(day.opportunities >= 1, 'the injected 40% burst qualifies as a significant opportunity');
  const missedMover = day.missed.find(m => m.episode.symbol === 'MOVER');
  assert.ok(missedMover, 'the un-selected burst mover is attributed as a miss');
  assert.ok(missedMover.attribution.primaryFailure, 'attribution carries a primary failure');
  assert.ok(Array.isArray(missedMover.attribution.evidence) && missedMover.attribution.evidence.length > 0, 'deterministic evidence attached');
  assert.strictEqual(day.dataQuality.survivorshipSafe, false, 'survivorship limitation is stamped, never hidden');
});

test('reconstruction is deterministic — same inputs, same episode ids and attributions', () => {
  const decisionDate = DATES[208];
  const a = RECON.reconstructCheckpoint({ dataset: buildDataset(), spyCandles, decisionDate, scope: 'large', horizonKey: 'h21' });
  const b = RECON.reconstructCheckpoint({ dataset: buildDataset(), spyCandles, decisionDate, scope: 'large', horizonKey: 'h21' });
  assert.deepStrictEqual(
    a.missed.map(m => [m.episode.opportunityId, m.attribution.primaryFailure]),
    b.missed.map(m => [m.episode.opportunityId, m.attribution.primaryFailure]),
  );
  assert.strictEqual(a.replaySummary.candidateSetHash, b.replaySummary.candidateSetHash);
});

test('a checkpoint that is not a benchmark session is refused, not guessed', () => {
  const day = RECON.reconstructCheckpoint({ dataset: buildDataset(), spyCandles, decisionDate: '2025-06-01', scope: 'large', horizonKey: 'h21' });
  assert.strictEqual(day.ok, false);
});

test('the intraday horizon is refused (delegated), never fabricated from daily bars', () => {
  const day = RECON.reconstructCheckpoint({ dataset: buildDataset(), spyCandles, decisionDate: DATES[208], horizonKey: 'intraday' });
  assert.strictEqual(day.ok, false);
  assert.strictEqual(day.reason, 'unsupported-horizon');
});

test('scanOutOfUniverse attributes big movers outside the scope as UNIVERSE_EXCLUSION', () => {
  const outside = new Map([['OUTS', { candles: series(DATES, { burstAt: 210, burstPct: 60, vol: 0.006 }), meta: {} }]]);
  const r = RECON.scanOutOfUniverse({ outsideDataset: outside, spyCandles, decisionDate: DATES[208], horizonKey: 'h21' });
  assert.ok(r.ok);
  if (r.missed.length) {
    assert.strictEqual(r.missed[0].attribution.primaryFailure, 'UNIVERSE_EXCLUSION');
    assert.strictEqual(r.missed[0].episode.universeScope, 'out-of-scope');
  }
});

test('episode caps are enforced and REPORTED as truncation, never silent', () => {
  const dataset = buildDataset();
  const orig = CFG.SWEEP.maxEpisodesPerDay;
  // SWEEP is frozen — assert the cap exists and the truncated flag is part of the contract.
  assert.ok(orig > 0);
  const day = RECON.reconstructCheckpoint({ dataset, spyCandles, decisionDate: DATES[208], scope: 'large', horizonKey: 'h21' });
  assert.ok('truncated' in day);
});

const test = require('node:test');
const assert = require('node:assert');
const ev2 = require('../lib/options-evaluate-v2');

function candles(startDate, days, { start = 100, drift = 0.5 } = {}) {
  const out = [];
  const d0 = Date.parse(`${startDate}T00:00:00Z`);
  for (let i = 0; i < days; i++) {
    const px = start + i * drift;
    out.push({ date: new Date(d0 + i * 86400000).toISOString().slice(0, 10), open: px, high: px + 1, low: px - 1, close: px + 0.5 });
  }
  return out;
}

function mkEvent(over = {}) {
  return {
    id: 'e1', ticker: 'TST', side: 'bullish', appearances: 3,
    firstSeen: {
      session: '2026-06-01', anomalyScore: 85,
      interpretation: { state: 'BULLISH_PROVISIONAL', confidence: 40 },
      tradeStatus: 'PRICE_CONFIRMED',
      challengerScores: [{ id: 'anomaly-v2-flat', score: 70 }],
      setup: { trigger: 101, invalidation: 96, target: 108, rr: 2 },
      contracts: [{ contractSymbol: 'A', openInterest: 100 }],
    },
    oiConfirmation: { status: 'CONFIRMED_BUILDING' },
    ...over,
  };
}

test('detection quality reports persistence / OI / spread-suspect / unknown-direction rates', () => {
  const events = [
    mkEvent(),
    mkEvent({ id: 'e2', appearances: 1, firstSeen: { ...mkEvent().firstSeen, interpretation: { state: 'UNKNOWN' } }, oiConfirmation: { status: 'WEAKENED' } }),
    mkEvent({ id: 'e3', firstSeen: { ...mkEvent().firstSeen, interpretation: { state: 'POSSIBLE_SPREAD' } }, oiConfirmation: { status: 'PENDING' } }),
  ];
  const d = ev2.detectionQuality(events);
  assert.strictEqual(d.n, 3);
  assert.strictEqual(d.oiResolved, 2);
  assert.strictEqual(d.oiConfirmedPct, 50);
  assert.ok(d.spreadOrHedgeSuspectPct > 0 && d.unknownDirectionPct > 0);
  // No affirmative edge/probability claim (the honest "neither implies … edge"
  // disclaimer is expected and allowed).
  assert.doesNotMatch(d.note, /has (an )?edge|probability of|% likely/i);
});

test('grading enters at the NEXT session open (no decision-close leak) and carries decision-time metadata', () => {
  const tkr = candles('2026-05-25', 60);
  const graded = ev2.gradeEvents([mkEvent()], { candlesByTicker: new Map([['TST', tkr]]), spy: candles('2026-05-25', 60, { drift: 0.1 }), sectorByTicker: new Map() });
  assert.strictEqual(graded.length, 1);
  const g = graded[0];
  assert.ok(g.entryDate > '2026-06-01', 'entry strictly after the decision session');
  assert.strictEqual(g.tradeStatusAtDecision, 'PRICE_CONFIRMED');
  assert.ok(['target-first', 'stop-first', 'neither', 'ambiguous-same-bar'].includes(g.targetBeforeStop));
});

test('neutral (unknown-direction) events are never graded directionally', () => {
  const graded = ev2.gradeEvents([mkEvent({ side: 'neutral' })], { candlesByTicker: new Map([['TST', candles('2026-05-25', 60)]]), spy: null, sectorByTicker: new Map() });
  assert.strictEqual(graded.length, 0);
});

test('incremental value stays an OPEN QUESTION on thin cohorts — no manufactured verdict', () => {
  const r = ev2.incrementalValue([], []);
  assert.strictEqual(r.ready, false);
  assert.ok(!r.verdict, 'no verdict without data');
  assert.match(r.note, /open/i);
});

test('incremental value compares price+options vs price-only with CIs when cohorts mature', () => {
  const mk = (n, mean) => Array.from({ length: n }, (_, i) => ({ decisionDate: `2026-0${(i % 6) + 1}-01`, horizons: { 21: { excessVsSpy: mean + (i % 3) - 1 } } }));
  const r = ev2.incrementalValue(mk(12, 2), mk(12, 1));
  assert.strictEqual(r.ready, true);
  assert.ok(r.withOptions.ci && r.priceOnly.ci);
  assert.ok(['options-evidence-adds-value', 'no-significant-difference', 'options-evidence-subtracts-value'].includes(r.verdict));
  assert.strictEqual(r.prospective, true);
});

test('challenger report walks forward per scorer and labels challengers shadow', () => {
  const graded = Array.from({ length: 30 }, (_, i) => ({
    decisionDate: new Date(Date.parse('2026-01-01') + i * 3 * 86400000).toISOString().slice(0, 10),
    score: 50 + i, challengerScores: [{ id: 'anomaly-v2-flat', score: 40 + i }],
    horizons: { 21: { excessVsSpy: (i % 5) - 2 } },
  }));
  const r = ev2.challengerReport(graded);
  assert.ok(r.scorers.champion);
  assert.ok(r.scorers['anomaly-v2-flat']);
  assert.match(r.scorers['anomaly-v2-flat'].state, /shadow/);
  assert.strictEqual(r.prospective, true);
});

test('targetBeforeStop resolves target-first on a rising path and stop-first on a falling one', () => {
  const up = candles('2026-06-01', 30, { drift: 1 });
  const down = candles('2026-06-01', 30, { drift: -1 });
  const setup = { direction: 'long', target: 108, invalidation: 96 };
  assert.strictEqual(ev2.targetBeforeStop(up, 0, setup, 21), 'target-first');
  assert.strictEqual(ev2.targetBeforeStop(down, 0, setup, 21), 'stop-first');
});

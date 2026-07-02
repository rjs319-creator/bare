// Tests for the archive baseline reader (lib/baseline.js) — "today vs normal".
const test = require('node:test');
const assert = require('node:assert');
const { computeBaselines, stats } = require('../lib/baseline');

// Build N days ending today, each with the given per-ticker mentions/optVol values.
// valuesByDay = [{ TICK: {mentions, optVol} }] in chronological order.
function daysFrom(valuesByDay) {
  return valuesByDay.map((rec, i) => ({
    date: `2026-06-${String(i + 1).padStart(2, '0')}`,
    records: Object.entries(rec).map(([ticker, v]) => ({
      ticker,
      mentions: v.mentions,
      options: v.optVol != null ? { totalVol: v.optVol, atmIV: null, pcVolRatio: null } : null,
    })),
  }));
}

test('stats: mean and sd of a simple series', () => {
  const s = stats([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(s.n, 8);
  assert.equal(s.mean, 5);
  assert.equal(s.sd, 2); // population sd
});

test('flags a mentions spike as unusual (high z)', () => {
  // 10 calm days at ~100, then a spike to 500 on the last day.
  const vals = [];
  for (let i = 0; i < 10; i++) vals.push({ AAA: { mentions: 100 + (i % 2), optVol: 1000 } });
  vals.push({ AAA: { mentions: 500, optVol: 1000 } }); // spike day = asOf
  const out = computeBaselines(daysFrom(vals), { minObs: 8, z: 2 });
  const hit = out.unusual.find(u => u.ticker === 'AAA' && u.metric === 'mentions');
  assert.ok(hit, 'mentions spike should be flagged');
  assert.equal(hit.direction, 'high');
  assert.ok(hit.z >= 2, `z should clear threshold, got ${hit.z}`);
  assert.equal(hit.pctile, 100, 'spike is the highest in its own history');
  // optVol was flat → not flagged
  assert.ok(!out.unusual.some(u => u.ticker === 'AAA' && u.metric === 'optVol'));
});

test('does NOT flag a name with too little prior history', () => {
  const vals = [];
  for (let i = 0; i < 4; i++) vals.push({ BBB: { mentions: 100, optVol: 1000 } });
  vals.push({ BBB: { mentions: 999, optVol: 1000 } }); // big spike but only 4 prior obs
  const out = computeBaselines(daysFrom(vals), { minObs: 8, z: 2 });
  assert.equal(out.unusual.length, 0, 'insufficient history → no signal');
  assert.equal(out.tickers.BBB.mentions.scored, false);
});

test('does NOT flag a name absent on the latest day', () => {
  const vals = [];
  for (let i = 0; i < 10; i++) vals.push({ CCC: { mentions: 100, optVol: 1000 }, DDD: { mentions: 50 + (i % 2), optVol: 500 } });
  // Final (asOf) day: DDD spikes, CCC missing entirely.
  vals.push({ DDD: { mentions: 999, optVol: 500 } });
  const out = computeBaselines(daysFrom(vals), { minObs: 8, z: 2 });
  assert.ok(out.unusual.some(u => u.ticker === 'DDD'), 'DDD present-and-spiking is flagged');
  assert.ok(!out.unusual.some(u => u.ticker === 'CCC'), 'CCC absent on asOf day is not flagged');
});

test('empty / malformed input is handled', () => {
  assert.equal(computeBaselines(null).unusual.length, 0);
  assert.equal(computeBaselines([]).days, 0);
  assert.equal(computeBaselines([{ foo: 1 }]).asOf, null); // no records array
});

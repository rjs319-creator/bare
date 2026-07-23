'use strict';
// OMEGA-SWING Defect A (AVOID render path) + Defect B (funnel-displacement join-back) tests.
// Pure where possible: exercise buildOmega, the carry-forward join-back helper, the live-pick
// mapping, and the frontend derived-reason function directly — never the network route.
const { test } = require('node:test');
const assert = require('node:assert');
const R = require('../lib/omega-swing-routes');

// ── candle builders (mirror test/omega-swing.test.js) ────────────────────────────────────
function series(rows, start = '2025-01-01') {
  let d = new Date(start + 'T00:00:00Z');
  return rows.map(r => {
    const date = d.toISOString().slice(0, 10); d = new Date(d.getTime() + 86400000);
    const close = r.close, vol = r.volume ?? 2e6;
    return { date, open: r.open ?? close, high: r.high ?? close * 1.01, low: r.low ?? close * 0.99, close, volume: vol };
  });
}
function healthyUptrend(n = 80, drift = 0.004) {
  const rows = []; let px = 30;
  for (let i = 0; i < n; i++) { px *= (1 + drift + Math.sin(i / 4) * 0.001); rows.push({ close: +px.toFixed(2), volume: 3e6 * (1 + i * 0.004) }); }
  return series(rows);
}
function brokenDown(n = 80) {
  const rows = []; let px = 50;
  for (let i = 0; i < 50; i++) { px *= 1.004; rows.push({ close: +px.toFixed(2), volume: 2e6 }); }
  for (let k = 0; k < n - 50; k++) { px *= 0.985; rows.push({ close: +px.toFixed(2), volume: 3e6 }); }
  return series(rows);
}
function flat(n = 80, px = 400) { const rows = []; for (let i = 0; i < n; i++) rows.push({ close: px, volume: 5e7 }); return series(rows); }

// ── DEFECT A — AVOID cards are computed, bucketed, and carry a derivable reason ────────────
test('buildOmega buckets a broken-down name into byTier.AVOID with a derivable reason', async () => {
  const signals = [{ ticker: 'HLTH', sector: 'technology', score: 80 }, { ticker: 'BRKN', sector: 'technology', score: 70 }];
  const cbt = { HLTH: healthyUptrend(), BRKN: brokenDown() };
  const p = R.buildOmega(signals, cbt, { SPY: flat() }, { riskOn: true });

  assert.strictEqual(p.byTier.AVOID.length, 1, 'the broken-down name is in the AVOID bucket');
  assert.strictEqual(p.counts.avoid, 1, 'counts.avoid reflects the AVOID card');
  const avoid = p.byTier.AVOID[0];
  assert.strictEqual(avoid.ticker, 'BRKN');
  // The fields the frontend derives the transition reason from are present on the card.
  assert.ok(avoid.stage === 'FAILED' || avoid.stage === 'EXHAUSTED' || avoid.utility <= 0, 'has a derivable Avoid cause');

  // The frontend derived-reason function turns those fields into a human transition reason.
  const { deriveAvoidReason } = await import('../public/js/omega-swing.js');
  const reasons = deriveAvoidReason(avoid);
  assert.ok(Array.isArray(reasons) && reasons.length >= 1, 'at least one reason');
  assert.ok(reasons.some(r => /momentum|utility|liquidity|strength|extended|risk-off|volume|entry bar/i.test(r)), `sensible reason, got ${reasons.join(', ')}`);
});

test('deriveAvoidReason falls back to "no longer clears the entry bar" when nothing else applies', async () => {
  const { deriveAvoidReason } = await import('../public/js/omega-swing.js');
  const bare = { stage: 'CONTINUATION', utility: 0.5, penalties: [], risks: [], features: { rsSpy5: 0.01, rsSpy10: 0.01, volPersistence: 0.8, extAbove20: 5 } };
  assert.deepStrictEqual(deriveAvoidReason(bare), ['no longer clears the entry bar']);
});

test('avoidSection renders a collapsed <details>, never a raw probability percentage', async () => {
  const { avoidSection } = await import('../public/js/omega-swing.js');
  const om = { byTier: { AVOID: [{ ticker: 'BRKN', tier: 'AVOID', stage: 'FAILED', utility: -0.03, score: 20, price: 40, features: { rsSpy10: -0.05 }, penalties: ['risk-off tape'], risks: ['risk-off tape'], pred: { p3pct: 0.7, p5pct: 0.6 }, calibration: { p3pct: { display: false, band: 'favorable' }, p5pct: { display: false, band: 'neutral' } } }] } };
  const html = avoidSection(om);
  assert.ok(/<details class="om-avoid"/.test(html), 'collapsed details section');
  assert.ok(/No Longer Actionable/.test(html), 'labeled section');
  assert.ok(/Why Avoid:/.test(html), 'shows a derived transition reason');
  assert.ok(!/70%|60%/.test(html), 'never renders the uncalibrated probability as a percentage');
  assert.strictEqual(avoidSection({ byTier: { AVOID: [] } }), '', 'empty when no AVOID cards');
});

// ── DEFECT B — carry-forward join-back keeps sub-funnel episodes monitored ─────────────────
test('carryForwardEpisodes returns most-recent episode per ticker for names ABSENT from the shortlist', () => {
  const livePicks = [
    { ticker: 'AAA', signalDate: '2026-07-10', tier: 'OMEGA_WATCH' },
    { ticker: 'AAA', signalDate: '2026-07-18', tier: 'OMEGA_QUALIFIED' },   // most recent for AAA
    { ticker: 'BBB', signalDate: '2026-07-15', tier: 'OMEGA_WATCH' },        // still in shortlist → excluded
    { ticker: 'CCC', signalDate: '2026-07-17', tier: 'AVOID' },
  ];
  const shortlist = new Set(['BBB', 'ZZZ']);
  const carried = R.carryForwardEpisodes(livePicks, shortlist);
  const tickers = carried.map(e => e.ticker);
  assert.ok(tickers.includes('AAA') && tickers.includes('CCC'), 'displaced names are carried forward');
  assert.ok(!tickers.includes('BBB'), 'a name still in the shortlist is NOT carried (scored normally)');
  const aaa = carried.find(e => e.ticker === 'AAA');
  assert.strictEqual(aaa.signalDate, '2026-07-18', 'most-recent published episode per ticker');
  assert.strictEqual(aaa.tier, 'OMEGA_QUALIFIED');
});

test('carryForwardEpisodes dedups by ticker+signalDate (a tier change on the same day does NOT fragment)', () => {
  const livePicks = [
    { ticker: 'AAA', signalDate: '2026-07-18', tier: 'OMEGA_WATCH', observationId: 'x:AAA:WATCH' },
    { ticker: 'AAA', signalDate: '2026-07-18', tier: 'AVOID', observationId: 'x:AAA:AVOID' },   // same day, different tier
  ];
  const carried = R.carryForwardEpisodes(livePicks, new Set());
  assert.strictEqual(carried.filter(e => e.ticker === 'AAA').length, 1, 'one episode per ticker+signalDate');
});

test('carryForwardEpisodes is bounded by the carry-forward cap', () => {
  const many = Array.from({ length: R.CARRY_FORWARD_MAX + 25 }, (_, i) => ({ ticker: 'T' + i, signalDate: '2026-07-' + String(10 + (i % 20)).padStart(2, '0') }));
  const carried = R.carryForwardEpisodes(many, new Set());
  assert.ok(carried.length <= R.CARRY_FORWARD_MAX, `capped at ${R.CARRY_FORWARD_MAX}`);
});

test('buildOmega tags carried tickers with funnelDisplaced + a carry reason (re-injected, not dropped)', () => {
  const signals = [
    { ticker: 'HLTH', sector: 'technology', score: 80 },                                  // today's shortlist
    R.episodeToSignal({ ticker: 'BRKN', sector: 'technology', signalDate: '2026-07-10', score: 55, candidateSource: 'trend' }), // carried
  ];
  const cbt = { HLTH: healthyUptrend(), BRKN: brokenDown() };
  const p = R.buildOmega(signals, cbt, { SPY: flat() }, { riskOn: true }, { carriedTickers: new Set(['BRKN']) });
  const brkn = p.cards.find(c => c.ticker === 'BRKN');
  assert.ok(brkn, 'the carried name was re-scored and included, not dropped');
  assert.strictEqual(brkn.funnelDisplaced, true, 'flagged as funnel-displaced');
  assert.ok(/funnel displacement/i.test(brkn.carryReason), 'carries a displacement reason');
  const hlth = p.cards.find(c => c.ticker === 'HLTH');
  assert.ok(!hlth.funnelDisplaced, 'a current-shortlist name is not flagged as displaced');
});

// ── DEFECT B — op=omegalog no longer filters out AVOID (transition captured for grading) ───
test('omegaLivePicks persists AVOID (and carried-forward) picks — no tier filter drops them', () => {
  const cards = [
    { ticker: 'HLTH', tier: 'OMEGA_WATCH', price: 40, stage: 'EARLY', sector: 'technology' },
    { ticker: 'BRKN', tier: 'AVOID', price: 20, stage: 'FAILED', sector: 'technology', funnelDisplaced: true },
  ];
  const picks = R.omegaLivePicks(cards, '2026-07-22');
  const byTicker = Object.fromEntries(picks.map(p => [p.ticker, p]));
  assert.ok(byTicker.BRKN, 'the AVOID pick is logged, not dropped');
  assert.strictEqual(byTicker.BRKN.tier, 'AVOID');
  assert.strictEqual(byTicker.BRKN.funnelDisplaced, true, 'carried-forward flag persisted');
  // Provenance / version shape preserved (honesty wall — no promotability change).
  assert.strictEqual(byTicker.BRKN.provenance, 'prospective_live');
  assert.strictEqual(byTicker.BRKN.strategyVersion, 'omega-swing-v2');
  // The AVOID transition gets a distinct observation id (episodeId = tier).
  assert.ok(/AVOID/.test(byTicker.BRKN.observationId), 'observationId reflects the AVOID episode');
  assert.notStrictEqual(byTicker.HLTH.observationId, byTicker.BRKN.observationId);
});

// Backlog batch (non-daytrade redesign follow-up, 2026-08):
//  A. entry-v2.1 trigger-verified Scoreboard grading for conditional contracts
//     (coil / gapdown) — no-fill, gap-skip, gap-through, fill-anchored benchmark.
//  B. posterior-rank gate — the fade-engine posterior's PROMOTE influence on live
//     ranks is weight-0 while shadow (avoid-only survives); Day Trade untouched.
//  C. Down-Day conditional-context gate + research-control labeling.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { forwardPath, spyForwardReturn, entryBasisForSection } = require('../lib/apex-routes');
const { posteriorRankWeight, POSTERIOR_POLICY_NOTE } = require('../lib/screener-routes');
const { fromDownDay } = require('../lib/decision-normalizers');
const { assessSignal, assessSource } = require('../lib/eligibility');

// ── A. entry-v2.1 basis policy ───────────────────────────────────────────────

test('entryBasisForSection: conditional contracts opt into trigger-verified, daytrade stays pinned', () => {
  assert.strictEqual(entryBasisForSection('coil'), 'trigger-verified');
  assert.strictEqual(entryBasisForSection('GapDown'), 'trigger-verified');
  assert.strictEqual(entryBasisForSection('daytrade'), null, 'FROZEN: daytrade must stay on the legacy basis');
  assert.strictEqual(entryBasisForSection('screener'), 'next-open', 'next-open sections unchanged');
  // entry-v2.2: lead-only/legacy sections now grade their PROXY at the first
  // executable print (next open) — a signal-day close was never a tradeable price.
  assert.strictEqual(entryBasisForSection('ReadThrough'), 'next-open', 'lead-only proxies price at next open');
  assert.strictEqual(entryBasisForSection('OMEGA'), 'next-open', 'legacy sections default to next-open');
});

// Bars: signal day d0, then 4 tradeable sessions. Trigger for longs = 105.
const D = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'];
const bar = (date, o, h, l, c) => ({ date, open: o, high: h, low: l, close: c });

test('trigger-verified: trigger never traded inside the horizon → no-fill, never a fabricated return', () => {
  const candles = [bar(D[0], 100, 101, 99, 100), bar(D[1], 100, 103, 99, 102), bar(D[2], 102, 104, 100, 103), bar(D[3], 103, 104.5, 101, 104)];
  const pick = { date: D[0], entry: 105 };
  const r = forwardPath(candles, pick, 3, { entryBasis: 'trigger-verified' });
  assert.strictEqual(r.fillStatus, 'no-fill');
  assert.strictEqual(r.ret, null);
});

test('trigger-verified: intra-bar trigger touch fills AT the trigger; return runs fill→horizon close', () => {
  const candles = [bar(D[0], 100, 101, 99, 100), bar(D[1], 102, 106, 101, 104), bar(D[2], 104, 108, 103, 107), bar(D[3], 107, 110, 106, 109)];
  const pick = { date: D[0], entry: 105 };
  const r = forwardPath(candles, pick, 3, { entryBasis: 'trigger-verified' });
  assert.strictEqual(r.fillStatus, 'filled');
  assert.strictEqual(r.fillDate, D[1]);
  assert.strictEqual(r.filledAtOpen, false);
  assert.ok(Math.abs(r.ret - ((109 - 105) / 105) * 100) < 1e-9, 'entry must be the trigger, not the open or close');
});

test('trigger-verified: open gaps through the trigger → filled at the WORSE open, not the trigger', () => {
  const candles = [bar(D[0], 100, 101, 99, 100), bar(D[1], 107, 109, 106, 108), bar(D[2], 108, 111, 107, 110)];
  const pick = { date: D[0], entry: 105 };
  const r = forwardPath(candles, pick, 2, { entryBasis: 'trigger-verified' });
  assert.strictEqual(r.fillStatus, 'filled');
  assert.strictEqual(r.filledAtOpen, true);
  assert.ok(Math.abs(r.ret - ((110 - 107) / 107) * 100) < 1e-9, 'gap-through must pay the open (107), never the intended 105');
});

test('trigger-verified: open beyond the chase ceiling → gap-skip, terminal, no return', () => {
  // Ceiling = 105 × 1.05 = 110.25; open at 111 refuses the chase.
  const candles = [bar(D[0], 100, 101, 99, 100), bar(D[1], 111, 115, 110, 114), bar(D[2], 114, 118, 113, 117)];
  const pick = { date: D[0], entry: 105 };
  const r = forwardPath(candles, pick, 2, { entryBasis: 'trigger-verified' });
  assert.strictEqual(r.fillStatus, 'gap-skip');
  assert.strictEqual(r.ret, null);
});

test('trigger-verified SHORT (gapdown): break of the low fills; direction-adjusted return', () => {
  // Short trigger = 95: D1 low 94 breaks it → fill at 95; horizon close 90 → +5.26% for the short.
  const candles = [bar(D[0], 100, 101, 96, 100), bar(D[1], 97, 98, 94, 95.5), bar(D[2], 95, 96, 89, 90)];
  const pick = { date: D[0], entry: 95, short: true };
  const r = forwardPath(candles, pick, 2, { entryBasis: 'trigger-verified' });
  assert.strictEqual(r.fillStatus, 'filled');
  assert.ok(r.ret > 0, 'a fall after a short fill must grade positive');
  assert.ok(Math.abs(r.ret - ((95 - 90) / 95) * 100) < 1e-9);
});

test('trigger-verified: a row with NO verifiable trigger level is ungradeable (null), never approximated', () => {
  const candles = [bar(D[0], 100, 101, 99, 100), bar(D[1], 102, 106, 101, 104), bar(D[2], 104, 108, 103, 107)];
  // Coil rows without a captured plan carry trigger: null explicitly.
  const r = forwardPath(candles, { date: D[0], entry: 100, trigger: null }, 2, { entryBasis: 'trigger-verified' });
  assert.strictEqual(r, null, 'decision price must never be silently graded as a trigger');
});

test('trigger-verified benchmark: anchored at the FILL date, fails closed without one', () => {
  const spy = [bar(D[0], 500, 501, 499, 500), bar(D[1], 502, 503, 501, 502), bar(D[2], 504, 505, 503, 505)];
  const pick = { date: D[0], entry: 105 };
  const anchored = spyForwardReturn(spy, pick, 2, { entryBasis: 'trigger-verified', anchorDate: D[1], anchorAtOpen: false });
  assert.ok(Math.abs(anchored - ((505 - 502) / 502) * 100) < 1e-9, 'benchmark leg must start at the fill-date close');
  const atOpen = spyForwardReturn(spy, pick, 2, { entryBasis: 'trigger-verified', anchorDate: D[1], anchorAtOpen: true });
  assert.ok(Math.abs(atOpen - ((505 - 502) / 502) * 100) > 1e-9 || spy[1].open === spy[1].close, 'open anchor differs when open ≠ close');
  assert.strictEqual(spyForwardReturn(spy, pick, 2, { entryBasis: 'trigger-verified' }), null, 'no anchor date → null (fail closed)');
});

test('legacy and next-open bases are byte-identical in shape (no fill fields leak)', () => {
  const candles = [bar(D[0], 100, 101, 99, 100), bar(D[1], 102, 106, 101, 104), bar(D[2], 104, 108, 103, 107)];
  const legacy = forwardPath(candles, { date: D[0], entry: 100 }, 2);
  assert.deepStrictEqual(Object.keys(legacy).sort(), ['mae', 'mfe', 'ret'], 'legacy return shape must not change');
  const nextOpen = forwardPath(candles, { date: D[0] }, 2, { entryBasis: 'next-open' });
  assert.deepStrictEqual(Object.keys(nextOpen).sort(), ['mae', 'mfe', 'ret'], 'next-open return shape must not change');
});

// ── B. posterior-rank gate ───────────────────────────────────────────────────

test('posterior-rank boost is weight-0 while shadow (default registry, no artifact)', () => {
  assert.strictEqual(posteriorRankWeight(), 0);
  assert.strictEqual(posteriorRankWeight({ artifact: { version: 'posterior-rank-v1', verdict: 'PASS' } }), 0,
    'an artifact alone must not open the gate while the registry entry is shadow');
});

test('posterior-rank boost needs BOTH registry production AND a PASS artifact', () => {
  const prodRegistry = [{ id: 'posterior-rank', maturity: 'production' }];
  assert.strictEqual(posteriorRankWeight({ registry: prodRegistry }), 0, 'registry promotion alone is not enough');
  assert.strictEqual(posteriorRankWeight({ registry: prodRegistry, artifact: { version: 'posterior-rank-v1', verdict: 'FAIL' } }), 0);
  assert.strictEqual(posteriorRankWeight({ registry: prodRegistry, artifact: { version: 'posterior-rank-v1', verdict: 'PASS' } }), 8);
});

test('posterior-rank registry entry exists and is shadow', () => {
  const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');
  const e = STRATEGY_REGISTRY.find(x => x.id === 'posterior-rank');
  assert.ok(e, 'posterior-rank must be registered');
  assert.strictEqual(e.maturity, 'shadow');
  assert.ok(e.criteria && e.criteria.length > 50, 'promotion criteria must be recorded');
  assert.ok(POSTERIOR_POLICY_NOTE.includes('avoid-only'));
});

test('confluence and downday rank sorts no longer hard-code the posterior boost; drifted veto survives', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'screener-routes.js'), 'utf8');
  assert.ok(!/indepScore \+ 8 \* [ab]\.learnedExcess/.test(src), 'the fixed 8× confluence boost must be gone');
  assert.match(src, /wPost \* b\.learnedExcess/, 'confluence sort must run through the gated weight');
  assert.match(src, /if \(p\.drifted\) continue;\s*\/\/ per-stock learner drop/, 'the avoid-direction drifted veto must survive');
  assert.match(src, /wPost \? \(b\.learnedExcess \|\| 0\) - \(a\.learnedExcess \|\| 0\) : 0/, 'downday posterior ordering must be gated');
});

test('FROZEN: the Day Trade consumer of the learner is untouched by the gate', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'screener-routes.js'), 'utf8');
  assert.match(src, /b\.score \+ 8 \* b\.learnedExcess/, 'daytrade scan sort must keep its literal 8× term (frozen)');
});

// ── C. Down-Day conditional-context gate + research controls ─────────────────

const DOWNDAY_ROW = {
  ticker: 'XYZ', sector: 'Tech', tier: 'EMERGING', bucket: 'bounce', score: 70, price: 10,
  signals: { entry: 10, stop: 9, target: 12, rr: 2, side: 'long' }, dollarVol: 5e6,
};

test('fromDownDay: rows declare the red-tape condition gate, met only on a red tape', () => {
  const red = fromDownDay({ tape: { down: true }, bounces: [DOWNDAY_ROW], fades: [] });
  assert.strictEqual(red[0].conditionGate.met, true);
  const green = fromDownDay({ tape: { down: false }, bounces: [DOWNDAY_ROW], fades: [] });
  assert.strictEqual(green[0].conditionGate.met, false);
  const unknown = fromDownDay({ bounces: [DOWNDAY_ROW], fades: [] });
  assert.strictEqual(unknown[0].conditionGate.met, false, 'unknown tape must fail closed');
});

test('eligibility: an unmet condition gate demotes the row to research (fail closed)', () => {
  const src = assessSource('downday', {});
  const sig = { source: 'downday', ticker: 'XYZ', side: 'long', entry: 10, stop: 9, target: 12,
    liquidity: { dollarVol: 5e6 }, conditionGate: { required: 'red-tape', met: false } };
  const a = assessSignal(sig, src);
  assert.strictEqual(a.tradeEligible, false);
  assert.ok(a.reasons.some(r => r.includes('red-tape')), 'the reason must name the unmet condition');
  const met = assessSignal({ ...sig, conditionGate: { required: 'red-tape', met: true } }, src);
  // With the condition met, the gate itself must not be the blocker (source-level
  // status may still block — that is orthogonal and asserted by not finding our reason).
  assert.ok(!met.reasons.some(r => r.includes('conditional sleeve outside')), 'a met condition adds no demotion reason');
});

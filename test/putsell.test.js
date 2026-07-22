// Tests for the put-selling setup logic (lib/putsell.js).
const test = require('node:test');
const assert = require('node:assert');
const { analyzePutSetup, finalizePutSell, gradePutSell, niceStrike } = require('../lib/putsell');

test('gradePutSell: strong setup + high IV grades A/A+; weak setup grades low', () => {
  const hi = gradePutSell({ score: 0.85, atmIV: 0.55 });
  const lo = gradePutSell({ score: 0.5, atmIV: 0.2 });
  assert.ok(['A', 'A+'].includes(hi.grade), `got ${hi.grade} (${hi.rankScore})`);
  assert.ok(hi.rankScore > lo.rankScore);
  assert.ok(['C', 'D'].includes(lo.grade));
});

test('gradePutSell: missing IV grades neutral (below confirmed-good-premium)', () => {
  const noIv = gradePutSell({ score: 0.85 });            // 0.85*0.7 + 0.5*0.3
  const goodIv = gradePutSell({ score: 0.85, atmIV: 0.55 });
  const lowIv = gradePutSell({ score: 0.85, atmIV: 0.15 });
  assert.ok(goodIv.rankScore > noIv.rankScore, 'confirmed good premium outranks unknown');
  assert.ok(noIv.rankScore > lowIv.rankScore, 'unknown outranks confirmed low premium');
});

test('gradePutSell: implausible IV (2%) is ignored — same as missing (neutral)', () => {
  const broken = gradePutSell({ score: 0.75, atmIV: 0.02 });   // 2% IV = broken feed
  const nodata = gradePutSell({ score: 0.75 });
  assert.equal(broken.rankScore, nodata.rankScore);            // sanity floor → treated as missing
});

test('finalizePutSell: drops a junk IV reading and flags it unreliable', () => {
  const out = finalizePutSell({ price: 14, cautions: [] }, { atmIV: 0.02 });
  assert.equal(out.atmIV, null);
  assert.equal(out.ivUnreliable, true);
  assert.equal(out.ivLevel, undefined);
  const ok = finalizePutSell({ price: 14, cautions: [] }, { atmIV: 0.45 });
  assert.equal(ok.atmIV, 0.45);
  assert.equal(ok.ivLevel, 'moderate');
});

// Build ~240 daily candles: a long uptrend, then an optional recent pullback.
function upThenPullback({ start = 50, peak = 100, pullbackPct = 8, n = 240, wobble = 0 }) {
  const candles = [];
  const climbN = n - 12;
  for (let i = 0; i < climbN; i++) {
    const base = start + ((peak - start) * i) / (climbN - 1);
    const c = base + (wobble ? Math.sin(i / 5) * wobble : 0);
    candles.push({ high: c * 1.01, low: c * 0.99, close: c, open: c, volume: 1e6 });
  }
  // recent pullback from the peak
  for (let i = 0; i < 12; i++) {
    const c = peak * (1 - (pullbackPct / 100) * ((i + 1) / 12));
    candles.push({ high: c * 1.01, low: c * 0.985, close: c, open: c, volume: 1e6 });
  }
  return candles;
}

test('analyzePutSetup: uptrend + healthy pullback → a qualifying setup', () => {
  const s = analyzePutSetup(upThenPullback({ pullbackPct: 8 }));
  assert.ok(s, 'should be a candidate');
  assert.ok(['PRIME', 'SOLID', 'WATCH'].includes(s.tier));
  assert.ok(s.strike < s.price, 'strike is below spot (OTM put)');
  assert.ok(s.bufferPct >= 2, 'has an OTM cushion');
  // The setup describes the price-action case; the tradeable strike is a REAL listed
  // contract chosen by the route, so reasons must NOT display a synthetic "Sell the $X put".
  assert.doesNotMatch(s.reasons.join(' '), /Sell the \$/);
  assert.match(s.reasons.join(' '), /support/i);
});

test('analyzePutSetup: downtrend (below 200-day) → not a candidate', () => {
  const down = [];
  for (let i = 0; i < 240; i++) { const c = 100 - i * 0.2; down.push({ high: c * 1.01, low: c * 0.99, close: c, open: c, volume: 1e6 }); }
  assert.equal(analyzePutSetup(down), null);
});

test('analyzePutSetup: thin history → null', () => {
  assert.equal(analyzePutSetup([{ high: 1, low: 1, close: 1 }]), null);
});

test('analyzePutSetup: strike sits below a named support with an ATR cushion', () => {
  const s = analyzePutSetup(upThenPullback({ pullbackPct: 6 }));
  assert.ok(s.atrCushion >= 1, `cushion ${s.atrCushion} ATR should be >= 1`);
  assert.ok(['50-day', '20-day low', '200-day', 'ATR band'].includes(s.supportBasis));
});

test('niceStrike rounds down to a sensible step per price range', () => {
  assert.equal(niceStrike(18.7, 18.7), 18.5);   // <25 → 0.5
  assert.equal(niceStrike(97.3, 97.3), 97);      // <100 → 1
  assert.equal(niceStrike(412, 412), 410);       // >=250 → 5
});

test('finalizePutSell: high IV + earnings soon annotate the setup', () => {
  const base = { price: 100, tier: 'SOLID', cautions: [] };
  const out = finalizePutSell(base, { atmIV: 0.55, earningsInDays: 12, contracts: 400 });
  assert.equal(out.ivLevel, 'high');
  assert.equal(out.earningsSoon, true);
  assert.match(out.cautions.join(' '), /Earnings in 12d/);
});

test('finalizePutSell: no data leaves setup clean', () => {
  const out = finalizePutSell({ price: 50, cautions: [] }, {});
  assert.equal(out.atmIV, null);
  assert.equal(out.earningsSoon, undefined);
});

'use strict';
// Wiring of the CBOE adapter + model greeks into the options-v2 pipeline:
//   observe-v2 rows carry vendor greeks or model-filled ones (labelled); greeksCapability
//   reports available+derived with the honesty label; selectOptionContract uses the true
//   delta band when covered and logs the moneyness-proxy shadow; provider-v2 capabilities
//   disclose the chain provider; the registry rows validate; warm-chains has the root.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { observeTicker } = require('../lib/options-observe-v2');
const oex = require('../lib/options-execution-v2');
const gate = require('../lib/options-trade-gate-v2');
const cfg = require('../lib/options-config-v2');
const provider = require('../lib/options-provider-v2');
const REG = require('../lib/research/hypothesis-registry');
const WC = require('../lib/warm-chains');

const NOW = Date.UTC(2026, 9, 1, 15);
const EXP = Math.floor(Date.UTC(2026, 10, 6) / 1000);   // 36 days
const raw = (o = {}) => ({ contractSymbol: 'T261106C00100000', strike: 100, expiration: EXP, bid: 2, ask: 2.1, lastPrice: 2.05, volume: 500, openInterest: 3000, impliedVolatility: 0.3, ...o });

test('observe-v2: vendor greeks pass through labelled; greek-less rows get model greeks from the quoted IV; no IV → none', () => {
  const result = {
    provider: 'cboe', source: 'cboe-delayed', greeksSource: 'vendor',
    quote: { regularMarketPrice: 100 },
    options: [{ expirationDate: EXP,
      calls: [raw({ delta: 0.55, gamma: 0.03, vega: 0.2, theta: -0.05, rho: 0.1, greeksSource: 'vendor' }), raw({ contractSymbol: 'T261106C00105000', strike: 105 }), raw({ contractSymbol: 'T261106C00110000', strike: 110, impliedVolatility: 0 })],
      puts: [] }],
  };
  const obs = observeTicker('TST', result, { nowMs: NOW, session: '2026-10-01' });
  assert.equal(obs.provider, 'cboe'); assert.equal(obs.greeksSource, 'vendor');
  const by = Object.fromEntries(obs.contracts.map((c) => [c.strike, c]));
  assert.equal(by[100].delta, 0.55); assert.equal(by[100].greeksSource, 'vendor');
  assert.equal(by[105].greeksSource, 'model-bsm-from-quoted-iv');
  assert.ok(by[105].delta > 0 && by[105].delta < 0.55 && by[105].gamma > 0, 'OTM call model delta below the ATM vendor one');
  assert.equal(by[110].greeksSource, null); assert.equal(by[110].delta, null);
});

test('greeksCapability: derived rows → available:true, derived:true with the model label; vendor rows → not derived', () => {
  const model = (o) => ({ side: 'call', strike: 100, delta: 0.4, gamma: 0.02, vega: 0.1, greeksSource: 'model-bsm-from-quoted-iv', ...o });
  const g = oex.greeksCapability({ capabilities: { hasFullChainOI: true }, chainRows: [model(), model({ strike: 105 })] });
  assert.equal(g.available, true); assert.equal(g.derived, true); assert.equal(g.greeksSource, 'model-bsm-from-quoted-iv');
  assert.match(g.disclosure, /MODEL-DERIVED/); assert.match(g.disclosure, /NOT supplied by the provider/);
  assert.equal(g.rowsModel, 2); assert.equal(g.rowsVendor, 0);
  assert.equal(g.dealerPositioning.available, true);
  const v = oex.greeksCapability({ capabilities: {}, chainRows: [model({ greeksSource: 'vendor' }), model({ greeksSource: 'vendor' })] });
  assert.equal(v.derived, false); assert.equal(v.greeksSource, 'vendor'); assert.match(v.disclosure, /provider-supplied/);
  const mixed = oex.greeksCapability({ capabilities: {}, chainRows: [model(), model({ greeksSource: 'vendor' })] });
  assert.equal(mixed.greeksSource, 'mixed'); assert.match(mixed.disclosure, /MIXED/);
});

const SETUP = { valid: true, direction: 'long' };
const liquid = (o = {}) => ({ side: 'call', dte: 36, openInterest: 5000, volume: 300, bid: 2, ask: 2.1, underlying: 100, expiry: '2026-11-06', ...o });

test('selectOptionContract: with delta coverage the true 0.30–0.50 band picks; the proxy pick is logged in shadow', () => {
  const rows = [
    liquid({ contractSymbol: 'ATM', strike: 100, delta: 0.55, greeksSource: 'vendor', openInterest: 9000 }),   // in proxy band, out of delta band
    liquid({ contractSymbol: 'D40', strike: 107, delta: 0.40, greeksSource: 'vendor', openInterest: 6000 }),   // in delta band, OUT of proxy band (+7%)
    liquid({ contractSymbol: 'D20', strike: 115, delta: 0.20, greeksSource: 'vendor' }),
  ];
  const r = gate.selectOptionContract(rows, SETUP);
  assert.equal(r.selected.contractSymbol, 'D40');
  assert.equal(r.selected.deltaBasis, 'measured-delta'); assert.equal(r.selected.delta, 0.4); assert.equal(r.selected.deltaSource, 'vendor');
  assert.equal(r.selected.deltaProxyNote, undefined);
  assert.deepEqual({ ...r.shadow, deltaCoverage: undefined }, { hypothesis: 'delta-band-vs-moneyness-proxy', weight: 0, measuredSelection: 'D40', proxySelection: 'ATM', agree: false, deltaCoverage: undefined });
  assert.equal(r.shadow.deltaCoverage, 1);
  assert.match(r.reason, /0\.3–0\.5 \|delta\|/);
});

test('selectOptionContract: below the coverage floor the moneyness proxy decides and is labelled; shadow still records both', () => {
  const rows = [liquid({ contractSymbol: 'ATM', strike: 100 }), liquid({ contractSymbol: 'OTM', strike: 108, delta: 0.4 }), liquid({ contractSymbol: 'FAR', strike: 130 })];
  const r = gate.selectOptionContract(rows, SETUP);
  assert.equal(r.selected.contractSymbol, 'ATM');
  assert.equal(r.selected.deltaBasis, 'moneyness-proxy'); assert.match(r.selected.deltaProxyNote, /proxy/i);
  assert.equal(r.shadow.measuredSelection, null, 'no measured pick when coverage is insufficient');
  assert.equal(r.shadow.proxySelection, 'ATM');
  assert.ok(r.shadow.deltaCoverage < cfg.CONTRACT_SELECT.deltaBand.minCoverage);
});

test('selectOptionContract: refuses when nothing passes the delta band, naming the band', () => {
  const r = gate.selectOptionContract([liquid({ contractSymbol: 'DEEP', strike: 85, delta: 0.9, greeksSource: 'vendor' })], SETUP);
  assert.equal(r.selected, null); assert.match(r.reason, /\|Δ\| 0\.3–0\.5/);
  assert.equal(r.shadow.proxySelection, null, 'strike 85 is below the −10% proxy floor too');
});

test('provider-v2 capabilities: disclose the chain provider, vendor greeks and full-chain OI; junk env is reported', () => {
  const c = provider.capabilities({});
  assert.equal(c.chainProvider, 'cboe'); assert.deepEqual(c.chainProviderOrder, ['cboe', 'yahoo']);
  assert.equal(c.hasVendorGreeks, true); assert.equal(c.hasFullChainOI, true);
  const y = provider.capabilities({ OPTIONS_PROVIDER: 'yahoo' });
  assert.equal(y.hasVendorGreeks, false); assert.equal(y.hasFullChainOI, false);
  assert.ok(provider.capabilities({ OPTIONS_PROVIDER: 'nope' }).misconfigured.some((m) => /OPTIONS_PROVIDER/.test(m)));
});

test('registry: the two shadow rows are valid, weight-0 by text, and carry a placebo + minimum N', () => {
  for (const id of ['delta-band-vs-moneyness-proxy', 'gex-gamma-flip-intraday-regime']) {
    const h = REG.find(id);
    assert.ok(h, id);
    assert.deepEqual(REG.validateHypothesis(h), { valid: true, errors: [] });
    assert.equal(h.familyId, 'volatility-structure'); assert.equal(h.mode, 'exploratory'); assert.equal(h.status, 'open');
    assert.match(h.baseline, /placebo|control/i); assert.match(h.stoppingRule, /≥\d+/);
  }
  assert.match(REG.find('gex-gamma-flip-intraday-regime').baseline, /SHUFFLED-FLIP/);
  assert.ok(REG.familyTrials('volatility-structure') >= 6);
});

test('warm-chains: optionsgex is its own ROOT chain with the single tick step', () => {
  assert.deepEqual(WC.CHAINS.optionsgex, ['op=optionsgextick']);
  assert.ok(WC.ROOT_CHAINS.includes('optionsgex'));
});

test('config: CONTRACT_SELECT carries both the delta band and the proxy band, frozen', () => {
  assert.deepEqual(cfg.CONTRACT_SELECT.deltaBand, { minAbsDelta: 0.3, maxAbsDelta: 0.5, minCoverage: 0.8 });
  assert.ok(Object.isFrozen(cfg.CONTRACT_SELECT.deltaBand));
  assert.deepEqual(cfg.CONTRACT_SELECT.deltaBandProxy, { minMoneyness: -0.1, maxMoneyness: 0.05 });
});

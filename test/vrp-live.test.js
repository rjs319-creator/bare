// Locks the vrp-put-write-live preregistration (PREREGISTRATION-VRP-LIVE-2026-08.md)
// and the FROZEN entry/settlement semantics in lib/vrp-routes.js.
const test = require('node:test');
const assert = require('node:assert');
const REG = require('../lib/research/hypothesis-registry');
const V = require('../lib/vrp-routes');

test('vrp-put-write-live is registered, valid, confirmatory, with the frozen boundaries', () => {
  const h = REG.find('vrp-put-write-live');
  assert.ok(h, 'missing');
  assert.ok(REG.validateHypothesis(h).valid);
  assert.equal(h.mode, 'confirmatory');
  assert.equal(h.status, 'open');
  assert.match(h.stoppingRule, /2028-02-01/);
  assert.match(h.stoppingRule, /≥60 resolved/);
  assert.match(h.stoppingRule, /5%/);          // the mandatory drawdown-month condition
  assert.match(h.stoppingRule, /NO gating/);
});

test('vrp-live-prospective holdout is sealed and untouched', () => {
  const untouched = new Set(REG.untouchedHoldouts().map((x) => x.id));
  assert.ok(untouched.has('vrp-live-prospective'));
});

test('frozen parameters match the doc', () => {
  assert.equal(V.ENTRY_EVERY_SESSIONS, 5);
  assert.equal(V.TENOR_MIN_DTE, 21);
  assert.equal(V.TENOR_MAX_DTE, 45);
  assert.equal(V.COST_PER_CONTRACT, 1);
});

const DAY_SEC = 86_400;
const nowMs = Date.parse('2026-08-05T20:00:00Z');
const expTs = (days) => Math.floor(nowMs / 1000) + days * DAY_SEC;
const chain = (days, puts) => ({ expirationDate: expTs(days), puts });

test('pickPutEntry: chooses the 21-45d expiry nearest 30d and the ATM strike with a real bid', () => {
  const result = {
    quote: { regularMarketPrice: 500 },
    options: [
      chain(7, [{ strike: 500, bid: 9 }]),                        // too near — excluded
      chain(28, [{ strike: 495, bid: 6.1, ask: 6.3, impliedVolatility: 0.17, openInterest: 1000 },
                 { strike: 500, bid: 7.2, ask: 7.4, impliedVolatility: 0.165, openInterest: 2000 },
                 { strike: 505, bid: 0, ask: 8.6 }]),             // zero bid — ineligible
      chain(44, [{ strike: 500, bid: 10 }]),                      // in window but farther from 30d
    ],
  };
  const p = V.pickPutEntry(result, nowMs);
  assert.equal(p.skip, undefined, JSON.stringify(p));
  assert.equal(p.dte, 28);
  assert.equal(p.strike, 500);
  assert.equal(p.bid, 7.2);
});

test('pickPutEntry: records skips instead of inventing entries', () => {
  assert.equal(V.pickPutEntry({ quote: {}, options: [] }, nowMs).skip, 'no-spot');
  assert.equal(V.pickPutEntry({ quote: { regularMarketPrice: 500 }, options: [chain(7, [{ strike: 500, bid: 5 }])] }, nowMs).skip, 'no-expiry-in-21-45d-window');
  assert.equal(V.pickPutEntry({ quote: { regularMarketPrice: 500 }, options: [chain(30, [{ strike: 500, bid: 0 }])] }, nowMs).skip, 'no-atm-put-with-bid');
});

test('resolveEntry: OTM expiry keeps the premium minus the $1 cost', () => {
  const entry = { expiry: '2026-09-04', strike: 500, bid: 7.2 };
  const bars = [{ date: '2026-09-03', close: 505 }, { date: '2026-09-04', close: 510 }];
  const r = V.resolveEntry(entry, bars);
  assert.equal(r.intrinsic, 0);
  assert.equal(r.pnl, 719);                     // 7.2×100 − 1
  assert.ok(r.win);
  assert.equal(r.settleDate, '2026-09-04');
});

test('resolveEntry: ITM expiry pays intrinsic — losses are real and recorded', () => {
  const entry = { expiry: '2026-09-04', strike: 500, bid: 7.2 };
  const bars = [{ date: '2026-09-08', close: 460 }];   // first session ≥ expiry (weekend gap)
  const r = V.resolveEntry(entry, bars);
  assert.equal(r.intrinsic, 40);
  assert.equal(r.pnl, 7.2 * 100 - 40 * 100 - 1);
  assert.ok(!r.win);
});

test('resolveEntry: unexpired entries stay open (null)', () => {
  const entry = { expiry: '2026-09-04', strike: 500, bid: 7.2 };
  assert.equal(V.resolveEntry(entry, [{ date: '2026-08-20', close: 505 }]), null);
});

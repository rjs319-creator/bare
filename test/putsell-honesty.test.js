'use strict';
// INCOME & ENTRY (cash-secured puts) — contract validity, quote provenance and honest
// economics (review prompt 7, findings P7-O5..O10).
//
// A delayed Yahoo snapshot of a real listed put is research. The card must say when the
// quote was observed and that a re-quote is required; the credit is the bid at that
// snapshot, not a fill. Non-standard deliverables never silently use ×100; an unknown
// earnings date is never reported as "no earnings before expiry"; missing IV leaves the
// cash economics intact but can never lift the grade.

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/putsell-contract');
const S = require('../lib/putsell');
const R = require('../lib/putsell-routes');

const DAY = 86_400;
const NOW_SEC = Date.parse('2026-10-02T19:59:00Z') / 1000;   // Friday 15:59 ET
const SAT_MS = Date.parse('2026-10-03T16:00:00Z');
const at = dte => NOW_SEC + dte * DAY;

const setup = { ticker: 'ACME', price: 100, sma50: 97, score: 0.8, cautions: [], earningsInDays: null };
const put = (o = {}) => ({ contractSymbol: 'ACME261106P00095000', strike: 95, bid: 1.20, ask: 1.30, openInterest: 800, volume: 40, impliedVolatility: 0.4, lastTradeDate: NOW_SEC - 600, ...o });
const base = (o = {}) => ({
  source: 'yahoo-delayed',
  quote: { regularMarketPrice: 100, regularMarketTime: NOW_SEC, exchangeDataDelayedBy: 15 },
  expirationDates: [at(7), at(35), at(63)],
  options: [{ expirationDate: at(7), calls: [], puts: [] }],
  ...o,
});

// ── P7-O6: deliverable / multiplier ──────────────────────────────────────────
test('isStandardContract: a plain OCC root matching the ticker is standard; adjusted roots are not; no symbol = unverified', () => {
  assert.deepEqual(C.isStandardContract('ACME261106P00095000', 'ACME'), { standard: true, root: 'ACME', reason: null });
  assert.equal(C.isStandardContract('ACME1261106P00095000', 'ACME').standard, false, 'digit-suffixed root = adjusted deliverable');
  assert.equal(C.isStandardContract('ACME7261106P00095000', 'ACME').standard, false);
  assert.equal(C.isStandardContract('OTHR261106P00095000', 'ACME').standard, false, 'root does not match the underlying');
  assert.equal(C.isStandardContract(null, 'ACME').standard, null, 'unknown — cannot be verified');
});

test('selectPutContract SKIPS non-standard deliverables and names the reason when nothing standard remains', () => {
  const adjusted = put({ contractSymbol: 'ACME1261106P00095000' });
  const r = C.selectPutContract([adjusted], { spot: 100, supportPx: 97, dte: 35, iv: 0.4, ticker: 'ACME' });
  assert.equal(r.contract, null);
  assert.equal(r.reason, 'non-standard-deliverable');
  const mixed = C.selectPutContract([adjusted, put()], { spot: 100, supportPx: 97, dte: 35, iv: 0.4, ticker: 'ACME' });
  assert.equal(mixed.contract.contractSymbol, 'ACME261106P00095000');
  assert.equal(mixed.deliverable.standard, true);
});

test('putEconomics takes an explicit multiplier and echoes it; standard figures reconcile; an adjusted spec never silently uses ×100', () => {
  const std = C.putEconomics({ strike: 95, credit: 1.20 }, { spot: 100, supportPx: 97, dte: 35 });
  assert.equal(std.multiplier, 100);
  assert.equal(std.deliverable, '100 shares per contract (standard)');
  assert.equal(std.cashRequired, 9500);
  assert.equal(std.maxProfit, 120);
  assert.equal(std.breakeven, 93.8);
  const adj = C.putEconomics({ strike: 95, credit: 1.20 }, { spot: 100, supportPx: 97, dte: 35, multiplier: 50 });
  assert.equal(adj.multiplier, 50);
  assert.equal(adj.cashRequired, 4750);
  assert.equal(adj.maxProfit, 60);
  assert.match(adj.deliverable, /adjusted/);
  assert.equal(C.putEconomics({ strike: 95, credit: 1.20 }, { spot: 100, dte: 35, multiplier: 0 }), null, 'a nonsensical multiplier yields no economics');
});

// ── P7-O7: quote validity ────────────────────────────────────────────────────
test('locked and crossed quotes are rejected; a zero bid is rejected; a one-sided ask-only quote is rejected', () => {
  const ctx = { spot: 100, supportPx: 97, dte: 35, iv: 0.4, ticker: 'ACME' };
  assert.equal(C.relSpread(1.2, 1.2), null, 'locked');
  assert.equal(C.relSpread(1.3, 1.2), null, 'crossed');
  assert.equal(C.selectPutContract([put({ bid: 1.2, ask: 1.2 })], ctx).contract, null);
  assert.equal(C.selectPutContract([put({ bid: 1.3, ask: 1.2 })], ctx).contract, null);
  assert.equal(C.selectPutContract([put({ bid: 0, ask: 0.05 })], ctx).contract, null);
  assert.equal(C.selectPutContract([put({ bid: null, ask: 1.3 })], ctx).contract, null);
  assert.equal(C.selectPutContract([put({ bid: 1.2, ask: null })], ctx).contract, null, 'no ask = no spread check possible');
});

// ── P7-O8: missing IV ────────────────────────────────────────────────────────
test('missing IV: richness unknown and the grade is never lifted above the setup-only grade, but cash economics stay available', () => {
  const sel = C.selectPutContract([put({ impliedVolatility: null })], { spot: 100, supportPx: 97, dte: 35, iv: null, ticker: 'ACME' });
  assert.ok(sel.contract, 'a fresh, quoted, listed contract is still a real contract');
  assert.equal(sel.premiumRichness, 'unknown');
  assert.equal(sel.proxyDelta.value, null);
  const econ = C.putEconomics({ strike: sel.contract.strike, credit: sel.credit }, { spot: 100, supportPx: 97, dte: 35 });
  assert.equal(econ.cashRequired, 9500);
  assert.equal(econ.maxProfit, 120);

  const fin = S.finalizePutSell({ ...setup }, { atmIV: null, earningsInDays: null, dte: 35 });
  assert.equal(fin.ivLevel, 'unknown');
  assert.equal(fin.premiumRichness, 'unknown');
  assert.match(fin.ivNote, /unknown/i);

  for (const score of [0.4, 0.55, 0.7, 0.85]) {
    const noIv = S.gradePutSell({ score, atmIV: null });
    const setupOnly = Math.round(score * 100);
    assert.ok(noIv.rankScore <= setupOnly, `score ${score}: ${noIv.rankScore} must not exceed setup-only ${setupOnly}`);
    assert.ok(noIv.rankScore <= S.gradePutSell({ score, atmIV: 0.6 }).rankScore, 'never above confirmed rich premium');
  }
});

// ── P7-O9: earnings relative to the SELECTED expiry ──────────────────────────
test('earnings before / after the selected expiry are classified against that expiry; an unknown date is never "no earnings"', () => {
  assert.equal(C.managementRules({ dte: 35, earningsInDays: 10 }).crossesEarnings, true);
  assert.equal(C.managementRules({ dte: 45, earningsInDays: 40 }).crossesEarnings, true, '40d is inside a 45-DTE expiry');
  assert.equal(C.managementRules({ dte: 35, earningsInDays: 40 }).crossesEarnings, false, '40d is after a 35-DTE expiry');
  const unknown = C.managementRules({ dte: 35, earningsInDays: null });
  assert.equal(unknown.crossesEarnings, null);
  assert.match(unknown.earningsHandling, /Earnings date unavailable/);
  assert.doesNotMatch(unknown.earningsHandling, /No earnings before expiry/);

  const inside = S.finalizePutSell({ ...setup }, { atmIV: 0.4, earningsInDays: 40, dte: 45 });
  assert.ok(inside.earningsSoon);
  assert.match(inside.cautions.join(' '), /Earnings in 40d.*before the selected 45-day expiry/);
  const after = S.finalizePutSell({ ...setup }, { atmIV: 0.4, earningsInDays: 40, dte: 35 });
  assert.ok(!after.earningsSoon);
  assert.doesNotMatch(after.cautions.join(' '), /Earnings in/);
  const noDate = S.finalizePutSell({ ...setup }, { atmIV: 0.4, earningsInDays: null, dte: 35 });
  assert.match(noDate.cautions.join(' '), /Earnings date unavailable/);
});

// ── P7-O5 / O10: the real-put record ─────────────────────────────────────────
test('assembleRealPut carries quoteAsOf, lastTradeDate, delayedByMin, source, session and multiplier; copy says re-quote, never fill', () => {
  const chain = { expirationDate: at(35), calls: [], puts: [put()] };
  const r = R.assembleRealPut(setup, { base: base(), chain, pick: { ts: at(35), dte: 35, inWindow: true }, nowMs: SAT_MS, allowEarnings: false });
  assert.equal(r.isRealContract, true);
  assert.equal(r.strike, 95);
  assert.equal(r.quoteAsOf, '2026-10-02T19:59:00.000Z');
  assert.equal(r.lastTradeDate, new Date((NOW_SEC - 600) * 1000).toISOString());
  assert.equal(r.delayedByMin, 15);
  assert.equal(r.source, 'yahoo-delayed');
  assert.equal(r.session, 'closed', 'Saturday read');
  assert.equal(r.snapshotOnly, true);
  assert.equal(r.requoteRequired, true);
  assert.equal(r.economics.multiplier, 100);
  assert.equal(r.deliverable.standard, true);
  assert.match(r.creditBasis, /bid at the delayed snapshot/i);
  assert.doesNotMatch(JSON.stringify(r), /should fill|will fill|you may fill/i);
  assert.equal(r.management.crossesEarnings, null, 'earnings date unknown stays unknown');
});

test('assembleRealPut never invents a quote time: a chain without one leaves quoteAsOf null', () => {
  const chain = { expirationDate: at(35), calls: [], puts: [put({ lastTradeDate: undefined })] };
  const b = base({ quote: { regularMarketPrice: 100 } });
  const r = R.assembleRealPut(setup, { base: b, chain, pick: { ts: at(35), dte: 35, inWindow: true }, nowMs: SAT_MS, allowEarnings: false });
  assert.equal(r.quoteAsOf, null);
  assert.equal(r.lastTradeDate, null);
  assert.equal(r.delayedByMin, null);
});

test('no expiry inside 25–45 DTE ⇒ { contract: null, reason: "no-expiry-in-window" } (selectExpiry fallback left alone)', () => {
  const pick = C.selectExpiry([at(7), at(90)], NOW_SEC);
  assert.equal(pick.inWindow, false, 'the pure picker still falls back (pinned behaviour)');
  const r = R.assembleRealPut(setup, { base: base({ expirationDates: [at(7), at(90)] }), chain: { puts: [put()] }, pick, nowMs: SAT_MS, allowEarnings: false });
  assert.equal(r.contract, null);
  assert.equal(r.reason, 'no-expiry-in-window');
  assert.equal(r.dte, pick.dte);
});

test('a crossed-earnings pick is excluded by default and the exclusion is explicit', () => {
  const chain = { expirationDate: at(35), calls: [], puts: [put()] };
  const r = R.assembleRealPut({ ...setup, earningsInDays: 10 }, { base: base(), chain, pick: { ts: at(35), dte: 35, inWindow: true }, nowMs: SAT_MS, allowEarnings: false });
  assert.equal(r.contract, null);
  assert.equal(r.reason, 'crosses-earnings');
  assert.equal(r.earningsExcluded, true);
});

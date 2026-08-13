'use strict';
// THE BACKTEST'S "OUT-OF-SAMPLE" BOUNDARY LEAKED TWO WAYS (alpha-research pass 3).
//
// api/backtest.js split its trades with:
//     const sorted = [...trades].sort((a, b) => a.date < b.date ? -1 : 1);
//     const cut = Math.floor(sorted.length * 0.6);
//     const IS = sorted.slice(0, cut), OOS = sorted.slice(cut);
//
// (1) THE CUT LANDED MID-DATE. The universe signals many tickers on the same session, so
//     an index-based cut splits ONE date across the boundary: the same day and the same
//     market shock, partly training and partly "out of sample". The comparator never
//     returns 0 for equal dates, so which side a same-date trade landed on was arbitrary.
//
// (2) NO EMBARGO AGAINST THE LABEL. Every label runs up to MAX_HOLD=20 sessions forward
//     from its signal, so the last in-sample trades were still OPEN — their outcomes
//     still being determined — across the first out-of-sample entries. The two cohorts
//     shared price action, which is precisely what an out-of-sample test must not allow.
//
// Both are fixed by splitting on a DATE boundary and then dropping every trade up to the
// latest in-sample EXIT date. The realized exit is used rather than a flat MAX_HOLD gap so
// trades that stopped out early do not purge more of the sample than they need to.
//
// CONSEQUENCE: this makes the test strictly harder and the OOS cohort strictly smaller.
// Any efficacy figure produced before this change measured a leaking boundary.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const BT = require('../api/backtest');

// Build trades on `dates`, `perDate` tickers each, each held `hold` sessions forward
// along the same date axis.
function mkTrades(dates, perDate, hold) {
  const out = [];
  dates.forEach((d, i) => {
    for (let k = 0; k < perDate; k++) {
      out.push({ date: d, exitDate: dates[Math.min(i + hold, dates.length - 1)], excess: 0.01, won: true });
    }
  });
  return out;
}

const DATES = Array.from({ length: 50 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`);

// ── (1) the boundary is a date, not an index ─────────────────────────────────────

test('no signal date appears on both sides of the split', () => {
  // The exact leak: one session's trades partly training, partly "out of sample".
  const { IS, OOS } = BT.splitWithEmbargo(mkTrades(DATES, 7, 3));
  const isDates = new Set(IS.map(t => t.date));
  const straddling = OOS.filter(t => isDates.has(t.date)).map(t => t.date);
  assert.deepEqual([...new Set(straddling)], [], `date(s) on both sides: ${straddling.join(', ')}`);
});

test('the split lands on a date boundary even when dates carry uneven trade counts', () => {
  // An index-based cut is at the mercy of how many tickers happened to fire per day; a
  // date-based cut is not. Lopsided counts is the case that exposed it.
  const lopsided = [
    ...mkTrades(DATES.slice(0, 10), 30, 2),  // heavy early
    ...mkTrades(DATES.slice(10), 1, 2),      // thin late
  ];
  const { IS, OOS, splitDate } = BT.splitWithEmbargo(lopsided);
  assert.ok(IS.every(t => t.date < splitDate), 'IS is strictly before the boundary');
  assert.ok(OOS.every(t => t.date > splitDate), 'OOS is strictly after it');
  // 60% of 50 DISTINCT DATES, not 60% of 340 trades.
  assert.equal(splitDate, DATES[Math.floor(DATES.length * BT.IS_FRACTION)]);
});

test('input order does not change the split — the old comparator never returned 0', () => {
  const t = mkTrades(DATES, 4, 3);
  const a = BT.splitWithEmbargo(t);
  const b = BT.splitWithEmbargo([...t].reverse());
  assert.equal(a.splitDate, b.splitDate);
  assert.equal(a.IS.length, b.IS.length);
  assert.equal(a.OOS.length, b.OOS.length);
});

test('the caller is not mutated', () => {
  const t = mkTrades(DATES, 3, 2);
  const before = t.map(x => x.date).join(',');
  BT.splitWithEmbargo(t);
  assert.equal(t.map(x => x.date).join(','), before);
});

// ── (2) the embargo covers the label ─────────────────────────────────────────────

test('no in-sample position is still open on any out-of-sample entry date', () => {
  // This is the whole point. If ANY IS trade exits on or after an OOS trade's signal, the
  // two cohorts share price action and the OOS number is not out-of-sample.
  const { IS, OOS } = BT.splitWithEmbargo(mkTrades(DATES, 5, 6));
  const lastIsExit = IS.reduce((m, t) => (t.exitDate > m ? t.exitDate : m), '');
  const overlapping = OOS.filter(t => t.date <= lastIsExit);
  assert.deepEqual(overlapping, [], `${overlapping.length} OOS entries fall inside an open IS label`);
});

test('the embargo gap widens with the holding period', () => {
  // A 1-session hold barely purges; a 20-session hold purges a lot. If the gap did not
  // track the label span, one of these would be wrong.
  const short = BT.splitWithEmbargo(mkTrades(DATES, 4, 1));
  const long = BT.splitWithEmbargo(mkTrades(DATES, 4, 20));
  assert.ok(long.embargoedN > short.embargoedN,
    `20-session labels must purge more than 1-session labels (${long.embargoedN} vs ${short.embargoedN})`);
  assert.ok(long.OOS.length < short.OOS.length, 'and leave a smaller OOS cohort');
});

test('the embargo is sized from the REALIZED exit, not a worst-case constant', () => {
  // Trades that stop out early must not purge MAX_HOLD sessions they never occupied.
  const early = BT.splitWithEmbargo(mkTrades(DATES, 4, 2));
  const full = BT.splitWithEmbargo(mkTrades(DATES, 4, BT.MAX_HOLD));
  assert.ok(early.embargoedN < full.embargoedN,
    'a flat MAX_HOLD gap would purge these two identically');
});

test('every trade lands in exactly one of IS / embargoed / OOS', () => {
  const t = mkTrades(DATES, 6, 4);
  const { IS, OOS, embargoedN } = BT.splitWithEmbargo(t);
  assert.equal(IS.length + OOS.length + embargoedN, t.length);
  const ids = new Set([...IS, ...OOS]);
  assert.equal(ids.size, IS.length + OOS.length, 'no trade counted twice');
});

test('the dropped count is reported, not silently absorbed', () => {
  const { embargoedN, embargoUntil } = BT.splitWithEmbargo(mkTrades(DATES, 5, 6));
  assert.ok(embargoedN > 0, 'a 6-session hold must drop something');
  assert.ok(embargoUntil, 'the gap end must be reported so the change is auditable');
});

// ── degenerate inputs fail closed ────────────────────────────────────────────────

test('too few distinct dates yields empty cohorts rather than a fake split', () => {
  for (const t of [[], mkTrades(['2026-01-01'], 50, 1)]) {
    const r = BT.splitWithEmbargo(t);
    assert.deepEqual(r.IS, []);
    assert.deepEqual(r.OOS, []);
    assert.equal(r.splitDate, null);
  }
});

test('a missing exitDate cannot shrink the embargo below the boundary date', () => {
  // Fail-closed: an unlabelled trade must not be read as "exits immediately".
  const t = mkTrades(DATES, 3, 5).map(x => ({ ...x, exitDate: undefined }));
  const { splitDate, embargoUntil, IS, OOS } = BT.splitWithEmbargo(t);
  assert.equal(embargoUntil, splitDate, 'the gap still starts at the boundary');
  assert.ok(IS.every(x => x.date < splitDate));
  assert.ok(OOS.every(x => x.date > splitDate));
});

// ── the wiring, and the honesty stamp on the response ────────────────────────────

const SRC = fs.readFileSync(path.join(__dirname, '..', 'api', 'backtest.js'), 'utf8');
const CODE = SRC.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

test('the efficacy block uses the embargoed split, not a raw index cut', () => {
  assert.ok(!/const cut = Math\.floor\(sorted\.length \* 0\.6\)/.test(CODE), 'the index cut returned');
  assert.match(CODE, /const \{ IS, OOS, splitDate, embargoUntil, embargoedN \} = splitWithEmbargo\(trades\)/);
});

test('trades carry the exit date the embargo is computed from', () => {
  // Without this the embargo silently degrades to the boundary date everywhere.
  assert.match(CODE, /trades\.push\(\{ tier: e\.status, date: c\[i\]\.date, exitDate,/);
});

test('the response states that prior figures are not comparable', () => {
  assert.match(CODE, /embargo: \{/);
  assert.match(CODE, /applied: true/);
  assert.match(SRC, /are not comparable/i);
  assert.match(CODE, /droppedTrades: embargoedN/);
});

test('the UI surfaces the embargo rather than reporting a quietly different number', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(app, /eff\.embargo && eff\.embargo\.applied/);
  assert.match(app, /trades spanning the boundary are dropped/);
});

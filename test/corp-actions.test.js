'use strict';
// CORPORATE-ACTION CALENDAR → the corpAction false-positive hypothesis.
//
// The contract under test is the asymmetry: a calendar that ANSWERS and lists nothing
// REFUTES the hypothesis; a calendar that FAILED leaves it open. Those two produce the
// same empty result and must not produce the same verdict.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const ca = require('../lib/corp-actions');
const hyp = require('../lib/options-hypotheses-v2');
const { CATEGORY } = require('../lib/fmp-client');

const NOW = Date.parse('2026-08-14T12:00:00Z');
const day = off => new Date(NOW + off * 86_400_000).toISOString().slice(0, 10);

// A fake fmpRequest keyed by path.
const req = (byPath) => async (path) => {
  const v = byPath[path];
  if (!v) return { ok: false, category: CATEGORY.NOT_FOUND, body: null };
  if (v.category) return { ok: false, category: v.category, body: null };
  return { ok: true, category: CATEGORY.OK, body: v };
};
const bothOk = (divRows = [], splitRows = []) => req({ [ca.DIVIDEND_PATH]: divRows, [ca.SPLIT_PATH]: splitRows });

// ── Row normalization ───────────────────────────────────────────────────────

test('rowOf accepts the field-name variants vendors actually emit', () => {
  assert.deepEqual(ca.rowOf({ symbol: 'AAA', date: '2026-08-20' }, 'dividend'), { symbol: 'AAA', date: '2026-08-20' });
  assert.deepEqual(ca.rowOf({ ticker: 'bbb', exDividendDate: '2026-08-21' }, 'dividend'), { symbol: 'BBB', date: '2026-08-21' });
  assert.deepEqual(ca.rowOf({ symbol: 'CCC', splitDate: '2026-08-22' }, 'split'), { symbol: 'CCC', date: '2026-08-22' });
});

test('rowOf rejects unusable rows rather than coercing them', () => {
  for (const bad of [null, {}, { symbol: 'AAA' }, { date: '2026-08-20' }, { symbol: 'AAA', date: 'soon' }]) {
    assert.equal(ca.rowOf(bad, 'dividend'), null);
  }
});

// ── The load-bearing asymmetry ──────────────────────────────────────────────

test('a CLEAN calendar with no action gives full coverage — the hypothesis can be refuted', async () => {
  const { index, diagnostics } = await ca.buildCorpActionIndex({ tickers: ['AAA'], now: NOW, requestImpl: bothOk([], []) });
  const entry = index.get('AAA');
  assert.equal(entry.exDivDate, null);
  assert.equal(entry.splitDate, null);
  assert.deepEqual(entry.coverage, { dividend: true, split: true });
  assert.equal(diagnostics.partial, false);

  const L = hyp.buildHypotheses({ contracts: [], corpAction: entry, nowMs: NOW });
  const h = L.hypotheses.find(x => x.id === 'corpAction');
  assert.equal(h.verdict, hyp.VERDICT.REFUTED);
  assert.match(h.evidence.join(' '), /returned cleanly/i);
});

test('a FAILED calendar with no action leaves the hypothesis OPEN — silence is not evidence', async () => {
  const { index, diagnostics } = await ca.buildCorpActionIndex({
    tickers: ['AAA'], now: NOW,
    requestImpl: req({ [ca.DIVIDEND_PATH]: [], [ca.SPLIT_PATH]: { category: CATEGORY.PLAN_GATED } }),
  });
  const entry = index.get('AAA');
  assert.deepEqual(entry.coverage, { dividend: true, split: false });
  assert.equal(diagnostics.partial, true);
  assert.match(diagnostics.partialNote, /cannot be fully refuted/i);

  const L = hyp.buildHypotheses({ contracts: [], corpAction: entry, nowMs: NOW });
  const h = L.hypotheses.find(x => x.id === 'corpAction');
  assert.equal(h.verdict, hyp.VERDICT.UNRESOLVED);
  assert.match(h.evidence.join(' '), /NOT evidence of absence/i);
});

test('THE REGRESSION: an answered-empty and a failed calendar must not agree', async () => {
  const clean = (await ca.buildCorpActionIndex({ tickers: ['AAA'], now: NOW, requestImpl: bothOk([], []) })).index.get('AAA');
  const failed = (await ca.buildCorpActionIndex({
    tickers: ['AAA'], now: NOW,
    requestImpl: req({ [ca.DIVIDEND_PATH]: { category: CATEGORY.UPSTREAM_ERROR }, [ca.SPLIT_PATH]: [] }),
  })).index.get('AAA');
  const v = e => hyp.buildHypotheses({ contracts: [], corpAction: e, nowMs: NOW }).hypotheses.find(x => x.id === 'corpAction').verdict;
  assert.equal(v(clean), hyp.VERDICT.REFUTED);
  assert.equal(v(failed), hyp.VERDICT.UNRESOLVED);
  assert.notEqual(v(clean), v(failed));
});

// ── Windows ─────────────────────────────────────────────────────────────────

test('a NEAR ex-dividend SUPPORTS the benign explanation', async () => {
  const { index } = await ca.buildCorpActionIndex({
    tickers: ['AAA'], now: NOW, requestImpl: bothOk([{ symbol: 'AAA', date: day(3) }], []),
  });
  const h = hyp.buildHypotheses({ contracts: [], corpAction: index.get('AAA'), nowMs: NOW }).hypotheses.find(x => x.id === 'corpAction');
  assert.equal(h.verdict, hyp.VERDICT.SUPPORTED);
  assert.equal(h.actionKind, 'ex-dividend');
  assert.match(h.evidence.join(' '), /nothing like a directional bet/i);
});

test('a JUST-PASSED ex-date still explains today\'s prints', async () => {
  const { index } = await ca.buildCorpActionIndex({
    tickers: ['AAA'], now: NOW, requestImpl: bothOk([{ symbol: 'AAA', date: day(-2) }], []),
  });
  const h = hyp.buildHypotheses({ contracts: [], corpAction: index.get('AAA'), nowMs: NOW }).hypotheses.find(x => x.id === 'corpAction');
  assert.equal(h.verdict, hyp.VERDICT.SUPPORTED);
  assert.match(h.evidence.join(' '), /2d ago/);
});

test('a DISTANT action is actively refuted, not left open', async () => {
  const { index } = await ca.buildCorpActionIndex({
    tickers: ['AAA'], now: NOW, requestImpl: bothOk([{ symbol: 'AAA', date: day(25) }], []),
  });
  const h = hyp.buildHypotheses({ contracts: [], corpAction: index.get('AAA'), nowMs: NOW }).hypotheses.find(x => x.id === 'corpAction');
  assert.equal(h.verdict, hyp.VERDICT.REFUTED);
  assert.match(h.evidence.join(' '), /too distant/i);
});

test('a split is detected as well as a dividend', async () => {
  const { index } = await ca.buildCorpActionIndex({
    tickers: ['AAA'], now: NOW, requestImpl: bothOk([], [{ symbol: 'AAA', date: day(4) }]),
  });
  const h = hyp.buildHypotheses({ contracts: [], corpAction: index.get('AAA'), nowMs: NOW }).hypotheses.find(x => x.id === 'corpAction');
  assert.equal(h.verdict, hyp.VERDICT.SUPPORTED);
  assert.equal(h.actionKind, 'split');
});

// ── Failure handling ────────────────────────────────────────────────────────

test('both calendars failing yields a NULL index — prior wording is preserved exactly', async () => {
  const { index, diagnostics } = await ca.buildCorpActionIndex({
    tickers: ['AAA'], now: NOW,
    requestImpl: req({ [ca.DIVIDEND_PATH]: { category: CATEGORY.PLAN_GATED }, [ca.SPLIT_PATH]: { category: CATEGORY.PLAN_GATED } }),
  });
  assert.equal(index, null);
  assert.equal(diagnostics.available, false);
  // With no index the caller passes null, and the hypothesis reads exactly as before.
  const h = hyp.buildHypotheses({ contracts: [], corpAction: null, nowMs: NOW }).hypotheses.find(x => x.id === 'corpAction');
  assert.equal(h.verdict, hyp.VERDICT.UNRESOLVED);
  assert.match(h.evidence.join(' '), /no corporate-action calendar is wired/i);
});

test('a plan-gated calendar says so PERMANENTLY, distinct from a transient failure', async () => {
  const gated = await ca.buildCorpActionIndex({
    tickers: ['A'], now: NOW,
    requestImpl: req({ [ca.DIVIDEND_PATH]: { category: CATEGORY.PLAN_GATED }, [ca.SPLIT_PATH]: { category: CATEGORY.PLAN_GATED } }),
  });
  assert.match(gated.diagnostics.dividend.reason, /not included in the current FMP plan/);
  assert.match(gated.diagnostics.dividend.reason, /permanent/i);
  assert.equal(gated.diagnostics.dividend.category, CATEGORY.PLAN_GATED);

  const flaky = await ca.buildCorpActionIndex({
    tickers: ['A'], now: NOW,
    requestImpl: req({ [ca.DIVIDEND_PATH]: { category: CATEGORY.RATE_LIMITED }, [ca.SPLIT_PATH]: { category: CATEGORY.RATE_LIMITED } }),
  });
  assert.doesNotMatch(flaky.diagnostics.dividend.reason, /plan/i);
});

test('a missing key is reported as such, not as an empty calendar', async () => {
  const r = await ca.buildCorpActionIndex({
    tickers: ['A'], now: NOW,
    requestImpl: req({ [ca.DIVIDEND_PATH]: { category: CATEGORY.NO_KEY }, [ca.SPLIT_PATH]: { category: CATEGORY.NO_KEY } }),
  });
  assert.equal(r.index, null);
  assert.match(r.diagnostics.dividend.reason, /FMP_API_KEY is not configured/);
});

test('an unexpected body shape is rejected rather than read as empty', async () => {
  const r = await ca.buildCorpActionIndex({
    tickers: ['A'], now: NOW,
    requestImpl: async () => ({ ok: true, category: CATEGORY.OK, body: { unexpected: true } }),
  });
  assert.equal(r.index, null);
  assert.match(r.diagnostics.dividend.reason, /unexpected shape/i);
});

// ── Index shape ─────────────────────────────────────────────────────────────

test('the index covers every requested ticker, including those with no action', async () => {
  const { index, diagnostics } = await ca.buildCorpActionIndex({
    tickers: ['AAA', 'BBB', 'CCC'], now: NOW,
    requestImpl: bothOk([{ symbol: 'AAA', date: day(2) }], [{ symbol: 'BBB', date: day(5) }]),
  });
  assert.equal(index.size, 3);
  assert.equal(diagnostics.withAction, 2);
  assert.equal(index.get('CCC').exDivDate, null);
  assert.deepEqual(index.get('CCC').coverage, { dividend: true, split: true });
});

test('only two calendar calls are made regardless of universe size', async () => {
  let calls = 0;
  const counting = async (path) => { calls++; return { ok: true, category: CATEGORY.OK, body: [] }; };
  await ca.buildCorpActionIndex({ tickers: Array.from({ length: 400 }, (_, i) => `T${i}`), now: NOW, requestImpl: counting });
  assert.equal(calls, 2);
});

test('the hypothesis ledger still reports all eight explanations', async () => {
  const { index } = await ca.buildCorpActionIndex({ tickers: ['AAA'], now: NOW, requestImpl: bothOk([], []) });
  const L = hyp.buildHypotheses({ contracts: [], corpAction: index.get('AAA'), nowMs: NOW });
  assert.equal(L.hypotheses.length, hyp.CATALOG.length);
  assert.ok(L.counts.refuted >= 1);
});

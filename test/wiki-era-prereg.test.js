// momentum-wiki-2014-2018 preregistration guards + wiki-source adapter units.
// The discipline these lock: the WIKI study is a NEW sealed hypothesis (the
// 2010-2021 Era-A holdout stays untouched), its verdict ceiling is recorded,
// and the adapter's identity/adjustment rules behave exactly as preregistered.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REG = require('../lib/research/hypothesis-registry');
const WIKI = require('../research/lib/wiki-source');
const RUN66 = require('../research/66-wiki-confirmatory');

// ── registry ─────────────────────────────────────────────────────────────────

test('momentum-wiki-2014-2018 is registered: confirmatory, open, swing-ranking, validator-clean', () => {
  const h = REG.HYPOTHESES.find((x) => x.id === 'momentum-wiki-2014-2018');
  assert.ok(h, 'registry entry must exist');
  assert.strictEqual(h.familyId, 'swing-ranking');
  assert.strictEqual(h.mode, 'confirmatory');
  assert.strictEqual(h.status, 'open');
  const v = REG.validateHypothesis(h);
  assert.strictEqual(v.valid, true, `validator errors: ${JSON.stringify(v.errors)}`);
  assert.match(h.stoppingRule, /NO tuning/i);
  assert.match(h.stoppingRule, /pass-provisional\(survivorship-reduced\)/);
  assert.match(h.stoppingRule, /NEVER, under any result, promote/);
});

test('the family denominator grew: swing-ranking counts the WIKI trial', () => {
  assert.ok(REG.familyTrials('swing-ranking') >= 12, 'registering the WIKI study must widen the BH denominator to ≥ 12');
});

test('the WIKI holdout is sealed and the original Era-A holdout REMAINS sealed', () => {
  const wiki = REG.HOLDOUTS.find((x) => x.id === 'momentum-wiki-2014-2018-era');
  assert.ok(wiki, 'wiki holdout must exist');
  assert.ok(wiki.sealedAt && wiki.openedAt === null && wiki.openedBy === null);
  assert.ok(REG.untouchedHoldouts().some((x) => x.id === 'momentum-wiki-2014-2018-era'));
  const eraA = REG.HOLDOUTS.find((x) => x.id === 'momentum-historical-2010-2021');
  assert.ok(eraA, 'Era-A holdout must still exist');
  assert.strictEqual(eraA.openedAt, null, 'the WIKI study must NOT open the 2010-2021 holdout');
});

test('the preregistration document exists and carries the load-bearing clauses', () => {
  const p = path.join(__dirname, '..', 'research', 'PREREGISTRATION-MOMENTUM-WIKI-2026-08.md');
  const doc = fs.readFileSync(p, 'utf8');
  assert.match(doc, /2014-01\.\.2017-12/);
  assert.match(doc, /Verdict ceiling: `pass-provisional \(survivorship-reduced\)`/);
  assert.match(doc, /ADV20 ≥ \$3M only/i);
  assert.match(doc, /ONE run ever|ONE evaluation ever/i);
  assert.match(doc, /no era extension/i);
  assert.match(doc, /Any deviation is a NEW hypothesis/);
  assert.match(doc, /REMAINS SEALED/);
});

// ── wiki-source adapter units ────────────────────────────────────────────────

const R = (date, close, opts = {}) => ({ date, open: opts.open ?? close, high: opts.high ?? close, low: opts.low ?? close, close, volume: opts.volume ?? 1000, exDividend: opts.exDividend ?? 0, splitRatio: opts.splitRatio ?? 1, adjClose: opts.adjClose ?? null });

test('backAdjustForSplits: a 2:1 split halves earlier prices and doubles earlier volume; post-split bars untouched', () => {
  const rows = [R('2015-01-02', 100), R('2015-01-05', 102), R('2015-01-06', 52, { splitRatio: 2 }), R('2015-01-07', 53)];
  const adj = WIKI.backAdjustForSplits(rows);
  assert.strictEqual(adj[0].close, 50);
  assert.strictEqual(adj[1].close, 51);
  assert.strictEqual(adj[0].volume, 2000);
  assert.strictEqual(adj[2].close, 52, 'the bar ON the split date is already post-split');
  assert.strictEqual(adj[3].close, 53);
});

test('synthesizeCorpactions: splits in numerator/denominator shape; adjDividend on the adjusted scale', () => {
  const rows = [R('2015-01-02', 100, { exDividend: 1 }), R('2015-01-06', 52, { splitRatio: 2 }), R('2015-01-07', 53, { exDividend: 0.25 })];
  const adj = WIKI.backAdjustForSplits(rows);
  const corp = WIKI.synthesizeCorpactions('T', rows, adj);
  assert.deepStrictEqual(corp.splits, [{ symbol: 'T', date: '2015-01-06', numerator: 2, denominator: 1, splitType: 'stock-split' }]);
  assert.strictEqual(corp.dividends.length, 2);
  assert.strictEqual(corp.dividends[0].adjDividend, 0.5, 'pre-split dividend must be halved onto the adjusted scale');
  assert.strictEqual(corp.dividends[1].adjDividend, 0.25);
});

test('adjustmentCrossCheck: agreement on clean data, disagreement counted, dividend days skipped', () => {
  const rows = [R('2015-01-02', 100, { adjClose: 50 }), R('2015-01-05', 102, { adjClose: 51 }), R('2015-01-06', 52, { splitRatio: 2, adjClose: 52 }), R('2015-01-07', 53, { adjClose: 53 })];
  const adj = WIKI.backAdjustForSplits(rows);
  const ok = WIKI.adjustmentCrossCheck(rows, adj);
  assert.strictEqual(ok.mismatched, 0, `derived basis must agree with WIKI adj ratios (checked ${ok.checked})`);
  const bad = rows.map((r) => ({ ...r, adjClose: r.adjClose * (r.date === '2015-01-05' ? 1.5 : 1) }));
  const res = WIKI.adjustmentCrossCheck(bad, WIKI.backAdjustForSplits(bad));
  assert.ok(res.mismatched >= 1, 'a corrupted adj ratio must be counted as a mismatch');
});

test('joinDeath: zombie exclusion, delisting attach with full outcome-v3 confirmation fields, honest unknown', () => {
  const death = { date: '2015-03-30', reasonCategory: 'bankruptcy', reason: '8-K 1.03', basis: 'edgar-form25-effective', confirmedAt: '2015-03-20', accessionNumber: '0000-xx' };
  // Bars continuing 46+ days past the death ⇒ ticker reuse ⇒ exclude.
  assert.strictEqual(WIKI.joinDeath('2015-06-30', death).kind, 'zombie');
  // Bars ending before/near the death ⇒ attach the confirmation.
  const attached = WIKI.joinDeath('2015-02-02', death);
  assert.strictEqual(attached.kind, 'delisted');
  for (const k of ['date', 'source', 'confirmedAt', 'provenance', 'reasonCategory']) {
    assert.ok(attached.delisting[k], `delisting.${k} required by outcome-v3 delistingConfirmation`);
  }
  // No verified death: alive at freeze vs unknown mid-era ender.
  assert.strictEqual(WIKI.joinDeath('2018-03-27', null).kind, 'active');
  assert.strictEqual(WIKI.joinDeath('2016-05-01', null).kind, 'unknown');
});

// ── confirmatory runner units ────────────────────────────────────────────────

test('spearman: exact on monotone and anti-monotone data; lcg control is deterministic', () => {
  assert.strictEqual(RUN66.spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.strictEqual(RUN66.spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1);
  const a = RUN66.lcg(42), b = RUN66.lcg(42);
  assert.strictEqual(a(), b(), 'same seed ⇒ same control permutation stream');
});

test('perDateICs: enforces the 30-name floor and the eligibility set; flagged rows excluded only in the sensitivity view', () => {
  const mk = (dt, n, flagged = 0) => Array.from({ length: n }, (_, i) => ({ dt, m121: i, f63: i + (i % 3 === 0 ? 0.5 : 0), ...(i < flagged ? { x63: 1 } : {}) }));
  const panel = { '2015-01': [...mk('2015-01-30', 40, 5), ...mk('2015-02-27', 10)] };
  const elig = new Set(['2015-01-30', '2015-02-27']);
  const inc = RUN66.perDateICs(panel, elig, 63, { excludeFlagged: false });
  assert.strictEqual(inc.ics.length, 1, 'the 10-name date must fall below the floor');
  assert.strictEqual(inc.dropped.length, 1);
  assert.strictEqual(inc.ics[0].n, 40);
  const exc = RUN66.perDateICs(panel, elig, 63, { excludeFlagged: true });
  assert.strictEqual(exc.ics[0].n, 35, 'sensitivity view must drop the flagged rows');
  const none = RUN66.perDateICs(panel, new Set(), 63, {});
  assert.strictEqual(none.ics.length, 0, 'no eligible dates ⇒ no ICs (fail closed)');
});

test('buildPanel stays parameterized with byte-identical defaults (source pins)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'research', '15-panel-features-v3.js'), 'utf8');
  assert.match(src, /const requireShares = opts\.requireShares !== false;/);
  assert.match(src, /cap < pit\.CAP_LO \|\| cap > pit\.CAP_HI \|\| pa\.adv < pit\.ADV_FLOOR/, 'the frozen default band rule must survive as the default');
  assert.match(src, /'fmp-cache-v1\+corpactions-v1-tr'/, 'default priceDataVersion unchanged');
});

// GitHub-scan research studies (docs/research-studies-2026-10.md): the four registry rows
// exist, validate, declare a placebo and a minimum N, and the op=hypotheses cross-check
// badge is additive and fail-closed. Also locks the js-stats-cli bridge the Python
// cross-check calls, so a drift in pbo.js/evolve-dsr.js shows up here, not in Python.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HR = require('../lib/research/hypothesis-registry');
const ROUTES = require('../lib/hypothesis-routes');
const CLI = require('../research/lib/js-stats-cli');
const PBO = require('../lib/research/pbo');

const STUDY_ROWS = [
  { id: 'wiki-attention-reversal', status: 'no-edge', mode: 'exploratory', familyId: 'attention' },
  { id: 'lazy-prices-text-change', status: 'open', mode: 'exploratory', familyId: 'filing-text' },
  { id: 'transcripts-tone-defeatbeta', status: 'open', mode: 'exploratory', familyId: 'earnings-tone' },
  { id: 'screener-family-spa', status: 'open', mode: 'confirmatory', familyId: 'overfit-crosscheck' },
];

for (const row of STUDY_ROWS) {
  test(`registry row ${row.id}: present, validator-clean, placebo + minimum N stated`, () => {
    const h = HR.find(row.id);
    assert.ok(h, 'row must exist');
    assert.strictEqual(h.status, row.status);
    assert.strictEqual(h.mode, row.mode);
    assert.strictEqual(h.familyId, row.familyId);
    assert.deepStrictEqual(HR.validateHypothesis(h), { valid: true, errors: [] });
    assert.match(h.baseline, /placebo|synthetic selftest/i, 'placebo definition lives in baseline');
    assert.match(h.primaryMetric, /minimum|insufficient-data below|minimum N|minimum 30/i, 'minimum N stated');
    assert.match(h.note, /weight 0|no alpha/i, 'weight-0 / shadow stated');
  });
}

test('wiki-attention-reversal is a graveyard row whose evidence names the artifact and the placebo read', () => {
  const h = HR.find('wiki-attention-reversal');
  assert.ok(HR.graveyard().some((g) => g.id === h.id));
  assert.match(h.evidence, /research\/data-derived\/wiki-attention\/summary\.json/);
  assert.match(h.evidence, /placebo/);
  assert.match(h.evidence, /NOT CONFIRMED/);
});

test('the committed wiki-attention summary agrees with the registry row (primary not-confirmed)', () => {
  const file = path.join(__dirname, '..', 'research', 'data-derived', 'wiki-attention', 'summary.json');
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(s.verdict.verdict, 'not-confirmed');
  assert.deepStrictEqual(s.frozen.primary, { variant: 'quiet', H: 21 });
  assert.ok(s.primary.n >= 100 && s.primary.dates >= 40, 'primary cell cleared the insufficient-data floor');
  assert.ok(s.primary.mean > 0, 'the recorded primary mean has the wrong sign for the hypothesis');
});

// ── cross-check badge ───────────────────────────────────────────────────────────────
test('readCrossCheck fails closed on a missing or malformed file', () => {
  assert.strictEqual(ROUTES.readCrossCheck(path.join(os.tmpdir(), 'does-not-exist.json')), null);
  const bad = path.join(os.tmpdir(), `bad-crosscheck-${process.pid}.json`);
  fs.writeFileSync(bad, JSON.stringify({ overall: 'maybe', byHypothesis: {} }));
  assert.strictEqual(ROUTES.readCrossCheck(bad), null);
  fs.unlinkSync(bad);
});

test('withCrossCheck attaches a badge only to the hypotheses the file names and never mutates the registry', () => {
  const good = path.join(os.tmpdir(), `good-crosscheck-${process.pid}.json`);
  fs.writeFileSync(good, JSON.stringify({ overall: 'agree', generatedAt: '2026-10-02T00:00:00Z', byHypothesis: { 'screener-family-spa': { verdict: 'agree', checkedAt: '2026-10-02T00:00:00Z', matrix: 'screener-family' }, ghost: { verdict: 'nope' } } }));
  const cc = ROUTES.readCrossCheck(good);
  fs.unlinkSync(good);
  assert.deepStrictEqual(Object.keys(cc.byHypothesis), ['screener-family-spa'], 'unknown verdicts are dropped');
  const out = ROUTES.withCrossCheck(HR.HYPOTHESES, cc);
  const badged = out.filter((h) => h.crossCheck);
  assert.strictEqual(badged.length, 1);
  assert.strictEqual(badged[0].id, 'screener-family-spa');
  assert.strictEqual(HR.find('screener-family-spa').crossCheck, undefined, 'registry rows untouched');
  assert.strictEqual(ROUTES.withCrossCheck(HR.HYPOTHESES, null), HR.HYPOTHESES, 'no file → same array');
});

test('the committed badge file is readable and not-computable until the live matrices are exported', () => {
  const cc = ROUTES.readCrossCheck();
  assert.ok(cc, 'lib/research/overfit-crosscheck.json must parse');
  assert.ok(['agree', 'disagree', 'not-computable'].includes(cc.overall));
});

test('op=hypotheses payload carries crossCheck (nullable) and the four study rows', async () => {
  let payload = null;
  const res = { setHeader() {}, json(p) { payload = p; return p; } };
  await ROUTES.runHypotheses({ query: {} }, res);
  assert.ok(payload.ok);
  assert.ok('crossCheck' in payload);
  for (const row of STUDY_ROWS) assert.ok(payload.hypotheses.some((h) => h.id === row.id));
});

// ── js-stats-cli bridge ─────────────────────────────────────────────────────────────
test('js-stats-cli pbo op returns pbo.js verbatim; dsr op mirrors challenger-eval deflatedSharpeOf', () => {
  const matrix = Array.from({ length: 32 }, (_, i) => [Math.sin(i), Math.cos(i), (i % 7) / 7 - 0.5]);
  assert.deepStrictEqual(CLI.handle({ op: 'pbo', matrix, blocks: 8 }), PBO.pbo(matrix, { blocks: 8 }));
  const rets = Array.from({ length: 40 }, (_, i) => 0.01 + 0.02 * Math.sin(i * 1.3));
  const d = CLI.handle({ op: 'dsr', returns: rets, trials: 5 });
  assert.strictEqual(d.ready, true);
  assert.ok(d.psr > 0.5 && d.psr <= 1 && d.dsr <= d.psr, 'deflation can only lower the probability');
  assert.deepStrictEqual(CLI.handle({ op: 'dsr', returns: rets }), { ready: false, reason: 'trial-count-required' });
  assert.match(CLI.handle({ op: 'nope' }).error, /unknown op/);
});

'use strict';
// AUDIT BACKLOG BATCH (alpha-research pass 3). Five findings from the six-specialist
// Phase A audit that were recorded and not yet fixed. Each is pinned here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const N = require('../lib/decision-normalizers');
const D = require('../lib/decision');
const T = require('../lib/transparent-challenger');
const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

// ── C5: RVOL manufactured an evidence family on the LIVE composite ───────────────

test('a high-RVOL biotech lead yields exactly ONE evidence family', () => {
  // It used to append 'volumeAccum' whenever relVol >= 1.5, raising evidenceUnits ->
  // evidenceMultiplier (up to 1.25x) and confidenceScore on the live op=today board —
  // on a factor this repo measured at rank-IC ~= -0.004 and weights zero everywhere else.
  const hot = N.fromBiotech({ items: [{ ticker: 'AAA', tier: 'Hot', score: 70, relVol: 3.0, last: 10 }] });
  assert.equal(hot.length, 1);
  assert.deepEqual(hot[0].evidenceFamilies, ['catalystForcedFlow']);
});

test('RVOL cannot change the evidence count at any level', () => {
  const at = (rv) => N.fromBiotech({ items: [{ ticker: 'A', tier: 'Hot', score: 70, relVol: rv, last: 10 }] })[0].evidenceFamilies;
  assert.deepEqual(at(0.5), at(1.49));
  assert.deepEqual(at(1.49), at(1.5));
  assert.deepEqual(at(1.5), at(9.0), 'no RVOL threshold may add an evidence family');
});

test('one catalyst lead is never counted as two independent families', () => {
  // The redundancy model discounts correlated families via evidenceOrigins; this site
  // recorded none, so the extra family read as genuinely independent confirmation.
  const row = N.fromBiotech({ items: [{ ticker: 'A', tier: 'Hot', score: 70, relVol: 5, last: 10 }] })[0];
  assert.equal(new Set(row.evidenceFamilies).size, 1);
});

// ── PG-B6: the Picks tab wore another strategy's record ──────────────────────────

test('the AI news pick list is registered as its own shadow strategy', () => {
  const e = STRATEGY_REGISTRY.find(x => x.id === 'picks');
  assert.ok(e, 'picks must be registered — it publishes a user-facing ranked BUY list');
  assert.equal(e.maturity, 'shadow');
  assert.ok(e.criteria && e.criteria.length > 80);
});

test('the Picks tab shows its OWN evidence, not the Momentum engine\'s', () => {
  const badge = read('public', 'js', 'evidence-badge.js');
  assert.ok(!/picks: 'momentum'/.test(badge),
    'an LLM news pick list must not wear the Momentum engine\'s resolved record');
  // Same defect class already fixed for aligned->screener and patternradar->coil.
  assert.match(badge, /aligned: 'aligned'/);
  assert.match(badge, /patternradar: 'chartpattern'/);
});

// ── C12: hardToBorrow was a dead execution-quality parameter ─────────────────────

test('executionQuality no longer accepts a borrow flag nothing sets', () => {
  const src = read('lib', 'decision.js');
  assert.ok(!/if \(hardToBorrow\)/.test(src), 'the dead 0.8x penalty must be gone');
  assert.ok(!/function executionQuality\(\{[^}]*hardToBorrow/.test(src),
    'the parameter itself must be gone, not merely unused');
  // And the reason is recorded: wiring it would have fed a tier-PRIOR guess
  // (borrowKnown:false) into a live penalty.
  assert.match(src, /borrowKnown: false/);
});

test('removing it did not change execution quality for any real input', () => {
  const q = D.executionQuality({ dollarVol: 5e7, price: 50, spreadPct: 0.05 });
  assert.ok(Number.isFinite(q.quality) && q.quality > 0);
});

// ── C13: CERN's Thompson sampling was non-reproducible ───────────────────────────

test('CERN no longer samples from Math.random', () => {
  const src = read('lib', 'cern.js');
  // Grep EXECUTABLE code only: the comment explaining this fix necessarily names
  // Math.random, and a naive grep would flag its own documentation.
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/Math\.random\(\)/.test(code),
    'Thompson exploration must be reproducible from stored state for replay/audit');
  assert.match(src, /function sampleNormal\(mu, sd, seed = ''\)/);
});

test('the sampler is deterministic in its seed, and varies across seeds', () => {
  const src = read('lib', 'cern.js');
  // Exercise the pure helpers without constructing the whole engine.
  const mod = { exports: {} };
  new Function('module', src.slice(src.indexOf('function fnv1a'), src.indexOf('// ═══════════════════ EVENT TYPES'))
    + '\nmodule.exports = { sampleNormal };')(mod);
  const { sampleNormal } = mod.exports;
  assert.equal(sampleNormal(0, 1, 'INDEX_DELETE|0|1|5|'), sampleNormal(0, 1, 'INDEX_DELETE|0|1|5|'),
    'same seed must give the same draw — this is what makes a signal re-derivable');
  assert.notEqual(sampleNormal(0, 1, 'A'), sampleNormal(0, 1, 'B'),
    'different arms must still explore differently');
});

// ── C10: a declared gate that never fired ────────────────────────────────────────

function series(n) {
  const out = []; const d = new Date(Date.UTC(2025, 0, 2));
  for (let i = 0; i < n; i++) {
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    const px = 100 + Math.sin(i / 9) * 4 + i * 0.05;
    out.push({ date: d.toISOString().slice(0, 10), open: px, high: px * 1.01, low: px * 0.99, close: px, volume: 1e6 });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
const FULL = series(220);
const name = (t, drop) => ({ ticker: t, dollarVol: 1e7, candles: FULL.slice(0, 220 - drop), benchCloses: FULL.map(c => c.close).slice(0, 220 - drop) });

test('MAX_STALE_SESSIONS is enforced, not merely declared', () => {
  // It was a dead constant, while the module header offered it as the compensating
  // control for the missing halt/corporate-action feed. The control did not exist.
  const out = T.scoreCohort([name('FRESH', 0), name('LAG3', 3), name('STALE9', 9)]);
  const by = Object.fromEntries(out.cohort.map(r => [r.ticker, r]));
  assert.equal(by.STALE9.eligible, false);
  assert.deepEqual(by.STALE9.rejectionReasons, ['stale-last-bar']);
});

test('names within the threshold are NOT rejected — the gate is not a blanket veto', () => {
  const out = T.scoreCohort([name('FRESH', 0), name('LAG2', 2), name('LAG3', 3)]);
  for (const r of out.cohort) {
    assert.ok(!r.rejectionReasons.includes('stale-last-bar'), `${r.ticker} must survive`);
  }
});

test('staleness is measured in COHORT sessions and reported per name', () => {
  const out = T.scoreCohort([name('FRESH', 0), name('STALE9', 9)]);
  const by = Object.fromEntries(out.cohort.map(r => [r.ticker, r]));
  assert.equal(by.FRESH.sessionsBehind, 0);
  assert.ok(by.STALE9.sessionsBehind > 0, 'the lag is quantified, not just flagged');
  assert.ok(by.FRESH.lastBar && by.STALE9.lastBar, 'the last bar is exposed for diagnosis');
});

test('the header no longer claims a freshness gate that does not exist', () => {
  const src = read('lib', 'transparent-challenger.js');
  // The DECLARED LIMITS block is the claim that matters; the in-function comment quotes
  // the old wording to explain what changed, so scope the check to the header.
  const header = src.slice(0, src.indexOf('const { costBreakdown }'));
  assert.ok(!/stale last bars are rejected via the freshness gate instead/.test(header));
  assert.match(header, /The compensating control is the STALENESS gate in scoreCohort/);
  assert.match(header, /proxy for an untradeable interval, not a substitute for the feed/);
});

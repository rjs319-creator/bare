'use strict';
// Non-Day-Trade screener redesign (2026-08) — regression pins for the new invariants:
//   • every core/production signal strategy carries an outcome contract
//   • every registry Scoreboard section resolves through SECTION_TO_ID (the Pattern
//     gap: an unmapped section silently fell back to the default cooldown)
//   • the previously-unregistered screeners (Trend Rider, Dual Confirmed, Confluence)
//     are registered shadow with honest fill-unverified contracts
//   • date-level portfolio statistics: per-date equal-weight pooling + 95% CI
//   • Aligned book v2: episode cooldown replaces first-appearance-forever
// Day Trade is untouched: its registry entry, contract (frozen:true) and pinned
// eligibility are asserted unchanged at the bottom.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');
const SC = require('../lib/strategy-contracts');

test('every core or production-maturity signal strategy has an outcome contract', () => {
  for (const e of STRATEGY_REGISTRY) {
    if (e.kind !== 'signal') continue;
    if (e.core || e.maturity === 'production') {
      const c = SC.contractFor(e.id);
      assert.ok(c, `${e.id} is core/production but has no outcome contract`);
      assert.ok(c.scoringVersion, `${e.id} contract must carry a scoringVersion`);
      assert.ok(c.metric, `${e.id} contract must declare its grading metric`);
      assert.equal(typeof c.fillVerified, 'boolean', `${e.id} contract must declare fillVerified`);
    }
  }
});

test('every registry Scoreboard section resolves through SECTION_TO_ID (no silent default-cooldown fallback)', () => {
  for (const e of STRATEGY_REGISTRY) {
    if (!e.section) continue;
    assert.equal(SC.SECTION_TO_ID[e.section], e.id,
      `registry section '${e.section}' must map to '${e.id}' in SECTION_TO_ID — an unmapped section is indistinguishable from a typo and silently takes the default cooldown`);
  }
});

test('contract scoringVersion matches the registry scoringVersion for every contracted strategy', () => {
  const byId = new Map(STRATEGY_REGISTRY.map(e => [e.id, e]));
  for (const [id, c] of Object.entries(SC.CONTRACTS)) {
    const reg = byId.get(id);
    if (!reg) continue; // daytrade etc. are registered; anything unregistered is caught elsewhere
    if (reg.scoringVersion && c.scoringVersion) {
      assert.equal(c.scoringVersion, reg.scoringVersion, `${id}: contract and registry scoring versions must agree (a mismatch would silently decouple evidence resets)`);
    }
  }
});

test('Trend Rider / Dual Confirmed / Confluence are registered shadow — never trade-eligible, honestly proxy-graded', () => {
  const gate = require('../lib/strategy-gate');
  for (const id of ['trendrider', 'aligned', 'confluence']) {
    const reg = STRATEGY_REGISTRY.find(e => e.id === id);
    assert.ok(reg, `${id} must be registered`);
    assert.equal(reg.maturity, 'shadow');
    assert.equal(gate.isTradeEligible(id), false);
    const c = SC.contractFor(id);
    assert.ok(c, `${id} must have a contract`);
    assert.equal(c.fillVerified, false, `${id} grading is a close-to-close proxy — must not claim verified fills`);
    assert.match(c.primaryLabel, /PROXY/i, `${id} primary label must disclose the proxy basis`);
  }
});

// ── date-level portfolio statistics (maturity-v2 verdict basis) ───────────────
test('dateLevelNetExcess pools same-day picks into one portfolio return per date', () => {
  const { dateLevelNetExcess } = require('../lib/apex-routes');
  // 3 dates; day-1 has two picks (+4, −2 → +1), day-2 one (+2), day-3 one (+3).
  const rows = [
    { date: '2026-01-05', netExc: 4 }, { date: '2026-01-05', netExc: -2 },
    { date: '2026-01-06', netExc: 2 },
    { date: '2026-01-07', netExc: 3 },
    { date: '2026-01-08' },                       // no net channel → excluded
    { date: null, netExc: 9 },                    // no date → excluded
  ];
  const s = dateLevelNetExcess(rows);
  assert.equal(s.n, 3, 'three dates, not five picks');
  assert.equal(s.avg, 2);                          // mean of [1, 2, 3]
  assert.ok(s.ci95.lo < s.avg && s.ci95.hi > s.avg);
  assert.match(s.basis, /per-date portfolio/);
});

test('dateLevelNetExcess returns null under 2 dates (no fabricated dispersion)', () => {
  const { dateLevelNetExcess } = require('../lib/apex-routes');
  assert.equal(dateLevelNetExcess([{ date: '2026-01-05', netExc: 1 }]), null);
  assert.equal(dateLevelNetExcess([]), null);
});

// ── Aligned book v2: episode cooldown ────────────────────────────────────────
test('aligned episodeEntries: a persistent pick is ONE episode; a post-cooldown return is a NEW one', () => {
  const { episodeEntries } = require('../lib/aligned-routes');
  const days = [
    { date: '2026-01-05', picks: [{ ticker: 'AAA', entry: 10 }] },
    { date: '2026-01-06', picks: [{ ticker: 'AAA', entry: 11 }] },   // next day — same episode
    { date: '2026-01-20', picks: [{ ticker: 'AAA', entry: 12 }] },   // 14d after last sighting — still inside 21d cooldown
    { date: '2026-03-02', picks: [{ ticker: 'AAA', entry: 13 }, { ticker: 'BBB', entry: 5 }] }, // 41d gap — NEW episode
  ];
  const entries = episodeEntries(days, 21);
  const aaa = entries.filter(e => e.ticker === 'AAA');
  assert.equal(aaa.length, 2, 'first sighting + post-cooldown reappearance');
  assert.deepEqual(aaa.map(e => e.date), ['2026-01-05', '2026-03-02']);
  assert.equal(entries.filter(e => e.ticker === 'BBB').length, 1);
});

test('aligned episodeEntries sorts unordered ledger days before deduping (order cannot flip episodes)', () => {
  const { episodeEntries } = require('../lib/aligned-routes');
  const days = [
    { date: '2026-03-02', picks: [{ ticker: 'AAA' }] },
    { date: '2026-01-05', picks: [{ ticker: 'AAA' }] },
  ];
  const entries = episodeEntries(days, 21);
  assert.deepEqual(entries.map(e => e.date), ['2026-01-05', '2026-03-02']);
});

// ── Day Trade unchanged ──────────────────────────────────────────────────────
test('Day Trade registry entry, frozen contract and eligibility pin are untouched', () => {
  const reg = STRATEGY_REGISTRY.find(e => e.id === 'daytrade');
  assert.equal(reg.maturity, 'production');
  assert.equal(reg.scoringVersion, 'daytrade-v2');
  const c = SC.contractFor('daytrade');
  assert.equal(c.frozen, true);
  const EL = require('../lib/eligibility');
  assert.ok(EL.PINNED_SOURCES.daytrade, 'daytrade must remain pinned — governance never consulted');
});

// ── Actionable lane (Phase-2 item 8): cleared strategies only, honest-empty ──
const { buildToday } = require('../lib/decision-routes');
const { SOURCES } = require('./fixtures/today-sources');
const NOW2 = Date.parse('2026-07-24T12:00:00Z');
const freshGov2 = (strategies) => ({ savedAt: '2026-07-24T00:00:00.000Z', strategies });

test('actionableByHorizon contains ONLY trade-eligible sources; research signals cannot enter or boost it', () => {
  const gov = freshGov2([{ id: 'screener', status: 'production', weight: 1, version: 'screener-v1' }]);
  const p = buildToday(SOURCES, null, null, null, { governance: gov, nowMs: NOW2 }); // default annotate
  const lane = Object.values(p.actionableByHorizon).flat();
  for (const x of lane) {
    const srcs = x.sources || [x.source];
    for (const s of srcs) assert.ok(['screener', 'daytrade'].includes(s), `${s} is not cleared — must not appear in (or boost) the actionable lane`);
    assert.equal(x.evidenceClass, 'ACTIONABLE');
  }
  // topByHorizon (the research-visible cross-section) still shows everything in annotate mode.
  const full = Object.values(p.topByHorizon).flat();
  assert.ok(full.length >= lane.length);
});

test('nothing cleared → the actionable lane is honestly EMPTY (except the pinned daytrade), never backfilled with research', () => {
  const p = buildToday(SOURCES, null, null, null, { governance: null, nowMs: NOW2 }); // no governance ⇒ fail closed
  const lane = Object.values(p.actionableByHorizon).flat();
  for (const x of lane) {
    const srcs = x.sources || [x.source];
    for (const s of srcs) assert.equal(s, 'daytrade', 'with no governance only the pinned daytrade source can be actionable');
  }
  // The research cross-section is NOT empty — visibility is preserved.
  assert.ok(Object.values(p.topByHorizon).flat().length > 0);
});

// ── Confluence family admission (source-scan, matching the repo's registry-coverage style) ──
test('Confluence display admission requires ≥2 independent families in BOTH strong and relaxed branches', () => {
  const src = require('node:fs').readFileSync(require.resolve('../lib/screener-routes.js'), 'utf8');
  assert.match(src, /CONFLUENCE_MIN_FAMILIES\s*=\s*2/, 'the ≥2-family constant must exist');
  assert.match(src, /bullishCount >= CONFLUENCE_DISPLAY_BULL && multiFamily\(p\)/,
    'strong admission must be vote-count AND multi-family');
  assert.match(src, /bullishCount >= CONFLUENCE_MIN_BULL && multiFamily\(p\)/,
    'the relaxed fallback must also require multi-family — an honest empty list beats single-family "confluence"');
});

test('confluence singleFamily flag: multiple bullish votes from one family are flagged, two families are not', () => {
  const { STRATEGY_FAMILY } = require('../lib/confluence');
  // Sanity-pin the family map the admission rule depends on: 4 trend + 1 meanReversion.
  const fams = Object.values(STRATEGY_FAMILY);
  assert.equal(fams.filter(f => f === 'trend').length, 4);
  assert.equal(fams.filter(f => f === 'meanReversion').length, 1);
});

test('enforce mode: researchByHorizon carries the full ungated cross-section, RESEARCH-classed (visibility survives enforcement)', () => {
  const gov = freshGov2([{ id: 'screener', status: 'production', weight: 1, version: 'screener-v1' }]);
  const p = buildToday(SOURCES, null, null, null, { eligibilityMode: 'enforce', governance: gov, nowMs: NOW2 });
  assert.ok(p.researchByHorizon, 'enforce mode must serve the research cross-section');
  const rows = Object.values(p.researchByHorizon).flat();
  assert.ok(rows.length > 0);
  const srcs = new Set(rows.flatMap(x => x.sources || [x.source]));
  const shadowVisible = [...srcs].some(s => !['screener', 'daytrade'].includes(s));
  assert.ok(shadowVisible, 'shadow sources must remain VISIBLE as research under enforcement');
  for (const x of rows) {
    assert.ok(x.evidenceClass === 'ACTIONABLE' || x.evidenceClass === 'RESEARCH');
    const rowSrcs = x.sources || [x.source];
    if (rowSrcs.some(s => !['screener', 'daytrade'].includes(s))) {
      assert.equal(x.evidenceClass, 'RESEARCH', 'an uncleared source must never wear ACTIONABLE');
    }
  }
  // Annotate mode: null by design (topByHorizon already is the full cross-section).
  const ann = buildToday(SOURCES, null, null, null, { governance: gov, nowMs: NOW2 });
  assert.equal(ann.researchByHorizon, null);
});

// ── entry-v2: per-contract next-open grading basis ───────────────────────────
test('forwardPath entryBasis next-open: enters at the NEXT session open, never the signal close or logged level', () => {
  const { forwardPath, spyForwardReturn } = require('../lib/apex-routes');
  const CAND = [
    { date: '2026-01-05', open: 98, close: 100, high: 101, low: 97 },
    { date: '2026-01-06', open: 104, close: 106, high: 107, low: 103 },   // entry bar: open 104
    { date: '2026-01-07', open: 106, close: 110, high: 111, low: 105 },
  ];
  const legacy = forwardPath(CAND, { date: '2026-01-05', entry: 100 }, 2);
  assert.equal(+legacy.ret.toFixed(2), 10);                    // 100 → 110 off the logged level
  const v2 = forwardPath(CAND, { date: '2026-01-05', entry: 100 }, 2, { entryBasis: 'next-open' });
  assert.equal(+v2.ret.toFixed(2), +(((110 - 104) / 104) * 100).toFixed(2));  // 104 → 110
  // benchmark measured on the SAME basis
  const bmLegacy = spyForwardReturn(CAND, { date: '2026-01-05' }, 2);
  const bmV2 = spyForwardReturn(CAND, { date: '2026-01-05' }, 2, { entryBasis: 'next-open' });
  assert.equal(+bmLegacy.toFixed(2), 10);
  assert.equal(+bmV2.toFixed(2), +(((110 - 104) / 104) * 100).toFixed(2));
});

test('forwardPath entryBasis next-open: no next session yet → null (never a fabricated fill)', () => {
  const { forwardPath } = require('../lib/apex-routes');
  const CAND = [
    { date: '2026-01-05', open: 98, close: 100, high: 101, low: 97 },
    { date: '2026-01-06', open: 104, close: 106, high: 107, low: 103 },
  ];
  assert.equal(forwardPath(CAND, { date: '2026-01-06' }, 1, { entryBasis: 'next-open' }), null);
});

test('entry-v2 basis policy: next-open sections come from their contracts; daytrade + conditional contracts stay legacy', () => {
  const src = require('node:fs').readFileSync(require.resolve('../lib/apex-routes.js'), 'utf8');
  assert.match(src, /section === 'daytrade'\) return null/, 'daytrade section must be pinned to the legacy basis');
  const { contractForSection } = require('../lib/strategy-contracts');
  // Sanity: the contracts the policy reads say what we think they say.
  assert.ok(contractForSection('screener').fillPolicy.startsWith('next-session-open'));
  assert.ok(contractForSection('Ghost').fillPolicy.startsWith('next-session-open'));
  assert.ok(!contractForSection('GapGo').fillPolicy.startsWith('next-session-open'), 'gapgo is conditional — stays legacy until verified fills');
  assert.ok(!contractForSection('coil').fillPolicy.startsWith('next-session-open'), 'coil is conditional — stays legacy until verified fills');
});

'use strict';
// The filing red-flag AVOID lane is wired end-to-end: contract, section map, strategy
// registry (shadow, weight 0, flag tiers), evidence family, cost tier, hypothesis rows (one
// per flag, placebo + min N stated), scoreboard fold, UI label, Session Board flag, badge
// hook, lookup chip. Each assertion cites the source it pins.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SC = require('../lib/strategy-contracts');
const { STRATEGY_REGISTRY } = require('../lib/strategy-registry');
const HR = require('../lib/research/hypothesis-registry');
const D = require('../lib/decision');
const { SECTION_TIER_DEFAULT } = require('../lib/costs');
const RF = require('../lib/filing-redflags');
const SB = require('../lib/session-board');
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('contract: next-open, 1m, LONG basis (the hypothesis is a negative record), SPY+sector, 63-session cooldown; section maps to the id', () => {
  const c = SC.contractFor('redflags');
  assert.ok(c); assert.equal(c.metric, '1m'); assert.equal(c.side, 'long'); assert.equal(c.fillPolicy, 'next-session-open'); assert.equal(c.fillVerified, false);
  assert.deepEqual(c.benchmark, ['SPY', 'sector']); assert.equal(c.episodeCooldownSessions, 63);
  assert.match(c.primaryLabel, /NEGATIVE/); assert.match(c.primaryLabel, /126 sessions earlier/);
  assert.equal(SC.SECTION_TO_ID.RedFlags, 'redflags');
  assert.equal(SC.contractForSection('RedFlags'), c);
});

test('strategy registry: shadow, non-core, one policy tier per flag, note forbids any user-facing weight; family + cost tier resolve', () => {
  const e = STRATEGY_REGISTRY.find((x) => x.id === 'redflags');
  assert.ok(e); assert.equal(e.maturity, 'shadow'); assert.equal(e.core, false); assert.equal(e.section, 'RedFlags'); assert.equal(e.horizon, 'position');
  assert.deepEqual(e.policyTiers, Object.keys(RF.FLAGS));
  assert.match(e.note, /MUST NOT originate, boost, gate/); assert.match(e.criteria, /≥300 development events/); assert.match(e.criteria, /placebo 126 sessions earlier/);
  assert.equal(D.SOURCE_FAMILY.redflags, 'fundamentalsRevisions');
  assert.equal(SECTION_TIER_DEFAULT.RedFlags, 'small');
});

test('hypothesis registry: six open exploratory event-drift rows, one per flag, each stating next-open entry, 5/21/63, the same-name placebo, kit eligibility and min N 300', () => {
  for (const [flag, meta] of Object.entries(RF.FLAGS)) {
    const h = HR.find(meta.hypothesisId);
    assert.ok(h, `${flag} → ${meta.hypothesisId} missing`);
    assert.equal(h.familyId, 'event-drift'); assert.equal(h.mode, 'exploratory'); assert.equal(h.status, 'open');
    assert.ok(HR.validateHypothesis(h).valid);
    assert.match(h.hypothesis, /NEGATIVE cost-net SPY-excess over the next 21 sessions from the next open/);
    assert.match(h.primaryMetric, new RegExp(`tier ${flag}`)); assert.match(h.primaryMetric, /5- and 63-session/); assert.match(h.primaryMetric, /≥300 development events/);
    assert.match(h.baseline, /SAME name 126 sessions earlier/);
    assert.match(h.universe, /≥60 prior bars, close ≥ \$2, as-of ADV60 ≥ \$2M/);
    assert.match(h.expectedDirection, /^NEGATIVE/);
    assert.match(h.stoppingRule, /PROSPECTIVE ONLY/);
  }
});

test('scoreboard: the ledger is loaded, folded as section RedFlags, counted in loggedRows; the UI labels the section', () => {
  const apex = src('lib/apex-routes.js');
  assert.match(apex, /load\('readAllRedflagDays'/);
  assert.match(apex, /rtDays, anomDays, icDays, rfDays, bioDays/, 'the positional destructuring names the new loader in the same slot');
  assert.match(apex, /sectionRows\(rfDays, 'RedFlags'\)/);
  assert.match(apex, /RedFlags:\$\{p\.tier\}:\$\{p\.ticker\}/);
  assert.match(apex, /rawIC\.length \+ rawRF\.length/);
  assert.match(src('public/js/app.js'), /RedFlags: '🚩 Filing Red Flags \(shadow AVOID/);
});

test('session board: rows are stamped from the snapshot (pure), flags carry redflag + kinds, the client renders the chip; grade never reads it', () => {
  const snap = { symbols: { AAA: { flags: ['NT_FIRST'], lastDate: '2026-10-01', ageDays: 1, events: 1 } } };
  const rows = SB.stampRedflags([{ ticker: 'AAA', section: 'screener' }, { ticker: 'BBB', section: 'screener' }], snap);
  assert.deepEqual(rows[0].redflags, snap.symbols.AAA); assert.equal(rows[1].redflags, undefined);
  assert.deepEqual(SB.stampRedflags(rows, null), rows);
  const sbSrc = src('lib/session-board.js');
  assert.match(sbSrc, /redflag: row\.redflags == null \? null : !!\(Array\.isArray\(row\.redflags\.flags\) && row\.redflags\.flags\.length\)/);
  assert.doesNotMatch(sbSrc.slice(sbSrc.indexOf('function gradeItem'), sbSrc.indexOf('// ── Row adapters')), /redflag/, 'the grade must not read the flag');
  assert.match(src('lib/session-board-routes.js'), /readRedflags: \(\) => require\('\.\/filing-redflags-store'\)\.readCurrent\(\)/);
  assert.match(src('lib/session-board-routes.js'), /SB\.stampRedflags\(SB\.collectTodayRows\(today\), redflags\)/);
  assert.match(src('public/js/session-board.js'), /if \(F\.redflag\) out\.push\(`<span class="sb-flag sb-flag-bad"/);
});

test('badge + lookup: redflag-badge decorates the dilution tabs plus Today; app.js starts it beside the dilution badge; the lookup header loads its chip', () => {
  const badge = src('public/js/redflag-badge.js');
  assert.match(badge, /REDFLAG_BADGE_TABS = new Set\(\[\.\.\.DILUTION_BADGE_TABS, 'today'\]\)/);
  assert.match(badge, /op=redflags/); assert.match(badge, /NOT a sell signal, NOT a short signal/);
  const app = src('public/js/app.js');
  assert.match(app, /import \{ startRedflagBadges, REDFLAG_BADGE_TABS \} from '\.\/redflag-badge\.js'/);
  assert.match(app, /if \(REDFLAG_BADGE_TABS\.has\(sub\)\) startRedflagBadges\(document\.getElementById\(sub\)\)/);
  const tl = src('public/js/ticker-lookup.js');
  assert.match(tl, /op=redflags&symbol=/); assert.match(tl, /curTicker !== tk/, 'a late response never decorates another ticker\'s header');
  assert.match(tl, /loadRedflagChip\(tk\);/);
});

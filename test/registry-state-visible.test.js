'use strict';
// REGISTRY STATE MUST REACH THE SURFACE (alpha-research pass 3).
//
// The 2026-08-11 ghost/downday demotion took effect in the GATE (isTradeEligible) while
// every tab kept presenting them exactly as before: public/js/evidence-badge.js mapped
// only `d.strategies` (the earned GRADE) and discarded `d.governance.strategies` (the
// STATE — status, weight, newPositions). A governance decision the user cannot see is
// not a control.
//
// Same root cause, two other P0 symptoms pinned here: momentum (registry `shadow`) fired
// a push notification reading "⚡ STRONG BUY", and the Fade tab published a sized short
// plan calling itself "the validated trade".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const APP = read('public', 'js', 'app.js');
const BADGE = read('public', 'js', 'evidence-badge.js');

// Load the pure wording rules the same way test/evidence-badge.test.js does.
function loadBadge() {
  const src = BADGE.replace(/^import .*$/gm, '').replace(/^export /gm, '');
  const factory = new Function('esc', 'fetchJSON', 'OPTIONAL_TIMEOUT_MS', 'module',
    `${src}\nmodule.exports = { verdictFor, verdictBannerHTML };`);
  const mod = { exports: {} };
  factory(x => String(x), async () => null, 0, mod);
  return mod.exports;
}

const withGov = (grade, status, weight) => ({
  id: 's', grade, stats: { excessN: 60, avgExcess: 1.1, beatMktRate: 55 },
  governance: { id: 's', status, weight },
});

// ── the shared mechanism ─────────────────────────────────────────────────────────

test('the grade table carries governance state, not just the earned grade', () => {
  assert.match(BADGE, /d\.governance && d\.governance\.strategies/,
    'loadGrades must map governance alongside strategies or no surface can see state');
});

test('a weight-0 strategy is labelled SHADOW and marked not-sized', () => {
  const { verdictFor } = loadBadge();
  const v = verdictFor(withGov('promising', 'paper', 0));
  assert.equal(v.sizable, false);
  assert.equal(v.stateLabel, 'SHADOW');
  assert.match(v.stateNote, /Not sized/);
});

test('a cleared strategy is labelled CLEARED and keeps its sizing advice', () => {
  const { verdictFor } = loadBadge();
  const v = verdictFor(withGov('validated', 'production', 1));
  assert.equal(v.sizable, true);
  assert.equal(v.stateLabel, 'CLEARED');
  assert.equal(v.stateNote, null);
  assert.match(v.advice, /size positions/i);
});

test('a validated-but-unsized strategy is NEVER told to size a position', () => {
  // The specific harm: "Its record holds up... Still size positions" rendered for a
  // strategy the app funds with nothing.
  const { verdictFor } = loadBadge();
  const v = verdictFor(withGov('validated', 'paper', 0));
  assert.ok(!/size positions/i.test(v.advice), 'sizing instruction must not survive weight 0');
  assert.match(v.advice, /ZERO weight/);
});

test('a missing governance record fails closed to unsized', () => {
  const { verdictFor } = loadBadge();
  const v = verdictFor({ id: 's', grade: 'validated', stats: { excessN: 60, avgExcess: 1.1, beatMktRate: 55 } });
  assert.equal(v.sizable, false, 'no governance record cannot mean "cleared"');
});

test('sharper grade-specific warnings survive — the state chip adds, it does not flatten', () => {
  // "it has not earned your money" says more than any generic research disclaimer, so
  // the disabled/informational/experimental lines are kept rather than replaced.
  const { verdictFor } = loadBadge();
  assert.match(verdictFor(withGov('disabled', 'paper', 0)).advice, /has not earned your money/);
  assert.match(verdictFor(withGov('informational', 'paper', 0)).advice, /not to pick a trade/);
});

test('the banner renders the state chip and a sizable data attribute', () => {
  const { verdictBannerHTML } = loadBadge();
  const html = verdictBannerHTML(withGov('promising', 'paper', 0));
  assert.match(html, /ev-state-chip/);
  assert.match(html, /ev-state-unsized/);
  assert.match(html, /data-sizable="0"/);
  assert.match(verdictBannerHTML(withGov('validated', 'production', 1)), /data-sizable="1"/);
});

test('the state chip is not rendered in the low-contrast honesty tokens', () => {
  // The app's --text-muted measures ~1.4:1 against the page background, and every
  // caveat in the UI uses it. A "carries no capital" disclosure must not be the least
  // legible text on the card.
  const css = read('public', 'css', 'app.css');
  const chip = css.slice(css.indexOf('.ev-state-chip'), css.indexOf('.ev-state-chip') + 600);
  assert.ok(!/var\(--text-muted\)/.test(chip), 'the state chip must not use the muted token');
  assert.match(chip, /color: #f2c94c/);
});

// ── momentum: a shadow strategy must not issue a buy imperative ───────────────────

test('op=momentum publishes its registry state', () => {
  const src = read('api', 'momentum.js');
  assert.match(src, /maturity: require\('\.\.\/lib\/strategy-gate'\)\.statusOf\('momentum'\)/);
  assert.match(src, /tradeEligible: require\('\.\.\/lib\/strategy-gate'\)\.isTradeEligible\('momentum'\)/);
});

test('the momentum action badge drops its imperative when the strategy is not cleared', () => {
  assert.ok(!/\$\{buy \? 'STRONG BUY' : 'STRONG SELL'\}/.test(APP),
    'the unconditional STRONG BUY badge must not return');
  assert.match(APP, /const momActionLabel = \(buy\) => \(momTradeEligible/);
  assert.match(APP, /RESEARCH · strong up-momentum/);
});

test('momentum trade-eligibility fails closed in the client', () => {
  // An older cached payload without the field must not shout STRONG BUY.
  assert.match(APP, /let momTradeEligible = false;/);
  assert.match(APP, /momTradeEligible = data\.tradeEligible === true;/);
});

test('the push notification is suppressed entirely for an uncleared strategy', () => {
  // Not reworded — suppressed. An unsolicited phone alert with haptics about a weight-0
  // research signal has no honest form.
  const fn = APP.slice(APP.indexOf('async function showFlipNotification'), APP.indexOf('async function showFlipNotification') + 700);
  assert.match(fn, /if \(!momTradeEligible\) return;/);
  // and the guard must precede the notification build
  assert.ok(fn.indexOf('if (!momTradeEligible) return;') < fn.indexOf('const title'),
    'the guard must run before the notification is constructed');
});

// ── fade: no sized short plan for an AVOID-only, borrow-blocked strategy ──────────

test('the Fade tab no longer publishes a position size or claims validation', () => {
  assert.ok(!/Suggested weight \$\{r\.sizePct\}%/.test(APP), 'a weight-0 strategy must not suggest a position size');
  assert.ok(!/the validated trade is the timed hold/.test(APP), 'nothing on this tab is validated');
  assert.match(APP, /RESEARCH — not sized, not a short recommendation/);
  assert.match(APP, /no borrow\/locate feed exists/);
});

// ── apex: a weight-0 sleeve must not publish share counts or dollar allocations ───

test('the Apex portfolio panel reads governance clearance rather than assuming it', () => {
  // Gated on the registry, not hardcoded — a future promotion restores sizing without
  // a code edit, and a wording change can never grant it.
  assert.match(APP, /let apexTradeEligible = false;/, 'must fail closed before the fetch resolves');
  assert.match(APP, /g\.status === 'production' && Number\(g\.weight\) > 0/);
  assert.match(APP, /import \{ mountVerdict, loadGrades \} from '\.\/evidence-badge\.js';/);
});

test('share counts and dollar allocations are not computed for an unsized sleeve', () => {
  assert.match(APP, /if \(rps && apexTradeEligible\) \{ shares = Math\.floor/,
    'sizing arithmetic must be gated, not merely hidden');
  assert.match(APP, /const sizeCells = apexTradeEligible/);
  // The columns themselves disappear, so there are no empty Shares/Alloc headers
  // implying a number the app declined to give.
  assert.match(APP, /\$\{apexTradeEligible \? '<th>Shares<\/th><th>Alloc<\/th>' : ''\}/);
});

test('the unsized Apex panel says why, in the repo\'s existing refusal vocabulary', () => {
  assert.match(APP, /RESEARCH — not sized\. Adaptive Momentum carries ZERO governance weight/);
});

test('the Apex tier alert is suppressed, including its buy-coloured card flash', () => {
  const fn = APP.slice(APP.indexOf('async function showApexNotification'), APP.indexOf('async function showApexNotification') + 700);
  assert.match(fn, /if \(!apexTradeEligible\) return;/);
  assert.ok(fn.indexOf('if (!apexTradeEligible) return;') < fn.indexOf("flashCards(ticker, 'STRONG_BUY')"),
    'the guard must precede the flash — a buy-coloured pulse is the same imperative in another medium');
});

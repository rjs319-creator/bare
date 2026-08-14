'use strict';
// FRONTEND STALENESS & FAILURE HONESTY — 2026-08-14 audit fixes, pinned so they can't
// silently regress. Source-scan style (same pattern as ui-claims.test.js): the frontend
// is browser-only, so these tests parse public/js sources with regex and assert the
// honest patterns are present and the dishonest ones stay gone.
//
// The findings pinned here:
//  #2 payload generatedAt stamps must go through stampText() (date+age when not today),
//     never straight through toLocaleTimeString() (a days-old blob rendered "4:02 PM").
//  #1 Today tab: the instant-painted localStorage cache must read its own age, refuse
//     a >24h paint, and show a loud banner when the refresh fails over stale data.
//  #3 Quick Hit: an errored cap-size fetch renders "⚠️ unavailable", never "none today";
//     the "across any cap size" abstention needs every scope to have answered.
//  #4 footer copy may not claim ranking mechanics that don't exist.
//  #5 Day-Trade silent 60s refresh: persistent failure must surface a stale banner.
//  #6 the momentum LIVE badge is earned by a real quote, not hardcoded at build time.
//  #7 today.js renders regime via the guarded `reg` local (no p.regime.label throw).
//  #8 buildReliability uses live scoreboard horizon keys and labels the one it used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const R = f => readFileSync(join(__dirname, '..', 'public', 'js', f), 'utf8');
const APP = R('app.js');
const TODAY = R('today.js');
const QUICKHIT = R('quickhit.js');
const OPPS = R('opportunities.js');

// ── #2: honest generatedAt stamps ───────────────────────────────────────────────

test('app.js never pipes a payload generatedAt straight into toLocaleTimeString', () => {
  // `new Date(<anything>generatedAt<anything>).toLocaleTimeString(...)` = time-of-day
  // only, indistinguishable from fresh when the blob is days old.
  const bad = APP.match(/new Date\([^)]*generatedAt[^)]*\)\s*\.toLocaleTimeString/g);
  assert.equal(bad, null, `generatedAt piped to toLocaleTimeString: ${bad && bad.join(' | ')}`);
  // Same for the ternary form `generatedAt ? new Date(...).toLocaleTimeString`.
  const bad2 = APP.match(/generatedAt\s*\?\s*new Date\([^)]*\)\.toLocaleTimeString/g);
  assert.equal(bad2, null, `ternary generatedAt stamp bypasses stampText: ${bad2 && bad2.join(' | ')}`);
});

test('app.js defines stampText and routes the generation stamps through it', () => {
  assert.match(APP, /function stampText\(ts\)/);
  const uses = (APP.match(/stampText\(/g) || []).length;
  assert.ok(uses >= 20, `expected >=20 stampText call sites (definition + ~21 stamps), found ${uses}`);
});

test('stampText behavior: clock-only for a same-day stamp, date + explicit age for an old one', () => {
  // Extract the helper + its constants from source and evaluate it in isolation —
  // app.js itself touches `document` at module scope so it can't be imported here.
  const consts = APP.match(/const STAMP_MS_PER_HOUR[\s\S]*?const STAMP_NY_DAY = \{[^}]+\};/);
  const fn = APP.match(/function stampText\(ts\) \{[\s\S]*?\n  \}/);
  assert.ok(consts && fn, 'could not extract stampText from app.js source');
  const stampText = new Function(`${consts[0]}\n${fn[0]}\nreturn stampText;`)();
  const fresh = stampText(Date.now());
  assert.match(fresh, /\d{1,2}:\d{2}/, 'same-day stamp should be a clock time');
  assert.ok(!fresh.includes('('), `same-day stamp must not carry an age note: "${fresh}"`);
  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
  const old = stampText(Date.now() - THREE_DAYS_MS - 60 * 1000);
  assert.match(old, /\(3d ago\)/, `3-day-old stamp must say its age: "${old}"`);
  assert.match(old, /[A-Z][a-z]{2} \d{1,2}/, `old stamp must carry the date: "${old}"`);
  assert.equal(stampText(null), '', 'a missing timestamp renders empty, never "Invalid Date"');
  assert.equal(stampText('garbage'), '', 'an unparseable timestamp renders empty');
});

// ── #1 + #7: Today tab cache staleness + regime guard ───────────────────────────

test('today.js instant paint reads the cache age, refuses >24h, and labels >30min', () => {
  assert.match(TODAY, /TODAY_CACHE_MAX_PAINT_MS/, 'a max instant-paint age must exist');
  assert.match(TODAY, /TODAY_CACHE_AGE_NOTE_MS/, 'an age-labeling threshold must exist');
  assert.match(TODAY, /Number\.isFinite\(c\.at\)/, 'the stored `at` stamp must actually be read');
  assert.match(TODAY, /age <= TODAY_CACHE_MAX_PAINT_MS/, 'paint must be gated on cache age');
});

test('today.js refresh failure over a stale board shows a loud banner, not a silent hint removal', () => {
  assert.match(TODAY, /function markRefreshFailed\(/);
  assert.match(TODAY, /Refresh failed — showing data from /, 'the failure banner must state the data age');
  assert.match(TODAY, /markRefreshFailed\(container, cacheAgeText\(cachedAt\)\)/,
    'the failed-refresh branch must render the banner (it used to just drop the refreshing hint)');
});

test('today.js renders regime via the guarded `reg` local (an ok payload without regime must not throw)', () => {
  assert.ok(!/p\.regime\.label/.test(TODAY), 'p.regime.label direct access can throw and kill the whole board');
  assert.match(TODAY, /reg\.label/);
});

test('today.js sector chip cannot render "NaN%"', () => {
  assert.match(TODAY, /Number\.isFinite\(\+s\.changePct\)/, 'changePct must be validated before pct()');
});

// ── #3: Quick Hit fetch failure ≠ honest abstention ─────────────────────────────

test('quickhit.js tracks per-scope fetch errors and renders them as unavailable, not "none today"', () => {
  assert.match(QUICKHIT, /scopeErrors/, 'per-scope errors must be tracked');
  assert.match(QUICKHIT, /⚠️ unavailable/, 'an errored cap tier must read "unavailable"');
  assert.match(QUICKHIT, /scopeErrors\.has\(cap\)/, 'the best-by-cap chip must distinguish error from empty');
});

test('quickhit.js only claims "across any cap size" when every scope actually answered', () => {
  // The blanket abstention copy must sit behind the no-errors branch.
  assert.match(QUICKHIT, /erroredCaps\.length\s*\?[\s\S]{0,400}?across any cap size/,
    'the "across any cap size" copy must be the NO-errors branch of the erroredCaps ternary');
});

// ── #4: footer copy describes actual behavior ───────────────────────────────────

test('footers no longer claim ranking mechanics that do not exist', () => {
  for (const phrase of ["tilted by each Ghost-tier", "dialed by the model's live results", 'results-trained conviction']) {
    assert.ok(!OPPS.includes(phrase), `opportunities.js resurrected dead ranking claim: "${phrase}"`);
  }
  assert.ok(!QUICKHIT.includes('boosted when an AI screener independently agrees'),
    'quickhit.js: AI agreement is badge-only (rank unaffected) — the "boosted" claim may not return');
  assert.match(QUICKHIT, /never moves the rank/, 'quickhit footer must state agreement is annotation-only');
});

// ── #5: Day-Trade silent refresh failure surfaces a stale banner ────────────────

test('app.js daytrade silent refresh counts failures and surfaces a stale banner', () => {
  assert.match(APP, /DT_STALE_AFTER_FAILURES/);
  assert.match(APP, /dt-stale-banner/);
  assert.match(APP, /Live refresh failing since /, 'the banner must state since when the feed is dead');
  assert.match(APP, /dtSilentFailStreak = 0/, 'a successful refresh must clear the failure streak');
});

// ── #6: the LIVE badge is earned, never hardcoded ───────────────────────────────

test('app.js momentum cards build with a neutral EOD badge; LIVE is flipped by a real quote', () => {
  assert.ok(!APP.includes('"alert-live-badge"><div class="alert-live-dot"></div>LIVE'),
    'the pulsing LIVE badge may not be hardcoded into the card template');
  assert.match(APP, /data-live-state="eod"/, 'cards must build in the neutral EOD state');
  assert.match(APP, /function setLiveBadge\(/);
  assert.match(APP, /setLiveBadge\(card, true\)/, 'a landed quote must be what flips the badge to LIVE');
  assert.match(APP, /LIVE_POLL_FAIL_REVERT/, 'persistent poll failure must revert the badge');
});

// ── #8: reliability fallback uses live horizon keys and labels the one used ─────

test('opportunities.js buildReliability uses live scoreboard horizons and oppTrack labels the real one', () => {
  assert.ok(!OPPS.includes("h['1w']"), "scoreboard horizons are 1d/5d/10d/20d/1m/3m — '1w' does not exist");
  assert.match(OPPS, /RELIABILITY_HORIZONS/);
  assert.match(OPPS, /horizon: key/, 'the horizon that supplied the record must be carried');
  assert.match(OPPS, /r\.horizon \? ` \(\$\{r\.horizon\}\)` : ''/,
    'oppTrack must caption the horizon actually used, not a hardcoded "(1m)"');
});

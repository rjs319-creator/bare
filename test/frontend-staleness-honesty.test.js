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
  // 2026-08-15 consolidation: stampText now delegates its age note to the shared
  // timeAgo() in format.js (ROUND buckets, 24h day cutoff — was floor + a clamped
  // "1h ago" minimum), so timeAgo's source is evaluated alongside it.
  const timeAgoFn = R('format.js').match(/export (function timeAgo\(ts\) \{[\s\S]*?\n\})/);
  const consts = APP.match(/const STAMP_MS_PER_DAY[\s\S]*?const STAMP_NY_DAY = \{[^}]+\};/);
  const fn = APP.match(/function stampText\(ts\) \{[\s\S]*?\n  \}/);
  assert.ok(timeAgoFn && consts && fn, 'could not extract timeAgo/stampText from source');
  const stampText = new Function(`${timeAgoFn[1]}\n${consts[0]}\n${fn[0]}\nreturn stampText;`)();
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
  // 2026-08-15 consolidation: the age string comes from the shared timeAgo() in
  // format.js (was a local cacheAgeText copy with its own inconsistent buckets).
  assert.match(TODAY, /markRefreshFailed\(container, timeAgo\(cachedAt\)\)/,
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

// ── #9 (2026-08-15): ONE relative-age formatter — format.js timeAgo() ───────────
// The frontend once carried four hand-rolled "…ago" rule sets (format.js timeAgo,
// app.js stampText + hcAgeText, today.js cacheAgeText) with mutually inconsistent
// buckets (floor vs round, "moments ago" vs "just now", 48h vs 24h day cutoff), so
// the same payload age rendered differently across surfaces and threshold fixes
// never propagated. Convention now: timeAgo's — "just now" under 90s, then ROUNDED
// minutes/hours/days with cutoffs at 1h/24h; unparseable input reads "a while ago".

test('app.js and today.js import the shared timeAgo and keep no local relative-age arithmetic', () => {
  assert.match(APP, /import \{[^}]*\btimeAgo\b[^}]*\} from '\.\/format\.js'/,
    'app.js must import timeAgo from format.js');
  assert.match(TODAY, /import \{[^}]*\btimeAgo\b[^}]*\} from '\.\/format\.js'/,
    'today.js must import timeAgo from format.js');
  for (const [name, src] of [['app.js', APP], ['today.js', TODAY]]) {
    // The deleted formatters and their private bucket constants may not return.
    assert.ok(!/cacheAgeText/.test(src), `${name}: cacheAgeText resurrected`);
    assert.ok(!/MINUTE_MS|HOUR_MS|STAMP_MS_PER_HOUR/.test(src),
      `${name}: local age-bucket constants resurrected`);
    // No minute/hour bucketing of a Date.now() delta outside the shared helper.
    assert.ok(!/Date\.now\(\)[^\n]*\/\s*(?:60000|3600000|60 \* 1000|60\s*\*\s*60\s*\*\s*1000)/.test(src),
      `${name}: hand-rolled minute/hour age arithmetic resurrected`);
    // Every literal "…m/h/d ago" left must render a SERVER-supplied age field
    // (ageMins / discoveryAgeMin / narrativeAgeMinutes) — never local bucket math.
    const agoLines = src.split('\n').filter(l => /[mhd] ago/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    const rogue = agoLines.filter(l => !/agemin/i.test(l));
    assert.deepEqual(rogue, [], `${name}: locally built "ago" strings must go through timeAgo()`);
  }
});

test('timeAgo convention: just-now under 90s, rounded m/h/d buckets, honest fallback on garbage', () => {
  const m = R('format.js').match(/export (function timeAgo\(ts\) \{[\s\S]*?\n\})/);
  assert.ok(m, 'could not extract timeAgo from format.js');
  const timeAgo = new Function(`${m[1]}\nreturn timeAgo;`)();
  const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  assert.equal(timeAgo(new Date().toISOString()), 'just now');            // ISO string
  assert.equal(timeAgo(Date.now() - 5 * MIN), '5m ago');                  // epoch ms (cache stamps)
  assert.equal(timeAgo(new Date(Date.now() - 3 * HOUR)), '3h ago');       // Date object
  assert.equal(timeAgo(Date.now() - 30 * HOUR), '1d ago', 'day cutoff is 24h, not 48h');
  assert.equal(timeAgo(Date.now() - 3 * DAY - 13 * HOUR), '4d ago', 'buckets ROUND, not floor');
  assert.equal(timeAgo(Date.now() + HOUR), 'just now', 'a future stamp clamps to just now');
  assert.equal(timeAgo('garbage'), 'a while ago', 'unparseable input must not render NaN');
  assert.equal(timeAgo(null), 'a while ago', 'missing input must not read as epoch 1970');
});

test('opportunities.js buildReliability uses live scoreboard horizons and oppTrack labels the real one', () => {
  assert.ok(!OPPS.includes("h['1w']"), "scoreboard horizons are 1d/5d/10d/20d/1m/3m — '1w' does not exist");
  assert.match(OPPS, /RELIABILITY_HORIZONS/);
  assert.match(OPPS, /horizon: key/, 'the horizon that supplied the record must be carried');
  assert.match(OPPS, /r\.horizon \? ` \(\$\{r\.horizon\}\)` : ''/,
    'oppTrack must caption the horizon actually used, not a hardcoded "(1m)"');
});

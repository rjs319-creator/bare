'use strict';
// PICKS OUTAGE HONESTY — frontend (review finding #10, 2026-08-15).
//
// THE DEFECT: /api/picks gained degraded / degradedNote / newsFeedsFailed (a full
// news-provider outage must never be recorded as a genuine abstention) — but renderPicks
// never read them. A total outage rendered the standard "no picks cleared the screen"
// empty state, indistinguishable from a real measured abstention, at the only surface
// users see. Source-scan style (same pattern as frontend-staleness-honesty.test.js):
// the frontend is browser-only, so these tests parse public/js/app.js with regex.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const APP = readFileSync(join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

// The renderPicks function body, so assertions can't be satisfied by unrelated code.
const RENDER_PICKS = (APP.match(/function renderPicks\(data\) \{[\s\S]*?\n  \}/) || [''])[0];

test('renderPicks consumes the outage fields from the /api/picks payload', () => {
  assert.ok(RENDER_PICKS, 'renderPicks(data) must exist in app.js');
  for (const field of ['degraded', 'degradedNote', 'newsFeedsFailed']) {
    assert.ok(RENDER_PICKS.includes(field), `renderPicks must read payload.${field}`);
  }
});

test('a degraded empty book renders a distinct outage state INSTEAD of the abstention copy', () => {
  // The outage branch must return before any track (and its abstention empty-state
  // copy) is built.
  assert.match(RENDER_PICKS, /degraded/, 'the outage branch must exist');
  const degradedIdx = RENDER_PICKS.indexOf('degraded');
  const trackIdx = RENDER_PICKS.indexOf('buildPickTrack');
  assert.ok(degradedIdx > -1 && trackIdx > degradedIdx,
    'the degraded check must run BEFORE the tracks (and their abstention copy) render');
  assert.match(RENDER_PICKS, /return;/, 'the empty-outage branch must stop before the tracks');
  // The outage copy itself: loud, and explicit that this is NOT an abstention.
  assert.match(APP, /not an abstention/i, 'the outage state must deny the abstention reading');
  assert.match(APP, /picks-degraded/, 'the outage state carries a distinct class');
});

test('the outage copy names the failed feed count and carries the ⚠️ style', () => {
  assert.match(APP, /function buildPicksOutageNotice\(/, 'a dedicated outage-notice builder must exist');
  const fn = (APP.match(/function buildPicksOutageNotice\([\s\S]*?\n  \}/) || [''])[0];
  assert.ok(fn.includes('newsFeedsFailed') || fn.includes('failed'), 'the notice must use the failed-feed count');
  assert.match(fn, /news feed/, 'the notice must name what failed (news feeds)');
  assert.match(fn, /⚠️/, 'the notice must be visibly a warning');
  assert.match(fn, /degradedNote/, 'the server degradedNote text must surface verbatim when present');
});

test('degraded WITH surviving picks shows a warning banner above the tracks, not a blank denial', () => {
  assert.match(APP, /picks-degraded-banner/, 'the picks-present variant is a smaller banner');
  const fn = (APP.match(/function buildPicksOutageNotice\([\s\S]*?\n  \}/) || [''])[0];
  assert.match(fn, /surviving feeds/, 'the banner must say the picks come from partial coverage');
});

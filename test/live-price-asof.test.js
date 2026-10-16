'use strict';
// "Today said live on a closed Saturday" (review 2026-10, Prompt 2.1/2.2). The section strip
// used to print `live · <polling clock>` with a green pulsing dot whenever any quote came
// back. It now derives its claim from the quotes: session from marketState, time from
// observedAt. Pure helper imported as an ES module (pulse2-render pattern).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = join(__dirname, '..');
const SRC = readFileSync(join(ROOT, 'public', 'js', 'live-price.js'), 'utf8');
let LP;
test.before(async () => { LP = await import(pathToFileURL(join(ROOT, 'public', 'js', 'live-price.js')).href); });

const SAT = new Date('2026-10-03T15:00:00Z');                   // Saturday 11:00 ET
const FRI_CLOSE = '2026-10-02T20:00:00.000Z';
const q = (marketState, observedAt = FRI_CLOSE, extra = {}) => ({ price: '10.00', changePct: '1.00', marketState, observedAt, ...extra });

test('a closed Saturday never says "live": it names the last close with its date and ET zone', () => {
  const a = LP.asOfLabelFor({ AAA: q('CLOSED'), BBB: q('CLOSED') }, SAT);
  assert.equal(a.live, false);
  assert.equal(a.dotClass, 'live-closed');
  assert.ok(!/\blive\b/.test(a.label), a.label);
  assert.match(a.label, /^last close · Oct 2, 2026, 4:00 PM ET · 2 names$/);
  assert.equal(a.observedAt, FRI_CLOSE);
});

test('"live" is earned only by a REGULAR session, and the time shown is the quote time, not the poll time', () => {
  const now = new Date('2026-10-05T15:07:42Z');                 // Monday 11:07:42 ET
  const a = LP.asOfLabelFor({ AAA: q('REGULAR', '2026-10-05T15:05:00.000Z') }, now);
  assert.equal(a.live, true);
  assert.equal(a.dotClass, 'live-regular');
  assert.equal(a.label, 'live · quotes as of 11:05 AM ET · 1 name');
  assert.ok(!a.label.includes('11:07'), 'the polling clock must not appear as the data time');
});

test('pre-market and after-hours get their own words and the amber dot', () => {
  assert.match(LP.asOfLabelFor([q('PRE', '2026-10-05T12:00:00Z')], new Date('2026-10-05T12:01:00Z')).label, /^pre-market · quotes as of 8:00 AM ET/);
  const post = LP.asOfLabelFor([q('POST', '2026-10-05T21:00:00Z')], new Date('2026-10-05T21:01:00Z'));
  assert.match(post.label, /^after-hours · /);
  assert.equal(post.dotClass, 'live-post');
  assert.equal(post.live, false);
});

test('a missing observation time is stated as unknown — never replaced by now', () => {
  const a = LP.asOfLabelFor({ AAA: q('CLOSED', null) }, SAT);
  assert.equal(a.observedAt, null);
  assert.match(a.label, /^last close · quote time unknown · 1 name$/);
  const stooq = LP.asOfLabelFor({ AAA: q('CLOSED', null, { observedDate: '2026-10-02' }) }, SAT);
  assert.match(stooq.label, /2026-10-02 \(time unknown\)/);
});

test('a mixed or unlabelled batch takes the least-live reading', () => {
  assert.equal(LP.asOfLabelFor([q('REGULAR'), q('CLOSED')], SAT).live, false);
  const none = LP.asOfLabelFor([{ price: '1.00' }], SAT);
  assert.equal(none.live, false);
  assert.match(none.label, /^session unknown/);
  assert.equal(LP.asOfLabelFor({}, SAT).count, 0);
});

test('source: the strip no longer hardcodes the live word or the green dot', () => {
  assert.ok(!/live-dot live-regular"><\/span>live ·/.test(SRC));
  assert.match(SRC, /asOfLabelFor\(shown, now\)/);
  assert.match(SRC, /if \(current !== section\)/, 'an in-flight poll for a section the user left is discarded');
});

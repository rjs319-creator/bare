'use strict';
// EVIDENCE-LANGUAGE GUARD — unvalidated research ranks must never render as
// conviction, star-rated buy recommendations, probabilities, or verified
// "smart money"/institutional flow. Candle/volume-derived accumulation is a
// PROXY and every rendered label must say so. (The audit behind these pins is
// docs/evidence-language-audit.md.)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('no rendered surface calls an unvalidated score "High conviction" or star-rates it', () => {
  for (const f of ['public/js/opportunities.js', 'public/js/quickhit.js', 'public/js/app.js', 'public/index.html']) {
    const s = read(f);
    assert.doesNotMatch(s, /High conviction/, `${f} still says "High conviction"`);
    assert.doesNotMatch(s, /⭐⭐/, `${f} still star-rates a tier (⭐⭐ / ⭐⭐⭐)`);
  }
});

test('the opportunities tier is a research rank labeled unvalidated, shown next to the rank glyphs', () => {
  const s = read('public/js/opportunities.js');
  assert.match(s, /High research rank — unvalidated/);
  assert.match(s, /Low research rank — watch only/);
  assert.match(s, /research rank — unvalidated/, 'the card must carry the label visibly, not only in a tooltip');
});

test('candle-derived accumulation is never asserted as smart money / institutional flow', () => {
  const opp = read('public/js/opportunities.js');
  assert.doesNotMatch(opp, /Smart money is showing/);
  assert.match(opp, /unverified proxy, not confirmed institutional buying/);
  const ghost = read('lib/ghost.js');
  assert.match(ghost, /SF: 'Up\/down-volume flow \(proxy\)'/);
  const whynow = read('lib/whynow.js');
  assert.doesNotMatch(whynow, /smart-money footprint/);
  const apex = read('lib/apex.js');
  assert.match(apex, /p4: 'Supply \/ accumulation \(proxy\)'/);
});

test('the APEX pillar-4 render sites say proxy, not smart money', () => {
  const app = read('public/js/app.js');
  assert.doesNotMatch(app, /'Supply \/ smart money'/);
  assert.doesNotMatch(app, /④ Smart money'/);
  assert.match(app, /Supply \/ accumulation \(proxy\)/);
  const html = read('public/index.html');
  assert.doesNotMatch(html, /Smart-money flow/);
});

test('every remaining rendered "smart money" mention is a negation/disclaimer, never a claim', () => {
  // String-literal lines only (comments excluded) across the app surfaces.
  for (const f of ['public/js/app.js', 'public/js/opportunities.js', 'public/js/ticker-lookup.js', 'public/index.html', 'lib/whynow.js', 'lib/ghost.js', 'lib/apex.js', 'lib/gameplan.js', 'lib/tech-command-options.js']) {
    const lines = read(f).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/smart[ -]money/i.test(line)) continue;
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;                       // comment
      const ok = /not (["“']?|proven |confirmed )?["“']?smart|never|NOT smart|it is not ["“']?smart|no ["“']?smart/i.test(line);
      assert.ok(ok, `${f}:${i + 1} makes an unqualified smart-money claim: ${line.trim().slice(0, 120)}`);
    }
  }
});

test('the default decision surface renders a first-class NO TRADE state', () => {
  const today = read('public/js/today.js');
  assert.match(today, /'no-trade': \['🔴', 'op-notrade', 'No trade today'\]/);
});

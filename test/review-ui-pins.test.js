'use strict';
// Review 2026-10 — source-string fences for the app.js / CSS fixes that have no pure function
// (frontend-staleness-honesty pattern) plus MEASURED contrast for the supporting-text token.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const R = (f) => readFileSync(join(__dirname, '..', f), 'utf8');
const APP = R('public/js/app.js');
const CSS = R('public/css/app.css');

// ── WCAG 2.x relative-luminance contrast ───────────────────────────────────────────────
const lum = (h) => { const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const token = (name) => (new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(CSS) || [])[1];

test('--text-2 (supporting text) measures >= 4.5:1 on --bg, --surface and --card; the old tokens did not', () => {
  const t2 = token('--text-2'), bg = token('--bg'), surface = token('--surface'), card = token('--card');
  assert.ok(t2 && bg && surface && card, 'tokens present');
  for (const b of [bg, surface, card]) assert.ok(contrast(t2, b) >= 4.5, `--text-2 ${t2} on ${b} = ${contrast(t2, b).toFixed(2)}`);
  // Documented measurements the fix was based on (fail if someone "fixes" them back).
  assert.ok(contrast(token('--text-muted'), bg) < 1.6, '--text-muted is decoration-only (~1.4:1)');
  assert.ok(contrast(token('--text-dim'), card) < 3.5, '--text-dim is below 4.5:1 and must not carry Today supporting text');
  // Pulse greys were raised from #6b7280 (3.7-4.1:1) to #9ca3af (>= 7:1).
  assert.ok(contrast('#9ca3af', '#0b0f17') >= 7);
});

test('Today / Scoreboard supporting-text selectors use --text-2, not --text-muted', () => {
  for (const sel of ['.td-dim', '.td-rank', '.td-ci', '.td-ver', '.td-hold', '.sb-count', '.section-label .lbl-time']) {
    const m = new RegExp(`${sel.replace(/[.\\[\\]]/g, '\\\\$&')}\\s*\\{[^}]*color:\\s*var\\(--text-2\\)`).exec(CSS);
    assert.ok(m, `${sel} must read from --text-2`);
  }
  assert.ok(!/#pulse \.p2-dim \{ color:#6b7280/.test(CSS));
  assert.match(CSS, /#today \.dt-note, #today \.dt-dim, \.td-co, \.td-levels, \.td-empty, \.td-lane-h, #session \.sb-dim \{ color: var\(--text-2\); \}/);
});

test('one global :focus-visible ring exists, covers role=link / tabindex cards, and no outline is removed without replacement', () => {
  assert.match(CSS, /:where\(button, \[role="button"\], \[role="link"\], \[tabindex\]:not\(\[tabindex="-1"\]\), summary, a, select, input, textarea\):focus-visible \{ outline: 2px solid var\(--cyan\)/);
  assert.ok(!/\.scr-filter:focus \{ outline: none/.test(CSS));
  assert.ok(!/\.live-asof \.live-dot \{ animation/.test(CSS), 'the dot pulses only when .is-live');
  assert.match(CSS, /\.live-asof\.is-live \.live-dot \{ animation/);
});

test('app.js: a failed op=tape renders "Market read unavailable", never the neutral mixed read', () => {
  const fn = APP.slice(APP.indexOf('function renderToday('), APP.indexOf('function todayRegimeLine'));
  assert.match(fn, /Market read unavailable/);
  assert.match(fn, /const rec = ok \? /);
  assert.match(fn, /'· market read unavailable'/);
});

test('app.js: Today refresh is sequenced and the button is disabled while loading', () => {
  const fn = APP.slice(APP.indexOf('async function runTodayUI()'), APP.indexOf('const TODAY_COND'));
  assert.match(fn, /const seq = \+\+todaySeq;/);
  assert.match(fn, /if \(seq !== todaySeq\) return;/);
  assert.match(fn, /rb\.disabled = true/);
});

test('app.js: a failed Pulse refresh keeps the last good v2 payload behind a failure strip instead of blanking to v1', () => {
  const fn = APP.slice(APP.indexOf('async function runPulse2UI('), APP.indexOf('function lazySection('));
  assert.match(fn, /if \(el && !pulse2Payload\) el\.innerHTML = /, 'only a first load blanks to the spinner');
  assert.match(fn, /if \(!hasV2 && pulse2Payload && !\(p && p\.disabled\)\)/);
  assert.match(fn, /renderPulse2\(pulse2Payload\);/);
  assert.match(fn, /p2-refresh-failed/);
  assert.match(fn, /stampText\(pulse2Payload\.clocks\.narrativeGeneratedAt\)/);
});

test('app.js: a failed Options refresh keeps the previous board behind a failure strip', () => {
  const fn = APP.slice(APP.indexOf('let optionsBoardShown = false;'), APP.indexOf('const OF_SEL ='));
  assert.match(fn, /if \(!optionsBoardShown\) optionsContainer\.innerHTML = skeletonGrid\(4\);/);
  assert.match(fn, /optionsRefreshFailed\('Could not load options flow\. Please try again\.'\)/);
  assert.match(fn, /of-refresh-failed/);
  assert.ok(!/catch \{ showOptionsError\(/.test(fn));
});

test('app.js: the personal lane toggle says "Shown/Hidden in my screens", with aria-pressed, and disclaims governance', () => {
  assert.match(APP, /👁 Shown in my screens/);
  assert.match(APP, /🙈 Hidden in my screens/);
  assert.match(APP, /data-sig-toggle="\$\{g\.section\}:\$\{g\.tier\}" aria-pressed=/);
  assert.match(APP, /does not change the strategy's governance status/);
  assert.ok(!/'✕ Disabled' : '✓ Enabled'/.test(APP));
});

test('app.js: a thin scoreboard sample is "Insufficient (n=…)" in every regime and names the horizon actually used', () => {
  assert.match(APP, /if \(n < SB_THIN_N\) return \{ cls: 'pending', label: `Insufficient \(n=\$\{n\}\)`/);
  assert.match(APP, /const thin = \(!hl \|\| hl\.n < SB_THIN_N\)/, 'not gated on sbRegime any more');
  assert.match(APP, /insufficient sample \(n=/);
  assert.match(APP, /sb-exp-hz">@\$\{esc\(v\.hzKey\)\}/);
  // ofFableEdgeHTML names its horizon key
  assert.match(APP, /const feKey = fableEdge \? \(fableEdge\['1w'\] \? '1w' : fableEdge\['1m'\] \? '1m' : null\) : null;/);
  assert.match(APP, /horizon \(\$\{esc\(feKey\)\}\)/);
});

test('app.js: recalibrate dry-run never claims adoption; the health banner attests data currency only from dataCurrent === true', () => {
  assert.match(APP, /res\.dryRun \? `🧪 Diagnostics only — a re-fit \$\{res\.wouldRefit \? 'WOULD' : 'would NOT'\} be adopted; adoption runs from the scheduled job\./);
  assert.match(APP, /be adopted from the seed; adoption runs from the scheduled job/);
  const health = APP.slice(APP.indexOf('async function checkHealth()'), APP.indexOf('checkHealth();'));
  assert.match(health, /d\.dataCurrent === true/);
  assert.match(health, /Market-data freshness could not be confirmed\./);
  assert.ok(!/\$\{chainsFrom\} Market data is current;/.test(health), 'the stock reassurance is no longer unconditional');
});

// ── Options / put-sell execution language (Prompt 7): a delayed snapshot is never a fill ──
test('options UI: no execution certainty from delayed quotes; volume/last-print never become confirmed direction', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  for (const gone of ['should fill', 'conservative bid', 'you may fill better', 'lifted the ask — buyer-initiated', 'hit the bid — seller-initiated',
    'supports aggressive buying', 'positioning confirmed', 'no new positioning', 'Single-stock conviction', 'aggressive <b>options bets</b>']) {
    assert.equal(src.includes(gone), false, `stale execution/direction claim still present: "${gone}"`);
  }
  assert.match(src, /Snapshot spread quality \(delayed\)/);
  assert.match(src, /not executable from this data/);
  assert.match(src, /re-quote required/);
  assert.match(src, /bid at the delayed snapshot — re-quote before placing/);
  assert.match(src, /Earnings date unknown/);
  assert.match(src, /IV unknown/);
  assert.match(src, /net new contracts \(side unknown\)/);
});

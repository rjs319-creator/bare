'use strict';
// Both Today renders read the SAME served field (`regimeView`, lib/regime-view) and label the two
// reads distinctly (site audit 2026-10-02 #6). Source-scan assertions on the string-built renders.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const TODAY = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'today.js'), 'utf8');

test('the Today header renders from regimeView and never says "The market is <macro regime>"', () => {
  const i = APP.indexOf('function renderToday'); assert.ok(i > -1);
  const fn = APP.slice(i, i + 6000);
  assert.doesNotMatch(fn, /The market is <b>/);
  assert.match(fn, /todayRegimeLine\(ok \? tape\.regimeView : null/);
  // When op=today lands, the header is re-rendered from ITS regimeView (same payload as the board).
  assert.match(fn, /loadCommandCenter\(.*?\)\)\.then\(\(p\) =>/);
  assert.match(fn, /p\.regimeView/);
  const j = APP.indexOf('function todayRegimeLine'); assert.ok(j > -1);
  const line = APP.slice(j, j + 2000);
  assert.match(line, /Macro risk/);
  assert.match(line, /rv\.governing\.label\.toUpperCase\(\)/);
});

test('the command-center header reads regimeView.governing and shows the macro read as "macro risk"', () => {
  const i = TODAY.indexOf('td-regime'); assert.ok(i > -1);
  const line = TODAY.slice(i - 200, i + 800);
  assert.match(line, /p\.regimeView\.governing\.label/);
  assert.match(line, /\(breadth regime\)/);
  assert.match(line, /macro risk: \$\{esc\(p\.regimeView\.macro\.regime\)\}/);
});

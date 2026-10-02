'use strict';
// Site audit 2026-10-02 #7 — the Options tab rendered "quote undefined/undefined (undefined% of
// mid)" when the executable-liquidity quote object was present but one-sided/empty. The quote
// line is string-built client-side, so the helper is lifted out of public/js/app.js by source
// and exercised directly (the established pattern for frontend checks).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

function liftHelper() {
  const start = APP_SRC.indexOf('function of2QuoteText(q)');
  assert.ok(start > -1, 'of2QuoteText helper not found in app.js');
  const end = APP_SRC.indexOf('\n  }\n', start);
  const src = APP_SRC.slice(start, end + 4);
  return new Function(`${src}; return of2QuoteText;`)();
}

test('a one-sided or empty quote renders "quote unavailable", never undefined/undefined', () => {
  const of2QuoteText = liftHelper();
  for (const q of [{ available: true }, { bid: undefined, ask: 2 }, { bid: 1, ask: null }, { bid: 'x', ask: 2 }]) {
    const out = of2QuoteText(q);
    assert.match(out, /quote unavailable/);
    assert.doesNotMatch(out, /undefined|NaN/);
  }
});

test('a finite two-sided quote renders bid/ask and the spread when it is a number', () => {
  const of2QuoteText = liftHelper();
  assert.equal(of2QuoteText({ bid: 1, ask: 3, spreadPctOfMid: 100 }), ' · quote 1/3 (100% of mid)');
  assert.equal(of2QuoteText({ bid: 1.2, ask: 1.4 }), ' · quote 1.2/1.4');
  assert.equal(of2QuoteText(null), ' · no two-sided quote');
});

test('the executable-liquidity line renders its quote through the guarded helper', () => {
  const idx = APP_SRC.indexOf('function of2ExecutionHTML');
  assert.ok(idx > -1);
  const fn = APP_SRC.slice(idx, idx + 2500);
  assert.match(fn, /\$\{of2QuoteText\(q\)\}/, 'quote line bypasses of2QuoteText');
  assert.doesNotMatch(fn, /quote \$\{q\.bid\}\/\$\{q\.ask\}/, 'raw q.bid/q.ask interpolation is back');
});

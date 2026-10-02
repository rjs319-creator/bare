'use strict';
// The Pattern Radar UI consumes the SERVER-paged op=patterns payload (site audit 2026-10-02 #8):
// bucket headings show the bucket TOTAL, and "show more" fetches the next page of one bucket
// instead of slicing a 24.5 MB list it no longer receives. Source-scan assertions, as the
// render path is string-built client-side.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const fnSrc = (name, len) => { const i = APP_SRC.indexOf(`function ${name}`); assert.ok(i > -1, `${name} not found`); return APP_SRC.slice(i, i + len); };

test('the first load asks the server for one page per bucket', () => {
  const fn = fnSrc('runPatternRadarUI', 800);
  assert.match(fn, /op=patterns&view=\$\{patternRadarView\}&limit=\$\{PR_PAGE_SIZE\}/);
});

test('bucket headings and the show-more count use the server total, not the page length', () => {
  const fn = fnSrc('renderPatternRadar', 3500);
  assert.match(fn, /prRadarTotals = t\.totals/);
  assert.match(fn, /const total = prRadarTotals && Number\.isFinite\(prRadarTotals\[k\]\) \? prRadarTotals\[k\] : items\.length/);
  assert.match(fn, /\(\$\{total\}\)<\/h3>/);
  assert.match(fn, /const hidden = total - shown/);
});

test('show more fetches the next page of ONE bucket from the server', () => {
  const fn = fnSrc('prShowMore', 2200);
  assert.match(fn, /op=patterns&view=\$\{patternRadarView\}&bucket=\$\{k\}&offset=\$\{start\}&limit=\$\{PR_PAGE_SIZE\}/);
  assert.match(fn, /j\.radar\[k\]/);
  // A legacy (unpaged) payload still pages client-side.
  assert.match(fn, /items\.slice\(start, start \+ PR_PAGE_SIZE\)/);
});

'use strict';
// Regression: the S&P "changes" wikitable parser must tolerate <tr> tags WITH attributes.
// Wikipedia emits `<tr class="...">`; a strict /<tr>/ matched zero rows and silently emptied
// the entire delisting source, so every survivorship correction added nothing.

const test = require('node:test');
const assert = require('node:assert');
const { parseRemovedConstituents } = require('../lib/constituents');

// A minimal changes table whose rows ALL carry attributes (the shape that broke the old regex —
// there is not a single bare `<tr>` here, exactly like real Wikipedia markup).
const HTML = `
<table class="wikitable sortable" id="changes">
<tr class="header"><th>Date</th><th>Ticker</th><th>Name</th><th>Ticker</th><th>Name</th><th>Reason</th></tr>
<tr class="vevent" style="x"><td>February 15, 2022</td><td>ACME</td><td>Acme Add</td><td>XLNX</td><td>Xilinx</td><td>Acquired</td></tr>
<tr id="r2"><td>March 10, 2023</td><td>NEWCO</td><td>New Co</td><td>SIVB</td><td>SVB</td><td>Delisted</td></tr>
<tr data-x="1"><td>January 1, 2000</td><td>OLDA</td><td>Old Add</td><td>OLDR</td><td>Old Removed</td><td>Too old</td></tr>
</table>`;

test('parseRemovedConstituents: parses attributed <tr> rows and honors the year cutoff', () => {
  const now = new Date('2026-01-01T00:00:00Z').getTime();
  const out = parseRemovedConstituents(HTML, { years: 5, now });
  assert.deepStrictEqual(out.map(x => x.ticker).sort(), ['SIVB', 'XLNX']);  // OLDR excluded by cutoff
  assert.equal(out.find(x => x.ticker === 'XLNX').removedDate, '2022-02-15');
});

test('parseRemovedConstituents: guards the regression (no bare <tr>; strict regex would match zero)', () => {
  assert.equal((HTML.match(/<tr>/g) || []).length, 0, 'fixture has no bare <tr> — all rows are attributed');
  assert.equal(parseRemovedConstituents(HTML, { years: 5, now: new Date('2026-01-01').getTime() }).length, 2);
});

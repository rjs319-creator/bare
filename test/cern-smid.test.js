// CERN SMID coverage — S&P 400/600 index-change events as separate types.
// Locks: the generalized changes-table parser, the SMID types' existence and
// separation from their 500 cousins, and the per-index tagging.
const test = require('node:test');
const assert = require('node:assert');
const { parseIndexChanges, SMID_SOURCES } = require('../lib/constituents');
const { EVENT_TYPES } = require('../lib/cern');

const FIXTURE = `
<table class="wikitable sortable">
<tr><th>Date</th><th colspan="2">Added</th><th colspan="2">Removed</th><th>Reason</th></tr>
<tr><th></th><th>Ticker</th><th>Security</th><th>Ticker</th><th>Security</th><th></th></tr>
<tr class="x"><td>July 30, 2026</td><td>ABCD</td><td>Abcd Corp</td><td>WXYZ</td><td>Wxyz Inc</td><td>Market cap change</td></tr>
<tr><td>July 1, 2026</td><td>EF.G</td><td>Efg Co</td><td></td><td></td><td>Add only</td></tr>
<tr><td>January 2, 2020</td><td>OLD</td><td>Old Co</td><td>GONE</td><td>Gone Co</td><td>Too old</td></tr>
</table>`;

const NOW = Date.parse('2026-08-05T00:00:00Z');

test('parseIndexChanges: parses adds+removes within the window, normalizes class-share dots', () => {
  const chg = parseIndexChanges(FIXTURE, { daysBack: 70, now: NOW });
  assert.deepEqual(chg.removes, [{ ticker: 'WXYZ', date: '2026-07-30' }]);
  assert.deepEqual(chg.adds.map(a => a.ticker).sort(), ['ABCD', 'EF-G']);
  assert.ok(!chg.adds.some(a => a.ticker === 'OLD'), 'stale rows excluded');
});

test('parseIndexChanges: attribute-bearing <tr> rows are matched (the historical regression)', () => {
  const chg = parseIndexChanges(FIXTURE, { daysBack: 70, now: NOW });
  assert.ok(chg.removes.length + chg.adds.length >= 2, 'rows with class attributes must parse');
});

test('parseIndexChanges: garbage/empty html yields empty result, never throws', () => {
  assert.deepEqual(parseIndexChanges('', {}), { adds: [], removes: [] });
  assert.deepEqual(parseIndexChanges('<table class="wikitable"><tr><td>x</td></tr></table>', {}), { adds: [], removes: [] });
});

test('SMID event types exist, separate from the 500 cousins, same priors', () => {
  for (const [smid, base] of [['INDEX_DELETE_SMID', 'INDEX_DELETE'], ['INDEX_ADD_FADE_SMID', 'INDEX_ADD_FADE']]) {
    assert.ok(EVENT_TYPES[smid], `${smid} missing`);
    assert.equal(EVENT_TYPES[smid].horizon, EVENT_TYPES[base].horizon);
    assert.equal(EVENT_TYPES[smid].priorKappa, EVENT_TYPES[base].priorKappa);
    assert.ok(!EVENT_TYPES[smid].logOnly, `${smid} must be able to log real paper decisions`);
  }
});

test('SMID sources cover the 400 and the 600', () => {
  assert.deepEqual(SMID_SOURCES.map(s => s.index).sort(), ['sp400', 'sp600']);
  for (const s of SMID_SOURCES) assert.match(s.url, /^https:\/\/en\.wikipedia\.org\/wiki\//);
});

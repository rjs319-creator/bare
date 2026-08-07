'use strict';
// Technology universe service: delisted / duplicate / non-technology rows are excluded
// AND counted, degraded operation is labeled, and views are honest about their basis.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const UNI = require('../lib/tech-command-universe');

const rows = [
  { symbol: 'NVDA', company: 'NVIDIA', sector: 'Technology', industry: 'Semiconductors', marketCap: 3.2e12, isActivelyTrading: true },
  { symbol: 'ADBE', company: 'Adobe', sector: 'Technology', industry: 'Software - Application', marketCap: 2.4e11, isActivelyTrading: true },
  { symbol: 'DEAD', company: 'Delisted Co', sector: 'Technology', industry: 'Software - Application', marketCap: 1e8, isActivelyTrading: false },
  { symbol: 'NVDA', company: 'NVIDIA duplicate line', sector: 'Technology', industry: 'Semiconductors', isActivelyTrading: true },
  { symbol: 'XOM', company: 'Exxon', sector: 'Energy', industry: 'Oil & Gas Integrated', isActivelyTrading: true },
  { symbol: 'MYST', company: 'Mystery Tech', sector: 'Technology', industry: null, isActivelyTrading: true },
];

test('delisted, duplicate and non-technology securities are excluded and COUNTED', () => {
  const b = UNI.buildFromRows(rows, { asOf: '2026-08-05T00:00:00Z' });
  const tickers = b.records.map(r => r.ticker);
  assert.ok(!tickers.includes('DEAD'), 'a security the provider says no longer trades must not sit on a board');
  assert.ok(!tickers.includes('XOM'));
  assert.equal(tickers.filter(t => t === 'NVDA').length, 1, 'duplicate symbols collapse to one');
  assert.equal(b.exclusions.inactiveOrDelisted, 1);
  assert.equal(b.exclusions.duplicateSymbols, 1);
  assert.equal(b.exclusions.nonTechnology, 1);
});

test('an unplaceable technology name is retained as unclassified, not dropped or guessed', () => {
  const b = UNI.buildFromRows(rows);
  const myst = b.records.find(r => r.ticker === 'MYST');
  assert.ok(myst, 'a technology name with thin metadata still belongs to the universe');
  assert.equal(myst.subsector, 'unclassified');
  assert.equal(b.coverage.unclassified, 1);
  assert.ok(b.coverage.classifiedPct < 100);
});

test('records are sorted by market cap and carry classification provenance', () => {
  const b = UNI.buildFromRows(rows, { asOf: '2026-08-05T00:00:00Z' });
  assert.equal(b.records[0].ticker, 'NVDA');
  assert.equal(b.records[0].classification.asOf, '2026-08-05T00:00:00Z');
  assert.equal(b.records[0].classification.pointInTime, false);
});

test('the curated fallback is small, real and never claims full coverage', () => {
  const fb = UNI.curatedFallbackRows();
  assert.ok(Array.isArray(fb));
  assert.ok(fb.every(r => r.metadataSource.includes('curated-fallback')));
  // The curated map asserts the SECTOR and nothing finer, so every fallback row says
  // so in words and can only reach 'other-technology' — never an invented subsector.
  assert.ok(fb.every(r => /no industry detail available/.test(r.industry)));
  const built = UNI.buildFromRows(fb);
  assert.ok(built.records.length > 0);
  // In the fallback the ONLY source of subsector detail is the labelled overlay.
  // Everything else stays 'other-technology' — no subsector is ever inferred from a
  // bare sector label.
  for (const r of built.records) {
    if (r.classification.overlayApplied) {
      assert.equal(r.classification.approximate, true, `${r.ticker}: overlay refinement must be labelled approximate`);
      assert.equal(r.classification.source, require('../lib/tech-command-taxonomy').OVERLAY_VERSION);
    } else {
      assert.equal(r.subsector, 'other-technology', `${r.ticker}: a bare sector label must not produce a specific subsector`);
      assert.match(r.classification.basis, /curated sector list/);
    }
  }
});

test('the viability floor turns a metadata outage into a LABELLED degradation, not an empty board', async () => {
  // A directory-only universe (no sector/industry) classifies to zero technology
  // names. That is a data outage, and it must not render as "nothing qualified".
  const doc = await UNI.loadTechUniverse({ now: new Date('2026-08-05T12:00:00Z') });
  if (doc.degraded) {
    assert.ok(doc.securities.length >= UNI.MIN_VIABLE_COUNT,
      'the fallback must actually be usable, not another empty set');
    assert.equal(doc.basis, 'curated-fallback');
  } else {
    assert.ok(doc.securities.length >= UNI.MIN_VIABLE_COUNT);
  }
});

test('loadTechUniverse degrades to the labeled fallback without a store or provider', async () => {
  const doc = await UNI.loadTechUniverse({ now: new Date('2026-08-05T12:00:00Z') });
  assert.equal(doc.schema, UNI.UNIVERSE_VERSION);
  assert.equal(doc.pointInTime, false);
  assert.ok(doc.pointInTimeNote.length > 0);
  if (doc.degraded) {
    assert.equal(doc.basis, 'curated-fallback');
    assert.ok(doc.warnings.some(w => /NOT full technology coverage/i.test(w)),
      'a degraded universe must say so in words');
  }
  assert.ok(Object.isFrozen(doc.securities));
});

test('views expose the options-liquidity proxy as a PROXY, not a measurement', () => {
  const doc = { securities: UNI.buildFromRows(rows).records, bySubsector: {} };
  const v = UNI.viewsOf(doc);
  assert.ok(v.liquidOptionsProxy.basis.includes('PROXY'));
  assert.ok(Array.isArray(v.megaCap));
  assert.ok(v.megaCap.includes('NVDA'));
});

test('lookup returns null for a ticker outside the technology universe', () => {
  const built = UNI.buildFromRows(rows);
  const doc = { byTicker: Object.fromEntries(built.records.map(r => [r.ticker, r])) };
  assert.ok(UNI.lookup(doc, 'nvda'));
  assert.equal(UNI.lookup(doc, 'XOM'), null);
  assert.equal(UNI.lookup(doc, null), null);
});

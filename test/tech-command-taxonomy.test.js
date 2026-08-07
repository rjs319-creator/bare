'use strict';
// Technology taxonomy: verified provider data classifies, the labeled overlay only
// REFINES, and anything unplaceable becomes an explicit 'unclassified' state — never
// a guess.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const TAX = require('../lib/tech-command-taxonomy');

const row = (o) => ({ symbol: 'X', company: 'X Corp', isActivelyTrading: true, metadataSource: 'nasdaq-trader+fmp-company-screener', ...o });

test('provider industry drives the primary classification', () => {
  assert.equal(TAX.classifyByIndustry({ sector: 'Technology', industry: 'Semiconductors' }).subsector, 'semiconductors');
  assert.equal(TAX.classifyByIndustry({ sector: 'Technology', industry: 'Semiconductor Equipment & Materials' }).subsector, 'semiconductor-equipment');
  assert.equal(TAX.classifyByIndustry({ sector: 'Technology', industry: 'Software - Infrastructure' }).subsector, 'software');
  assert.equal(TAX.classifyByIndustry({ sector: 'Technology', industry: 'Communication Equipment' }).subsector, 'communications-equipment');
  assert.equal(TAX.classifyByIndustry({ sector: 'Technology', industry: 'Information Technology Services' }).subsector, 'it-services');
});

test('semiconductor EQUIPMENT is matched before plain semiconductors (rule order matters)', () => {
  const c = TAX.classifyByIndustry({ sector: 'Technology', industry: 'Semiconductor Equipment & Materials' });
  assert.notEqual(c.subsector, 'semiconductors');
});

// ── Live-vocabulary regressions ─────────────────────────────────────────────
// These strings are the provider's ACTUAL industry values, audited 2026-08-06.
test('THE SUBSTRING TRAP: "Credit Services" must not be read as "IT Services"', () => {
  // "credit services" literally contains "it services". Without a word boundary the
  // IT-services rule swallowed every Financial-Services credit name, which the
  // adjacent-sector allow-list then dropped — deleting fintech from the universe.
  const c = TAX.classifyByIndustry({ sector: 'Financial Services', industry: 'Financial - Credit Services' });
  assert.equal(c.subsector, 'fintech');
  assert.notEqual(c.subsector, 'it-services');
  const v = TAX.classifySecurity(row({ symbol: 'V', sector: 'Financial Services', industry: 'Financial - Credit Services' }));
  assert.ok(v, 'a payments network must not vanish from the technology universe');
  assert.equal(v.subsector, 'fintech');
});

test('every industry the provider actually emits inside Technology resolves', () => {
  // The complete Technology vocabulary as returned by the live company-screener.
  const LIVE = [
    ['Software - Application', 'software'], ['Software - Infrastructure', 'software'],
    ['Software - Services', 'software'], ['Information Technology Services', 'it-services'],
    ['Hardware, Equipment & Parts', 'hardware'], ['Semiconductors', 'semiconductors'],
    ['Communication Equipment', 'communications-equipment'], ['Computer Hardware', 'hardware'],
    ['Consumer Electronics', 'hardware'], ['Technology Distributors', 'it-services'],
    ['Solar', 'solar'],
    // Not one of the spec's named areas — must land in other-technology, and must
    // NOT be mis-read as electronic components.
    ['Electronic Gaming & Multimedia', 'other-technology'],
    ['Media & Entertainment', 'other-technology'],
  ];
  for (const [industry, expected] of LIVE) {
    const c = TAX.classifyByIndustry({ sector: 'Technology', industry });
    assert.equal(c && c.subsector, expected, `"${industry}" resolved to ${c && c.subsector}, expected ${expected}`);
  }
});

test('subsectors the provider cannot reach are declared overlay-only', () => {
  for (const s of TAX.OVERLAY_ONLY_SUBSECTORS) {
    assert.ok(TAX.SUBSECTORS[s], `${s} must be a real subsector`);
  }
  // Semiconductor equipment is the load-bearing case: the provider files AMAT/LRCX/
  // KLAC under the single industry "Semiconductors", so the distinction exists only
  // in the overlay — and the overlay must actually carry it.
  assert.ok(TAX.OVERLAY_ONLY_SUBSECTORS.includes('semiconductor-equipment'));
  const semicap = Object.values(TAX.OVERLAY).filter(o => o.subsector === 'semiconductor-equipment');
  assert.ok(semicap.length >= 5, 'an overlay-only subsector with no entries is unreachable');
  assert.ok(semicap.every(o => o.basis && o.basis.length > 10));
  const amat = TAX.classifySecurity(row({ symbol: 'AMAT', sector: 'Technology', industry: 'Semiconductors' }));
  assert.equal(amat.subsector, 'semiconductor-equipment');
  assert.equal(amat.classification.overlayApplied, true);
});

test('the overlay never places a name the provider puts outside technology', () => {
  // Data-centre power/thermal companies are classified Industrials by the provider,
  // so the overlay cannot reach them — and must not pretend otherwise.
  const industrial = TAX.classifySecurity(row({ symbol: 'VRT', sector: 'Industrials', industry: 'Electrical Equipment & Parts' }));
  assert.equal(industrial, null);
  for (const [ticker, o] of Object.entries(TAX.OVERLAY)) {
    assert.notEqual(o.subsector, 'datacenter-infrastructure',
      `${ticker}: this subsector's companies sit outside technology; the overlay must stay empty rather than import them`);
  }
});

test('adjacent sectors contribute ONLY their allowed industries', () => {
  // Communication Services → internet platforms / advertising are allowed…
  assert.equal(TAX.classifyByIndustry({ sector: 'Communication Services', industry: 'Internet Content & Information' }).subsector, 'internet-platforms');
  assert.equal(TAX.classifyByIndustry({ sector: 'Communication Services', industry: 'Advertising Agencies' }).subsector, 'digital-advertising');
  // …but a telecom is not technology.
  assert.equal(TAX.classifyByIndustry({ sector: 'Communication Services', industry: 'Telecom Services' }), null);
  // A bank is not fintech.
  assert.equal(TAX.classifyByIndustry({ sector: 'Financial Services', industry: 'Banks - Regional' }), null);
});

test('non-technology sectors are excluded entirely', () => {
  assert.equal(TAX.classifySecurity(row({ symbol: 'XOM', sector: 'Energy', industry: 'Oil & Gas Integrated' })), null);
});

test('a technology row with no industry becomes UNCLASSIFIED, not a guess', () => {
  const r = TAX.classifySecurity(row({ symbol: 'ZZZZ', sector: 'Technology', industry: null }));
  assert.equal(r.subsector, 'unclassified');
  assert.equal(r.classification.approximate, true);
  assert.equal(r.benchmark, null, 'unclassified has no benchmark to compare against');
  const r2 = TAX.classifySecurity(row({ symbol: 'ZZZZ', sector: 'Technology', industry: '' }));
  assert.equal(r2.subsector, 'unclassified');
});

test('a technology row with an UNMAPPED industry lands in other-technology, distinct from unclassified', () => {
  const r = TAX.classifySecurity(row({ symbol: 'WXYZ', sector: 'Technology', industry: 'Quantum Widgetry' }));
  assert.equal(r.subsector, 'other-technology');
  assert.ok(r.classification.basis.includes('Quantum Widgetry'));
});

test('a row with no sector at all is dropped rather than invented into technology', () => {
  assert.equal(TAX.classifySecurity(row({ symbol: 'QQQQ', sector: null, industry: null })), null);
});

test('the overlay only REFINES and is always labeled as a current approximation', () => {
  const base = TAX.classifyByIndustry({ sector: 'Technology', industry: 'Semiconductors' });
  assert.equal(base.subsector, 'semiconductors');
  const r = TAX.classifySecurity(row({ symbol: 'NVDA', sector: 'Technology', industry: 'Semiconductors' }));
  assert.equal(r.subsector, 'ai-infrastructure');
  assert.equal(r.classification.overlayApplied, true);
  assert.equal(r.classification.overlay.from, 'semiconductors');
  assert.equal(r.classification.approximate, true);
  assert.equal(r.classification.pointInTime, false);
  assert.equal(r.classification.source, TAX.OVERLAY_VERSION);
  assert.ok(r.classification.basis.length > 0);
});

test('the overlay can be disabled and never adds a security', () => {
  const r = TAX.classifySecurity(row({ symbol: 'NVDA', sector: 'Technology', industry: 'Semiconductors' }), { applyOverlay: false });
  assert.equal(r.subsector, 'semiconductors');
  assert.equal(r.classification.overlayApplied, false);
  // An overlay ticker that is NOT technology by provider data stays out.
  assert.equal(TAX.classifySecurity(row({ symbol: 'MU', sector: 'Industrials', industry: 'Machinery' })), null);
});

test('every classification carries source, basis and asOf provenance', () => {
  const r = TAX.classifySecurity(row({ symbol: 'ADBE', sector: 'Technology', industry: 'Software - Application' }), { asOf: '2026-08-05T00:00:00Z' });
  assert.equal(r.classification.asOf, '2026-08-05T00:00:00Z');
  assert.ok(r.classification.source);
  assert.ok(r.classification.basis.includes('Software'));
  assert.equal(r.classification.taxonomyVersion, TAX.TAXONOMY_VERSION);
});

test('every subsector has a benchmark or an explicit null, and unclassified has none', () => {
  for (const id of TAX.SUBSECTOR_IDS) {
    const meta = TAX.SUBSECTORS[id];
    assert.ok(meta.label, `${id} needs a label`);
    assert.ok(meta.benchmark === null || typeof meta.benchmark === 'string');
  }
  assert.equal(TAX.SUBSECTORS.unclassified.benchmark, null);
});

test('coverage report counts unclassified and overlay-refined names honestly', () => {
  const recs = [
    TAX.classifySecurity(row({ symbol: 'NVDA', sector: 'Technology', industry: 'Semiconductors' })),
    TAX.classifySecurity(row({ symbol: 'ADBE', sector: 'Technology', industry: 'Software - Application' })),
  ].filter(Boolean);
  const cov = TAX.coverageOf(recs);
  assert.equal(cov.total, 2);
  assert.equal(cov.overlayRefined, 1);
  assert.equal(cov.unclassified, 0);
  assert.equal(cov.classifiedPct, 100);
});

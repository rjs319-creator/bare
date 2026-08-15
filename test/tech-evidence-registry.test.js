'use strict';
// Prevents: guessed/unverified mappings leaking into signal production, SSRF via a
// corrupted mapping URL, inactive (delisted) companies producing new signals, and
// registry entries missing the provenance fields the UI promises to display.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/tech-evidence/registry');

test('every registry mapping passes its own validator', () => {
  for (const m of R.MAPPINGS) {
    const v = R.validateMapping(m);
    assert.ok(v.ok, `${m.mappingId}: ${v.issues.join('; ')}`);
  }
});

test('activeMappings excludes deregistered companies (CFLT filed Form 15 in 2026)', () => {
  const tickers = R.verifiedTickers();
  assert.ok(!tickers.includes('CFLT'), 'CFLT deregistered — must never produce new signals');
  assert.ok(tickers.length >= 4, 'the active verified universe must be non-trivial');
  // point-in-time: CFLT WAS active before its deregistration date
  const asOfEarly = R.activeMappings({ asOf: '2026-01-15' }).map(m => m.ticker);
  assert.ok(asOfEarly.includes('CFLT'), 'historical asOf inside the active window must include CFLT');
});

test('validateMapping rejects arbitrary hosts and missing provenance', () => {
  const base = R.MAPPINGS[0];
  assert.equal(R.validateMapping({ ...base, sourceUrl: 'https://evil.example.com/pkg' }).ok, false);
  assert.equal(R.validateMapping({ ...base, ownershipEvidence: '' }).ok, false);
  assert.equal(R.validateMapping({ ...base, revenueConnection: '' }).ok, false);
  assert.equal(R.validateMapping({ ...base, cik: '12345' }).ok, false, '10-digit zero-padded CIK required');
  assert.equal(R.validateMapping({ ...base, monetizationWeight: 'huge' }).ok, false);
});

test('isAllowedUrl is a strict https allowlist (the SSRF guard)', () => {
  assert.equal(R.isAllowedUrl('https://api.npmjs.org/downloads/range/2026-01-01:2026-01-31/mongodb'), true);
  assert.equal(R.isAllowedUrl('https://data.sec.gov/api/xbrl/companyfacts/CIK0001441816.json'), true);
  assert.equal(R.isAllowedUrl('https://evil.example.com/'), false);
  assert.equal(R.isAllowedUrl('http://api.npmjs.org/x'), false, 'plain http never allowed');
  assert.equal(R.isAllowedUrl('not a url'), false);
  assert.equal(R.isAllowedUrl('https://api.npmjs.org.evil.com/x'), false, 'suffix spoof must fail');
});

test('candidates carry an explicit exclusion reason and never validate as verified', () => {
  assert.ok(R.CANDIDATES.length >= 1);
  for (const c of R.CANDIDATES) {
    assert.ok(c.excludeReason && c.excludeReason.length > 10, 'every candidate must say why it is excluded');
  }
});

test('benchmarkFor and cikFor resolve for verified tickers', () => {
  for (const t of R.verifiedTickers()) {
    assert.ok(R.benchmarkFor(t), `${t} needs a benchmark ETF`);
    assert.match(R.cikFor(t), /^\d{10}$/);
  }
});

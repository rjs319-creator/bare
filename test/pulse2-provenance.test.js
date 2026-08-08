'use strict';
// Market Pulse v2 — SOURCE-TO-CLAIM PROVENANCE.
// Required behaviors #3, #4, #5: every displayed verified claim maps to an allowed real
// source; an invented source URL is rejected; syndicated copies do not count as
// independent sources.

const test = require('node:test');
const assert = require('node:assert');
const P = require('../lib/pulse2-provenance');

const CITES = [
  { url: 'https://www.reuters.com/a', title: 'Acme raises full-year datacenter outlook', domain: 'reuters.com', publishedAt: '2026-06-09' },
  { url: 'https://www.bloomberg.com/b', title: 'Acme lifts guidance on AI demand', domain: 'bloomberg.com', publishedAt: '2026-06-09' },
  { url: 'https://finance.yahoo.com/c', title: 'Acme raises full-year datacenter outlook', domain: 'finance.yahoo.com', publishedAt: '2026-06-09' },
  { url: 'https://www.sec.gov/f', title: 'Form 8-K Acme Corp', domain: 'sec.gov', publishedAt: '2026-06-09' },
  { url: 'https://x.com/trader/status/1', title: 'huge acme news!!', domain: 'x.com', publishedAt: null },
];

test('#4: an invented URL is rejected — only provider-returned URLs survive', () => {
  const index = P.buildSourceIndex(CITES);
  const { sourceRefs, droppedUrls } = P.resolveSourceRefs(
    ['https://www.reuters.com/a', 'https://fake.example.com/i-made-this-up'], index);
  assert.equal(sourceRefs.length, 1);
  assert.equal(droppedUrls, 1);
  const claims = P.sanitizeClaims([{ text: 'Acme raised guidance', sourceUrls: ['https://totally-invented.com/x'] }], index);
  assert.equal(claims[0].sourceRefs.length, 0);
  assert.equal(claims[0].status, 'UNVERIFIED');
  assert.equal(claims[0].droppedUrls, 1);
});

test('#5: syndicated copies share one lineage — a Yahoo reprint of the Reuters story is NOT independent', () => {
  const index = P.buildSourceIndex(CITES);
  // reuters.com/a and finance.yahoo.com/c share a normalized title ⇒ one lineage.
  const refs = P.resolveSourceRefs(['https://www.reuters.com/a', 'https://finance.yahoo.com/c'], index).sourceRefs;
  assert.equal(refs.length, 2);
  assert.equal(P.independentLineageCount(refs, index), 1);
  const status = P.deriveClaimStatus({ sourceRefs: refs }, index);
  assert.notEqual(status, 'VERIFIED');   // one lineage cannot verify
});

test('#3: VERIFIED requires ≥2 genuinely independent lineages', () => {
  const index = P.buildSourceIndex(CITES);
  const refs = P.resolveSourceRefs(['https://www.reuters.com/a', 'https://www.bloomberg.com/b'], index).sourceRefs;
  assert.equal(P.independentLineageCount(refs, index), 2);
  assert.equal(P.deriveClaimStatus({ sourceRefs: refs }, index), 'VERIFIED');
});

test('a single primary source (SEC filing) is SUPPORTED, one newsroom is SINGLE_SOURCE, social is not verification', () => {
  const index = P.buildSourceIndex(CITES);
  const sec = P.resolveSourceRefs(['https://www.sec.gov/f'], index).sourceRefs;
  assert.equal(P.deriveClaimStatus({ sourceRefs: sec }, index), 'SUPPORTED');
  const one = P.resolveSourceRefs(['https://www.bloomberg.com/b'], index).sourceRefs;
  assert.equal(P.deriveClaimStatus({ sourceRefs: one }, index), 'SINGLE_SOURCE');
  const social = P.resolveSourceRefs(['https://x.com/trader/status/1'], index).sourceRefs;
  assert.equal(P.independentLineageCount(social, index), 0);   // social ≠ evidence lineage
  assert.equal(P.deriveClaimStatus({ sourceRefs: social }, index), 'UNVERIFIED');
});

test('conflicted flag dominates any source count', () => {
  const index = P.buildSourceIndex(CITES);
  const refs = P.resolveSourceRefs(['https://www.reuters.com/a', 'https://www.bloomberg.com/b'], index).sourceRefs;
  assert.equal(P.deriveClaimStatus({ sourceRefs: refs, conflicted: true }, index), 'CONFLICTED');
});

test('rollupEvidence: conflicted dominates; verified requires the material (first) claim to hold', () => {
  assert.equal(P.rollupEvidence([{ status: 'VERIFIED' }, { status: 'CONFLICTED' }]), 'CONFLICTED');
  assert.equal(P.rollupEvidence([{ status: 'VERIFIED' }]), 'VERIFIED');
  // best claim VERIFIED but the material first claim unverified ⇒ only SUPPORTED
  assert.equal(P.rollupEvidence([{ status: 'UNVERIFIED' }, { status: 'VERIFIED' }]), 'SUPPORTED');
  assert.equal(P.rollupEvidence([]), 'UNVERIFIED');
});

test('index round-trips through JSON persistence', () => {
  const index = P.buildSourceIndex(CITES);
  const back = P.indexFromJSON(P.indexToJSON(index));
  assert.equal(back.sources.length, index.sources.length);
  const ref = P.resolveSourceRefs(['https://www.sec.gov/f'], back).sourceRefs;
  assert.equal(ref.length, 1);
});

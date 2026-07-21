'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const s = require('../lib/pulse-schema');

// ── Source integrity: never fabricate ─────────────────────────────────────────
test('sanitizeSource: drops a URL not in the real citation set (anti-fabrication)', () => {
  const allowed = new Set(['https://reuters.com/real']);
  const c = s.sanitizeSource({ url: 'https://evil.example/made-up', title: 'X' }, allowed);
  assert.equal(c.url, null);
  assert.equal(c.fabricatedUrlDropped, true);
});

test('sanitizeSource: keeps a URL that IS in the citation set + derives domain', () => {
  const allowed = new Set(['https://www.bloomberg.com/news/a']);
  const c = s.sanitizeSource({ url: 'https://www.bloomberg.com/news/a', title: 'A' }, allowed);
  assert.equal(c.url, 'https://www.bloomberg.com/news/a');
  assert.equal(c.domain, 'bloomberg.com');
  assert.equal(c.fabricatedUrlDropped, false);
});

test('sanitizeSources: de-duplicates by url and caps length', () => {
  const allowed = new Set(['https://a.com/1', 'https://b.com/2']);
  const out = s.sanitizeSources([
    { url: 'https://a.com/1' }, { url: 'https://a.com/1' }, { url: 'https://b.com/2' },
  ], allowed);
  assert.equal(out.length, 2);
});

test('no allowedUrls set → URLs still pass (offline / test path) but shape is clean', () => {
  const out = s.sanitizeSources([{ url: 'https://x.com/1', title: 't' }]);
  assert.equal(out[0].url, 'https://x.com/1');
});

// ── Measured vs inferred: popularity is NOT evidence ──────────────────────────
test('deriveEvidenceState: a very "popular" story with no sources is still Unverified', () => {
  const it = s.sanitizeItem({ headline: 'h', idea: 'i', tickers: ['x'], popularity: 99, velocity: 'exploding' }, true);
  assert.equal(s.deriveEvidenceState({ sourceList: it.sourceList, sources: it.sources }), 'Unverified');
});

test('deriveEvidenceState: grades by INDEPENDENT domains', () => {
  const three = [
    { url: 'https://a.com/1', independent: true }, { url: 'https://b.com/2', independent: true }, { url: 'https://c.com/3', independent: true },
  ].map(x => s.sanitizeSource(x));
  assert.equal(s.deriveEvidenceState({ sourceList: three, sources: '' }), 'Verified');
  assert.equal(s.deriveEvidenceState({ sourceList: three.slice(0, 2), sources: '' }), 'Multi-source');
  assert.equal(s.deriveEvidenceState({ sourceList: three.slice(0, 1), sources: '' }), 'Single-source');
  assert.equal(s.deriveEvidenceState({ sourceList: [], sources: 'trending on FinTwit' }), 'Search-summary only');
  assert.equal(s.deriveEvidenceState({ sourceList: [], sources: '', conflicted: true }), 'Conflicted');
});

// ── Ticker validation + macro handling ────────────────────────────────────────
test('sanitizeItem: validates tickers and infers category=macro when none', () => {
  const macro = s.sanitizeItem({ headline: 'Fed path', idea: 'i', tickers: [] }, false);
  assert.equal(macro.category, 'macro');
  assert.deepEqual(macro.tickers, []);
  const tk = s.sanitizeItem({ headline: 'h', idea: 'i', tickers: ['$aapl!', 'brk.b'] }, false);
  assert.equal(tk.category, 'ticker');
  assert.deepEqual(tk.tickers, ['AAPL', 'BRK.B']);
});

test('sanitizeItem: an explicit macro category is honored even with stray tickers', () => {
  const it = s.sanitizeItem({ headline: 'Oil spikes', idea: 'i', tickers: ['xle'], category: 'macro' }, false);
  assert.equal(it.category, 'macro');
});

// ── Concise-insight length caps (novice copy protection) ──────────────────────
test('sanitizeInsight: truncates verbose fields to their caps', () => {
  const long = 'x'.repeat(500);
  const it = s.sanitizeItem({ headline: 'h', idea: 'i', tickers: [], whatChanged: long, noviceTranslation: long, invalidation: long }, false);
  assert.ok(it.whatChanged.length <= s.LIMITS.whatChanged);
  assert.ok(it.noviceTranslation.length <= s.LIMITS.noviceTranslation);
  assert.ok(it.invalidation.length <= s.LIMITS.invalidation);
});

test('sanitizeInsight: missing fields stay null (never invented) + horizon defaults to context', () => {
  const it = s.sanitizeItem({ headline: 'h', idea: 'i', tickers: [] }, false);
  assert.equal(it.whatChanged, null);
  assert.equal(it.traderRead, null);
  assert.equal(it.horizon, 'context');
});

// ── Lifecycle derivation ──────────────────────────────────────────────────────
test('deriveLifecycle: crowd positioning + age drive the stage', () => {
  assert.equal(s.deriveLifecycle({ crowding: 'capitulation' }), 'Fading');
  assert.equal(s.deriveLifecycle({ velocity: 'cooling', crowding: 'building' }), 'Fading');
  assert.equal(s.deriveLifecycle({ crowding: 'crowded' }), 'Crowded');
  assert.equal(s.deriveLifecycle({ crowding: 'building' }), 'Building');
  assert.equal(s.deriveLifecycle({ crowding: 'early', ageDays: 0, sourceCount: 1 }), 'New');
  assert.equal(s.deriveLifecycle({ crowding: 'early', ageDays: 2, sourceCount: 3 }), 'Emerging');
});

// ── Action-state precedence (research states, not orders) ─────────────────────
test('deriveActionState: precedence — stale > macro > unverified > extended > crowded', () => {
  const a = o => s.deriveActionState(o);
  assert.equal(a({ stale: true, category: 'ticker', lifecycle: 'Emerging', evidence: 'Verified' }), 'STALE');
  assert.equal(a({ category: 'macro', lifecycle: 'Emerging', evidence: 'Verified' }), 'CONTEXT ONLY');
  assert.equal(a({ category: 'ticker', lifecycle: 'Emerging', evidence: 'Unverified' }), 'UNVERIFIED');
  assert.equal(a({ category: 'ticker', lifecycle: 'Emerging', evidence: 'Multi-source', enrichment: { atrExt: 3 } }), 'TOO EXTENDED');
  assert.equal(a({ category: 'ticker', lifecycle: 'Crowded', evidence: 'Multi-source', enrichment: { atrExt: 1 } }), 'CROWDED — DO NOT CHASE');
});

test('deriveActionState: crowded is a RISK state — never auto-flips to CONTRARIAN', () => {
  // crowded + no explicit contrarian thesis → DO NOT CHASE, not CONTRARIAN WATCH
  assert.equal(s.deriveActionState({ category: 'ticker', lifecycle: 'Crowded', evidence: 'Multi-source', contrarianThesis: false }), 'CROWDED — DO NOT CHASE');
  // only an explicit, testable thesis earns CONTRARIAN WATCH
  assert.equal(s.deriveActionState({ category: 'ticker', lifecycle: 'Building', evidence: 'Multi-source', contrarianThesis: true }), 'CONTRARIAN WATCH');
});

test('deriveActionState: fresh + strong evidence + not extended = INVESTIGATE NOW', () => {
  assert.equal(s.deriveActionState({ category: 'ticker', lifecycle: 'Emerging', evidence: 'Verified', enrichment: { atrExt: 0.5 } }), 'INVESTIGATE NOW');
  // weak evidence downgrades to WATCH even when fresh
  assert.equal(s.deriveActionState({ category: 'ticker', lifecycle: 'Emerging', evidence: 'Search-summary only', enrichment: { atrExt: 0.5 } }), 'EMERGING — WATCH');
});

test('priceConfirms / extensionState thresholds', () => {
  assert.equal(s.priceConfirms({ dayReturn: 2, relVol: 2 }), true);
  assert.equal(s.priceConfirms({ dayReturn: 2, relVol: 1 }), false);   // no volume confirmation
  assert.equal(s.extensionState({ atrExt: 3 }), 'extended');
  assert.equal(s.extensionState({ atrExt: 1.8 }), 'stretched');
  assert.equal(s.extensionState({ atrExt: 0.5 }), null);
  assert.equal(s.extensionState(null), null);
});

// ── Malformed LLM output never throws ─────────────────────────────────────────
test('parsePulse / parseRefinedPulse: junk in → clean empty out, no throw', () => {
  assert.deepEqual(s.parsePulse({ content: [{ type: 'text', text: 'hi' }] }), []);
  assert.deepEqual(s.parsePulse({}), []);
  assert.deepEqual(s.parseRefinedPulse(null), []);
  assert.deepEqual(s.parseRefinedPulse({ items: [{ nope: 1 }] }), []);
});

test('deriveStates: attaches all three states + preserves enrichment (measured)', () => {
  const it = s.sanitizeItem({ headline: 'h', idea: 'i', tickers: ['x'], sentiment: 'bullish', velocity: 'rising', crowding: 'building', sources: 'x' }, true);
  const d = s.deriveStates(it, { ageDays: 1, enrichment: { atrExt: 0.4, relVol: 2, dayReturn: 3 } });
  assert.ok(s.ACTION_STATES.includes(d.actionState));
  assert.ok(s.LIFECYCLES.includes(d.lifecycleState));
  assert.ok(s.EVIDENCE_STATES.includes(d.evidenceState));
  assert.equal(d.enrichment.relVol, 2);
});

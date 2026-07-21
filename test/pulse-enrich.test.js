'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const en = require('../lib/pulse-enrich');
const store = require('../lib/pulse-store');

// ── Point-in-time compute ─────────────────────────────────────────────────────
test('computeEnrichment: day / 3-session returns + relative volume', () => {
  const e = en.computeEnrichment({
    closes: [100, 101, 99, 100, 104, 110],
    volumes: [100, 100, 100, 100, 100, 400],
    opens: [100, 101, 99, 100, 104, 108],
  });
  assert.equal(e.asOfClose, 110);
  assert.ok(Math.abs(e.dayReturn - 5.77) < 0.1);       // 110 vs 104
  assert.ok(Math.abs(e.ret3 - 11.11) < 0.1);           // 110 vs 99
  assert.ok(Math.abs(e.relVol - 4) < 0.01);            // 400 vs trailing mean 100
});

test('computeEnrichment: ATR extension needs highs/lows + ≥15 bars, else null', () => {
  const short = en.computeEnrichment({ closes: [1, 2, 3, 4, 5], highs: [1, 2, 3, 4, 5], lows: [1, 2, 3, 4, 5] });
  assert.equal(short.atrExt, null);
  const n = 20;
  const closes = Array.from({ length: n }, (_, i) => 100 + i);   // steady uptrend
  const highs = closes.map(c => c + 1);
  const lows = closes.map(c => c - 1);
  const e = en.computeEnrichment({ closes, highs, lows });
  assert.ok(e.atr != null && e.atrExt != null);
  assert.ok(e.atrExt > 0);   // last close is above its 20-session mean
});

test('computeEnrichment: too few candles → null (never guesses)', () => {
  assert.equal(en.computeEnrichment({ closes: [1, 2] }), null);
  assert.equal(en.computeEnrichment({}), null);
});

// ── Provider-failure tolerance ────────────────────────────────────────────────
test('enrichTickers: a throwing fetch leaves the ticker absent, never throws', async () => {
  const out = await en.enrichTickers(['AAA', 'BBB'], { fetchBars: async () => { throw new Error('network'); } });
  assert.deepEqual(out, {});
});

test('enrichTickers: mixes successes and failures, de-dupes + caps', async () => {
  const bars = { closes: [10, 11, 12, 13, 14, 15], volumes: [1, 1, 1, 1, 1, 3] };
  const out = await en.enrichTickers(['aaa', 'AAA', 'bbb'], { fetchBars: async t => (t === 'BBB' ? null : bars) });
  assert.ok(out.AAA && !out.BBB);
});

// ── Real-citation extraction ──────────────────────────────────────────────────
test('extractCitations: pulls URLs from web_search_tool_result blocks only', () => {
  const msg = { content: [
    { type: 'web_search_tool_result', content: [
      { type: 'web_search_result', url: 'https://reuters.com/a', title: 'A', page_age: '2026-07-20' },
      { type: 'web_search_result', url: 'https://bloomberg.com/b', title: 'B' },
    ] },
    { type: 'text', text: 'summary', citations: [{ url: 'https://wsj.com/c', title: 'C' }] },
  ] };
  const { urls, sources } = en.extractCitations(msg);
  assert.ok(urls.has('https://reuters.com/a') && urls.has('https://wsj.com/c'));
  assert.equal(sources.find(s => s.url === 'https://reuters.com/a').domain, 'reuters.com');
});

test('extractCitations: no search blocks → empty set, no throw', () => {
  const { urls, sources } = en.extractCitations({ content: [{ type: 'text', text: 'hi' }] });
  assert.equal(urls.size, 0);
  assert.equal(sources.length, 0);
});

// ── Persistence honesty: no store → persisted:false, not a crash ──────────────
test('writeVerified: returns false when no Blob store is configured (honest persist)', async () => {
  const wasSet = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    const ok = await store.writeVerified('pulse/latest.json', { generation: 'g1' }, b => b.generation === 'g1');
    assert.equal(ok, false);
  } finally {
    if (wasSet) process.env.BLOB_READ_WRITE_TOKEN = wasSet;
  }
});

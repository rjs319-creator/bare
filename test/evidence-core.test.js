'use strict';
const test = require('node:test');
const assert = require('node:assert');

const schema = require('../lib/evidence-schema');
const { clusterEvents, fingerprint, jaccard, tokenize } = require('../lib/evidence-cluster');
const { scoreConsensus } = require('../lib/evidence-consensus');

// Helper: build a normalized event quickly.
function ev(raw, sources = []) {
  return schema.normalizeEvent(raw, { ticker: raw.ticker || 'ABC', sources, detectedAt: raw.detectedAt || '2026-07-24' });
}

// ── Schema: source classification (deterministic primary vs secondary) ──────────
test('classifySource marks SEC + wires primary, journalism secondary', () => {
  assert.equal(schema.classifySource({ url: 'https://www.sec.gov/Archives/edgar/x.htm' }).isPrimary, true);
  assert.equal(schema.classifySource({ url: 'https://www.businesswire.com/news/abc' }).isPrimary, true);
  const reuters = schema.classifySource({ url: 'https://www.reuters.com/markets/x' });
  assert.equal(reuters.isPrimary, false);
  assert.equal(reuters.type, 'journalism_tier1');
  assert.ok(reuters.reliability > schema.classifySource({ url: 'https://randomblog.example/x' }).reliability);
});

test('classifySource falls back to publisher name when no url host matches', () => {
  const c = schema.classifySource({ publisher: 'PR Newswire' });
  assert.equal(c.type, 'primary_release');
  assert.equal(c.isPrimary, true);
});

// ── Schema: null-discipline (no fabricated numbers) ─────────────────────────────
test('normalizeEvent keeps ungrounded numbers null, clamps scores, whitelists enums', () => {
  const e = ev({ claim: 'Beat on revenue', eventType: 'nonsense', direction: 'up', noveltyScore: 5, quantitativeMagnitude: 'lots' });
  assert.equal(e.eventType, 'operational');   // invalid → safe default
  assert.equal(e.direction, 'neutral');        // invalid → safe default
  assert.equal(e.noveltyScore, 1);             // clamped into [0,1]
  assert.equal(e.quantitativeMagnitude, null); // non-number → null, not fabricated
});

test('normalizeEvent returns null when there is no claim (fail-closed)', () => {
  assert.equal(ev({ claim: '' }), null);
});

// ── Clustering: THE acceptance test — duplicate articles collapse to one event ──
test('five reprints of one earnings beat collapse to a single cluster', () => {
  const day = '2026-07-24';
  const base = { ticker: 'ABC', eventType: 'earnings', direction: 'positive', catalystDate: day, surpriseMagnitude: 0.12, materialityScore: 0.7 };
  const events = [
    ev({ ...base, claim: 'ABC Q3 EPS beat consensus by $0.12', headline: 'ABC tops estimates' }, [{ url: 'https://www.businesswire.com/x' }]),
    ev({ ...base, claim: 'ABC beats Q3 earnings by $0.12 per share', headline: 'ABC earnings beat' }, [{ url: 'https://www.reuters.com/x' }]),
    ev({ ...base, claim: 'ABC Q3 EPS beats by $0.12', headline: 'Earnings beat at ABC' }, [{ url: 'https://www.cnbc.com/x' }]),
    ev({ ...base, claim: 'ABC reports Q3 EPS beat of $0.12', headline: 'ABC beat' }, [{ url: 'https://finance.yahoo.com/x' }]),
    ev({ ...base, claim: 'ABC Q3 earnings beat by $0.12', headline: 'ABC beats' }, [{ url: 'https://www.benzinga.com/x' }]),
  ];
  const clusters = clusterEvents(events);
  assert.equal(clusters.length, 1, 'all five reprints must be one cluster');
  assert.equal(clusters[0].coverageCount, 5);
  assert.equal(clusters[0].derivativeCount, 4, 'four reprints add no independent evidence');
  assert.equal(clusters[0].hasPrimarySource, true, 'businesswire is primary');
  // the primary event should be the businesswire (primary-source) one
  assert.ok(clusters[0].primary.sourceType === 'primary_release' || clusters[0].primary.primarySourceCount > 0);
});

test('distinct events on the same ticker stay separate clusters', () => {
  const earnings = ev({ ticker: 'XYZ', claim: 'XYZ beats Q3 earnings', eventType: 'earnings', direction: 'positive', catalystDate: '2026-07-24' });
  const lawsuit = ev({ ticker: 'XYZ', claim: 'XYZ faces securities class action lawsuit', eventType: 'litigation', direction: 'negative', catalystDate: '2026-07-24' });
  const clusters = clusterEvents([earnings, lawsuit]);
  assert.equal(clusters.length, 2, 'different event types must not merge');
});

test('fingerprint ignores case/time but respects ticker+type+day+magnitude', () => {
  const a = ev({ ticker: 'AA', claim: 'x', eventType: 'guidance', catalystDate: '2026-07-24', newValue: 10 });
  const b = ev({ ticker: 'AA', claim: 'y', eventType: 'guidance', catalystDate: '2026-07-24', newValue: 10 });
  assert.equal(fingerprint(a), fingerprint(b));
});

// ── Consensus: duplicate coverage does NOT inflate the score ───────────────────
test('consensus over 5 reprints of ONE event = one-family score, with duplication penalty', () => {
  const base = { ticker: 'ABC', eventType: 'earnings', direction: 'positive', catalystDate: '2026-07-24', surpriseMagnitude: 0.12, materialityScore: 0.7, noveltyScore: 0.6 };
  const events = Array.from({ length: 5 }, (_, i) =>
    ev({ ...base, claim: `ABC Q3 EPS beat by $0.12 (${i})` }, [{ url: 'https://www.reuters.com/x' }]));
  const clusters = clusterEvents(events);
  const one = clusterEvents([events[0]]);
  const r5 = scoreConsensus({ clusters });
  const r1 = scoreConsensus({ clusters: one });
  // one event, one family — breadth identical whether 1 or 5 reprints
  assert.equal(r5.distinctFamilies, r1.distinctFamilies);
  assert.equal(r5.clusterCount, 1);
  assert.ok(r5.penalties.duplication < 0, 'reprints incur a duplication penalty');
  assert.ok(r5.score <= r1.score, 'more reprints must NOT raise consensus');
});

test('two INDEPENDENT families score higher than one family alone', () => {
  const day = '2026-07-24';
  const earnings = ev({ ticker: 'ABC', claim: 'ABC beats earnings', eventType: 'earnings', direction: 'positive', catalystDate: day, materialityScore: 0.7 }, [{ url: 'https://www.businesswire.com/x' }]);
  const insider = ev({ ticker: 'ABC', claim: 'ABC CEO buys $2M shares', eventType: 'insider_activity', direction: 'positive', catalystDate: day, materialityScore: 0.7 }, [{ url: 'https://www.sec.gov/x' }]);
  const two = scoreConsensus({ clusters: clusterEvents([earnings, insider]) });
  const one = scoreConsensus({ clusters: clusterEvents([earnings]) });
  assert.ok(two.distinctFamilies > one.distinctFamilies);
  assert.ok(two.score > one.score, 'genuine independent breadth raises consensus');
});

test('consensus returns insufficient_evidence with no clusters', () => {
  const r = scoreConsensus({ clusters: [] });
  assert.equal(r.state, 'insufficient_evidence');
  assert.equal(r.score, 0);
});

test('conflicting positive+negative events incur a contradiction penalty', () => {
  const day = '2026-07-24';
  const good = ev({ ticker: 'ABC', claim: 'ABC beats earnings', eventType: 'earnings', direction: 'positive', catalystDate: day }, [{ url: 'https://www.businesswire.com/x' }]);
  const bad = ev({ ticker: 'ABC', claim: 'ABC guidance cut on weak demand', eventType: 'guidance', direction: 'negative', catalystDate: day }, [{ url: 'https://www.reuters.com/x' }]);
  const r = scoreConsensus({ clusters: clusterEvents([good, bad]) });
  assert.equal(r.conflicting, true);
  assert.ok(r.penalties.contradiction < 0);
});

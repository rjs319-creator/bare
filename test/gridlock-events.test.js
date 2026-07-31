'use strict';
// GRIDLOCK extraction: deterministic classification/grounding + LLM-output
// validation (the LLM can never invent numbers, dates, regions). Synthetic text.
const test = require('node:test');
const assert = require('node:assert');
const GE = require('../lib/gridlock-events');

test('classifyEventType recognizes the core physical event families', () => {
  assert.strictEqual(GE.classifyEventType('Hyperscaler plans 500 MW data center campus in Ohio'), 'DATA_CENTER_LOAD');
  assert.strictEqual(GE.classifyEventType('Utility signs 20-year power purchase agreement for nuclear output'), 'POWER_PURCHASE_AGREEMENT');
  assert.strictEqual(GE.classifyEventType('Operator to retire 1,200 MW coal plant next year'), 'GENERATOR_RETIREMENT');
  assert.strictEqual(GE.classifyEventType('PJM base residual auction clears at record price'), 'CAPACITY_AUCTION');
  assert.strictEqual(GE.classifyEventType('Manufacturer books order for seven gas turbines'), 'TURBINE_ORDER');
  assert.strictEqual(GE.classifyEventType('Developer cancels gas plant project in Virginia'), 'PROJECT_CANCELLATION');
  assert.strictEqual(GE.classifyEventType('Quarterly earnings beat on cloud growth'), null);
});

test('extractMW and extractUSD ground quantities from literal text only', () => {
  assert.deepStrictEqual(GE.extractMW('a 960 MW campus plus 4.5 GW of gas'), [960, 4500]);
  assert.deepStrictEqual(GE.extractMW('a 1,200-megawatt plant'), [1200]);
  assert.deepStrictEqual(GE.extractMW('no numbers here'), []);
  assert.deepStrictEqual(GE.extractUSD('a $650 million sale and $16 billion plan'), [650e6, 16e9]);
});

test('detectStateIso maps states deterministically; the LLM never assigns ISO regions', () => {
  assert.deepStrictEqual(GE.detectStateIso('a campus in Pennsylvania'), { state: 'PENNSYLVANIA', isoRegion: 'PJM' });
  assert.strictEqual(GE.detectStateIso('a campus in PJM territory').isoRegion, 'PJM');
  assert.strictEqual(GE.detectStateIso('a campus in Texas').isoRegion, null);   // ERCOT not in slice 1
});

test('groundExtraction drops LLM-invented megawatts, dollars and dates', () => {
  const text = 'The 960 MW Riverbend campus in Pennsylvania was announced with a $650 million commitment.';
  const proposal = {
    eventType: 'DATA_CENTER_LOAD',
    demandDeltaMW: 960,           // grounded — appears in text
    generationDeltaMW: 1500,      // INVENTED — not in text
    capexAmount: 650e6,           // grounded
    contractValue: 2e9,           // INVENTED
    effectiveStartDate: '2027-01-01', // INVENTED (year not in text)
    certainty: 'ANNOUNCED',
    companiesNamed: ['Riverbend'],
    summary: 'campus announcement',
  };
  const { grounded, dropped } = GE.groundExtraction(proposal, text);
  assert.strictEqual(grounded.demandDeltaMW, 960);
  assert.strictEqual(grounded.generationDeltaMW, null);
  assert.strictEqual(grounded.capexAmount, 650e6);
  assert.strictEqual(grounded.contractValue, null);
  assert.strictEqual(grounded.effectiveStartDate, null);
  assert.ok(dropped.includes('generationDeltaMW') && dropped.includes('contractValue') && dropped.includes('effectiveStartDate'));
  assert.strictEqual(grounded.isoRegion, 'PJM');           // from the state map, not the proposal
  assert.ok(grounded.extractionConfidence < 0.8);          // confidence reduced by drops
});

test('groundExtraction whitelists enums and never trusts unknown event types', () => {
  const { grounded, dropped } = GE.groundExtraction({ eventType: 'MOON_LASER', summary: 'x' }, 'text');
  assert.strictEqual(grounded.eventType, null);
  assert.ok(dropped.includes('eventType'));
});

test('buildEventFromArticle: classified + regional articles become valid events; others are dropped', () => {
  const art = {
    title: 'Developer announces 750 MW data center campus in Virginia',
    text: 'The project would add 750 MW of load near Ashburn, Virginia.',
    url: 'https://example.test/a1', publisher: 'SyntheticWire',
    publishedAt: '2026-07-10', retrievedAt: '2026-07-11',
  };
  const ev = GE.buildEventFromArticle(art, { todayIso: '2026-07-11' });
  assert.ok(ev);
  assert.strictEqual(ev.eventType, 'DATA_CENTER_LOAD');
  assert.strictEqual(ev.isoRegion, 'PJM');
  assert.strictEqual(ev.demandDeltaMW, 750);               // single unambiguous MW figure
  assert.strictEqual(ev.affectedTickers.length, 0);        // tickers come from the graph, never extraction
  assert.ok(ev.unresolvedFields.includes('capexAmount'));
  // No region → dropped (first slice only attributes supported regions).
  assert.strictEqual(GE.buildEventFromArticle({ ...art, title: 'Developer announces 750 MW data center campus', text: 'somewhere unknown' }, { todayIso: '2026-07-11' }), null);
  // No physical event type → dropped.
  assert.strictEqual(GE.buildEventFromArticle({ ...art, title: 'CEO discusses culture', text: 'no physical content, Virginia' }, { todayIso: '2026-07-11' }), null);
});

test('ambiguous MW figures are NOT guessed onto fields', () => {
  const art = {
    title: 'Data center campus in Ohio', text: 'Plans mention 300 MW now and 900 MW later.',
    publisher: 'SyntheticWire', publishedAt: '2026-07-10', retrievedAt: '2026-07-11',
  };
  const ev = GE.buildEventFromArticle(art, { todayIso: '2026-07-11' });
  assert.ok(ev);
  assert.strictEqual(ev.demandDeltaMW, null);              // two figures → ambiguous → null
});

test('foldIntoLedger dedups by canonical id (merge) and appends new events', () => {
  const art = (title) => GE.buildEventFromArticle({
    title, text: 'A 500 MW data center campus in Maryland.', url: `https://example.test/${title}`,
    publisher: 'SyntheticWire', publishedAt: '2026-07-10', retrievedAt: '2026-07-11',
  }, { todayIso: '2026-07-11' });
  const a = art('Oakfield data center campus adds 500 MW in Maryland');
  const b = art('Oakfield data center campus adds 500 MW in Maryland'); // same story, new source id via url? same → merge no-op
  const r1 = GE.foldIntoLedger({}, [a]);
  assert.strictEqual(r1.added, 1);
  const r2 = GE.foldIntoLedger(r1.ledger, [b]);
  assert.strictEqual(r2.added, 0);
  assert.strictEqual(r2.merged, 1);
  assert.strictEqual(Object.keys(r2.ledger).length, 1);
});

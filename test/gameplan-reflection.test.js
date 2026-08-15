'use strict';
// GAME-PLAN REFLECTION LOOP — guard tests: pending-never-injects-as-record, deterministic
// tone-vs-SPY scoring with a dead zone, fail-open resolution, immutable ledger ops,
// same-date latest-wins, prompt-block honesty, and the route/prompt wiring.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../lib/gameplan-reflection');
const gp = require('../lib/gameplan');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const candle = (date, close) => ({ date, close });
// Mon..Fri closes: 100, then +1% steps up.
const SPY = [
  candle('2026-08-03', 100), candle('2026-08-04', 101), candle('2026-08-05', 102),
  candle('2026-08-06', 103), candle('2026-08-07', 104), candle('2026-08-10', 105),
];

test('recordPlan appends a pending entry, clips predictions, and never mutates the input', () => {
  const doc = { entries: [{ date: '2026-08-01', tone: 'neutral', predictions: [], status: 'pending' }] };
  const frozen = JSON.stringify(doc);
  const next = R.recordPlan(doc, {
    date: '2026-08-03', tone: 'cautious', headline: 'h',
    predictions: [{ call: 'x'.repeat(500), confidence: 'medium', horizon: 'this week' }, { call: 'b' }, { call: 'c' }, { call: 'dropped-over-cap' }],
  });
  assert.equal(JSON.stringify(doc), frozen, 'input doc must not be mutated');
  assert.equal(next.entries.length, 2);
  const e = next.entries[1];
  assert.equal(e.status, 'pending');
  assert.equal(e.tone, 'cautious');
  assert.equal(e.predictions.length, 3, 'predictions capped');
  assert.ok(e.predictions[0].call.length <= 160, 'call clipped');
});

test('recordPlan is same-date latest-wins and caps the ledger at MAX_ENTRIES', () => {
  let doc = { entries: [] };
  doc = R.recordPlan(doc, { date: '2026-08-03', tone: 'risk-on', predictions: [] });
  doc = R.recordPlan(doc, { date: '2026-08-03', tone: 'risk-off', predictions: [] });
  assert.equal(doc.entries.length, 1);
  assert.equal(doc.entries[0].tone, 'risk-off');
  for (let i = 0; i < R.MAX_ENTRIES + 10; i++) {
    doc = R.recordPlan(doc, { date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}x${i}`, tone: 'neutral', predictions: [] });
  }
  assert.ok(doc.entries.length <= R.MAX_ENTRIES, 'ledger capped');
});

test('recordPlan stores an unknown tone as null (never a scoreable lean by accident)', () => {
  const doc = R.recordPlan({ entries: [] }, { date: '2026-08-03', tone: 'euphoric', predictions: [] });
  assert.equal(doc.entries[0].tone, null);
});

test('resolveEntries scores a bullish lean right on an up-tape and never mutates input', () => {
  const doc = R.recordPlan({ entries: [] }, { date: '2026-08-03', tone: 'risk-on', predictions: [] });
  const frozen = JSON.stringify(doc);
  const next = R.resolveEntries(doc, SPY, '2026-08-10T00:00:00Z');
  assert.equal(JSON.stringify(doc), frozen, 'input doc must not be mutated');
  const e = next.entries[0];
  assert.equal(e.status, 'resolved');
  assert.equal(e.resolved.verdict, 'right');
  assert.equal(e.resolved.sessions, R.RESOLVE_SESSIONS);
  assert.equal(e.resolved.spyFwdPct, 3, '100 → 103 over 3 sessions = +3%');
});

test('resolveEntries scores a bearish lean wrong on an up-tape and neutral as no-lean', () => {
  let doc = R.recordPlan({ entries: [] }, { date: '2026-08-03', tone: 'risk-off', predictions: [] });
  doc = R.recordPlan(doc, { date: '2026-08-04', tone: 'neutral', predictions: [] });
  const next = R.resolveEntries(doc, SPY, '2026-08-10T00:00:00Z');
  assert.equal(next.entries[0].resolved.verdict, 'wrong');
  assert.equal(next.entries[1].resolved.verdict, 'no-lean');
});

test('resolveEntries applies the dead zone: a sub-threshold move is flat, not right/wrong', () => {
  const flatTape = [candle('2026-08-03', 100), candle('2026-08-04', 100.05), candle('2026-08-05', 100.1), candle('2026-08-06', 100.1), candle('2026-08-07', 100.2)];
  const doc = R.recordPlan({ entries: [] }, { date: '2026-08-03', tone: 'risk-on', predictions: [] });
  const next = R.resolveEntries(doc, flatTape, '2026-08-10T00:00:00Z');
  assert.equal(next.entries[0].resolved.verdict, 'flat');
});

test('resolveEntries is fail-open: an immature entry stays pending untouched', () => {
  const doc = R.recordPlan({ entries: [] }, { date: '2026-08-07', tone: 'risk-on', predictions: [] });
  const next = R.resolveEntries(doc, SPY, '2026-08-10T00:00:00Z');
  assert.equal(next.entries[0].status, 'pending', 'only 1 forward session available — must stay pending');
  assert.equal(R.resolveEntries(doc, null, 'x'), doc, 'no candles → doc unchanged');
});

test('weekend plan anchors to the prior close (decision bar = last candle <= date)', () => {
  const doc = R.recordPlan({ entries: [] }, { date: '2026-08-08', tone: 'risk-on', predictions: [] }); // Saturday
  const next = R.resolveEntries(doc, SPY, '2026-08-10T00:00:00Z');
  assert.equal(next.entries[0].status, 'pending', 'anchored to 08-07 → needs 3 forward sessions');
  assert.equal(R.decisionIdx(SPY, '2026-08-08'), 4);
});

test('reflectionBlock: pending entries NEVER appear as measured record, only as open predictions', () => {
  let doc = R.recordPlan({ entries: [] }, { date: '2026-08-03', tone: 'risk-on', predictions: [] });
  doc = R.resolveEntries(doc, SPY, '2026-08-10T00:00:00Z');
  doc = R.recordPlan(doc, { date: '2026-08-10', tone: 'risk-off', predictions: [{ call: 'SPX fades this week', confidence: 'medium', horizon: 'this week' }] });
  const block = R.reflectionBlock(doc);
  assert.match(block, /MEASURED RECORD/);
  assert.match(block, /\[2026-08-03\] tone=risk-on → SPY \+3% → RIGHT/);
  assert.doesNotMatch(block, /\[2026-08-10\] tone=risk-off → SPY/, 'a pending entry must never render as record');
  assert.match(block, /OPEN PREDICTIONS/);
  assert.match(block, /SPX fades this week/);
  assert.match(block, /confirmed, invalidated, or still open/);
});

test('reflectionBlock is honest framing: data-not-instructions, and empty when nothing to say', () => {
  let doc = R.recordPlan({ entries: [] }, { date: '2026-08-03', tone: 'risk-on', predictions: [] });
  doc = R.resolveEntries(doc, SPY, '2026-08-10T00:00:00Z');
  const block = R.reflectionBlock(doc);
  assert.match(block, /not instructions/i);
  assert.match(block, /deterministic/i);
  assert.equal(R.reflectionBlock({ entries: [] }), '');
  const onlyPendingNoPreds = R.recordPlan({ entries: [] }, { date: '2026-08-10', tone: 'neutral', predictions: [] });
  assert.equal(R.reflectionBlock(onlyPendingNoPreds), '', 'a pending entry with no predictions renders nothing');
});

test('reflectionBlock caps rendered records and aggregates the full resolved history', () => {
  let doc = { entries: [] };
  for (let i = 1; i <= 9; i++) doc = R.recordPlan(doc, { date: `2026-07-0${i > 4 ? i - 4 : i}T${i}`, tone: 'risk-on', predictions: [] });
  doc = { entries: doc.entries.map((e) => ({ ...e, status: 'resolved', resolved: { at: 'x', spyFwdPct: 1, sessions: 3, verdict: 'right' } })) };
  const block = R.reflectionBlock(doc);
  const recordLines = block.split('\n').filter((l) => l.startsWith('- [')).length;
  assert.ok(recordLines <= R.MAX_RESOLVED_IN_PROMPT, `at most ${R.MAX_RESOLVED_IN_PROMPT} record lines, got ${recordLines}`);
  assert.match(block, /all 9 resolved plans: right 9/);
});

test('toneRecord counts verdict classes', () => {
  const entries = [
    { status: 'resolved', resolved: { verdict: 'right' } },
    { status: 'resolved', resolved: { verdict: 'wrong' } },
    { status: 'resolved', resolved: { verdict: 'flat' } },
    { status: 'pending' },
  ];
  assert.deepEqual(R.toneRecord(entries), { right: 1, wrong: 1, flat: 1, noLean: 0 });
});

test('buildUserMessage carries the reflection block between headlines and prior narrative', () => {
  const msg = gp.buildUserMessage({
    date: '2026-08-10', macro: null, headlines: [{ title: 'h1' }], signals: null,
    reflection: 'MEASURED RECORD of your prior plans (x):\n- [2026-08-03] tone=risk-on → SPY +3% → RIGHT',
    priorNarrative: 'prior story',
  });
  assert.match(msg, /MEASURED RECORD/);
  assert.ok(msg.indexOf('MEASURED RECORD') > msg.indexOf('h1'), 'after headlines');
  assert.ok(msg.indexOf('MEASURED RECORD') < msg.indexOf('PRIOR NARRATIVE'), 'before prior narrative');
  assert.doesNotMatch(gp.buildUserMessage({ date: 'd', headlines: [] }), /MEASURED RECORD/, 'absent when not provided');
});

test('SYSTEM prompt instructs calibration-correction and open-prediction accountability', () => {
  assert.match(gp.SYSTEM, /MEASURED RECORD/);
  assert.match(gp.SYSTEM, /OPEN PREDICTION/);
  assert.match(gp.SYSTEM, /never self-reported/);
});

test('route wiring: resolve before synthesize, record after persist, pending-safe fail-open', () => {
  const src = read('lib/gameplan-routes.js');
  assert.match(src, /require\('\.\/gameplan-reflection'\)/);
  assert.match(src, /resolveEntries\(reflectionDoc, spy\.candles/);
  assert.match(src, /reflection: reflectionText/);
  assert.match(src, /recordPlan\(reflectionDoc/);
  assert.match(src, /resolution deferred — entries stay pending/);
  assert.ok(src.indexOf('resolveEntries') < src.indexOf('gp.synthesize'), 'resolution happens before synthesis');
  assert.ok(src.indexOf('recordPlan') > src.indexOf('gp.synthesize'), 'recording happens after synthesis');
});

test('frozen scoring constants (drift here silently changes every future lesson)', () => {
  assert.equal(R.RESOLVE_SESSIONS, 3);
  assert.equal(R.DEAD_ZONE_PCT, 0.25);
  assert.deepEqual(R.TONE_LEAN, { 'risk-on': 1, constructive: 1, neutral: 0, cautious: -1, 'risk-off': -1 });
  assert.equal(R.KEY, 'gameplan/reflection.json');
});

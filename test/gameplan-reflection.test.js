'use strict';
// GAME-PLAN REFLECTION LOOP — guard tests: pending-never-injects-as-record, deterministic
// tone-vs-SPY scoring on COMPLETED bars only (forming-bar freeze hazard), dead zone,
// fail-open resolution + 'expired' close-out, prediction lifecycle decoupled from tone
// resolution (14-day window, oldest-first cap), immutable ledger ops, same-date
// latest-wins, prompt-block honesty, and the route/prompt wiring (ET date anchor,
// decoupled persistence, rebase-before-record).
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
const ASOF = '2026-08-11';   // strictly after the last candle → every bar above is completed

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
    doc = R.recordPlan(doc, { date: `2026-02-${String((i % 28) + 1).padStart(2, '0')}#${i}`, tone: 'neutral', predictions: [] });
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
  const next = R.resolveEntries(doc, SPY, '2026-08-11T00:00:00Z', ASOF);
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
  const next = R.resolveEntries(doc, SPY, '2026-08-11T00:00:00Z', ASOF);
  assert.equal(next.entries[0].resolved.verdict, 'wrong');
  assert.equal(next.entries[1].resolved.verdict, 'no-lean');
});

test('resolveEntries applies the dead zone: a sub-threshold move is flat, not right/wrong', () => {
  const flatTape = [candle('2026-08-03', 100), candle('2026-08-04', 100.05), candle('2026-08-05', 100.1), candle('2026-08-06', 100.1), candle('2026-08-07', 100.2)];
  const doc = R.recordPlan({ entries: [] }, { date: '2026-08-03', tone: 'risk-on', predictions: [] });
  const next = R.resolveEntries(doc, flatTape, '2026-08-11T00:00:00Z', ASOF);
  assert.equal(next.entries[0].resolved.verdict, 'flat');
});

test('FORMING-BAR GUARD: a verdict is never frozen against a bar dated on/after the as-of date', () => {
  // Exit bar would be 2026-08-06; pretend today IS 08-06 (that bar may be live intraday).
  const doc = R.recordPlan({ entries: [] }, { date: '2026-08-03', tone: 'risk-on', predictions: [] });
  const sameDay = R.resolveEntries(doc, SPY, '2026-08-06T15:00:00Z', '2026-08-06');
  assert.equal(sameDay.entries[0].status, 'pending', 'exit bar dated today may be forming — must defer');
  const nextDay = R.resolveEntries(doc, SPY, '2026-08-07T00:00:00Z', '2026-08-07');
  assert.equal(nextDay.entries[0].status, 'resolved', 'the completed bar scores the next day');
  assert.equal(R.resolveEntries(doc, SPY, 'x', null), doc, 'no as-of date → nothing scores');
});

test('resolveEntries is fail-open: an immature entry stays pending untouched', () => {
  const doc = R.recordPlan({ entries: [] }, { date: '2026-08-07', tone: 'risk-on', predictions: [] });
  const next = R.resolveEntries(doc, SPY, '2026-08-11T00:00:00Z', ASOF);
  assert.equal(next.entries[0].status, 'pending', 'only 1 forward session available — must stay pending');
  assert.equal(R.resolveEntries(doc, null, 'x', ASOF), doc, 'no candles → doc unchanged');
});

test('an entry predating the candle window resolves as expired instead of pending forever', () => {
  const doc = R.recordPlan({ entries: [] }, { date: '2025-01-02', tone: 'risk-on', predictions: [] });
  const next = R.resolveEntries(doc, SPY, '2026-08-11T00:00:00Z', ASOF);
  assert.equal(next.entries[0].status, 'resolved');
  assert.equal(next.entries[0].resolved.verdict, 'expired');
  assert.equal(next.entries[0].resolved.spyFwdPct, null);
});

test('weekend plan anchors to the prior close (decision bar = last candle <= date)', () => {
  const doc = R.recordPlan({ entries: [] }, { date: '2026-08-08', tone: 'risk-on', predictions: [] }); // Saturday
  const next = R.resolveEntries(doc, SPY, '2026-08-11T00:00:00Z', ASOF);
  assert.equal(next.entries[0].status, 'pending', 'anchored to 08-07 → needs 3 forward sessions');
});

test('reflectionBlock: pending entries NEVER appear as measured record', () => {
  let doc = R.recordPlan({ entries: [] }, { date: '2026-08-03', tone: 'risk-on', predictions: [] });
  doc = R.resolveEntries(doc, SPY, '2026-08-11T00:00:00Z', ASOF);
  doc = R.recordPlan(doc, { date: '2026-08-10', tone: 'risk-off', predictions: [{ call: 'SPX fades this week', confidence: 'medium', horizon: 'this week' }] });
  const block = R.reflectionBlock(doc, ASOF);
  assert.match(block, /MEASURED RECORD/);
  assert.match(block, /\[2026-08-03\] tone=risk-on → SPY \+3% → RIGHT/);
  assert.doesNotMatch(block, /\[2026-08-10\] tone=risk-off → SPY/, 'a pending entry must never render as record');
  assert.match(block, /OPEN PREDICTIONS/);
  assert.match(block, /SPX fades this week/);
  assert.match(block, /confirmed, invalidated, or still open/);
});

test('PREDICTION LIFECYCLE: predictions survive tone resolution and age out after the window', () => {
  let doc = R.recordPlan({ entries: [] }, { date: '2026-08-03', tone: 'risk-on', predictions: [{ call: 'NVDA reclaims $200 in 1-2 weeks', confidence: 'medium', horizon: '1-2 weeks' }] });
  doc = R.resolveEntries(doc, SPY, '2026-08-11T00:00:00Z', ASOF);
  assert.equal(doc.entries[0].status, 'resolved', 'tone resolved at 3 sessions');
  const block = R.reflectionBlock(doc, ASOF);
  assert.match(block, /NVDA reclaims \$200/, 'a resolved-tone entry keeps its predictions visible inside the window');
  const aged = R.reflectionBlock(doc, '2026-09-01');
  assert.doesNotMatch(aged, /NVDA reclaims/, `predictions age out after ${R.PREDICTION_WINDOW_DAYS} days`);
  // Today's own (same-date) entry never self-injects.
  const todayOnly = R.recordPlan({ entries: [] }, { date: ASOF, tone: 'neutral', predictions: [{ call: 'today call' }] });
  assert.doesNotMatch(R.reflectionBlock(todayOnly, ASOF), /today call/);
});

test('open predictions render OLDEST first — the cap drops the newest, not the nearest-maturity', () => {
  let doc = { entries: [] };
  for (const d of ['2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-10']) {
    doc = R.recordPlan(doc, { date: d, tone: 'neutral', predictions: [{ call: `call-${d}` }] });
  }
  const block = R.reflectionBlock(doc, ASOF);
  assert.match(block, /call-2026-08-04/);
  assert.match(block, /call-2026-08-06/);
  assert.doesNotMatch(block, /call-2026-08-10/, 'newest beyond the cap is deferred, oldest kept');
});

test('reflectionBlock is honest framing, expired carries no record line, empty when nothing to say', () => {
  let doc = R.recordPlan({ entries: [] }, { date: '2026-08-03', tone: 'risk-on', predictions: [] });
  doc = R.resolveEntries(doc, SPY, '2026-08-11T00:00:00Z', ASOF);
  const block = R.reflectionBlock(doc, ASOF);
  assert.match(block, /not instructions/i);
  assert.match(block, /deterministic/i);
  assert.match(block, /completed sessions/);
  assert.equal(R.reflectionBlock({ entries: [] }, ASOF), '');
  const expiredOnly = { entries: [{ date: '2025-01-02', tone: 'risk-on', predictions: [], status: 'resolved', resolved: { verdict: 'expired', spyFwdPct: null } }] };
  assert.equal(R.reflectionBlock(expiredOnly, ASOF), '', 'expired entries carry no information — render nothing');
});

test('reflectionBlock caps rendered records and aggregates the full resolved history', () => {
  let doc = { entries: [] };
  for (let i = 1; i <= 9; i++) doc = R.recordPlan(doc, { date: `2026-07-0${i > 4 ? i - 4 : i}#${i}`, tone: 'risk-on', predictions: [] });
  doc = { entries: doc.entries.map((e) => ({ ...e, status: 'resolved', resolved: { at: 'x', spyFwdPct: 1, sessions: 3, verdict: 'right' } })) };
  const block = R.reflectionBlock(doc, ASOF);
  const recordLines = block.split('\n').filter((l) => l.startsWith('- [')).length;
  assert.ok(recordLines <= R.MAX_RESOLVED_IN_PROMPT, `at most ${R.MAX_RESOLVED_IN_PROMPT} record lines, got ${recordLines}`);
  assert.match(block, /all 9 scored plans: right 9/);
});

test('hasMaturablePending gates the SPY fetch: nothing maturable → false', () => {
  assert.equal(R.hasMaturablePending({ entries: [] }, ASOF), false);
  const fresh = R.recordPlan({ entries: [] }, { date: '2026-08-10', tone: 'risk-on', predictions: [] });
  assert.equal(R.hasMaturablePending(fresh, ASOF), false, 'a 1-day-old entry cannot have 3 completed forward sessions');
  const old = R.recordPlan({ entries: [] }, { date: '2026-08-03', tone: 'risk-on', predictions: [] });
  assert.equal(R.hasMaturablePending(old, ASOF), true);
  const resolved = { entries: [{ date: '2026-08-01', status: 'resolved', resolved: { verdict: 'right' } }] };
  assert.equal(R.hasMaturablePending(resolved, ASOF), false, 'resolved entries need no fetch');
});

test('toneRecord counts verdict classes including expired', () => {
  const entries = [
    { status: 'resolved', resolved: { verdict: 'right' } },
    { status: 'resolved', resolved: { verdict: 'wrong' } },
    { status: 'resolved', resolved: { verdict: 'flat' } },
    { status: 'resolved', resolved: { verdict: 'expired' } },
    { status: 'pending' },
  ];
  assert.deepEqual(R.toneRecord(entries), { right: 1, wrong: 1, flat: 1, noLean: 0, expired: 1 });
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

test('SYSTEM prompt instructs calibration-correction with a per-clause budget that cannot collide with the tightness cap', () => {
  assert.match(gp.SYSTEM, /MEASURED RECORD/);
  assert.match(gp.SYSTEM, /OPEN PREDICTION/);
  assert.match(gp.SYSTEM, /never self-reported/);
  assert.match(gp.SYSTEM, /short clause each/, 'per-prediction resolution must be clause-sized, not sentence-sized');
  assert.match(gp.SYSTEM, /extend narrativeUpdate beyond its usual cap/, 'explicitly reconciles with the <=2-sentence tightness rule');
});

test('route wiring: ET date anchor, gated SPY fetch, decoupled persistence, rebase before record', () => {
  const src = read('lib/gameplan-routes.js');
  assert.match(src, /require\('\.\/gameplan-reflection'\)/);
  assert.match(src, /const date = sessionInfoAt\(new Date\(\)\)\.etDate/, 'plan + ledger date must be the ET calendar date, not UTC');
  assert.doesNotMatch(src, /const date = new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/, 'the UTC plan-date stamp must be gone');
  assert.match(src, /hasMaturablePending/, 'SPY fetch gated on a maturable entry');
  assert.match(src, /'6mo'/, "SPY range must clear fetchDailyHistory's 60-candle floor");
  assert.match(src, /reflection: reflectionText/);
  const resolveIdx = src.indexOf('reflection.resolveEntries');
  const persistIdx = src.indexOf('writeJSON(reflection.KEY, resolvedDoc');
  const synthIdx = src.indexOf('gp.synthesize');
  assert.ok(resolveIdx > 0 && persistIdx > resolveIdx && persistIdx < synthIdx,
    'resolutions must persist immediately after resolving, BEFORE (and regardless of) the LLM call');
  assert.match(src, /readJSON\(reflection\.KEY, \{ entries: \[\] \}\)\.catch\(\(\) => reflectionDoc\)/, 're-read before record (rebase, not blind overwrite)');
  assert.ok(src.indexOf('recordPlan') > synthIdx, 'recording happens after synthesis');
});

test('frozen scoring constants (drift here silently changes every future lesson)', () => {
  assert.equal(R.RESOLVE_SESSIONS, 3);
  assert.equal(R.DEAD_ZONE_PCT, 0.25);
  assert.equal(R.PREDICTION_WINDOW_DAYS, 14);
  assert.deepEqual(R.TONE_LEAN, { 'risk-on': 1, constructive: 1, neutral: 0, cautious: -1, 'risk-off': -1 });
  assert.equal(R.KEY, 'gameplan/reflection.json');
});

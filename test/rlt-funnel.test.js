'use strict';
// RLT false-early-rate / lead-time study (pre-registered 2026-07-27). Guards:
//   - progression (reaching a forward rung) and failure (explicit WEAKENING/
//     INVALIDATED/EXPIRED/DROPPED) are told apart correctly, and a still-open
//     episode is CENSORED, never silently counted as a failure;
//   - lead time is measured in accrued sessions from first entry to the
//     resolving transition;
//   - a demotion to an earlier, non-failure rung does not resolve the episode
//     — the scan keeps looking forward instead of giving up early;
//   - re-entering the same base state after a demotion is a second,
//     independent episode (entries can exceed distinct tickers);
//   - the <40-distinct-date sample-too-thin flag fires but still reports
//     whatever is there, instead of withholding it or pretending certainty;
//   - a per-sector split is withheld below the entry floor rather than
//     fabricated from a handful of names;
//   - duplicate cross-section documents for the same date are a no-op
//     (write-once data fed twice must not double-count).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildFunnelStudy, STUDY_BASES, DEFAULT_MIN_DATES_FOR_VERDICT } = require('../lib/rlt-funnel');

// One cross-section "day" with a set of transitions. `date` is a YYYY-MM-DD
// string; `rows` carries the sector lookup the way rlt-scan's `observations`
// does (only ticker+sector matter here).
function day(date, transitions, sectorByTicker = {}) {
  const rows = Object.entries(sectorByTicker).map(([ticker, sector]) => ({ ticker, sector }));
  return { schema: 'RltCrossSection', date, rows, transitions: transitions.map(t => ({ session: date, ...t })) };
}

// A run of consecutive trading-day dates, Mon-Fri only, starting at a fixed
// anchor so fixtures are deterministic across runs.
function dates(n, startIndex = 0) {
  const out = [];
  const d = new Date('2026-08-03T00:00:00Z');   // a Monday
  let i = 0, produced = 0;
  while (produced < startIndex + n) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) { if (produced >= startIndex) out.push(d.toISOString().slice(0, 10)); produced++; }
    d.setUTCDate(d.getUTCDate() + 1);
    i++;
  }
  return out;
}

test('progressed vs failed vs censored are told apart, and lead time is sessions-to-resolution', () => {
  const d = dates(6);
  const docs = [
    day(d[0], [
      { ticker: 'AAA', prevState: 'DISCOVERED', newState: 'EMERGING_LEADER' },
      { ticker: 'BBB', prevState: 'DISCOVERED', newState: 'EMERGING_LEADER' },
      { ticker: 'CCC', prevState: 'DISCOVERED', newState: 'EMERGING_LEADER' },
    ], { AAA: 'Technology', BBB: 'Technology', CCC: 'Technology' }),
    day(d[2], [{ ticker: 'AAA', prevState: 'EMERGING_LEADER', newState: 'PRIMED' }]),
    day(d[3], [{ ticker: 'BBB', prevState: 'EMERGING_LEADER', newState: 'WEAKENING' }]),
    // CCC gets no further transition at all — still open at the data cutoff.
  ];
  const study = buildFunnelStudy(docs, { minEntriesPerSplit: 1 });
  const el = study.perBase.EMERGING_LEADER;
  assert.equal(el.entries, 3);
  assert.equal(el.progressed, 1);
  assert.equal(el.failed, 1);
  assert.equal(el.censored, 1);
  assert.equal(el.resolvedForRate, 2);
  assert.equal(el.progressionRateAmongResolved, 0.5);
  // Sessions are indexed over ACCRUED dates only (d[0], d[2], d[3] have docs; d[1]
  // does not), so AAA's entry (session 0) and resolution (session 1) are 1 apart.
  assert.deepEqual(el.leadTimeSessions, { n: 1, median: 1, p25: 1, p75: 1, min: 1, max: 1 });
});

test('a demotion to an earlier non-failure rung does not resolve the episode', () => {
  const d = dates(6);
  const docs = [
    day(d[0], [{ ticker: 'ZZZ', prevState: 'DISCOVERED', newState: 'EMERGING_LEADER' }], { ZZZ: 'Energy' }),
    day(d[1], [{ ticker: 'ZZZ', prevState: 'EMERGING_LEADER', newState: 'DISCOVERED' }]),   // setback, not a verdict
    day(d[4], [{ ticker: 'ZZZ', prevState: 'DISCOVERED', newState: 'PRIMED' }]),            // later reaches PRIMED anyway
  ];
  const study = buildFunnelStudy(docs, { minEntriesPerSplit: 1 });
  const el = study.perBase.EMERGING_LEADER;
  assert.equal(el.entries, 1);
  assert.equal(el.progressed, 1, 'the demotion must not have been scored as a failure or a stop');
  // Accrued-session calendar here is [d0, d1, d4] (3 distinct dates) ⇒ sessions 0,1,2.
  assert.equal(el.leadTimeSessions.median, 2);
});

test('re-entering the same base state after a demotion counts as a second, independent episode', () => {
  const d = dates(10);
  const docs = [
    day(d[0], [{ ticker: 'QQQ', prevState: 'DISCOVERED', newState: 'EMERGING_LEADER' }], { QQQ: 'Financials' }),
    day(d[1], [{ ticker: 'QQQ', prevState: 'EMERGING_LEADER', newState: 'DISCOVERED' }]),
    day(d[3], [{ ticker: 'QQQ', prevState: 'DISCOVERED', newState: 'EMERGING_LEADER' }]),   // re-entry: entry #2
    day(d[5], [{ ticker: 'QQQ', prevState: 'EMERGING_LEADER', newState: 'PRIMED' }]),        // resolves BOTH entries
  ];
  const study = buildFunnelStudy(docs, { minEntriesPerSplit: 1 });
  const el = study.perBase.EMERGING_LEADER;
  assert.equal(el.entries, 2, 'one ticker, two independent entries into EMERGING_LEADER');
  assert.equal(el.progressed, 2);
  // Accrued-session calendar is [d0, d1, d3, d5] ⇒ sessions 0,1,2,3. Entry #1 (session 0)
  // and entry #2 (session 2, the re-entry) both resolve at session 3 — lead times 3 and 1.
  assert.equal(el.leadTimeSessions.min, 1);
  assert.equal(el.leadTimeSessions.max, 3);
});

test('below the 40-distinct-date floor the result is flagged INCONCLUSIVE but still reports what exists', () => {
  const d = dates(5);
  const docs = d.map((date, i) => day(date, i === 0
    ? [{ ticker: 'SOLO', prevState: 'DISCOVERED', newState: 'EMERGING_LEADER' }]
    : [], { SOLO: 'Industrials' }));
  const study = buildFunnelStudy(docs, { minEntriesPerSplit: 1 });
  assert.equal(study.dateCoverage.distinctDates, 5);
  assert.equal(study.sampleTooThin, true);
  assert.equal(study.minDatesForVerdict, DEFAULT_MIN_DATES_FOR_VERDICT);
  assert.match(study.verdict, /INCONCLUSIVE/);
  // Still reports the (tiny) sample rather than withholding it.
  assert.equal(study.perBase.EMERGING_LEADER.entries, 1);
});

test('a per-sector split is withheld below the entry floor, never fabricated from a handful of names', () => {
  const d = dates(4);
  const docs = [
    day(d[0], [
      { ticker: 'T1', prevState: 'DISCOVERED', newState: 'EMERGING_LEADER' },
      { ticker: 'T2', prevState: 'DISCOVERED', newState: 'EMERGING_LEADER' },
    ], { T1: 'Technology', T2: 'Technology' }),
  ];
  const study = buildFunnelStudy(docs);   // default minEntriesPerSplit (20) — 2 Technology entries is far below it
  const el = study.perBase.EMERGING_LEADER;
  assert.equal(el.bySector, null);
  assert.match(el.sectorSplitNote, /withheld/);
});

test('a sector that clears the entry floor is reported; one that does not is excluded, not blended in', () => {
  const d = dates(2);
  const trans = [];
  const sectors = {};
  for (let i = 0; i < 3; i++) { trans.push({ ticker: `TECH${i}`, prevState: 'DISCOVERED', newState: 'EMERGING_LEADER' }); sectors[`TECH${i}`] = 'Technology'; }
  trans.push({ ticker: 'ENE0', prevState: 'DISCOVERED', newState: 'EMERGING_LEADER' });
  sectors.ENE0 = 'Energy';
  const docs = [day(d[0], trans, sectors)];
  const study = buildFunnelStudy(docs, { minEntriesPerSplit: 3 });
  const el = study.perBase.EMERGING_LEADER;
  assert.ok(el.bySector.Technology, 'Technology cleared the floor (3 entries)');
  assert.equal(el.bySector.Technology.entries, 3);
  assert.equal(el.bySector.Energy, undefined, 'Energy (1 entry) stays excluded, not merged into Technology');
  assert.match(el.sectorSplitNote, /Energy/);
});

test('loading the same date twice (duplicate probe hit) is a no-op, not double-counted', () => {
  const d = dates(2);
  const doc = day(d[0], [{ ticker: 'DUP', prevState: 'DISCOVERED', newState: 'EMERGING_LEADER' }], { DUP: 'Health Care' });
  const study = buildFunnelStudy([doc, { ...doc }], { minEntriesPerSplit: 1 });
  assert.equal(study.dateCoverage.distinctDates, 1);
  assert.equal(study.perBase.EMERGING_LEADER.entries, 1, 'the duplicate document must not double the entry count');
});

test('DISCOVERED and PRIMED bases are measured too, with base-relative progression thresholds', () => {
  const d = dates(6);
  const docs = [
    day(d[0], [
      { ticker: 'DD', prevState: null, newState: 'DISCOVERED' },
      { ticker: 'PP', prevState: 'EMERGING_LEADER', newState: 'PRIMED' },
    ], { DD: 'Materials', PP: 'Materials' }),
    day(d[1], [{ ticker: 'DD', prevState: 'DISCOVERED', newState: 'EMERGING_LEADER' }]),   // progression for the DISCOVERED entry
    day(d[2], [{ ticker: 'PP', prevState: 'PRIMED', newState: 'ARMED' }]),                 // progression for the PRIMED entry
  ];
  const study = buildFunnelStudy(docs, { bases: ['DISCOVERED', 'PRIMED'], minEntriesPerSplit: 1 });
  assert.equal(study.perBase.DISCOVERED.progressed, 1);
  assert.equal(study.perBase.PRIMED.progressed, 1);
  // EMERGING_LEADER is a valid progression target for a DISCOVERED entry but
  // would NOT count as progression for a PRIMED entry — confirm the PRIMED
  // base required ARMED specifically by checking its lead time (session 2, not 1).
  assert.equal(study.perBase.PRIMED.leadTimeSessions.median, 2);
});

test('an empty / garbage input never throws and reports zero coverage honestly', () => {
  const study = buildFunnelStudy([]);
  assert.equal(study.dateCoverage.distinctDates, 0);
  assert.equal(study.sampleTooThin, true);
  for (const base of STUDY_BASES) assert.equal(study.perBase[base].entries, 0);

  const garbage = buildFunnelStudy([null, {}, { date: '2026-08-03' }, { rows: [] }]);
  assert.equal(garbage.dateCoverage.distinctDates, 0);
});

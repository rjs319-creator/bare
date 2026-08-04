'use strict';
// sb-episodes-v2 — contracts declare episode cooldowns in TRADING SESSIONS; the episode
// engine must compare them against sessions, not calendar days (a 21-session cooldown
// enforced as 21 calendar days ≈ 15 sessions opened "independent" episodes ~40% early,
// inflating the episode/date counts the promotion gates lean on). The FROZEN daytrade
// section is pinned to the legacy calendar-day axis (Day Trade excluded by directive).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEpisodeMap, gapSessions, CALENDAR_AXIS_SECTIONS, EPISODES_VERSION } = require('../lib/scoreboard-episodes');

test('sessions are counted by weekday roll minus holidays — never calendar days', () => {
  // Mon 2026-07-06 → Mon 2026-07-13: 7 calendar days but only 5 trading sessions.
  assert.equal(gapSessions('2026-07-06', '2026-07-13'), 5);
  // Fri → Mon over a weekend: 3 calendar days, 1 session.
  assert.equal(gapSessions('2026-07-10', '2026-07-13'), 1);
});

test('a 21-session cooldown is NOT interpreted as 21 calendar days: a 25-calendar-day gap (~17 sessions) stays ONE episode', () => {
  const m = createEpisodeMap({ cooldownForSection: () => 21 });
  m.add('S:T:AAA', { section: 'S', tier: 'T', ticker: 'AAA', date: '2026-06-01' });
  m.add('S:T:AAA', { section: 'S', tier: 'T', ticker: 'AAA', date: '2026-06-26' }); // 25 cal days ≈ 18 sessions ≤ 21
  const eps = m.values();
  assert.equal(eps.length, 1, 'inside the session cooldown — same episode (the calendar-day engine wrongly split it)');
});

test('a reappearance beyond the session cooldown opens a NEW episode', () => {
  const m = createEpisodeMap({ cooldownForSection: () => 21 });
  m.add('S:T:AAA', { section: 'S', tier: 'T', ticker: 'AAA', date: '2026-06-01' });
  m.add('S:T:AAA', { section: 'S', tier: 'T', ticker: 'AAA', date: '2026-07-15' }); // 44 cal days ≈ 31 sessions > 21
  const eps = m.values();
  assert.equal(eps.length, 2);
  assert.equal(eps[1].episode, 2);
});

test('DAY TRADE PIN: the daytrade section keeps the legacy CALENDAR-day axis exactly', () => {
  assert.ok(CALENDAR_AXIS_SECTIONS.has('daytrade'));
  // Fri 2026-07-10 → Thu 2026-07-16: 6 calendar days (> 5 cooldown ⇒ NEW episode under
  // the legacy axis) but only 4 sessions (≤ 5 ⇒ same episode under the session axis).
  // Day Trade must reproduce the LEGACY split — its episode boundaries may not move.
  const mk = section => {
    const m = createEpisodeMap({ cooldownForSection: () => 5 });
    m.add(`${section}:T:AAA`, { section, tier: 'T', ticker: 'AAA', date: '2026-07-10' });
    m.add(`${section}:T:AAA`, { section, tier: 'T', ticker: 'AAA', date: '2026-07-16' });
    return m.values().length;
  };
  assert.equal(mk('daytrade'), 2, 'daytrade: legacy calendar-day behavior (6d > 5 ⇒ new episode) unchanged');
  assert.equal(mk('screener'), 1, 'non-daytrade: session axis (4 sessions ≤ 5 ⇒ same episode)');
});

test('the engine version is bumped so summaries under the two axes are distinguishable', () => {
  assert.equal(EPISODES_VERSION, 'sb-episodes-v2');
});

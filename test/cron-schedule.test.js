'use strict';
// CRON SCHEDULE GUARD — the single daily cron's HOUR is load-bearing, not cosmetic.
//
// It was 13:00 UTC (09:00 ET, pre-open). Moved to 22:00 UTC so it runs AFTER the US close,
// which is what lets the warm-cron candle cache contain the current session's completed bar
// (op=scoreboard could otherwise never reuse it — the cache trailed live by a bar all day).
//
// The DST trap this pins: the cron is UTC, the close is ET, and ET shifts.
//   EDT (UTC-4): 16:00 close = 20:00 UTC   → 22:00 UTC is 2h after the close
//   EST (UTC-5): 16:00 close = 21:00 UTC   → 22:00 UTC is 1h after the close
// Anything at or below 21:00 UTC lands AT/BEFORE the close for half the year, which would
// silently reintroduce a pre-close cache every winter.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));

const CLOSE_UTC_EDT = 20;   // 16:00 ET during daylight time
const CLOSE_UTC_EST = 21;   // 16:00 ET during standard time

const cronHour = expr => {
  const m = /^(\d+)\s+(\d+)\s+\*\s+\*\s+\*$/.exec(expr);
  assert.ok(m, `unsupported cron expression: ${expr}`);
  return { minute: Number(m[1]), hour: Number(m[2]) };
};

test('there is still exactly one cron (Hobby caps crons at one per day)', () => {
  assert.equal((vercel.crons || []).length, 1);
  assert.equal(vercel.crons[0].path, '/api/warm');
});

test('the cron runs after the US close in BOTH daylight and standard time', () => {
  const { hour } = cronHour(vercel.crons[0].schedule);

  assert.ok(hour > CLOSE_UTC_EDT, `${hour}:00 UTC is not after the ${CLOSE_UTC_EDT}:00 UTC close (EDT)`);
  assert.ok(hour > CLOSE_UTC_EST, `${hour}:00 UTC is not after the ${CLOSE_UTC_EST}:00 UTC close (EST) — this breaks every winter`);
});

test('the cron still lands on the SAME ET calendar day as the session it captures', () => {
  // op=track stamps picks with nowET().date. If the cron ran late enough to cross midnight ET
  // (>= 05:00 UTC next day), a session's picks would be filed under the following date.
  const { hour } = cronHour(vercel.crons[0].schedule);
  assert.ok(hour < 24, 'hour out of range');
  // 22:00 UTC = 18:00 EDT / 17:00 EST — comfortably the same ET day.
  const etHourEST = (hour - 5 + 24) % 24;
  assert.ok(etHourEST > 16 && etHourEST < 24,
    `${hour}:00 UTC = ${etHourEST}:00 EST, which is not the same-day post-close window`);
});

test('the cron leaves settle time for EOD data before the candle cache is rebuilt', () => {
  // Yahoo EOD bars are not final the instant the bell rings. Require >= 1h of slack against
  // the LATER of the two close times, or a rebuild can capture a partial final bar.
  const { hour } = cronHour(vercel.crons[0].schedule);
  assert.ok(hour - CLOSE_UTC_EST >= 1,
    `only ${hour - CLOSE_UTC_EST}h after the EST close — too tight for EOD data to settle`);
});

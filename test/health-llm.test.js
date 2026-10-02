'use strict';
// op=health carries the LLM cost ledger block verbatim and never lets it decide `healthy`.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHealthResponse } = require('../lib/health');
const { buildLlmHealth, foldShards } = require('../lib/llm-usage');

const AUTH_OK = { ok: true, production: false, secretConfigured: true, warnings: [] };
const run = { at: '2026-10-02T22:10:00Z', ok: true, failCount: 0, failed: [], chainSkips: [], chains: {} };

test('buildHealthResponse passes the llm block through and defaults it to null', () => {
  const today = foldShards([], '2026-10-02');
  const llm = buildLlmHealth({ ...today, usd: 9 }, { ...today, date: '2026-10-01', usd: 2 });
  const r = buildHealthResponse([run], { spyDate: '2026-10-02', ageDays: 0.2, now: Date.parse('2026-10-02T23:00:00Z'), auth: AUTH_OK, llm });
  assert.equal(r.llm.today.usd, 9);
  assert.equal(r.llm.flags.dayOverDayJump.flagged, true, '9 > 2x2 and above the $1 floor');
  assert.equal(r.llm.flags.budget.monthlyStopUsd, 200);
  assert.equal(r.llm.flags.budget.todayOverPace, true);
  assert.equal(r.healthy, true, 'spend flags are informational, not a health verdict');
  const bare = buildHealthResponse([run], { spyDate: '2026-10-02', ageDays: 0.2, now: Date.parse('2026-10-02T23:00:00Z'), auth: AUTH_OK });
  assert.equal(bare.llm, null);
});

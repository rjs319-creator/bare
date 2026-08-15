'use strict';
// STOCKTWITS BULL-RATIO FLAG — shadow overlay guard tests: frozen threshold semantics,
// labeled-ratio arithmetic, fresh-crossing decision units, fail-closed tick/resolve
// wiring, shadow honesty (unvalidated, weak prior, no rank effect), chain + privilege
// registration, and the never-CDN-cache-the-empty-state rule.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const FLAG = require('../lib/stbull-flag');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const msg = (s) => ({ entities: { sentiment: s ? { basic: s } : null } });

test('labeledRatio counts user-labeled tags only and reports a null ratio with zero labels', () => {
  const r = FLAG.labeledRatio([msg('Bullish'), msg('Bullish'), msg('Bearish'), msg(null), {}]);
  assert.deepStrictEqual(r, { bull: 2, bear: 1, labeled: 3, total: 5, bullPct: 66.7 });
  assert.strictEqual(FLAG.labeledRatio([msg(null)]).bullPct, null);
  assert.strictEqual(FLAG.labeledRatio(null).total, 0);
});

test('buildFlagSet applies the FROZEN thresholds exactly: labeled >= 10 AND bullPct >= 90', () => {
  const rows = [
    { ticker: 'aaa', bull: 9, bear: 1, labeled: 10, total: 30, bullPct: 90 },     // flags (both at boundary)
    { ticker: 'BBB', bull: 17, bear: 2, labeled: 19, total: 30, bullPct: 89.5 },  // ratio below
    { ticker: 'CCC', bull: 9, bear: 0, labeled: 9, total: 30, bullPct: 100 },     // labels below
    { ticker: 'DDD', bull: 0, bear: 12, labeled: 12, total: 30, bullPct: 0 },     // bearish extreme — NOT flagged (one-sided hypothesis)
  ];
  const snap = FLAG.buildFlagSet(rows, '2026-08-17');
  assert.deepStrictEqual(Object.keys(snap.symbols), ['AAA']);
  assert.strictEqual(snap.counts.flagged, 1);
  assert.strictEqual(snap.counts.scanned, 4);
  assert.ok(snap.universe.BBB && snap.universe.DDD, 'every scanned row is kept for research');
  assert.strictEqual(snap.version, 'stbull-flag-v1');
});

test('selectFreshFlags returns only NEW threshold crossings vs the previous flag set', () => {
  const snap = FLAG.buildFlagSet([
    { ticker: 'AAA', bull: 10, bear: 0, labeled: 10, total: 30, bullPct: 100 },
    { ticker: 'BBB', bull: 12, bear: 1, labeled: 13, total: 30, bullPct: 92.3 },
  ], '2026-08-17');
  const fresh = FLAG.selectFreshFlags(snap, ['AAA']);
  assert.deepStrictEqual(fresh.map((f) => f.ticker), ['BBB']);
  assert.strictEqual(FLAG.selectFreshFlags(snap, null).length, 2, 'first ledger day: every flagged name is fresh');
});

test('fetchTrending admits only GRADEABLE symbols (canonical lib/alerts rule) and THROWS on an empty list', async () => {
  const fake = (payload) => async () => ({ ok: true, json: async () => payload });
  // BTC.X (crypto), BRK.B (dotted class Yahoo history can't serve), BB.TSX (foreign),
  // RTY_F (futures), USDJPY (forex) must ALL be rejected — an ungradeable ticker in the
  // write-once ledger would pollute it forever as excess5:null 'no-history'.
  const syms = await FLAG.fetchTrending(fake({ symbols: [
    { symbol: 'NVDA' }, { symbol: 'BTC.X' }, { symbol: 'nvda' }, { symbol: 'BRK.B' },
    { symbol: 'BB.TSX' }, { symbol: 'RTY_F' }, { symbol: 'USDJPY' }, { symbol: 'BRK-B' },
  ] }));
  assert.deepStrictEqual(syms, ['NVDA', 'BRK-B'], 'only gradeable US symbology survives, deduped case-insensitively');
  await assert.rejects(() => FLAG.fetchTrending(fake({ symbols: [] })), /empty/);
  await assert.rejects(() => FLAG.fetchTrending(async () => ({ ok: false, status: 429, json: async () => ({}) })), /HTTP 429/);
  assert.match(read('lib/stbull-flag.js'), /isGradeableSymbol/, 'the canonical gradeability rule, not a private regex');
});

test('frozen config drift guard — these thresholds define every future ledger decision', () => {
  assert.strictEqual(FLAG.FROZEN.version, 'stbull-flag-v1');
  assert.strictEqual(FLAG.FROZEN.streamMessages, 30);
  assert.strictEqual(FLAG.FROZEN.minLabeled, 10);
  assert.strictEqual(FLAG.FROZEN.minBullPct, 90);
  assert.strictEqual(FLAG.FROZEN.holdSessions, 5);
  assert.strictEqual(FLAG.FROZEN.prospectiveGate.minResolvedDates, 50);
  assert.strictEqual(FLAG.FROZEN.experimentId, 'stbull-ratio-2026-08');
  assert.match(FLAG.FROZEN.prospectiveGate.evaluation, /NOT the gate/);
});

test('routes: outcome construction is REUSED from the dilution overlay, not re-implemented', () => {
  const src = read('lib/stbull-routes.js');
  assert.match(src, /require\('\.\/dilution-routes'\)/);
  assert.match(src, /excess5\(c, spy, target\)/);
  assert.doesNotMatch(src, /function excess5/, 'no private copy of the grader');
});

test('routes: fail-closed semantics mirror (and harden) the dilution ledger', () => {
  const src = read('lib/stbull-routes.js');
  assert.match(src, /502.*trending fetch failed — snapshot left unchanged/s);
  assert.match(src, /every symbol stream failed — snapshot left unchanged/);
  assert.match(src, /listed in the index but unreadable — refusing to mark it resolved/);
  assert.match(src, /SPY history unavailable — resolution postponed, nothing marked/);
  assert.match(src, /not fully mature yet — postponed/, 'no partial-day resolution (selection-bias rule)');
  assert.match(src, /if \(snap\) cached\(res\); else noStore\(res\);/, 'never CDN-cache the empty state');
  assert.match(src, /sessionInfoAt\(new Date\(\)\)/, 'decision dates live on the ET trading calendar');
});

test('LEDGER-WIPE GUARD: every writer reads the index fail-closed via blobExists, never a bare default', () => {
  const src = read('lib/stbull-routes.js');
  assert.match(src, /STORE\.blobExists\(INDEX_KEY\)/, 'existence probed fail-closed (throws on infra failure)');
  assert.match(src, /exists but is unreadable/, 'an unreadable-but-existing index refuses, never treated as empty');
  assert.match(src, /ledger index unreadable — nothing written/);
  assert.match(src, /ledger index unreadable — nothing resolved/);
  assert.match(src, /STORE\.blobExists\(dayKey\(date\)\)/, 'day docs are write-once by probe, re-indexed on crash recovery, never overwritten');
  // The dilution lane shares the defect — its writers must be fixed too.
  const dil = read('lib/dilution-routes.js');
  assert.match(dil, /readIndexCheckedForWrite/, 'dilution writers use the fail-closed read');
  assert.match(dil, /STORE\.blobExists\(INDEX_KEY\)/);
});

test('TRADING-DAY GATE: no weekend/holiday ledger days (correlated pseudo-decisions)', () => {
  const src = read('lib/stbull-routes.js');
  assert.match(src, /if \(!si\.isTradingDay\)/);
  assert.match(src, /non-trading day — no ledger day minted/);
});

test('FRESH-CROSSING BASELINE fails closed and the snapshot writes LAST', () => {
  const src = read('lib/stbull-routes.js');
  assert.match(src, /previous ledger day \$\{prevDate\} unreadable — nothing written/);
  assert.doesNotMatch(src, /prevSnap/, 'no fallback to the display snapshot as a crossing baseline');
  const dayWrite = src.indexOf('STORE.writeJSON(dayKey(date)');
  const idxWrite = src.indexOf('STORE.writeJSON(INDEX_KEY, { ...idx, dates:');
  const snapWrite = src.indexOf('STORE.writeJSON(CURRENT_KEY, snap');
  assert.ok(dayWrite > 0 && idxWrite > dayWrite && snapWrite > idxWrite,
    'write order must be: day doc → index → snapshot (a mid-tick crash can never make today\'s snapshot the baseline)');
});

test('RESOLVE never fail-opens a day: fetch failures postpone (bounded), dead names close out as never-matured', () => {
  const src = read('lib/stbull-routes.js');
  assert.match(src, /RESOLVE_MAX_FETCH_ATTEMPTS = 3/);
  assert.match(src, /RESOLVE_MAX_AGE_DAYS = 30/);
  assert.match(src, /fetch failure\(s\) — postponed \(attempt/);
  assert.match(src, /never-matured/, 'a permanently immature (delisted/halted) name cannot head-of-line-block the ledger');
  assert.match(src, /RESOLVE_FETCH_CONCURRENCY = 4/, 'bounded Yahoo fan-out in the 22:00 window');
  assert.match(src, /mapLimit\(rows, RESOLVE_FETCH_CONCURRENCY/, 'shared mapLimit, not a hand-rolled pool');
});

test('GATE ACCOUNTING: resolvedDays (scored decision dates) and resolvedTotal are reported as distinct numbers', () => {
  const src = read('lib/stbull-routes.js');
  assert.match(src, /resolvedDays: agg\.resolvedDates/);
  assert.match(src, /resolvedTotal: \(idx\.resolved \|\| \[\]\)\.length/);
  assert.match(src, /counts only decision dates with scored outcomes/);
});

test('every rendered string is shadow-honest: unvalidated, weak prior, not a sell signal, no rank effect', () => {
  const src = read('lib/stbull-routes.js');
  assert.match(src, /state: 'SHADOW'/);
  assert.match(src, /WEAK prior/);
  assert.match(src, /unvalidated prospectively/i);
  assert.match(src, /NOT a sell signal, NOT a short signal, affects no ranking/);
  assert.doesNotMatch(src, /sell now|short this|avoid buying/i, 'the read informs; it must not instruct');
});

test('chain + privilege registration: tick/resolve are PRIVILEGED, the read is public, chain is a root', () => {
  const chains = read('lib/warm-chains.js');
  assert.match(chains, /stbull: \['op=stbulltick', 'op=stbullresolve'\]/);
  const rootsBlock = chains.slice(chains.indexOf('ROOT_CHAINS'));
  assert.match(rootsBlock, /'stbull'/, 'must be a ROOT chain or it never runs');
  const tracker = read('api/tracker.js');
  const privileged = tracker.slice(tracker.indexOf('const PRIVILEGED_OPS'), tracker.indexOf('const EXPENSIVE_OPS'));
  assert.match(privileged, /'stbulltick'/);
  assert.match(privileged, /'stbullresolve'/);
  assert.doesNotMatch(privileged, /'stbull'[,\]]/, 'the public read must not be gated');
  assert.match(tracker, /op === 'stbull'/);
});

test('experiment registry carries the frozen hypothesis', () => {
  const reg = JSON.parse(read('research/experiments/registry.json'));
  const entry = (Array.isArray(reg) ? reg : reg.experiments || []).find((e) => e && e.id === 'stbull-ratio-2026-08');
  assert.ok(entry, 'registry entry stbull-ratio-2026-08 must exist');
});

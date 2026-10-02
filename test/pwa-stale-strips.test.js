'use strict';
// 🕰 STALE STRIPS + GRADE-CHANGE TOAST + SORTABLE TABLES — the UI side of the offline-first pass.
//   • session-board.js: a `stale:true` payload renders "as of HH:MM · showing last good data"
//     instead of the empty panel; a grade change since the last look produces ONE toast message.
//   • today.js: same strip over the command center; the redundancy pair table is sortable.
//   • leaderboard.js: the ranked board is a real <table class="sortable"> per metric basis.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = join(__dirname, '..');
const R = (f) => readFileSync(join(ROOT, 'public', 'js', f), 'utf8');
const url = (f) => pathToFileURL(join(ROOT, 'public', 'js', f)).href;
const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'session-board-sample.json'), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const NOW = new Date('2026-09-21T12:20:00.000Z');

let SB, TOASTS;
test.before(async () => { SB = await import(url('session-board.js')); TOASTS = await import(url('toasts.js')); });

function assertClean(html) {
  assert.ok(!html.includes('${'), 'unresolved template');
  assert.ok(!/\bundefined\b/.test(html), 'literal undefined leaked');
  assert.ok(!/\bNaN\b/.test(html), 'literal NaN leaked');
  assert.ok(!/\[object Object\]/.test(html), 'object stringified');
}

// ── session board ───────────────────────────────────────────────────────────────────
test('renderSessionBoard: a stale payload shows the last-good strip with its asOf, not the empty panel', () => {
  const p = { ...clone(FIXTURE), stale: true, asOf: '2026-09-21T12:05:00.000Z', staleReason: 'refresh failed (Failed to fetch)' };
  const html = SB.renderSessionBoard(p, { now: NOW });
  assertClean(html);
  assert.match(html, /lg-strip/);
  assert.match(html, /as of 8:05 AM ET · showing last good data/);
  assert.match(html, /Failed to fetch/);
  assert.match(html, /ABCD/, 'the last good cards still render');
  assert.ok(!/Nothing graded for this session yet/.test(html));
  assert.ok(!/lg-strip/.test(SB.renderSessionBoard(clone(FIXTURE), { now: NOW })), 'a fresh payload has no strip');
});

test('gradeChangeMessage: one line naming upgrades/downgrades since last look; null when nothing moved', () => {
  const prev = { generatedAt: '2026-09-21T11:00:00.000Z', byId: { a: { letter: 'C', status: 'in-zone' }, b: { letter: 'A', status: 'triggered' }, c: { letter: 'B', status: 'in-zone' } } };
  const payload = { generatedAt: '2026-09-21T12:00:00.000Z', items: [
    { id: 'a', ticker: 'AAA', grade: { letter: 'A' }, live: { status: 'in-zone' } },
    { id: 'b', ticker: 'BBB', grade: { letter: 'C' }, live: { status: 'triggered' } },
    { id: 'c', ticker: 'CCC', grade: { letter: 'B' }, live: { status: 'stopped' } },
    { id: 'd', ticker: 'DDD', grade: { letter: 'B' }, live: { status: 'in-zone' } },
  ] };
  const msg = SB.gradeChangeMessage(SB.deltaSince(payload, prev), payload.items);
  assert.match(msg, /AAA ↑ C → A/);
  assert.match(msg, /BBB ↓ A → C/);
  assert.match(msg, /since .*7:00:00 AM ET/);
  assert.ok(!/CCC/.test(msg), 'a status-only change is not a grade change');
  assert.ok(!/DDD/.test(msg), 'a new row is not a grade change');
  assert.match(SB.gradeChangeMessage(SB.deltaSince(payload, prev)), /^a ↑ C → A/, 'without items the id stands in for the ticker');
  assert.equal(SB.gradeChangeMessage(SB.deltaSince(payload, null), payload.items), null, 'no baseline → nothing to announce');
  assert.equal(SB.gradeChangeMessage(SB.deltaSince({ items: [{ id: 'c', grade: { letter: 'B' }, live: { status: 'stopped' } }] }, prev)), null);
  assert.equal(SB.gradeChangeMessage(null), null);
});

test('loadSessionBoard: notifies ONCE per generatedAt on a grade change and renders the strip for a stale fetch', async () => {
  const el = { innerHTML: '', dataset: {}, addEventListener() {}, contains() { return false; }, offsetParent: null };
  const notes = [];
  const notify = (m) => notes.push(m);
  const seen = { generatedAt: '2026-09-21T11:00:00.000Z', byId: { 'sb1': { letter: 'C', status: 'in-zone' } } };
  const fresh = clone(FIXTURE); fresh.session.phase = 'closed';
  const first = fresh.items.find((it) => it && it.id) || fresh.items[0];
  seen.byId = { [first.id]: { letter: 'F', status: 'in-zone' } };
  first.grade.letter = 'A';
  SB._internals.state.lastGood = null; SB._internals.state.lastFetchAt = 0; SB._internals.state.lastSeen = seen; SB._internals.state.toastedFor = null;
  let stale = false;
  const fetcher = async () => (stale ? { ...fresh, stale: true, asOf: '2026-09-21T12:00:00.000Z', staleReason: 'refresh failed (HTTP 503)' } : fresh);
  const t0 = Date.parse('2026-09-21T12:20:00.000Z');
  await SB.loadSessionBoard(el, { fetcher, now: t0, notify });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /↑ F → A/);
  await SB.loadSessionBoard(el, { fetcher, now: t0 + 10 * 60_000, notify });
  assert.equal(notes.length, 1, 'same generatedAt → no second toast');
  stale = true;
  // A live board is on screen and the refresh fell back to the stored snapshot: the fresher
  // in-memory board stays, behind the loud "refresh failed" banner (no strip — the board on
  // screen is not the snapshot).
  const p = await SB.loadSessionBoard(el, { fetcher, now: t0 + 20 * 60_000, notify });
  assert.equal(p.stale, true);
  assert.match(el.innerHTML, /sb-stale/);
  assert.match(el.innerHTML, /Refresh failed \(HTTP 503\)/);
  assert.ok(!/lg-strip/.test(el.innerHTML));
  // Cold start straight onto the snapshot (offline open): the snapshot IS the board → strip.
  SB._internals.state.lastGood = null; SB._internals.state.lastFetchAt = 0;
  const cold = await SB.loadSessionBoard(el, { fetcher, now: t0 + 30 * 60_000, notify });
  assert.equal(cold.stale, true);
  assert.match(el.innerHTML, /lg-strip/);
  // paint() stamps against the REAL clock, so the Sep-21 fixture carries its date (honesty rule).
  assert.match(el.innerHTML, /as of (Sep 21, 2026, )?8:00 AM ET · showing last good data/);
  assert.ok(!/Nothing graded for this session yet/.test(el.innerHTML));
  assert.equal(notes.length, 1, 'the snapshot carries the same generatedAt → still no second toast');
  clearTimeout(SB._internals.state.seenTimer);
});

test('session-board.js reads through fetchSnapshot (last-good layer) under the sessionboard key', () => {
  const src = R('session-board.js');
  assert.match(src, /import \{ fetchSnapshot, HEAVY_TIMEOUT_MS \} from '\.\/fetch-json\.js'/);
  assert.match(src, /export const LAST_GOOD_KEY = 'sessionboard'/);
  assert.match(src, /fetchSnapshot\(url, \{ \.\.\.opts, key: LAST_GOOD_KEY \}\)/);
  assert.match(src, /lastGoodStripHTML\(/);
  assert.match(src, /from '\.\/toasts\.js'/);
});

// ── toasts ──────────────────────────────────────────────────────────────────────────
test('toastForSwMessage maps a push and an update activation to toasts and ignores everything else', () => {
  const push = TOASTS.toastForSwMessage({ type: 'push', title: 'NVDA · entry', body: 'Triggered above 120', kind: 'entry', url: '/#daytrade' });
  assert.equal(push.kind, 'good'); assert.equal(push.title, 'NVDA · entry'); assert.equal(push.url, '/#daytrade');
  assert.equal(TOASTS.toastForSwMessage({ type: 'push', kind: 'early_watch' }).kind, 'info');
  const up = TOASTS.toastForSwMessage({ type: 'sw-activated', version: 'v2', isUpdate: true });
  assert.equal(up.kind, 'update'); assert.equal(up.reload, true); assert.match(up.message, /reload/i);
  assert.equal(TOASTS.toastForSwMessage({ type: 'sw-activated', version: 'v2', isUpdate: false }), null, 'first install is not an update');
  assert.equal(TOASTS.toastForSwMessage({ type: 'other' }), null);
  assert.equal(TOASTS.toastForSwMessage('x'), null);
  assert.equal(TOASTS.toast('info', 'hello'), null, 'no Notyf in node → null, never a throw');
});

// ── today ───────────────────────────────────────────────────────────────────────────
test('today.js wraps op=today in the last-good layer, renders the strip and keeps a stale board out of the instant-paint cache', () => {
  const src = R('today.js');
  assert.match(src, /import \{ withLastGood, lastGoodStripHTML \} from '\.\/last-good\.js'/);
  assert.match(src, /withLastGood\('today', \(\) => fetchJSON\('\/api\/tracker\?op=today', \{ timeoutMs: HEAVY_TIMEOUT_MS \}\)\)/);
  assert.match(src, /lastGoodStripHTML\(p/);
  assert.match(src, /if \(p && p\.ok && !p\.stale\) \{/, 'only a fresh board is written to the localStorage instant-paint cache');
  assert.match(src, /<table class="td-redunp-tbl sortable">/);
  assert.match(src, /data-sort="\$\{/, 'numeric cells carry data-sort so the sort is numeric, not lexical');
});

// ── leaderboard ─────────────────────────────────────────────────────────────────────
function loadLeaderboard() {
  const src = R('leaderboard.js').replace(/^import .*$/gm, '').replace(/^export /gm, '');
  const factory = new Function('esc', 'fetchJSON', 'HEAVY_TIMEOUT_MS', 'OPTIONAL_TIMEOUT_MS', 'module',
    `${src}\nmodule.exports = { buildBoard, renderBoardHTML, MIN_RANKED_N };`);
  const mod = { exports: {} };
  factory((x) => String(x), async () => null, 0, 0, mod);
  return mod.exports;
}

test('renderBoardHTML: one sortable table per metric basis (medals restart per basis) plus a building table', () => {
  const { buildBoard, renderBoardHTML } = loadLeaderboard();
  const g = (section, tier, n, avg, winRate) => ({ section, tier, horizons: { '1m': { n, avg, winRate } } });
  const board = buildBoard([g('momentum', 'StrongSell', 18, 7.37, 55), g('screener', 'Breakout', 30, 3.2, 70), g('CERN', 'INDEX_ADD_FADE', 3, 16.85, 100)],
    { Breakout: { avgAlpha: 1.1, winRate: 52, n: 40 } }, { conf1: { name: 'Confluence A', excess: 0.4, beatRate: 51, wilsonLo: 44, n: 12 } });
  const html = renderBoardHTML(board);
  assertClean(html);
  const tables = html.match(/<table class="lb-table sortable">/g) || [];
  assert.equal(tables.length, 4, 'live + backtest + confluence + building');
  assert.match(html, /<thead><tr><th/);
  assert.match(html, /<tr class="lb-row">/);
  assert.match(html, /data-sort="/);
  assert.equal((html.match(/🥇/g) || []).length, 3, 'a gold medal per ranked basis, never across bases');
  assert.match(html, /Building evidence/);
  assert.match(html, /only 3 resolved/);
  assert.equal(renderBoardHTML([]), '');
});

test('leaderboard.js emits <table class="lb-table sortable"> and no flex-row divs', () => {
  const src = R('leaderboard.js');
  assert.match(src, /<table class="lb-table sortable">/);
  assert.ok(!/<div class="lb-row">/.test(src));
  const css = readFileSync(join(ROOT, 'public', 'css', 'app.css'), 'utf8');
  assert.match(css, /\.lb-table/);
  assert.match(css, /table\.sortable th\[aria-sort="ascending"\]/, 'sort direction indicator styles');
  assert.ok(!/\.lb-row \{ display: flex/.test(css), 'the old flex row rule would break <tr> layout');
});

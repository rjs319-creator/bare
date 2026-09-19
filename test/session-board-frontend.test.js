'use strict';
// 🎯 SESSION BOARD frontend — pure render helpers + UI registration pins.
// The module is an ES module (browser), imported here via dynamic import(); every helper
// under test is pure (payload in, HTML/objects out) so no DOM is needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = join(__dirname, '..');
const APP = readFileSync(join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const HTML = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
const CSS = readFileSync(join(ROOT, 'public', 'css', 'app.css'), 'utf8');
const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'session-board-sample.json'), 'utf8'));

const clone = (o) => JSON.parse(JSON.stringify(o));
let SB;
test.before(async () => { SB = await import(pathToFileURL(join(ROOT, 'public', 'js', 'session-board.js')).href); });

// The four render hazards the app's render-guard tests scan for.
function assertClean(html) {
  assert.ok(!html.includes('${'), 'unresolved template');
  assert.ok(!/\bundefined\b/.test(html), `literal undefined leaked: ${html.match(/.{40}undefined.{40}/) || ''}`);
  assert.ok(!/\bNaN\b/.test(html), 'literal NaN leaked');
  assert.ok(!/\[object Object\]/.test(html), 'object stringified');
}

// ── UI registration (the touchpoint checklist, mirrors ignition-live-routes.test.js) ──
test('session is registered at every UI touchpoint', () => {
  assert.match(APP, /home: {7}\['today', 'session', 'ensemble', 'start', 'quickhit'\]/, 'in TAB_GROUPS.home, right after today');
  assert.match(APP, /session: '🎯 Session'/, 'SUB_LABEL');
  assert.match(APP, /session: 'Session Board — what is worth looking at RIGHT NOW/, 'SECTION_HELP');
  assert.match(APP, /session: \{\n {6}what:/, 'HOWTO');
  assert.match(APP, /import \{ loadSessionBoard \} from '\.\/session-board\.js'/, 'module import');
  assert.match(APP, /session: lazySection\('session', loadSessionBoard, SESSION_BOARD_REFRESH_MS\)/, 'lazy loader with minute host tick');
  assert.match(APP, /function ensureSessionBoard\(\)/, 'hoisted function declaration (showTab TDZ rule)');
  assert.match(APP, /sub === 'session' && typeof ensureSessionBoard === 'function'/, 'showTab dispatch');
  assert.match(HTML, /<section class="screener-section" id="session">/, 'index.html section');
  assert.match(HTML, /id="session-container"/, 'container');
  assert.match(HTML, /id="session-refresh-btn"/, 'refresh button');
  assert.match(CSS, /#session \.sb-card \{/, 'stylesheet');
});

test('the lab and candidates pins are untouched', () => {
  assert.match(APP, /'edge', 'cfl', 'orbitlab'/);
  assert.match(APP, /'rltlab', 'psrl', 'gridlock'/);
  assert.match(APP, /'catalyst', 'peerlab'\]/);
  assert.match(APP, /'lowfloat', 'ignitionlive', 'breakoutradar'/);
});

// ── phase / countdown / stamps ───────────────────────────────────────────────────────
test('phaseLabel covers every phase and degrades on unknown', () => {
  for (const [p, label] of [['premarket', 'Premarket'], ['regular', 'Regular session'], ['afterhours', 'After hours'], ['closed', 'Closed']]) {
    assert.equal(SB.phaseLabel({ phase: p }).label, label);
  }
  assert.equal(SB.phaseLabel(null).label, 'Unknown session');
  assert.equal(SB.phaseLabel({ phase: 'weird' }).phase, 'weird');
});

test('countdownText: opens-in / closes-in / next session', () => {
  assert.equal(SB.countdownText({ phase: 'premarket', minutesToOpen: 76 }), 'opens in 1h 16m');
  assert.equal(SB.countdownText({ phase: 'regular', minutesToClose: 45 }), 'closes in 45m');
  const nx = SB.countdownText({ phase: 'closed', nextTransition: { phase: 'premarket', at: '2026-09-21T08:00:00.000Z' } });
  assert.match(nx, /^next session /);
  assert.equal(SB.countdownText({ phase: 'closed' }), '');
  assert.equal(SB.countdownText(null), '');
});

test('stampET carries the date whenever the stamp is not today in New York', () => {
  const now = new Date('2026-09-21T12:30:00.000Z');
  assert.match(SB.stampET('2026-09-21T12:14:05.000Z', now), /^\d{1,2}:\d{2}:\d{2} [AP]M ET$/);
  assert.match(SB.stampET('2026-09-18T12:14:05.000Z', now), /Sep 18, 2026, .* ET$/);
  assert.equal(SB.stampET(null, now), '–');
  assert.equal(SB.stampET('garbage', now), '–');
});

test('show() renders null as a dash, never 0', () => {
  assert.equal(SB.show(null), '–');
  assert.equal(SB.show(undefined), '–');
  assert.equal(SB.show(0), '0.00');
  assert.equal(SB.show(1.234, { suffix: '%', digits: 1, signed: true }), '+1.2%');
});

// ── since-you-last-looked ────────────────────────────────────────────────────────────
test('deltaSince: no baseline → nothing flagged', () => {
  const d = SB.deltaSince(FIXTURE, null);
  assert.equal(d.hasBaseline, false);
  assert.deepEqual(d.byId, {});
  assert.equal(SB.deltaSummary(d), '');
});

test('deltaSince: new / upgraded / downgraded / status change', () => {
  const seen = SB.snapshotOf(FIXTURE);
  const next = clone(FIXTURE);
  next.generatedAt = '2026-09-21T13:45:00.000Z';
  next.items[0].grade.letter = 'A';                 // ABCD B → A
  next.items[1].grade.letter = 'D';                 // EFGH C → D
  next.items[2].live = { status: 'triggered' };     // IJKL null → triggered (no prior status → not a change)
  next.items[3].live.status = 'stopped';            // MNOP extended → stopped
  next.items.push({ id: 'x:new:ZZZZ', ticker: 'ZZZZ', grade: { letter: 'C' }, live: null });
  const d = SB.deltaSince(next, seen);
  assert.equal(d.byId['gapgo:intraday:ABCD'].kind, 'up');
  assert.equal(d.byId['screener:swing:EFGH'].kind, 'down');
  assert.equal(d.byId['coremo:portfolio:IJKL'], undefined);
  assert.equal(d.byId['crossasset:position:MNOP'].kind, 'status');
  assert.equal(d.byId['crossasset:position:MNOP'].label, 'extended → stopped');
  assert.equal(d.byId['x:new:ZZZZ'].kind, 'new');
  assert.deepEqual(d.counts, { new: 1, up: 1, down: 1, status: 1 });
  const s = SB.deltaSummary(d);
  assert.match(s, /1 new · 1 upgraded · 1 downgraded · 1 status change since /);
});

test('last-seen storage is try/catch safe', () => {
  const bad = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(SB.readLastSeen(bad), null);
  assert.equal(SB.writeLastSeen({ byId: {} }, bad), false);
  const mem = {}; const ok = { getItem: (k) => mem[k] ?? null, setItem: (k, v) => { mem[k] = v; } };
  assert.equal(SB.writeLastSeen(SB.snapshotOf(FIXTURE), ok), true);
  assert.equal(SB.readLastSeen(ok).byId['gapgo:intraday:ABCD'].letter, 'B');
  mem[SB.LAST_SEEN_KEY] = '{not json';
  assert.equal(SB.readLastSeen(ok), null);
});

// ── full render ──────────────────────────────────────────────────────────────────────
test('renders the fixture: header, pills, ranked cards, held-out block, disclosure', () => {
  const html = SB.renderSessionBoard(FIXTURE, { now: new Date('2026-09-21T12:20:00.000Z') });
  assertClean(html);
  assert.match(html, /sb-phase-premarket/);
  assert.match(html, /opens in 1h 16m/);
  assert.match(html, /refreshes every 60s/);
  assert.match(html, /Risk-off/);
  assert.match(html, /two way chop/);
  assert.match(html, /Technology \+0\.8%/);
  assert.match(html, /data-tf="all"[^>]*>All <span class="sb-pill-n">4<\/span>/);
  assert.match(html, /data-tf="intraday"[^>]*>⚡ Intraday \(today\) <span class="sb-pill-n">1<\/span>/);
  // ranked, held-out item never in the main list
  const main = html.split('sb-heldout')[0];
  assert.match(main, /#1[\s\S]*ABCD/);
  assert.ok(!/QRST/.test(main), 'held-out item leaked into the main list');
  assert.match(html, /sb-heldout[\s\S]*QRST/);
  // grades A..F, status pills, premarket row, checklist marks
  for (const g of ['A', 'B', 'C', 'D', 'F']) assert.match(html, new RegExp(`sb-g-${g}`));
  assert.match(html, /In entry zone/); assert.match(html, /Not triggered/); assert.match(html, /Extended/); assert.match(html, /Stopped/);
  assert.match(html, /gap \+6\.2%/); assert.match(html, /pre rel-vol <b>3\.1×<\/b>/);
  assert.match(html, /sb-ck-na">–<\/span><span class="sb-ck-lbl">Quoted spread<\/span><span class="sb-ck-val">–<\/span>/, 'null check value renders as a dash');
  assert.match(html, /capped at B: no validated lane/);
  assert.match(html, /Partial read — not answering: intraday/);
  assert.match(html, /No live read/, 'null live renders the grey pill');
  assert.match(html, /Grades are snapshot-quality reads, not proven edge/);
  assert.match(html, /every position is paper until it does/);
});

test('renders every phase without leaking', () => {
  for (const phase of ['premarket', 'regular', 'afterhours', 'closed']) {
    const p = clone(FIXTURE);
    p.session = { phase, minutesToOpen: phase === 'premarket' ? 5 : null, minutesToClose: phase === 'regular' ? 200 : null, nextTransition: null };
    const html = SB.renderSessionBoard(p, { now: new Date('2026-09-21T12:20:00.000Z') });
    assertClean(html);
    assert.match(html, new RegExp(`sb-phase-${phase}`));
    assert.match(html, phase === 'premarket' || phase === 'regular' ? /every 60s/ : /every 5 min/);
  }
});

test('timeframe filter narrows the list and says so when empty', () => {
  const swing = SB.renderSessionBoard(FIXTURE, { filter: 'swing' });
  assertClean(swing);
  assert.match(swing.split('sb-heldout')[0], /EFGH/);
  assert.ok(!/ABCD/.test(swing.split('sb-heldout')[0]));
  const p = clone(FIXTURE); p.items = p.items.filter((i) => i.horizon !== 'intraday'); p.byTimeframe.intraday = [];
  const none = SB.renderSessionBoard(p, { filter: 'intraday' });
  assert.match(none, /Nothing in this time frame right now/);
});

test('empty payload → calm empty panel naming failed sources; never a blank section', () => {
  const p = { ok: true, empty: true, items: [], heldOut: [], byTimeframe: {}, session: { phase: 'closed' }, sources: [{ source: 'today', ok: false, reason: 'timeout' }], disclosure: 'D.' };
  const html = SB.renderSessionBoard(p);
  assertClean(html);
  assert.match(html, /Nothing graded for this session yet/);
  assert.match(html, /<b>today<\/b> \(timeout\)/);
  assert.ok(html.length > 200);
  // a completely bare payload also renders
  const bare = SB.renderSessionBoard({});
  assertClean(bare);
  assert.match(bare, /Nothing graded/);
  assert.match(SB.renderSessionBoard(null), /Unknown session/);
});

test('stale banner keeps the last good board', () => {
  const html = SB.renderSessionBoard(FIXTURE, { stale: 'Refresh failed (HTTP 500)', now: new Date('2026-09-21T12:20:00.000Z') });
  assert.match(html, /⚠️ Refresh failed \(HTTP 500\) — showing the last good board from/);
  assert.match(html, /ABCD/);
});

test('null-safe card: every field missing still renders', () => {
  const html = SB.renderCard({ id: 'x', ticker: 'X' });
  assertClean(html);
  assert.match(html, /sb-g-none/);
  assert.match(html, /No live read/);
  assert.match(html, /Prev close<\/span><b>–<\/b>/);
  const withDelta = SB.renderCard(FIXTURE.items[0], { delta: { kind: 'new', label: 'NEW' }, rank: 3 });
  assert.match(withDelta, /sb-delta-new">NEW/); assert.match(withDelta, /#3/);
});

test('user-supplied strings are escaped', () => {
  const p = clone(FIXTURE);
  p.items[0].company = '<img src=x onerror=alert(1)>';
  p.items[0].why = ['<script>bad()</script>'];
  p.disclosure = '<b>x</b>';
  const html = SB.renderSessionBoard(p);
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('<script>bad'));
  assert.ok(!html.includes('<b>x</b>'));
});

// ── loader behaviour (no DOM: a stub element) ─────────────────────────────────────────
function stubEl() {
  const el = { innerHTML: '', dataset: {}, offsetParent: null, listeners: [], addEventListener(t, f) { this.listeners.push([t, f]); }, contains() { return true; } };
  return el;
}

test('loadSessionBoard: renders on success, keeps the last good board with a stale banner on failure, throttles idle polls', async () => {
  const el = stubEl();
  let calls = 0;
  const closed = clone(FIXTURE); closed.session.phase = 'closed';
  const fetcher = async () => { calls++; if (calls === 2) throw new Error('HTTP 503'); return closed; };
  const t0 = 1_000_000;
  const p1 = await SB.loadSessionBoard(el, { fetcher, now: t0 });
  assert.equal(p1.version, 'session-board-v1');
  assert.match(el.innerHTML, /sb-phase-closed/);
  assert.ok(!/sb-stale/.test(el.innerHTML));
  // silent poll 60s later in a closed phase → throttled, no fetch
  const p2 = await SB.loadSessionBoard(el, { fetcher, now: t0 + 60_000, silent: true });
  assert.equal(calls, 1); assert.equal(p2, p1);
  // manual refresh → fetch fails → last good board + stale banner
  const p3 = await SB.loadSessionBoard(el, { fetcher, now: t0 + 120_000 });
  assert.equal(p3, null); assert.equal(calls, 2);
  assert.match(el.innerHTML, /sb-stale/); assert.match(el.innerHTML, /HTTP 503/); assert.match(el.innerHTML, /ABCD/);
  // silent poll after the idle window → fetches again
  await SB.loadSessionBoard(el, { fetcher, now: t0 + 6 * 60_000, silent: true });
  assert.equal(calls, 3);
  assert.ok(!/sb-stale/.test(el.innerHTML));
  clearTimeout(SB._internals.state.seenTimer);
});

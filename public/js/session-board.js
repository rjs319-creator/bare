// 🎯 SESSION BOARD — "what is worth looking at right now", graded on today's snapshot.
//
// Renders the server-authoritative op=sessionboard payload (lib/session-board*.js) — the
// engine grades, this module only draws, so there is no client/server scoring skew.
// Session-aware by design: the same board reads differently at 08:00 ET (premarket gap
// and pre-volume), during the session (live status vs the frozen levels, VWAP / opening
// range) and after the close (what is setting up for the next session). A "since you
// last looked" delta is kept per browser so a return visit shows what changed.
//
// Honesty rules carried from the rest of the app: a null field renders as "–", never as 0;
// generatedAt is stamped with its date whenever it is not today; a failed refresh keeps
// the last good render behind a loud stale banner; held-out lanes (the app's proven
// negatives) never appear in the main list.
import { esc } from './format.js';
import { fetchJSON, HEAVY_TIMEOUT_MS } from './fetch-json.js';

export const SESSION_BOARD_URL = '/api/tracker?op=sessionboard';
export const LAST_SEEN_KEY = 'sessionBoardLastSeen';
export const ACTIVE_REFRESH_MS = 60 * 1000;        // premarket / regular session
export const IDLE_REFRESH_MS = 5 * 60 * 1000;      // after hours / closed
export const LAST_SEEN_SETTLE_MS = 5 * 1000;       // the tab must stay visible this long to count as "looked"

const GRADE_ORDER = { A: 5, B: 4, C: 3, D: 2, F: 1 };
const TIMEFRAMES = [
  ['intraday', '⚡ Intraday (today)'],
  ['swing', '📅 Days to weeks'],
  ['position', '🧭 Weeks to months'],
  ['portfolio', '💼 Long term'],
];
const STATUS = {
  'not-triggered': ['⏳', 'Not triggered', 'sb-st-good'],
  'in-zone': ['🎯', 'In entry zone', 'sb-st-good'],
  triggered: ['🚀', 'Triggered', 'sb-st-neutral'],
  extended: ['🟡', 'Extended', 'sb-st-warn'],
  'target-hit': ['🏁', 'Target hit', 'sb-st-warn'],
  stopped: ['❌', 'Stopped', 'sb-st-bad'],
  unknown: ['·', 'No live read', 'sb-st-grey'],
};
const PHASE = {
  premarket: ['🌅', 'Premarket'],
  regular: ['🟢', 'Regular session'],
  afterhours: ['🌆', 'After hours'],
  closed: ['🌙', 'Closed'],
};
const NY_TIME = { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit' };
const NY_DAY = { timeZone: 'America/New_York', year: 'numeric', month: 'short', day: 'numeric' };

// ── small pure helpers ──────────────────────────────────────────────────────────────
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
// Null-safe display: a missing value is "–", never "0", "undefined" or "NaN".
export function show(v, { suffix = '', digits = 2, signed = false } = {}) {
  if (v == null || v === '') return '–';
  if (isNum(v)) {
    const s = v.toFixed(digits);
    return `${signed && v > 0 ? '+' : ''}${s}${suffix}`;
  }
  return esc(String(v));
}
const pct = (v, digits = 1) => show(v, { suffix: '%', digits, signed: true });
const px = (v) => (isNum(v) ? `$${v.toFixed(v >= 100 ? 0 : 2)}` : '–');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function phaseLabel(session) {
  const p = session && session.phase;
  const [icon, label] = PHASE[p] || ['·', 'Unknown session'];
  return { icon, label, phase: p || 'unknown' };
}

// "opens in 76m" / "closes in 3h 12m" / "next session Mon Sep 21, 09:30 ET"
export function countdownText(session) {
  if (!session) return '';
  const m2t = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
  if (session.phase === 'premarket' && isNum(session.minutesToOpen)) return `opens in ${m2t(Math.max(0, Math.round(session.minutesToOpen)))}`;
  if (session.phase === 'regular' && isNum(session.minutesToClose)) return `closes in ${m2t(Math.max(0, Math.round(session.minutesToClose)))}`;
  const nt = session.nextTransition;
  if (nt && nt.at) {
    const d = new Date(nt.at);
    if (Number.isFinite(d.getTime())) {
      let day; try { day = d.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' }); } catch { day = d.toDateString(); }
      let time; try { time = d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }); } catch { time = ''; }
      return `next session ${day}${time ? `, ${time} ET` : ''}`;
    }
  }
  return '';
}

// Date + time whenever the stamp is not today in New York — a days-old payload must never
// read as "8:14 AM" (the frontend-staleness-honesty rule).
export function stampET(iso, now = new Date()) {
  const d = new Date(iso);
  if (!iso || !Number.isFinite(d.getTime())) return '–';
  let time, sameDay;
  try {
    time = d.toLocaleTimeString('en-US', NY_TIME);
    sameDay = d.toLocaleDateString('en-US', NY_DAY) === new Date(now).toLocaleDateString('en-US', NY_DAY);
  } catch { time = d.toISOString().slice(11, 19); sameDay = (now - d) < 86400000; }
  if (sameDay) return `${time} ET`;
  let day; try { day = d.toLocaleDateString('en-US', NY_DAY); } catch { day = d.toISOString().slice(0, 10); }
  return `${day}, ${time} ET`;
}

// ── "since you last looked" ─────────────────────────────────────────────────────────
export function snapshotOf(payload) {
  const byId = {};
  for (const it of (payload && payload.items) || []) {
    if (!it || !it.id) continue;
    byId[it.id] = { letter: it.grade && it.grade.letter || null, status: it.live && it.live.status || null };
  }
  return { generatedAt: payload && payload.generatedAt || null, byId };
}

export function deltaSince(payload, lastSeen) {
  const out = { byId: {}, counts: { new: 0, up: 0, down: 0, status: 0 }, since: lastSeen && lastSeen.generatedAt || null, hasBaseline: !!(lastSeen && lastSeen.byId) };
  if (!out.hasBaseline) return out;
  const prev = lastSeen.byId;
  for (const it of (payload && payload.items) || []) {
    if (!it || !it.id) continue;
    const was = prev[it.id];
    const letter = it.grade && it.grade.letter || null;
    const status = it.live && it.live.status || null;
    if (!was) { out.byId[it.id] = { kind: 'new', label: 'NEW' }; out.counts.new++; continue; }
    const g0 = GRADE_ORDER[was.letter] || 0, g1 = GRADE_ORDER[letter] || 0;
    if (g1 > g0 && g0) { out.byId[it.id] = { kind: 'up', label: `↑ ${was.letter} → ${letter}` }; out.counts.up++; continue; }
    if (g1 < g0 && g1) { out.byId[it.id] = { kind: 'down', label: `↓ ${was.letter} → ${letter}` }; out.counts.down++; continue; }
    if (status && was.status && status !== was.status) {
      const to = (STATUS[status] || STATUS.unknown)[1].toLowerCase();
      out.byId[it.id] = { kind: 'status', label: `${(STATUS[was.status] || STATUS.unknown)[1].toLowerCase()} → ${to}` };
      out.counts.status++;
    }
  }
  return out;
}

export function deltaSummary(delta) {
  if (!delta || !delta.hasBaseline) return '';
  const c = delta.counts;
  const parts = [];
  if (c.new) parts.push(`${c.new} new`);
  if (c.up) parts.push(`${c.up} upgraded`);
  if (c.down) parts.push(`${c.down} downgraded`);
  if (c.status) parts.push(`${plural(c.status, 'status change')}`);
  const since = delta.since ? ` since ${stampET(delta.since)}` : '';
  return parts.length ? `${parts.join(' · ')}${since}` : `No changes${since}`;
}

export function readLastSeen(storage) {
  try {
    const raw = (storage || globalThis.localStorage).getItem(LAST_SEEN_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && v.byId ? v : null;
  } catch { return null; }
}
export function writeLastSeen(snap, storage) {
  try { (storage || globalThis.localStorage).setItem(LAST_SEEN_KEY, JSON.stringify(snap)); return true; } catch { return false; }
}

// ── render pieces ───────────────────────────────────────────────────────────────────
function gradeChip(g) {
  const letter = g && g.letter && GRADE_ORDER[g.letter] ? g.letter : '–';
  const score = g && isNum(g.score) ? ` <small>${Math.round(g.score)}</small>` : '';
  return `<span class="sb-grade sb-g-${letter === '–' ? 'none' : letter}" title="Snapshot-quality grade — not a probability">${letter}${score}</span>`;
}
function statusPill(live) {
  const key = live && live.status && STATUS[live.status] ? live.status : 'unknown';
  const [icon, label, cls] = STATUS[key];
  const note = live && live.note ? ` <span class="sb-dim">— ${esc(live.note)}</span>` : '';
  return `<span class="sb-status ${cls}">${icon} ${label}</span>${note}`;
}
function bars(components) {
  const c = components || {};
  return `<div class="sb-bars">` + ['evidence', 'setup', 'live', 'regime'].map((k) => {
    const v = isNum(c[k]) ? Math.max(0, Math.min(1, c[k])) : null;
    const w = v == null ? 0 : Math.round(v * 100);
    return `<div class="sb-bar" title="${k}: ${v == null ? '–' : w + '%'}"><span class="sb-bar-lbl">${k}</span><span class="sb-bar-track"><span class="sb-bar-fill sb-bar-${k}" style="width:${w}%"></span></span></div>`;
  }).join('') + `</div>`;
}
function capsNote(g) {
  const caps = (g && g.caps) || [];
  if (!caps.length) return '';
  return `<div class="sb-caps">${caps.map((c) => `<span class="sb-cap">capped at ${esc(c.appliedMax || '?')}: ${esc(c.rule || '')}</span>`).join(' ')}</div>`;
}
function levelsRow(l) {
  const L = l || {};
  const cells = [
    ['Prev close', px(L.prevClose)], ['Entry', px(L.entry)], ['Stop', px(L.stop)], ['Target', px(L.target)],
    ['R:R', isNum(L.rr) ? `${L.rr.toFixed(1)}×` : '–'], ['ATR', isNum(L.atrPct) ? `${L.atrPct.toFixed(1)}%` : '–'],
  ];
  return `<div class="sb-levels">${cells.map(([k, v]) => `<span class="sb-lvl"><span class="sb-lvl-k">${k}</span><b>${v}</b></span>`).join('')}</div>`;
}
function liveRow(live) {
  if (!live) return '';
  const p = live.pct || {};
  const bits = [];
  if (isNum(p.toEntry)) bits.push(`to entry <b>${pct(p.toEntry)}</b>`);
  if (isNum(p.toStop)) bits.push(`to stop <b>${pct(p.toStop)}</b>`);
  if (isNum(p.toTarget)) bits.push(`to target <b>${pct(p.toTarget)}</b>`);
  if (live.vwap && isNum(live.vwap.value)) bits.push(`VWAP <b>${px(live.vwap.value)}</b> ${live.vwap.above === true ? '▲ above' : live.vwap.above === false ? '▼ below' : ''}`);
  if (live.orb && (isNum(live.orb.high) || isNum(live.orb.low))) bits.push(`ORB <b>${px(live.orb.low)}–${px(live.orb.high)}</b>${live.orb.state ? ` (${esc(live.orb.state)})` : ''}`);
  if (isNum(live.relVol)) bits.push(`rel-vol <b>${live.relVol.toFixed(1)}×</b>`);
  if (isNum(live.dayRangePct)) bits.push(`day range <b>${live.dayRangePct.toFixed(1)}%</b>`);
  return bits.length ? `<div class="sb-live">${bits.join(' · ')}</div>` : '';
}
function premarketRow(pm) {
  if (!pm) return '';
  const bits = [];
  if (isNum(pm.gapPct)) bits.push(`<span class="sb-gap ${pm.gapPct >= 0 ? 'up' : 'down'}">gap ${pct(pm.gapPct)}</span>`);
  if (isNum(pm.preRelVol)) bits.push(`pre rel-vol <b>${pm.preRelVol.toFixed(1)}×</b>`);
  if (isNum(pm.preMarketPrice)) bits.push(`pre <b>${px(pm.preMarketPrice)}</b>`);
  return bits.length ? `<div class="sb-pre">🌅 ${bits.join(' · ')}</div>` : '';
}
function checklist(checks) {
  const arr = Array.isArray(checks) ? checks : [];
  if (!arr.length) return '';
  const row = (c) => {
    const mark = c.ok === true ? '<span class="sb-ck-ok">✓</span>' : c.ok === false ? '<span class="sb-ck-bad">✗</span>' : '<span class="sb-ck-na">–</span>';
    return `<div class="sb-ck">${mark}<span class="sb-ck-lbl">${esc(c.label || c.key || '')}</span><span class="sb-ck-val">${c.value == null || c.value === '' ? '–' : esc(String(c.value))}</span></div>`;
  };
  return `<details class="sb-checks"><summary>Expert checklist <span class="sb-dim">${arr.filter((c) => c.ok === true).length}/${arr.length} ✓</span></summary>${arr.map(row).join('')}</details>`;
}
function flagChips(f) {
  const F = f || {};
  const out = [];
  if (F.negativeLane) out.push('<span class="sb-flag sb-flag-bad">proven-negative lane</span>');
  if (F.dilution) out.push('<span class="sb-flag sb-flag-warn">dilution filing</span>');
  if (F.shortInterest) out.push('<span class="sb-flag sb-flag-warn">high short interest</span>');
  if (F.lowFloat) out.push('<span class="sb-flag">low float</span>');
  return out.length ? `<div class="sb-flags">${out.join(' ')}</div>` : '';
}
function whyList(why, cls = 'sb-why') {
  const arr = Array.isArray(why) ? why.filter(Boolean) : [];
  return arr.length ? `<ul class="${cls}">${arr.map((w) => `<li>${esc(String(w))}</li>`).join('')}</ul>` : '';
}
function deltaTag(d) {
  if (!d) return '';
  return `<span class="sb-delta sb-delta-${esc(d.kind)}">${esc(d.label)}</span>`;
}

export function renderCard(it, { delta = null, rank = null } = {}) {
  const tf = it.timeframe || {};
  const side = it.side === 'short' ? '<span class="sb-side sb-short">SHORT</span>' : '<span class="sb-side sb-long">LONG</span>';
  const name = [it.company, it.sector].filter(Boolean).map((s) => esc(String(s))).join(' · ');
  const gradeWhy = whyList(it.grade && it.grade.why, 'sb-grade-why');
  return `<article class="sb-card" data-id="${esc(it.id || '')}" data-ticker="${esc(it.ticker || '')}" data-tf="${esc(tf.key || it.horizon || '')}">
    <div class="sb-card-hd">
      ${rank != null ? `<span class="sb-rank">#${rank}</span>` : ''}
      ${gradeChip(it.grade)}
      <span class="sb-tf" title="${esc(tf.holdWindow || '')}">${esc(tf.label || it.horizon || '–')}</span>
      ${side}
      <b class="sb-ticker">${esc(it.ticker || '?')}</b>
      <span class="sb-name">${name}</span>
      ${deltaTag(delta)}
    </div>
    <div class="sb-card-st">${statusPill(it.live)}</div>
    ${premarketRow(it.premarket)}
    ${levelsRow(it.levels)}
    ${liveRow(it.live)}
    ${gradeWhy}
    ${bars(it.grade && it.grade.components)}
    ${capsNote(it.grade)}
    ${flagChips(it.flags)}
    ${checklist(it.checks)}
    ${whyList(it.why)}
    <div class="sb-src sb-dim">${esc(it.section || it.source || '')}${it.tier ? ` · ${esc(it.tier)}` : ''}</div>
  </article>`;
}

function headerStrip(p, now) {
  const s = p.session || {};
  const ph = phaseLabel(s);
  const live = ph.phase === 'premarket' || ph.phase === 'regular';
  const reg = p.regime || {};
  const mk = p.market || null;
  const secs = (arr, cls) => (arr || []).slice(0, 3).map((x) => `<span class="sb-sec ${cls}">${esc(x.name || '')} ${pct(x.changePct)}</span>`).join(' ');
  return `<div class="sb-head">
    <div class="sb-head-row">
      <span class="sb-phase sb-phase-${esc(ph.phase)}">${ph.icon} ${esc(ph.label)}</span>
      <span class="sb-clock">${s.etTime ? `${esc(s.etTime)} ET` : ''}${s.etDate ? ` · ${esc(s.etDate)}` : ''}</span>
      <span class="sb-countdown">${esc(countdownText(s))}</span>
      ${s.isTradingDay === false ? '<span class="sb-dim">not a trading day</span>' : ''}
    </div>
    <div class="sb-head-row">
      <span class="sb-chip sb-regime ${reg.bearish ? 'bad' : reg.riskOn ? 'good' : ''}">${esc(reg.label || 'Regime –')}</span>
      ${mk && mk.mode ? `<span class="sb-chip">${esc(String(mk.mode).replace(/_/g, ' ').toLowerCase())}</span>` : ''}
      ${mk && isNum(mk.spyChangePct) ? `<span class="sb-chip">SPY ${pct(mk.spyChangePct)}</span>` : ''}
      ${mk ? `<span class="sb-secs">${secs(mk.leading, 'up')} ${secs(mk.weakening, 'down')}</span>` : ''}
    </div>
    <div class="sb-head-row sb-dim">
      <span>as of ${stampET(p.generatedAt, now)}</span>
      <span class="sb-refresh-ind ${live ? 'on' : ''}">${live ? '⟳ refreshes every 60s while open' : '⟳ refreshes every 5 min while open'}</span>
    </div>
  </div>`;
}

function pills(p, filter, items) {
  const bt = p.byTimeframe || {};
  const total = (items || []).length;
  const pill = (key, label, n) => `<button type="button" class="sb-pill ${filter === key ? 'active' : ''}" data-tf="${key}">${label} <span class="sb-pill-n">${n}</span></button>`;
  return `<div class="sb-pills">${pill('all', 'All', total)}${TIMEFRAMES.map(([k, l]) => pill(k, l, (bt[k] || []).length)).join('')}</div>`;
}

function emptyPanel(p) {
  const failed = (p.sources || []).filter((s) => s && s.ok === false);
  return `<div class="sb-empty">
    <div class="sb-empty-h">Nothing graded for this session yet</div>
    <div class="sb-dim">${esc(p.disclosure || '')}</div>
    ${failed.length ? `<div class="sb-dim">Sources not answering: ${failed.map((s) => `<b>${esc(s.source)}</b>${s.reason ? ` (${esc(s.reason)})` : ''}`).join(', ')}</div>` : ''}
  </div>`;
}

function heldOutBlock(items) {
  const arr = Array.isArray(items) ? items : [];
  if (!arr.length) return '';
  return `<details class="sb-heldout"><summary>Held out (proven-negative lanes) <span class="sb-dim">${arr.length}</span></summary>
    <div class="sb-dim sb-heldout-note">These lanes lose money at their own contract horizon on the app's resolved record. They are shown so you know they were considered, never ranked.</div>
    ${arr.map((it) => renderCard(it)).join('')}
  </details>`;
}

// F-grade items are real candidates the rubric rejected (stopped, no plan, nothing lit). On a
// closed market they are mostly the prior session's day-trade watch names — dozens of them —
// so they render collapsed by default; the counts and ranks stay honest (ranks continue).
export const LOW_GRADE_LETTERS = new Set(['F']);
export function splitLowGrade(items) {
  const arr = Array.isArray(items) ? items : [];
  const primary = arr.filter((it) => !LOW_GRADE_LETTERS.has(it && it.grade && it.grade.letter));
  const low = arr.filter((it) => LOW_GRADE_LETTERS.has(it && it.grade && it.grade.letter));
  return { primary, low };
}
function listWithLowGradeCollapsed(shown, delta) {
  const { primary, low } = splitLowGrade(shown);
  const card = (it, i) => renderCard(it, { delta: delta.byId[it.id] || null, rank: i + 1 });
  const main = primary.length
    ? `<div class="sb-list">${primary.map(card).join('')}</div>`
    : `<div class="sb-empty sb-dim">Nothing graded above F right now — every candidate is stopped, unplanned or unlit.</div>`;
  if (!low.length) return main;
  const lowCards = low.map((it, i) => card(it, primary.length + i)).join('');
  return `${main}<details class="sb-lowgrade"><summary>Low grade (F) <span class="sb-dim">${low.length}</span></summary>
    <div class="sb-dim sb-lowgrade-note">Considered and rejected by the snapshot rubric — listed so nothing is hidden, never ranked above the board.</div>
    <div class="sb-list">${lowCards}</div>
  </details>`;
}

export function renderSessionBoard(payload, { lastSeen = null, now = new Date(), filter = 'all', stale = null } = {}) {
  const p = payload || {};
  const delta = deltaSince(p, lastSeen);
  const items = Array.isArray(p.items) ? p.items.filter((it) => it && !(it.flags && it.flags.heldOut)) : [];
  const shown = filter === 'all' ? items : items.filter((it) => (it.timeframe && it.timeframe.key || it.horizon) === filter);
  const summary = deltaSummary(delta);
  const staleBanner = stale ? `<div class="sb-stale">⚠️ ${esc(stale)} — showing the last good board from ${stampET(p.generatedAt, now)}.</div>` : '';
  const failed = (p.sources || []).filter((s) => s && s.ok === false);
  const degraded = failed.length && !p.empty ? `<div class="sb-dim sb-degraded">Partial read — not answering: ${failed.map((s) => esc(s.source)).join(', ')}.</div>` : '';
  let body;
  if (p.empty || !items.length) body = emptyPanel(p);
  else if (!shown.length) body = `<div class="sb-empty sb-dim">Nothing in this time frame right now.</div>`;
  else body = listWithLowGradeCollapsed(shown, delta);
  return `${staleBanner}${headerStrip(p, now)}
    ${summary ? `<div class="sb-since">👀 ${esc(summary)}</div>` : ''}
    ${degraded}
    ${pills(p, filter, items)}
    ${body}
    ${heldOutBlock(p.heldOut)}
    <div class="sb-foot sb-dim">${esc(p.disclosure || '')}<br>Grades are snapshot-quality reads, not proven edge; held-out lanes are the app's proven negatives.</div>`;
}

// ── loader (browser) ────────────────────────────────────────────────────────────────
const state = { lastGood: null, lastFetchAt: 0, filter: 'all', seenTimer: null, lastSeen: undefined };

function isLivePhase(p) { const ph = p && p.session && p.session.phase; return ph === 'premarket' || ph === 'regular'; }

function paint(el, opts = {}) {
  if (!state.lastGood) return;
  if (state.lastSeen === undefined) state.lastSeen = readLastSeen();
  el.innerHTML = renderSessionBoard(state.lastGood, { lastSeen: state.lastSeen, filter: state.filter, stale: opts.stale || null });
  scheduleLastSeen(el);
}

// The board counts as "looked at" only after it has stayed on screen for a few seconds.
function scheduleLastSeen(el) {
  if (state.seenTimer) clearTimeout(state.seenTimer);
  state.seenTimer = setTimeout(() => {
    state.seenTimer = null;
    const visible = typeof document === 'undefined' ? true : (!document.hidden && !!el.offsetParent);
    if (!visible || !state.lastGood) return;
    const snap = snapshotOf(state.lastGood);
    if (writeLastSeen(snap)) state.lastSeen = snap;
  }, LAST_SEEN_SETTLE_MS);
}

export async function loadSessionBoard(el, { silent = false, now = Date.now(), fetcher = fetchJSON } = {}) {
  if (!el) return null;
  // A silent poll outside premarket / regular hours is throttled to the idle cadence even
  // though the host timer ticks every minute (lazySection has one fixed interval).
  if (silent && state.lastGood && !isLivePhase(state.lastGood) && now - state.lastFetchAt < IDLE_REFRESH_MS) return state.lastGood;
  if (!silent && !state.lastGood) el.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Grading this session's candidates…</p></div>`;
  if (!el.dataset.sbBound) {
    el.dataset.sbBound = '1';
    el.addEventListener('click', (ev) => {
      const b = ev.target && ev.target.closest && ev.target.closest('.sb-pill');
      if (!b || !el.contains(b)) return;
      state.filter = b.dataset.tf || 'all';
      paint(el);
    });
  }
  try {
    const p = await fetcher(`${SESSION_BOARD_URL}&_cb=${now}`, { timeoutMs: HEAVY_TIMEOUT_MS });
    if (!p || p.ok === false) throw new Error((p && p.error) || 'session board unavailable');
    state.lastGood = p;
    state.lastFetchAt = now;
    paint(el);
    return p;
  } catch (e) {
    const msg = e && e.message ? e.message : 'refresh failed';
    if (state.lastGood) paint(el, { stale: `Refresh failed (${msg})` });
    else el.innerHTML = `<div class="sb-empty"><div class="sb-empty-h">Session board unavailable</div><div class="sb-dim">${esc(msg)}. Try ⟳ Refresh.</div></div>`;
    return null;
  }
}

export const _internals = { state, TIMEFRAMES, STATUS, GRADE_ORDER };

// 🖥 TECHNOLOGY COMMAND CENTER — page controller.
//
// Reads the versioned read-only payload from op=techcommand and renders it. All
// server state is authoritative: this module filters and displays, it never
// decides an action, re-ranks a board, or computes a score.
//
// Behaviour contracts:
//   • polling PAUSES while the tab is hidden or the section is not active, and
//     adapts to the market session (faster during regular hours, slow when closed);
//   • a payload whose `generatedAt` is unchanged does NOT re-render, so cards never
//     jump under the reader;
//   • every failure lands in the error boundary with a visible reason — a blank
//     board is never shown as if it meant "nothing qualified".
import { esc } from './format.js';
import { fetchJSON, HEAVY_TIMEOUT_MS, OPTIONAL_TIMEOUT_MS } from './fetch-json.js';
import * as R from './tech-command-render.js';
import { renderTechEvidence } from './tech-evidence-render.js';

const POLL_MS = { regular: 90000, premarket: 180000, afterhours: 180000, closed: 900000 };
const STORAGE_KEY = 'techCommandPrefs';

const state = {
  payload: null,
  renderedAt: null,
  loading: false,
  error: null,
  dossier: null,
  dossierLoading: false,
  techev: null,           // op=techev payload (optional enrichment — its failure never blanks the page)
  techevError: null,
  techevLoading: false,
  timer: null,
  container: null,
  prefs: {
    expertMode: false,
    subsector: 'all',
    horizon: 'all',
    catalystWindow: 'all',
    evidence: 'all',      // all | actionable | research
    query: '',
    evArm: 'all',         // operational-evidence section: all | npm | github | sec
    evShow: 'all',        // operational-evidence section: all | available | eligible
  },
};

function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (raw && typeof raw === 'object') state.prefs = { ...state.prefs, ...raw };
  } catch { /* defaults are fine */ }
}
function savePrefs() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.prefs)); } catch { /* non-fatal */ }
}

// ── Filtering (display only — never re-orders a board) ──────────────────────
const ACTIONABLE_ACTIONS = new Set(['TRIGGERED', 'ENTER', 'ACCUMULATE', 'READY', 'MANAGE', 'HOLD', 'WATCH_VALUATION']);

function matches(row, prefs) {
  if (!row) return false;
  if (prefs.subsector !== 'all' && row.subsector !== prefs.subsector) return false;
  if (prefs.query) {
    const q = prefs.query.toUpperCase();
    if (!String(row.ticker || '').includes(q) && !String(row.company || '').toUpperCase().includes(q)) return false;
  }
  if (prefs.evidence === 'actionable' && !ACTIONABLE_ACTIONS.has(row.action)) return false;
  if (prefs.evidence === 'research' && ACTIONABLE_ACTIONS.has(row.action)) return false;
  if (prefs.catalystWindow !== 'all') {
    const d = row.earningsInDays;
    const cap = prefs.catalystWindow === 'week' ? 5 : prefs.catalystWindow === 'month' ? 21 : 63;
    if (d == null || d < 0 || d > cap) return false;
  }
  return true;
}

function filterPayload(payload, prefs) {
  if (!payload) return payload;
  const f = (board, key = 'rows') => {
    if (!board) return board;
    const rows = (board[key] || []).filter(r => matches(r, prefs));
    const featured = (board.featured || []).filter(r => matches(r, prefs));
    return { ...board, [key]: rows, featured: board.featured ? featured : undefined };
  };
  const showHorizon = h => prefs.horizon === 'all' || prefs.horizon === h;
  return {
    ...payload,
    daytrade: showHorizon('daytrade') ? f(payload.daytrade) : { ...payload.daytrade, rows: [], hiddenByFilter: true },
    swing: showHorizon('swing') ? f(payload.swing) : { ...payload.swing, rows: [], featured: [], hiddenByFilter: true },
    longterm: showHorizon('longterm') ? f(payload.longterm) : { ...payload.longterm, rows: [], featured: [], hiddenByFilter: true },
  };
}

// ── Controls ────────────────────────────────────────────────────────────────
function controls(payload) {
  const p = state.prefs;
  const subsectors = payload && payload.universe && payload.universe.bySubsector
    ? Object.entries(payload.universe.bySubsector).filter(([, v]) => (v || []).length).map(([k, v]) => [k, `${k} (${v.length})`])
    : [];
  const sel = (id, label, value, options) => `
    <label class="tc-ctl"><span>${esc(label)}</span>
      <select id="${id}" aria-label="${esc(label)}">
        ${options.map(([v, t]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(t)}</option>`).join('')}
      </select></label>`;
  return `<div class="tc-controls" role="group" aria-label="Board filters">
    <label class="tc-ctl"><span>Search</span>
      <input id="tc-query" type="search" placeholder="Ticker or company" value="${esc(p.query)}" aria-label="Filter by ticker or company" /></label>
    ${sel('tc-horizon', 'Horizon', p.horizon, [['all', 'All horizons'], ['daytrade', 'Day trade'], ['swing', 'Swing'], ['longterm', 'Long term']])}
    ${sel('tc-subsector', 'Subsector', p.subsector, [['all', 'All subsectors'], ...subsectors])}
    ${sel('tc-catalyst', 'Catalyst window', p.catalystWindow, [['all', 'Any'], ['week', 'Reports ≤ 5 sessions'], ['month', '≤ 21 sessions'], ['quarter', '≤ 63 sessions']])}
    ${sel('tc-evidence', 'Type', p.evidence, [['all', 'Actionable + research'], ['actionable', 'Actionable only'], ['research', 'Research / watch only']])}
    <button id="tc-expert" class="tc-toggle" aria-pressed="${p.expertMode}" type="button">
      ${p.expertMode ? '🔬 Expert view: ON' : '🔬 Expert view: OFF'}</button>
    <button id="tc-refresh" class="tc-toggle" type="button">⟳ Refresh</button>
  </div>`;
}

function watermark(payload) {
  const parts = [
    `generated ${esc(R.shortTime(payload.generatedAt))}`,
    payload.marketSession ? `session: ${esc(payload.marketSession)}` : null,
    payload.servedFrom ? `source: ${esc(payload.servedFrom)}` : null,
    payload.universe ? `${payload.universe.count} technology securities` : null,
  ].filter(Boolean);
  return `<p class="tc-watermark">${parts.join(' · ')}</p>`;
}

// ── Render ──────────────────────────────────────────────────────────────────
function render() {
  const el = state.container;
  if (!el) return;
  if (state.error && !state.payload) {
    el.innerHTML = `<div class="tc-error" role="alert">
      <b>The Technology Command Center could not load.</b>
      <p>${esc(state.error)}</p>
      <p class="tc-note">Every board is empty because of this failure — not because nothing qualified.</p>
      <button id="tc-refresh" class="tc-toggle" type="button">⟳ Try again</button></div>`;
    wire();
    return;
  }
  if (!state.payload) { el.innerHTML = R.skeleton(); return; }

  const p = state.payload;
  const view = filterPayload(p, state.prefs);
  const opts = { expertMode: state.prefs.expertMode };

  el.innerHTML = `
    ${controls(p)}
    ${watermark(p)}
    ${p.degraded ? `<div class="tc-error" role="alert"><b>Degraded.</b> ${esc(p.reason || p.error || 'The snapshot could not be assembled.')}</div>` : ''}
    ${R.renderRegime(p.regime)}
    ${state.dossier ? `<div id="tc-dossier-slot">${R.renderDossier(state.dossier)}</div>` : (state.dossierLoading ? '<div id="tc-dossier-slot"><p class="tc-note">Loading dossier…</p></div>' : '<div id="tc-dossier-slot"></div>')}
    ${R.renderAlignment(p.alignment)}
    ${R.renderDaytrade(view.daytrade, opts)}
    ${R.renderSwing(view.swing, opts)}
    ${R.renderLongTerm(view.longterm, opts)}
    ${R.renderEvents(p.events, p.scenarios, opts)}
    ${R.renderReadThrough(p.readthrough, opts)}
    ${R.renderOptions(p.options)}
    ${R.renderSentiment(p.sentiment)}
    ${R.renderRisk(p.risk)}
    ${renderTechEvidence(state.techev, state.prefs, { error: state.techevError, loading: state.techevLoading && !state.techev })}
    ${R.renderHealth(p)}
  `;
  state.renderedAt = p.generatedAt;
  wire();
}

function wire() {
  const el = state.container;
  if (!el) return;
  const on = (id, ev, fn) => { const n = el.querySelector('#' + id); if (n) n.addEventListener(ev, fn); };
  on('tc-refresh', 'click', () => load({ force: true }));
  on('tc-expert', 'click', () => { state.prefs.expertMode = !state.prefs.expertMode; savePrefs(); render(); });
  const bind = (id, key, ev = 'change') => on(id, ev, e => { state.prefs[key] = e.target.value; savePrefs(); render(); });
  bind('tc-horizon', 'horizon'); bind('tc-subsector', 'subsector');
  bind('tc-catalyst', 'catalystWindow'); bind('tc-evidence', 'evidence');
  bind('tcev-arm', 'evArm'); bind('tcev-show', 'evShow');
  const q = el.querySelector('#tc-query');
  if (q) {
    let t = null;
    q.addEventListener('input', e => {
      clearTimeout(t);
      const v = e.target.value;
      t = setTimeout(() => { state.prefs.query = v.trim(); savePrefs(); render(); q.focus(); }, 250);
    });
  }
  // One delegated handler for every ticker button (keyboard-accessible by being a <button>).
  el.querySelectorAll('[data-ticker]').forEach(btn => {
    if (btn.tagName !== 'BUTTON') return;
    btn.addEventListener('click', () => openDossier(btn.dataset.ticker));
  });
  const close = el.querySelector('[data-close-dossier]');
  if (close) close.addEventListener('click', () => { state.dossier = null; render(); });
}

// ── Data ────────────────────────────────────────────────────────────────────
async function load({ force = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  if (force) { state.error = null; }
  try {
    const url = `/api/tracker?op=techcommand${force ? `&_=${Date.now()}` : ''}`;
    const data = await fetchJSON(url, { timeoutMs: HEAVY_TIMEOUT_MS });
    state.error = null;
    // Stable rendering: an unchanged snapshot must not repaint the board.
    if (!force && state.payload && data && data.generatedAt === state.renderedAt) return;
    state.payload = data;
    render();
  } catch (e) {
    state.error = String((e && e.message) || e);
    if (!state.payload) render();
  } finally {
    state.loading = false;
    schedule();
  }
  loadTechEvidence({ force });
}

// Optional enrichment: the Operational Evidence panel. Its failure or absence must
// never blank the command boards — it degrades to an in-section error state.
async function loadTechEvidence({ force = false } = {}) {
  if (state.techevLoading) return;
  if (!force && state.techev) return; // snapshot changes at most daily — no need to re-poll
  state.techevLoading = true;
  try {
    const data = await fetchJSON(`/api/tracker?op=techev${force ? `&_=${Date.now()}` : ''}`, { timeoutMs: OPTIONAL_TIMEOUT_MS });
    state.techev = data;
    state.techevError = null;
  } catch (e) {
    state.techevError = String((e && e.message) || e);
  } finally {
    state.techevLoading = false;
    render();
  }
}

async function openDossier(ticker) {
  if (!ticker) return;
  state.dossierLoading = true;
  state.dossier = null;
  render();
  try {
    const data = await fetchJSON(`/api/tracker?op=techcommandticker&ticker=${encodeURIComponent(ticker)}`, { timeoutMs: OPTIONAL_TIMEOUT_MS });
    state.dossier = (data && data.dossier) || null;
  } catch (e) {
    state.dossier = { found: false, reason: `Dossier unavailable: ${String((e && e.message) || e)}` };
  } finally {
    state.dossierLoading = false;
    render();
    const slot = state.container && state.container.querySelector('#tc-dossier-slot');
    if (slot) slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// ── Polling ─────────────────────────────────────────────────────────────────
function isVisible() {
  if (typeof document === 'undefined') return false;
  if (document.hidden) return false;
  const sec = document.getElementById('tech-command');
  return !!(sec && sec.classList.contains('tab-active'));
}

function schedule() {
  clearTimeout(state.timer);
  const session = (state.payload && state.payload.marketSession) || 'closed';
  const ms = POLL_MS[session] || POLL_MS.closed;
  state.timer = setTimeout(() => { if (isVisible()) load(); else schedule(); }, ms);
}

/** Entry point used by the app shell when the section becomes active. */
export function loadTechCommand(container) {
  state.container = container || document.getElementById('tech-command-container');
  if (!state.container) return;
  loadPrefs();
  if (!state.payload) render();          // skeleton first
  load({ force: false });
  if (!loadTechCommand._wired) {
    loadTechCommand._wired = true;
    document.addEventListener('visibilitychange', () => { if (isVisible()) load(); });
  }
}

export function stopTechCommand() { clearTimeout(state.timer); }

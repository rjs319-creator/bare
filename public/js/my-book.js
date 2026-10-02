// 📓 MY BOOK — the per-browser paper ledger of Session Board rows the reader marked
// "taking this". Stored in localStorage (every access try/catch — a private window or
// blocked site data must leave the page working), valued by op=mybook under the SAME
// execution policy as the house book, rendered with the house-book helpers.
import { esc } from './format.js';
import { fetchJSON, OPTIONAL_TIMEOUT_MS } from './fetch-json.js';
import { _internals as SB } from './session-board.js';
import { equityChartSvg, metricTiles, fmtPctPts, fmtUsd } from './house-book.js';

export const MY_BOOK_KEY = 'myBook.v1';
export const MY_BOOK_URL = '/api/tracker?op=mybook';
export const MY_BOOK_MAX_ROWS = 25;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ── storage (never throws) ──────────────────────────────────────────────────────────
export function readLedger(storage) {
  try {
    const raw = (storage || globalThis.localStorage).getItem(MY_BOOK_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) ? v.filter((e) => e && e.rowId && e.ticker) : [];
  } catch { return []; }
}
export function writeLedger(entries, storage) {
  try { (storage || globalThis.localStorage).setItem(MY_BOOK_KEY, JSON.stringify(entries)); return true; } catch { return false; }
}

// ── pure ledger ops ─────────────────────────────────────────────────────────────────
export function entryFromItem(it, generatedAt, takenAt = new Date().toISOString()) {
  if (!it || !it.id || !it.ticker) return null;
  const L = it.levels || {};
  return {
    rowId: it.id, ticker: String(it.ticker).toUpperCase(), timeframe: (it.timeframe && it.timeframe.key) || it.horizon || 'swing',
    stop: isNum(L.stop) ? L.stop : null, target: isNum(L.target) ? L.target : null,
    grade: (it.grade && it.grade.letter) || null, section: it.section || null, side: it.side || 'long',
    signalAt: generatedAt || null, takenAt,
  };
}
const keyOf = (e) => `${e.rowId}|${e.signalAt || ''}`;
export function hasEntry(entries, entry) { return entries.some((e) => keyOf(e) === keyOf(entry)); }
export function toggleEntry(entries, entry) {
  if (!entry) return entries;
  return hasEntry(entries, entry) ? entries.filter((e) => keyOf(e) !== keyOf(entry)) : [...entries, entry];
}
export function removeEntry(entries, rowId, signalAt) { return entries.filter((e) => !(e.rowId === rowId && (e.signalAt || '') === (signalAt || ''))); }

// `TICKER~DATE~TF~STOP~TARGET~GRADE~SECTION,…` — the server validates every field again.
export function rowsParam(entries) {
  const clean = (s) => String(s == null ? '' : s).replace(/[~,]/g, '');
  return entries.slice(0, MY_BOOK_MAX_ROWS).map((e) => [e.ticker, e.signalAt || '', e.timeframe, e.stop ?? '', e.target ?? '', e.grade || '', e.section || ''].map(clean).join('~')).join(',');
}

// ── render ──────────────────────────────────────────────────────────────────────────
const STATUS_LABEL = { open: '🟢 open', closed: '🏁 closed', pending: '⏳ awaiting next open', skipped: '– skipped' };
function rowLine(e, v) {
  const st = v ? (STATUS_LABEL[v.status] || v.status) : '…';
  const fill = v && isNum(v.fillPrice) ? `filled ${v.fillPrice.toFixed(2)} on ${esc(v.fillDate || '')}` : '';
  const ret = v ? (v.status === 'closed' ? fmtPctPts(v.netReturnPct) : v.status === 'open' ? fmtPctPts(v.unrealizedPct) : '–') : '–';
  const exit = v && v.exit ? `exit ${esc(v.exit.reason)} ${isNum(v.exit.price) ? v.exit.price.toFixed(2) : ''}` : (v && v.reason ? esc(v.reason) : '');
  return `<li class="mb-row" data-rowid="${esc(e.rowId)}" data-signalat="${esc(e.signalAt || '')}">
    <b class="mb-tk">${esc(e.ticker)}</b><span class="sb-dim">${esc(e.timeframe)} · ${esc(e.grade || '–')} · ${esc(e.section || '')}</span>
    <span class="mb-st">${st}</span><span class="sb-dim">${fill} ${exit}</span>
    <span class="mb-ret ${/^-/.test(ret) ? 'neg' : 'pos'}">${ret}</span>
    <button type="button" class="mb-remove" title="Remove from my book">✕</button>
  </li>`;
}

export function renderMyBook(entries, valuation, { stale = null, loading = false } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return `<div class="mb-panel"><div class="mb-h">📓 My book <span class="sb-dim">this browser only</span></div><div class="sb-dim">Mark a card with <b>☐ Taking this</b> and it is paper-traded here under the house policy (next open + slippage, equal notional, stop / target / horizon exits). Nothing leaves your browser except the rows being valued.</div></div>`;
  const byKey = new Map(((valuation && valuation.rows) || []).map((r) => [`${r.ticker}|${r.signalDate}`, r]));
  const sigDate = (e) => (e.signalAt && /T/.test(e.signalAt) ? null : e.signalAt);
  const lookup = (e) => byKey.get(`${e.ticker}|${sigDate(e)}`) || [...byKey.values()].find((r) => r.ticker === e.ticker) || null;
  const rows = list.map((e) => rowLine(e, lookup(e))).join('');
  const val = valuation && valuation.ok !== false ? `${equityChartSvg(valuation.equity && valuation.equity.points)}${metricTiles(valuation.metrics)}<div class="sb-dim">as of ${esc(valuation.asOfDate || '–')} · cash ${fmtUsd(valuation.cash)} of ${fmtUsd(valuation.initialCash)}${valuation.unpriced && valuation.unpriced.length ? ` · no prices for ${valuation.unpriced.map(esc).join(', ')}` : ''}</div>` : '';
  const note = stale ? `<div class="sb-stale">⚠️ ${esc(stale)}</div>` : loading ? `<div class="sb-dim">Valuing…</div>` : '';
  return `<div class="mb-panel"><div class="mb-h">📓 My book <span class="sb-dim">${list.length} row${list.length === 1 ? '' : 's'} · this browser only</span><button type="button" class="mb-refresh refresh-btn">⟳ Value</button></div>
    ${note}<ul class="mb-list">${rows}</ul>${val}
    <div class="sb-dim mb-disc">${esc((valuation && valuation.disclosure) || 'A paper valuation under the house policy — not a brokerage record.')}</div></div>`;
}

// ── wiring (browser) ────────────────────────────────────────────────────────────────
const state = { entries: null, valuation: null, inflight: null };

export function markTakeButtons(boardEl, entries) {
  if (!boardEl) return;
  const keys = new Set(entries.map(keyOf));
  const gen = SB.state.lastGood && SB.state.lastGood.generatedAt;
  for (const b of boardEl.querySelectorAll('.sb-take')) {
    const item = (SB.state.lastGood && SB.state.lastGood.items || []).find((it) => it.id === b.dataset.id);
    const e = item ? entryFromItem(item, gen) : null;
    const on = !!(e && keys.has(keyOf(e)));
    b.classList.toggle('on', on);
    b.textContent = on ? '☑ Taking this' : '☐ Taking this';
  }
}

async function value(panelEl, fetcher) {
  if (!state.entries.length) { state.valuation = null; panelEl.innerHTML = renderMyBook(state.entries, null); return; }
  if (state.inflight) return state.inflight;
  panelEl.innerHTML = renderMyBook(state.entries, state.valuation, { loading: true });
  state.inflight = (async () => {
    try {
      const v = await fetcher(`${MY_BOOK_URL}&rows=${encodeURIComponent(rowsParam(state.entries))}`, { timeoutMs: OPTIONAL_TIMEOUT_MS });
      if (!v || v.ok === false) throw new Error((v && v.error) || 'valuation unavailable');
      state.valuation = v;
      panelEl.innerHTML = renderMyBook(state.entries, v);
    } catch (e) {
      panelEl.innerHTML = renderMyBook(state.entries, state.valuation, { stale: `Valuation failed (${e && e.message ? e.message : 'error'})` });
    } finally { state.inflight = null; }
  })();
  return state.inflight;
}

export function initMyBook({ boardEl, panelEl, fetcher = fetchJSON, storage } = {}) {
  if (!boardEl || !panelEl || panelEl.dataset.mbBound) return;
  panelEl.dataset.mbBound = '1';
  state.entries = readLedger(storage);
  panelEl.innerHTML = renderMyBook(state.entries, null);
  const save = () => { if (!writeLedger(state.entries, storage)) panelEl.innerHTML = renderMyBook(state.entries, state.valuation, { stale: 'Could not save to this browser (storage blocked) — the list will not survive a reload' }); };
  boardEl.addEventListener('click', (ev) => {
    const b = ev.target && ev.target.closest && ev.target.closest('.sb-take');
    if (!b || !boardEl.contains(b)) return;
    const item = (SB.state.lastGood && SB.state.lastGood.items || []).find((it) => it.id === b.dataset.id);
    const e = entryFromItem(item, SB.state.lastGood && SB.state.lastGood.generatedAt);
    if (!e) return;
    state.entries = toggleEntry(state.entries, e);
    save();
    markTakeButtons(boardEl, state.entries);
    value(panelEl, fetcher);
  });
  panelEl.addEventListener('click', (ev) => {
    const rm = ev.target && ev.target.closest && ev.target.closest('.mb-remove');
    if (rm) { const li = rm.closest('.mb-row'); state.entries = removeEntry(state.entries, li.dataset.rowid, li.dataset.signalat); save(); markTakeButtons(boardEl, state.entries); value(panelEl, fetcher); return; }
    if (ev.target && ev.target.closest && ev.target.closest('.mb-refresh')) value(panelEl, fetcher);
  });
  // The board repaints every poll; re-mark its buttons each time.
  if (typeof MutationObserver === 'function') new MutationObserver(() => markTakeButtons(boardEl, state.entries)).observe(boardEl, { childList: true });
  if (state.entries.length) value(panelEl, fetcher);
}

export const _internals = { state, keyOf };

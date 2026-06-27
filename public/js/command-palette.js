// Global command palette (⌘K / Ctrl-K). A single search box that spans the whole
// app: jump to any section, look up a ticker (open it in Options flow or reveal
// it on a screener that's already showing it), or open a Learn concept. Pure
// client-side over data the app already holds; routes via callbacks so this
// module stays decoupled from app.js internals.
import { esc } from './format.js';

const MAX_RESULTS = 12;
const TICKER_RE = /^[A-Za-z.]{1,6}$/;

let cfg = null;          // { sections, learn, onRoute, onLearn, onTickerOptions }
let box = null, input = null, list = null, overlay = null;
let results = [], active = 0;

function injectStyles() {
  if (document.getElementById('cmdk-style')) return;
  const s = document.createElement('style');
  s.id = 'cmdk-style';
  s.textContent = `
    #cmdk-overlay{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);display:flex;justify-content:center;align-items:flex-start;padding-top:12vh}
    #cmdk-overlay[hidden]{display:none}
    #cmdk-box{width:min(620px,92vw);max-height:64vh;background:#11141b;border:1px solid #2a2f3a;border-radius:12px;box-shadow:0 18px 60px rgba(0,0,0,.6);overflow:hidden;display:flex;flex-direction:column}
    #cmdk-input{width:100%;box-sizing:border-box;padding:15px 16px;border:none;border-bottom:1px solid #222732;background:transparent;color:#e5e7eb;font-size:1.02rem;outline:none}
    #cmdk-input::placeholder{color:#6b7280}
    #cmdk-list{list-style:none;margin:0;padding:6px;overflow-y:auto}
    .cmdk-item{display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:8px;cursor:pointer;color:#cbd2dc}
    .cmdk-item.active{background:#1b2230}
    .cmdk-ic{font-size:1rem;width:1.4em;text-align:center;flex:none}
    .cmdk-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .cmdk-title b{color:#fff}
    .cmdk-kind{font-size:.66rem;color:#7b8494;border:1px solid #2a2f3a;border-radius:5px;padding:1px 6px;flex:none}
    .cmdk-empty{padding:18px 14px;color:#6b7280;font-size:.86rem;text-align:center}
    .cmdk-hint{padding:8px 12px;border-top:1px solid #222732;color:#6b7280;font-size:.7rem;display:flex;gap:14px;flex-wrap:wrap}
    .cmdk-flash{animation:cmdkFlash 1.6s ease-out}
    @keyframes cmdkFlash{0%,40%{box-shadow:0 0 0 2px var(--green,#10d98a),0 0 16px var(--green,#10d98a)}100%{box-shadow:none}}
  `;
  document.head.appendChild(s);
}

function buildOverlay() {
  overlay = document.createElement('div');
  overlay.id = 'cmdk-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `<div id="cmdk-box" role="dialog" aria-label="Search">
    <input id="cmdk-input" type="text" autocomplete="off" spellcheck="false" placeholder="Search sections, a ticker, or a concept…">
    <ul id="cmdk-list"></ul>
    <div class="cmdk-hint"><span>↑↓ navigate</span><span>↵ open</span><span>esc close</span></div>
  </div>`;
  document.body.appendChild(overlay);
  box = overlay.querySelector('#cmdk-box');
  input = overlay.querySelector('#cmdk-input');
  list = overlay.querySelector('#cmdk-list');
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
  input.addEventListener('input', () => rebuild(input.value));
  input.addEventListener('keydown', onKey);
}

// Reveal a ticker on a section that's already rendering it (flash the card).
function revealTicker(sectionId, ticker) {
  cfg.onRoute(sectionId);
  let tries = 0;
  const find = () => {
    const el = document.querySelector(`#${sectionId} [data-live="${ticker}"]`);
    if (el) {
      const card = el.closest('.cx-card, .scr-card, .dt-card, .fade-card, .bt-card') || el;
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      card.classList.add('cmdk-flash');
      setTimeout(() => card.classList.remove('cmdk-flash'), 1700);
    } else if (tries++ < 20) setTimeout(find, 150);
  };
  setTimeout(find, 120);
}

// Sections currently showing this ticker (cards are rendered with data-live).
function sectionsWithTicker(ticker) {
  const ids = new Set();
  document.querySelectorAll(`[data-live="${ticker}"]`).forEach(el => {
    const sec = el.closest('section.tabbable, section[id]');
    if (sec && sec.id && sec.id !== 'options') ids.add(sec.id);  // options has its own ticker command
  });
  return [...ids];
}

function tickerCommands(q) {
  const tk = q.toUpperCase();
  const cmds = [{
    ic: '💰', kind: 'Ticker', title: `Options flow → <b>${esc(tk)}</b>`,
    run: () => cfg.onTickerOptions(tk),
  }];
  const labelOf = id => (cfg.sections.find(s => s.id === id) || {}).label || id;
  sectionsWithTicker(tk).forEach(id => cmds.push({
    ic: '📍', kind: 'Reveal', title: `Show <b>${esc(tk)}</b> in ${esc(labelOf(id))}`,
    run: () => revealTicker(id, tk),
  }));
  return cmds;
}

function match(q, hay) { return hay.toLowerCase().includes(q); }

function buildResults(raw) {
  const q = raw.trim().toLowerCase();
  if (!q) {
    // Empty query: a few helpful defaults.
    return cfg.sections.slice(0, 8).map(s => sectionCmd(s));
  }
  const out = [];
  if (TICKER_RE.test(raw.trim())) out.push(...tickerCommands(raw.trim()));
  cfg.sections.forEach(s => { if (match(q, s.label) || match(q, s.id) || match(q, s.group)) out.push(sectionCmd(s)); });
  cfg.learn.forEach(l => { if (match(q, l.label) || match(q, l.group)) out.push(learnCmd(l)); });
  return out.slice(0, MAX_RESULTS);
}

function sectionCmd(s) {
  return { ic: '↪', kind: 'Go to', title: `${esc(s.label)} <span style="color:#6b7280;font-size:.78em">· ${esc(s.group)}</span>`, run: () => cfg.onRoute(s.id) };
}
function learnCmd(l) {
  return { ic: '📚', kind: 'Learn', title: esc(l.label), run: () => cfg.onLearn(l.key) };
}

function rebuild(raw) {
  results = buildResults(raw);
  active = 0;
  render();
}

function render() {
  if (!results.length) { list.innerHTML = `<li class="cmdk-empty">No matches. Try a section name, a ticker (e.g. NVDA), or a concept.</li>`; return; }
  list.innerHTML = results.map((r, i) =>
    `<li class="cmdk-item${i === active ? ' active' : ''}" data-i="${i}"><span class="cmdk-ic">${r.ic}</span><span class="cmdk-title">${r.title}</span><span class="cmdk-kind">${r.kind}</span></li>`
  ).join('');
  list.querySelectorAll('.cmdk-item').forEach(el => {
    el.addEventListener('mouseenter', () => { active = +el.dataset.i; highlight(); });
    el.addEventListener('click', () => run(+el.dataset.i));
  });
}

function highlight() {
  list.querySelectorAll('.cmdk-item').forEach((el, i) => el.classList.toggle('active', i === active));
}

function run(i) {
  const r = results[i];
  if (!r) return;
  close();
  r.run();
}

function onKey(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, results.length - 1); highlight(); scrollActive(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); highlight(); scrollActive(); }
  else if (e.key === 'Enter') { e.preventDefault(); run(active); }
  else if (e.key === 'Escape') { e.preventDefault(); close(); }
}
function scrollActive() {
  const el = list.querySelector('.cmdk-item.active');
  if (el) el.scrollIntoView({ block: 'nearest' });
}

export function openPalette() {
  if (!overlay) return;
  overlay.hidden = false;
  document.body.style.overflow = 'hidden';
  input.value = '';
  rebuild('');
  setTimeout(() => input.focus(), 0);
}
function close() {
  if (!overlay) return;
  overlay.hidden = true;
  document.body.style.overflow = '';
}

export function initCommandPalette(config) {
  cfg = config;
  injectStyles();
  buildOverlay();
  // Global ⌘K / Ctrl-K toggles the palette.
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      overlay.hidden ? openPalette() : close();
    }
  });
}

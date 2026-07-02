// Ticker lookup modal — the "search any stock" surface. Type a ticker in the
// command palette and this opens a single card that answers three questions:
//   1. What's it doing now?  → live price + change (+ pre/after-hours)
//   2. Is it a good time to buy?  → plain-English verdict from the app's own
//      technical signal engine (lib/signal.js, via /api/chart)
//   3. Where else does the app mention it?  → jump-to chips for any tab already
//      showing the ticker.
// The grade + chart itself is delegated to the app's shared renderChart so the
// verdict here always matches what every card in the app shows.
import { esc } from './format.js';

// Maps the signal engine's action → a plain-language "good time to buy?" answer.
const VERDICT = {
  STRONG_BUY:  { cls: 'strong_buy', icon: '✅', head: 'Yes — a strong entry',  sub: 'Multiple signals line up on the buy side right now.' },
  BUY:         { cls: 'buy',        icon: '🟢', head: 'Leaning yes',           sub: 'Momentum is positive — confirm the setup before sizing up.' },
  HOLD:        { cls: 'hold',       icon: '⏸️', head: 'Not a clear entry',     sub: 'Signals are mixed. Waiting for a cleaner setup is reasonable.' },
  SELL:        { cls: 'sell',       icon: '🔴', head: 'Not right now',         sub: 'Momentum is negative — buying here fights the trend.' },
  STRONG_SELL: { cls: 'strong_sell',icon: '⛔', head: 'No',                    sub: 'Sellers are firmly in control.' },
};

let cfg = null;           // { renderChart, findMentions, onReveal }
let overlay = null, body = null, refreshTimer = null, curTicker = null;

function build() {
  overlay = document.createElement('div');
  overlay.className = 'cx-help-backdrop';
  overlay.id = 'tkl-modal';
  overlay.hidden = true;
  overlay.innerHTML = `<div class="cx-help-card" role="dialog" aria-modal="true" aria-label="Stock lookup">
    <button class="cx-help-x" id="tkl-x" aria-label="Close">✕</button>
    <div id="tkl-body"></div>
  </div>`;
  document.body.appendChild(overlay);
  body = overlay.querySelector('#tkl-body');
  overlay.querySelector('#tkl-x').addEventListener('click', close);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !overlay.hidden) close(); });
}

function priceLine(price) {
  const chg = price.regChangePct;
  const up = chg == null ? true : chg >= 0;
  const chgTxt = chg == null ? '' :
    `<span class="tkl-chg" style="color:${up ? 'var(--green)' : 'var(--red)'}">${up ? '+' : ''}${price.regChange} (${up ? '+' : ''}${chg}%)</span>`;
  const ah = price.afterHours
    ? `<span class="tkl-ah">${price.afterHours.session === 'pre' ? 'Pre' : 'After'}-hrs <b style="color:${price.afterHours.change >= 0 ? 'var(--green)' : 'var(--red)'}">$${price.afterHours.price} (${price.afterHours.change >= 0 ? '+' : ''}${price.afterHours.changePct}%)</b></span>`
    : '';
  return `<div class="tkl-price"><span class="tkl-px">$${price.live}</span>${chgTxt}</div>${ah ? `<div class="tkl-ah-row">${ah}</div>` : ''}`;
}

function verdictBanner(live) {
  const v = VERDICT[live.action] || VERDICT.HOLD;
  return `<div class="tkl-verdict sig-banner ${v.cls}">
    <div class="tkl-vic">${v.icon}</div>
    <div class="tkl-vtext">
      <div class="tkl-vhead">Good time to buy? <b>${esc(v.head)}</b></div>
      <div class="tkl-vsub">${esc(v.sub)} <span class="tkl-vconf">Signal confidence ${live.confidence}/10.</span></div>
    </div>
  </div>`;
}

function mentionsBlock(ticker) {
  const mentions = (cfg.findMentions ? cfg.findMentions(ticker) : []) || [];
  if (!mentions.length) {
    return `<div class="tkl-mentions"><div class="tkl-mtitle">Elsewhere in the app</div>
      <div class="tkl-mnone">Not currently shown on any other tab. Open a screener or the Momentum tab and it'll appear here if it's on the list.</div></div>`;
  }
  const chips = mentions.map(m =>
    `<button class="tkl-chip" data-reveal="${esc(m.id)}">${esc(m.label)}</button>`
  ).join('');
  return `<div class="tkl-mentions"><div class="tkl-mtitle">Also on these tabs — tap to jump</div>
    <div class="tkl-chips">${chips}</div></div>`;
}

function renderBody(data) {
  const { ticker, live, price } = data;
  body.innerHTML = `
    <div class="tkl-head"><span class="tkl-tk">📈 ${esc(ticker)}</span></div>
    ${priceLine(price)}
    ${verdictBanner(live)}
    <div id="tkl-chart"></div>
    ${mentionsBlock(ticker)}`;

  // Delegate the grade banner + levels + live chart to the app's shared renderer.
  const chartPanel = body.querySelector('#tkl-chart');
  try { cfg.renderChart(chartPanel, data); }
  catch { chartPanel.innerHTML = `<div class="chart-err">Chart unavailable.</div>`; }

  body.querySelectorAll('.tkl-chip').forEach(el => el.addEventListener('click', () => {
    const id = el.dataset.reveal;
    close();                       // close() clears curTicker, so read it first
    if (cfg.onReveal) cfg.onReveal(id, ticker);
  }));
}

async function load(ticker, silent) {
  try {
    const res = await fetch('/api/chart?ticker=' + encodeURIComponent(ticker));
    if (!res.ok) throw new Error('no data');
    const data = await res.json();
    if (curTicker !== ticker) return;   // user moved on
    renderBody(data);
  } catch {
    if (!silent && curTicker === ticker) {
      body.innerHTML = `<div class="tkl-head"><span class="tkl-tk">📈 ${esc(ticker)}</span></div>
        <div class="chart-err">Couldn't load data for ${esc(ticker)}. Check the symbol and try again.</div>`;
    }
  }
}

export function openTickerLookup(ticker) {
  if (!overlay) return;
  const tk = (ticker || '').toUpperCase().trim();
  if (!tk) return;
  curTicker = tk;
  overlay.hidden = false;
  document.body.style.overflow = 'hidden';
  body.innerHTML = `<div class="tkl-head"><span class="tkl-tk">📈 ${esc(tk)}</span></div>
    <div class="chart-loading"><div class="mom-spinner"></div>Loading live price, chart &amp; signal for ${esc(tk)}…</div>`;
  load(tk);
  // Keep it live while open — /api/chart is cached 60s server-side, so cheap.
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => load(tk, true), 60 * 1000);
}

function close() {
  if (!overlay) return;
  overlay.hidden = true;
  document.body.style.overflow = '';
  curTicker = null;
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

export function initTickerLookup(config) {
  cfg = config;
  build();
}

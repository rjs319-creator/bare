// Live intraday price overlay for the screener cards. The screeners run on daily
// (EOD) bars; this fetches a near-live quote (/api/price, 5-min + pre/post, 30s
// cache) for the names ON SCREEN and shows price + intraday % next to each ticker.
// Cards opt in with data-live="TICKER"; a .live-px badge is injected/updated.
import { esc } from './format.js';

// Sub-tabs that get the overlay (daytrade already has its own live price).
export const LIVE_SCREENERS = new Set(['opportunities', 'screener', 'custom', 'ghost', 'trendrider', 'fade', 'confluence']);

async function fetchPrices(tickers) {
  const out = {};
  for (let i = 0; i < tickers.length; i += 12) {          // /api/price caps at 12/call
    const chunk = tickers.slice(i, i + 12);
    try {
      const d = await fetch('/api/price?tickers=' + encodeURIComponent(chunk.join(','))).then(r => r.json());
      if (d && !d.error) Object.assign(out, d);
    } catch { /* offline / rate-limited — leave gaps, keep the daily close visible */ }
  }
  return out;
}

function badgeHTML(q) {
  const pct = parseFloat(q.changePct);
  const col = pct > 0 ? 'var(--green)' : pct < 0 ? 'var(--red)' : 'var(--text-dim)';
  const ext = q.afterHours ? ` <span class="live-ext">${q.afterHours.session === 'pre' ? 'pre' : 'aft'} $${esc(q.afterHours.price)}</span>` : '';
  return `<span class="live-dot live-${(q.marketState || 'CLOSED').toLowerCase()}"></span>`
    + `$${esc(q.price)} <span style="color:${col}">${pct > 0 ? '+' : ''}${esc(q.changePct)}%</span>${ext}`;
}

// Cards render a headline % from cached daily (EOD) screener data, which can be a
// full day stale (yesterday's close-over-close) versus today's live move. Once we
// have the live quote for a card, overwrite that headline so it reflects today's
// regular-session change (vs previous close) — one truth on screen.
const HEADLINE_SEL = '.scr-chg, .cx-chg, [data-change]';
function syncHeadline(liveEl, q) {
  const card = liveEl.closest('.scr-card, .cx-card, .dt-card, .fade-card, .bt-card');
  if (!card) return;
  const chg = card.querySelector(HEADLINE_SEL);
  if (!chg) return;
  const pct = parseFloat(q.changePct);
  if (Number.isNaN(pct)) return;
  const up = pct >= 0;
  chg.textContent = (up ? '▲ +' : '▼ ') + q.changePct + '%';
  chg.classList.toggle('up', up);
  chg.classList.toggle('down', !up);
}

// "🟢 live · HH:MM:SS · N names" indicator in the section header (updated on refresh).
function updateAsOf(section, n) {
  let el = section.querySelector('.live-asof');
  if (!el) {
    el = document.createElement('div');
    el.className = 'live-asof';
    const label = section.querySelector('.section-label');
    if (label) label.insertAdjacentElement('afterend', el);   // its own line below the header (mobile-safe)
    else section.insertBefore(el, section.firstChild);
  }
  const t = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  el.innerHTML = `<span class="live-dot live-regular"></span>live · ${t} · ${n} name${n === 1 ? '' : 's'}`;
}

let busy = false;
async function hydrate(section) {
  if (!section || busy) return;
  const els = [...section.querySelectorAll('[data-live]')];
  if (!els.length) return;
  const tickers = [...new Set(els.map(e => (e.dataset.live || '').toUpperCase()).filter(Boolean))];
  if (!tickers.length) return;
  busy = true;
  let prices = {};
  try { prices = await fetchPrices(tickers); } finally { busy = false; }
  let n = 0;
  for (const el of els) {
    const q = prices[(el.dataset.live || '').toUpperCase()];
    if (!q) continue;
    let badge = el.querySelector(':scope > .live-px');
    if (!badge) { badge = document.createElement('span'); badge.className = 'live-px'; el.appendChild(badge); }
    badge.innerHTML = badgeHTML(q);
    syncHeadline(el, q);
    n++;
  }
  if (n) updateAsOf(section, n);
}

let timer = null, current = null;
const earlyTimers = [];
export function startLivePrices(section) {
  stopLivePrices();
  current = section;
  hydrate(section);                                                    // cards may already be there
  [2000, 5000, 12000].forEach(t => earlyTimers.push(setTimeout(() => { if (current === section) hydrate(section); }, t)));  // catch async loads
  timer = setInterval(() => hydrate(current), 30000);                  // near-live refresh
}
export function stopLivePrices() {
  if (timer) clearInterval(timer);
  earlyTimers.forEach(clearTimeout); earlyTimers.length = 0;
  if (current) { const a = current.querySelector('.live-asof'); if (a) a.remove(); }
  timer = null; current = null;
}

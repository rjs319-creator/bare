// Live intraday price overlay for the screener cards. The screeners run on daily
// (EOD) bars; this fetches a near-live quote (/api/price, 5-min + pre/post, 30s
// cache) for the names ON SCREEN and shows price + intraday % next to each ticker.
// Cards opt in with data-live="TICKER"; a .live-px badge is injected/updated.
import { esc } from './format.js';

// Sub-tabs that get the overlay (daytrade already has its own live price).
export const LIVE_SCREENERS = new Set(['screener', 'custom', 'ghost', 'trendrider', 'fade', 'confluence']);

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
  for (const el of els) {
    const q = prices[(el.dataset.live || '').toUpperCase()];
    if (!q) continue;
    let badge = el.querySelector(':scope > .live-px');
    if (!badge) { badge = document.createElement('span'); badge.className = 'live-px'; el.appendChild(badge); }
    badge.innerHTML = badgeHTML(q);
  }
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
  timer = null; current = null;
}

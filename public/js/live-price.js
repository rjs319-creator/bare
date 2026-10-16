// Intraday price overlay for the screener cards. The screeners run on daily
// (EOD) bars; this fetches the latest available quote (/api/price, 5-min + pre/post, 30s
// cache) for the names ON SCREEN and shows price + intraday % next to each ticker.
// Cards opt in with data-live="TICKER"; a .live-px badge is injected/updated.
import { esc } from './format.js';
import { fetchJSON } from './fetch-json.js';

// Sub-tabs that get the overlay (daytrade already has its own live price).
// xalerts = Trade Alerts: cards carry data-live on .cx-ticker, so each alert shows a
// live price + daily up/down change next to the ticker, refreshed ~every 30s.
export const LIVE_SCREENERS = new Set(['opportunities', 'screener', 'custom', 'ghost', 'trendrider', 'fade', 'confluence', 'xalerts']);

export async function fetchPrices(tickers) {
  const out = {};
  for (let i = 0; i < tickers.length; i += 12) {          // /api/price caps at 12/call
    const chunk = tickers.slice(i, i + 12);
    try {
      const d = await fetchJSON('/api/price?tickers=' + encodeURIComponent(chunk.join(',')));
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

// ── Section "as of" strip ────────────────────────────────────────────────────────────
// What the strip may claim comes from the QUOTES, never from the polling clock:
//   • the word "live" is earned only when the exchange session (marketState, derived
//     server-side from the exchange calendar) is REGULAR;
//   • the data time is the quote's own observedAt (provider print time). When the
//     provider gave none, the time is stated as unknown — the moment we polled is shown
//     separately and labelled "checked", so it can never read as the data's age.
// A Saturday poll of Friday's bars therefore reads "last close · Oct 2, 2026, 4:00 PM ET".
const NY_STAMP = { timeZone: 'America/New_York', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
const NY_CLOCK = { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' };
const NY_DAY = { timeZone: 'America/New_York', year: 'numeric', month: 'short', day: 'numeric' };
const SESSION_WORD = { REGULAR: 'live', PRE: 'pre-market', POST: 'after-hours', CLOSED: 'last close' };

function etStamp(ms, now) {
  const d = new Date(ms);
  try {
    const sameDay = d.toLocaleDateString('en-US', NY_DAY) === new Date(now).toLocaleDateString('en-US', NY_DAY);
    return `${d.toLocaleString('en-US', sameDay ? NY_CLOCK : NY_STAMP)} ET`;
  } catch { return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`; }
}

/**
 * Pure. Decide what the strip says for a batch of quotes.
 * @param {object|Array} quotes  ticker→quote map (or array) as returned by /api/price
 * @param {Date|number} [now]
 * @returns {{ state: string, live: boolean, dotClass: string, label: string, observedAt: string|null, count: number }}
 */
export function asOfLabelFor(quotes, now = new Date()) {
  const list = (Array.isArray(quotes) ? quotes : Object.values(quotes || {})).filter(q => q && typeof q === 'object');
  const states = new Set(list.map(q => String(q.marketState || '').toUpperCase()));
  // One session per poll in practice; if the batch ever disagrees, take the LEAST live
  // reading — a mixed batch must not borrow the "live" word from one of its members.
  const state = !list.length ? 'UNKNOWN'
    : ['CLOSED', 'POST', 'PRE', 'REGULAR'].find(s => states.has(s)) || 'UNKNOWN';
  const observedMs = list.map(q => Date.parse(q.observedAt)).filter(Number.isFinite);
  const newest = observedMs.length ? Math.max(...observedMs) : null;
  const dates = [...new Set(list.map(q => q.observedDate).filter(Boolean))].sort();
  const word = SESSION_WORD[state] || 'session unknown';
  const when = newest != null ? etStamp(newest, now)
    : dates.length ? `${dates[dates.length - 1]} (time unknown)`
      : 'quote time unknown';
  const n = list.length;
  return {
    state,
    live: state === 'REGULAR',
    dotClass: state === 'REGULAR' ? 'live-regular' : state === 'PRE' ? 'live-pre' : state === 'POST' ? 'live-post' : 'live-closed',
    label: `${word} · ${state === 'REGULAR' || state === 'PRE' || state === 'POST' ? 'quotes as of ' : ''}${when} · ${n} name${n === 1 ? '' : 's'}`,
    observedAt: newest != null ? new Date(newest).toISOString() : null,
    count: n,
  };
}

function updateAsOf(section, shown) {
  let el = section.querySelector('.live-asof');
  if (!el) {
    el = document.createElement('div');
    el.className = 'live-asof';
    el.setAttribute('role', 'status');
    const label = section.querySelector('.section-label');
    if (label) label.insertAdjacentElement('afterend', el);   // its own line below the header (mobile-safe)
    else section.insertBefore(el, section.firstChild);
  }
  const now = new Date();
  const a = asOfLabelFor(shown, now);
  let checked = '';
  try { checked = ` <span class="live-checked">· checked ${esc(now.toLocaleTimeString('en-US', NY_CLOCK))} ET</span>`; } catch { /* no TZ data → omit */ }
  el.classList.toggle('is-live', a.live);
  el.innerHTML = `<span class="live-dot ${a.dotClass}"></span>${esc(a.label)}${checked}`;
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
  // The user switched sections while this poll was in flight: an obsolete response must
  // not paint badges / an "as of" strip into a section that is no longer the live one.
  if (current !== section) { if (current) hydrate(current); return; }
  const shown = [];
  for (const el of els) {
    const q = prices[(el.dataset.live || '').toUpperCase()];
    if (!q) continue;
    let badge = el.querySelector(':scope > .live-px');
    if (!badge) { badge = document.createElement('span'); badge.className = 'live-px'; el.appendChild(badge); }
    badge.innerHTML = badgeHTML(q);
    syncHeadline(el, q);
    shown.push(q);
  }
  if (shown.length) updateAsOf(section, shown);
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

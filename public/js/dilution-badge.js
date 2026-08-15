// 424B5 dilution badge — SHADOW research overlay on candidate cards. Mirrors the
// flow-badge mechanics (cards opt in with data-live="TICKER"); shows "⚠️ 424B5" when a
// name filed a prospectus supplement (new-share/ATM offering paperwork) inside the frozen
// 91-day research window. Display + honesty only: it changes no rank, no selection, no
// sizing — the finding behind it (research/95) is under prospective validation and the
// badge must say so.
import { fetchJSON } from './fetch-json.js';

// Same candidate tabs the flow badge decorates, plus the swing research strips.
export const DILUTION_BADGE_TABS = new Set(['screener', 'custom', 'ghost', 'trendrider', 'fade', 'confluence', 'daytrade', 'opportunities']);

let lookup = null;      // ticker -> { lastFiled, ageDays, fresh, filings }
let loading = null;

function ensureLookup() {
  if (lookup) return Promise.resolve(lookup);
  if (!loading) {
    loading = fetchJSON('/api/tracker?op=dilution').then(d => {
      lookup = (d && d.ok && d.available && d.symbols) ? d.symbols : {};
      return lookup;
    }).catch(() => { lookup = {}; return lookup; });
  }
  return loading;
}

function applyBadge(el, r) {
  if (!el || el.dataset.dilutionDecorated) return;
  el.dataset.dilutionDecorated = '1';
  const b = document.createElement('span');
  b.className = 'dilution-badge cx-tierbadge';
  b.style.cssText = 'margin-left:6px;color:var(--amber,#f59e0b);border-color:currentColor';
  b.title = `Filed a 424B5 prospectus supplement ${r.ageDays} day${r.ageDays === 1 ? '' : 's'} ago`
    + `${r.filings > 1 ? ` (${r.filings} filings in the last 91 days)` : ''} — paperwork to sell new shares (follow-on / ATM / shelf takedown). `
    + 'In 2021-2026 research (1,722 events) such names lagged SPY on average over the following week and quarter. '
    + 'SHADOW research flag under prospective validation — unvalidated forward, NOT a sell signal, and it changes no ranking in this app.';
  b.textContent = r.fresh ? '⚠️ 424B5 fresh' : '⚠️ 424B5';
  el.insertAdjacentElement('afterend', b);
}

async function decorate(section) {
  if (!section) return;
  const m = await ensureLookup();
  if (!m || !Object.keys(m).length) return;
  section.querySelectorAll('[data-live]').forEach(el => {
    const r = m[(el.dataset.live || '').toUpperCase()];
    if (r) applyBadge(el, r);
  });
}

// Decorate now, then retry to catch cards that load asynchronously after the tab
// opens (same schedule as the flow badge; filings don't change intraday).
export function startDilutionBadges(section) {
  decorate(section);
  [1500, 4000, 9000].forEach(t => setTimeout(() => decorate(section), t));
}

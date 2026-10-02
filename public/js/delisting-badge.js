// Delisting-pending badge — SHADOW research overlay on candidate cards. Mirrors the 424B5
// dilution badge (cards opt in with data-live="TICKER"); shows "⚠️ delisting notice" when a
// name has an EDGAR Form 25 / 25-NSE (exchange removal) or Form 15-12G / 15-15D
// (deregistration) notice inside the frozen 45-day window. Display + honesty only: it changes
// no rank, no selection, no sizing — the hypothesis behind it (registry row
// delisting-pending-avoid) is preregistered and unvalidated, and the badge must say so.
import { fetchJSON } from './fetch-json.js';
import { DILUTION_BADGE_TABS } from './dilution-badge.js';

// Surfaces exactly where the dilution flag surfaces.
export const DELISTING_BADGE_TABS = new Set(DILUTION_BADGE_TABS);

let lookup = null;      // ticker -> { form, kind, filedAt, effectiveAt, status, confidence, ageDays, filings }
let loading = null;

function ensureLookup() {
  if (lookup) return Promise.resolve(lookup);
  if (!loading) {
    loading = fetchJSON('/api/tracker?op=delisting').then(d => {
      lookup = (d && d.ok && d.available && d.symbols) ? d.symbols : {};
      return lookup;
    }).catch(() => { lookup = {}; return lookup; });
  }
  return loading;
}

const KIND_LABEL = { 'exchange-delisting': 'exchange delisting (Form 25)', deregistration: 'deregistration (Form 15-12G)', 'reporting-suspension': 'suspension of reporting (Form 15-15D)' };

function applyBadge(el, r) {
  if (!el || el.dataset.delistingDecorated) return;
  el.dataset.delistingDecorated = '1';
  const b = document.createElement('span');
  b.className = 'delisting-badge cx-tierbadge';
  b.style.cssText = 'margin-left:6px;color:var(--red,#ef4444);border-color:currentColor';
  const when = r.status === 'pending' ? `effective ${r.effectiveAt}` : `effective since ${r.effectiveAt}`;
  b.title = `EDGAR ${KIND_LABEL[r.kind] || r.form} notice filed ${r.ageDays} day${r.ageDays === 1 ? '' : 's'} ago (${when}`
    + `${r.filings > 1 ? `, ${r.filings} filings in the window` : ''}). `
    + `Ticker join confidence: ${r.confidence}. A Form 25 is also filed on a voluntary exchange transfer, so this reads "notice on file", not "going to zero". `
    + 'SHADOW research flag — preregistered, unvalidated forward, NOT a sell signal, and it changes no ranking in this app.';
  b.textContent = r.status === 'pending' ? '⚠️ delisting pending' : '⚠️ delisting notice';
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

// Decorate now, then retry to catch cards that load asynchronously after the tab opens
// (same schedule as the dilution badge; filings don't change intraday).
export function startDelistingBadges(section) {
  decorate(section);
  [1500, 4000, 9000].forEach(t => setTimeout(() => decorate(section), t));
}

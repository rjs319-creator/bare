// 🚩 Filing red-flag badge — SHADOW AVOID-side research overlay on candidate cards. Same
// mechanics as the 424B5 dilution badge (cards opt in with data-live="TICKER"); shows
// "🚩 red flag" when a name has a recent SEC filing red flag (late-filing notice, 8-K
// non-reliance / auditor change / listing deficiency / CEO-CFO exit, first going-concern
// language) inside the frozen 91-day window. Display + honesty only: it changes no rank,
// no selection, no sizing — the lane is under prospective validation and must say so.
import { fetchJSON } from './fetch-json.js';
import { DILUTION_BADGE_TABS } from './dilution-badge.js';

// Wherever the dilution badge renders, plus the Today board.
export const REDFLAG_BADGE_TABS = new Set([...DILUTION_BADGE_TABS, 'today']);

let lookup = null;      // ticker -> { flags, lastDate, ageDays, events }
let labels = {};        // flag id -> plain-English label (served by op=redflags)
let loading = null;

function ensureLookup() {
  if (lookup) return Promise.resolve(lookup);
  if (!loading) {
    loading = fetchJSON('/api/tracker?op=redflags').then(d => {
      lookup = (d && d.ok && d.available && d.symbols) ? d.symbols : {};
      if (d && d.flags) labels = Object.fromEntries(Object.entries(d.flags).map(([k, v]) => [k, v && v.label ? v.label : k]));
      return lookup;
    }).catch(() => { lookup = {}; return lookup; });
  }
  return loading;
}

function applyBadge(el, r) {
  if (!el || el.dataset.redflagDecorated) return;
  el.dataset.redflagDecorated = '1';
  const kinds = (r.flags || []).map(f => labels[f] || f);
  const b = document.createElement('span');
  b.className = 'redflag-badge cx-tierbadge';
  b.style.cssText = 'margin-left:6px;color:var(--red,#ef4444);border-color:currentColor';
  b.title = `${kinds.join(' · ')} — filed ${r.ageDays} day${r.ageDays === 1 ? '' : 's'} ago`
    + `${r.events > 1 ? ` (${r.events} red-flag events in the last 91 days)` : ''}. `
    + 'SHADOW AVOID research lane (weight 0): such filings are hypothesised to precede SPY-underperformance; unvalidated forward. '
    + 'NOT a sell signal, NOT a short signal, and it changes no ranking in this app.';
  b.textContent = '🚩 red flag';
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
export function startRedflagBadges(section) {
  decorate(section);
  [1500, 4000, 9000].forEach(t => setTimeout(() => decorate(section), t));
}

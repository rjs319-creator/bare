// Reverse confluence: shows a "💰 flow" badge on screener cards when that same
// ticker has unusual options flow today (op=optionsflow — the same feed the
// Options tab renders). Mirrors the live-price overlay: cards opt in with
// data-live="TICKER" and we append the badge next to the ticker. This is the
// mirror of the confluence badges on the Options tab — it makes every screener
// options-aware so the tools cross-reference each other in both directions.
import { esc } from './format.js';
import { fetchJSON } from './fetch-json.js';

// Stock-screener sub-tabs whose cards should get the badge (have data-live).
export const FLOW_BADGE_TABS = new Set(['screener', 'custom', 'ghost', 'trendrider', 'fade', 'confluence', 'daytrade']);

let lookup = null;       // ticker -> { premium, callPremiumSharePct, premiumSkew }
let loading = null;      // in-flight promise (dedupes concurrent callers)
let navFn = null;        // optional: jump to the Options tab on click

export function setFlowNav(fn) { navFn = fn; }

function usd(n) { return n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + Math.round(n / 1e3) + 'k' : '$' + n; }

function ensureLookup() {
  if (lookup) return Promise.resolve(lookup);
  if (!loading) {
    loading = fetchJSON('/api/tracker?op=optionsflow').then(d => {
      const m = {};
      (d && d.signals || []).forEach(s => {
        const r = m[s.ticker] || (m[s.ticker] = { ticker: s.ticker, call: 0, put: 0, premium: 0 });
        if (s.side === 'call') r.call += s.premium; else r.put += s.premium;
        r.premium += s.premium;
      });
      Object.values(m).forEach(r => {
        r.callPremiumSharePct = r.premium ? Math.round(100 * r.call / r.premium) : 50;
        r.premiumSkew = r.callPremiumSharePct >= 60 ? 'call-dominant' : r.callPremiumSharePct <= 40 ? 'put-dominant' : 'balanced';
      });
      lookup = m;
      return m;
    }).catch(() => { lookup = {}; return lookup; });
  }
  return loading;
}

function applyBadge(el, r) {
  if (!el || el.dataset.flowDecorated) return;
  el.dataset.flowDecorated = '1';
  // The badge marks PRESENCE of unusual options activity and its call/put premium split.
  // It carries no direction: delayed chains cannot distinguish an opening bet from a
  // hedge, a roll, a spread leg, or a covered-call write, so no green-up / red-down.
  const b = document.createElement('span');
  b.className = 'flow-badge cx-tierbadge';
  b.style.cssText = 'margin-left:6px;cursor:pointer;color:var(--text-dim);border-color:currentColor';
  b.title = `Unusual options activity today: ${usd(r.premium)} estimated premium · ${r.callPremiumSharePct}% of it in calls (${r.premiumSkew}). `
    + 'That split is a composition statistic, NOT a directional read. Tap to open the Options tab.';
  b.innerHTML = '💰 flow';
  b.addEventListener('click', e => { e.stopPropagation(); if (navFn) navFn(); });
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

// Decorate now, then retry to catch cards that load asynchronously after the
// tab opens (flow doesn't change intraday, so no polling interval is needed).
export function startFlowBadges(section) {
  decorate(section);
  [1500, 4000, 9000].forEach(t => setTimeout(() => decorate(section), t));
}

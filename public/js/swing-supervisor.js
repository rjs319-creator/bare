// SWING SUPERVISOR — frontend view (ES module, mirrors omega-swing.js). Renders the
// op=swingmonitor payload as a lifecycle command surface: every non-terminal published
// swing episode (New / Still Valid / Waiting / Needs Attention) plus collapsed terminal
// lanes (No Longer Actionable / Completed / Archive). Server-authoritative.
//
// HONESTY: the honesty banner + warnings are rendered VERBATIM from the server. The router
// block is a SHADOW algorithm tilt — its multipliers are NOT probabilities and are never
// presented as such. Numbers are guarded with Number.isFinite before formatting so a null
// field renders '—', never 'null' / 'undefined' / 'NaN'.

import { esc } from './format.js';

// Lifecycle-state chip colors (spec color map). Anything unlisted falls back to grey.
const LIFECYCLE_COLOR = {
  THESIS_INTACT: '#16a34a', ENTERABLE: '#16a34a', TARGET_HIT: '#16a34a',
  WEAKENING: '#f59e0b', EXTENDED: '#f59e0b', VALID_BUT_DISPLACED: '#f59e0b', WAITING_FOR_TRIGGER: '#f59e0b',
  INVALIDATED: '#dc2626', NO_FILL: '#dc2626', EXPIRED: '#dc2626',
  DATA_STALE: '#9ca3af',
};
const chipColor = (s) => LIFECYCLE_COLOR[s] || '#9ca3af';

// Terminal lanes render COLLAPSED (a closed <details>) so resolved episodes stay visible
// but out of the way. New/Actionable always show a header even when empty.
const COLLAPSED_SECTIONS = new Set(['noLongerActionable', 'completed', 'archive']);
const ALWAYS_SHOW_SECTIONS = new Set(['newCandidates', 'stillValid']);

export async function loadSwingSupervisor(container) {
  if (!container) return;
  container.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Loading swing lifecycle…</p></div>`;
  try {
    // Public read — same-origin GET, no auth header.
    const data = await fetch('/api/tracker?op=swingmonitor').then(r => r.json()).catch(() => null);
    renderSupervisor(container, data);
  } catch {
    container.innerHTML = `<div class="mom-status error"><p>Could not load the Swing Supervisor.</p></div>`;
  }
}

function renderSupervisor(container, data) {
  if (!data || typeof data !== 'object') {
    container.innerHTML = `<div class="mom-status error"><p>Swing Supervisor is unavailable right now.</p></div>`;
    return;
  }
  const order = Array.isArray(data.sectionOrder) ? data.sectionOrder : [];
  const labels = data.sectionLabels || {};
  const sections = data.sections || {};
  const counts = data.counts || {};

  let html = headerHtml(data);
  for (const key of order) {
    const cards = Array.isArray(sections[key]) ? sections[key] : [];
    const count = Number.isFinite(counts[key]) ? counts[key] : cards.length;
    if (!cards.length && !ALWAYS_SHOW_SECTIONS.has(key)) continue; // skip empty terminal lanes
    html += sectionHtml(key, labels[key] || key, cards, count);
  }

  // Destructive replace is SAFE here: the SERVER payload already unions all non-terminal
  // published episodes, so nothing the user cares about is dropped by overwriting innerHTML.
  container.innerHTML = html;
  container.querySelectorAll('[data-ticker]').forEach(el => el.addEventListener('click', () => {
    const t = el.getAttribute('data-ticker');
    if (t && window.openTickerLookup) window.openTickerLookup(t);
  }));
}

// ── Header: honesty banner (verbatim, muted) + gen time + warnings + shadow router line ──
function headerHtml(data) {
  const gen = Number.isFinite(Date.parse(data.generatedAt))
    ? new Date(data.generatedAt).toLocaleTimeString() : '—';
  const supp = Number.isFinite(data.suppressedReentries) && data.suppressedReentries > 0
    ? ` · ${data.suppressedReentries} re-entry ${data.suppressedReentries === 1 ? 'signal' : 'signals'} suppressed` : '';

  let html = `<div class="om-banner">`;
  if (data.honesty) html += `<div class="om-note" style="opacity:0.85">${esc(data.honesty)}</div>`;
  html += `<div class="om-foot"><span>Updated ${esc(gen)}${supp}</span>`;
  html += `<span>${routerLine(data.router)}</span></div>`;
  const warnings = Array.isArray(data.warnings) ? data.warnings.filter(Boolean) : [];
  for (const w of warnings) {
    html += `<div class="om-note" style="border-left-color:#f59e0b;color:#f59e0b">⚠️ ${esc(w)}</div>`;
  }
  html += `</div>`;
  return html;
}

// Router is SHADOW: report only how many algos it scored — never surface a multiplier as a
// probability.
function routerLine(router) {
  if (!router || typeof router !== 'object') return '';
  const n = router.sources && typeof router.sources === 'object' ? Object.keys(router.sources).length : 0;
  if (!n) return '';
  return `<span style="opacity:0.7">Algorithm tilt (shadow): ${n} algos scored</span>`;
}

// ── Section: header + count, with terminal lanes wrapped in a closed <details> ──
function sectionHtml(key, label, cards, count) {
  const head = `${esc(label)} <span class="om-count">${count}</span>`;
  const body = cards.length
    ? `<div class="om-cards">${cards.map(cardHtml).join('')}</div>`
    : `<div class="om-tier-empty">None today.</div>`;

  if (COLLAPSED_SECTIONS.has(key)) {
    return `<details class="om-evidence"><summary>${head}</summary><div class="om-cards">${cards.map(cardHtml).join('')}</div></details>`;
  }
  return `<div class="om-tier-head"><h3>${head}</h3></div>${body}`;
}

// ── Number/format helpers — every one guards with Number.isFinite ──
// Signed percent from a decimal fraction (0.034 → "+3.4%"); '—' when not finite.
const pct = (x, d = 1) => Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%` : '—';
const signCls = (x) => Number.isFinite(x) ? (x >= 0 ? 'om-pos' : 'om-neg') : '';
const num = (x, d = 1) => Number.isFinite(x) ? x.toFixed(d) : null;
const priceTag = (p, x) => Number.isFinite(x) ? `${p}${x}` : null;

// "72→79" style transition (original → current); collapses gracefully when either is null.
function arrow(from, to) {
  const a = Number.isFinite(from) ? String(from) : null;
  const b = Number.isFinite(to) ? String(to) : null;
  if (a && b) return `${a}→${b}`;
  return b || a || '—';
}
function rankArrow(from, to) {
  const a = Number.isFinite(from) ? `#${from}` : null;
  const b = Number.isFinite(to) ? `#${to}` : null;
  if (a && b) return `${a}→${b}`;
  return b || a || '—';
}

// ── Card ──
function cardHtml(cd) {
  if (!cd || typeof cd !== 'object') return '';
  const stat = (label, val, cls = '') =>
    `<div class="om-stat"><span class="om-stat-l">${label}</span><span class="om-stat-v ${cls}">${val}</span></div>`;

  const side = cd.side === 'short' ? 'short' : cd.side === 'long' ? 'long' : null;
  const sideBadge = side
    ? `<span class="om-chip" style="background:${side === 'short' ? '#dc2626' : '#16a34a'};color:#fff">${side}</span>` : '';
  const state = cd.lifecycleState || '—';
  const stateChip = `<span class="om-chip" style="background:${chipColor(state)};color:#fff">${esc(state)}</span>`;

  // % of original target still remaining, from consumedPct (0..1.5).
  const remainPctVal = Number.isFinite(cd.consumedPct) ? (1 - cd.consumedPct) : null;
  const remainPct = remainPctVal == null ? '—' : `${Math.round(remainPctVal * 100)}%`;
  const rr = num(cd.remainingRewardRisk, 1);

  // Original plan line — read-only.
  const plan = [priceTag('e', cd.originalEntry), priceTag('s', cd.originalStop),
    Array.isArray(cd.originalTargets) && cd.originalTargets.some(Number.isFinite)
      ? 't' + cd.originalTargets.filter(Number.isFinite).join('/') : null].filter(Boolean).join(' / ');

  // Footer bits: freshness dot, strategy version, setup generation.
  const stale = cd.dataFreshness === 'stale';
  const freshDot = `<span style="color:${stale ? '#f59e0b' : '#16a34a'}" title="data ${stale ? 'stale' : 'fresh'}">●</span>`;
  const genTag = Number.isFinite(cd.setupGeneration) && cd.setupGeneration > 1 ? ` · gen ${cd.setupGeneration}` : '';
  const verTag = cd.strategyVersion ? ` · ${esc(String(cd.strategyVersion))}` : '';

  return `<div class="om-card">
    <div class="om-card-top">
      <div class="om-id" data-ticker="${esc(cd.ticker || '')}" role="button">
        <b class="om-tk">${esc(cd.ticker || '—')}</b>
        <span class="om-co">${esc(String(cd.company || '').slice(0, 28))}</span>
      </div>
    </div>
    <div class="om-chips">${sideBadge}${stateChip}${cd.terminal && cd.outcomeState
      ? `<span class="om-chip" style="background:#334155;color:#fff">${esc(cd.outcomeState)}</span>` : ''}</div>
    ${cd.explanation ? `<div class="om-why">${esc(cd.explanation)}</div>` : ''}
    <div class="om-stats">
      ${stat('Return', pct(cd.returnSinceSuggestion), signCls(cd.returnSinceSuggestion))}
      ${stat('vs SPY', pct(cd.excessVsSpy), signCls(cd.excessVsSpy))}
      ${stat('Age', Number.isFinite(cd.sessionsSinceSuggestion) ? cd.sessionsSinceSuggestion + 'd' : '—')}
      ${stat('Score', arrow(cd.originalScore, cd.currentScore))}
      ${stat('Rank', rankArrow(cd.originalRank, cd.currentRank))}
      ${stat('Rem R:R', rr ? rr + 'R' : '—')}
      ${stat('Target left', remainPct)}
      ${stat('MFE/MAE', `${pct(cd.mfeSinceSuggestion)} / ${pct(cd.maeSinceSuggestion)}`)}
    </div>
    ${plan ? `<div class="om-plan"><div class="om-plan-row"><span>Original</span><b>${esc(plan)}</b></div></div>` : ''}
    ${cd.originalThesis ? `<div class="om-cat" style="opacity:0.7;font-size:0.85em">${esc(String(cd.originalThesis).slice(0, 200))}</div>` : ''}
    <div class="om-foot">
      <span>${cd.actionState ? `<span class="om-chip">${esc(cd.actionState)}</span>` : ''}</span>
      <span>${freshDot}${verTag}${genTag}</span>
    </div>
  </div>`;
}

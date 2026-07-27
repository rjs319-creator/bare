// PRE-MOVE INVENTORY — frontend view (ES module, mirrors swing-supervisor.js).
// Renders the op=premove payload: the SHADOW pre-move transition inventory with
// its PRIMED → ARMED → TRIGGERED → ACCEPTED → WEAKENING → INVALIDATED →
// EXPIRED → COMPLETED states, a novice line per card and an expandable expert
// block. Server-authoritative.
//
// HONESTY: probabilities render ONLY when the server marked them displayable
// (a valid calibration artifact exists). Otherwise the card shows the rank
// percentile + qualitative evidence band with the server's uncalibrated/shadow
// label VERBATIM. Numbers are guarded with Number.isFinite — a null renders
// '—', never 'null'/'NaN'.

import { esc } from './format.js';
import { fetchJSON, HEAVY_TIMEOUT_MS } from './fetch-json.js';

const STATE_COLOR = {
  PRIMED: '#64748b', ARMED: '#f59e0b', TRIGGERED: '#2563eb', ACCEPTED: '#16a34a',
  WEAKENING: '#f59e0b', INVALIDATED: '#dc2626', EXPIRED: '#9ca3af', COMPLETED: '#16a34a',
};
const chipColor = (s) => STATE_COLOR[s] || '#9ca3af';
const COLLAPSED_STATES = new Set(['INVALIDATED', 'EXPIRED', 'COMPLETED']);
const ALWAYS_SHOW = new Set(['PRIMED', 'ARMED', 'TRIGGERED']);

export async function loadPremove(container) {
  if (!container) return;
  container.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Loading pre-move inventory…</p></div>`;
  try {
    const data = await fetchJSON('/api/tracker?op=premove', { timeoutMs: HEAVY_TIMEOUT_MS }).catch(() => null);
    renderPremove(container, data);
  } catch {
    container.innerHTML = `<div class="mom-status error"><p>Could not load the Pre-Move inventory.</p></div>`;
  }
}

function renderPremove(container, data) {
  const board = data && data.board;
  if (!board || typeof board !== 'object') {
    container.innerHTML = `<div class="mom-status error"><p>Pre-Move inventory is unavailable right now.</p></div>`;
    return;
  }
  let html = `<div class="om-banner">`;
  html += `<div class="om-note" style="opacity:0.85">${esc(board.note || '')}</div>`;
  const gateLine = data.gate && data.gate.mayAffectLive
    ? 'enforce mode — validated artifact present'
    : `SHADOW · 0 weight · not affecting ranks (mode: ${esc(String(data.mode || 'shadow'))})`;
  html += `<div class="om-foot"><span class="td-action-badge">${gateLine}</span><span>${esc(String(data.date || ''))}</span></div>`;
  html += `</div>`;

  const states = Array.isArray(board.states) ? board.states : [];
  for (const s of states) {
    const cards = (board.byState && board.byState[s]) || [];
    if (!cards.length && !ALWAYS_SHOW.has(s)) continue;
    const head = `${esc(s)} <span class="om-count">${cards.length}</span>`;
    const body = cards.length ? `<div class="om-cards">${cards.map(cardHtml).join('')}</div>` : `<div class="om-tier-empty">None today.</div>`;
    html += COLLAPSED_STATES.has(s)
      ? `<details class="om-evidence"><summary>${head}</summary><div class="om-cards">${cards.map(cardHtml).join('')}</div></details>`
      : `<div class="om-tier-head"><h3>${head}</h3></div>${body}`;
  }
  container.innerHTML = html;
  container.querySelectorAll('[data-ticker]').forEach(el => el.addEventListener('click', () => {
    const t = el.getAttribute('data-ticker');
    if (t && window.openTickerLookup) window.openTickerLookup(t);
  }));
}

const num = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');

// A server displayNumber object → safe text ('34%' only when isPercent).
function probText(p) {
  if (!p || typeof p !== 'object') return '—';
  if (p.isPercent && p.display) return esc(String(p.display));
  return p.band ? `${esc(String(p.band))} <span style="opacity:0.6">(experimental score)</span>` : '—';
}

function cardHtml(cd) {
  if (!cd || typeof cd !== 'object') return '';
  const n = cd.novice || {};
  const e = cd.expert || {};
  const stateChip = `<span class="om-chip" style="background:${chipColor(cd.state)};color:#fff">${esc(cd.state || '—')}</span>`;
  const actionChip = n.action ? `<span class="om-chip">${esc(n.action)}</span>` : '';
  const rank = Number.isFinite(e.preMoveRank) ? `${Math.round(e.preMoveRank * 100)}th pctile` : '—';
  const wf = e.utilityWaterfall;
  const wfRows = wf && Array.isArray(wf.rows)
    ? wf.rows.map(r => `<div class="om-plan-row"><span>${esc(r.item)}</span><b>${num(r.bps, 1)} bps</b></div>`).join('')
      + `<div class="om-plan-row"><span><b>expected net utility</b></span><b>${num(wf.expectedNetUtilityBps, 1)} bps</b></div>`
    : '';
  return `<div class="om-card">
    <div class="om-card-top">
      <div class="om-id" data-ticker="${esc(cd.ticker || '')}" role="button">
        <b class="om-tk">${esc(cd.ticker || '—')}</b>
        <span class="om-co">${esc(String(cd.company || '').slice(0, 28))}</span>
      </div>
    </div>
    <div class="om-chips">${stateChip}${actionChip}${cd.sector ? `<span class="om-chip">${esc(cd.sector)}</span>` : ''}</div>
    ${n.reason ? `<div class="om-why">${esc(n.reason)}</div>` : ''}
    <div class="om-stats">
      <div class="om-stat"><span class="om-stat-l">Pre-move rank</span><span class="om-stat-v">${rank}</span></div>
      <div class="om-stat"><span class="om-stat-l">Evidence</span><span class="om-stat-v">${esc(String(e.evidenceBand || '—'))}</span></div>
      <div class="om-stat"><span class="om-stat-l">Invalidation</span><span class="om-stat-v">${Number.isFinite(n.invalidation) ? n.invalidation : '—'}</span></div>
      <div class="om-stat"><span class="om-stat-l">Timeframe</span><span class="om-stat-v">${esc(String(n.timeframe || '—'))}</span></div>
    </div>
    <details class="om-evidence"><summary>Expert view</summary>
      <div class="om-plan">
        <div class="om-plan-row"><span>P(trigger before invalidation)</span><b>${probText(e.pTriggerBeforeInvalidation)}</b></div>
        <div class="om-plan-row"><span>P(fill | trigger)</span><b>${probText(e.pFillGivenTrigger)}</b></div>
        <div class="om-plan-row"><span>P(target before stop | fill)</span><b>${probText(e.pTargetBeforeStopGivenFill)}</b></div>
        <div class="om-plan-row"><span>Expected net R | fill</span><b>${num(e.expectedNetRGivenFill)}</b></div>
        <div class="om-plan-row"><span>Severe-loss probability</span><b>${probText(e.severeLossProbability)}</b></div>
        <div class="om-plan-row"><span>Remaining opportunity</span><b>${Number.isFinite(e.remainingOpportunity) ? e.remainingOpportunity + '%' : '—'}</b></div>
        ${wfRows}
        ${e.triggerAssumptions ? `<div class="om-cat" style="opacity:0.7;font-size:0.85em">${esc(e.triggerAssumptions)}</div>` : ''}
        ${Array.isArray(e.missingFeatures) && e.missingFeatures.length ? `<div class="om-cat" style="opacity:0.6;font-size:0.8em">missing: ${esc(e.missingFeatures.slice(0, 8).join(', '))}${e.missingFeatures.length > 8 ? '…' : ''}</div>` : ''}
        ${Array.isArray(e.displacement) && e.displacement.length ? `<div class="om-cat" style="color:#f59e0b;font-size:0.85em">displaced: ${esc(e.displacement.join(', '))}</div>` : ''}
      </div>
    </details>
    <div class="om-foot">
      <span>${e.shadowLabel ? `<span style="opacity:0.7">${esc(e.shadowLabel)}</span>` : ''}</span>
      <span style="opacity:0.6">${esc(String((e.versions && e.versions.stageA) || ''))}</span>
    </div>
  </div>`;
}

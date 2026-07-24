// ATLAS-X — frontend research view (ES module, mirrors omega-swing.js / swing-supervisor.js).
// Renders the op=atlasx payload as a SHADOW / weight-0 research workspace: entry-lane CANDIDATE
// cards (Enter Next Session / Wait-for-Breakout / Wait-for-Pullback / Wait-for-Confirmation /
// Do Not Chase / Avoid), episode-lane EPISODE cards (Open / No Longer Actionable / Completed)
// from the shared swing supervisor, and a dedicated Evidence & Validation panel.
//
// HONESTY: ATLAS-X is weight-0 and CANNOT originate or affect any live trade. The server-supplied
// qualitative bands (`prosecutor.failureScore`, `targetBeforeStop`) are ALREADY strings and are
// rendered VERBATIM — never suffixed with '%' or reformatted as a probability. Only genuine RETURN
// magnitudes (bps / fractional returns from distribution / utilityWaterfall / expectedValueBps)
// are shown numerically, with a "bps" or "%" suffix as appropriate for a return, never a chance.
// Every number is guarded with Number.isFinite so a null field renders '—', not 'NaN'/'undefined'.

import { esc } from './format.js';
import { fetchJSON } from './fetch-json.js';

// Which lanes hold which card kind. Evidence is handled on its own path.
const ENTRY_LANES = new Set(['enterNextSession', 'waitBreakout', 'waitPullback', 'waitConfirmation', 'doNotChase', 'avoid']);
const EPISODE_LANES = new Set(['openEpisodes', 'noLongerActionable', 'completed']);
// Negative / resolved lanes render COLLAPSED (a closed <details>) so they stay visible with a
// label + count but out of the way; the primary lanes stay expanded even when empty.
const COLLAPSED_LANES = new Set(['doNotChase', 'avoid', 'noLongerActionable', 'completed']);

// Lifecycle-state chip colors, shared with the swing supervisor's palette.
const LIFECYCLE_COLOR = {
  THESIS_INTACT: '#16a34a', ENTERABLE: '#16a34a', TARGET_HIT: '#16a34a',
  WEAKENING: '#f59e0b', EXTENDED: '#f59e0b', VALID_BUT_DISPLACED: '#f59e0b', WAITING_FOR_TRIGGER: '#f59e0b',
  INVALIDATED: '#dc2626', NO_FILL: '#dc2626', EXPIRED: '#dc2626', DATA_STALE: '#9ca3af',
};
const chipColor = (s) => LIFECYCLE_COLOR[s] || '#9ca3af';

export async function loadAtlas(container) {
  if (!container) return;
  container.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Loading ATLAS-X research candidates…</p></div>`;
  try {
    // Public read — same-origin GET, no auth header.
    const data = await fetchJSON('/api/tracker?op=atlasx').catch(() => null);
    renderAtlas(container, data);
  } catch {
    container.innerHTML = `<div class="mom-status error"><p>Could not load ATLAS-X.</p></div>`;
  }
}

function renderAtlas(container, data) {
  if (!data || typeof data !== 'object' || data.ok === false) {
    container.innerHTML = `<div class="mom-status error"><p>ATLAS-X is unavailable right now.</p></div>`;
    return;
  }
  const gt = document.getElementById('atlas-gen-time');
  if (gt && Number.isFinite(Date.parse(data.generatedAt))) gt.textContent = new Date(data.generatedAt).toLocaleTimeString();

  const order = Array.isArray(data.sectionOrder) ? data.sectionOrder : [];
  const labels = data.sectionLabels || {};
  const sections = data.sections || {};
  const counts = data.counts || {};

  let html = shadowBanner(data);
  for (const key of order) {
    if (key === 'evidenceValidation') {
      html += evidencePanel(labels[key] || 'Evidence & Validation', (sections[key] || [])[0]);
      continue;
    }
    const cards = Array.isArray(sections[key]) ? sections[key] : [];
    const count = Number.isFinite(counts[key]) ? counts[key] : cards.length;
    html += laneHtml(key, labels[key] || key, cards, count, data);
  }

  container.innerHTML = html;
  container.querySelectorAll('[data-ticker]').forEach(el => el.addEventListener('click', () => {
    const t = el.getAttribute('data-ticker');
    if (t && window.openTickerLookup) window.openTickerLookup(t);
  }));
}

// ── Shadow / weight-0 banner — the honest headline, always at the top ──
function shadowBanner(data) {
  const gen = Number.isFinite(Date.parse(data.generatedAt)) ? new Date(data.generatedAt).toLocaleString() : '—';
  const ver = data.version ? esc(String(data.version)) : '—';
  return `<div class="om-banner">
    <div class="om-shadow">🛰 <b>ATLAS-X — SHADOW RESEARCH, weight-0.</b> Research candidate — cannot originate or affect any live trade. Governance: <b>${esc(String(data.governanceStatus || 'shadow'))}</b> · weight <b>${Number.isFinite(data.weight) ? data.weight : 0}</b>.</div>
    <div class="om-note">⚠️ Qualitative bands (failure score, target-before-stop) are shown verbatim, NOT as percentages — a number would imply a calibration that does not exist yet. Only genuine return magnitudes are shown numerically (bps / %).</div>
    <div class="om-foot"><span>Updated ${esc(gen)}${data.date ? ` · ${esc(String(data.date))}` : ''}</span><span>version ${ver}</span></div>
  </div>`;
}

// ── A lane: header + count, entry-lane candidate cards or episode-lane cards, with
// negative/resolved lanes collapsed. Enter Next Session shows emptyActionableNote when empty. ──
function laneHtml(key, label, cards, count, data) {
  const isEpisode = EPISODE_LANES.has(key);
  const render = isEpisode ? episodeCard : candidateCard;
  const head = `${esc(label)} <span class="om-count">${count}</span>`;

  let body;
  if (cards.length) {
    body = `<div class="om-cards">${cards.map(render).join('')}</div>`;
  } else if (key === 'enterNextSession' && data.emptyActionableNote) {
    body = `<div class="om-tier-empty">${esc(String(data.emptyActionableNote))}</div>`;
  } else {
    body = `<div class="om-tier-empty">None today.</div>`;
  }

  if (COLLAPSED_LANES.has(key)) {
    return `<details class="om-evidence"><summary>${head}</summary>${body}</details>`;
  }
  return `<div class="om-tier-head"><h3>${head}</h3></div>${body}`;
}

// ── Number / format helpers — every one guards with Number.isFinite ──
// Signed percent from a decimal fraction (0.034 → "+3.4%"); '—' when not finite.
const pct = (x, d = 1) => Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%` : '—';
const signCls = (x) => Number.isFinite(x) ? (x >= 0 ? 'om-pos' : 'om-neg') : '';
// A RETURN expressed in basis points (magnitude, never a probability).
const bps = (x) => Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${Math.round(x)} bps` : '—';
const num = (x, d = 1) => Number.isFinite(x) ? x.toFixed(d) : '—';
const priceTag = (x) => Number.isFinite(x) ? `$${x}` : '—';
const sideBadge = (side) => side === 'short'
  ? `<span class="om-chip" style="background:#dc2626;color:#fff">short</span>`
  : side === 'long' ? `<span class="om-chip" style="background:#16a34a;color:#fff">long</span>` : '';

// ── Entry-lane CANDIDATE card ──
function candidateCard(cd) {
  if (!cd || typeof cd !== 'object') return '';
  const stat = (label, val, cls = '') =>
    `<div class="om-stat"><span class="om-stat-l">${label}</span><span class="om-stat-v ${cls}">${val}</span></div>`;

  const dayCls = signCls(cd.residual10);
  const targets = Array.isArray(cd.targets) ? cd.targets.filter(Number.isFinite) : [];
  const targetLine = targets.length ? targets.map(t => `$${t}`).join(' → ') : '—';
  const dist = cd.distribution || {};
  const prosec = cd.prosecutor || {};
  const prov = cd.provenance || {};

  // Qualitative bands are ALREADY strings — rendered verbatim, never suffixed with '%'.
  const failureScore = prosec.failureScore != null ? esc(String(prosec.failureScore)) : '—';
  const targetBeforeStop = cd.targetBeforeStop != null ? esc(String(cd.targetBeforeStop)) : '—';

  const utility = Array.isArray(cd.utilityWaterfall)
    ? cd.utilityWaterfall.filter(w => w && Number.isFinite(w.value))
      .map(w => `<span class="om-chip" title="utility term (bps)">${esc(String(w.term))}: ${bps(w.value)}</span>`).join('')
    : '';
  const champions = Array.isArray(cd.champion) ? cd.champion.filter(Boolean) : [];
  const modes = Array.isArray(prosec.modes) ? prosec.modes.filter(Boolean) : [];

  return `<div class="om-card">
    <div class="om-card-top">
      <div class="om-id" data-ticker="${esc(cd.ticker || '')}" role="button">
        <b class="om-tk">${esc(cd.ticker || '—')}</b>
        <span class="om-co">${esc(String(cd.company || '').slice(0, 28))}</span>
      </div>
      <div class="om-px">${priceTag(cd.price)}</div>
    </div>
    <div class="om-chips">
      ${sideBadge(cd.side)}
      ${cd.expert ? `<span class="om-chip om-stage">${esc(String(cd.expert))}${cd.expertStage ? ` · ${esc(String(cd.expertStage))}` : ''}</span>` : ''}
      ${cd.pathArchetype ? `<span class="om-chip om-setup">${esc(String(cd.pathArchetype))}</span>` : ''}
      ${cd.governanceStatus ? `<span class="om-chip" style="background:#334155;color:#fff">${esc(String(cd.governanceStatus))}</span>` : ''}
      ${cd.calibrationStatus ? `<span class="om-chip" title="calibration status">cal: ${esc(String(cd.calibrationStatus))}</span>` : ''}
    </div>
    <div class="om-action"><b>${esc(String(cd.action || '—'))}</b>${cd.actionable === false ? ' <span class="om-band">· not actionable (research)</span>' : ''}</div>
    ${cd.abstentionReason ? `<div class="om-why"><b>Abstain:</b> ${esc(String(cd.abstentionReason))}</div>` : ''}
    ${cd.transition ? `<div class="om-transition"><b>Transition:</b> ${esc(String(cd.transition))}</div>` : ''}
    <div class="om-stats">
      ${stat('Resid 10d', pct(cd.residual10), dayCls)}
      ${stat('Resid accel', pct(cd.residualAccel), signCls(cd.residualAccel))}
      ${stat('Rem R:R', Number.isFinite(cd.remainingRR) ? cd.remainingRR + 'R' : '—')}
      ${stat('Hold window', cd.holdingWindow ? esc(String(cd.holdingWindow)) : '—')}
      ${stat('Exp sessions', num(cd.expectedSessions, 0))}
      ${stat('Data fresh', Number.isFinite(cd.dataFreshnessSessions) ? cd.dataFreshnessSessions + 'd' : '—')}
    </div>
    <div class="om-plan">
      <div class="om-plan-row"><span>Trigger</span><b>${cd.trigger ? esc(String(cd.trigger)) : '—'}</b></div>
      <div class="om-plan-row"><span>Invalidation</span><b class="om-neg">${priceTag(cd.invalidation)}</b></div>
      <div class="om-plan-row"><span>Targets</span><b class="om-pos">${targetLine}</b></div>
      <div class="om-plan-row"><span>Target-before-stop</span><b>${targetBeforeStop}</b></div>
    </div>
    <div class="om-stats">
      ${stat('Return dist p10', pct(dist.p10), signCls(dist.p10))}
      ${stat('median', pct(dist.median), signCls(dist.median))}
      ${stat('p90', pct(dist.p90), signCls(dist.p90))}
      ${stat('dist score', num(dist.score, 0))}
      ${stat('Exp value', bps(cd.expectedValueBps), signCls(cd.expectedValueBps))}
      ${stat('Lower bound', bps(cd.lowerBps), signCls(cd.lowerBps))}
    </div>
    ${utility ? `<div class="om-chips" title="Utility waterfall — return contributions in bps">${utility}</div>` : ''}
    ${champions.length ? `<div class="om-cat">✅ <b>Champion:</b> ${champions.map(esc).join(' · ')}</div>` : ''}
    <div class="om-risks">🛡 <b>Prosecutor</b> — failure score: <b>${failureScore}</b>${prosec.binding ? ' · <b>BINDING</b>' : ' · non-binding'}${modes.length ? ` · ${modes.map(esc).join(' · ')}` : ''}</div>
    ${cd.uncertaintySource ? `<div class="om-note" style="opacity:0.8">Uncertainty: ${esc(String(cd.uncertaintySource))}</div>` : ''}
    <div class="om-foot">
      <span>Evidence: uncalibrated · shadow (weight-0)</span>
      <span>${prov.strategyVersion ? esc(String(prov.strategyVersion)) : ''}${prov.eligibleEntryTs ? ` · entry ${esc(String(prov.eligibleEntryTs))}` : ''}</span>
    </div>
  </div>`;
}

// ── Episode-lane card (shared swing supervisor shape) ──
function episodeCard(cd) {
  if (!cd || typeof cd !== 'object') return '';
  const stat = (label, val, cls = '') =>
    `<div class="om-stat"><span class="om-stat-l">${label}</span><span class="om-stat-v ${cls}">${val}</span></div>`;

  const state = cd.lifecycleState || '—';
  const stateChip = `<span class="om-chip" style="background:${chipColor(state)};color:#fff">${esc(state)}</span>`;
  const stale = cd.dataFreshness === 'stale';
  const freshDot = `<span style="color:${stale ? '#f59e0b' : '#16a34a'}" title="data ${stale ? 'stale' : 'fresh'}">●</span>`;

  return `<div class="om-card">
    <div class="om-card-top">
      <div class="om-id" data-ticker="${esc(cd.ticker || '')}" role="button">
        <b class="om-tk">${esc(cd.ticker || '—')}</b>
        <span class="om-co">${esc(String(cd.company || '').slice(0, 28))}</span>
      </div>
      <div class="om-px">${priceTag(cd.currentPrice)}</div>
    </div>
    <div class="om-chips">
      ${sideBadge(cd.side)}${stateChip}
      ${cd.sourceStrategy ? `<span class="om-chip om-src" title="source strategy / family">${esc(String(cd.sourceStrategy))}${cd.strategyFamily ? ` · ${esc(String(cd.strategyFamily))}` : ''}</span>` : ''}
      ${cd.terminal && cd.outcomeState ? `<span class="om-chip" style="background:#334155;color:#fff">${esc(String(cd.outcomeState))}</span>` : ''}
    </div>
    ${cd.explanation ? `<div class="om-why">${esc(String(cd.explanation))}</div>` : ''}
    <div class="om-stats">
      ${stat('Return', pct(cd.returnSinceSuggestion), signCls(cd.returnSinceSuggestion))}
      ${stat('Rem R:R', Number.isFinite(cd.remainingRewardRisk) ? cd.remainingRewardRisk + 'R' : '—')}
      ${stat('Age', Number.isFinite(cd.sessionsSinceSuggestion) ? cd.sessionsSinceSuggestion + 'd' : '—')}
      ${stat('Thesis', cd.thesisState ? esc(String(cd.thesisState)) : '—')}
      ${stat('Action', cd.actionState ? esc(String(cd.actionState)) : '—')}
      ${stat('Execution', cd.executionState ? esc(String(cd.executionState)) : '—')}
    </div>
    <div class="om-foot">
      <span>${cd.firstDecisionDate ? `since ${esc(String(cd.firstDecisionDate))}` : ''}</span>
      <span>${freshDot}</span>
    </div>
  </div>`;
}

// ── Evidence & Validation panel — the single evidenceValidation[0] object, rendered prominently ──
function evidencePanel(label, ev) {
  if (!ev || typeof ev !== 'object') {
    return `<div class="om-tier-head"><h3>${esc(label)}</h3></div><div class="om-tier-empty">No validation snapshot yet.</div>`;
  }
  const universe = ev.universe || {};
  const health = ev.health || {};
  const promotion = ev.promotion || {};
  const portfolio = ev.portfolio || {};
  const calibration = ev.calibration || {};

  const healthReasons = Array.isArray(health.reasons) ? health.reasons.filter(Boolean) : [];
  const unmet = Array.isArray(promotion.unmet) ? promotion.unmet.filter(Boolean) : [];
  const promoEligible = promotion.eligible === true;

  const uni = (l, v) => `<div class="om-stat"><span class="om-stat-l">${l}</span><span class="om-stat-v">${Number.isFinite(v) ? v : '—'}</span></div>`;

  return `<div class="om-tier-head"><h3>${esc(label)}</h3></div>
  <div class="om-card">
    ${ev.honesty ? `<div class="om-shadow" style="margin-bottom:8px">🔬 <b>${esc(String(ev.honesty))}</b></div>` : ''}
    ${ev.coverage ? `<div class="om-note">Coverage: ${esc(String(ev.coverage))}</div>` : ''}
    <div class="om-stats">
      ${uni('Evaluable', universe.evaluable)}
      ${uni('Current', universe.current)}
      ${uni('Episodes', universe.episodes)}
      ${uni('Near-miss', universe.nearMiss)}
    </div>
    <div class="om-plan">
      <div class="om-plan-row"><span>Model health</span><b>${esc(String(health.state || '—'))}</b></div>
      ${healthReasons.length ? `<div class="om-plan-row"><span>Health reasons</span><b>${healthReasons.map(esc).join(' · ')}</b></div>` : ''}
      <div class="om-plan-row"><span>Promotion</span><b class="${promoEligible ? 'om-pos' : 'om-neg'}">${promoEligible ? 'eligible' : 'NOT eligible'}${promotion.gate ? ` · gate: ${esc(String(promotion.gate))}` : ''}</b></div>
      ${unmet.length ? `<div class="om-plan-row"><span>Unmet criteria</span><b class="om-neg">${unmet.map(esc).join(' · ')}</b></div>` : ''}
      <div class="om-plan-row"><span>Portfolio</span><b>weight ${esc(String(portfolio.weightPolicy || 'weight-0'))} · ${Number.isFinite(portfolio.positions) ? portfolio.positions : 0} positions · ${Number.isFinite(portfolio.excluded) ? portfolio.excluded : 0} excluded</b></div>
      <div class="om-plan-row"><span>Calibration</span><b>${esc(String(calibration.status || 'uncalibrated'))}${calibration.note ? ` — ${esc(String(calibration.note))}` : ''}</b></div>
      ${ev.capture != null ? `<div class="om-plan-row"><span>Capture</span><b>${esc(String(ev.capture))}</b></div>` : ''}
      ${ev.ledger != null ? `<div class="om-plan-row"><span>Ledger</span><b>${esc(String(ev.ledger))}</b></div>` : ''}
    </div>
    <div class="om-foot"><span>Weight-0 shadow research — validation only, never a live signal.</span></div>
  </div>`;
}

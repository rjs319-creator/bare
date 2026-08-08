// 📡 MARKET PULSE v2 — pure render module (no fetching, no DOM at import time).
// Every function takes wire data and returns an HTML string; app.js owns fetching and
// element wiring. Kept pure so tests can import it directly (tech-command pattern).
//
// Visual honesty rules baked in:
//   • measured / verified / inference / editorial content is chip-tagged, never blended;
//   • the narrative clock and the market-data clock render separately;
//   • empty sections say WHY they are empty — no padding with low-quality filler;
//   • no probability, win rate, or "edge" is rendered unless the payload marks it Measured.

import { esc } from './format.js';

// ── shared chips/badges ─────────────────────────────────────────────────────
const BASIS_CHIP = {
  MEASURED: ['📏', 'Measured', '#3b82f6'],
  VERIFIED_FACT: ['✅', 'Verified fact', '#22c55e'],
  MODEL_INFERENCE: ['🧠', 'Model inference', '#a855f7'],
  EDITORIAL_SUMMARY: ['📝', 'Editorial', '#94a3b8'],
};
export function basisChip(basis) {
  const [ico, label, color] = BASIS_CHIP[basis] || BASIS_CHIP.EDITORIAL_SUMMARY;
  return `<span class="p2-basis" style="color:${color}" role="note" aria-label="${esc(label)}">${ico} ${esc(label)}</span>`;
}

const NARR_FRESH = {
  CURRENT_NARRATIVE: ['🟢', 'narrative current', '#22c55e'],
  RECENT_NARRATIVE: ['🕐', 'narrative recent', '#eab308'],
  STALE_NARRATIVE: ['🟠', 'narrative stale', '#f97316'],
  LAST_KNOWN_GOOD: ['⚠️', 'last known good', '#ef4444'],
  UNAVAILABLE: ['⛔', 'narrative unavailable', '#ef4444'],
};
const MD_FRESH = {
  REALTIME: ['🟢', 'market data realtime', '#22c55e'],
  DELAYED: ['🕐', 'market data delayed', '#eab308'],
  STALE: ['🟠', 'market data stale', '#f97316'],
  DAILY_ONLY: ['📅', 'daily data only', '#eab308'],
  MARKET_CLOSED: ['🌙', 'market closed', '#94a3b8'],
  UNAVAILABLE: ['⛔', 'market data unavailable', '#ef4444'],
};
export function clockChips(clocks) {
  if (!clocks) return '';
  const n = NARR_FRESH[clocks.narrativeFreshness] || NARR_FRESH.UNAVAILABLE;
  const m = MD_FRESH[clocks.marketDataFreshness] || MD_FRESH.UNAVAILABLE;
  const nAge = clocks.narrativeAgeMinutes != null ? ` (${clocks.narrativeAgeMinutes}m)` : '';
  const mAge = clocks.marketDataAgeSeconds != null ? ` (${Math.round(clocks.marketDataAgeSeconds / 60)}m)` : '';
  return `<span class="p2-clock" style="color:${n[2]}" title="How old the story snapshot is — separate from market data">${n[0]} ${esc(n[1])}${nAge}</span>`
       + `<span class="p2-clock" style="color:${m[2]}" title="How old the price/market data is">${m[0]} ${esc(m[1])}${mAge}</span>`;
}

const TRADE_PILL = {
  CONTEXT_ONLY: ['#64748b', 'Context'],
  INVESTIGATE: ['#3b82f6', 'Investigate'],
  WATCH: ['#eab308', 'Watch'],
  ARMED: ['#f97316', 'Armed'],
  PRICE_CONFIRMED: ['#22c55e', 'Price-confirmed'],
  CONTRADICTED: ['#ef4444', 'Contradicted'],
  INVALIDATED: ['#ef4444', 'Invalidated'],
  EXPIRED: ['#64748b', 'Expired'],
  DATA_STALE: ['#f97316', 'Data stale'],
};
export function tradePill(state) {
  const [color, label] = TRADE_PILL[state] || TRADE_PILL.CONTEXT_ONLY;
  return `<span class="p2-pill" style="border-color:${color};color:${color}" role="status" aria-label="trade state ${esc(label)}">${esc(label)}</span>`;
}

const EVID_CHIP = {
  VERIFIED: ['✅', '#22c55e', 'multiple independent source lineages'],
  SUPPORTED: ['🟢', '#84cc16', 'primary source or multiple lineages'],
  SINGLE_SOURCE: ['①', '#eab308', 'one source lineage'],
  CONFLICTED: ['⚔️', '#ef4444', 'sources disagree'],
  UNVERIFIED: ['❓', '#f97316', 'no mapped evidence'],
  STALE: ['🕰', '#94a3b8', 'evidence predates relevance'],
};
export function evidenceChip(ev) {
  const [ico, color, tip] = EVID_CHIP[ev] || EVID_CHIP.UNVERIFIED;
  return `<span class="p2-evid" style="color:${color}" title="${esc(tip)}">${ico} ${esc(ev || 'UNVERIFIED')}</span>`;
}

export function emptySection(title, why) {
  return `<div class="p2-empty" role="status"><b>${esc(title)}</b> — ${esc(why)}</div>`;
}

const fmtPct = v => (v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
const fmtN = v => (v == null || !Number.isFinite(v) ? '—' : String(v));

// ── 1. MARKET NOW ───────────────────────────────────────────────────────────
export function renderMarketNow(state, clocks) {
  if (!state) {
    return emptySection('Market Now', 'no market-state snapshot yet — the scheduler has not run (this is a data gap, not a quiet market)');
  }
  const mode = state.mode || {};
  const idx = state.indexes || {};
  const tiles = ['SPY', 'QQQ', 'IWM', 'DIA', 'RSP'].map(t => {
    const s = idx[t] || {};
    if (!s.available) return `<div class="p2-tile p2-unavail" title="${esc(s.reason || 'unavailable')}"><div class="p2-tk">${t}</div><div class="p2-val">—</div></div>`;
    const vw = s.aboveVWAP == null ? '' : s.aboveVWAP ? ' <span title="above VWAP">▲vw</span>' : ' <span title="below VWAP">▼vw</span>';
    return `<div class="p2-tile"><div class="p2-tk">${t}</div><div class="p2-val" style="color:${(s.dayReturnPct || 0) >= 0 ? '#22c55e' : '#ef4444'}">${fmtPct(s.dayReturnPct)}${vw}</div>`
      + `<div class="p2-sub">${s.sameTimeRelVol != null ? esc(s.sameTimeRelVol.toFixed(1)) + '× vol' : (s.source === 'daily' ? 'daily only' : '')}</div></div>`;
  }).join('');
  const vix = state.vix && state.vix.available
    ? `<div class="p2-tile"><div class="p2-tk">VIX</div><div class="p2-val">${fmtN(state.vix.level)}</div><div class="p2-sub">${fmtPct(state.vix.dayReturnPct)}</div></div>`
    : `<div class="p2-tile p2-unavail"><div class="p2-tk">VIX</div><div class="p2-val">—</div></div>`;
  const part = state.participation || {};
  const breadth = state.breadth && state.breadth.available
    ? `${fmtN(state.breadth.pctAbove50dma)}% above 50DMA · NH ${fmtN(state.breadth.newHighs63)} / NL ${fmtN(state.breadth.newLows63)} <span class="p2-dim">(${esc(state.breadth.source || '')}, as of ${esc(state.breadth.asOf || '?')})</span>`
    : `<span class="p2-dim">unavailable — ${esc((state.breadth && state.breadth.reason) || 'no source')}</span>`;
  const modeChanged = mode.changed ? ` <span class="p2-modechg">changed from ${esc((mode.previous || '').replace(/_/g, ' '))}</span>` : '';
  return `<div class="p2-now">
    <div class="p2-now-head">
      <span class="p2-mode" role="status">${esc((mode.mode || 'UNKNOWN').replace(/_/g, ' '))}</span>${modeChanged}
      ${basisChip('MEASURED')}
      <span class="p2-clocks">${clockChips(clocks)}</span>
    </div>
    <div class="p2-mode-why p2-dim">${esc(mode.why || '')}</div>
    <div class="p2-tiles">${tiles}${vix}</div>
    <div class="p2-line"><b>Participation:</b> equal-vs-cap ${fmtPct(part.equalVsCapPct)} · small-vs-large ${fmtPct(part.smallVsLargePct)}</div>
    <div class="p2-line"><b>Breadth:</b> ${breadth}</div>
  </div>`;
}

// ── 2. PLAYBOOK ─────────────────────────────────────────────────────────────
function playLine(label, l) {
  if (!l) return '';
  return `<div class="p2-play-row"><span class="p2-play-lbl">${esc(label)}</span><span class="p2-play-txt">${esc(l.text)}</span>${basisChip(l.basis)}</div>`;
}
export function renderPlaybook(pb) {
  if (!pb) return emptySection('Playbook', 'needs a market-state snapshot');
  const multi = (label, arr) => (arr && arr.length)
    ? arr.map(l => playLine(label, l)).join('')
    : playLine(label, { text: 'none right now', basis: 'MEASURED' });
  return `<div class="p2-play">
    <div class="p2-play-title">⏱ The tape in 20 seconds</div>
    ${playLine('Market mode', pb.marketMode)}
    ${(pb.whatChanged || []).map(l => playLine('What changed', l)).join('')}
    ${playLine('Leadership', pb.leadership)}
    ${playLine('Deterioration', pb.deterioration)}
    ${playLine('Favor', pb.favor)}
    ${playLine('Avoid', pb.avoid)}
    ${playLine('Next decision point', pb.nextDecisionPoint)}
    ${multi('Fresh opportunity', pb.freshOpportunities)}
    ${multi('Active trigger', pb.activeTriggers)}
    ${multi('Event risk', pb.upcomingEventRisk)}
  </div>`;
}

// ── 3-5. HORIZON VIEWS ──────────────────────────────────────────────────────
function contractHTML(c) {
  if (!c) return '';
  const row = (k, v) => (v == null || v === '' ? '' : `<div class="p2-c-row"><span>${esc(k)}</span><b>${esc(String(v))}</b></div>`);
  return `<div class="p2-contract">
    ${row('Verified', c.verified)}
    ${row('Price since detection', c.priceSinceDetectionPct != null ? fmtPct(c.priceSinceDetectionPct) : null)}
    ${row('Horizon', c.horizon)}
    ${row('Must happen next', c.whatMustHappen)}
    ${row('Trigger', c.trigger)}
    ${row('Invalidation', c.invalidation)}
    ${row('Extended', c.extended ? 'yes — chase risk' : null)}
    ${row('Event risk', c.eventRisk)}
    ${row('Missing data', (c.missingData || []).join(', ') || null)}
    ${row('Why not actionable', c.notActionableReason)}
  </div>`;
}

export function viewCard(d, novice) {
  if (!d) return '';
  const c = d.contract || {};
  const plain = c.notActionableReason || c.whatMustHappen || 'context for the tape';
  const dirIco = d.direction === 'BULLISH' ? '🟢▲' : d.direction === 'BEARISH' ? '🔴▼' : '◽';
  return `<div class="p2-card" data-state="${esc(d.tradeState || '')}">
    <div class="p2-card-head">${tradePill(d.tradeState)} ${evidenceChip(d.evidence)} <span class="p2-dir">${dirIco}</span>
      <button class="p2-tkbtn pulse-tk" type="button">$${esc(d.ticker || '')}</button></div>
    <div class="p2-card-title">${esc(d.headline || '')}</div>
    <div class="p2-card-plain">🔰 ${esc(plain)}</div>
    ${d.thesisClass ? `<div class="p2-line p2-dim">Thesis class: ${esc(d.thesisClass)}</div>` : ''}
    ${novice ? '' : `<details class="p2-pro"><summary>Expert detail</summary>${contractHTML(c)}
      ${d.sameTimeRelVol != null ? `<div class="p2-c-row"><span>Same-time-of-day rel vol</span><b>${esc(d.sameTimeRelVol.toFixed(2))}×</b></div>` : ''}
      ${d.vsVWAPPct != null ? `<div class="p2-c-row"><span>vs VWAP</span><b>${fmtPct(d.vsVWAPPct)}</b></div>` : ''}
      ${d.chaseAtr != null ? `<div class="p2-c-row"><span>Extension (ATR)</span><b>${esc(String(d.chaseAtr))}</b></div>` : ''}
      ${d.rr != null ? `<div class="p2-c-row"><span>R:R framework</span><b>${esc(String(d.rr))}</b></div>` : ''}
      ${d.quality != null ? `<div class="p2-c-row"><span>Setup quality</span><b>${esc(String(d.quality))}</b></div>` : ''}
      ${d.evidenceSupport ? `<div class="p2-c-row"><span>Support</span><b>${esc(d.evidenceSupport)}</b></div>` : ''}
    </details>`}
  </div>`;
}

export function renderView(name, list, novice, emptyWhy) {
  const items = (list || []).filter(Boolean);
  if (!items.length) return emptySection(name, emptyWhy);
  const order = { PRICE_CONFIRMED: 0, ARMED: 1, WATCH: 2, INVESTIGATE: 3, CONTEXT_ONLY: 4, DATA_STALE: 5, CONTRADICTED: 6, INVALIDATED: 7, EXPIRED: 8 };
  const sorted = [...items].sort((a, b) => (order[a.tradeState] ?? 9) - (order[b.tradeState] ?? 9));
  return sorted.map(d => viewCard(d, novice)).join('');
}

// ── 6-10. EVENT SECTIONS ────────────────────────────────────────────────────
const SECTION_META = [
  ['freshVerified', '🆕 Fresh verified events', 'nothing newly verified this cycle — an honest quiet, not a data error'],
  ['unreacted', '💤 Verified but unreacted', 'no verified story is sitting unreacted right now'],
  ['priceConfirmed', '📈 Price-confirmed', 'no event has fired its price trigger with participation'],
  ['crowdedExtended', '🔥 Crowded / extended', 'nothing is measurably extended right now'],
  ['contradictions', '⚔️ Contradictions & risks', 'no conflicted evidence or price-contradicted stories'],
];
export function eventCard(e, sourcesById, novice) {
  if (!e) return '';
  const claims = (e.claims || []).map(cl => {
    const links = (cl.sourceRefs || []).map(id => {
      const s = sourcesById && sourcesById[id];
      return s ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" class="p2-src" title="${esc(s.title || s.url)}">${esc(s.domain || 'source')}${s.lineageType === 'syndicated-copy' ? ' (syndicated)' : ''}</a>` : '';
    }).filter(Boolean).join(' ');
    return `<div class="p2-claim"><span class="p2-claim-st">${evidenceChip(cl.status)}</span> ${esc(cl.text)} ${links || '<span class="p2-dim">no mapped source — treat as unverified</span>'}</div>`;
  }).join('');
  const life = e.narrativeLifecycle ? `<span class="p2-life">${esc(e.narrativeLifecycle)}</span>` : '';
  const reaction = e.reaction ? `<span class="p2-react">${esc(e.reaction.replace(/_/g, ' '))}</span>` : '';
  return `<div class="p2-card p2-event">
    <div class="p2-card-head">${evidenceChip(e.evidence)} ${life} ${reaction}
      ${(e.tickers || []).map(t => `<button class="p2-tkbtn pulse-tk" type="button">$${esc(t)}</button>`).join(' ')}</div>
    <div class="p2-card-title">${esc(e.headline)}</div>
    ${e.matrixCell ? `<div class="p2-line p2-dim">Reaction matrix: ${esc(e.matrixCell.replace(/_/g, ' '))}</div>` : ''}
    ${novice ? '' : `<details class="p2-pro"><summary>Evidence & lifecycle</summary>
      ${claims || '<div class="p2-dim">no structured claims</div>'}
      <div class="p2-c-row"><span>Event id</span><b>${esc(e.fingerprint || e.id)}</b></div>
      <div class="p2-c-row"><span>Family / direction</span><b>${esc(e.family || '?')} / ${esc(e.currentDirection || '?')}</b></div>
      <div class="p2-c-row"><span>First seen</span><b>${esc(e.firstSeenDate || '?')}${e.thesisVersion > 1 ? ` (thesis v${e.thesisVersion})` : ''}</b></div>
      <div class="p2-c-row"><span>Observations / lineages</span><b>${esc(String(e.observationCount || 0))} / ${esc(String(e.independentLineages || 0))}</b></div>
    </details>`}
  </div>`;
}
export function renderEventSections(sections, events, sourcesById, novice) {
  const byId = new Map((events || []).map(e => [e.id, e]));
  return SECTION_META.map(([key, title, emptyWhy]) => {
    const ids = (sections && sections[key]) || [];
    const cards = ids.map(id => byId.get(id)).filter(Boolean).map(e => eventCard(e, sourcesById, novice)).join('');
    return `<div class="p2-sec"><div class="p2-sec-head">${esc(title)} <span class="p2-sec-n">${ids.length}</span></div>${cards || emptySection(title, emptyWhy)}</div>`;
  }).join('');
}

// ── 11. RECENTLY CHANGED + ALERTS ───────────────────────────────────────────
export function renderRecent(recent, alerts) {
  const rc = (recent || []).slice(0, 10).map(r =>
    `<div class="p2-recent-row">🔄 <b>${esc(r.headline || r.kind)}</b> ${esc(r.from || '')} → ${esc(r.to || '')} <span class="p2-dim">${esc(r.date || '')}</span></div>`).join('');
  const al = (alerts || []).slice(0, 8).map(a =>
    `<div class="p2-alert-row">🔔 <b>${esc(a.label)}</b> ${esc(a.headline || '')} — ${esc(a.whatChanged || '')} <span class="p2-dim">${esc(a.actionability || '')}</span></div>`).join('');
  if (!rc && !al) return emptySection('Recently changed', 'no state transitions yet');
  return `<div class="p2-sec"><div class="p2-sec-head">🔄 Recently changed & alerts</div>${al}${rc}</div>`;
}

// ── 12. EVIDENCE & TRACK RECORD ─────────────────────────────────────────────
export function renderTrackRecord(tr) {
  if (!tr || (!tr.summary && !tr.comparison)) {
    return emptySection('Track record', 'prospective grading has not matured yet — outcomes appear after events age in trading sessions');
  }
  const s = tr.summary || {};
  const stat = (label, w) => {
    if (!w || w.n === 0) return `<div class="p2-c-row"><span>${esc(label)}</span><b>no matured sample</b></div>`;
    const rate = w.probability != null ? `${w.rate}% (${w.lo}–${w.hi}%, n=${w.n})` : `${esc(w.status || 'Collecting evidence')} (n=${w.n})`;
    return `<div class="p2-c-row"><span>${esc(label)}</span><b>${rate}</b></div>`;
  };
  const cmp = tr.comparison ? `<div class="p2-line"><b>Setup alone vs setup + Pulse evidence:</b> ${esc(tr.comparison.verdict.replace(/_/g, ' '))}
    <span class="p2-dim">(base n=${tr.comparison.baseCohort ? tr.comparison.baseCohort.n : 0}, +pulse n=${tr.comparison.pulseCohort ? tr.comparison.pulseCohort.n : 0})</span></div>` : '';
  return `<div class="p2-sec"><div class="p2-sec-head">🎖 Evidence & track record <span class="p2-dim">prospective, cluster-aware</span></div>
    <div class="p2-c-row"><span>Raw events / distinct decision dates / effective sample</span><b>${esc(String(s.rawEventCount ?? 0))} / ${esc(String(s.distinctDecisionDates ?? 0))} / ${esc(String(s.effectiveSampleSize ?? 0))}</b></div>
    ${stat('Direction correct (SPY-relative)', s.directional)}
    ${stat('Detected ahead of a material move', s.awareness)}
    ${stat('Material move followed', s.consequence)}
    ${cmp}
    <div class="p2-dim">No probability is shown until the independent sample clears the floor; directional value is never claimed automatically.</div>
  </div>`;
}

// ── 13. DATA HEALTH ─────────────────────────────────────────────────────────
export function renderHealthStrip(clocks, unavailable, coverage) {
  const un = (unavailable || []).map(u => `<div class="p2-unavail-row">⛔ <b>${esc(u.what)}</b>: ${esc(u.why)}</div>`).join('');
  const cov = coverage ? `<span class="p2-dim">symbols ${esc(String(coverage.intradayCount ?? '?'))}/${esc(String(coverage.symbolsRequested ?? '?'))} intraday${(coverage.failedSymbols || []).length ? `, failed: ${esc(coverage.failedSymbols.join(', '))}` : ''}</span>` : '';
  return `<div class="p2-health">
    <span class="p2-dim">mode: ${esc((clocks && clocks.dataMode) || '?')} · model ${esc((clocks && clocks.modelVersion) || '?')}</span> ${cov}${un}
  </div>`;
}

// ── shell ───────────────────────────────────────────────────────────────────
export function renderShell({ payload, novice }) {
  const p = payload || {};
  const clocks = p.clocks || null;
  const sourcesById = {};
  for (const s of (p.narratives && p.narratives.sources) || []) sourcesById[s.id] = s;
  const views = (p.narratives && p.narratives.views) || {};
  const modeBtn = (id, label, active) => `<button type="button" class="p2-vtab${active ? ' p2-active' : ''}" id="${id}">${label}</button>`;
  return `
  <div class="p2-note dt-note"><b>📡 Market Intelligence Center.</b>
    <span class="p2-toggle-wrap">${modeBtn('p2-m-simple', '🔰 Simple', novice)}${modeBtn('p2-m-pro', '📊 Pro', !novice)}</span>
    <span class="p2-dim">${esc((p.narratives && p.narratives.disclaimer) || 'Evidence-graded market read — not investment advice; directional value unproven until prospectively measured.')}</span>
  </div>
  ${renderHealthStrip(clocks, p.unavailable, p.marketState && p.marketState.coverage)}
  ${renderMarketNow(p.marketState, clocks)}
  ${renderPlaybook(p.playbook)}
  <div class="p2-views">
    <div class="p2-sec-head">🎯 Horizon views</div>
    <div class="p2-vtabs">
      ${modeBtn('p2-v-day', '⚡ Day', true)}${modeBtn('p2-v-swing', '📅 Swing', false)}${modeBtn('p2-v-investor', '🏛 Investor', false)}
    </div>
    <div class="p2-view-body" data-view="day">${renderView('Day trade', views.day, novice, 'no day-trade reads — needs fresh regular-session data and collected events')}</div>
    <div class="p2-view-body" data-view="swing" style="display:none">${renderView('Swing', views.swing, novice, 'no swing reads — needs collected events with daily structure')}</div>
    <div class="p2-view-body" data-view="investor" style="display:none">${renderView('Investor', views.investor, novice, 'no investor reads yet')}</div>
  </div>
  ${renderEventSections(p.narratives && p.narratives.sections, p.events, sourcesById, novice)}
  ${renderRecent(p.recentlyChanged, p.alerts)}
  ${renderTrackRecord(p.trackRecord)}
  `;
}

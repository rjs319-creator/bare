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

// ── story timestamps (the three clocks: event / publication / discovery) ────
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function fmtWhen(iso) {
  if (!iso) return null;
  const dateOnly = DATE_ONLY_RE.test(String(iso));
  const d = new Date(dateOnly ? iso + 'T00:00:00Z' : iso);
  if (!Number.isFinite(d.getTime())) return null;
  if (dateOnly) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Semantic timestamp: <time datetime> so assistive tech and tooling get the ISO value. */
export function timeEl(iso, label) {
  const text = label != null ? label : fmtWhen(iso);
  if (!iso || text == null) return '';
  return `<time datetime="${esc(String(iso))}">${esc(text)}</time>`;
}

// Concise, honest age badge: 3h · 2d old · Ongoing · Date unknown · Rediscovered ·
// Material update. Reads from the card's server-computed freshness block.
const REASON_BADGE = {
  NEW_MATERIAL_UPDATE: ['Material update', '#22c55e'],
  REDISCOVERED: ['Rediscovered', '#f97316'],
  ONGOING_EVENT: ['Ongoing', '#94a3b8'],
  SYNDICATED_COPY: ['Syndicated', '#94a3b8'],
};
export function ageBadge(f) {
  if (!f) return '';
  const age = f.eventAgeHours ?? f.publicationAgeHours;
  let ageTxt, color;
  if (age == null) { ageTxt = 'Date unknown'; color = '#f97316'; }
  else if (age < 24) { ageTxt = `${Math.max(1, Math.round(age))}h`; color = '#22c55e'; }
  else { ageTxt = `${Math.round(age / 24)}d old`; color = age <= 72 ? '#eab308' : '#f97316'; }
  const chips = [`<span class="p2-age" style="color:${color}" role="note" aria-label="story age ${esc(ageTxt)}">${esc(ageTxt)}</span>`];
  const rb = REASON_BADGE[f.reason];
  if (rb) chips.push(`<span class="p2-age" style="color:${rb[1]}">${esc(rb[0])}</span>`);
  return chips.join(' ');
}

/** The accessible timestamp row: Event … · Published … · Discovered … */
export function timestampRow(f) {
  if (!f) return '';
  const parts = [];
  if (f.eventOccurredAt) parts.push(`Event ${timeEl(f.eventOccurredAt)}`);
  if (f.firstPublishedAt) parts.push(`Published ${timeEl(f.firstPublishedAt)}`);
  if (f.discoveredAt) parts.push(`Discovered ${timeEl(f.discoveredAt)}`);
  if (!parts.length) return '<div class="p2-times p2-dim" role="note">No event, publication, or discovery time is known for this story</div>';
  return `<div class="p2-times" role="note">${parts.join(' · ')}</div>`;
}

// Lifecycle-reason chip — replaces the old blanket "new" implication with the
// explicit reason a story reads as active.
const FRESH_REASON_CHIP = {
  NEW_PUBLICATION: ['🆕', 'New event', '#22c55e'],
  NEW_MATERIAL_UPDATE: ['📌', 'Material update', '#22c55e'],
  NEW_CORROBORATION: ['🤝', 'New corroborating source', '#84cc16'],
  REDISCOVERED: ['🕰', 'Newly discovered by Market Pulse — older event', '#f97316'],
  SYNDICATED_COPY: ['🔁', 'Syndicated copies arriving', '#94a3b8'],
  ONGOING_EVENT: ['➿', 'Ongoing', '#94a3b8'],
  UNKNOWN: ['❓', 'Date unknown', '#f97316'],
};
export function freshnessChip(reason) {
  const c = FRESH_REASON_CHIP[reason];
  if (!c) return '';
  return `<span class="p2-freshreason" style="color:${c[2]}" role="note">${c[0]} ${esc(c[1])}</span>`;
}

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
  const f = d.freshness || null;
  const plain = c.notActionableReason || c.whatMustHappen || 'context for the tape';
  const dirIco = d.direction === 'BULLISH' ? '🟢▲' : d.direction === 'BEARISH' ? '🔴▼' : '◽';
  return `<div class="p2-card" data-state="${esc(d.tradeState || '')}">
    <div class="p2-card-head">${tradePill(d.tradeState)} ${evidenceChip(d.evidence)} ${ageBadge(f)} <span class="p2-dir">${dirIco}</span>
      <button class="p2-tkbtn pulse-tk" type="button">$${esc(d.ticker || '')}</button></div>
    <div class="p2-card-title">${esc(d.headline || '')}</div>
    <div class="p2-card-plain">🔰 ${esc(plain)}</div>
    ${d.thesisClass ? `<div class="p2-line p2-dim">Thesis class: ${esc(d.thesisClass)}</div>` : ''}
    ${novice ? '' : `${timestampRow(f)}<details class="p2-pro"><summary>Expert detail</summary>${contractHTML(c)}
      ${f ? `<div class="p2-c-row"><span>Freshness</span><b>${esc(f.reason || 'UNKNOWN')} · date confidence ${esc(f.dateConfidence || 'unknown')}</b></div>` : ''}
      ${f && f.lastCorroboratedAt ? `<div class="p2-c-row"><span>Last corroborated</span><b>${timeEl(f.lastCorroboratedAt)}</b></div>` : ''}
      ${d.sameTimeRelVol != null ? `<div class="p2-c-row"><span>Same-time-of-day rel vol</span><b>${esc(d.sameTimeRelVol.toFixed(2))}×</b></div>` : ''}
      ${d.vsVWAPPct != null ? `<div class="p2-c-row"><span>vs VWAP</span><b>${fmtPct(d.vsVWAPPct)}</b></div>` : ''}
      ${d.chaseAtr != null ? `<div class="p2-c-row"><span>Extension (ATR)</span><b>${esc(String(d.chaseAtr))}</b></div>` : ''}
      ${d.rr != null ? `<div class="p2-c-row"><span>R:R framework</span><b>${esc(String(d.rr))}</b></div>` : ''}
      ${d.quality != null ? `<div class="p2-c-row"><span>Setup quality</span><b>${esc(String(d.quality))}</b></div>` : ''}
      ${d.evidenceSupport ? `<div class="p2-c-row"><span>Support</span><b>${esc(d.evidenceSupport)}</b></div>` : ''}
    </details>`}
  </div>`;
}

// Deterministic card ordering — NEVER input order. Freshness-ranked cards sort by
// the server's recency-aware rank score with timestamp tie-breaks; legacy cards
// (no freshness block) fall back to trade-state order with a stable id tie-break.
const LEGACY_STATE_ORDER = { PRICE_CONFIRMED: 0, ARMED: 1, WATCH: 2, INVESTIGATE: 3, CONTEXT_ONLY: 4, DATA_STALE: 5, CONTRADICTED: 6, INVALIDATED: 7, EXPIRED: 8 };
const descIso = (a, b) => {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a > b ? -1 : 1;
};
export function compareCards(a, b) {
  const fa = (a && a.freshness) || null, fb = (b && b.freshness) || null;
  if (fa && fb) {
    const sa = fa.rankScore ?? -Infinity, sb = fb.rankScore ?? -Infinity;
    if (sa !== sb) return sb - sa;
    return descIso(fa.eventOccurredAt, fb.eventOccurredAt)
      || descIso(fa.firstPublishedAt, fb.firstPublishedAt)
      || descIso(fa.lastCorroboratedAt, fb.lastCorroboratedAt)
      || String((a && a.eventId) || '').localeCompare(String((b && b.eventId) || ''));
  }
  return (LEGACY_STATE_ORDER[a.tradeState] ?? 9) - (LEGACY_STATE_ORDER[b.tradeState] ?? 9)
    || String((a && a.eventId) || '').localeCompare(String((b && b.eventId) || ''));
}

export function renderView(name, list, novice, emptyWhy) {
  const items = (list || []).filter(Boolean);
  if (!items.length) return emptySection(name, emptyWhy);
  const sorted = [...items].sort(compareCards);
  // Current stories lead; older/undated items sit in a clearly separated,
  // collapsed context group — never mixed into the main list.
  const current = sorted.filter(d => !d.freshness || d.freshness.group !== 'context');
  const context = sorted.filter(d => d.freshness && d.freshness.group === 'context');
  const main = current.map(d => viewCard(d, novice)).join('')
    || emptySection(name, 'nothing current right now — older or undated stories are in the context group below');
  const ctx = context.length
    ? `<details class="p2-context-group"><summary>🕰 Earlier / undated context (${context.length}) — not current ${esc(name)} stories</summary>${context.map(d => viewCard(d, novice)).join('')}</details>`
    : '';
  return main + ctx;
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
      if (!s) return '';
      const lineageTag = s.lineageType === 'syndicated-copy' ? ' (syndicated)'
        : s.reference ? ` (reference — ${esc(String(s.reference))})` : '';
      const pub = s.publishedAt ? ` ${timeEl(s.publishedAt)}` : ' <span class="p2-dim">(undated)</span>';
      return `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer" class="p2-src" title="${esc(s.title || s.url)}">${esc(s.domain || 'source')}${lineageTag}</a>${pub}`;
    }).filter(Boolean).join(' ');
    return `<div class="p2-claim"><span class="p2-claim-st">${evidenceChip(cl.status)}</span> ${esc(cl.text)} ${links || '<span class="p2-dim">no mapped source — treat as unverified</span>'}</div>`;
  }).join('');
  const life = e.narrativeLifecycle ? `<span class="p2-life">${esc(e.narrativeLifecycle)}</span>` : '';
  const reaction = e.reaction ? `<span class="p2-react">${esc(e.reaction.replace(/_/g, ' '))}</span>` : '';
  const evtFresh = {
    reason: e.freshnessReason, eventOccurredAt: e.eventOccurredAt || e.eventDate,
    firstPublishedAt: e.firstPublishedAt, discoveredAt: e.firstSeenAt || e.firstSeen,
  };
  return `<div class="p2-card p2-event">
    <div class="p2-card-head">${evidenceChip(e.evidence)} ${freshnessChip(e.freshnessReason)} ${life} ${reaction}
      ${(e.tickers || []).map(t => `<button class="p2-tkbtn pulse-tk" type="button">$${esc(t)}</button>`).join(' ')}</div>
    <div class="p2-card-title">${esc(e.headline)}</div>
    ${e.matrixCell ? `<div class="p2-line p2-dim">Reaction matrix: ${esc(e.matrixCell.replace(/_/g, ' '))}</div>` : ''}
    ${novice ? '' : `${timestampRow(evtFresh)}<details class="p2-pro"><summary>Evidence & lifecycle</summary>
      ${claims || '<div class="p2-dim">no structured claims</div>'}
      <div class="p2-c-row"><span>Event id</span><b>${esc(e.fingerprint || e.id)}</b></div>
      <div class="p2-c-row"><span>Family / direction</span><b>${esc(e.family || '?')} / ${esc(e.currentDirection || '?')}</b></div>
      <div class="p2-c-row"><span>First seen</span><b>${esc(e.firstSeenDate || '?')}${e.thesisVersion > 1 ? ` (thesis v${e.thesisVersion})` : ''}</b></div>
      <div class="p2-c-row"><span>Date confidence</span><b>${esc(e.dateConfidence || 'unknown')}</b></div>
      ${e.lastCorroboratedAt ? `<div class="p2-c-row"><span>Last corroborated</span><b>${timeEl(e.lastCorroboratedAt)}</b></div>` : ''}
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
export function renderHealthStrip(clocks, unavailable, coverage, cache) {
  const un = (unavailable || []).map(u => `<div class="p2-unavail-row">⛔ <b>${esc(u.what)}</b>: ${esc(u.why)}</div>`).join('');
  const cov = coverage ? `<span class="p2-dim">symbols ${esc(String(coverage.intradayCount ?? '?'))}/${esc(String(coverage.symbolsRequested ?? '?'))} intraday${(coverage.failedSymbols || []).length ? `, failed: ${esc(coverage.failedSymbols.join(', '))}` : ''}</span>` : '';
  // Narrative-snapshot age is the SNAPSHOT's age — never presented as story age.
  const narr = clocks && clocks.narrativeAgeMinutes != null
    ? `<span class="p2-dim">narrative updated ${esc(String(clocks.narrativeAgeMinutes))}m ago</span>` : '';
  const next = clocks && clocks.nextNarrativeRefreshAt
    ? `<span class="p2-dim">next update ${timeEl(clocks.nextNarrativeRefreshAt)}</span>` : '';
  const cacheChip = cache && cache.status
    ? `<span class="p2-dim" title="TTL ${esc(String(cache.ttlSeconds))}s">cache ${esc(cache.status)}</span>` : '';
  return `<div class="p2-health">
    <span class="p2-dim">mode: ${esc((clocks && clocks.dataMode) || '?')} · model ${esc((clocks && clocks.modelVersion) || '?')}</span> ${narr} ${next} ${cacheChip} ${cov}${un}
  </div>`;
}

// ── shell ───────────────────────────────────────────────────────────────────
// ── Three-layer regime stack ────────────────────────────────────────────────
// Rendered as THREE separate rows. There is deliberately no combined regime badge:
// compressing the horizons hides exactly the conflict an expert needs to see.
const P2_LAYER_META = {
  intraday: ['⚡', 'Intraday', 'trend/chop, breadth, VWAP participation, realized-volatility expansion'],
  tactical: ['📅', 'Tactical (1–4 weeks)', 'breadth thrust, leadership, credit, rates, dollar, volatility curve'],
  strategic: ['🏛', 'Strategic (1–6 months)', 'growth, inflation, liquidity, earnings revisions, valuation'],
};
const P2_STATE_COLOR = {
  TRENDING_UP: '#22c55e', TRENDING_DOWN: '#ef4444', CHOPPY: '#94a3b8', VOLATILITY_EXPANSION: '#f0a832',
  BROADENING: '#22c55e', NARROWING: '#f0a832', RISK_SEEKING: '#22c55e', RISK_AVERSE: '#ef4444',
  EXPANSION: '#22c55e', RECOVERY: '#3b82f6', SLOWDOWN: '#f0a832', CONTRACTION: '#ef4444',
  MIXED: '#94a3b8', UNAVAILABLE: '#64748b',
};

function persistenceLabel(l) {
  if (!l.persistence || !l.persistence.sinceISO) return '';
  const n = l.persistence.observations || 1;
  return ` · held ${n} observation${n === 1 ? '' : 's'}`;
}

export function regimeLayerRow(l) {
  const [icon, title, inputs] = P2_LAYER_META[l.name] || ['•', l.name, ''];
  const col = P2_STATE_COLOR[l.state] || '#94a3b8';
  if (!l.available) {
    return `<div class="p2-regime-layer">
      <div class="p2-regime-head"><b>${icon} ${esc(title)}</b>
        <span class="p2-regime-state" style="color:#64748b;border-color:#64748b">UNAVAILABLE</span></div>
      <div class="p2-dim">${esc(l.unavailableReason || 'no inputs')}</div>
      <div class="p2-dim">Inputs it would need: ${esc(inputs)}.</div>
    </div>`;
  }
  const obsList = arr => arr.map(o => `<li>${esc(o.text)}${o.value != null ? ` <span class="p2-dim">(${esc(String(o.value))})</span>` : ''}</li>`).join('');
  return `<div class="p2-regime-layer">
    <div class="p2-regime-head"><b>${icon} ${esc(title)}</b>
      <span class="p2-regime-state" style="color:${col};border-color:${col}">${esc(l.state.replace(/_/g, ' '))}</span>
      ${l.contested ? '<span class="p2-regime-contested" title="This layer carries observations that argue AGAINST its own state. They are kept, not netted out.">⚖ contested</span>' : ''}
      <span class="p2-dim" style="margin-left:auto">coverage ${Math.round((l.coverage && l.coverage.fraction || 0) * 100)}%</span></div>
    <div class="p2-dim">${l.previousState && l.previousState !== l.state ? `was ${esc(l.previousState.replace(/_/g, ' '))} · changed ${esc(fmtWhen(l.transitionAt))}` : 'no change since the previous read'}${esc(persistenceLabel(l))}</div>
    ${l.supporting.length ? `<div class="p2-regime-obs"><b>Supporting</b><ul>${obsList(l.supporting)}</ul></div>` : ''}
    ${l.contradicting.length ? `<div class="p2-regime-obs p2-regime-against"><b>Contradicting</b><ul>${obsList(l.contradicting)}</ul></div>` : ''}
    ${(l.whatWouldFlipIt || []).length ? `<div class="p2-dim">Would flip it: ${l.whatWouldFlipIt.map(esc).join('; ')}.</div>` : ''}
  </div>`;
}

export function renderRegimeStack(stack) {
  if (!stack) {
    return emptySection('🧭 Regime stack', 'no market-state tick has persisted a regime stack yet — it is written by the scheduled state tick.');
  }
  const layers = (stack.layerOrder || ['intraday', 'tactical', 'strategic']).map(k => stack.layers[k]).filter(Boolean);
  return `<div class="p2-regime">
    <div class="p2-sec-head">🧭 Regime stack <span class="p2-dim">— three horizons, reported separately</span></div>
    <div class="p2-dim" style="margin-bottom:6px">${esc(stack.compositeNote || '')}</div>
    ${(stack.horizonConflicts || []).length ? `<div class="p2-conflict">⚠ <b>Horizon conflict:</b> ${stack.horizonConflicts.map(esc).join(' ')}</div>` : ''}
    ${layers.map(regimeLayerRow).join('')}
  </div>`;
}

// ── Cross-asset confirmation matrix ─────────────────────────────────────────
const P2_VERDICT_STYLE = {
  CONFIRMS: ['✓', '#22c55e'], CONTRADICTS: ['✗', '#ef4444'],
  NEUTRAL: ['–', '#94a3b8'], UNAVAILABLE: ['?', '#64748b'],
};

export function renderCrossAsset(m) {
  if (!m) return emptySection('🔗 Cross-asset confirmation', 'no cross-asset matrix has persisted yet — it is written by the scheduled state tick.');
  if (!m.available) {
    return emptySection('🔗 Cross-asset confirmation', 'not one leg could be measured — this is a DEGRADED data state. It does NOT mean the cross-asset legs are quiet or in agreement.');
  }
  const rows = Object.values(m.rows || {});
  const row = r => {
    const [mark, col] = P2_VERDICT_STYLE[r.verdict] || P2_VERDICT_STYLE.UNAVAILABLE;
    const val = r.changePct != null ? `${r.changePct >= 0 ? '+' : ''}${r.changePct}%`
      : r.level != null ? String(r.level)
        : r.slope != null ? `slope ${r.slope}` : '—';
    return `<tr title="${esc(r.proxyNote || r.reason || '')}">
      <td>${esc(r.underlying)}</td>
      <td class="p2-dim">${r.proxy ? esc(r.proxy) : '—'}</td>
      <td style="text-align:right">${esc(val)}</td>
      <td style="color:${col};text-align:center" title="${esc(r.reason || r.verdict)}">${mark}</td>
    </tr>`;
  };
  return `<div class="p2-crossasset">
    <div class="p2-sec-head">🔗 Cross-asset confirmation <span class="p2-dim">— vs SPY ${m.equityChangePct != null ? (m.equityChangePct >= 0 ? '+' : '') + m.equityChangePct + '%' : ''}</span></div>
    <div class="p2-dim">${esc(m.summary.confirmationRatioNote)}</div>
    ${m.summary.contradicting ? `<div class="p2-conflict">⚠ <b>Contradicting:</b> ${m.summary.contradictingLegs.map(esc).join(' · ')}</div>` : ''}
    <div class="p2-ca-scroll"><table class="p2-ca-table">
      <thead><tr><th>Leg</th><th>Proxy</th><th style="text-align:right">Change</th><th>vs equities</th></tr></thead>
      <tbody>${rows.map(row).join('')}</tbody>
    </table></div>
    <div class="p2-dim">${esc(m.proxyDisclosure)}</div>
    ${m.coverage.unavailable.length ? `<details><summary class="p2-dim">${m.coverage.unavailable.length} leg(s) could not be measured</summary><ul class="p2-dim">${m.coverage.unavailable.map(u => `<li>${esc(u.underlying)}: ${esc(u.reason)}</li>`).join('')}</ul></details>` : ''}
  </div>`;
}

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
  ${renderHealthStrip(clocks, p.unavailable, p.marketState && p.marketState.coverage, p.cache)}
  ${renderMarketNow(p.marketState, clocks)}
  ${renderRegimeStack(p.regimeStack)}
  ${renderCrossAsset(p.crossAsset)}
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

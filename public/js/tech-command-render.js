// 🖥 TECHNOLOGY COMMAND CENTER — card/section renderers.
//
// Pure string builders. Every one of them handles four states explicitly:
// present, partial, empty-with-a-reason, and unavailable. Status is never
// communicated by colour alone — each state carries a text label and, where a
// colour is used, an icon or word repeats the meaning.
import { esc } from './format.js';

export const ACCENT = '#06c4d4';
const DIM = 'var(--text-dim)';

// ── shared atoms ────────────────────────────────────────────────────────────
export const fmtNum = (v, digits = 2, suffix = '') =>
  (v == null || !Number.isFinite(v) ? '—' : `${(+v).toFixed(digits)}${suffix}`);
export const fmtPct = (v, digits = 2) =>
  (v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${(+v).toFixed(digits)}%`);
export const fmtUsd = (v) => {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}k`;
  return `$${v.toFixed(0)}`;
};
export const shortTime = (iso) => (iso ? String(iso).replace('T', ' ').slice(0, 16) : '—');
// Three-valued display: null means UNKNOWN, and unknown must read as unknown — never
// as "false" and never as a blank.
const tri = (v) => (v === true ? 'yes' : v === false ? 'no' : 'unknown');

// Action → { label, tone, glyph }. The glyph carries the meaning so a colour-blind
// or monochrome reader loses nothing.
const ACTION_META = {
  TRIGGERED: ['Triggered', 'var(--green)', '▶'],
  ENTER: ['Enter', 'var(--green)', '▶'],
  ACCUMULATE: ['Accumulate', 'var(--green)', '▲'],
  READY: ['Ready', 'var(--cyan)', '◆'],
  MANAGE: ['Manage', 'var(--blue)', '■'],
  HOLD: ['Hold', 'var(--blue)', '■'],
  WATCH_VALUATION: ['Watch valuation', 'var(--amber)', '◐'],
  WATCH: ['Watch', DIM, '○'],
  DO_NOT_CHASE: ['Do not chase', 'var(--amber)', '✕'],
  AVOID: ['Avoid', 'var(--amber)', '✕'],
  THESIS_WEAKENING: ['Thesis weakening', 'var(--amber)', '▽'],
  REDUCE: ['Reduce', 'var(--amber)', '▽'],
  EXIT_INVALIDATE: ['Exit — invalidated', 'var(--red)', '✖'],
  EXIT_THESIS_BROKEN: ['Exit — thesis broken', 'var(--red)', '✖'],
  INVALIDATED: ['Invalidated', 'var(--red)', '✖'],
  EXPIRED: ['Expired', DIM, '⊘'],
  TARGET_REACHED: ['Target reached', 'var(--green)', '✔'],
  INSUFFICIENT_DATA: ['Insufficient data', DIM, '?'],
  NOT_ON_BOARD: ['Not on board', DIM, '–'],
};

export function actionPill(action) {
  const [label, tone, glyph] = ACTION_META[action] || [action || 'Unknown', DIM, '·'];
  return `<span class="tc-pill" style="--tc-tone:${tone}" role="status" aria-label="Action: ${esc(label)}">
    <span aria-hidden="true">${glyph}</span> ${esc(label)}</span>`;
}

export function freshnessBadge(state, asOf) {
  const map = {
    fresh: ['Fresh', 'var(--green)'], delayed: ['Delayed', 'var(--amber)'],
    stale: ['Stale', 'var(--red)'], partial: ['Partial', 'var(--amber)'],
    unavailable: ['Unavailable', 'var(--red)'],
  };
  const [label, tone] = map[state] || ['Unknown', DIM];
  return `<span class="tc-fresh" style="--tc-tone:${tone}" title="${esc(asOf || 'no timestamp')}">${esc(label)}${asOf ? ` · ${esc(shortTime(asOf))}` : ''}</span>`;
}

export function emptyState(title, reason) {
  return `<div class="tc-empty" role="status">
    <div class="tc-empty-title">${esc(title)}</div>
    <p>${esc(reason || 'Nothing to show.')}</p>
  </div>`;
}

export function expert(summary, body) {
  return `<details class="tc-expert"><summary>${esc(summary)}</summary><div class="tc-expert-body">${body}</div></details>`;
}

function kv(label, value, title) {
  return `<div class="tc-kv"${title ? ` title="${esc(title)}"` : ''}><span>${esc(label)}</span><b>${value}</b></div>`;
}

function list(items, className = '') {
  const arr = (items || []).filter(Boolean);
  if (!arr.length) return '';
  return `<ul class="tc-list ${className}">${arr.map(x => `<li>${esc(typeof x === 'string' ? x : (x.label || JSON.stringify(x)))}</li>`).join('')}</ul>`;
}

// ── 1. Regime header ────────────────────────────────────────────────────────
export function renderRegime(regime) {
  if (!regime) return emptyState('Technology regime unavailable', 'The regime header could not be computed this cycle. Treat every board below as low-confidence.');
  const m = regime.measures || {};
  const s = regime.states || {};
  const chips = [
    ['Leadership', s.leadership], ['Participation', s.participation],
    ['Concentration', s.concentration], ['Volatility', s.volatility], ['Crowding', s.crowding],
  ].map(([k, v]) => `<span class="tc-chip"${v === 'unknown' ? ' data-unknown="1"' : ''}>${esc(k)}: <b>${esc(v || 'unknown')}</b></span>`).join('');

  const leaders = (m.leadership || []).map(l =>
    `<div class="tc-lead-row"><span>${esc(l.group)} <i>(${esc(l.etf)})</i></span><b>${fmtPct(l.excessVsQqq21)}</b></div>`).join('');

  const measures = [
    kv('Tech vs SPY (21d)', fmtPct(m.techVsSpy21)), kv('Tech vs SPY (63d)', fmtPct(m.techVsSpy63)),
    kv('QQQ vs SPY (21d)', fmtPct(m.qqqVsSpy21)), kv('Equal-wt vs cap-wt (21d)', fmtPct(m.equalWeightVsCapWeight21)),
    kv('% above 50DMA', fmtNum(m.pctAbove50dma, 1, '%')), kv('% above 200DMA', fmtNum(m.pctAbove200dma, 1, '%')),
    kv('Advancers / decliners', m.advancing == null ? '—' : `${m.advancing} / ${m.declining}`),
    kv('New highs / lows (63d)', m.newHighs63 == null ? '—' : `${m.newHighs63} / ${m.newLows63}`),
    kv('Cross-sectional dispersion', fmtNum(m.dispersion21, 1)),
    kv('Avg pairwise correlation', fmtNum(m.averagePairwiseCorrelation, 2)),
    kv('Realized vol (ann.)', fmtNum(m.realizedVolAnnualizedPct, 1, '%')),
    kv('Vol percentile (1y)', fmtNum(m.realizedVolPercentile1y, 2)),
    kv('Rate correlation (QQQ/TLT)', fmtNum(m.rateCorrelationQqqTlt63, 2)),
    kv('Intraday VWAP participation', '<i>not computed</i>'),
  ].join('');

  const missing = (regime.missing || []).length
    ? `<div class="tc-missing"><b>Not measured:</b> ${(regime.missing || []).map(x => esc(x)).join(' · ')}</div>` : '';

  return `<section class="tc-regime" aria-labelledby="tc-regime-h">
    <h3 id="tc-regime-h" class="tc-h3">Technology regime <span class="tc-code">${esc(regime.classification || '—')}</span></h3>
    <p class="tc-novice">${esc(regime.novice || '')}</p>
    <div class="tc-chips">${chips}</div>
    ${missing}
    ${expert('Expert measurements, coverage and thresholds', `
      <div class="tc-kvgrid">${measures}</div>
      <h4 class="tc-h4">Group leadership vs QQQ (21 sessions)</h4>
      <div class="tc-leadgrid">${leaders || '<i>unavailable</i>'}</div>
      <p class="tc-note">Breadth sample: ${regime.coverage ? regime.coverage.breadthSample : '—'} names ·
        dimensions measured ${regime.coverage ? regime.coverage.dimensionsKnown : '—'}/${regime.coverage ? regime.coverage.dimensionsTotal : '—'} ·
        ${esc(regime.note || '')}</p>
    `)}
  </section>`;
}

// ── 2. Alignment strip ──────────────────────────────────────────────────────
export function renderAlignment(alignment) {
  const rows = (alignment && alignment.rows) || [];
  const multi = rows.filter(r => r.horizonsPresent > 1).slice(0, 12);
  if (!multi.length) return '';
  const cell = (h) => (h ? `${esc(h.stance)}` : 'not on board');
  return `<section class="tc-align" aria-labelledby="tc-align-h">
    <h3 id="tc-align-h" class="tc-h3">Multi-horizon alignment</h3>
    <p class="tc-note">${esc(alignment.policy)}</p>
    <div class="tc-align-grid" role="table" aria-label="Multi-horizon alignment">
      <div class="tc-align-row tc-align-head" role="row">
        <span role="columnheader">Ticker</span><span role="columnheader">Day</span>
        <span role="columnheader">Swing</span><span role="columnheader">Long term</span><span role="columnheader">Agreement</span>
      </div>
      ${multi.map(r => `<div class="tc-align-row" role="row">
        <button class="tc-ticker-btn" data-ticker="${esc(r.ticker)}" role="cell">${esc(r.ticker)}</button>
        <span role="cell">${cell(r.daytrade)}</span>
        <span role="cell">${cell(r.swing)}</span>
        <span role="cell">${cell(r.longterm)}</span>
        <span role="cell">${esc(r.agreement)}</span>
      </div>`).join('')}
    </div>
  </section>`;
}

// ── 3a. Day-trade board ─────────────────────────────────────────────────────
export function renderDaytrade(board, { expertMode }) {
  if (!board) return emptyState('Day-trade board unavailable', 'The frozen Day Trade engine could not be read.');
  const rows = (board.rows || []).slice(0, 5);
  const head = `<div class="tc-board-head">
      <h3 class="tc-h3">⚡ Day trade <span class="tc-sub">same session</span></h3>
      <span class="tc-src">Read-only projection of the frozen Day Trade engine · ${esc(board.sourceEngine || '')} · ${freshnessBadge(board.sourceGeneratedAt ? 'fresh' : 'unavailable', board.sourceGeneratedAt)}</span>
    </div>`;
  if (!rows.length) return `<section class="tc-board" aria-labelledby="tc-dt-h">${head}${emptyState('No high-quality technology day trades are currently triggered.', board.emptyReason)}</section>`;

  return `<section class="tc-board" aria-labelledby="tc-dt-h">${head}
    ${rows.map(r => `<article class="tc-card" data-ticker="${esc(r.ticker)}">
      <header class="tc-card-head">
        <button class="tc-ticker-btn tc-ticker-lg" data-ticker="${esc(r.ticker)}">${esc(r.ticker)}</button>
        <span class="tc-company">${esc(r.company || '')}</span>
        <span class="tc-chip">${esc(r.subsectorLabel || 'Unclassified')}</span>
        ${actionPill(r.action)}
        <span class="tc-code" title="Engine lifecycle state, carried through unchanged">${esc(r.lifecycleState || '—')}</span>
      </header>
      <div class="tc-why"><b>Why now:</b> ${esc(r.catalyst || r.transitionReason || 'No catalyst was recorded by the engine.')}</div>
      <div class="tc-kvgrid tc-kvgrid-tight">
        ${kv('Price', fmtNum(r.price))}${kv('Change', fmtPct(r.pctChange))}
        ${kv('Rel. volume', fmtNum(r.relVol, 2, '×'))}${kv('$ volume', fmtUsd(r.dollarVolume))}
        ${kv('VWAP', r.aboveVwap == null ? '—' : (r.aboveVwap ? 'above' : 'below'))}
        ${kv('Opening range', r.openingRangeForming == null ? '—' : (r.openingRangeForming ? 'forming' : 'complete'))}
        ${kv('Trigger', fmtNum(r.trigger))}${kv('Invalidation', fmtNum(r.invalidation))}
        ${kv('Target', fmtNum(r.target))}${kv('Chase distance', fmtPct(r.chaseDistancePct))}
      </div>
      ${r.techAnnotations ? `<div class="tc-annot"><b>Technology-relative (annotation only):</b>
        vs QQQ ${fmtPct(r.techAnnotations.rsVsQqqPct)} · vs ${esc(r.techAnnotations.subsectorBenchmark || 'subsector')} ${fmtPct(r.techAnnotations.rsVsSubsectorPct)}
        <i>${esc(r.techAnnotations.note)}</i></div>` : ''}
      ${(r.liquidityGate && r.liquidityGate.blocked) ? `<div class="tc-warn"><b>Execution gate blocked:</b> ${(r.liquidityGate.reasons || []).map(esc).join('; ')}</div>` : ''}
      ${expertMode ? expert('Expert detail', `
        <div class="tc-kvgrid">
          ${kv('Runner score (uncalibrated)', fmtNum(r.runnerScore, 0))}${kv('Dud score (uncalibrated)', fmtNum(r.dudScore, 0))}
          ${kv('Residual vs SPY', fmtPct(r.residualVsSpy))}${kv('Extension (ATR)', fmtNum(r.extensionAtr))}
          ${kv('Remaining R:R', fmtNum(r.remainingRR))}${kv('Round-trip cost', fmtNum(r.costRoundTripBps, 0, 'bps'))}
          ${kv('Spread', r.spreadStatus === 'observed' ? fmtNum(r.spreadPct, 3, '%') : 'unknown')}
          ${kv('Plan basis', esc(r.planBasis || '—'))}
          ${kv('Session fresh', tri(r.currentSessionFresh))}${kv('Thesis valid', tri(r.thesisValid))}
        </div>
        <p class="tc-note">Last evaluated ${esc(shortTime(r.lastEvaluatedAt))} · quote ${esc(shortTime(r.quoteAsOf))} · bar ${esc(shortTime(r.intradayBarAsOf))}
          · state reason: ${esc(r.transitionReason || 'n/a')}</p>
      `) : ''}
    </article>`).join('')}
    ${board.transitions && board.transitions.length ? `<p class="tc-note"><b>Since the last evaluation:</b> ${board.transitions.slice(0, 6).map(t => esc(`${t.ticker} ${t.from || 'new'}→${t.to}`)).join(' · ')}</p>` : ''}
  </section>`;
}

// ── 3b. Swing board ─────────────────────────────────────────────────────────
export function renderSwing(board, { expertMode }) {
  if (!board) return emptyState('Swing board unavailable', 'The governed swing cross-section could not be read.');
  const featured = board.featured || [];
  const persisted = (board.rows || []).filter(r => r.persisted || r.removalReason);
  const head = `<div class="tc-board-head">
      <h3 class="tc-h3">📅 Swing <span class="tc-sub">3–30 sessions</span></h3>
      <span class="tc-src">${esc(board.rankBasis || '')}</span>
    </div>`;
  const body = featured.length
    ? featured.map(r => swingCard(r, expertMode)).join('')
    : emptyState('No swing setups currently clear execution and evidence gates.', board.emptyReason);
  return `<section class="tc-board" aria-labelledby="tc-sw-h">${head}${body}
    ${persisted.length ? expert(`Previously published, still tracked (${persisted.length})`, persisted.map(r =>
    `<div class="tc-tracked"><b>${esc(r.ticker)}</b> — ${actionPill(r.action)} <span>${esc(r.removalReason || r.whyStillHere || 'retained')}</span></div>`).join('')) : ''}
  </section>`;
}

function swingCard(r, expertMode) {
  const ev = r.evidence || {};
  return `<article class="tc-card" data-ticker="${esc(r.ticker)}">
    <header class="tc-card-head">
      <button class="tc-ticker-btn tc-ticker-lg" data-ticker="${esc(r.ticker)}">${esc(r.ticker)}</button>
      <span class="tc-company">${esc(r.company || '')}</span>
      <span class="tc-chip">${esc(r.subsectorLabel || '')}</span>
      ${actionPill(r.action)}
      <span class="tc-code" title="Upstream eligibility class">${esc(r.signalClass || 'unclassified')}</span>
    </header>
    <div class="tc-why"><b>Why now:</b> ${esc(r.whyNow || '')}</div>
    <div class="tc-why"><b>On the board because:</b> ${esc(r.whyOnBoard || '')} · setup ${esc(r.setupType || 'n/a')}</div>
    <div class="tc-kvgrid tc-kvgrid-tight">
      ${kv('Trigger', fmtNum(r.trigger))}${kv('Invalidation', fmtNum(r.invalidation))}
      ${kv('Target', fmtNum(r.target))}${kv('Reward:risk', fmtNum(r.rr))}
      ${kv('Hold', esc(r.expectedHoldingPeriod || ''))}${kv('Earnings in', r.earningsInDays == null ? 'unknown' : `${r.earningsInDays}d`)}
      ${kv('vs QQQ (21d)', fmtPct(r.techContext && r.techContext.rsVsQqq21))}
      ${kv('vs subsector (21d)', fmtPct(r.techContext && r.techContext.rsVsSubsector21))}
    </div>
    ${r.demotedFrom ? `<div class="tc-warn"><b>Demoted ${esc(r.demotedFrom)} → ${esc(r.action)}</b> by the upstream evidence class (${esc(r.signalClass || 'unknown')}). A research signal cannot become an actionable recommendation here.</div>` : ''}
    ${(r.gatesFailed || []).length ? `<div class="tc-warn"><b>Not an entry because:</b> ${(r.gatesFailed || []).map(esc).join('; ')}</div>` : ''}
    ${r.removalReason ? `<div class="tc-warn"><b>Status:</b> ${esc(r.removalReason)}</div>` : ''}
    <div class="tc-evi">
      <div><b>Supports</b>${list((r.supporting || []).map(e => `${e.label}${e.value == null ? '' : `: ${e.value}`}`))}</div>
      <div><b>Contradicts</b>${(r.contradicting || []).length ? list((r.contradicting || []).map(e => `${e.label}${e.value == null ? '' : `: ${e.value}`}`)) : '<p class="tc-note">Nothing measured contradicts this — that is not the same as nothing existing.</p>'}</div>
    </div>
    ${expertMode ? expert('Score decomposition & evidence quality', `
      <p class="tc-note">${esc(ev.scoreLabel || '')}: <b>${ev.score == null ? '—' : ev.score}</b> ·
        evidence quality <b>${esc(ev.evidenceQuality || '—')}</b> · coverage ${ev.coveragePct == null ? '—' : ev.coveragePct}%
        · <b>not used for ranking</b> (${esc(r.rankBasisNote || 'the board is ordered by the upstream governed score')}).</p>
      ${(ev.missingFamilies || []).length ? `<p class="tc-note"><b>Missing evidence families (quality reduced):</b> ${(ev.missingFamilies || []).map(esc).join(', ')}</p>` : ''}
      <div class="tc-decomp">${(ev.contributions || []).map(c => `<div class="tc-decomp-row">
        <span>${esc(c.label)}</span>
        <span class="tc-code">${esc(c.family)}${c.cluster ? ` · cluster ${esc(c.cluster)}` : ''}</span>
        <span>w ${c.effectiveWeight}${c.correlationDiscount < 1 ? ` (discounted ×${c.correlationDiscount})` : ''}</span>
        <b>${c.contribution >= 0 ? '+' : ''}${c.contribution}</b>
        ${c.researchOnly ? '<i>research-only, weight 0</i>' : ''}
      </div>`).join('')}</div>
      <p class="tc-note">${esc(ev.correlationNote || '')}</p>
      <p class="tc-note"><b>Probability:</b> ${esc(r.probabilityNote || 'none available')}</p>
      <p class="tc-note"><b>What would remove it:</b> ${(r.whatWouldRemoveIt || []).map(esc).join(' · ')}</p>
    `) : ''}
  </article>`;
}

// ── 3c. Long-term board ─────────────────────────────────────────────────────
export function renderLongTerm(board, { expertMode }) {
  if (!board) return emptyState('Long-term board unavailable', 'The long-term model could not be run.');
  const featured = board.featured || [];
  const head = `<div class="tc-board-head">
      <h3 class="tc-h3">🏛 Long-term investment <span class="tc-sub">6–36 months</span></h3>
      <span class="tc-src">${esc(board.modelNote || '')}</span>
    </div>`;
  if (!featured.length) {
    return `<section class="tc-board">${head}${emptyState('No long-term candidates currently offer a sufficiently attractive expectations/risk balance.', board.emptyReason)}
      ${unavailableFactors(board)}</section>`;
  }
  return `<section class="tc-board">${head}
    ${featured.map(r => `<article class="tc-card" data-ticker="${esc(r.ticker)}">
      <header class="tc-card-head">
        <button class="tc-ticker-btn tc-ticker-lg" data-ticker="${esc(r.ticker)}">${esc(r.ticker)}</button>
        <span class="tc-company">${esc(r.company || '')}</span>
        <span class="tc-chip">${esc(r.subsectorLabel || '')}</span>
        ${actionPill(r.action)}
        <span class="tc-code">data ${r.dataCompletenessPct == null ? '—' : r.dataCompletenessPct}% · evidence ${esc(r.evidenceQuality || '—')}</span>
      </header>
      <div class="tc-why"><b>Thesis:</b> ${esc(r.coreThesis || '')}</div>
      <div class="tc-why"><b>What the market appears to expect:</b> ${esc(r.marketExpects || '')}</div>
      <div class="tc-why"><b>What could exceed it:</b> ${(r.couldExceedExpectations || []).map(esc).join(' · ')}</div>
      <div class="tc-kvgrid tc-kvgrid-tight">
        ${kv('Revenue growth', fmtNum(r.growthProfile && r.growthProfile.revGrowth, 1, '%'))}
        ${kv('EPS growth', fmtNum(r.growthProfile && r.growthProfile.epsGrowth, 1, '%'))}
        ${kv('Rev. acceleration', fmtNum(r.growthProfile && r.growthProfile.revAccel, 1, 'pp'))}
        ${kv('Op. margin', fmtNum(r.qualityProfile && r.qualityProfile.operatingMargin, 1, '%'))}
        ${kv('P/E', fmtNum(r.valuation && r.valuation.pe, 1))}
        ${kv('P/E ÷ growth', fmtNum(r.valuation && r.valuation.peToGrowth, 2))}
        ${kv('Long-term trend', esc((r.longTermTrend && r.longTermTrend.trend) || '—'))}
        ${kv('vs QQQ (126d)', fmtPct(r.techContext && r.techContext.rsVsQqq126))}
      </div>
      <div class="tc-evi">
        <div><b>Next proof points</b>${list((r.nextProofPoints || []).map(p => `${p.what}${p.when ? ` — ${p.when}` : ''}`))}</div>
        <div><b>Thesis risks</b>${list(r.thesisRisks)}</div>
      </div>
      ${r.revisions ? `<div class="tc-warn"><b>Analyst revisions (${esc(r.revisions.status)}):</b> ${esc(r.revisions.summary)} —
        displayed as current context only, weight zero, cannot lift this action.</div>` : ''}
      ${expertMode ? expert('Invalidation, bear case and score decomposition', `
        <p class="tc-note"><b>Long-term invalidation:</b> ${(r.longTermInvalidation || []).map(esc).join(' · ')}</p>
        <p class="tc-note"><b>Bear case:</b> ${(r.bearCase || []).map(esc).join(' · ') || 'nothing measured'}</p>
        <p class="tc-note">${esc(r.scoreLabel || '')}: <b>${r.score == null ? '—' : r.score}</b> — ${esc(board.probabilityNote || '')}</p>
        <div class="tc-decomp">${((r.evidence && r.evidence.contributions) || []).map(c =>
    `<div class="tc-decomp-row"><span>${esc(c.label)}</span><span class="tc-code">${esc(c.family)}</span><span>w ${c.effectiveWeight}</span><b>${c.contribution >= 0 ? '+' : ''}${c.contribution}</b></div>`).join('')}</div>
      `) : ''}
    </article>`).join('')}
    ${unavailableFactors(board)}
  </section>`;
}

function unavailableFactors(board) {
  const f = (board && board.unavailableFactors) || [];
  if (!f.length) return '';
  return expert(`Factors this model cannot see (${f.length})`,
    `<p class="tc-note">These are not estimated or proxied. Their absence lowers the data-completeness grade on every card.</p>
     ${list(f.map(x => `${x.factor} — ${x.reason}`))}`);
}

// ── 4. Around the corner ────────────────────────────────────────────────────
const BUCKET_LABEL = {
  'next-session': 'Next session', 'next-48h': 'Next 48 hours',
  'next-two-weeks': 'Next two weeks', 'next-1-3-months': 'Next 1–3 months',
};

export function renderEvents(events, scenarios, { expertMode }) {
  if (!events) return emptyState('Event timeline unavailable', 'No event data could be assembled.');
  const evRow = e => `<li class="tc-ev">
    <span class="tc-code">${esc(e.kind)}${e.scheduled ? ' · scheduled' : ' · emerging'}</span>
    ${e.ticker ? `<button class="tc-ticker-btn" data-ticker="${esc(e.ticker)}">${esc(e.ticker)}</button>` : '<span class="tc-chip">sector</span>'}
    ${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.title)}</a>` : esc(e.title)}
    <i>${esc(e.publisher || 'source unknown')} · ${esc(e.scheduledFor || shortTime(e.publishedAt))}${e.syndicatedCopies ? ` · ${e.syndicatedCopies} syndicated copies merged` : ''}</i>
  </li>`;

  const upcoming = Object.entries(events.byBucket || {}).map(([b, arr]) => `
    <div class="tc-bucket">
      <h4 class="tc-h4">${esc(BUCKET_LABEL[b] || b)} <span class="tc-code">${(arr || []).length}</span></h4>
      ${(arr || []).length ? `<ul class="tc-evlist">${arr.slice(0, 8).map(evRow).join('')}</ul>` : '<p class="tc-note">Nothing dated in this window from the sources available.</p>'}
    </div>`).join('');

  const presentRows = (events.present || []).filter(p => (p.contradictions || []).length).slice(0, 8);

  const scen = Object.entries(scenarios || {}).slice(0, 5).map(([t, s]) => `
    <article class="tc-card tc-scen">
      <header class="tc-card-head"><button class="tc-ticker-btn tc-ticker-lg" data-ticker="${esc(t)}">${esc(t)}</button>
        <span class="tc-code">window: ${esc(s.window)}</span></header>
      ${['bull', 'base', 'bear'].map(k => `<div class="tc-scen-row">
        <b>${esc(s[k].label)}</b><span>${esc(s[k].condition)}</span><i>${esc(s[k].priceContext)}</i></div>`).join('')}
      <div class="tc-why"><b>Confirmed by:</b> ${(s.bull.confirmedBy || []).map(esc).join(' · ')}</div>
      <div class="tc-why"><b>Invalidated by:</b> ${(s.invalidationConditions || []).map(esc).join(' · ')}</div>
      ${s.affectedRelated && s.affectedRelated.length ? `<div class="tc-why"><b>Related names:</b> ${s.affectedRelated.map(esc).join(', ')}</div>` : ''}
      <p class="tc-note">${esc(s.probabilityNote)} Data confidence: ${(s.dataConfidence || []).map(esc).join('; ')}.</p>
    </article>`).join('');

  return `<section class="tc-board" aria-labelledby="tc-ev-h">
    <div class="tc-board-head"><h3 id="tc-ev-h" class="tc-h3">🧭 Around the corner</h3>
      <span class="tc-src">${events.counts ? `${events.counts.past} past · ${events.counts.upcoming} upcoming · ${events.counts.duplicatesRemoved} syndicated duplicates removed` : ''}</span></div>
    ${events.empty ? emptyState('No dated technology events', events.emptyReason) : ''}
    <div class="tc-buckets">${upcoming}</div>
    ${presentRows.length ? `<div class="tc-bucket"><h4 class="tc-h4">Happening now — contradictions</h4>
      <ul class="tc-list">${presentRows.map(p => `<li><b>${esc(p.ticker)}</b>: ${(p.contradictions || []).map(esc).join(' ')}</li>`).join('')}</ul></div>` : ''}
    ${scen ? `<h4 class="tc-h4">Scenarios (mechanical, not forecasts)</h4>${scen}` : ''}
    ${expertMode && (events.past || []).length ? expert(`Past events (${(events.past || []).length})`, `<ul class="tc-evlist">${events.past.slice(0, 20).map(evRow).join('')}</ul>`) : ''}
    ${expertMode && (events.undated || []).length ? expert(`Undated items excluded from the timeline (${events.undated.length})`, `<ul class="tc-evlist">${events.undated.slice(0, 10).map(evRow).join('')}</ul>`) : ''}
  </section>`;
}

// ── 5. Leadership / read-through map ────────────────────────────────────────
export function renderReadThrough(rt, { expertMode }) {
  if (!rt) return '';
  const groups = (rt.groups || []).filter(g => g.observed > 0).slice(0, 12);
  return `<section class="tc-board">
    <div class="tc-board-head"><h3 class="tc-h3">🕸 Technology leadership & read-through</h3>
      <span class="tc-src">${esc(rt.relationshipPolicy || '')}</span></div>
    ${groups.length ? `<div class="tc-groupgrid">${groups.map(g => `<div class="tc-group">
      <b>${esc(g.label)}</b>
      <span>${fmtPct(g.medianPctChange)} median</span>
      <span>${g.breadthUpPct == null ? '—' : `${g.breadthUpPct}% up`}</span>
      <i>${g.observed}/${g.members} observed (${g.coverage}% coverage)</i>
    </div>`).join('')}</div>` : '<p class="tc-note">No subsector had enough observed members to summarise.</p>'}
    ${(rt.movers || []).slice(0, 6).map(m => `<article class="tc-card">
      <header class="tc-card-head">
        <button class="tc-ticker-btn tc-ticker-lg" data-ticker="${esc(m.ticker)}">${esc(m.ticker)}</button>
        <span class="tc-chip">${esc(m.subsectorLabel)}</span>
        <span class="tc-code">${esc(m.scope)}</span>
        <b>${fmtPct(m.pctChange)}</b>
      </header>
      <div class="tc-why">${esc(m.scopeExplanation)} ${esc(m.betaCheck)}</div>
      <div class="tc-kvgrid tc-kvgrid-tight">
        ${kv('Group median', fmtPct(m.groupMedianPctChange))}${kv('Idiosyncratic', fmtPct(m.idiosyncraticPct))}
        ${kv('Confirming peers', (m.confirmingPeers || []).map(p => p.ticker).join(', ') || '—')}
        ${kv('Contradicting peers', (m.contradictingPeers || []).map(p => p.ticker).join(', ') || '—')}
        ${kv('Not yet reacted', (m.notYetReacted || []).map(p => p.ticker).join(', ') || '—')}
        ${kv('Next in group to report', m.nextGroupReporter ? `${m.nextGroupReporter.ticker} (${m.nextGroupReporter.earningsDate})` : '—')}
      </div>
      ${expertMode ? expert('Relationship provenance', `
        <p class="tc-note"><b>Direct (verified):</b></p>
        ${list((m.directEdges || []).map(e => `${e.from}→${e.to} · ${e.type} · ${e.mechanism} · source ${e.source} · ${e.confidence}`))}
        <p class="tc-note"><b>Inferred (research only, weight 0):</b></p>
        ${(m.inferredEdges || []).length ? list((m.inferredEdges || []).map(e => `${e.from}→${e.to} · ${e.type} · ${e.mechanism} · source ${e.source}`)) : '<p class="tc-note">None recorded. Relationships are never invented.</p>'}
      `) : ''}
    </article>`).join('')}
  </section>`;
}

// ── 6. Options ──────────────────────────────────────────────────────────────
export function renderOptions(opt) {
  if (!opt) return '';
  const rows = (opt.rows || []).slice(0, 8);
  return `<section class="tc-board">
    <div class="tc-board-head"><h3 class="tc-h3">📈 Unusual options positioning</h3>
      <span class="tc-src">Delayed chain data · weight 0 · cannot originate a recommendation</span></div>
    <div class="tc-warn"><b>What this data cannot tell you:</b> buyer vs seller, opening vs closing, directional bet vs hedge, or true sweep aggression. ${esc(opt.liveOrderFlowNote || '')}</div>
    ${rows.length ? rows.map(r => `<div class="tc-optrow">
      <button class="tc-ticker-btn" data-ticker="${esc(r.ticker)}">${esc(r.ticker)}</button>
      <span class="tc-code">${esc(r.state)}</span>
      <span>${fmtUsd(r.totalPremiumUsd)} premium · ${r.contracts} contracts</span>
      <span>${esc(r.directionLabel)}${r.unknownShare == null ? '' : ` · ${Math.round(r.unknownShare * 100)}% unknown`}</span>
      <i>${esc(r.stateExplanation)}</i>
      <i>${esc(r.oiConfirmationNote)}</i>
      <i>${esc(r.disclosure)}</i>
    </div>`).join('') : emptyState('No technology options rows', opt.emptyReason)}
  </section>`;
}

// ── 7. Social attention ─────────────────────────────────────────────────────
export function renderSentiment(soc) {
  if (!soc) return '';
  const rows = (soc.rows || []).slice(0, 8);
  return `<section class="tc-board">
    <div class="tc-board-head"><h3 class="tc-h3">📣 Social attention & narrative</h3>
      <span class="tc-src">Attention, NOT sentiment · weight 0 · ${esc(soc.trustNote || `${soc.windowDays}-day archive`)}</span></div>
    <div class="tc-warn">A name absent from a day's trending list has <b>no observation</b> for that day — that is not zero mentions. Trending is never reported as bullish.</div>
    ${rows.length ? rows.map(r => `<div class="tc-optrow">
      <button class="tc-ticker-btn" data-ticker="${esc(r.ticker)}">${esc(r.ticker)}</button>
      <span class="tc-code">${esc(r.state)}</span>
      <span>${r.attentionPresenceDays}/${r.windowDays} days · latest ${r.latestMentions == null ? '—' : r.latestMentions} (peak ${r.peakMentions == null ? '—' : r.peakMentions})</span>
      <span>price 5d ${fmtPct(r.priceChange5d)}</span>
      <i>${esc(r.stateExplanation)}</i>
    </div>`).join('') : emptyState('No technology names in the attention archive', soc.emptyReason)}
  </section>`;
}

// ── 8. Risk map ─────────────────────────────────────────────────────────────
export function renderRisk(risk) {
  if (!risk || risk.empty) return '';
  const c = risk.concentration || {};
  return `<section class="tc-board">
    <div class="tc-board-head"><h3 class="tc-h3">⚖️ Technology risk map</h3>
      <span class="tc-src">${esc(risk.sizingNote || '')}</span></div>
    <div class="tc-kvgrid tc-kvgrid-tight">
      ${kv('Names surfaced', risk.names)}
      ${kv('AI-theme share', c.aiThemePct == null ? '—' : `${c.aiThemePct}%`)}
      ${kv('Semiconductor share', c.semiconductorPct == null ? '—' : `${c.semiconductorPct}%`)}
      ${kv('Mega-cap share', c.megaCapPct == null ? '—' : `${c.megaCapPct}%`)}
      ${kv('Average beta vs QQQ', fmtNum(risk.exposure && risk.exposure.averageBetaVsQqq))}
      ${kv('Rate correlation', fmtNum(risk.exposure && risk.exposure.averageRateCorrelation))}
      ${kv('Longs / shorts', `${risk.exposure ? risk.exposure.longs : '—'} / ${risk.exposure ? risk.exposure.shorts : '—'}`)}
      ${kv('Reporting within 10 sessions', risk.earningsConcentration ? risk.earningsConcentration.count : '—')}
    </div>
    ${(risk.overlapWarnings || []).length ? `<div class="tc-warn"><b>Overlap warnings:</b>${list(risk.overlapWarnings)}</div>` : ''}
    ${expert('Portfolio-wide invalidation', list(risk.portfolioWideInvalidation))}
  </section>`;
}

// ── 9. Data health & disclosures ────────────────────────────────────────────
export function renderHealth(payload) {
  const dh = payload.dataHealth || {};
  const sources = Object.entries(dh.sources || {});
  const d = payload.disclosures || {};
  return `<section class="tc-board" id="tc-health">
    <div class="tc-board-head"><h3 class="tc-h3">🩺 Data health, timestamps & evidence disclosures</h3>
      <span class="tc-src">served from ${esc(payload.servedFrom || 'unknown')}${payload.liteMode ? ' (bounded live build)' : ''}</span></div>
    ${payload.liteNote ? `<div class="tc-warn">${esc(payload.liteNote)}</div>` : ''}
    <div class="tc-kvgrid">${sources.map(([k, v]) =>
    kv(k, `${freshnessBadge(v.state, v.asOf)} <i>${esc(v.note || '')}</i>`)).join('')}</div>
    ${(dh.unavailable || []).length ? `<div class="tc-warn"><b>Not computed on this surface:</b>${list((dh.unavailable || []).map(u => `${u.what} — ${u.why}`))}</div>` : ''}
    ${(payload.warnings || []).length ? expert(`Warnings (${payload.warnings.length})`, list(payload.warnings)) : ''}
    ${expert('Evidence ladder — what each section has earned', `
      <div class="tc-decomp">${(d.evidenceLadder || []).map(l =>
    `<div class="tc-decomp-row"><b>${esc(l.level)}</b><span>${esc(l.meaning)}</span><i>${(l.applies || []).map(esc).join(', ') || 'nothing on this page'}</i></div>`).join('')}</div>
      <p class="tc-note"><b>Probability policy.</b> ${esc(d.probabilityPolicy || '')}</p>
      <p class="tc-note"><b>Alpha claim.</b> ${esc(d.noAlphaClaim || '')}</p>
    `)}
    ${payload.universe ? expert('Technology universe & classification provenance', `
      <div class="tc-kvgrid">
        ${kv('Securities classified', payload.universe.count)}
        ${kv('Basis', esc(payload.universe.basis))}
        ${kv('Taxonomy', esc(payload.universe.taxonomyVersion))}
        ${kv('Overlay', esc(payload.universe.overlayVersion))}
        ${kv('As of', esc(shortTime(payload.universe.universeAsOf)))}
        ${kv('Classified', payload.universe.coverage ? `${payload.universe.coverage.classifiedPct}%` : '—')}
        ${kv('Unclassified', payload.universe.coverage ? payload.universe.coverage.unclassified : '—')}
        ${kv('Overlay-refined', payload.universe.coverage ? payload.universe.coverage.overlayRefined : '—')}
      </div>
      <p class="tc-note">${esc(payload.universe.pointInTimeNote || '')}</p>
      ${(payload.universe.warnings || []).length ? list(payload.universe.warnings) : ''}
    `) : ''}
  </section>`;
}

// ── 10. Dossier ─────────────────────────────────────────────────────────────
export function renderDossier(d) {
  if (!d) return '';
  if (d.found === false) return emptyState('Not in the technology universe', d.reason);
  const stance = (label, s) => `<div class="tc-stance">
    <b>${esc(label)}</b> ${actionPill(s.action)}
    <span>${esc(s.reason || s.whyNow || s.coreThesis || '')}</span></div>`;
  return `<div class="tc-dossier" role="region" aria-label="Dossier for ${esc(d.ticker)}">
    <div class="tc-board-head">
      <h3 class="tc-h3">${esc(d.ticker)}${d.company ? ` — ${esc(d.company)}` : ''}</h3>
      <span class="tc-src">${esc(d.subsectorLabel || '')} · ${esc(d.conclusion || '')}</span>
      <button class="tc-close" data-close-dossier aria-label="Close dossier">✕</button>
    </div>
    ${(d.contradictions || []).length ? `<div class="tc-warn tc-contradict"><b>⚠ Contradictions</b>${list(d.contradictions)}</div>` : ''}
    <div class="tc-stances">
      ${stance('Intraday', d.intraday)}${stance('Swing', d.swing)}${stance('Long term', d.longterm)}
    </div>
    <div class="tc-why"><b>Why it matters now:</b>${list(d.whyItMattersNow)}</div>
    ${d.whatChangedSincePriorSession ? `<div class="tc-why"><b>What changed:</b> ${esc(d.whatChangedSincePriorSession)}</div>` : ''}
    <div class="tc-kvgrid tc-kvgrid-tight">
      ${kv('vs QQQ', fmtPct(d.relativeStrength && d.relativeStrength.vsQqq))}
      ${kv('vs subsector', fmtPct(d.relativeStrength && d.relativeStrength.vsSubsector))}
      ${kv('Subsector rank', d.relativeStrength && d.relativeStrength.subsectorRank ? `${d.relativeStrength.subsectorRank}/${d.relativeStrength.subsectorCount}` : '—')}
      ${kv('Options', d.options ? esc(d.options.state) : '—')}
      ${kv('Attention', d.social ? esc(d.social.state) : '—')}
    </div>
    ${d.scenarios ? `<div class="tc-why"><b>Scenarios:</b> ${['bull', 'base', 'bear'].map(k => `${esc(d.scenarios[k].label)} — ${esc(d.scenarios[k].condition)}`).join(' | ')}
      <i>${esc(d.scenarios.probabilityNote)}</i></div>` : ''}
    <div class="tc-evi">
      <div><b>Supporting evidence</b>${list((d.supportingEvidence || []).map(e => `[${e.horizon}] ${e.label}`))}</div>
      <div><b>Contradicting evidence</b>${list((d.contradictingEvidence || []).map(e => `[${e.horizon}] ${e.label}`))}</div>
    </div>
    ${expert('Invalidation, transitions, maturity and timestamps', `
      <p class="tc-note"><b>Invalidation:</b> ${(d.invalidationConditions || []).map(esc).join(' · ') || 'none recorded'}</p>
      <p class="tc-note"><b>Evidence maturity:</b> ${Object.entries(d.evidenceMaturity || {}).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' · ')}</p>
      <p class="tc-note"><b>Data timestamps:</b> ${Object.entries(d.dataTimestamps || {}).map(([k, v]) => `${esc(k)} ${esc(shortTime(v))}`).join(' · ')}</p>
      <div class="tc-decomp">${(d.stateTransitions || []).slice(0, 12).map(t =>
    `<div class="tc-decomp-row"><span class="tc-code">${esc(t.horizon)}</span><span>${esc(t.from || 'new')} → ${esc(t.to)}</span><i>${esc(shortTime(t.at))}</i><span>${esc(t.rationale || '')}</span></div>`).join('') || '<p class="tc-note">No recorded transitions yet.</p>'}</div>
      <p class="tc-note">${esc(d.probabilityNote || '')}</p>
    `)}
  </div>`;
}

export function skeleton() {
  return `<div class="tc-skel" aria-busy="true" aria-live="polite">
    <p class="tc-note">Loading the Technology Command Center…</p>
    ${Array.from({ length: 4 }, () => '<div class="tc-skel-block"></div>').join('')}
  </div>`;
}

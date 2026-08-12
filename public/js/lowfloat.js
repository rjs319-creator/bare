// LOW-FLOAT IGNITION RADAR · INTRADAY BREAKOUT RADAR · LARGE-MOVER MISS AUDIT ·
// INTRADAY VALIDATION DASHBOARD — the four new frontend sections.
//
// Server-authoritative: this module RENDERS, it never scores. Every state, headline, score,
// blocking reason and "what must happen next" sentence is computed on the server so the
// browser and the ledger can never disagree (a lesson this app has already paid for once with
// a scorer duplicated between server and client).
//
// PRESENTATION RULE, applied everywhere below: the HEADLINE is more prominent than the score.
// A number invites the reader to supply their own interpretation; a sentence does not.

import { esc } from './format.js';
import { fetchJSON, HEAVY_TIMEOUT_MS } from './fetch-json.js';

const STATE = {
  // Default tab is 'all': every scanned candidate renders with its scores and blocking
  // reasons as annotations. Thresholds still decide the OTHER buckets (and actionability),
  // but they no longer decide whether a row exists on first paint.
  lowfloat: { tab: 'all', data: null, spreadOk: new Set() },
  breakout: { data: null, filter: 'all' },
  audit: { data: null, book: null },
  validation: { data: null, tab: 'templates' },
};

const money = v => (Number.isFinite(v) ? `$${v.toFixed(2)}` : '—');
const pct = v => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)}%` : '—');
const num = v => (Number.isFinite(v) ? v.toLocaleString() : '—');
const compact = v => {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return String(Math.round(v));
};
const timeOnly = ts => { try { return new Date(ts).toLocaleTimeString(); } catch { return '—'; } };

// Headline colour keys off the DECISION, not the score — "DO NOT CHASE" on a 90-explosion
// name must read as a warning, not a celebration.
const HEADLINE_CLASS = {
  'LIVE VALIDATED ENTRY': 'lf-hl-live',
  'PAPER ENTRY ONLY': 'lf-hl-paper',
  'READY IF TRIGGERED': 'lf-hl-ready',
  'EARLY IGNITION — WATCH': 'lf-hl-watch',
  'SETUP BUILDING': 'lf-hl-watch',
  'HIGH EXPLOSION — POOR TRADE QUALITY': 'lf-hl-warn',
  'DO NOT CHASE': 'lf-hl-warn',
  'FAILED BREAKOUT': 'lf-hl-bad',
  'DISTRIBUTION RISK': 'lf-hl-bad',
  'EXHAUSTED — NO NEW ENTRY': 'lf-hl-bad',
  'AVOID': 'lf-hl-bad',
  'NO TRADE — STALE DATA': 'lf-hl-dead',
  'NO TRADE — SPREAD NOT VERIFIED': 'lf-hl-dead',
  'TOO LATE — MANAGE ONLY': 'lf-hl-dead',
  'WATCH ONLY': 'lf-hl-watch',
};

const FLOAT_LABEL = {
  ULTRA_LOW: 'Ultra-low float', LOW: 'Low float', MODERATELY_LOW: 'Moderately low float',
  SMALL_SUPPLY: 'Small supply', NORMAL: 'Normal float', UNKNOWN: 'Float unknown',
};

// ── Shared furniture ─────────────────────────────────────────────────────────
function spinner(msg) {
  return `<div class="mom-status"><div class="mom-spinner"></div><p>${esc(msg)}</p></div>`;
}
function errorBox(msg) {
  return `<div class="mom-status error"><p>${esc(msg)}</p></div>`;
}

// The limitations block. Rendered on every one of these sections, collapsed by default but
// never omitted — these are the reasons the numbers above cannot mean more than they do.
function limitationsBlock(payload) {
  const lim = (payload && payload.limitations) || [];
  if (!lim.length) return '';
  return `<details class="lf-limits"><summary>⚠️ Data limitations that apply to everything on this page (${lim.length})</summary>
    <ul>${lim.map(l => `<li>${esc(l)}</li>`).join('')}</ul></details>`;
}

function coverageBlock(cov) {
  if (!cov) return '';
  const row = (label, value, note) => `<div class="lf-cov-row"><span>${esc(label)}</span><b>${esc(String(value ?? '—'))}</b>${note ? `<i>${esc(note)}</i>` : ''}</div>`;
  return `<details class="lf-coverage"><summary>📊 Coverage &amp; runtime for this scan</summary><div class="lf-cov-grid">
    ${row('Eligible universe', num(cov.universeSize))}
    ${row('Bulk quotes received', num(cov.bulkQuotesReceived), cov.quoteProvider ? `via ${cov.quoteProvider}` : '')}
    ${row('Volume available', cov.volumeAvailable === false ? 'NO — recall reduced' : 'yes')}
    ${row('Candidates discovered', num(cov.candidatesDiscovered))}
    ${row('Enriched with float', num(cov.floatEnriched), cov.floatCoveragePct != null ? `${cov.floatCoveragePct}% of requested` : '')}
    ${row('Float unavailable', num(cov.floatMissing), 'these stay UNKNOWN — never treated as low float')}
    ${row('Enriched with 5-min bars', num(cov.intradayEnriched), cov.intradayFailures ? `${cov.intradayFailures} failed` : '')}
    ${row('Stale candidates', num(cov.staleCandidates))}
    ${row('Endpoint runtime', cov.elapsedMs != null ? `${cov.elapsedMs} ms` : '—')}
    ${row('Partial results', cov.partialResults ? 'YES — the deadline cut some enrichment' : 'no')}
  </div>
  ${cov.floatNote ? `<p class="lf-cov-note">${esc(cov.floatNote)}</p>` : ''}
  ${cov.discoveryLaneCounts ? `<p class="lf-cov-note">Discovery lanes: ${Object.entries(cov.discoveryLaneCounts).map(([k, v]) => `${esc(k)} ${v}`).join(' · ')}</p>` : ''}
  ${cov.universeCoverage ? `<p class="lf-cov-note">${esc(cov.universeCoverage.coverageCaveat || '')} Exclusions: ${Object.entries(cov.universeCoverage.exclusionsByReason || {}).map(([k, v]) => `${esc(k)} ${v}`).join(' · ') || 'none'}.</p>` : ''}
  </details>`;
}

// ══════════════════════════════════════════════════════════════════════════════
// LOW-FLOAT IGNITION RADAR
// ══════════════════════════════════════════════════════════════════════════════
export async function loadLowFloat(container) {
  if (!container) return;
  container.innerHTML = spinner('Scanning the full eligible universe for low-float ignition…');
  try {
    const ok = [...STATE.lowfloat.spreadOk];
    const url = `/api/tracker?op=lowfloat${ok.length ? `&spreadok=${encodeURIComponent(ok.join(','))}` : ''}`;
    const data = await fetchJSON(url, { timeoutMs: HEAVY_TIMEOUT_MS });
    STATE.lowfloat.data = data;
    renderLowFloat(container);
  } catch {
    container.innerHTML = errorBox('Could not load the Low-Float Ignition Radar.');
  }
}

const LF_TABS = [
  ['all', 'All'],
  ['potentialMovers', 'Potential Movers'],
  ['readyWatching', 'Ready / Watching'],
  ['tooExtended', 'Too Extended'],
  ['avoid', 'Avoid'],
];

function renderLowFloat(container) {
  const d = STATE.lowfloat.data;
  if (!d) return;
  if (!d.ok) { container.innerHTML = errorBox(d.error || 'The radar is unavailable right now.') + limitationsBlock(d); return; }
  if (d.disabled) { container.innerHTML = `<div class="lf-empty">${esc(d.disabled)}</div>` + limitationsBlock(d); return; }

  const buckets = d.buckets || {};
  const active = STATE.lowfloat.tab;
  const cards = buckets[active] || [];
  const c = d.counts || {};

  const banner = `<div class="lf-banner">
    <b>Explosion potential and trade quality are scored separately.</b> A stock can be very likely to keep
    moving and still be a bad entry — those are different questions and this page answers them independently.
    <div class="lf-banner-sub">
      Session: <b>${esc((d.session && d.session.session) || '—')}</b> ·
      ${Number.isFinite(d.session && d.session.minutesUntilClose) ? `${d.session.minutesUntilClose} min to close · ` : ''}
      Regime: <b>${esc(d.regime || '—')}</b> ·
      ${c.total || 0} candidates · ${c.highExplosion || 0} high-explosion ·
      <b>${c.paperEligible || 0} paper-eligible</b> · ${c.liveValidated || 0} live-validated
    </div>
    <div class="lf-strong-note">⚠️ Strong mover does not necessarily mean an appropriate entry.</div>
  </div>`;

  const tabs = `<div class="lf-tabs">${LF_TABS.map(([k, label]) =>
    `<button class="lf-tab${active === k ? ' lf-tab-on' : ''}" data-lftab="${k}">${esc(label)} <span>${(buckets[k] || []).length}</span></button>`).join('')}</div>`;

  const body = cards.length
    ? `<div class="lf-cards">${cards.map(lowFloatCard).join('')}</div>`
    : `<div class="lf-empty">${esc(d.emptyMessage || 'Nothing in this bucket right now.')}
        <div class="lf-empty-sub">The system is allowed to show nothing. Thresholds are never lowered to populate the screen.</div></div>`;

  container.innerHTML = banner + tabs + body + coverageBlock(d.coverage) + limitationsBlock(d);
  wireLowFloat(container);
}

function lowFloatCard(x) {
  const hl = x.headline || 'WATCH ONLY';
  const cls = HEADLINE_CLASS[hl] || 'lf-hl-watch';
  const reasons = (x.reasonCodes || []).slice(0, 3);
  const warns = (x.warnings || []).slice(0, 4);
  const blocks = (x.blockingReasons || []).slice(0, 4);

  // The two scores are shown SIDE BY SIDE and never combined. Combining them is exactly the
  // conflation this redesign exists to undo.
  const scores = `<div class="lf-scores">
    <div class="lf-score lf-score-exp"><span>Explosion potential</span><b>${x.explosionPotentialScore ?? '—'}</b>
      <i>${esc(topFamilies(x.explosionFamilies))}</i></div>
    <div class="lf-score lf-score-q"><span>Trade quality</span><b>${x.tradeQualityScore ?? '—'}</b>
      <i>${esc(topFamilies(x.tradeQualityFamilies))}</i></div>
  </div>`;

  const floatLine = `<div class="lf-float">
    <span title="Actual publicly tradable shares — never market capitalization">
      ${esc(FLOAT_LABEL[x.floatTier] || x.floatTier || 'Float unknown')}
      ${Number.isFinite(x.floatShares) ? `· ${compact(x.floatShares)} sh` : ''}
    </span>
    <span class="lf-conf lf-conf-${esc(String(x.floatConfidence || 'LOW').toLowerCase())}">${esc(x.floatConfidence || 'LOW')} confidence</span>
    ${Number.isFinite(x.floatTurnover) ? `<span>${(x.floatTurnover * 100).toFixed(0)}% of float traded today</span>` : '<span class="lf-dim">float turnover unavailable</span>'}
  </div>`;

  const plan = `<div class="lf-plan">
    <div><span>Trigger</span><b>${money(x.trigger)}</b></div>
    <div><span>Entry zone</span><b>${money(x.entryZoneLow)}–${money(x.entryZoneHigh)}</b></div>
    <div class="lf-plan-chase"><span>Max chase</span><b>${money(x.maximumChasePrice)}</b></div>
    <div><span>Invalidation</span><b>${money(x.invalidation)}</b></div>
    <div><span>Targets</span><b>${money(x.target1)} / ${money(x.target2)}</b></div>
    <div><span>R:R</span><b>${Number.isFinite(x.riskReward) ? `${x.riskReward}:1` : '—'}</b></div>
  </div>`;

  const spreadCtl = x.manualSpreadCheckRequired
    ? `<label class="lf-spread"><input type="checkbox" data-spreadok="${esc(x.ticker)}"${x.spreadConfirmed ? ' checked' : ''}>
        I verified the current spread and liquidity</label>`
    : '';

  return `<article class="lf-card${x.stale ? ' lf-card-stale' : ''}" data-ticker="${esc(x.ticker)}">
    <div class="lf-headline ${cls}">${esc(hl)}</div>
    <header class="lf-head">
      <div class="lf-tick"><b>${esc(x.ticker)}</b> <span>${esc(x.company || '')}</span></div>
      <div class="lf-price">${money(x.price)} <span class="${(x.dayChangePct || 0) >= 0 ? 'lf-up' : 'lf-down'}">${pct(x.dayChangePct)}</span></div>
    </header>
    ${floatLine}
    ${scores}
    <div class="lf-metrics">
      <span>5-min vol accel <b>${Number.isFinite(x.fiveMinVolumeAcceleration) ? `${x.fiveMinVolumeAcceleration}×` : '—'}</b></span>
      <span>Session $vol <b>${compact(x.currentSessionDollarVolume)}</b></span>
      <span>RVOL <b>${Number.isFinite(x.relativeVolume) ? `${x.relativeVolume}×` : '—'}</b></span>
      <span>Catalyst <b>${esc(x.catalyst || 'none found')}</b>${Number.isFinite(x.catalystFreshnessMinutes) ? ` <i>${x.catalystFreshnessMinutes}m ago</i>` : ''}</span>
      <span>Dilution risk <b class="lf-dil-${esc(String(x.dilutionRisk || 'UNKNOWN').toLowerCase())}">${esc(x.dilutionRisk || 'UNKNOWN')}</b></span>
      <span>Structure <b>${esc(x.structureState || '—')}</b></span>
      <span>Time left <b>${Number.isFinite(x.minutesUntilClose) ? `${x.minutesUntilClose}m` : '—'}</b></span>
      <span>Data <b>${x.lastCompletedBarAt ? timeOnly(x.lastCompletedBarAt) : '—'}</b> <i>${x.barResolutionMinutes || 5}-min bars</i></span>
    </div>
    ${plan}
    <div class="lf-next"><b>What must happen next:</b> ${esc(x.whatMustHappenNext || '')}</div>
    ${reasons.length ? `<div class="lf-reasons">${reasons.map(r => `<span class="lf-chip">${esc(r)}</span>`).join('')}</div>` : ''}
    ${blocks.length ? `<div class="lf-blocks"><b>Blocked:</b> ${blocks.map(r => `<span class="lf-chip lf-chip-bad">${esc(r)}</span>`).join('')}</div>` : ''}
    ${warns.length ? `<div class="lf-warns"><b>Warnings:</b> ${warns.map(r => `<span class="lf-chip lf-chip-warn">${esc(r)}</span>`).join('')}</div>` : ''}
    ${spreadCtl}
    <details class="lf-check"><summary>Entry checklist (${(x.checklist || []).filter(i => i.pass).length}/${(x.checklist || []).length} met)</summary>
      <ul>${(x.checklist || []).map(i => `<li class="${i.pass ? 'lf-ok' : i.unknown ? 'lf-unk' : 'lf-no'}">
        ${i.pass ? '✓' : i.unknown ? '?' : '✗'} ${esc(i.label)}${i.detail ? ` <i>— ${esc(String(i.detail))}</i>` : ''}</li>`).join('')}</ul>
    </details>
    <footer class="lf-foot">
      Found by ${esc((x.discoverySources || []).join(', ') || '—')}
      ${x.firstDetectedAt ? ` · first seen ${timeOnly(x.firstDetectedAt)} at ${money(x.priceAtFirstDetection)}` : ''}
      · template ${esc(x.entryTemplate || 'none')} (${esc(x.templatePromotionState || 'UNVALIDATED')})
    </footer>
  </article>`;
}

// Name the two biggest contributing families so a score is explainable at a glance.
function topFamilies(fams) {
  if (!fams) return '';
  return Object.entries(fams).sort((a, b) => b[1] - a[1]).slice(0, 2)
    .filter(([, v]) => v > 0).map(([k, v]) => `${k.toLowerCase().replace(/_/g, ' ')} ${v}`).join(' · ');
}

function wireLowFloat(container) {
  container.querySelectorAll('[data-lftab]').forEach(b => b.addEventListener('click', () => {
    STATE.lowfloat.tab = b.getAttribute('data-lftab');
    renderLowFloat(container);
  }));
  container.querySelectorAll('[data-spreadok]').forEach(cb => cb.addEventListener('change', () => {
    const t = cb.getAttribute('data-spreadok');
    if (cb.checked) STATE.lowfloat.spreadOk.add(t); else STATE.lowfloat.spreadOk.delete(t);
    // Re-request: the spread attestation is a GATE INPUT evaluated on the server, so the
    // client cannot simply unlock the card locally.
    loadLowFloat(container);
  }));
}

// ══════════════════════════════════════════════════════════════════════════════
// INTRADAY BREAKOUT RADAR
// ══════════════════════════════════════════════════════════════════════════════
export async function loadBreakoutRadar(container) {
  if (!container) return;
  container.innerHTML = spinner('Reading five-minute structure across today’s movers…');
  try {
    const data = await fetchJSON('/api/tracker?op=intradaycontinuation', { timeoutMs: HEAVY_TIMEOUT_MS });
    STATE.breakout.data = data;
    renderBreakout(container);
  } catch {
    container.innerHTML = errorBox('Could not load the Intraday Breakout Radar.');
  }
}

const STATE_ORDER = [
  'BREAKOUT_CONFIRMED', 'BREAKOUT_RETEST', 'BREAKOUT_PENDING', 'COMPRESSION',
  'CONSTRUCTIVE_PULLBACK', 'EARLY_IGNITION', 'BREAKOUT_ATTEMPT', 'WATCH',
  'FAILED_BREAKOUT', 'DISTRIBUTION', 'EXHAUSTED', 'STALE_DATA',
];
const STATE_BLURB = {
  BREAKOUT_CONFIRMED: 'A completed five-minute bar closed above the prior level, on volume, in the upper half of its range.',
  BREAKOUT_RETEST: 'The level was broken, price came back to it on contracting volume, and it held.',
  BREAKOUT_PENDING: 'Coiled at the level with the structure to break it. No entry until a completed close above.',
  COMPRESSION: 'Range contracting — a release precursor, not yet a trigger.',
  CONSTRUCTIVE_PULLBACK: 'An orderly dip holding VWAP/EMA structure on lighter volume.',
  EARLY_IGNITION: 'Participation and price accelerating, but no tradeable structure has formed. Watch only.',
  BREAKOUT_ATTEMPT: 'The FORMING candle is above the level. This is not confirmation and can never become one until the bar closes.',
  WATCH: 'No qualifying structure.',
  FAILED_BREAKOUT: 'Traded above the level and closed back under it. New entries blocked.',
  DISTRIBUTION: 'Drawdown from the high with lower highs and weak participation.',
  EXHAUSTED: 'Parabolic extension and/or a volume climax. The move is likely made.',
  STALE_DATA: 'The data is not current enough to decide anything.',
};

function renderBreakout(container) {
  const d = STATE.breakout.data;
  if (!d) return;
  if (!d.ok) { container.innerHTML = errorBox(d.error || 'Unavailable.') + limitationsBlock(d); return; }

  const by = d.byStructureState || {};
  const total = (d.cards || []).length;
  const banner = `<div class="lf-banner">
    <b>Five-minute structure, separated into states.</b> Early ignition, orderly continuation, failed
    breakouts, distribution and exhaustion look identical on a daily bar and completely different here.
    <div class="lf-banner-sub">${total} names with analyzable current-session structure ·
      confirmations use COMPLETED bars only — a forming candle can never confirm a breakout.</div>
  </div>`;

  const groups = STATE_ORDER.filter(s => (by[s] || []).length).map(s => `
    <section class="lf-group lf-group-${esc(s.toLowerCase())}">
      <h3>${esc(s.replace(/_/g, ' '))} <span>${(by[s] || []).length}</span></h3>
      <p class="lf-group-blurb">${esc(STATE_BLURB[s] || '')}</p>
      <div class="lf-rows">${(by[s] || []).map(breakoutRow).join('')}</div>
    </section>`).join('');

  container.innerHTML = banner
    + (groups || `<div class="lf-empty">${esc(d.emptyMessage || 'No analyzable structure right now.')}</div>`)
    + coverageBlock(d.coverage) + limitationsBlock(d);
}

function breakoutRow(x) {
  return `<div class="lf-row" data-ticker="${esc(x.ticker)}">
    <span class="lf-row-t"><b>${esc(x.ticker)}</b> ${money(x.price)} <i class="${(x.dayChangePct || 0) >= 0 ? 'lf-up' : 'lf-down'}">${pct(x.dayChangePct)}</i></span>
    <span>cont <b>${x.continuationScore ?? '—'}</b></span>
    <span>remaining edge <b>${x.remainingEdgeScore ?? '—'}</b></span>
    <span>trigger <b>${money(x.trigger)}</b></span>
    <span>max chase <b>${money(x.maximumChasePrice)}</b></span>
    <span>R:R <b>${Number.isFinite(x.riskReward) ? `${x.riskReward}:1` : '—'}</b></span>
    <span class="lf-row-state">${esc(x.setupEntryClassification || '')}</span>
    <span class="lf-row-action ${esc(HEADLINE_CLASS[x.headline] || '')}">${esc(x.headline || x.actionState || '')}</span>
    <span class="lf-row-next">${esc(x.whatMustHappenNext || '')}</span>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════════════
// LARGE-MOVER MISS AUDIT
// ══════════════════════════════════════════════════════════════════════════════
export async function loadMoverAudit(container) {
  if (!container) return;
  container.innerHTML = spinner('Auditing the day’s largest movers against our own pipeline…');
  try {
    const [audit, book] = await Promise.all([
      fetchJSON('/api/tracker?op=largemoveraudit', { timeoutMs: HEAVY_TIMEOUT_MS }).catch(() => null),
      fetchJSON('/api/tracker?op=largemoverbook', { timeoutMs: HEAVY_TIMEOUT_MS }).catch(() => null),
    ]);
    STATE.audit = { data: audit, book };
    renderAudit(container);
  } catch {
    container.innerHTML = errorBox('Could not load the Large-Mover Miss Audit.');
  }
}

function renderAudit(container) {
  const d = STATE.audit.data;
  const book = STATE.audit.book;
  if (!d) { container.innerHTML = errorBox('Unavailable.'); return; }
  if (!d.ok) { container.innerHTML = errorBox(d.error || 'Unavailable.') + limitationsBlock(d); return; }
  if (d.disabled) { container.innerHTML = `<div class="lf-empty">${esc(d.disabled)}</div>`; return; }

  const r = d.recall || {};
  const hist = d.missHistogram || {};
  const labels = (book && book.categoryLabels) || {};

  const banner = `<div class="lf-banner">
    <b>Where the day's biggest movers fell out of our pipeline.</b> This is the report that makes
    "improve recall" a measurable task instead of a guess: every mover we missed carries the specific
    stage and reason we lost it.
    <div class="lf-banner-sub">${d.sessionDate || d.date || ''} · ${r.totalMoversAudited || 0} movers audited ·
      <b>${r.overallRecallPct ?? '—'}% discovered</b> · ${r.producedEntryEvents || 0} produced an entry event</div>
  </div>`;

  const metrics = `<div class="lf-metric-grid">
    ${metricTile('Top-10 open→high recall', r.recallOfTop10OpenToHighMovers, '%')}
    ${metricTile('Top-20 open→high recall', r.recallOfTop20OpenToHighMovers, '%')}
    ${metricTile('Top-20 30-min recall', r.recallOfTop20ThirtyMinuteMovers, '%')}
    ${metricTile('Top-20 60-min recall', r.recallOfTop20SixtyMinuteMovers, '%')}
    ${metricTile('Found before +10%', r.recallBefore10PctMove, '%')}
    ${metricTile('Found before +20%', r.recallBefore20PctMove, '%')}
    ${metricTile('Found before half the move', r.recallBeforeHalfOfFinalMove, '%')}
    ${metricTile('Median gain left after detection', r.medianGainRemainingAfterFirstDetection, '%')}
    ${metricTile('Median rank of real top movers', r.medianDiscoveryRankOfActualTopMovers, '')}
  </div>`;

  const histRows = Object.entries(hist).sort((a, b) => b[1] - a[1]);
  const histBlock = histRows.length ? `<div class="lf-hist">
    <h3>Why we missed them</h3>
    ${histRows.map(([k, v]) => {
      const w = Math.round((v / histRows[0][1]) * 100);
      return `<div class="lf-hist-row"><span>${esc(labels[k] || k)}</span>
        <div class="lf-hist-bar"><i style="width:${w}%"></i></div><b>${v}</b></div>`;
    }).join('')}
    ${book && book.largestSingleCauseOfMisses ? `<p class="lf-cov-note">Across ${book.sessions} logged sessions the single largest cause of misses is
      <b>${esc(labels[book.largestSingleCauseOfMisses] || book.largestSingleCauseOfMisses)}</b>. That is the filter to re-examine first.</p>` : ''}
  </div>` : '';

  const coverageTables = `<div class="lf-cov2">
    ${bucketTable('Coverage by float tier', r.coverageByFloatTier)}
    ${bucketTable('Coverage by price band', r.coverageByPriceBand)}
  </div>`;

  const rows = (d.records || []).slice(0, 40).map(m => `<tr class="${m.discovered ? '' : 'lf-miss'}">
    <td><b>${esc(m.ticker)}</b></td>
    <td>${money(m.sessionOpen)}→${money(m.sessionHigh)}</td>
    <td class="lf-up">${pct(m.openToHighPct)}</td>
    <td>${pct(m.max30mReturn)}</td>
    <td>${esc(m.floatTier || 'UNKNOWN')}</td>
    <td>${m.discovered ? '✓' : '✗'}</td>
    <td>${m.firstDiscoveryTimestamp ? timeOnly(m.firstDiscoveryTimestamp) : '—'}</td>
    <td>${Number.isFinite(m.gainAtFirstDiscovery) ? pct(m.gainAtFirstDiscovery) : '—'}</td>
    <td>${Number.isFinite(m.eventualGainAfterDiscovery) ? pct(m.eventualGainAfterDiscovery) : '—'}</td>
    <td>${m.discoveryRank ?? '—'}</td>
    <td>${esc(m.pipelineStageReached || '')}</td>
    <td>${esc(m.missCategory ? (labels[m.missCategory] || m.missCategory) : '—')}</td>
    <td class="lf-why">${esc((m.rejectionReasons || []).join('; '))}</td>
  </tr>`).join('');

  const table = `<div class="lf-table-wrap"><table class="lf-table">
    <thead><tr><th>Ticker</th><th>Open→High</th><th>%</th><th>Max 30m</th><th>Float</th>
      <th>Found</th><th>When</th><th>Gain then</th><th>Left after</th><th>Rank</th>
      <th>Stage reached</th><th>Miss category</th><th>Why</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;

  container.innerHTML = banner + metrics + histBlock + coverageTables + table + limitationsBlock(d);
}

function metricTile(label, value, unit) {
  return `<div class="lf-tile"><span>${esc(label)}</span><b>${Number.isFinite(value) ? `${value}${unit}` : '—'}</b></div>`;
}

function bucketTable(title, buckets) {
  if (!buckets) return '';
  return `<div class="lf-bucket"><h4>${esc(title)}</h4>
    <table><tbody>${Object.entries(buckets).map(([k, v]) =>
      `<tr><td>${esc(k)}</td><td>${v.discovered}/${v.total}</td><td><b>${v.recallPct ?? '—'}%</b></td></tr>`).join('')}</tbody></table></div>`;
}

// ══════════════════════════════════════════════════════════════════════════════
// INTRADAY VALIDATION DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════
export async function loadIntradayValidation(container) {
  if (!container) return;
  container.innerHTML = spinner('Reading the forward record for every entry template…');
  try {
    const data = await fetchJSON('/api/tracker?op=intradayvalidation', { timeoutMs: HEAVY_TIMEOUT_MS });
    STATE.validation.data = data;
    renderValidation(container);
  } catch {
    container.innerHTML = errorBox('Could not load the Validation Dashboard.');
  }
}

const PROMO_CLASS = {
  LIVE_VALIDATED: 'lf-promo-live', PAPER_PROMISING: 'lf-promo-paper',
  INSUFFICIENT_SAMPLE: 'lf-promo-thin', FAILED: 'lf-promo-failed', UNVALIDATED: 'lf-promo-none',
};

function renderValidation(container) {
  const d = STATE.validation.data;
  if (!d) return;
  if (!d.ok) { container.innerHTML = errorBox(d.error || 'Unavailable.') + limitationsBlock(d); return; }

  const banner = `<div class="lf-banner">
    <b>Every entry template is measured separately and never pooled.</b> A confirmed-breakout record tells
    you nothing about an early-ignition continuation, so they are never averaged together.
    <div class="lf-banner-sub">${d.resolvedEvents || 0} resolved events across ${d.datesWithOutcomes || 0} sessions ·
      outcomes measured from the simulated fill at the first bar AFTER the signal became visible, never from
      the prior close, the open, or a candle low.</div>
    ${!d.durableStore ? '<div class="lf-strong-note">⚠️ Blob storage is not configured — nothing is being logged, so no forward record can accrue.</div>' : ''}
  </div>`;

  const t = d.byTemplate || {};
  const cards = Object.entries(t).map(([name, v]) => {
    const s = v.stats || {};
    const p = v.promotion || {};
    const b = v.baselineComparison || {};
    const dr = v.drift || {};
    return `<section class="lf-tmpl">
      <header><h3>${esc(name.replace(/_/g, ' '))}</h3>
        <span class="lf-promo ${PROMO_CLASS[p.promotionState] || ''}">${esc(p.promotionState || 'UNVALIDATED')}</span></header>
      <p class="lf-tmpl-reason">${esc(p.reason || '')}</p>
      <div class="lf-tmpl-metrics">
        ${metricTile('Resolved events', s.n, '')}
        ${metricTile('Out-of-sample', s.outOfSampleN, '')}
        ${metricTile('Target before stop', s.targetBeforeStopRate != null ? +(s.targetBeforeStopRate * 100).toFixed(1) : null, '%')}
        ${metricTile('Wilson lower bound', s.targetBeforeStopWilsonLo != null ? +(s.targetBeforeStopWilsonLo * 100).toFixed(1) : null, '%')}
        ${metricTile('Expectancy', s.expectancyR, 'R')}
        ${metricTile('Baseline edge', b.edge != null ? +(b.edge * 100).toFixed(1) : null, 'pts')}
        ${metricTile('Same-bar ambiguous', s.sameBarAmbiguousShare, '%')}
      </div>
      ${(p.criteria || []).length ? `<details class="lf-crit"><summary>Promotion criteria (${(p.criteria || []).filter(c => c.pass).length}/${(p.criteria || []).length} met)</summary>
        <ul>${(p.criteria || []).map(c => `<li class="${c.pass ? 'lf-ok' : 'lf-no'}">${c.pass ? '✓' : '✗'} ${esc(c.key)} <i>— ${esc(String(c.detail || ''))}</i></li>`).join('')}</ul></details>` : ''}
      ${(s.byTimeBlock || []).length ? `<details class="lf-crit"><summary>Stability by time block</summary>
        <table class="lf-table"><thead><tr><th>Block</th><th>n</th><th>Target-before-stop</th><th>Expectancy</th></tr></thead>
        <tbody>${s.byTimeBlock.map(x => `<tr><td>${esc(x.block)}</td><td>${x.n}</td><td>${x.targetBeforeStopRate != null ? `${(x.targetBeforeStopRate * 100).toFixed(0)}%` : '—'}</td><td>${x.expectancyR ?? '—'}R</td></tr>`).join('')}</tbody></table></details>` : ''}
      <div class="lf-drift">Drift: <b>${esc(dr.status || 'UNKNOWN')}</b>${(dr.reasons || []).length ? ` — ${esc(dr.reasons.join('; '))}` : ''}
        ${dr.demote ? ' <span class="lf-chip lf-chip-bad">AUTO-DEMOTED</span>' : ''}</div>
    </section>`;
  }).join('');

  container.innerHTML = banner + `<div class="lf-tmpls">${cards}</div>`
    + `<div class="lf-cov-note">${esc(d.note || '')}</div>` + limitationsBlock(d);
}

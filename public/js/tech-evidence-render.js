// 🧾 TECH OPERATIONAL EVIDENCE — section renderers (pure; no fetching, no state).
// Renders the op=techev payload inside the Technology Command Center page.
// Contract: every upstream string passes esc(); numbers are validated before display;
// empty/error/stale states always carry a visible reason — a blank panel is never
// presented as "no operational change anywhere".
import { esc } from './format.js';

const pct = (v, digits = 2) => (Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : '—');
const num = (v, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits) : '—');
const dt = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET';
};

const STATE_META = {
  COLLECTING: ['⏳', 'collecting'],
  INSUFFICIENT_DATA: ['⛔', 'insufficient data'],
  NULL: ['∅', 'null result'],
  PROMISING_RESEARCH: ['🧪', 'promising research'],
  VALIDATED: ['✅', 'validated'],
};

function statePill(stateName) {
  const [glyph, label] = STATE_META[stateName] || ['❔', String(stateName || 'unknown').toLowerCase()];
  return `<span class="tc-chip" role="status" aria-label="Research status: ${esc(label)}">${glyph} ${esc(label)}</span>`;
}

function qualityChip(q) {
  const label = q === 'ok' ? 'quality ok' : q === 'degraded' ? 'quality degraded' : q === 'low' ? 'quality low' : 'unavailable';
  return `<span class="tc-chip">${esc(label)}</span>`;
}

// ── health + coverage strip ─────────────────────────────────────────────────
function healthStrip(p) {
  const h = p.health || {};
  const sources = Object.entries(h.sources || {});
  // Disjoint buckets: a partial success (delivered data despite an error) is degraded,
  // never counted as an outright failure with zero freshness.
  const notConfigured = sources.filter(([, s]) => s && s.configured === false).length;
  const healthy = sources.filter(([, s]) => s && s.configured !== false && s.lastSuccessAt && !s.lastError).length;
  const degraded = sources.filter(([, s]) => s && s.configured !== false && s.lastSuccessAt && s.lastError).length;
  const failing = sources.filter(([, s]) => s && s.configured !== false && !s.lastSuccessAt && s.lastError).length;
  const fw = p.forward || {};
  const cells = [
    ['Last collection', h.updatedAt ? dt(h.updatedAt) : 'never'],
    ['Verified mappings', `${p.coverage ? p.coverage.verifiedMappings : 0} (${p.coverage ? p.coverage.verifiedTickers.length : 0} tickers)`],
    ['Sources healthy / degraded / failing / unconfigured', `${healthy} / ${degraded} / ${failing} / ${notConfigured}`],
    ['Eligible forward events', String(fw.eligibleEvents ?? 0)],
    ['Resolved events', String(fw.resolvedEvents ?? 0)],
  ];
  return `<div class="tc-kvgrid">${cells.map(([k, v]) => `<div><span class="tc-note">${esc(k)}</span><br><b>${esc(v)}</b></div>`).join('')}</div>
  ${h.note ? `<p class="tc-note">${esc(h.note)}</p>` : ''}`;
}

function sourceHealthDetail(p) {
  const rows = Object.entries((p.health && p.health.sources) || {});
  if (!rows.length) return '<p class="tc-note">No source health recorded yet — collection has not run.</p>';
  return `<div class="tc-scroll"><table class="tc-table"><thead><tr><th>Source</th><th>Last success</th><th>Fresh obs</th><th>State</th></tr></thead><tbody>
    ${rows.map(([name, s]) => `<tr><td>${esc(name)}</td><td>${esc(s.lastSuccessAt ? dt(s.lastSuccessAt) : '—')}</td><td>${esc(String(s.freshObservations ?? '—'))}</td>
      <td>${s.configured === false ? 'no verified mappings' : s.lastError ? `<span class="tc-warn">${esc(String(s.lastError).slice(0, 90))}</span>` : s.rateLimited ? 'rate limited' : s.lastSuccessAt ? 'ok' : 'pending'}</td></tr>`).join('')}
  </tbody></table></div>`;
}

// ── evidence cards ──────────────────────────────────────────────────────────
function signalCard(s, mappingById) {
  const m = s.mappingId ? mappingById.get(s.mappingId) : null;
  const revenueLine = m ? m.revenueConnection : 'Company-level SEC filing evidence tied to the verified CIK.';
  const provenance = m ? `${m.product} — ${m.sourceUrl}` : `SEC Company Facts, CIK ${s.entity}`;
  const why = s.direction === 'positive'
    ? 'Adoption/activity ran ahead of this company\'s own baseline after peer adjustment — operating momentum can precede reported results.'
    : 'Activity ran behind the company\'s own baseline after peer adjustment — a possible early operating soft patch.';
  const noise = 'Single-product proxy; bot traffic, CI pipelines, mirrors, version churn or a seasonal quirk can move it without any revenue meaning.';
  return `<article class="tc-card">
    <header><button type="button" class="tc-ticker-btn" data-ticker="${esc(s.ticker)}">${esc(s.ticker)}</button>
      <span class="tc-chip">${esc(s.arm)}</span>
      ${qualityChip(s.quality)}
      ${s.eligible ? '<span class="tc-chip">forward-ledger event</span>' : ''}
      ${Number.isFinite(s.attention) ? `<span class="tc-chip" title="Sort order only — abnormality × freshness × mapping quality. Not expected return, not conviction, not validated alpha.">attention ${esc(String(s.attention))}</span>` : ''}
    </header>
    <p><b>${esc(s.metricLabel || 'operational measure')}</b> — cutoff ${esc(s.cutoffDate)}</p>
    <div class="tc-kvgrid">
      <div><span class="tc-note">recent</span><br><b>${s.arm === 'github' ? esc(num(s.recentGrowth, 0)) : esc(pct(s.recentGrowth))}</b></div>
      <div><span class="tc-note">own baseline</span><br><b>${s.arm === 'github' ? esc(num(s.ownExpected, 1)) : esc(pct(s.ownExpected))}</b></div>
      <div><span class="tc-note">surprise</span><br><b>${s.arm === 'github' ? esc(num(s.surprise, 1)) : esc(pct(s.surprise))}</b></div>
      <div><span class="tc-note">robust z</span><br><b>${esc(num(s.z))}</b></div>
      <div><span class="tc-note">peer-adjusted</span><br><b>${s.peerMedianSurprise == null ? 'n/a' : (s.arm === 'github' ? esc(num(s.adjustedSurprise, 1)) : esc(pct(s.adjustedSurprise)))}</b></div>
    </div>
    <p class="tc-note">${esc(revenueLine)}</p>
    <details class="tc-expert"><summary>Provenance, timestamps &amp; caveats</summary>
      <p class="tc-code">${esc(provenance)}</p>
      <p class="tc-note">windows: ${esc(JSON.stringify(s.windows || {}))} · signal id ${esc(s.id)} · mapping ${esc(s.mappingId || 'company-level')} v${esc(String(s.mappingVersion ?? '—'))}</p>
      <p class="tc-note">Why it may matter: ${esc(why)}</p>
      <p class="tc-note">Why it may be noise: ${esc(noise)}</p>
      ${(s.caveats || []).map((c) => `<p class="tc-note">⚠ ${esc(c)}</p>`).join('')}
      <p class="tc-note">${esc(s.eligibleReason || '')}</p>
    </details>
  </article>`;
}

export function renderTechEvidenceSignals(p, prefs = {}) {
  const items = (p.signals && p.signals.items) || [];
  const filtered = items.filter((s) => {
    if (prefs.evArm && prefs.evArm !== 'all' && s.arm !== prefs.evArm) return false;
    if (prefs.evShow === 'eligible' && !s.eligible) return false;
    if (prefs.evShow === 'available' && !s.available) return false;
    return true;
  });
  const mappingById = new Map((p.mappingsPublic || []).map((m) => [m.mappingId, m]));
  const available = filtered.filter((s) => s.available);
  const unavailable = filtered.filter((s) => !s.available);
  const sorted = [...available].sort((a, b) => (b.attention ?? -1) - (a.attention ?? -1));
  if (!items.length) {
    return `<div class="tc-empty">No derived signals yet. ${esc((p.health && p.health.note) || 'The nightly collection has not produced a signal snapshot.')} This is a coverage state, not evidence of quiet.</div>`;
  }
  return `
    ${sorted.map((s) => signalCard(s, mappingById)).join('')}
    ${unavailable.length ? `<details class="tc-expert"><summary>${unavailable.length} arm/ticker pairs without a computable signal</summary>
      ${unavailable.map((s) => `<p class="tc-note">${esc(s.ticker)} · ${esc(s.arm)} — ${esc(s.unavailableReason || 'unavailable')}</p>`).join('')}
    </details>` : ''}`;
}

// ── scorecard ───────────────────────────────────────────────────────────────
export function renderTechEvidenceScorecard(scorecard) {
  if (!scorecard || !Array.isArray(scorecard.arms)) return '<p class="tc-note">Scorecard unavailable.</p>';
  const rows = scorecard.arms;
  return `<div class="tc-scroll"><table class="tc-table">
    <thead><tr><th>Arm</th><th>H</th><th>Status</th><th>n (dates)</th><th>mean net residual</th><th>hit</th><th>95% CI</th><th>folds+</th><th>q</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${esc(r.arm)}</td><td>${esc(String(r.horizon))}${r.inFamily ? '' : '<span class="tc-note">·desc</span>'}</td>
      <td>${statePill(r.state)}</td>
      <td>${esc(String(r.resolvedEvents ?? 0))}${r.resolvedDates ? ` (${esc(String(r.resolvedDates))})` : ''}</td>
      <td>${esc(pct(r.meanNetResidual, 3))}</td>
      <td>${esc(r.hitRate == null ? '—' : (r.hitRate * 100).toFixed(0) + '%')}</td>
      <td>${r.ci95 ? esc(`${pct(r.ci95.lo, 2)} .. ${pct(r.ci95.hi, 2)}`) : '—'}</td>
      <td>${esc(r.positiveBlocks == null ? '—' : `${r.positiveBlocks}/4`)}</td>
      <td>${esc(r.q == null ? '—' : num(r.q, 3))}</td>
    </tr>
    <tr class="tc-subrow"><td colspan="9"><span class="tc-note">${esc(r.stateReason || '')}</span></td></tr>`).join('')}
    </tbody></table></div>
    <p class="tc-note">${esc(scorecard.disclosure || '')}</p>
    <p class="tc-note">Declared family (FDR α=${esc(String(scorecard.gate ? scorecard.gate.fdrAlpha : ''))}): ${esc((scorecard.family || []).join(', '))}. 1-session rows are descriptive only. Gate floor: ${esc(String(scorecard.gate ? scorecard.gate.minResolvedEvents : ''))} resolved events.</p>`;
}

// ── mapping coverage ────────────────────────────────────────────────────────
export function renderTechEvidenceMappings(p) {
  const maps = p.mappingsPublic || [];
  const candidates = (p.coverage && p.coverage.candidates) || [];
  if (!maps.length) return '<p class="tc-note">The mapping registry is empty.</p>';
  return `<div class="tc-scroll"><table class="tc-table">
    <thead><tr><th>Ticker</th><th>Source</th><th>Product</th><th>Weight</th><th>Verified</th><th>Active</th></tr></thead>
    <tbody>${maps.map((m) => `<tr>
      <td>${esc(m.ticker)}</td><td>${esc(m.source)}</td><td>${esc(m.product || '—')}</td>
      <td>${esc(m.monetizationWeight || '—')}</td><td>${esc(m.verifiedAt || '—')}</td>
      <td>${m.activeTo ? `<span class="tc-warn">inactive since ${esc(m.activeTo)}</span>` : 'active'}</td>
    </tr>
    <tr class="tc-subrow"><td colspan="6"><span class="tc-note">${esc(m.ownershipEvidence || '')}${m.inactiveReason ? ' · ' + esc(m.inactiveReason) : ''}</span></td></tr>`).join('')}
    </tbody></table></div>
    ${candidates.length ? `<details class="tc-expert"><summary>${candidates.length} excluded mapping candidates (never produce signals)</summary>
      ${candidates.map((c) => `<p class="tc-note">${esc(c.ticker)} · ${esc(c.source)}${c.sourceId ? ' · ' + esc(c.sourceId) : ''} — ${esc(c.excludeReason)}</p>`).join('')}
    </details>` : ''}`;
}

// ── the full section ────────────────────────────────────────────────────────
export function renderTechEvidence(p, prefs = {}, { error = null, loading = false } = {}) {
  const head = `<div class="tc-board-head"><h3 class="tc-h3">🧾 Operational Evidence <span class="tc-note">between-report activity monitor</span></h3></div>
    <p class="tc-note">Monitors operational changes between company reports from verified official sources (SEC facts, npm downloads, GitHub releases, job boards, status pages).
    <b>Research evidence, not a trade recommendation. No source is assumed to provide alpha until the forward ledger validates it.</b></p>`;
  if (loading) return `<section class="tc-board" id="tc-evidence" aria-busy="true">${head}<p class="tc-note">Loading operational evidence…</p></section>`;
  if (error) {
    return `<section class="tc-board" id="tc-evidence">${head}
      <div class="tc-error" role="alert"><b>Operational evidence could not load.</b><p>${esc(error)}</p>
      <p class="tc-note">This panel is empty because of the failure above — not because nothing changed operationally.</p></div></section>`;
  }
  if (!p) return `<section class="tc-board" id="tc-evidence">${head}<div class="tc-empty">Not loaded yet.</div></section>`;
  if (p.ok === false) {
    const reason = p.reason || p.error || (p.state === 'not-configured' ? 'Storage is not configured, so no evidence can persist.' : 'Unavailable.');
    return `<section class="tc-board" id="tc-evidence">${head}
      <div class="tc-empty">${esc(reason)}</div></section>`;
  }
  const filterRow = `<div class="tc-controls" role="group" aria-label="Evidence filters">
    <label class="tc-ctl"><span>Arm</span><select id="tcev-arm" aria-label="Filter by source arm">
      ${['all', 'npm', 'github', 'sec'].map((a) => `<option value="${esc(a)}"${(prefs.evArm || 'all') === a ? ' selected' : ''}>${esc(a === 'all' ? 'All arms' : a)}</option>`).join('')}
    </select></label>
    <label class="tc-ctl"><span>Show</span><select id="tcev-show" aria-label="Filter by signal status">
      ${[['all', 'Everything'], ['available', 'Computable signals'], ['eligible', 'Forward-ledger events']].map(([v, t]) => `<option value="${esc(v)}"${(prefs.evShow || 'all') === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}
    </select></label>
  </div>`;
  return `<section class="tc-board" id="tc-evidence">
    ${head}
    ${healthStrip(p)}
    ${filterRow}
    ${renderTechEvidenceSignals(p, prefs)}
    <details class="tc-expert"><summary>Research scorecard — the forward experiment, arm by arm</summary>${renderTechEvidenceScorecard(p.scorecard)}</details>
    <details class="tc-expert"><summary>Verified mappings &amp; coverage (${esc(String((p.coverage && p.coverage.verifiedMappings) || 0))} active)</summary>${renderTechEvidenceMappings(p)}</details>
    <details class="tc-expert"><summary>Source health</summary>${sourceHealthDetail(p)}</details>
    <p class="tc-watermark">signals cutoff ${esc((p.signals && p.signals.cutoffDate) || '—')} · generated ${esc(dt(p.generatedAt))} · all timestamps stored UTC, shown ET</p>
  </section>`;
}

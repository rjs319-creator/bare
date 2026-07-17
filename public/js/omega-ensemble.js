// 🎯 OMEGA ENSEMBLE (spec §9) — the one board that composes every engine.
//
// This module RENDERS ONLY. Every number comes from the op=ensemble payload, which is
// itself a pure projection of op=today + op=evolvehealth (lib/omega-ensemble.js). There
// is no scoring here and there must never be: a client-side scorer is the sync hazard
// that lib/apex.js and its index.html twin already taught this app to avoid.
//
// Where an engine has no number, the payload says so and we print the reason. We do not
// render a dash and let the reader assume it is loading.
import { esc } from './format.js';

const REASON_ICON = {
  'sector-cap': '🏛', 'family-cap': '🧬', 'duplicate-underlying': '👥',
  liquidity: '💧', 'net-ev': '💸', 'not-a-position': 'ℹ️', 'quality-floor': '📉', size: '✂️',
};
const HZ_LABEL = { intraday: '⚡ Intraday', swing: '📈 Swing', position: '🧭 Position', portfolio: '💼 Portfolio' };

const pct = (v, d = 2) => (Number.isFinite(v) ? `${v.toFixed(d)}%` : '—');
const nn = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');

// ── Summary panel ───────────────────────────────────────────────────────────
function summaryPanel(s) {
  if (!s) return '';
  const r = s.regime || {};
  const red = s.redundancy;
  const val = s.validation || {};
  const m = s.model || null;
  const regimeClass = r.bearish ? 'oe-bad' : r.riskOn ? 'oe-good' : 'oe-mid';
  return `
    <div class="oe-summary">
      <div class="oe-sum-cell">
        <div class="oe-sum-k">Market regime</div>
        <div class="oe-sum-v ${regimeClass}">${esc(r.label || 'Unknown')}</div>
        <div class="oe-sum-sub">${Number.isFinite(r.breadthPct) ? `breadth ${r.breadthPct}%` : 'breadth n/a'}${r.condition ? ` · ${esc(r.condition)}` : ''}</div>
        <div class="oe-sum-note">${esc(r.probabilities?.why || '')}</div>
      </div>
      <div class="oe-sum-cell">
        <div class="oe-sum-k">Evidence model</div>
        <div class="oe-sum-v">${red ? esc(red.method) : 'prior'}</div>
        <div class="oe-sum-sub">${red && Number.isFinite(red.measurablePairs) ? `${red.measurablePairs}/${red.totalPairs} algo pairs measured` : 'not yet measured'}</div>
        <div class="oe-sum-note">${red && Number.isFinite(red.avgConfirmationLift) && red.avgConfirmationLift < 0
    ? `⚠️ agreement has been COSTING ${pct(red.avgConfirmationLift)} — co-selected names underperform singles`
    : esc(red?.verdict || '')}</div>
      </div>
      <div class="oe-sum-cell">
        <div class="oe-sum-k">Validation</div>
        <div class="oe-sum-v ${val.passing === 0 ? 'oe-bad' : val.known ? 'oe-good' : 'oe-mid'}">${val.known ? `${val.passing}/${val.trials} cells` : 'n/a'}</div>
        <div class="oe-sum-sub">deflated-Sharpe multiple-testing gate</div>
        <div class="oe-sum-note">${esc(val.verdict || '')}</div>
      </div>
      <div class="oe-sum-cell">
        <div class="oe-sum-k">Model</div>
        <div class="oe-sum-v">${esc((m && m.version) || (s.mode || '').split(' ')[0])}</div>
        <div class="oe-sum-sub">${m && m.known
    ? `${m.resolvedSamples ?? '—'} resolved · ${m.calibrated ? `calibrated (Brier ${nn(m.brier, 3)})` : 'not calibrated'}`
    : esc(s.mode || '')}</div>
        <div class="oe-sum-note">${esc(s.mode || '')}${s.generatedAt ? ` · as of ${esc(new Date(s.generatedAt).toLocaleString())}` : ''}</div>
      </div>
    </div>
    ${(s.warnings || []).length ? `<div class="oe-warn">⚠️ ${s.warnings.map(w => esc(w)).join(' · ')}</div>` : ''}`;
}

// ── One row of the ranking table ────────────────────────────────────────────
function rankRow(r) {
  const c = r.cost || {};
  const e = r.evidence || {};
  const tr = r.trackRecord || {};
  // The evidence chip is the whole point of the redundancy work: show the raw count AND
  // what it was actually worth once correlation was measured.
  const evChip = e.measured && Number.isFinite(e.discounted) && e.discounted > 0.01
    ? `<span class="oe-chip oe-chip-warn" title="measured: ${esc(e.source)}">🧩 ${nn(e.effectiveUnits, 2)} of ${e.declaredFamilyCount} — ${nn(e.discounted, 2)} discounted</span>`
    : `<span class="oe-chip" title="${esc(e.source || '')}">🧩 ${e.declaredFamilyCount ?? '—'} ${e.measured ? 'measured' : 'declared'}</span>`;
  const costChip = c.known
    ? `<span class="oe-chip ${c.costShare > 0.1 ? 'oe-chip-warn' : ''}" title="${esc(c.tierLabel || '')}${c.tierAssumed ? ' (tier assumed — dollar-volume unknown)' : ''}">💸 ${pct(c.grossMovePct)} → ${pct(c.netMovePct)} net</span>`
    : '<span class="oe-chip oe-chip-dim" title="no target level — nothing to charge the round trip against">💸 n/a</span>';
  const trChip = tr.known
    ? `<span class="oe-chip ${tr.avgExcess > 0 ? 'oe-chip-good' : 'oe-chip-warn'}" title="${esc(tr.source)}">📊 ${pct(tr.avgExcess)} vs mkt · n=${tr.n}</span>`
    : '<span class="oe-chip oe-chip-dim" title="no resolved track record for this section:tier yet">📊 building</span>';
  return `
    <tr class="oe-row">
      <td class="oe-rank">${r.rank ?? '—'}</td>
      <td class="oe-tk"><strong>${esc(r.ticker)}</strong>${r.side === 'short' ? ' <span class="oe-short">🔻</span>' : ''}
        <div class="oe-sub">${esc(r.sector || '—')} · ${esc(r.strategyFamily || '—')}</div></td>
      <td>${HZ_LABEL[r.horizon] || esc(r.horizon)}</td>
      <td class="oe-score">${nn(r.score)}</td>
      <td class="oe-prob" title="${esc(r.probabilities?.why || '')}">not calibrated</td>
      <td class="oe-chips">${costChip} ${evChip} ${trChip}</td>
    </tr>`;
}

function rankingTable(rows) {
  if (!rows.length) {
    return '<div class="oe-empty">The book is empty — no name cleared the quality floor and the portfolio constraints today. That is an allowed outcome, not an error.</div>';
  }
  return `
    <div class="oe-tablewrap">
      <table class="oe-table">
        <thead><tr>
          <th>#</th><th>Name</th><th>Horizon</th>
          <th title="validated expectancy x confidence x regime x execution x independent evidence x cost">Composite</th>
          <th title="the composite is a RANK, not a probability">2/5/10d probability</th>
          <th>Cost · evidence · track record</th>
        </tr></thead>
        <tbody>${rows.map(rankRow).join('')}</tbody>
      </table>
    </div>`;
}

// ── Excluded candidates (§9) ────────────────────────────────────────────────
function excludedPanel(ex) {
  if (!ex || !ex.length) return '';
  return `
    <details class="oe-excl">
      <summary>🚫 Strong candidates excluded (${ex.length}) — what the raw rank would have handed you</summary>
      <div class="oe-excl-body">
        ${ex.map(e => `
          <div class="oe-excl-row">
            <span class="oe-excl-tk">${esc(e.ticker)}</span>
            <span class="oe-excl-score">${nn(e.score)}</span>
            <span class="oe-excl-reason">${REASON_ICON[e.reason] || '·'} ${esc(e.label || e.reason)}</span>
            <span class="oe-excl-detail">${esc(e.detail || '')}${e.blockedBy?.length ? ` <em>(blocked by ${e.blockedBy.map(b => esc(b)).join(', ')})</em>` : ''}</span>
          </div>`).join('')}
      </div>
    </details>`;
}

function portfolioPanel(p) {
  if (!p) return '';
  const exp = Object.entries(p.exposure || {});
  const fam = Object.entries(p.familyExposure || {});
  return `
    <div class="oe-pf">
      <div class="oe-pf-line"><strong>Book</strong> — ${p.caps?.size ?? '?'} slot ceiling, max ${p.caps?.maxPerSector ?? '?'}/sector, max ${p.caps?.maxPerFamily ?? '?'}/archetype, quality floor ${p.caps?.minScore ?? '?'}
        ${p.unfilled > 0 ? `<span class="oe-chip oe-chip-warn">${p.unfilled} slot${p.unfilled === 1 ? '' : 's'} left EMPTY — better than filling with junk</span>` : ''}</div>
      <div class="oe-pf-line">Sector exposure: ${exp.length ? exp.map(([k, v]) => `${esc(k)} ${v}`).join(' · ') : '—'}</div>
      <div class="oe-pf-line">Archetype exposure: ${fam.length ? fam.map(([k, v]) => `${esc(k)} ${v}`).join(' · ') : '—'}</div>
      ${p.note ? `<div class="oe-pf-note">${esc(p.note)}</div>` : ''}
    </div>`;
}

function disclosurePanel(d) {
  if (!d || !d.length) return '';
  return `
    <details class="oe-disc">
      <summary>📋 What this page does NOT claim</summary>
      <ul>${d.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
    </details>`;
}

export function renderEnsemble(container, p) {
  if (!container) return;
  if (!p || p.ok === false) {
    container.innerHTML = `<div class="oe-empty">⚠️ ${esc((p && p.note) || 'The decision engine did not answer. Nothing is rendered rather than a stale board.')}</div>`;
    return;
  }
  container.innerHTML = `
    ${summaryPanel(p.summary)}
    ${portfolioPanel(p.portfolio)}
    ${rankingTable(p.ranking || [])}
    ${excludedPanel(p.excluded)}
    ${disclosurePanel(p.disclosures)}`;
}

// `force` busts the CDN. Only the Refresh button should: op=ensemble self-fetches op=today
// (~12s cold), and a cache-buster on every tab open would make the route a guaranteed CDN
// MISS — re-running the whole merge per visit and throwing away the s-maxage=300 the route
// sets on itself.
export async function loadEnsemble(container, force = false) {
  if (!container) return;
  container.innerHTML = '<div class="mom-status"><div class="mom-spinner"></div><p>Composing the ensemble from every engine… <span class="dt-dim">(can take ~15s cold)</span></p></div>';
  try {
    const r = await fetch(`/api/tracker?op=ensemble${force ? `&_cb=${Date.now()}` : ''}`);
    const p = await r.json();
    renderEnsemble(container, p);
  } catch (e) {
    container.innerHTML = `<div class="oe-empty">⚠️ Could not reach the ensemble: ${esc(String(e && e.message || e))}</div>`;
  }
}

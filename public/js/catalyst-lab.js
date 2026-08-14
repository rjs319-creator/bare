// ⚡ Catalyst–Flow Ranker lab board — RESEARCH / SHADOW, weight-0, read-only.
//
// Renders /api/tracker?op=catalystflow and ?op=catalystflowcoverage. The board's job is
// as much to display the LIMITATIONS as the ranking: this engine's historical evidence is
// built on a reconstructed consensus archive and has no signed customer opening option
// flow, and a reader who sees ten tickers without seeing that is being misled.
//
// Two rules are enforced in the rendering itself, not left to the data:
//   * a LambdaMART score is displayed as an ORDINAL rank, never as a percentage or a
//     probability — there is no `%` formatter applied to a score anywhere in this file;
//   * an unmeasured arm is drawn as INSUFFICIENT_DATA, visually distinct from a measured
//     null result, because "we never looked" and "we looked and found nothing" are
//     different claims.

import { esc } from './format.js';
import { fetchJSON, HEAVY_TIMEOUT_MS } from './fetch-json.js';

const ACCENT = '#64d2ff';
const num = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '·');

const STATE_STYLE = {
  DISABLED: { color: '#8e8e93', icon: '○', text: 'Disabled' },
  UNAVAILABLE: { color: '#8e8e93', icon: '○', text: 'Not published' },
  STALE: { color: '#ff9f0a', icon: '◷', text: 'Stale' },
  INVALID: { color: 'var(--red)', icon: '⚠', text: 'Invalid artifact' },
  SHADOW: { color: ACCENT, icon: '◐', text: 'Shadow' },
  LIVE: { color: 'var(--green)', icon: '●', text: 'Live' },
};

function card(title, subtitle, body) {
  return `<div style="border:1px solid #2c2c2e;border-radius:12px;padding:14px 16px;margin-bottom:14px;background:#1c1c1e">
    <div style="font-weight:600;color:${ACCENT};margin-bottom:2px">${title}</div>
    ${subtitle ? `<div style="font-size:.78em;color:#8e8e93;margin-bottom:8px">${subtitle}</div>` : ''}
    ${body}</div>`;
}

function shadowBanner(d) {
  const s = STATE_STYLE[d.state] || STATE_STYLE.UNAVAILABLE;
  return `<div style="border:1px dashed #48484a;border-radius:10px;padding:10px 14px;margin-bottom:14px;font-size:.82em;color:#8e8e93">
    ⚡ <b style="color:${s.color}">${s.icon} ${esc(s.text.toUpperCase())} — weight 0.</b>
    Nothing on this board can move a live pick.
    <span style="color:#c7c7cc">${esc(d.reason || '')}</span>
    <span class="expert-only"> · engine ${esc(d.engine || '')} · ${esc(d.artifact?.arm || 'no arm')}</span>
  </div>`;
}

// The limitations panel is NOT decoration. It is rendered before the ranking, and when the
// server reports none it says so rather than being hidden.
function limitations(d) {
  const rows = d.limitations || [];
  if (!rows.length) return '';
  return card('🧭 What this ranking cannot tell you',
    'derived from the artifact\'s own recorded data quality — not a hand-maintained list',
    `<ul style="margin:0;padding-left:18px;font-size:.85em;line-height:1.55;color:#c7c7cc">
      ${rows.map((l) => `<li style="margin-bottom:5px">${esc(l)}</li>`).join('')}
    </ul>`);
}

function gatePanel(d) {
  const g = d.gates;
  if (!g) return '';
  const rows = Object.entries(g.passed).map(([name, ok]) =>
    `<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #2c2c2e">
      <span style="color:#c7c7cc">${esc(name)}</span>
      <b style="color:${ok ? 'var(--green)' : '#8e8e93'}">${ok ? 'PASSED' : 'not passed'}</b>
    </div>`).join('');
  return card('🔒 Promotion gates',
    `all must pass on IMMUTABLE point-in-time evidence before this can leave shadow — ${g.failing.length} outstanding`,
    `<div style="font-size:.82em">${rows}</div>`);
}

function ranking(d) {
  const ranks = d.artifact?.ranks || [];
  if (!ranks.length) {
    return card('📋 Ranking', 'no candidates published for this decision date',
      `<div style="font-size:.85em;color:#8e8e93">The book is empty. Holding cash is a decision the strategy is allowed to make — an empty ranking is not a failure to produce one.</div>`);
  }
  const rows = ranks.map((r) => `<tr>
    <td style="padding:5px 8px;color:#8e8e93">${r.rank}</td>
    <td style="padding:5px 8px;font-weight:600">${esc(r.symbol)}</td>
    <td style="padding:5px 8px;color:#c7c7cc">${esc(r.sector || '·')}</td>
    <td style="padding:5px 8px;text-align:right;font-variant-numeric:tabular-nums" title="ordinal LambdaMART relevance — not a return, not a probability">${num(r.score, 3)}</td>
    <td class="expert-only" style="padding:5px 8px;text-align:right;color:#8e8e93;font-variant-numeric:tabular-nums">${num(r.missingFeatureShare, 2)}</td>
  </tr>`).join('');
  return card(`📋 Ranking — ${esc(d.artifact.decisionDate)}`,
    'score is an ORDINAL relevance value from a ranking model. It is not an expected return and not a probability.',
    `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:.85em">
      <thead><tr style="color:#8e8e93;text-align:left">
        <th style="padding:5px 8px">#</th><th style="padding:5px 8px">Symbol</th>
        <th style="padding:5px 8px">Sector</th>
        <th style="padding:5px 8px;text-align:right">Score <span style="font-weight:400">(ordinal)</span></th>
        <th class="expert-only" style="padding:5px 8px;text-align:right">Missing</th>
      </tr></thead><tbody>${rows}</tbody></table></div>`);
}

// Data availability. The distinction this panel exists to draw: INSUFFICIENT_DATA is not
// a result, and it is coloured and worded so it cannot be read as one.
function coveragePanel(c) {
  if (!c) return '';
  const so = c.providers?.signedOptions || {};
  const armRow = (name, status) => {
    const insufficient = String(status).includes('INSUFFICIENT_DATA');
    return `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #2c2c2e">
      <span style="color:#c7c7cc">${esc(name)}</span>
      <b style="color:${insufficient ? '#ff9f0a' : '#c7c7cc'}">${esc(status)}</b>
    </div>`;
  };
  return card('🛰 Data availability',
    'what is measurable today — an arm with no data has NOT been shown to be worthless',
    `<div style="font-size:.82em">
      ${Object.entries(c.arms || {}).map(([k, v]) => armRow(k, v)).join('')}
      <div style="margin-top:10px;padding:9px 11px;border:1px solid #48484a;border-radius:8px;color:#8e8e93;line-height:1.5">
        <b style="color:#ff9f0a">Signed customer opening option flow: ${so.optionsSignedCoverage ? 'available' : 'NOT AVAILABLE'}.</b>
        ${esc(so.reason || '')}
        <div style="margin-top:6px">Those features are left <b>missing, not zero</b>. Free option-chain volume cannot determine participant, side, or open/close, so it is never substituted here — calls are not relabelled bullish and puts are not relabelled bearish.</div>
        ${so.exchanges?.length ? `<div class="expert-only" style="margin-top:6px">Exchanges: ${esc(so.exchanges.join(', '))} · full-market coverage: ${so.exchangeCoverageComplete ? 'yes' : 'NO — partial-exchange history is not full-market history'}</div>` : ''}
      </div>
    </div>`);
}

function modelPanel(d) {
  const m = d.artifact?.modelMeta;
  if (!m) return '';
  return card('🧮 Model', 'offline-trained; a request never trains and never recomputes a rank',
    `<div class="expert-only" style="font-size:.82em;color:#c7c7cc;line-height:1.6">
      objective <b>${esc(m.objective || '·')}</b> · metric <b>${esc(m.metric || '·')}</b>
      ${m.ndcgEvalAt ? ` @${esc(String(m.ndcgEvalAt))}` : ''}<br>
      training cutoff ${esc(m.trainingCutoff || '·')} · configurations tried <b>${esc(String(m.trialCount ?? '·'))}</b><br>
      <span style="color:#8e8e93">The trial count is shown because a winner selected from an undocumented search is not evidence.</span>
    </div>`);
}

export async function renderCatalystLab(el) {
  if (!el) return;
  el.innerHTML = '<div style="padding:20px;color:#8e8e93">Loading Catalyst–Flow…</div>';
  try {
    const [d, c] = await Promise.all([
      fetchJSON('/api/tracker?op=catalystflow', { timeoutMs: HEAVY_TIMEOUT_MS }),
      fetchJSON('/api/tracker?op=catalystflowcoverage', { timeoutMs: HEAVY_TIMEOUT_MS }).catch(() => null),
    ]);
    if (!d || d.ok === false) throw new Error(d?.error || 'unavailable');

    el.innerHTML = shadowBanner(d)
      + limitations(d)
      + ranking(d)
      + coveragePanel(c)
      + gatePanel(d)
      + modelPanel(d);
  } catch (e) {
    el.innerHTML = card('⚡ Catalyst–Flow Ranker', 'research / shadow',
      `<div style="font-size:.85em;color:#8e8e93">Could not load: ${esc(String(e.message || e))}.
       The engine is off by default and publishes nothing until the offline trainer has run.</div>`);
  }
}

// EVOLVE — OMEGA Evidence panel (frontend). §20/§16: champion-vs-challenger, per-horizon
// rank-IC, sample-independence, deflated-Sharpe / multiple-testing grid, calibration, and the
// pre-registered promotion decision.
//
// This module holds NO summarization logic. The server (lib/evolve-evidence-view.js) builds a
// render-ready `evidenceView`; here we only turn that object into HTML. The walk-forward is
// heavy (it replays years of history), so it is LAZY: nothing runs until the user clicks —
// the default EVOLVE tab stays fast.

import { esc } from './format.js';

const TONE_ICON = { pass: '🟢', fail: '🔴', warn: '🟡', muted: '⚪' };
const dec3 = (x) => (x == null ? '–' : (x >= 0 ? '+' : '') + Number(x).toFixed(3));
const brierStr = (x) => (x == null ? '–' : Number(x).toFixed(3));

// Collapsed shell + trigger button. Rendered into the EVOLVE tab; fetch happens on click.
export function evidencePanelHtml() {
  return `<details class="ev-disclosure evi-panel">
    <summary>🔬 Evidence — purged walk-forward vs the champion (${esc('OMEGA §20')})</summary>
    <div class="ev-disc-body">
      <p>The rigorous, leakage-controlled out-of-sample test behind EVOLVE's abstention. It trains
      specialist performance only on the strict past, <b>purges + embargoes</b> the boundary so a
      63-day label can't leak into the test block, and judges every specialist×regime×horizon cell
      against the max Sharpe random trials alone would produce. <b>This is the arbiter of whether
      the challenger may promote over the champion — and today it does not.</b></p>
      <p class="evi-warn">⚠ Heavy: replays years of history (~20–45s). Read-only, cached ~30 min.</p>
      <p><button class="today-cta evi-run-btn">▶ Run walk-forward evidence</button></p>
      <div class="evi-result" hidden></div>
    </div>
  </details>`;
}

// Wire the run button inside `container` (called once after the tab renders).
export function wireEvidencePanel(container) {
  if (!container) return;
  const btn = container.querySelector('.evi-run-btn');
  const out = container.querySelector('.evi-result');
  if (!btn || !out) return;
  let ran = false;
  btn.addEventListener('click', async () => {
    if (ran) return;
    ran = true;
    btn.disabled = true;
    btn.textContent = '⏳ Running purged walk-forward…';
    out.hidden = false;
    out.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Replaying history, purging &amp; embargoing folds, scoring cells…</p></div>`;
    try {
      const data = await fetch('/api/tracker?op=evolveomegawf').then((r) => r.json());
      out.innerHTML = renderEvidence(data && data.evidenceView);
      btn.textContent = '↻ Re-run evidence';
    } catch (e) {
      out.innerHTML = `<div class="mom-status error"><p>Could not run the walk-forward evidence right now.</p></div>`;
      btn.textContent = '▶ Run walk-forward evidence';
      ran = false;
    } finally {
      btn.disabled = false;
    }
  });
}

// Pure: view-model → HTML. Exported for a headless render check.
export function renderEvidence(v) {
  if (!v || !v.available) {
    return `<div class="ev-col-empty">${esc((v && v.note) || 'No walk-forward evidence available.')}</div>`;
  }
  return `<div class="evi-wrap">
    ${verdictBanner(v)}
    ${championChallenger(v.championChallenger)}
    ${horizonTable(v.horizons)}
    ${dsrBlock(v.dsr)}
    ${uniquenessBlock(v.uniqueness, v.calibration)}
    ${promotionBlock(v.promotion)}
    ${metaFooter(v.meta, v.version)}
  </div>`;
}

function verdictBanner(v) {
  const vd = v.verdict || {};
  const icon = TONE_ICON[vd.tone] || '⚪';
  return `<div class="evi-verdict evi-${esc(vd.tone || 'muted')}">
    <div class="evi-verdict-head">${icon} <b>${esc(vd.label || 'Unknown')}</b></div>
    <p>${esc(vd.plain || '')}</p>
  </div>`;
}

function championChallenger(cc) {
  if (!cc) return '';
  const badge = cc.promote ? `<span class="evi-badge evi-badge-pass">PROMOTE</span>` : `<span class="evi-badge evi-badge-hold">CHAMPION RETAINED</span>`;
  return `<div class="evi-section">
    <div class="evi-sec-title">Champion vs challenger ${badge}</div>
    <div class="evi-cc">
      <div class="evi-cc-cell"><span class="evi-k">${esc(cc.challenger)} (purged OOS IC)</span><span class="evi-v">${dec3(cc.purgedMeanIC)}</span></div>
      <div class="evi-cc-cell"><span class="evi-k">naive un-purged IC</span><span class="evi-v evi-muted-v">${dec3(cc.leakyMeanIC)}</span></div>
      <div class="evi-cc-cell"><span class="evi-k">leakage the rigor removes</span><span class="evi-v">${dec3(cc.leakageInflation)}</span></div>
      <div class="evi-cc-cell"><span class="evi-k">OOS blocks (positive / tested)</span><span class="evi-v">${esc(String(cc.positiveBlocks))} / ${esc(String(cc.testedBlocks))}</span></div>
    </div>
    <p class="evi-note">${esc(cc.decision)}</p>
  </div>`;
}

function horizonTable(rows) {
  if (!rows || !rows.length) return '';
  const body = rows.map((r) => `<tr>
    <td>${esc(r.label)}</td>
    <td class="${icClass(r.meanOOS)}">${dec3(r.meanOOS)}</td>
    <td>${esc(String(r.positiveBlocks))}/${esc(String(r.testedBlocks))}</td>
    <td>${brierStr(r.brier)}</td>
    <td>${r.effectiveN != null ? `${esc(String(r.effectiveN))}/${esc(String(r.rawN))}` : '–'}</td>
    <td><span class="evi-hv evi-hv-${esc(hvTone(r.verdict))}">${esc(r.verdict)}</span></td>
  </tr>`).join('');
  return `<div class="evi-section">
    <div class="evi-sec-title">By horizon (purged out-of-sample)</div>
    <div class="evi-table-scroll"><table class="evi-table">
      <thead><tr><th>Horizon</th><th>Mean IC</th><th>+blocks</th><th>Brier</th><th>eff/raw N</th><th>Verdict</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
  </div>`;
}

function dsrBlock(d) {
  if (!d) return '';
  const best = d.bestCell;
  const bestStr = best
    ? `${esc(best.specialist)} · ${esc(best.regime)} · ${esc(best.horizon)} — SR ${dec3(best.sr)} (n${esc(String(best.n))})${best.pass ? ' ✅' : ''}`
    : 'no cell with sufficient sample';
  return `<div class="evi-section">
    <div class="evi-sec-title">Deflated Sharpe · multiple-testing gate</div>
    <div class="evi-cc">
      <div class="evi-cc-cell"><span class="evi-k">cells tried</span><span class="evi-v">${esc(String(d.trials))}</span></div>
      <div class="evi-cc-cell"><span class="evi-k">E[max Sharpe | null]</span><span class="evi-v">${dec3(d.expectedMaxNull)}</span></div>
      <div class="evi-cc-cell"><span class="evi-k">cells surviving</span><span class="evi-v ${d.passing ? '' : 'evi-muted-v'}">${esc(String(d.passing))}</span></div>
      <div class="evi-cc-cell"><span class="evi-k">best cell</span><span class="evi-v evi-v-wide">${bestStr}</span></div>
    </div>
    <p class="evi-note">${esc(d.plain)}</p>
  </div>`;
}

function uniquenessBlock(u, cal) {
  if (!u) return '';
  return `<div class="evi-section evi-inline">
    <div><div class="evi-sec-title">Sample independence</div>
      <p class="evi-note"><b>${u.effectiveN != null ? esc(String(u.effectiveN)) : '–'}</b> effective of ${u.rawN != null ? esc(String(u.rawN)) : '–'} raw labels${u.ratio != null ? ` (ratio ${dec3(u.ratio)})` : ''} — ${esc(u.plain)}.</p>
    </div>
    <div><div class="evi-sec-title">Calibration</div>
      <p class="evi-note">Pooled purged <b>Brier ${brierStr(cal && cal.brier)}</b> (lower is better; 0.25 = uninformative).</p>
    </div>
  </div>`;
}

function promotionBlock(p) {
  if (!p) return '';
  return `<div class="evi-section evi-promotion">
    <div class="evi-sec-title">Promotion decision (pre-registered)</div>
    <p class="evi-note"><b>Criterion:</b> ${esc(p.criterion)}</p>
    <p class="evi-note evi-${p.promote ? 'pass' : 'fail'}-text"><b>Decision:</b> ${esc(p.decision)}</p>
  </div>`;
}

function metaFooter(m, version) {
  if (!m) return '';
  const regime = Object.entries(m.regimeComposition || {}).map(([k, n]) => `${esc(k)} ${esc(String(n))}`).join(' · ');
  return `<div class="evi-foot">
    ${esc(version || 'evolve-omega-wf')} · range ${esc(String(m.range))} · embargo ${esc(String(m.embargo))}d · ${m.weighted ? 'uniqueness-weighted' : 'unweighted'} · ${esc(String(m.events))} events${regime ? ` · regime mix: ${regime}` : ''}
  </div>`;
}

function icClass(x) { return x == null ? '' : x > 0 ? 'evi-pos' : x < 0 ? 'evi-neg' : ''; }
function hvTone(v) {
  if (v === 'edge-holds-oos') return 'pass';
  if (v === 'no-edge') return 'fail';
  if (v === 'inconclusive') return 'warn';
  return 'muted';
}

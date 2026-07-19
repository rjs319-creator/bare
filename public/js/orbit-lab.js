// Research Lab panel for the ORBIT + ORBIT-ML shadow systems.
// Read-only: fetches op=orbit / op=orbithealth / op=orbitml / op=orbitmlhealth and
// renders an HONEST shadow view — grade, health, and the (cold-start-friendly) board.
// Never implies these affect the live rank; they carry weight 0 by design.
import { esc } from './format.js';

const ACCENT = '#5ac8fa';

async function getJSON(url) {
  try { const r = await fetch(url); return await r.json(); } catch { return null; }
}

function pct(x) { return x == null ? '—' : (x * 100).toFixed(1) + '%'; }
function num(x, d = 4) { return x == null ? '—' : (+x).toFixed(d); }

function gradeChip(g) {
  const colors = { A: '#34c759', B: '#5ac8fa', C: '#ffd60a', D: '#ff9f0a', F: '#ff453a' };
  const c = colors[g] || '#8e8e93';
  return `<span style="display:inline-block;min-width:1.4em;text-align:center;font-weight:700;color:#000;background:${c};border-radius:5px;padding:1px 6px">${esc(g || '—')}</span>`;
}
function statusChip(s) {
  const colors = { HEALTHY: '#34c759', WATCH: '#ffd60a', DEGRADING: '#ff9f0a', BROKEN: '#ff453a', INSUFFICIENT_DATA: '#8e8e93' };
  const c = colors[s] || '#8e8e93';
  return `<span style="color:${c};font-weight:600">${esc((s || 'n/a').replace(/_/g, ' '))}</span>`;
}

function healthRows(monitor, grades) {
  if (!monitor || !monitor.byHorizon) return '<div style="color:#8e8e93">No resolved outcomes yet — accruing.</div>';
  const H = [['days5', '5-session'], ['days21', '21-session'], ['days63', '63-session']];
  const rows = H.map(([k, label]) => {
    const h = monitor.byHorizon[k] || {};
    const ex = h.expanding || {};
    const g = grades && grades[k] ? grades[k].grade : null;
    return `<tr>
      <td style="padding:4px 10px 4px 0">${esc(label)}</td>
      <td style="padding:4px 10px">${statusChip(h.status)}</td>
      <td style="padding:4px 10px">${gradeChip(g)}</td>
      <td style="padding:4px 10px;color:#c7c7cc">IC ${num(ex.ic)}</td>
      <td style="padding:4px 10px;color:#c7c7cc">n=${ex.effN != null ? ex.effN : '—'}</td>
    </tr>`;
  }).join('');
  return `<table style="border-collapse:collapse;font-size:13px;width:100%"><thead><tr style="color:#8e8e93;text-align:left">
    <th style="padding:2px 10px 2px 0">Horizon</th><th style="padding:2px 10px">Health</th><th style="padding:2px 10px">Grade</th><th style="padding:2px 10px">OOS rank-IC</th><th style="padding:2px 10px">Dates</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function boardList(latest, kind) {
  if (!latest) return '<div style="color:#8e8e93">Not logged yet.</div>';
  if (latest.note && (!latest.board || !latest.board.length) && (!latest.ranked || !latest.ranked.length) && (!latest.predictions || !latest.predictions.length)) {
    return `<div style="color:#8e8e93">${esc(latest.note)}</div>`;
  }
  const items = kind === 'orbitml'
    ? (latest.predictions || latest.ranked || [])
    : (latest.predictions || latest.board || []);
  if (!items.length) return '<div style="color:#8e8e93">No candidates in the last logged run (shadow abstained).</div>';
  const shown = items.slice(0, 15).map((p, i) => {
    const cls = p.classification || '';
    const extra = kind === 'orbitml'
      ? `rank ${p.rankPct != null ? (p.rankPct * 100).toFixed(0) + '%' : num(p.rankScore, 3)}`
      : `${cls}`;
    return `<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #2c2c2e;font-size:13px">
      <span><b>${esc(p.ticker || '?')}</b></span><span style="color:#8e8e93">${esc(extra)}</span></div>`;
  }).join('');
  const asOf = latest.date ? ` · as of ${esc(latest.date)}` : '';
  return `<div style="color:#8e8e93;font-size:12px;margin-bottom:4px">${items.length} logged${asOf}</div>${shown}`;
}

function card(title, subtitle, bodyHtml) {
  return `<div style="background:#1c1c1e;border:1px solid #2c2c2e;border-radius:10px;padding:14px 16px;margin-bottom:14px">
    <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px">
      <h3 style="margin:0;color:${ACCENT};font-size:16px">${esc(title)}</h3>
      <span style="color:#8e8e93;font-size:12px">${esc(subtitle)}</span>
    </div>${bodyHtml}</div>`;
}

export async function loadOrbitLab(container) {
  if (!container) return;
  container.innerHTML = `<div class="mom-status"><div class="mom-spinner"></div><p>Loading ORBIT shadow systems…</p></div>`;

  const [orbit, orbitHealth, orbitml, orbitmlHealth] = await Promise.all([
    getJSON('/api/tracker?op=orbit'),
    getJSON('/api/tracker?op=orbithealth'),
    getJSON('/api/tracker?op=orbitml'),
    getJSON('/api/tracker?op=orbitmlhealth'),
  ]);

  const banner = `<div style="background:#2c2c2e;border-left:3px solid ${ACCENT};border-radius:6px;padding:10px 14px;margin-bottom:14px;font-size:13px;color:#c7c7cc">
    🛰️ <b>ORBIT &amp; ORBIT-ML are shadow research systems.</b> They rank stocks by calibrated / residual-drift signals over 5·21·63 sessions but
    <b>carry zero deployment weight and never affect the live rank</b> — they exist to accrue an out-of-sample track record and be judged honestly.
    Current state: no durable out-of-sample edge demonstrated (grade C); they abstain rather than force picks.
    Both start logging on the daily warm cron, so the boards below fill in over time.</div>`;

  // ORBIT card
  const oValidity = (orbitHealth && orbitHealth.researchValidity) || {};
  const orbitCard = card('ORBIT', 'orthogonal-residual Bayesian drift · shadow',
    healthRows(orbitHealth && orbitHealth.monitor, orbitHealth && orbitHealth.grades)
    + `<div style="margin-top:10px"><div style="color:#8e8e93;font-size:12px;margin-bottom:4px">Latest board</div>${boardList(orbit && orbit.latest, 'orbit')}</div>`
    + `<div style="margin-top:10px;font-size:12px;color:#8e8e93">Research validity: production-grade ${oValidity.productionGrade ? 'yes' : 'no'} · survivorship-safe ${oValidity.survivorshipSafe ? 'yes' : 'no'}</div>`);

  // ORBIT-ML card
  const mMon = orbitmlHealth && orbitmlHealth.monitor;
  const inc = mMon && mMon.incremental ? mMon.incremental : {};
  const loo = inc.leaveOneOut;
  const marginalHtml = loo && loo.ready
    ? `<div style="margin-top:10px;font-size:13px">Marginal ensemble contribution: <b style="color:${loo.marginalDelta > 0 ? '#34c759' : '#ff453a'}">${num(loo.marginalDelta)}</b> <span style="color:#8e8e93">(${esc(loo.verdict)})</span></div>`
    : `<div style="margin-top:10px;font-size:13px;color:#8e8e93">Marginal ensemble contribution: accruing (needs a joint resolved cross-section).</div>`;
  const specStatus = orbitml && orbitml.sourceMapped === false
    ? `<span style="color:#8e8e93">EVOLVE specialist <code>idiosyncraticPersistence</code> · unmapped (shadow)</span>` : '';
  const orbitmlCard = card('ORBIT-ML', 'cross-sectional residual-drift ranker · shadow',
    `<div style="font-size:12px;margin-bottom:8px">${specStatus}</div>`
    + healthRows(mMon && mMon.health, mMon && mMon.grades)
    + marginalHtml
    + `<div style="margin-top:10px"><div style="color:#8e8e93;font-size:12px;margin-bottom:4px">Latest ranking</div>${boardList(orbitml && orbitml.latest, 'orbitml')}</div>`);

  container.innerHTML = banner + orbitCard + orbitmlCard;
}

// Research Lab panel for the RLT (Relative Leadership Transition) shadow system.
// Read-only: fetches op=rlt and renders an HONEST shadow view — inventory by
// state, prospective evidence, calibration status, and WHY the system abstained.
// Never implies RLT affects the live rank; it carries weight 0 by design.
import { esc } from './format.js';

const ACCENT = '#bf5af2';

async function getJSON(url) {
  try { const r = await fetch(url); return await r.json(); } catch { return null; }
}

const STATE_META = {
  ACCEPTED: { label: 'Accepted', color: '#34c759', hint: 'trigger held, positive expected utility remains' },
  TRIGGERED: { label: 'Recently triggered', color: '#30d158', hint: 'objective trigger occurred — execution pending, not auto-buy' },
  ARMED: { label: 'Armed near trigger', color: '#ffd60a', hint: 'near a valid trigger with improving participation — alert candidate, NOT a buy' },
  PRIMED: { label: 'Primed', color: '#5ac8fa', hint: 'leadership established, structure forming — watch only' },
  EMERGING_LEADER: { label: 'Emerging leaders', color: '#64d2ff', hint: 'entering the upper peer group with rank acceleration' },
  DISCOVERED: { label: 'Discovered', color: '#8e8e93', hint: 'leadership improving, evidence early' },
  WEAKENING: { label: 'Weakening', color: '#ff9f0a', hint: 'open but deteriorating' },
  INVALIDATED: { label: 'Invalidated', color: '#ff453a', hint: 'structural downside condition hit' },
  EXPIRED: { label: 'Expired', color: '#8e8e93', hint: 'transition did not occur in window' },
  COMPLETED: { label: 'Completed', color: '#8e8e93', hint: 'terminal outcome resolved' },
};

function pctile(x) { return x == null ? '—' : Math.round(x * 100) + 'th'; }
function signedPts(x) { return x == null ? '—' : (x >= 0 ? '+' : '') + Math.round(x * 100) + ' pts'; }

function card(c) {
  const n = c.novice || {};
  const e = c.expert || {};
  const pg = e.peerGroup || {};
  const meta = STATE_META[c.state] || { color: '#8e8e93', label: c.state };
  return `<div style="border:1px solid #2c2c2e;border-radius:10px;padding:10px 12px;margin:6px 0;background:#1c1c1e">
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap">
      <div><b style="font-size:1.05em">${esc(c.ticker)}</b>
        <span style="color:${meta.color};font-weight:600;margin-left:6px">${esc(meta.label || c.state)}</span>
        ${c.sector ? `<span style="color:#8e8e93;margin-left:6px">${esc(c.sector)}${c.sectorState ? ` · ${esc(c.sectorState)}` : ''}</span>` : '<span style="color:#8e8e93;margin-left:6px">no sector (market-only)</span>'}
      </div>
      <div style="color:#8e8e93;font-size:.85em">peer rank ${pctile(e.residualRank)} · 5s ${signedPts(e.rankVel5)}</div>
    </div>
    <div style="color:#d1d1d6;font-size:.9em;margin-top:4px">
      ${esc(n.trigger || '')} · ${esc(n.invalidation || '')} · ${esc(n.timeframe || '')}
    </div>
    <div style="color:#8e8e93;font-size:.85em;margin-top:3px">
      transition rank: ${e.transitionRank != null ? esc(String(Math.round(e.transitionRank * 100)) + 'th') : '—'}
      (${esc(e.evidenceBand || 'n/a')}) · calibration: ${esc(e.calibrationStatus || 'unavailable')}
      · peers: ${esc(String(pg.size ?? '—'))} (${esc(pg.level || '—')})${pg.fallback ? ` · ${esc(pg.fallback)}` : ''}
    </div>
    ${e.decision && e.decision.abstainReasons && e.decision.abstainReasons.length
      ? `<div style="color:#ff9f0a;font-size:.83em;margin-top:3px">abstained: ${esc(e.decision.abstainReasons.join(' · '))}</div>`
      : ''}
    ${n.majorRisk ? `<div style="color:#8e8e93;font-size:.83em;margin-top:2px">risk: ${esc(n.majorRisk)}</div>` : ''}
  </div>`;
}

function sectorStrip(sl) {
  if (!sl) return '';
  const row = (label, arr, color) => (arr && arr.length
    ? `<div><span style="color:${color};font-weight:600">${label}:</span> <span style="color:#d1d1d6">${esc(arr.join(', '))}</span></div>` : '');
  return `<div style="border:1px solid #2c2c2e;border-radius:10px;padding:10px 12px;margin:8px 0;background:#1c1c1e;font-size:.9em">
    <div style="color:#8e8e93;margin-bottom:4px">Sector leadership (measured, as of ${esc(sl.asOf || '—')}) —
      breadth ${sl.leadershipBreadth ? esc(sl.leadershipBreadth) : '—'},
      ${sl.emergingLeaderCount != null ? sl.emergingLeaderCount + ' improving leaders' : ''}</div>
    ${row('Leading', sl.leading, '#34c759')}
    ${row('Improving', sl.improving, '#5ac8fa')}
    ${row('Weakening / risk-off', sl.weakening, '#ff9f0a')}
    <div style="color:#8e8e93;margin-top:4px">${esc(sl.note || '')}</div>
  </div>`;
}

export async function loadRltLab(container) {
  if (!container) return;
  container.innerHTML = '<div class="mom-status"><div class="mom-spinner"></div><p>Loading Relative Leadership Transition (shadow)…</p></div>';
  const d = await getJSON('/api/tracker?op=rlt');
  if (!d || d.ok === false) {
    container.innerHTML = `<div style="color:#8e8e93;padding:12px">RLT board unavailable${d && d.error ? ` — ${esc(d.error)}` : ''}. It accrues shadow evidence via the daily cron; nothing here affects live picks.</div>`;
    return;
  }
  const counts = d.counts || {};
  const order = ['ACCEPTED', 'TRIGGERED', 'ARMED', 'PRIMED', 'EMERGING_LEADER', 'DISCOVERED', 'WEAKENING', 'INVALIDATED', 'COMPLETED'];
  const inv = Array.isArray(d.inventory) ? d.inventory : [];
  const sections = order.map(s => {
    const items = inv.filter(c => c.state === s);
    if (!items.length) return '';
    const meta = STATE_META[s];
    return `<div style="margin-top:12px">
      <div style="color:${meta.color};font-weight:700">${esc(meta.label)} (${items.length})
        <span style="color:#8e8e93;font-weight:400;font-size:.85em">— ${esc(meta.hint)}</span></div>
      ${items.map(card).join('')}
    </div>`;
  }).join('');

  container.innerHTML = `
    <div style="border:1px solid #bf5af255;border-radius:10px;padding:10px 12px;background:#bf5af211;font-size:.9em;color:#d1d1d6">
      <b style="color:${ACCENT}">SHADOW / weight-0.</b> ${esc(d.honesty || '')}
      <div style="color:#8e8e93;margin-top:4px">mode: ${esc(d.mode || 'shadow')} ·
        universe ${d.coverage ? `${d.coverage.eligible}/${d.coverage.total} eligible` : '—'}
        ${d.coverage && d.coverage.note ? ` · ${esc(d.coverage.note)}` : ''} ·
        abstained ${counts.abstained ?? '—'} of ${counts.inventory ?? '—'}</div>
    </div>
    ${sectorStrip(d.sectorLeadership)}
    ${sections || '<div style="color:#8e8e93;padding:12px">No leadership transitions qualify today — an honest empty board beats a forced pick.</div>'}
  `;
}
